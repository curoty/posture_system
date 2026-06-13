#!/usr/bin/env python3
"""Re-train 4 ablation models at size=35 and output confusion matrices."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_cnn_only
import model_cnn_lstm
import model_cnn_attention
import model_full

SEED = 42
SEQ_LENGTH = 180
INPUT_DIM = 54
N_ACTIONS = 7
N_QUALITIES = 4
TEST_PER_COMBO = 100
TRAIN_PER_COMBO = 35

LABELS_SHORT = ["WS", "SPR", "JMP", "TRN", "STP", "AS", "CMB"]
LABELS_FULL = ["weight_shift", "side_push_recover", "jump", "turn", "stop", "arm_swing", "combination"]

HP = {
    "batch_size": 64,
    "max_epochs": 40,
    "learning_rate": 1e-3,
    "weight_decay": 1e-4,
    "patience": 12,
}


def set_seed(seed=SEED):
    np.random.seed(seed)
    torch.manual_seed(seed)


class EarlyStopping:
    def __init__(self, patience=10, mode="max", min_delta=1e-4):
        self.patience = patience
        self.mode = mode
        self.min_delta = min_delta
        self.best = -float("inf") if mode == "max" else float("inf")
        self.counter = 0
        self.best_state = None
        self.should_stop = False

    def step(self, metric, model):
        improved = ((self.mode == "max" and metric > self.best + self.min_delta) or
                    (self.mode == "min" and metric < self.best - self.min_delta))
        if improved:
            self.best = metric
            self.counter = 0
            self.best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            self.counter += 1
            if self.counter >= self.patience:
                self.should_stop = True


def compute_class_weights(labels, num_classes, device):
    counts = Counter(int(l) for l in labels.tolist())
    total = float(len(labels))
    weights = [total / (num_classes * max(counts.get(c, 1), 1)) for c in range(num_classes)]
    return torch.tensor(weights, dtype=torch.float32, device=device)


class IMUDataset(Dataset):
    def __init__(self, sequences, labels):
        self.sequences = sequences
        self.labels = labels

    def __len__(self):
        return len(self.sequences)

    def __getitem__(self, idx):
        return (torch.as_tensor(self.sequences[idx], dtype=torch.float32),
                torch.tensor(self.labels[idx], dtype=torch.long))


def stratified_sample(sequences, action_labels, quality_labels, per_combo, rng):
    indices = []
    for a in range(N_ACTIONS):
        for q in range(N_QUALITIES):
            combo_idx = np.where((action_labels == a) & (quality_labels == q))[0]
            n = min(per_combo, len(combo_idx))
            indices.extend(rng.choice(combo_idx, size=n, replace=False).tolist())
    return np.array(indices)


def normalize(X_train, X_val, X_test):
    flat = X_train.reshape(-1, X_train.shape[-1])
    mean = np.mean(flat, axis=0).astype(np.float32)
    std = np.std(flat, axis=0).astype(np.float32)
    std = np.where(std < 1e-6, 1.0, std)
    return ((X_train - mean) / std).astype(np.float32), \
           ((X_val - mean) / std).astype(np.float32), \
           ((X_test - mean) / std).astype(np.float32)


def train_and_evaluate(model, model_name, train_loader, val_loader, test_data, device):
    """Train model, return best checkpoint, test predictions, and metrics."""
    X_test, y_test = test_data
    test_loader = DataLoader(IMUDataset(X_test, y_test), batch_size=HP["batch_size"], shuffle=False)

    class_weights = compute_class_weights(
        train_loader.dataset.labels, N_ACTIONS, device)
    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = torch.optim.AdamW(model.parameters(), lr=HP["learning_rate"],
                                  weight_decay=HP["weight_decay"])
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", patience=4, factor=0.5)
    stopper = EarlyStopping(patience=HP["patience"], mode="max")

    for epoch in range(1, HP["max_epochs"] + 1):
        model.train()
        for bx, by in train_loader:
            bx, by = bx.to(device), by.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(bx), by)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()

        model.eval()
        val_preds, val_trues = [], []
        with torch.no_grad():
            for bx, by in val_loader:
                logits = model(bx.to(device))
                val_preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
                val_trues.extend(by.cpu().tolist())
        val_acc = float(accuracy_score(val_trues, val_preds))

        scheduler.step(val_acc)
        stopper.step(val_acc, model)
        if stopper.should_stop:
            break

    # Load best weights
    if stopper.best_state is not None:
        model.load_state_dict(stopper.best_state)

    # Test inference
    model.eval()
    all_preds, all_trues = [], []
    with torch.no_grad():
        for bx, by in test_loader:
            logits = model(bx.to(device))
            all_preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
            all_trues.extend(by.cpu().tolist())

    yt = np.asarray(all_trues, dtype=int)
    yp = np.asarray(all_preds, dtype=int)

    cm = confusion_matrix(yt, yp, labels=range(N_ACTIONS))
    acc = float(accuracy_score(yt, yp))
    macro_f1 = float(f1_score(yt, yp, average="macro", zero_division=0))
    prec, rec, f1, _ = precision_recall_fscore_support(yt, yp, labels=range(N_ACTIONS), zero_division=0)

    return {
        "cm": cm,
        "acc": acc,
        "macro_f1": macro_f1,
        "per_class_f1": {LABELS_FULL[i]: round(float(f1[i]), 4) for i in range(N_ACTIONS)},
        "per_class_prec": {LABELS_FULL[i]: round(float(prec[i]), 4) for i in range(N_ACTIONS)},
        "per_class_rec": {LABELS_FULL[i]: round(float(rec[i]), 4) for i in range(N_ACTIONS)},
    }


def main():
    data_path = "dataset_v3.npz"
    if not Path(data_path).exists():
        print(f"Error: {data_path} not found")
        return 1

    data = np.load(data_path)
    sequences = data["sequences"].astype(np.float32)
    action_labels = data["action_labels"].astype(np.int64)
    quality_labels = data["quality_labels"].astype(np.int64)
    device = torch.device("cpu")

    master_rng = np.random.RandomState(SEED)

    # Fixed test set: 100 per combo
    test_idx = stratified_sample(sequences, action_labels, quality_labels, TEST_PER_COMBO, master_rng)
    test_mask = np.zeros(len(sequences), dtype=bool)
    test_mask[test_idx] = True
    remaining_idx = np.where(~test_mask)[0]

    # Train: 35 per combo from remaining
    rng = np.random.RandomState(SEED)
    train_idx_remap = stratified_sample(
        sequences[remaining_idx], action_labels[remaining_idx],
        quality_labels[remaining_idx], TRAIN_PER_COMBO, rng,
    )
    train_mask = np.zeros(len(remaining_idx), dtype=bool)
    train_mask[train_idx_remap] = True
    val_idx_remap = np.where(~train_mask)[0]

    X_train = sequences[remaining_idx][train_idx_remap]
    y_train = action_labels[remaining_idx][train_idx_remap]
    X_val = sequences[remaining_idx][val_idx_remap]
    y_val = action_labels[remaining_idx][val_idx_remap]
    X_test = sequences[test_idx]
    y_test = action_labels[test_idx]

    X_train, X_val, X_test = normalize(X_train, X_val, X_test)

    print(f"Train: {len(X_train)}  Val: {len(X_val)}  Test: {len(X_test)}")
    print(f"Test label distribution: {Counter(y_test.tolist())}")

    model_specs = [
        (model_cnn_only.Model, model_cnn_only.MODEL_NAME, model_cnn_only.DESCRIPTION),
        (model_cnn_lstm.Model, model_cnn_lstm.MODEL_NAME, model_cnn_lstm.DESCRIPTION),
        (model_cnn_attention.Model, model_cnn_attention.MODEL_NAME, model_cnn_attention.DESCRIPTION),
        (model_full.Model, model_full.MODEL_NAME, model_full.DESCRIPTION),
    ]

    all_results = []

    for model_cls, name, desc in model_specs:
        print(f"\n{'='*60}")
        print(f"Training: {name}")
        print(f"{'='*60}")

        set_seed(SEED)
        model = model_cls().to(device)

        train_loader = DataLoader(IMUDataset(X_train, y_train),
                                  batch_size=HP["batch_size"], shuffle=True)
        val_loader = DataLoader(IMUDataset(X_val, y_val),
                                batch_size=HP["batch_size"], shuffle=False)

        result = train_and_evaluate(model, name, train_loader, val_loader,
                                    (X_test, y_test), device)
        result["name"] = name
        result["desc"] = desc
        all_results.append(result)

    # --- Print formatted output ---
    print("\n\n" + "=" * 70)
    print("CONFUSION MATRICES (rows=True label, cols=Predicted label)")
    print("=" * 70)

    for r in all_results:
        name = r["name"]
        acc = r["acc"]
        cm = r["cm"]
        f1s = r["per_class_f1"]
        mf1 = r["macro_f1"]

        print(f"\n### {name}  Acc={acc*100:.2f}%")
        print("Confusion Matrix (rows=True, cols=Predicted):")
        print(f"{'':>6s}", end="")
        for lb in LABELS_SHORT:
            print(f"{lb:>6s}", end="")
        print()
        for i in range(N_ACTIONS):
            print(f"{LABELS_SHORT[i]:>6s}", end="")
            for j in range(N_ACTIONS):
                print(f"{cm[i][j]:6d}", end="")
            print()

        print(f"\nPer-class F1:")
        f1_str = ", ".join(f"{LABELS_SHORT[i]}={f1s[LABELS_FULL[i]]:.4f}" for i in range(N_ACTIONS))
        print(f"  {f1_str}")
        print(f"Macro F1={mf1:.4f}")

    # --- Save raw data for plotting ---
    import json
    output = {
        "labels_short": LABELS_SHORT,
        "labels_full": LABELS_FULL,
        "models": []
    }
    for r in all_results:
        output["models"].append({
            "name": r["name"],
            "accuracy": round(r["acc"], 4),
            "macro_f1": round(r["macro_f1"], 4),
            "confusion_matrix": r["cm"].tolist(),
            "per_class_f1": {LABELS_SHORT[i]: r["per_class_f1"][LABELS_FULL[i]] for i in range(N_ACTIONS)},
        })

    out_path = "experiments/confusion_matrices_size35.json"
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\nRaw data saved to: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
