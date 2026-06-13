"""Train the CNN-LSTM action classifier from baseline-compatible JSONL data."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from torch.utils.data import DataLoader
from tqdm import tqdm

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    SequenceTensorDataset,
    apply_normalization,
    fit_normalization,
    load_sequence_dataset_from_jsonl,
    write_json,
)
from src.model import ActionModelConfig, CNNLSTMAttentionClassifier


DEFAULT_RANDOM_SEED = 42


def set_random_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _can_stratify(labels: np.ndarray, min_count: int = 2) -> bool:
    counts = Counter(int(label) for label in labels.tolist())
    return bool(counts) and min(counts.values()) >= min_count


def split_dataset_indices(
    labels: np.ndarray,
    val_ratio: float,
    test_ratio: float,
    seed: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    all_indices = np.arange(len(labels))
    if len(all_indices) < 4:
        raise ValueError("Deep action training requires at least 4 valid samples.")

    holdout_ratio = val_ratio + test_ratio
    stratify = labels if _can_stratify(labels) else None
    train_indices, holdout_indices = train_test_split(
        all_indices,
        test_size=holdout_ratio,
        random_state=seed,
        shuffle=True,
        stratify=stratify,
    )

    holdout_labels = labels[holdout_indices]
    val_fraction = val_ratio / holdout_ratio
    holdout_stratify = holdout_labels if _can_stratify(holdout_labels) else None
    val_indices, test_indices = train_test_split(
        holdout_indices,
        train_size=val_fraction,
        random_state=seed,
        shuffle=True,
        stratify=holdout_stratify,
    )
    return train_indices, val_indices, test_indices


def _compute_class_weights(labels: np.ndarray, num_classes: int, device: torch.device) -> torch.Tensor:
    counts = Counter(int(label) for label in labels.tolist())
    total = float(len(labels))
    weights = []
    for class_id in range(num_classes):
        count = float(counts.get(class_id, 1))
        weights.append(total / (num_classes * count))
    return torch.tensor(weights, dtype=torch.float32, device=device)


def _evaluate_model(
    model: CNNLSTMAttentionClassifier,
    loader: DataLoader,
    device: torch.device,
    label_id_to_name: Dict[int, str],
) -> Dict[str, Any]:
    model.eval()
    all_labels: list[int] = []
    all_predictions: list[int] = []
    all_probabilities: list[np.ndarray] = []

    with torch.no_grad():
        for batch_x, batch_y in loader:
            batch_x = batch_x.to(device)
            logits = model(batch_x)
            probabilities = torch.softmax(logits, dim=1)
            predictions = torch.argmax(probabilities, dim=1)
            all_labels.extend(batch_y.cpu().numpy().astype(int).tolist())
            all_predictions.extend(predictions.cpu().numpy().astype(int).tolist())
            all_probabilities.extend(probabilities.cpu().numpy())

    labels_array = np.asarray(all_labels, dtype=int)
    predictions_array = np.asarray(all_predictions, dtype=int)
    probabilities_array = np.asarray(all_probabilities, dtype=float)
    class_ids = sorted(label_id_to_name)
    top2_correct = 0
    if probabilities_array.size:
        top2 = np.argsort(probabilities_array, axis=1)[:, -2:]
        top2_correct = int(sum(labels_array[index] in top2[index] for index in range(len(labels_array))))

    return {
        "samples": int(len(labels_array)),
        "accuracy": float(accuracy_score(labels_array, predictions_array)) if len(labels_array) else 0.0,
        "macro_f1": float(f1_score(labels_array, predictions_array, average="macro", zero_division=0)) if len(labels_array) else 0.0,
        "weighted_f1": float(f1_score(labels_array, predictions_array, average="weighted", zero_division=0)) if len(labels_array) else 0.0,
        "top2_accuracy": float(top2_correct / len(labels_array)) if len(labels_array) else 0.0,
        "classification_report": classification_report(
            labels_array,
            predictions_array,
            labels=class_ids,
            target_names=[label_id_to_name[class_id] for class_id in class_ids],
            output_dict=True,
            zero_division=0,
        ),
        "confusion_matrix": confusion_matrix(labels_array, predictions_array, labels=class_ids).tolist(),
    }


def run_action_training(
    jsonl_path: str | Path,
    output_dir: str | Path,
    sequence_length: int = 180,
    use_derived_channels: bool = False,
    use_attention: bool = True,
    batch_size: int = 32,
    max_epochs: int = 100,
    learning_rate: float = 1e-3,
    weight_decay: float = 1e-4,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    patience: int = 12,
    seed: int = DEFAULT_RANDOM_SEED,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    set_random_seed(seed)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

    sequence_config = SequenceConfig(
        sequence_length=sequence_length,
        derived_channels=("acc_mag", "gyro_mag") if use_derived_channels else (),
    )
    X, y, metadata, label_name_to_id, label_id_to_name, dataset_stats = load_sequence_dataset_from_jsonl(
        jsonl_path=jsonl_path,
        config=sequence_config,
    )
    train_indices, val_indices, test_indices = split_dataset_indices(y, val_ratio=val_ratio, test_ratio=test_ratio, seed=seed)
    normalization = fit_normalization(X[train_indices])
    X_normalized = apply_normalization(X, normalization)

    train_loader = DataLoader(
        SequenceTensorDataset(X_normalized[train_indices], y[train_indices]),
        batch_size=batch_size,
        shuffle=True,
    )
    val_loader = DataLoader(
        SequenceTensorDataset(X_normalized[val_indices], y[val_indices]),
        batch_size=batch_size,
        shuffle=False,
    )
    test_loader = DataLoader(
        SequenceTensorDataset(X_normalized[test_indices], y[test_indices]),
        batch_size=batch_size,
        shuffle=False,
    )

    model_config = ActionModelConfig(
        input_dim=sequence_config.input_dim,
        num_classes=len(label_name_to_id),
        use_attention=use_attention,
    )
    model = CNNLSTMAttentionClassifier(model_config).to(device)
    criterion = nn.CrossEntropyLoss(weight=_compute_class_weights(y[train_indices], len(label_name_to_id), device))
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", patience=4, factor=0.5)

    best_val_macro_f1 = -1.0
    best_state: Optional[Dict[str, torch.Tensor]] = None
    epochs_without_improvement = 0
    history: list[Dict[str, Any]] = []

    for epoch in range(1, max_epochs + 1):
        model.train()
        train_losses: list[float] = []
        progress = tqdm(train_loader, desc=f"epoch {epoch}", leave=False)
        for batch_x, batch_y in progress:
            batch_x = batch_x.to(device)
            batch_y = batch_y.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch_x)
            loss = criterion(logits, batch_y)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            optimizer.step()
            train_losses.append(float(loss.detach().cpu()))

        val_metrics = _evaluate_model(model, val_loader, device, label_id_to_name)
        scheduler.step(float(val_metrics["macro_f1"]))
        epoch_summary = {
            "epoch": int(epoch),
            "train_loss": float(np.mean(train_losses)) if train_losses else 0.0,
            "val_accuracy": float(val_metrics["accuracy"]),
            "val_macro_f1": float(val_metrics["macro_f1"]),
            "learning_rate": float(optimizer.param_groups[0]["lr"]),
        }
        history.append(epoch_summary)

        if val_metrics["macro_f1"] > best_val_macro_f1:
            best_val_macro_f1 = float(val_metrics["macro_f1"])
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= patience:
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    val_metrics = _evaluate_model(model, val_loader, device, label_id_to_name)
    test_metrics = _evaluate_model(model, test_loader, device, label_id_to_name)

    checkpoint = {
        "model_state_dict": model.state_dict(),
        "model_config": model_config.to_dict(),
        "sequence_config": sequence_config.to_dict(),
        "normalization": normalization,
        "label_metadata": {
            "label_schema": "dynamic_jsonl",
            "action_labels": {str(label_id): label_name for label_id, label_name in label_id_to_name.items()},
            "action_label_to_id": {label_name: int(label_id) for label_name, label_id in label_name_to_id.items()},
        },
    }
    model_path = output_path / "action_model.pt"
    torch.save(checkpoint, model_path)

    dataset_summary = {
        "task": "deep_action_classification",
        "data_source": "jsonl_action_samples",
        "input_file": str(Path(jsonl_path)),
        "dataset_stats": dataset_stats,
        "num_samples": int(len(y)),
        "train_samples": int(len(train_indices)),
        "val_samples": int(len(val_indices)),
        "test_samples": int(len(test_indices)),
        "class_counts": {label_id_to_name[class_id]: int(np.sum(y == class_id)) for class_id in sorted(label_id_to_name)},
    }
    training_summary = {
        "task": "deep_action_classification",
        "model_file": str(model_path),
        "model_config": model_config.to_dict(),
        "sequence_config": sequence_config.to_dict(),
        "device": str(device),
        "best_val_macro_f1": float(best_val_macro_f1),
        "history": history,
    }
    evaluation_summary = {
        "validation": val_metrics,
        "test": test_metrics,
    }
    prediction_policy = {
        "task": "deep_action_classification",
        "policy": "softmax_argmax",
        "confidence_threshold": 0.65,
        "top_margin_threshold": 0.15,
    }

    paths = {
        "action_model.pt": str(model_path),
        "dataset_summary.json": str(write_json(output_path / "dataset_summary.json", dataset_summary)),
        "training_summary.json": str(write_json(output_path / "training_summary.json", training_summary)),
        "evaluation_summary.json": str(write_json(output_path / "evaluation_summary.json", evaluation_summary)),
        "prediction_policy.json": str(write_json(output_path / "prediction_policy.json", prediction_policy)),
        "label_metadata.json": str(write_json(output_path / "label_metadata.json", checkpoint["label_metadata"])),
        "deep_feature_config.json": str(write_json(output_path / "deep_feature_config.json", sequence_config.to_dict())),
        "normalization.json": str(write_json(output_path / "normalization.json", normalization)),
    }

    return {
        "model_file": str(model_path),
        "num_samples": int(len(y)),
        "train_samples": int(len(train_indices)),
        "val_samples": int(len(val_indices)),
        "test_samples": int(len(test_indices)),
        "best_val_macro_f1": float(best_val_macro_f1),
        "test_metrics": test_metrics,
        "artifacts": paths,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train CNN-LSTM action classifier from JSONL.")
    parser.add_argument("--jsonl", required=True, help="Path to baseline-compatible JSONL samples.")
    parser.add_argument("--output-dir", required=True, help="Directory for deep model artifacts.")
    parser.add_argument("--sequence-length", type=int, default=180)
    parser.add_argument("--use-derived-channels", action="store_true", help="Append acc_mag and gyro_mag channels.")
    parser.add_argument("--disable-attention", action="store_true")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-epochs", type=int, default=100)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--patience", type=int, default=12)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        result = run_action_training(
            jsonl_path=args.jsonl,
            output_dir=args.output_dir,
            sequence_length=args.sequence_length,
            use_derived_channels=bool(args.use_derived_channels),
            use_attention=not bool(args.disable_attention),
            batch_size=args.batch_size,
            max_epochs=args.max_epochs,
            learning_rate=args.learning_rate,
            patience=args.patience,
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
