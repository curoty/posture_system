"""Self-supervised pretraining for the action encoder (single-class friendly).

Why self-supervised?
    The dataset currently holds a single action class (weight_shift).  A
    classification objective is degenerate there: softmax over one class is
    always 1.0, so CrossEntropyLoss is identically 0 and the encoder receives
    zero gradient — it never learns.  Instead we train the *same* CNN-LSTM-
    Attention backbone with two label-free objectives:

      1. Denoising reconstruction — encode an augmented view, decode back to the
         *clean* sequence.  Forces the embedding to capture the whole motion.
      2. Contrastive (NT-Xent) — two augmented views of the same record are
         pulled together, other records in the batch pushed apart.  Yields
         discriminative embeddings that transfer to a future classifier head.

    Output checkpoint uses the exact schema of the classification trainer
    (``model_config`` / ``model_state_dict`` / ``sequence_config`` /
    ``normalization``) so ``load_action_model`` and ``train_lgb_quality`` consume
    it unchanged.  Later, when multi-class data exists, load these encoder
    weights and attach a classifier head to continue training.

Usage:
    python -m src.train_ssl \
        --train-jsonl training_set_train.jsonl \
        --val-jsonl training_set_val.jsonl \
        --output-dir experiments/weight_shift_ssl_v1 \
        --max-epochs 60 --batch-size 64 --seed 42
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, TensorDataset
from tqdm import tqdm

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    fit_normalization,
    iter_jsonl_records,
    write_json,
)
from src.model import ActionModelConfig, SSLPretrainer


DEFAULT_RANDOM_SEED = 42

# Node layout of the flattened 54-dim vector (BASELINE_NODE_ORDER, 6 ch each).
# Index i covers channels [6i : 6i+6] = (ax, ay, az, gx, gy, gz).
_BASELINE_NODES = ("head", "l_elbow", "l_knee", "l_skate", "l_wrist",
                   "r_elbow", "r_knee", "r_skate", "r_wrist")
_MIRROR_PAIRS = {"l_elbow": "r_elbow", "l_knee": "r_knee", "l_skate": "r_skate",
                 "l_wrist": "r_wrist", "head": "head"}
_FLIP_CHANNELS = (0, 3, 5)  # ax, gx, gz negated under left/right mirror


def set_random_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_sequences(jsonl_path: str, config: SequenceConfig) -> np.ndarray:
    """Convert every record to a [180, 54] tensor (labels are irrelevant here)."""
    sequences: List[np.ndarray] = []
    skipped = 0
    for record in iter_jsonl_records(jsonl_path):
        seq, _label, _meta = convert_record_to_sequence(
            record, config=config, label_name_to_id=None, require_action_type=False,
        )
        if seq is None:
            skipped += 1
            continue
        sequences.append(seq)
    if not sequences:
        raise ValueError(f"No valid sequences parsed from {jsonl_path}")
    print(f"  {Path(jsonl_path).name}: {len(sequences)} sequences (skipped {skipped})")
    return np.stack(sequences).astype(np.float32)


def _build_mirror_index(node_order: Tuple[str, ...]) -> Tuple[np.ndarray, np.ndarray]:
    """Precompute a channel permutation + sign vector for left/right mirroring."""
    node_to_idx = {n: i for i, n in enumerate(node_order)}
    perm = np.arange(len(node_order) * 6)
    sign = np.ones(len(node_order) * 6, dtype=np.float32)
    for node, mirror in _MIRROR_PAIRS.items():
        if node not in node_to_idx or mirror not in node_to_idx:
            continue
        src = node_to_idx[node] * 6
        dst = node_to_idx[mirror] * 6
        for ch in range(6):
            perm[src + ch] = dst + ch
        for ch in _FLIP_CHANNELS:
            sign[src + ch] = -1.0
    return perm, sign


# ---------------------------------------------------------------------------
# Online augmentation (operates on normalized [B, T, C] tensors)
# ---------------------------------------------------------------------------

class Augmenter:
    """Generates a random augmented view for contrastive / denoising learning."""

    def __init__(self, node_order: Tuple[str, ...], device: torch.device,
                 noise_std: float = 0.08, seed: int = 0) -> None:
        self.device = device
        perm, sign = _build_mirror_index(node_order)
        self.mirror_perm = torch.as_tensor(perm, dtype=torch.long, device=device)
        self.mirror_sign = torch.as_tensor(sign, dtype=torch.float32, device=device)
        self.noise_std = noise_std
        self.gen = torch.Generator(device="cpu")
        self.gen.manual_seed(seed)

    def _rand(self, *shape: int) -> torch.Tensor:
        return torch.rand(*shape, generator=self.gen).to(self.device)

    def __call__(self, x: torch.Tensor) -> torch.Tensor:
        b, t, c = x.shape
        out = x.clone()

        # 1. Gaussian noise (always)
        noise = torch.randn(x.shape, generator=self.gen).to(self.device) * self.noise_std
        out = out + noise

        # 2. Amplitude scaling (per-sample, 50%)
        scale = (0.9 + 0.2 * self._rand(b, 1, 1))
        apply_scale = (self._rand(b, 1, 1) < 0.5).float()
        out = out * (apply_scale * scale + (1.0 - apply_scale))

        # 3. Time masking — zero a contiguous span (50%)
        for i in range(b):
            if float(self._rand(1)) < 0.5:
                span = int(5 + float(self._rand(1)) * 25)  # 5..30 frames
                start = int(float(self._rand(1)) * max(1, t - span))
                out[i, start:start + span, :] = 0.0

        # 4. Node dropout — zero one node's channels (30%), mimics sensor loss
        for i in range(b):
            if float(self._rand(1)) < 0.3:
                node = int(float(self._rand(1)) * (c // 6))
                out[i, :, node * 6:node * 6 + 6] = 0.0

        # 5. Left/right mirror (30%)
        mirror_mask = (self._rand(b) < 0.3)
        if mirror_mask.any():
            mirrored = out[:, :, self.mirror_perm] * self.mirror_sign
            out = torch.where(mirror_mask.view(b, 1, 1), mirrored, out)

        return out


# ---------------------------------------------------------------------------
# Losses
# ---------------------------------------------------------------------------

def nt_xent_loss(z1: torch.Tensor, z2: torch.Tensor, temperature: float = 0.2) -> torch.Tensor:
    """Normalized temperature-scaled cross entropy (SimCLR)."""
    batch = z1.shape[0]
    z = torch.cat([z1, z2], dim=0)                       # [2B, D]
    sim = torch.matmul(z, z.t()) / temperature           # [2B, 2B]
    self_mask = torch.eye(2 * batch, dtype=torch.bool, device=z.device)
    sim.masked_fill_(self_mask, float("-inf"))
    # positive pairs: i <-> i+B
    targets = torch.arange(2 * batch, device=z.device)
    targets = (targets + batch) % (2 * batch)
    return F.cross_entropy(sim, targets)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def run_ssl_pretraining(
    train_jsonl: str,
    val_jsonl: str,
    output_dir: str,
    sequence_length: int = 180,
    batch_size: int = 64,
    max_epochs: int = 60,
    learning_rate: float = 1e-3,
    weight_decay: float = 1e-4,
    contrastive_weight: float = 0.5,
    temperature: float = 0.2,
    patience: int = 8,
    seed: int = DEFAULT_RANDOM_SEED,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    set_random_seed(seed)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

    sequence_config = SequenceConfig(sequence_length=sequence_length)

    print("Loading sequences...")
    X_train = load_sequences(train_jsonl, sequence_config)
    X_val = load_sequences(val_jsonl, sequence_config)

    normalization = fit_normalization(X_train)
    X_train = apply_normalization(X_train, normalization)
    X_val = apply_normalization(X_val, normalization)

    train_loader = DataLoader(
        TensorDataset(torch.from_numpy(X_train)), batch_size=batch_size,
        shuffle=True, drop_last=True,
    )
    val_loader = DataLoader(
        TensorDataset(torch.from_numpy(X_val)), batch_size=batch_size, shuffle=False,
    )

    model_config = ActionModelConfig(
        input_dim=sequence_config.input_dim,
        num_classes=1,  # unused during SSL; kept for downstream schema compat
    )
    model = SSLPretrainer(model_config, sequence_length=sequence_length).to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="min", patience=3, factor=0.5)

    augment = Augmenter(sequence_config.node_order, device, seed=seed)
    recon_criterion = nn.MSELoss()

    best_val = float("inf")
    best_encoder_state: Optional[Dict[str, torch.Tensor]] = None
    epochs_without_improvement = 0
    history: List[Dict[str, Any]] = []

    print(f"\nSSL pretraining backbone (input_dim={model_config.input_dim}, "
          f"embedding_dim={model_config.embedding_dim})")
    print(f"  Device: {device}, epochs: {max_epochs}, batch: {batch_size}, "
          f"contrastive_weight: {contrastive_weight}")

    for epoch in range(1, max_epochs + 1):
        model.train()
        tr_recon, tr_contrast, n_batches = 0.0, 0.0, 0
        for (batch,) in tqdm(train_loader, desc=f"epoch {epoch}", leave=False):
            clean = batch.to(device)
            view1 = augment(clean)
            view2 = augment(clean)

            recon1, proj1, _ = model(view1)
            _recon2, proj2, _ = model(view2)

            recon_loss = recon_criterion(recon1, clean)
            contrast_loss = nt_xent_loss(proj1, proj2, temperature)
            loss = recon_loss + contrastive_weight * contrast_loss

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()

            tr_recon += float(recon_loss.detach().cpu())
            tr_contrast += float(contrast_loss.detach().cpu())
            n_batches += 1

        # Validation — reconstruction loss on clean-encoded / clean-target
        model.eval()
        val_recon, val_batches = 0.0, 0
        with torch.no_grad():
            for (batch,) in val_loader:
                clean = batch.to(device)
                recon, _proj, _emb = model(clean)
                val_recon += float(recon_criterion(recon, clean).cpu())
                val_batches += 1
        val_recon /= max(1, val_batches)
        scheduler.step(val_recon)

        epoch_summary = {
            "epoch": epoch,
            "train_recon": round(tr_recon / max(1, n_batches), 6),
            "train_contrast": round(tr_contrast / max(1, n_batches), 6),
            "val_recon": round(val_recon, 6),
            "lr": optimizer.param_groups[0]["lr"],
        }
        history.append(epoch_summary)
        print(f"  epoch {epoch:3d} | train_recon={epoch_summary['train_recon']:.4f} "
              f"train_contrast={epoch_summary['train_contrast']:.4f} "
              f"val_recon={val_recon:.4f} lr={epoch_summary['lr']:.1e}")

        if val_recon < best_val - 1e-5:
            best_val = val_recon
            best_encoder_state = {k: v.detach().cpu().clone()
                                  for k, v in model.encoder.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= patience:
                print(f"  Early stopping at epoch {epoch}")
                break

    if best_encoder_state is None:
        best_encoder_state = {k: v.detach().cpu().clone()
                              for k, v in model.encoder.state_dict().items()}

    # Save in the SAME schema as the classification trainer so downstream code
    # (load_action_model / train_lgb_quality) consumes it unchanged.
    checkpoint = {
        "model_config": model_config.to_dict(),
        "model_state_dict": best_encoder_state,
        "sequence_config": sequence_config.to_dict(),
        "normalization": normalization,
        "label_metadata": {
            "action_labels": {"0": "weight_shift"},
            "num_classes": 1,
            "note": "SSL-pretrained encoder; classifier head is random/unused.",
        },
        "ssl_training_summary": {
            "objective": "denoising_reconstruction + nt_xent_contrastive",
            "best_val_recon": best_val,
            "contrastive_weight": contrastive_weight,
            "history": history,
        },
    }
    model_file = output_path / "action_model.pt"
    torch.save(checkpoint, model_file)

    write_json(output_path / "ssl_training_summary.json", checkpoint["ssl_training_summary"])
    write_json(output_path / "deep_feature_config.json", sequence_config.to_dict())
    write_json(output_path / "normalization.json", normalization)
    write_json(output_path / "label_metadata.json", checkpoint["label_metadata"])
    write_json(output_path / "prediction_policy.json",
               {"confidence_threshold": 0.65, "top_margin_threshold": 0.15,
                "note": "single-class: use reconstruction-error anomaly gate, not softmax"})

    print(f"\nSSL-pretrained encoder saved to {model_file}")
    print(f"  best_val_recon: {best_val:.4f}")
    return {
        "model_file": str(model_file),
        "best_val_recon": best_val,
        "epochs_trained": len(history),
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Self-supervised pretraining of the action encoder.")
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--sequence-length", type=int, default=180)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--max-epochs", type=int, default=60)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--contrastive-weight", type=float, default=0.5)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--seed", type=int, default=DEFAULT_RANDOM_SEED)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    result = run_ssl_pretraining(
        train_jsonl=args.train_jsonl,
        val_jsonl=args.val_jsonl,
        output_dir=args.output_dir,
        sequence_length=args.sequence_length,
        batch_size=args.batch_size,
        max_epochs=args.max_epochs,
        learning_rate=args.learning_rate,
        contrastive_weight=args.contrastive_weight,
        temperature=args.temperature,
        patience=args.patience,
        seed=args.seed,
        device_name=args.device,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
