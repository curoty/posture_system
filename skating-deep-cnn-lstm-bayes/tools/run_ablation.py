#!/usr/bin/env python3
"""Ablation study: train & evaluate all 4 CNN-LSTM-Attention model variants.

Trains: CNN-only, CNN+LSTM, CNN+Attention, CNN+LSTM+Attention (full)
on the same data split (train/val/test = 7:1:2, seed=42) with identical
hyperparameters.

Evaluates:
  - Accuracy, Macro F1, per-class F1 (full-sequence)
  - Accuracy, Macro F1 (sliding-window, window=64, stride=32)
  - Training time and inference latency (100-sample average)

Output: ablation_results.json
"""

from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader, Dataset

# Import 4 model variants
sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_cnn_only
import model_cnn_lstm
import model_cnn_attention
import model_full

# ============================================================================
# Configuration
# ============================================================================

SEED = 42
SEQ_LENGTH = 180
INPUT_DIM = 54
N_ACTIONS = 7

ACTION_NAMES = (
    "weight_shift", "side_push_recover", "jump",
    "turn", "stop", "arm_swing", "combination",
)

# Shared hyperparameters
HP = {
    "batch_size": 128,
    "max_epochs": 40,
    "learning_rate": 1e-3,
    "weight_decay": 1e-4,
    "patience": 10,
    "dropout": 0.3,
    "cnn_channels": (64, 128, 128),
    "kernel_sizes": (5, 5, 3),
    "lstm_hidden": 128,
    "lstm_layers": 1,
    "bidirectional": True,
    "fc_hidden": 128,
}

# Data split
TRAIN_RATIO = 0.7
VAL_RATIO   = 0.1
TEST_RATIO  = 0.2

# Sliding window
WINDOW_SIZE = 64
WINDOW_STRIDE = 32
LATENCY_SAMPLES = 100


# ============================================================================
# Utilities
# ============================================================================

def set_seed(seed: int = SEED) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


class EarlyStopping:
    def __init__(self, patience: int = 10, mode: str = "max", min_delta: float = 1e-4):
        self.patience = patience
        self.mode = mode
        self.min_delta = min_delta
        self.best = -float("inf") if mode == "max" else float("inf")
        self.counter = 0
        self.best_state: Dict[str, torch.Tensor] | None = None
        self.should_stop = False

    def step(self, metric: float, model: nn.Module) -> None:
        improved = (
            (self.mode == "max" and metric > self.best + self.min_delta)
            or (self.mode == "min" and metric < self.best - self.min_delta)
        )
        if improved:
            self.best = metric
            self.counter = 0
            self.best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            self.counter += 1
            if self.counter >= self.patience:
                self.should_stop = True


def compute_class_weights(labels: np.ndarray, num_classes: int, device: torch.device) -> torch.Tensor:
    counts = Counter(int(l) for l in labels.tolist())
    total = float(len(labels))
    weights = [total / (num_classes * max(counts.get(c, 1), 1)) for c in range(num_classes)]
    return torch.tensor(weights, dtype=torch.float32, device=device)


class IMUDataset(Dataset):
    def __init__(self, sequences: np.ndarray, labels: np.ndarray) -> None:
        self.sequences = sequences
        self.labels = labels

    def __len__(self) -> int:
        return len(self.sequences)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        return (
            torch.as_tensor(self.sequences[idx], dtype=torch.float32),
            torch.tensor(self.labels[idx], dtype=torch.long),
        )


# ============================================================================
# Data Loading
# ============================================================================

def load_and_split(npz_path: str) -> Tuple:
    data = np.load(npz_path)
    sequences = data["sequences"].astype(np.float32)
    action_labels = data["action_labels"].astype(np.int64)

    n = len(sequences)
    indices = np.arange(n)

    # First split: train vs rest (val+test)
    train_idx, rest_idx = train_test_split(
        indices, test_size=1.0 - TRAIN_RATIO,
        random_state=SEED, shuffle=True, stratify=action_labels,
    )
    rest_labels = action_labels[rest_idx]
    # Second split: val vs test
    val_fraction = VAL_RATIO / (VAL_RATIO + TEST_RATIO)
    val_idx, test_idx = train_test_split(
        rest_idx, test_size=1.0 - val_fraction,
        random_state=SEED, shuffle=True, stratify=rest_labels,
    )

    X_train, y_train = sequences[train_idx], action_labels[train_idx]
    X_val, y_val = sequences[val_idx], action_labels[val_idx]
    X_test, y_test = sequences[test_idx], action_labels[test_idx]

    # Per-channel z-score normalization (fit on train only)
    flat_train = X_train.reshape(-1, X_train.shape[-1])
    mean = np.mean(flat_train, axis=0).astype(np.float32)
    std = np.std(flat_train, axis=0).astype(np.float32)
    std = np.where(std < 1e-6, 1.0, std)

    X_train = ((X_train - mean) / std).astype(np.float32)
    X_val   = ((X_val   - mean) / std).astype(np.float32)
    X_test  = ((X_test  - mean) / std).astype(np.float32)

    print(f"Data split: train={len(train_idx)}, val={len(val_idx)}, test={len(test_idx)}")
    return X_train, y_train, X_val, y_val, X_test, y_test


# ============================================================================
# Training
# ============================================================================

def train_one_model(
    model: nn.Module,
    model_name: str,
    X_train: np.ndarray, y_train: np.ndarray,
    X_val: np.ndarray,   y_val: np.ndarray,
    device: torch.device,
) -> Dict[str, Any]:
    """Train a single model variant, return metrics and timing."""
    print(f"\n{'='*60}")
    print(f"Training: {model_name}")
    print(f"{'='*60}")

    train_loader = DataLoader(
        IMUDataset(X_train, y_train),
        batch_size=HP["batch_size"], shuffle=True,
    )
    val_loader = DataLoader(
        IMUDataset(X_val, y_val),
        batch_size=HP["batch_size"], shuffle=False,
    )

    class_weights = compute_class_weights(y_train, N_ACTIONS, device)
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=HP["learning_rate"], weight_decay=HP["weight_decay"],
    )
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", patience=HP["patience"] // 3, factor=0.5,
    )
    stopper = EarlyStopping(patience=HP["patience"], mode="max")

    history: Dict[str, List[float]] = {"train_loss": [], "val_acc": []}
    t0 = time.perf_counter()

    for epoch in range(1, HP["max_epochs"] + 1):
        # Train
        model.train()
        train_losses = []
        for bx, by in train_loader:
            bx, by = bx.to(device), by.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(bx), by)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            train_losses.append(float(loss.detach().cpu()))

        # Validate
        model.eval()
        val_preds, val_true = [], []
        with torch.no_grad():
            for bx, by in val_loader:
                bx = bx.to(device)
                logits = model(bx)
                val_preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
                val_true.extend(by.cpu().tolist())

        val_acc = float(accuracy_score(val_true, val_preds))
        history["train_loss"].append(float(np.mean(train_losses)))
        history["val_acc"].append(val_acc)

        scheduler.step(val_acc)
        stopper.step(val_acc, model)

        if epoch % 10 == 0 or epoch == 1 or stopper.should_stop:
            print(f"  Epoch {epoch:3d} | loss={history['train_loss'][-1]:.4f} | "
                  f"val_acc={val_acc:.4f} | lr={optimizer.param_groups[0]['lr']:.2e}")

        if stopper.should_stop:
            print(f"  Early stopping at epoch {epoch}")
            break

    train_time = time.perf_counter() - t0
    best_val_acc = float(stopper.best)

    if stopper.best_state is not None:
        model.load_state_dict(stopper.best_state)

    print(f"  Train time: {train_time:.1f}s, best_val_acc: {best_val_acc:.4f}")

    return {
        "best_val_acc": best_val_acc,
        "train_time_seconds": round(train_time, 1),
        "epochs_trained": len(history["train_loss"]),
        "history": history,
    }


# ============================================================================
# Evaluation
# ============================================================================

def evaluate_full_sequence(
    model: nn.Module,
    X_test: np.ndarray,
    y_test: np.ndarray,
    device: torch.device,
) -> Dict[str, Any]:
    """Full-sequence (180-frame) evaluation."""
    model.eval()
    test_loader = DataLoader(
        IMUDataset(X_test, y_test),
        batch_size=HP["batch_size"], shuffle=False,
    )
    all_preds, all_true = [], []
    with torch.no_grad():
        for bx, by in test_loader:
            bx = bx.to(device)
            logits = model(bx)
            all_preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
            all_true.extend(by.cpu().tolist())

    y_true = np.asarray(all_true, dtype=int)
    y_pred = np.asarray(all_preds, dtype=int)

    prec, rec, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=range(N_ACTIONS), zero_division=0,
    )
    cm = confusion_matrix(y_true, y_pred, labels=range(N_ACTIONS))

    per_class = {}
    for i, name in enumerate(ACTION_NAMES):
        per_class[name] = {
            "precision": round(float(prec[i]), 4),
            "recall":    round(float(rec[i]), 4),
            "f1":        round(float(f1[i]), 4),
            "support":   int(support[i]),
        }

    return {
        "accuracy":      round(float(accuracy_score(y_true, y_pred)), 4),
        "macro_f1":      round(float(f1_score(y_true, y_pred, average="macro", zero_division=0)), 4),
        "weighted_f1":   round(float(f1_score(y_true, y_pred, average="weighted", zero_division=0)), 4),
        "per_class":     per_class,
        "confusion_matrix": cm.tolist(),
    }


def sliding_window_predict(
    model: nn.Module,
    sequence: np.ndarray,     # (180, 54)
    device: torch.device,
    window_size: int = WINDOW_SIZE,
    stride: int = WINDOW_STRIDE,
) -> int:
    """Sliding-window prediction → aggregated class label."""
    model.eval()
    seq_len = sequence.shape[0]
    windows = []
    start = 0
    while start + window_size <= seq_len:
        windows.append(sequence[start:start + window_size])
        start += stride
    if not windows:
        windows = [sequence]

    all_probs = []
    with torch.no_grad():
        for win in windows:
            x = torch.as_tensor(win, dtype=torch.float32, device=device).unsqueeze(0)
            logits = model(x)
            all_probs.append(torch.softmax(logits, dim=1).cpu().numpy()[0])

    agg_probs = np.mean(all_probs, axis=0)
    return int(np.argmax(agg_probs))


def evaluate_sliding_window(
    model: nn.Module,
    X_test: np.ndarray,
    y_test: np.ndarray,
    device: torch.device,
) -> Dict[str, Any]:
    """Sliding-window evaluation."""
    model.eval()
    all_preds, all_true = [], []
    for i in range(len(X_test)):
        pred = sliding_window_predict(model, X_test[i], device)
        all_preds.append(pred)
        all_true.append(int(y_test[i]))

    y_true = np.asarray(all_true, dtype=int)
    y_pred = np.asarray(all_preds, dtype=int)

    return {
        "accuracy":    round(float(accuracy_score(y_true, y_pred)), 4),
        "macro_f1":    round(float(f1_score(y_true, y_pred, average="macro", zero_division=0)), 4),
        "weighted_f1": round(float(f1_score(y_true, y_pred, average="weighted", zero_division=0)), 4),
    }


def benchmark_latency(
    model: nn.Module,
    X_test: np.ndarray,
    device: torch.device,
    n_samples: int = LATENCY_SAMPLES,
) -> Dict[str, Any]:
    """Measure inference latency (full-sequence + sliding-window)."""
    model.eval()

    # Warm-up
    warmup = torch.as_tensor(X_test[:4], dtype=torch.float32, device=device)
    for _ in range(20):
        _ = model(warmup)
    if device.type == "cuda":
        torch.cuda.synchronize()

    # Full-sequence latency
    full_latencies = []
    for i in range(min(n_samples, len(X_test))):
        inp = torch.as_tensor(X_test[i:i + 1], dtype=torch.float32, device=device)
        if device.type == "cuda":
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        with torch.no_grad():
            _ = model(inp)
        if device.type == "cuda":
            torch.cuda.synchronize()
        full_latencies.append((time.perf_counter() - t0) * 1000.0)

    full_latencies = np.array(full_latencies)

    # Sliding-window latency
    sw_latencies = []
    for i in range(min(n_samples, len(X_test))):
        if device.type == "cuda":
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        sliding_window_predict(model, X_test[i], device)
        if device.type == "cuda":
            torch.cuda.synchronize()
        sw_latencies.append((time.perf_counter() - t0) * 1000.0)

    sw_latencies = np.array(sw_latencies)

    return {
        "full_sequence": {
            "mean_ms":   round(float(np.mean(full_latencies)), 3),
            "median_ms": round(float(np.median(full_latencies)), 3),
            "p95_ms":    round(float(np.percentile(full_latencies, 95)), 3),
            "std_ms":    round(float(np.std(full_latencies)), 3),
        },
        "sliding_window": {
            "mean_ms":   round(float(np.mean(sw_latencies)), 3),
            "median_ms": round(float(np.median(sw_latencies)), 3),
            "p95_ms":    round(float(np.percentile(sw_latencies, 95)), 3),
            "std_ms":    round(float(np.std(sw_latencies)), 3),
        },
    }


# ============================================================================
# Main
# ============================================================================

def run_ablation(data_path: str = "sim_data.npz") -> Dict[str, Any]:
    set_seed(SEED)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # --- Load data ---
    print("\nLoading data...")
    X_train, y_train, X_val, y_val, X_test, y_test = load_and_split(data_path)

    # --- Model registry ---
    model_specs = [
        (model_cnn_only,     model_cnn_only.Model),
        (model_cnn_lstm,     model_cnn_lstm.Model),
        (model_cnn_attention, model_cnn_attention.Model),
        (model_full,         model_full.Model),
    ]

    all_results: Dict[str, Any] = {
        "hyperparameters": HP,
        "data_split": {
            "train_ratio": TRAIN_RATIO,
            "val_ratio": VAL_RATIO,
            "test_ratio": TEST_RATIO,
            "seed": SEED,
            "train_samples": int(len(X_train)),
            "val_samples":   int(len(X_val)),
            "test_samples":  int(len(X_test)),
        },
        "models": [],
    }

    for module, model_cls in model_specs:
        name = module.MODEL_NAME
        print(f"\n{'#'*60}")
        print(f"#  {name}")
        print(f"#  {module.DESCRIPTION}")
        print(f"{'#'*60}")

        set_seed(SEED)  # reset seed before each model for fairness
        model = model_cls().to(device)
        n_params = sum(p.numel() for p in model.parameters())
        print(f"Parameters: {n_params:,}")

        # Train
        train_result = train_one_model(model, name, X_train, y_train, X_val, y_val, device)

        # Evaluate (full-sequence)
        print(f"\n  Evaluating full-sequence...")
        full_metrics = evaluate_full_sequence(model, X_test, y_test, device)
        print(f"  Full-seq  acc={full_metrics['accuracy']:.4f}  "
              f"macro_f1={full_metrics['macro_f1']:.4f}")

        # Evaluate (sliding-window)
        print(f"  Evaluating sliding-window...")
        sw_metrics = evaluate_sliding_window(model, X_test, y_test, device)
        print(f"  Slide-win acc={sw_metrics['accuracy']:.4f}  "
              f"macro_f1={sw_metrics['macro_f1']:.4f}")

        # Benchmark latency
        print(f"  Benchmarking latency...")
        latency = benchmark_latency(model, X_test, device)
        print(f"  Full-seq:  mean={latency['full_sequence']['mean_ms']:.3f} ms")
        print(f"  Slide-win: mean={latency['sliding_window']['mean_ms']:.3f} ms")

        # Per-class F1
        print(f"  Per-class F1 (full-seq):")
        for cls_name, m in full_metrics["per_class"].items():
            print(f"    {cls_name:20s}: {m['f1']:.4f}")

        all_results["models"].append({
            "name": name,
            "description": module.DESCRIPTION,
            "parameters": n_params,
            "training": train_result,
            "evaluation": {
                "full_sequence": full_metrics,
                "sliding_window": sw_metrics,
            },
            "latency": latency,
        })

    # --- Save ---
    output_path = Path(__file__).resolve().parent.parent / "experiments" / "ablation_results.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nResults saved to: {output_path.resolve()}")

    # --- Quick summary ---
    print(f"\n{'='*70}")
    print("ABLATION SUMMARY")
    print(f"{'='*70}")
    print(f"{'Model':25s} {'Acc':>8s} {'MacroF1':>8s} {'Params':>8s} {'Train(s)':>9s} {'Lat(ms)':>8s}")
    print("-" * 70)
    for m in all_results["models"]:
        print(f"{m['name']:25s} "
              f"{m['evaluation']['full_sequence']['accuracy']:8.4f} "
              f"{m['evaluation']['full_sequence']['macro_f1']:8.4f} "
              f"{m['parameters']:8,d} "
              f"{m['training']['train_time_seconds']:9.1f} "
              f"{m['latency']['full_sequence']['mean_ms']:8.3f}")

    return all_results


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Run ablation study on CNN-LSTM-Attention variants.")
    parser.add_argument("--data", default="sim_data.npz", help="Path to sim_data.npz.")
    args = parser.parse_args()

    if not Path(args.data).exists():
        print(f"Error: {args.data} not found. Run generate_synthetic_data.py first.")
        return 1

    run_ablation(args.data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
