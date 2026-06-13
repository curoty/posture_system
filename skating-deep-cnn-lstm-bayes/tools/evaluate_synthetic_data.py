#!/usr/bin/env python3
"""Comprehensive evaluation of synthetic roller-skating IMU data.

Loads sim_data.npz, trains a 1D-CNN + BiLSTM + Self-Attention action classifier
and a GaussianNB quality assessor, then evaluates classification accuracy,
sliding-window real-time inference, and end-to-end latency.

Suitable as a standalone experiment for thesis Chapter 6.

Usage:
  python tools/evaluate_synthetic_data.py
  python tools/evaluate_synthetic_data.py --data sim_data.npz --epochs 50
  python tools/evaluate_synthetic_data.py --no-augment --batch-size 64
"""

from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import GaussianNB
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

# ============================================================================
# Configuration
# ============================================================================

SEED = 42
SEQ_LENGTH = 180
INPUT_DIM = 54  # 9 nodes x 6 IMU channels
N_NODES = 9
N_CHANNELS = 6

N_ACTIONS = 7
N_QUALITIES = 4

ACTION_NAMES = (
    "weight_shift", "side_push_recover", "jump",
    "turn", "stop", "arm_swing", "combination",
)
ACTION_NAMES_ZH = (
    "重心转移", "侧向推冰", "跳跃",
    "转弯", "刹车", "摆臂", "组合动作",
)
QUALITY_NAMES = {0: "Fail", 1: "Mid", 2: "Good", 3: "Excellent"}
QUALITY_NAMES_ZH = {0: "不合格", 1: "一般", 2: "良好", 3: "优秀"}

COLORS = {
    "train": "#4C72B0",
    "val": "#55A868",
    "test": "#C44E52",
}

# Configure matplotlib for Chinese font support (fallback to English if unavailable)
_HAS_CHINESE_FONT = False
for _font in ("SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC"):
    try:
        matplotlib.font_manager.findfont(_font, fallback_to_default=False)
        matplotlib.rcParams["font.sans-serif"] = [_font, "DejaVu Sans", "Arial"]
        _HAS_CHINESE_FONT = True
        break
    except Exception:
        continue
if not _HAS_CHINESE_FONT:
    # Fall back: use English-only labels in plots
    ACTION_NAMES_ZH = ACTION_NAMES  # overwrite with English
    QUALITY_NAMES_ZH = {k: v for k, v in QUALITY_NAMES.items()}
    print("Note: Chinese font not found, using English labels in plots.")

matplotlib.rcParams.update({
    "font.size": 11,
    "axes.titlesize": 13,
    "axes.labelsize": 11,
    "figure.dpi": 150,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "axes.unicode_minus": False,
})


# ============================================================================
# Reproducibility
# ============================================================================

def set_seed(seed: int = SEED) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# ============================================================================
# Data loading
# ============================================================================

def load_dataset(npz_path: str | Path) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Load sim_data.npz and return (sequences, action_labels, quality_labels)."""
    data = np.load(npz_path)
    sequences = data["sequences"].astype(np.float32)
    action_labels = data["action_labels"].astype(np.int64)
    quality_labels = data["quality_labels"].astype(np.int64)
    print(f"Loaded {len(sequences)} samples from {npz_path}")
    print(f"  shape: {sequences.shape}, actions: {len(np.unique(action_labels))}, "
          f"qualities: {len(np.unique(quality_labels))}")
    return sequences, action_labels, quality_labels


def split_dataset(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
    seed: int = SEED,
) -> Tuple[np.ndarray, ...]:
    """Stratified split into train / val / test sets.

    Stratification uses a combined label = action * 10 + quality to preserve
    the joint (action, quality) distribution across splits.
    """
    combined = action_labels * 10 + quality_labels
    n = len(sequences)

    indices = np.arange(n)
    train_idx, temp_idx = train_test_split(
        indices, test_size=1.0 - train_ratio,
        random_state=seed, shuffle=True,
        stratify=combined,
    )
    temp_combined = combined[temp_idx]
    val_size = val_ratio / (1.0 - train_ratio)
    val_idx, test_idx = train_test_split(
        temp_idx, test_size=1.0 - val_size,
        random_state=seed, shuffle=True,
        stratify=temp_combined,
    )

    print(f"Split: train={len(train_idx)}, val={len(val_idx)}, test={len(test_idx)}")
    return (
        sequences[train_idx], action_labels[train_idx], quality_labels[train_idx],
        sequences[val_idx],   action_labels[val_idx],   quality_labels[val_idx],
        sequences[test_idx],  action_labels[test_idx],  quality_labels[test_idx],
    )


def fit_normalization(train_seq: np.ndarray) -> Dict[str, np.ndarray]:
    """Compute per-channel mean and std from training data.

    Input: (N, T, C) — normalize each of the C=54 channels independently.
    """
    # Flatten N and T: (N*T, C)
    flat = train_seq.reshape(-1, train_seq.shape[-1])
    mean = np.mean(flat, axis=0).astype(np.float32)
    std = np.std(flat, axis=0).astype(np.float32)
    std = np.where(std < 1e-6, 1.0, std)
    return {"mean": mean, "std": std}


def apply_normalization(
    sequences: np.ndarray, norm: Dict[str, np.ndarray],
) -> np.ndarray:
    return ((sequences - norm["mean"]) / norm["std"]).astype(np.float32)


# ============================================================================
# Data augmentation
# ============================================================================

def time_warp_augment(
    sequences: np.ndarray, strength: float = 0.08, rng: np.random.RandomState | None = None,
) -> np.ndarray:
    """Apply smooth time warping to a batch of sequences.

    Args:
        sequences: (N, T, C) array.
        strength: warp intensity (0 = no change, 0.15 = heavy).
        rng: random state.

    Returns:
        Warped sequences of same shape.
    """
    if rng is None:
        rng = np.random.RandomState()
    n_batch, n_frames, n_features = sequences.shape
    if strength <= 0.0 or n_frames < 8:
        return sequences

    t_orig = np.linspace(0.0, 1.0, n_frames, dtype=np.float64)
    n_ctrl = max(3, n_frames // 16)
    ctrl_t = np.linspace(0.0, 1.0, n_ctrl, dtype=np.float64)

    out = np.empty_like(sequences, dtype=np.float32)
    for b in range(n_batch):
        # Build one warp curve per sample (shared across channels)
        warps = rng.uniform(-strength, strength, n_ctrl).astype(np.float64)
        warps = np.cumsum(warps)
        warps -= np.mean(warps)
        warp = np.interp(t_orig, ctrl_t, warps).astype(np.float64)
        warp = np.clip(warp, -0.35, 0.35)
        t_src = np.clip(t_orig + warp, 0.0, 1.0)
        t_src = np.sort(t_src)
        for c in range(n_features):
            out[b, :, c] = np.interp(t_src, t_orig, sequences[b, :, c])
    return out


def node_dropout_augment(
    sequences: np.ndarray, dropout_prob: float = 0.05, rng: np.random.RandomState | None = None,
) -> np.ndarray:
    """Randomly zero out entire sensor nodes (9 channels at once)."""
    if rng is None:
        rng = np.random.RandomState()
    out = sequences.copy()
    n_batch = sequences.shape[0]
    for b in range(n_batch):
        for node_i in range(N_NODES):
            if rng.uniform() < dropout_prob:
                start = node_i * N_CHANNELS
                out[b, :, start:start + N_CHANNELS] = 0.0
    return out


def gaussian_noise_augment(
    sequences: np.ndarray, noise_std: float = 0.05, rng: np.random.RandomState | None = None,
) -> np.ndarray:
    """Add Gaussian noise scaled per channel type (accel vs gyro)."""
    if rng is None:
        rng = np.random.RandomState()
    noise = np.zeros_like(sequences, dtype=np.float32)
    # Accelerometer channels (indices 0,1,2 per node): small noise
    for node_i in range(N_NODES):
        for ch_i in range(3):  # ax, ay, az
            c = node_i * N_CHANNELS + ch_i
            noise[:, :, c] = rng.normal(0.0, noise_std * 2.0, sequences.shape[:2])
    # Gyroscope channels (indices 3,4,5 per node): larger noise
    for node_i in range(N_NODES):
        for ch_i in range(3, 6):  # gx, gy, gz
            c = node_i * N_CHANNELS + ch_i
            noise[:, :, c] = rng.normal(0.0, noise_std * 500.0, sequences.shape[:2])
    return (sequences + noise).astype(np.float32)


def augment_batch(
    sequences: np.ndarray,
    rng: np.random.RandomState,
    use_warp: bool = True,
    use_dropout: bool = True,
    use_noise: bool = True,
) -> np.ndarray:
    """Apply random augmentations to a training batch."""
    out = sequences.copy()
    if use_warp:
        out = time_warp_augment(out, strength=0.06 + rng.uniform() * 0.04, rng=rng)
    if use_noise:
        out = gaussian_noise_augment(out, noise_std=0.02 + rng.uniform() * 0.04, rng=rng)
    if use_dropout:
        out = node_dropout_augment(out, dropout_prob=0.03 + rng.uniform() * 0.03, rng=rng)
    return out


# ============================================================================
# PyTorch Dataset
# ============================================================================

class IMUDataset(Dataset):
    def __init__(
        self,
        sequences: np.ndarray,
        action_labels: np.ndarray,
        quality_labels: np.ndarray,
        augment: bool = False,
        aug_rng: np.random.RandomState | None = None,
    ) -> None:
        self.sequences = sequences
        self.action_labels = action_labels
        self.quality_labels = quality_labels
        self.augment = augment
        self.aug_rng = aug_rng

    def __len__(self) -> int:
        return len(self.sequences)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        seq = self.sequences[idx]
        if self.augment and self.aug_rng is not None:
            seq = augment_batch(seq[np.newaxis, :, :], self.aug_rng)[0]
        return (
            torch.as_tensor(seq, dtype=torch.float32),
            torch.tensor(self.action_labels[idx], dtype=torch.long),
            torch.tensor(self.quality_labels[idx], dtype=torch.long),
        )


# ============================================================================
# Action Model (1D-CNN + BiLSTM + Self-Attention)
# ============================================================================

class AdditiveSelfAttention(nn.Module):
    """Bahdanau-style additive attention for temporal aggregation."""

    def __init__(self, input_dim: int) -> None:
        super().__init__()
        self.score = nn.Sequential(
            nn.Linear(input_dim, input_dim),
            nn.Tanh(),
            nn.Linear(input_dim, 1),
        )

    def forward(self, sequence: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        # sequence: (B, T, D)
        scores = self.score(sequence).squeeze(-1)  # (B, T)
        weights = F.softmax(scores, dim=1)
        context = torch.sum(sequence * weights.unsqueeze(-1), dim=1)  # (B, D)
        return context, weights


class ActionClassifier(nn.Module):
    """1D-CNN + BiLSTM + Additive Self-Attention action classifier.

    Input:  (B, T, C)  where T=180, C=54
    Output: (B, N_ACTIONS) logits
    """

    def __init__(
        self,
        input_dim: int = INPUT_DIM,
        num_classes: int = N_ACTIONS,
        cnn_channels: Tuple[int, int, int] = (64, 128, 128),
        kernel_sizes: Tuple[int, int, int] = (5, 5, 3),
        lstm_hidden: int = 128,
        lstm_layers: int = 1,
        bidirectional: bool = True,
        dropout: float = 0.3,
        fc_hidden: int = 128,
        use_attention: bool = True,
    ) -> None:
        super().__init__()
        c1, c2, c3 = cnn_channels
        k1, k2, k3 = kernel_sizes
        self.use_attention = use_attention

        self.cnn = nn.Sequential(
            nn.Conv1d(input_dim, c1, k1, padding=k1 // 2),
            nn.BatchNorm1d(c1),
            nn.ReLU(),
            nn.Dropout(dropout * 0.5),
            nn.Conv1d(c1, c2, k2, padding=k2 // 2),
            nn.BatchNorm1d(c2),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2),
            nn.Dropout(dropout * 0.7),
            nn.Conv1d(c2, c3, k3, padding=k3 // 2),
            nn.BatchNorm1d(c3),
            nn.ReLU(),
            nn.Dropout(dropout * 0.7),
        )

        lstm_dropout = dropout if lstm_layers > 1 else 0.0
        self.lstm = nn.LSTM(
            input_size=c3, hidden_size=lstm_hidden,
            num_layers=lstm_layers, batch_first=True,
            dropout=lstm_dropout, bidirectional=bidirectional,
        )
        lstm_out = lstm_hidden * (2 if bidirectional else 1)

        self.attention = AdditiveSelfAttention(lstm_out) if use_attention else None
        embed_dim = lstm_out  # attention output dim = lstm_out

        self.classifier = nn.Sequential(
            nn.Linear(embed_dim, fc_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(fc_hidden, num_classes),
        )

    def forward(
        self, x: torch.Tensor,
        return_embedding: bool = False,
    ) -> Any:
        # x: (B, T, C) → transpose for Conv1d: (B, C, T)
        x = x.transpose(1, 2)
        x = self.cnn(x)            # (B, c3, T')
        x = x.transpose(1, 2)      # (B, T', c3)
        x, _ = self.lstm(x)        # (B, T', lstm_out)

        if self.attention is not None:
            embedding, _ = self.attention(x)  # (B, lstm_out)
        else:
            embedding = torch.mean(x, dim=1)

        logits = self.classifier(embedding)
        if return_embedding:
            return logits, embedding
        return logits


# ============================================================================
# Quality Neural Network
# ============================================================================

class QualityNN(nn.Module):
    """Simple MLP for quality classification from action embeddings + probs."""

    def __init__(
        self,
        input_dim: int,
        num_classes: int = N_QUALITIES,
        hidden_dim: int = 128,
        dropout: float = 0.3,
    ) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.BatchNorm1d(hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout * 0.7),
            nn.Linear(hidden_dim // 2, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ============================================================================
# Quality Model helpers
# ============================================================================

QUALITY_REPRESENTATIVE_SCORES = {0: 29.5, 1: 67.0, 2: 82.0, 3: 95.0}


def estimate_quality_score(
    class_ids: Sequence[int], probabilities: Sequence[float],
) -> float:
    """Weighted sum: score = Σ P(class) × representative_score."""
    total = float(sum(probabilities))
    if total <= 0.0:
        return QUALITY_REPRESENTATIVE_SCORES[int(np.argmax(probabilities))]
    score = 0.0
    for cid, prob in zip(class_ids, probabilities):
        score += QUALITY_REPRESENTATIVE_SCORES[int(cid)] * float(prob / total)
    return round(score, 2)


def build_quality_features(
    embeddings: np.ndarray,       # (N, embed_dim)
    action_probs: np.ndarray,     # (N, N_ACTIONS)
    predicted_actions: np.ndarray, # (N,)
) -> np.ndarray:
    """Build feature vectors for quality classification.

    Features: embedding + action_probs + predicted_onehot.
    """
    n = embeddings.shape[0]
    pred_onehot = np.zeros((n, N_ACTIONS), dtype=np.float32)
    pred_onehot[np.arange(n), predicted_actions] = 1.0
    return np.concatenate([embeddings, action_probs, pred_onehot], axis=1).astype(np.float32)


# ============================================================================
# Training utilities
# ============================================================================

def compute_class_weights(labels: np.ndarray, num_classes: int, device: torch.device) -> torch.Tensor:
    counts = Counter(int(l) for l in labels.tolist())
    total = float(len(labels))
    weights = [total / (num_classes * max(counts.get(c, 1), 1)) for c in range(num_classes)]
    return torch.tensor(weights, dtype=torch.float32, device=device)


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


# ============================================================================
# Metrics
# ============================================================================

def action_metrics(
    y_true: np.ndarray, y_pred: np.ndarray, class_names: Sequence[str],
) -> Dict[str, Any]:
    """Compute per-class and overall classification metrics."""
    acc = float(accuracy_score(y_true, y_pred))
    prec, rec, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=range(len(class_names)), zero_division=0,
    )
    cm = confusion_matrix(y_true, y_pred, labels=range(len(class_names)))

    per_class = {}
    for i, name in enumerate(class_names):
        per_class[name] = {
            "precision": round(float(prec[i]), 4),
            "recall":    round(float(rec[i]), 4),
            "f1":        round(float(f1[i]), 4),
            "support":   int(support[i]),
        }

    return {
        "accuracy":      round(acc, 4),
        "macro_f1":      round(float(f1_score(y_true, y_pred, average="macro", zero_division=0)), 4),
        "weighted_f1":   round(float(f1_score(y_true, y_pred, average="weighted", zero_division=0)), 4),
        "per_class":     per_class,
        "confusion_matrix": cm.tolist(),
    }


# ============================================================================
# Sliding-window inference
# ============================================================================

def sliding_window_predict(
    model: nn.Module,
    sequence: np.ndarray,       # (180, 54)
    device: torch.device,
    window_size: int = 64,
    stride: int = 32,
) -> Dict[str, Any]:
    """Sliding-window action prediction on a full-length sequence.

    Returns:
        Dict with:
          - predicted_label: aggregated prediction (mean-probability vote)
          - window_predictions: per-window class labels
          - window_probabilities: per-window probability arrays
          - aggregated_probabilities: mean probability across windows
    """
    model.eval()
    seq_len = sequence.shape[0]
    windows = []
    start = 0
    while start + window_size <= seq_len:
        windows.append(sequence[start:start + window_size])
        start += stride
    # Always include the final window
    if start < seq_len and start + window_size > seq_len and len(windows) == 0:
        windows.append(sequence[-window_size:])

    if not windows:
        windows = [sequence]

    window_probs = []
    window_preds = []
    with torch.no_grad():
        for win in windows:
            x = torch.as_tensor(win, dtype=torch.float32, device=device).unsqueeze(0)
            logits = model(x)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
            window_probs.append(probs)
            window_preds.append(int(np.argmax(probs)))

    # Aggregate: mean probability across windows
    agg_probs = np.mean(window_probs, axis=0)
    agg_pred = int(np.argmax(agg_probs))

    return {
        "predicted_label": agg_pred,
        "confidence": float(agg_probs[agg_pred]),
        "window_predictions": window_preds,
        "aggregated_probabilities": agg_probs.tolist(),
        "n_windows": len(windows),
    }


# ============================================================================
# Visualization
# ============================================================================

def plot_confusion_matrix(
    cm: np.ndarray,
    class_names: Sequence[str],
    title: str,
    save_path: Path,
    normalize: bool = True,
) -> None:
    """Plot and save a confusion matrix heatmap."""
    if normalize:
        cm_norm = cm.astype(float) / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    else:
        cm_norm = cm

    fig, ax = plt.subplots(figsize=(9, 7.5))
    im = ax.imshow(cm_norm, cmap="Blues", vmin=0, vmax=1)

    n = len(class_names)
    ax.set_xticks(range(n))
    ax.set_yticks(range(n))
    ax.set_xticklabels([f"{nm}\n({class_names[i]})" for i, nm in enumerate(ACTION_NAMES_ZH)],
                       fontsize=8, ha="center")
    ax.set_yticklabels([f"{nm}\n({class_names[i]})" for i, nm in enumerate(ACTION_NAMES_ZH)],
                       fontsize=8, va="center")
    ax.set_xlabel("Predicted", fontsize=11)
    ax.set_ylabel("True", fontsize=11)

    # Annotate cells
    for i in range(n):
        for j in range(n):
            text = f"{cm_norm[i,j]:.2f}" if normalize else f"{cm[i,j]}"
            color = "white" if cm_norm[i, j] > 0.5 else "black"
            ax.text(j, i, text, ha="center", va="center", fontsize=7.5, color=color)

    cbar = fig.colorbar(im, ax=ax, shrink=0.82, pad=0.02)
    cbar.set_label("Proportion" if normalize else "Count", fontsize=9)

    ax.set_title(title, fontsize=12, fontweight="bold", pad=12)
    plt.tight_layout()
    save_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(save_path)
    plt.close(fig)
    print(f"  Saved: {save_path.resolve()}")


def plot_quality_distribution(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    save_path: Path,
) -> None:
    """Plot quality-level distribution as grouped bar chart."""
    fig, ax = plt.subplots(figsize=(8, 5))

    x = np.arange(N_QUALITIES)
    width = 0.35

    true_counts = [int(np.sum(y_true == q)) for q in range(N_QUALITIES)]
    pred_counts = [int(np.sum(y_pred == q)) for q in range(N_QUALITIES)]

    bars1 = ax.bar(x - width / 2, true_counts, width, label="True",
                   color=COLORS["train"], edgecolor="black", linewidth=0.5)
    bars2 = ax.bar(x + width / 2, pred_counts, width, label="Predicted",
                   color=COLORS["test"], edgecolor="black", linewidth=0.5)

    ax.set_xticks(x)
    ax.set_xticklabels([f"{QUALITY_NAMES[q]}\n({QUALITY_NAMES_ZH[q]})" for q in range(N_QUALITIES)],
                       fontsize=9)
    ax.set_ylabel("Sample Count", fontsize=11)
    ax.set_title("Quality Level Distribution: True vs Predicted", fontsize=12, fontweight="bold")
    ax.legend(fontsize=10)

    for bar in bars1:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 5,
                str(int(bar.get_height())), ha="center", fontsize=8, fontweight="bold")
    for bar in bars2:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 5,
                str(int(bar.get_height())), ha="center", fontsize=8, fontweight="bold")

    plt.tight_layout()
    save_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(save_path)
    plt.close(fig)
    print(f"  Saved: {save_path.resolve()}")


def plot_latency_histogram(
    latencies_ms: np.ndarray,
    save_path: Path,
    bins: int = 50,
) -> None:
    """Plot end-to-end latency distribution histogram."""
    fig, ax = plt.subplots(figsize=(8, 4.5))

    ax.hist(latencies_ms, bins=bins, color=COLORS["train"], edgecolor="black",
            linewidth=0.4, alpha=0.85)

    mean_val = float(np.mean(latencies_ms))
    median_val = float(np.median(latencies_ms))
    ax.axvline(mean_val, color=COLORS["test"], linestyle="--", linewidth=1.8,
               label=f"Mean: {mean_val:.2f} ms")
    ax.axvline(median_val, color=COLORS["val"], linestyle=":", linewidth=1.8,
               label=f"Median: {median_val:.2f} ms")

    ax.set_xlabel("Latency (ms)", fontsize=11)
    ax.set_ylabel("Frequency", fontsize=11)
    ax.set_title("End-to-End Inference Latency Distribution", fontsize=12, fontweight="bold")
    ax.legend(fontsize=10)

    plt.tight_layout()
    save_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(save_path)
    plt.close(fig)
    print(f"  Saved: {save_path.resolve()}")


def plot_training_curves(
    history: Dict[str, List[float]],
    save_path: Path,
) -> None:
    """Plot training loss and validation accuracy curves."""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.2))

    epochs = range(1, len(history["train_loss"]) + 1)

    ax1.plot(epochs, history["train_loss"], color=COLORS["train"], linewidth=1.5, label="Train Loss")
    ax1.plot(epochs, history["val_loss"], color=COLORS["test"], linewidth=1.5, label="Val Loss")
    ax1.set_xlabel("Epoch")
    ax1.set_ylabel("Loss")
    ax1.set_title("Training & Validation Loss", fontweight="bold")
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    ax2.plot(epochs, history["val_acc"], color=COLORS["val"], linewidth=1.5, marker="o", markersize=3)
    ax2.set_xlabel("Epoch")
    ax2.set_ylabel("Accuracy")
    ax2.set_title("Validation Accuracy", fontweight="bold")
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    save_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(save_path)
    plt.close(fig)
    print(f"  Saved: {save_path.resolve()}")


# ============================================================================
# Main experiment pipeline
# ============================================================================

def run_experiment(
    data_path: str = "sim_data.npz",
    output_dir: str = "experiments/synthetic_eval",
    batch_size: int = 64,
    max_epochs: int = 60,
    learning_rate: float = 1e-3,
    weight_decay: float = 1e-4,
    patience: int = 10,
    use_augment: bool = True,
    window_size: int = 64,
    window_stride: int = 32,
    device_name: str | None = None,
    seed: int = SEED,
) -> Dict[str, Any]:
    set_seed(seed)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))
    print(f"Device: {device}")
    print(f"Output dir: {output_path.resolve()}\n")

    # ------------------------------------------------------------------
    # 1. Load & split data
    # ------------------------------------------------------------------
    print("=" * 60)
    print("STEP 1: Data Loading & Preprocessing")
    print("=" * 60)
    seq, a_lbl, q_lbl = load_dataset(data_path)
    (
        X_train, y_a_train, y_q_train,
        X_val,   y_a_val,   y_q_val,
        X_test,  y_a_test,  y_q_test,
    ) = split_dataset(seq, a_lbl, q_lbl)

    # Normalize
    norm = fit_normalization(X_train)
    X_train = apply_normalization(X_train, norm)
    X_val   = apply_normalization(X_val, norm)
    X_test  = apply_normalization(X_test, norm)

    print(f"Train: {len(X_train)}, Val: {len(X_val)}, Test: {len(X_test)}")

    # DataLoaders
    aug_rng = np.random.RandomState(seed)
    train_dataset = IMUDataset(X_train, y_a_train, y_q_train, augment=use_augment, aug_rng=aug_rng)
    val_dataset   = IMUDataset(X_val,   y_a_val,   y_q_val,   augment=False)
    test_dataset  = IMUDataset(X_test,  y_a_test,  y_q_test,  augment=False)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader   = DataLoader(val_dataset,   batch_size=batch_size, shuffle=False)
    test_loader  = DataLoader(test_dataset,  batch_size=batch_size, shuffle=False)

    # ------------------------------------------------------------------
    # 2. Train action classifier
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("STEP 2: Action Classification Model Training")
    print("=" * 60)

    action_model = ActionClassifier(
        input_dim=INPUT_DIM, num_classes=N_ACTIONS, use_attention=True,
    ).to(device)
    print(f"Action model params: {sum(p.numel() for p in action_model.parameters()):,}")

    class_weights = compute_class_weights(y_a_train, N_ACTIONS, device)
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(action_model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", patience=patience // 3, factor=0.5,
    )
    stopper = EarlyStopping(patience=patience, mode="max")

    history: Dict[str, List[float]] = {
        "train_loss": [], "val_loss": [], "val_acc": [],
    }

    for epoch in range(1, max_epochs + 1):
        # Train
        action_model.train()
        train_losses = []
        for bx, ba, _ in train_loader:
            bx, ba = bx.to(device), ba.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = action_model(bx)
            loss = criterion(logits, ba)
            loss.backward()
            nn.utils.clip_grad_norm_(action_model.parameters(), max_norm=5.0)
            optimizer.step()
            train_losses.append(float(loss.detach().cpu()))

        # Validate
        action_model.eval()
        val_losses = []
        val_preds, val_true = [], []
        with torch.no_grad():
            for bx, ba, _ in val_loader:
                bx, ba = bx.to(device), ba.to(device)
                logits = action_model(bx)
                val_losses.append(float(criterion(logits, ba).cpu()))
                val_preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
                val_true.extend(ba.cpu().tolist())

        val_acc = float(accuracy_score(val_true, val_preds))
        avg_train_loss = float(np.mean(train_losses))
        avg_val_loss = float(np.mean(val_losses))

        history["train_loss"].append(avg_train_loss)
        history["val_loss"].append(avg_val_loss)
        history["val_acc"].append(val_acc)

        scheduler.step(val_acc)
        stopper.step(val_acc, action_model)

        if epoch % 5 == 0 or epoch == 1 or stopper.should_stop:
            print(f"  Epoch {epoch:3d} | train_loss={avg_train_loss:.4f} | "
                  f"val_loss={avg_val_loss:.4f} | val_acc={val_acc:.4f} | "
                  f"lr={optimizer.param_groups[0]['lr']:.2e}")

        if stopper.should_stop:
            print(f"  Early stopping at epoch {epoch}")
            break

    if stopper.best_state is not None:
        action_model.load_state_dict(stopper.best_state)
    best_val_acc = stopper.best

    # ------------------------------------------------------------------
    # 3. Evaluate action classifier on test set
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("STEP 3: Action Classification Evaluation")
    print("=" * 60)

    # Full-sequence evaluation
    action_model.eval()
    test_a_true, test_a_pred_full = [], []
    all_test_embeddings = []
    all_test_probs = []
    with torch.no_grad():
        for bx, ba, _ in test_loader:
            bx = bx.to(device)
            logits, embeddings = action_model(bx, return_embedding=True)
            probs = torch.softmax(logits, dim=1)
            test_a_pred_full.extend(torch.argmax(probs, dim=1).cpu().tolist())
            test_a_true.extend(ba.cpu().tolist())
            all_test_embeddings.append(embeddings.cpu().numpy())
            all_test_probs.append(probs.cpu().numpy())

    test_a_true = np.asarray(test_a_true, dtype=int)
    test_a_pred_full = np.asarray(test_a_pred_full, dtype=int)
    test_embeddings = np.concatenate(all_test_embeddings, axis=0).astype(np.float32)
    test_probs = np.concatenate(all_test_probs, axis=0).astype(np.float32)

    print("\n--- Full-Sequence Action Classification ---")
    full_metrics = action_metrics(test_a_true, test_a_pred_full, ACTION_NAMES)
    print(f"  Accuracy:     {full_metrics['accuracy']:.4f}")
    print(f"  Macro F1:     {full_metrics['macro_f1']:.4f}")
    print(f"  Weighted F1:  {full_metrics['weighted_f1']:.4f}")
    print("\n  Per-class metrics:")
    print(f"  {'Class':20s} {'Prec':>8s} {'Recall':>8s} {'F1':>8s} {'Support':>8s}")
    for name, m in full_metrics["per_class"].items():
        zh = ACTION_NAMES_ZH[ACTION_NAMES.index(name)]
        print(f"  {name:20s} {m['precision']:8.4f} {m['recall']:8.4f} {m['f1']:8.4f} {m['support']:8d}")

    # Sliding-window evaluation
    print("\n--- Sliding-Window Inference (window=64, stride=32) ---")
    test_a_pred_sw = []
    sw_latencies = []
    for i in range(len(X_test)):
        t0 = time.perf_counter()
        result = sliding_window_predict(
            action_model, X_test[i], device,
            window_size=window_size, stride=window_stride,
        )
        sw_latencies.append((time.perf_counter() - t0) * 1000.0)
        test_a_pred_sw.append(result["predicted_label"])
    test_a_pred_sw = np.asarray(test_a_pred_sw, dtype=int)

    sw_metrics = action_metrics(test_a_true, test_a_pred_sw, ACTION_NAMES)
    print(f"  Accuracy:     {sw_metrics['accuracy']:.4f}")
    print(f"  Macro F1:     {sw_metrics['macro_f1']:.4f}")
    print(f"  Weighted F1:  {sw_metrics['weighted_f1']:.4f}")

    # Confusion matrix figure (full-sequence)
    cm_full = np.array(full_metrics["confusion_matrix"])
    plot_confusion_matrix(
        cm_full, ACTION_NAMES,
        title="Action Classification Confusion Matrix (Full-Sequence)",
        save_path=output_path / "fig_confusion_matrix.png",
    )

    # Training curves
    plot_training_curves(history, output_path / "fig_training_curves.png")

    # ------------------------------------------------------------------
    # 4. Train quality classifier
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("STEP 4: Quality Assessment Model")
    print("=" * 60)

    # Build quality features from action model embeddings
    # Train set features
    action_model.eval()
    train_embeddings = []
    train_probs = []
    with torch.no_grad():
        for bx, _, _ in DataLoader(
            IMUDataset(X_train, y_a_train, y_q_train, augment=False),
            batch_size=batch_size, shuffle=False,
        ):
            bx = bx.to(device)
            _, emb = action_model(bx, return_embedding=True)
            probs = torch.softmax(action_model(bx), dim=1)
            train_embeddings.append(emb.cpu().numpy())
            train_probs.append(probs.cpu().numpy())
    train_emb = np.concatenate(train_embeddings, axis=0).astype(np.float32)
    train_prob = np.concatenate(train_probs, axis=0).astype(np.float32)
    train_a_pred = np.argmax(train_prob, axis=1).astype(int)

    X_quality_train = build_quality_features(train_emb, train_prob, train_a_pred)
    y_quality_train = y_q_train.astype(int)

    X_quality_test = build_quality_features(
        test_embeddings, test_probs, test_a_pred_full,
    )
    y_quality_test = y_q_test.astype(int)

    print(f"  Quality feature dim: {X_quality_train.shape[1]}")

    # Gaussian Naive Bayes
    gnb_pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("gnb", GaussianNB()),
    ])
    gnb_pipeline.fit(X_quality_train, y_quality_train)
    q_pred_gnb = gnb_pipeline.predict(X_quality_test)
    q_prob_gnb = gnb_pipeline.predict_proba(X_quality_test)

    q_acc_gnb = float(accuracy_score(y_quality_test, q_pred_gnb))
    q_f1_gnb = float(f1_score(y_quality_test, q_pred_gnb, average="macro", zero_division=0))

    print(f"\n  GaussianNB Quality Classifier:")
    print(f"    Accuracy:  {q_acc_gnb:.4f}")
    print(f"    Macro F1:  {q_f1_gnb:.4f}")
    print(f"    Per-class accuracy:")
    for q in range(N_QUALITIES):
        mask = y_quality_test == q
        if np.any(mask):
            q_acc = float(np.mean(q_pred_gnb[mask] == q))
            print(f"      {QUALITY_NAMES[q]:9s} ({QUALITY_NAMES_ZH[q]}): {q_acc:.4f} "
                  f"({int(np.sum(mask))} samples)")

    # Continuous quality scores
    class_ids = list(range(N_QUALITIES))
    continuous_scores = np.array([
        estimate_quality_score(class_ids, q_prob_gnb[i].tolist())
        for i in range(len(y_quality_test))
    ])
    print(f"    Mean quality score: {float(np.mean(continuous_scores)):.1f}")

    # --- Neural Network quality classifier ---
    print(f"\n  Neural Network Quality Classifier:")
    qnn_input_dim = X_quality_train.shape[1]
    quality_nn = QualityNN(input_dim=qnn_input_dim).to(device)

    qnn_criterion = nn.CrossEntropyLoss()
    qnn_optimizer = torch.optim.AdamW(quality_nn.parameters(), lr=1e-3, weight_decay=1e-4)
    qnn_stopper = EarlyStopping(patience=15, mode="max")

    # Prepare torch datasets for quality
    q_train_set = torch.utils.data.TensorDataset(
        torch.as_tensor(X_quality_train, dtype=torch.float32),
        torch.as_tensor(y_quality_train, dtype=torch.long),
    )
    q_val_emb = []
    q_val_prob = []
    action_model.eval()
    with torch.no_grad():
        for bx, _, _ in DataLoader(
            IMUDataset(X_val, y_a_val, y_q_val, augment=False),
            batch_size=batch_size, shuffle=False,
        ):
            bx = bx.to(device)
            _, emb = action_model(bx, return_embedding=True)
            probs = torch.softmax(action_model(bx), dim=1)
            q_val_emb.append(emb.cpu().numpy())
            q_val_prob.append(probs.cpu().numpy())
    val_emb = np.concatenate(q_val_emb, axis=0).astype(np.float32)
    val_prob = np.concatenate(q_val_prob, axis=0).astype(np.float32)
    val_a_pred = np.argmax(val_prob, axis=1).astype(int)
    X_quality_val = build_quality_features(val_emb, val_prob, val_a_pred)

    q_val_set = torch.utils.data.TensorDataset(
        torch.as_tensor(X_quality_val, dtype=torch.float32),
        torch.as_tensor(y_q_val, dtype=torch.long),
    )
    q_train_loader = DataLoader(q_train_set, batch_size=256, shuffle=True)
    q_val_loader = DataLoader(q_val_set, batch_size=256, shuffle=False)

    for epoch in range(1, 81):
        quality_nn.train()
        train_losses = []
        for bx, by in q_train_loader:
            bx, by = bx.to(device), by.to(device)
            qnn_optimizer.zero_grad(set_to_none=True)
            loss = qnn_criterion(quality_nn(bx), by)
            loss.backward()
            qnn_optimizer.step()
            train_losses.append(float(loss.detach().cpu()))

        quality_nn.eval()
        val_preds, val_true = [], []
        with torch.no_grad():
            for bx, by in q_val_loader:
                bx = bx.to(device)
                val_preds.extend(torch.argmax(quality_nn(bx), dim=1).cpu().tolist())
                val_true.extend(by.cpu().tolist())
        val_acc = float(accuracy_score(val_true, val_preds))
        qnn_stopper.step(val_acc, quality_nn)
        if qnn_stopper.should_stop:
            break

    if qnn_stopper.best_state is not None:
        quality_nn.load_state_dict(qnn_stopper.best_state)

    # Evaluate QualityNN on test set
    quality_nn.eval()
    with torch.no_grad():
        q_test_tensor = torch.as_tensor(X_quality_test, dtype=torch.float32, device=device)
        q_logits_nn = quality_nn(q_test_tensor)
        q_probs_nn = torch.softmax(q_logits_nn, dim=1).cpu().numpy()
    q_pred_nn = np.argmax(q_probs_nn, axis=1).astype(int)

    q_acc_nn = float(accuracy_score(y_quality_test, q_pred_nn))
    q_f1_nn = float(f1_score(y_quality_test, q_pred_nn, average="macro", zero_division=0))

    print(f"    Accuracy:  {q_acc_nn:.4f}")
    print(f"    Macro F1:  {q_f1_nn:.4f}")
    print(f"    Per-class accuracy:")
    for q in range(N_QUALITIES):
        mask = y_quality_test == q
        if np.any(mask):
            q_acc = float(np.mean(q_pred_nn[mask] == q))
            print(f"      {QUALITY_NAMES[q]:9s} ({QUALITY_NAMES_ZH[q]}): {q_acc:.4f} "
                  f"({int(np.sum(mask))} samples)")

    # Continuous quality scores from NN
    nn_continuous = np.array([
        estimate_quality_score(list(range(N_QUALITIES)), q_probs_nn[i].tolist())
        for i in range(len(y_quality_test))
    ])
    print(f"    Mean quality score (NN): {float(np.mean(nn_continuous)):.1f}")

    # Quality distribution figure
    plot_quality_distribution(
        y_quality_test, q_pred_nn,
        output_path / "fig_quality_distribution.png",
    )

    # ------------------------------------------------------------------
    # 5. Latency benchmark
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("STEP 5: End-to-End Latency Benchmark")
    print("=" * 60)

    # Warm-up
    warmup_seq = torch.as_tensor(X_test[0:1], dtype=torch.float32, device=device)
    for _ in range(10):
        _ = action_model(warmup_seq)
    if device.type == "cuda":
        torch.cuda.synchronize()

    # Measure per-sequence latency
    e2e_latencies = []
    for i in range(len(X_test)):
        seq_tensor = torch.as_tensor(X_test[i:i + 1], dtype=torch.float32, device=device)
        if device.type == "cuda":
            torch.cuda.synchronize()
        t0 = time.perf_counter()
        with torch.no_grad():
            logits, emb = action_model(seq_tensor, return_embedding=True)
        if device.type == "cuda":
            torch.cuda.synchronize()
        elapsed = (time.perf_counter() - t0) * 1000.0
        e2e_latencies.append(elapsed)

    e2e_latencies = np.array(e2e_latencies)
    print(f"  Samples measured: {len(e2e_latencies)}")
    print(f"  Mean latency:   {float(np.mean(e2e_latencies)):.3f} ms")
    print(f"  Median latency: {float(np.median(e2e_latencies)):.3f} ms")
    print(f"  Min latency:    {float(np.min(e2e_latencies)):.3f} ms")
    print(f"  Max latency:    {float(np.max(e2e_latencies)):.3f} ms")
    print(f"  Std latency:    {float(np.std(e2e_latencies)):.3f} ms")
    print(f"  P95 latency:    {float(np.percentile(e2e_latencies, 95)):.3f} ms")
    print(f"  P99 latency:    {float(np.percentile(e2e_latencies, 99)):.3f} ms")

    print(f"\n  Sliding-window mean latency: {float(np.mean(sw_latencies)):.3f} ms")
    print(f"  FPS (full-sequence): {1000.0 / float(np.mean(e2e_latencies)):.1f}")
    print(f"  FPS (sliding-window): {1000.0 / float(np.mean(sw_latencies)):.1f}")

    plot_latency_histogram(e2e_latencies, output_path / "fig_latency_distribution.png")

    # ------------------------------------------------------------------
    # 6. Summary
    # ------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("EXPERIMENT SUMMARY")
    print("=" * 60)
    print(f"  Action Classification (full-seq):  acc={full_metrics['accuracy']:.4f}, "
          f"macro_f1={full_metrics['macro_f1']:.4f}")
    print(f"  Action Classification (slide-win): acc={sw_metrics['accuracy']:.4f}, "
          f"macro_f1={sw_metrics['macro_f1']:.4f}")
    print(f"  Quality Assessment (GaussianNB):   acc={q_acc_gnb:.4f}, "
          f"macro_f1={q_f1_gnb:.4f}")
    print(f"  Quality Assessment (Neural Net):   acc={q_acc_nn:.4f}, "
          f"macro_f1={q_f1_nn:.4f}")
    print(f"  Mean E2E latency: {float(np.mean(e2e_latencies)):.2f} ms "
          f"({1000.0 / float(np.mean(e2e_latencies)):.1f} FPS)")
    print(f"\n  All outputs saved to: {output_path.resolve()}")

    return {
        "action_full_metrics": full_metrics,
        "action_sliding_metrics": sw_metrics,
        "quality_gnb_accuracy": q_acc_gnb,
        "quality_gnb_macro_f1": q_f1_gnb,
        "quality_nn_accuracy": q_acc_nn,
        "quality_nn_macro_f1": q_f1_nn,
        "mean_latency_ms": float(np.mean(e2e_latencies)),
        "p95_latency_ms": float(np.percentile(e2e_latencies, 95)),
        "best_val_acc": best_val_acc,
        "output_dir": str(output_path.resolve()),
    }


# ============================================================================
# CLI
# ============================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Evaluate synthetic roller-skating IMU data with CNN-LSTM-Attention.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python tools/evaluate_synthetic_data.py
  python tools/evaluate_synthetic_data.py --data sim_data.npz --epochs 50
  python tools/evaluate_synthetic_data.py --no-augment --batch-size 32
  python tools/evaluate_synthetic_data.py --output-dir experiments/my_eval
        """,
    )
    p.add_argument("--data", default="sim_data.npz", help="Path to sim_data.npz.")
    p.add_argument("--output-dir", default="experiments/synthetic_eval",
                   help="Output directory for artifacts.")
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--epochs", type=int, default=60,
                   help="Max training epochs.")
    p.add_argument("--lr", type=float, default=1e-3, help="Learning rate.")
    p.add_argument("--patience", type=int, default=10,
                   help="Early stopping patience.")
    p.add_argument("--no-augment", action="store_true",
                   help="Disable data augmentation.")
    p.add_argument("--window-size", type=int, default=64,
                   help="Sliding window size (frames).")
    p.add_argument("--window-stride", type=int, default=32,
                   help="Sliding window stride (frames).")
    p.add_argument("--device", default=None, help="Device (cpu, cuda, cuda:0).")
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not Path(args.data).exists():
        print(f"Error: data file not found: {args.data}")
        print("Run 'python tools/generate_synthetic_data.py' first.")
        return 1

    run_experiment(
        data_path=args.data,
        output_dir=args.output_dir,
        batch_size=args.batch_size,
        max_epochs=args.epochs,
        learning_rate=args.lr,
        patience=args.patience,
        use_augment=not args.no_augment,
        window_size=args.window_size,
        window_stride=args.window_stride,
        device_name=args.device,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
