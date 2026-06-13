"""Train Gaussian Naive Bayes quality classifiers from deep action embeddings."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np
import torch
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import GaussianNB
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    iter_jsonl_records,
    write_json,
)
from src.model import ActionModelConfig, CNNLSTMAttentionClassifier
from src.quality_labels import (
    QUALITY_CLASS_IDS,
    convert_score_to_quality_class,
    estimate_quality_score_from_probabilities,
    get_quality_code,
    get_quality_label_zh,
)


def load_action_checkpoint(model_path: str | Path, device: torch.device) -> Tuple[CNNLSTMAttentionClassifier, Dict[str, Any]]:
    checkpoint = torch.load(model_path, map_location=device, weights_only=False)
    model_config = ActionModelConfig.from_dict(checkpoint["model_config"])
    model = CNNLSTMAttentionClassifier(model_config)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.to(device)
    model.eval()
    return model, checkpoint


def load_quality_rows(dataset_path: str | Path) -> List[Dict[str, Any]]:
    path = Path(dataset_path)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as file:
            return [dict(row) for row in csv.DictReader(file)]
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            return [dict(row) for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict) and isinstance(payload.get("evaluation_rows"), list):
            return [dict(row) for row in payload["evaluation_rows"] if isinstance(row, dict)]
        raise ValueError("Quality JSON must be a list or contain evaluation_rows.")

    rows = []
    with path.open("r", encoding="utf-8") as file:
        for line in file:
            stripped = line.strip()
            if stripped:
                payload = json.loads(stripped)
                if isinstance(payload, dict):
                    rows.append(payload)
    return rows


def _parse_sample_index(row: Dict[str, Any]) -> Optional[int]:
    for key in ("sample_index", "sample_id", "id"):
        try:
            return int(row.get(key))
        except (TypeError, ValueError):
            continue
    return None


def _parse_quality_class(row: Dict[str, Any]) -> Optional[int]:
    for key in ("quality_class", "class_id", "qualityClass"):
        try:
            value = int(row.get(key))
            if value in QUALITY_CLASS_IDS:
                return value
        except (TypeError, ValueError):
            continue

    for key in ("coachScore", "score", "regression_label", "similarity_score", "similarity"):
        try:
            return convert_score_to_quality_class(float(row.get(key)))
        except (TypeError, ValueError):
            continue
    return None


def build_quality_label_map(rows: Sequence[Dict[str, Any]]) -> Dict[int, int]:
    label_map: Dict[int, int] = {}
    for row in rows:
        sample_index = _parse_sample_index(row)
        quality_class = _parse_quality_class(row)
        if sample_index is None or quality_class is None:
            continue
        label_map[int(sample_index)] = int(quality_class)
    return label_map


def build_quality_feature_matrix(
    model: CNNLSTMAttentionClassifier,
    checkpoint: Dict[str, Any],
    raw_records: Sequence[Dict[str, Any]],
    sample_indices: Sequence[int],
    device: torch.device,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, List[Dict[str, Any]]]:
    sequence_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    label_name_to_id = {
        str(name): int(label_id)
        for name, label_id in checkpoint["label_metadata"]["action_label_to_id"].items()
    }
    num_actions = int(checkpoint["model_config"]["num_classes"])
    sequences: List[np.ndarray] = []
    true_action_labels: List[int] = []
    metadata_rows: List[Dict[str, Any]] = []

    for sample_index in sample_indices:
        if sample_index < 0 or sample_index >= len(raw_records):
            continue
        sequence, label_id, metadata = convert_record_to_sequence(
            raw_records[sample_index],
            config=sequence_config,
            label_name_to_id=label_name_to_id,
            require_action_type=True,
        )
        if sequence is None or label_id is None:
            continue
        metadata["sample_index"] = int(sample_index)
        sequences.append(sequence)
        true_action_labels.append(int(label_id))
        metadata_rows.append(metadata)

    if not sequences:
        raise ValueError("No quality-labeled samples could be converted to deep sequence tensors.")

    X = apply_normalization(np.stack(sequences).astype(np.float32), checkpoint["normalization"])
    with torch.no_grad():
        tensor = torch.as_tensor(X, dtype=torch.float32, device=device)
        logits, embeddings = model(tensor, return_embedding=True)
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()
        predicted_actions = np.argmax(probabilities, axis=1).astype(int)
        embeddings_array = embeddings.cpu().numpy().astype(np.float32)

    features: List[np.ndarray] = []
    for row_index, metadata in enumerate(metadata_rows):
        action_probs = probabilities[row_index].astype(np.float32)
        predicted_one_hot = np.zeros(num_actions, dtype=np.float32)
        predicted_one_hot[predicted_actions[row_index]] = 1.0
        scalar_features = np.asarray(
            [
                float(metadata.get("duration_seconds", 0.0)),
                float(metadata.get("missing_node_ratio", 0.0)),
            ],
            dtype=np.float32,
        )
        features.append(np.concatenate([embeddings_array[row_index], action_probs, predicted_one_hot, scalar_features]))
        metadata["predicted_action_id"] = int(predicted_actions[row_index])
        metadata["action_confidence"] = float(np.max(action_probs))

    return (
        np.stack(features).astype(np.float32),
        np.asarray(true_action_labels, dtype=int),
        predicted_actions,
        metadata_rows,
    )


def _can_stratify(labels: np.ndarray) -> bool:
    counts = Counter(int(label) for label in labels.tolist())
    return bool(counts) and min(counts.values()) >= 2


def _fit_gaussian_nb(features: np.ndarray, labels: np.ndarray) -> Pipeline:
    model = Pipeline(
        [
            ("scaler", StandardScaler()),
            ("gaussian_nb", GaussianNB()),
        ]
    )
    model.fit(features, labels)
    return model


def _evaluate_quality_model(model: Pipeline, features: np.ndarray, labels: np.ndarray) -> Dict[str, Any]:
    predictions = model.predict(features)
    class_ids = list(QUALITY_CLASS_IDS)
    return {
        "samples": int(len(labels)),
        "accuracy": float(accuracy_score(labels, predictions)),
        "macro_f1": float(f1_score(labels, predictions, average="macro", zero_division=0)),
        "weighted_f1": float(f1_score(labels, predictions, average="weighted", zero_division=0)),
        "classification_report": classification_report(
            labels,
            predictions,
            labels=class_ids,
            target_names=[get_quality_code(class_id) for class_id in class_ids],
            output_dict=True,
            zero_division=0,
        ),
        "confusion_matrix": confusion_matrix(labels, predictions, labels=class_ids).tolist(),
    }


def _quality_preview(model: Pipeline, feature: np.ndarray) -> Dict[str, Any]:
    probabilities = model.predict_proba(feature.reshape(1, -1))[0]
    class_ids = [int(class_id) for class_id in model.classes_.tolist()]
    best_index = int(np.argmax(probabilities))
    predicted_class = class_ids[best_index]
    return {
        "class_id": int(predicted_class),
        "code": get_quality_code(predicted_class),
        "label": get_quality_label_zh(predicted_class),
        "confidence": float(probabilities[best_index]),
        "quality_score": estimate_quality_score_from_probabilities(class_ids, probabilities.tolist()),
    }


def run_bayes_quality_training(
    raw_data_path: str | Path,
    quality_dataset_path: str | Path,
    action_model_path: str | Path,
    output_dir: str | Path,
    only_correct_actions: bool = True,
    min_action_confidence: float = 0.0,
    test_ratio: float = 0.2,
    min_by_action_samples: int = 20,
    seed: int = 42,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    by_action_dir = output_path / "bayes_quality_by_action"
    by_action_dir.mkdir(exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

    raw_records = list(iter_jsonl_records(raw_data_path))
    quality_rows = load_quality_rows(quality_dataset_path)
    quality_label_map = build_quality_label_map(quality_rows)
    if len(quality_label_map) < 2:
        raise ValueError("Bayesian quality training requires at least 2 labeled quality samples.")

    model, checkpoint = load_action_checkpoint(action_model_path, device=device)
    ordered_indices = sorted(quality_label_map)
    features, true_actions, predicted_actions, metadata_rows = build_quality_feature_matrix(
        model=model,
        checkpoint=checkpoint,
        raw_records=raw_records,
        sample_indices=ordered_indices,
        device=device,
    )
    quality_labels = np.asarray(
        [quality_label_map[int(metadata["sample_index"])] for metadata in metadata_rows],
        dtype=int,
    )

    success_mask = np.ones(len(metadata_rows), dtype=bool)
    if only_correct_actions:
        success_mask &= predicted_actions == true_actions
    if min_action_confidence > 0.0:
        success_mask &= np.asarray([float(row["action_confidence"]) for row in metadata_rows]) >= min_action_confidence

    selected_features = features[success_mask]
    selected_labels = quality_labels[success_mask]
    selected_metadata = [row for row, keep in zip(metadata_rows, success_mask.tolist()) if keep]
    filter_policy = "correct_action_only" if only_correct_actions else "all_converted_samples"

    if len(selected_features) < 4 or len(set(selected_labels.tolist())) < 2:
        selected_features = features
        selected_labels = quality_labels
        selected_metadata = metadata_rows
        filter_policy = "fallback_all_converted_samples"

    if len(selected_features) < 2:
        raise ValueError("Not enough samples remain for Bayesian quality training.")

    if len(selected_features) >= 5:
        stratify = selected_labels if _can_stratify(selected_labels) else None
        train_indices, test_indices = train_test_split(
            np.arange(len(selected_labels)),
            test_size=test_ratio,
            random_state=seed,
            shuffle=True,
            stratify=stratify,
        )
        global_model = _fit_gaussian_nb(selected_features[train_indices], selected_labels[train_indices])
        evaluation = _evaluate_quality_model(global_model, selected_features[test_indices], selected_labels[test_indices])
        global_model = _fit_gaussian_nb(selected_features, selected_labels)
    else:
        global_model = _fit_gaussian_nb(selected_features, selected_labels)
        evaluation = {"samples": 0, "note": "Skipped holdout evaluation because the quality sample count is too small."}

    global_path = output_path / "bayes_quality_global.pkl"
    quality_feature_config = {
        "quality_model_type": "GaussianNB",
        "feature_source": "deep_action_embedding_plus_action_probabilities",
        "feature_dim": int(selected_features.shape[1]),
        "embedding_dim": int(checkpoint["model_config"]["embedding_dim"]),
        "num_actions": int(checkpoint["model_config"]["num_classes"]),
        "extra_scalar_features": ["duration_seconds", "missing_node_ratio"],
        "filter_policy": filter_policy,
        "only_correct_actions": bool(only_correct_actions),
        "min_action_confidence": float(min_action_confidence),
    }
    joblib.dump(
        {
            "model": global_model,
            "quality_feature_config": quality_feature_config,
            "quality_classes": list(QUALITY_CLASS_IDS),
            "action_label_metadata": checkpoint["label_metadata"],
        },
        global_path,
    )

    action_labels = {int(label_id): str(label_name) for label_id, label_name in checkpoint["label_metadata"]["action_labels"].items()}
    by_action_paths: Dict[str, str] = {}
    for action_id, action_name in action_labels.items():
        action_mask = np.asarray([int(row["predicted_action_id"]) == action_id for row in selected_metadata], dtype=bool)
        if int(np.sum(action_mask)) < min_by_action_samples:
            continue
        action_labels_quality = selected_labels[action_mask]
        if len(set(action_labels_quality.tolist())) < 2:
            continue
        action_model = _fit_gaussian_nb(selected_features[action_mask], action_labels_quality)
        path = by_action_dir / f"{action_name}.pkl"
        joblib.dump(
            {
                "model": action_model,
                "quality_feature_config": {**quality_feature_config, "action_name": action_name},
                "quality_classes": list(QUALITY_CLASS_IDS),
                "action_label_metadata": checkpoint["label_metadata"],
            },
            path,
        )
        by_action_paths[action_name] = str(path)

    dataset_summary = {
        "task": "bayesian_quality_classification",
        "raw_data_file": str(Path(raw_data_path)),
        "quality_dataset_file": str(Path(quality_dataset_path)),
        "action_model_file": str(Path(action_model_path)),
        "quality_rows": int(len(quality_rows)),
        "quality_labeled_samples": int(len(quality_label_map)),
        "converted_samples": int(len(features)),
        "selected_samples": int(len(selected_features)),
        "filter_policy": filter_policy,
        "quality_class_counts": {str(class_id): int(np.sum(selected_labels == class_id)) for class_id in QUALITY_CLASS_IDS},
    }
    training_summary = {
        "task": "bayesian_quality_classification",
        "global_model_file": str(global_path),
        "by_action_models": by_action_paths,
        "quality_feature_config": quality_feature_config,
        "preview_first_selected_sample": _quality_preview(global_model, selected_features[0]),
    }
    prediction_policy = {
        "task": "bayesian_quality_classification",
        "policy": "gaussian_nb_predict_proba",
        "quality_score": "sum(class_probability * representative_score)",
        "representative_scores": {
            "Fail": 29.5,
            "Mid": 67.0,
            "Good": 82.0,
            "Excellent": 95.0,
        },
    }

    artifacts = {
        "bayes_quality_global.pkl": str(global_path),
        "dataset_summary.json": str(write_json(output_path / "dataset_summary.json", dataset_summary)),
        "training_summary.json": str(write_json(output_path / "training_summary.json", training_summary)),
        "evaluation_summary.json": str(write_json(output_path / "evaluation_summary.json", evaluation)),
        "prediction_policy.json": str(write_json(output_path / "prediction_policy.json", prediction_policy)),
        "quality_feature_config.json": str(write_json(output_path / "quality_feature_config.json", quality_feature_config)),
    }
    artifacts.update({f"bayes_quality_by_action/{name}.pkl": path for name, path in by_action_paths.items()})

    return {
        "global_model_file": str(global_path),
        "by_action_models": by_action_paths,
        "selected_samples": int(len(selected_features)),
        "filter_policy": filter_policy,
        "evaluation": evaluation,
        "artifacts": artifacts,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train GaussianNB quality model from deep action embeddings.")
    parser.add_argument("--raw", required=True, help="Path to baseline-compatible raw JSONL samples.")
    parser.add_argument("--quality-dataset", required=True, help="CSV/JSON/JSONL with sample_index and quality labels.")
    parser.add_argument("--action-model", required=True, help="Path to trained action_model.pt.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--include-incorrect-actions", action="store_true")
    parser.add_argument("--min-action-confidence", type=float, default=0.0)
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--min-by-action-samples", type=int, default=20)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        result = run_bayes_quality_training(
            raw_data_path=args.raw,
            quality_dataset_path=args.quality_dataset,
            action_model_path=args.action_model,
            output_dir=args.output_dir,
            only_correct_actions=not bool(args.include_incorrect_actions),
            min_action_confidence=float(args.min_action_confidence),
            test_ratio=float(args.test_ratio),
            min_by_action_samples=int(args.min_by_action_samples),
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
