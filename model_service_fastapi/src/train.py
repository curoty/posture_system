"""Training entrypoint for skating random forest baseline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

from src.artifact_layout import write_standard_artifact_bundle
from src.config import (
    DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    DEFAULT_MODEL_OUTPUT_DIR,
    DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    DEFAULT_MISSING_NODE_FILL_VALUE,
    DEFAULT_RANDOM_FOREST_PARAMS,
    DEFAULT_WINDOW_END_SECONDS,
    DEFAULT_WINDOW_START_SECONDS,
)
from src.evaluate_classifier import evaluate_model
from src.feature_engineering import DEFAULT_FEATURE_CHANNELS, build_feature_spec, get_best_feature_config, load_feature_dataset
from src.labels import CANONICAL_LABELS


def train_random_forest_models(
    X: np.ndarray,
    y_action: np.ndarray,
    y_standard: Optional[np.ndarray] = None,
    rf_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Train action and optional standard random-forest models."""
    if X.size == 0 or len(y_action) == 0:
        raise ValueError("Training data is empty. Cannot train the action model.")

    resolved_params = dict(DEFAULT_RANDOM_FOREST_PARAMS)
    if rf_params is not None:
        resolved_params.update(rf_params)

    action_model = RandomForestClassifier(**resolved_params)
    action_model.fit(X, y_action)

    result: Dict[str, Any] = {"action_model": action_model, "standard_model": None}
    if y_standard is not None:
        standard_mask = np.asarray([label is not None for label in y_standard], dtype=bool)
        if np.any(standard_mask):
            standard_targets = np.asarray(y_standard[standard_mask], dtype=int)
            if len(np.unique(standard_targets)) >= 2:
                standard_model = RandomForestClassifier(**resolved_params)
                standard_model.fit(X[standard_mask], standard_targets)
                result["standard_model"] = standard_model

    return result


def build_feature_config_payload(
    node_order: Sequence[str],
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    top_k: int = 3,
) -> Dict[str, Any]:
    """Create the feature_config.json payload used by training and inference."""
    feature_spec = build_feature_spec(
        node_order=node_order,
        channels=channels,
        enable_missing_flags=enable_missing_flags,
    )
    best_config = get_best_feature_config()
    return {
        "node_order": list(node_order),
        "channels": list(channels),
        "start_window_seconds": float(start_window_seconds),
        "end_window_seconds": float(end_window_seconds),
        "min_samples_per_node": int(min_samples_per_node),
        "enable_missing_flags": bool(enable_missing_flags),
        "missing_fill_value": float(missing_fill_value),
        "min_valid_nodes_per_window": int(min_valid_nodes_per_window),
        "feature_dim": int(feature_spec["feature_dim"]),
        "feature_groups": list(best_config["feature_groups"]),
        "stats_per_channel": list(feature_spec["stats_per_channel"]),
        "segment_stats_per_channel": list(feature_spec["segment_stats_per_channel"]),
        "windows_used": list(feature_spec["windows_used"]),
        "missing_flags_per_window": int(feature_spec["missing_flags_per_window"]),
        "expected_feature_dim_breakdown": dict(feature_spec["expected_feature_dim_breakdown"]),
        "feature_name_count": int(feature_spec["feature_name_count"]),
        "top_k": int(top_k),
    }


def build_label_metadata_payload(
    action_labels: Optional[Dict[int, str]] = None,
    action_label_to_id: Optional[Dict[str, int]] = None,
    label_schema: str = "canonical",
    standard_positive_label: int = 1,
) -> Dict[str, Any]:
    """Create the label_metadata.json payload for inference."""
    resolved_action_labels = action_labels or CANONICAL_LABELS
    resolved_action_label_to_id = action_label_to_id or {
        label_name: label_id for label_id, label_name in resolved_action_labels.items()
    }
    return {
        "label_schema": str(label_schema),
        "action_labels": {str(label_id): label_name for label_id, label_name in resolved_action_labels.items()},
        "action_label_to_id": {
            str(label_name): int(label_id) for label_name, label_id in resolved_action_label_to_id.items()
        },
        "standard_positive_label": int(standard_positive_label),
    }


def save_training_artifacts(
    output_dir: str | Path,
    action_model: Any,
    feature_config: Dict[str, Any],
    label_metadata: Dict[str, Any],
    standard_model: Optional[Any] = None,
) -> Dict[str, Path]:
    """Persist trained models and metadata to disk."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    action_model_path = output_path / "rf_action.pkl"
    feature_config_path = output_path / "feature_config.json"
    label_metadata_path = output_path / "label_metadata.json"

    joblib.dump(action_model, action_model_path)
    feature_config_path.write_text(json.dumps(feature_config, ensure_ascii=False, indent=2), encoding="utf-8")
    label_metadata_path.write_text(json.dumps(label_metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    artifact_paths: Dict[str, Path] = {
        "rf_action.pkl": action_model_path,
        "feature_config.json": feature_config_path,
        "label_metadata.json": label_metadata_path,
    }

    if standard_model is not None:
        standard_model_path = output_path / "rf_standard.pkl"
        joblib.dump(standard_model, standard_model_path)
        artifact_paths["rf_standard.pkl"] = standard_model_path

    return artifact_paths


def _maybe_run_action_evaluation(
    X: np.ndarray,
    y_action: np.ndarray,
    output_dir: str | Path,
    label_names: Sequence[str],
    rf_params: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Run stratified hold-out evaluation when the dataset is large enough."""
    unique_action_labels, class_counts = np.unique(y_action, return_counts=True)
    if len(unique_action_labels) < 2:
        print("[train] Skipping classifier evaluation: fewer than 2 action classes.")
        return None
    if int(np.min(class_counts)) < 2:
        print("[train] Skipping classifier evaluation: at least one class has fewer than 2 samples.")
        return None

    X_train, X_test, y_action_train, y_action_test = train_test_split(
        X,
        y_action,
        test_size=0.2,
        random_state=42,
        stratify=y_action,
    )

    evaluation_models = train_random_forest_models(
        X=X_train,
        y_action=y_action_train,
        y_standard=None,
        rf_params=rf_params,
    )
    evaluation_path = Path(output_dir) / "eval_result.json"
    evaluation_result = evaluate_model(
        evaluation_models["action_model"],
        X_test,
        y_action_test,
        label_names,
        save_path=evaluation_path,
    )
    return {
        "test_samples": int(len(y_action_test)),
        "accuracy": float(evaluation_result["accuracy"]),
        "eval_result_json": str(evaluation_path),
        "evaluation_summary": evaluation_result,
    }


def run_training(
    sensor_csv_path: str | Path,
    labels_csv_path: str | Path,
    output_dir: str | Path = DEFAULT_MODEL_OUTPUT_DIR,
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_rows_per_segment: int = 2,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    top_k: int = 3,
    rf_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Load data, train RF models, and save artifacts."""
    X, y_action, y_standard, metadata = load_feature_dataset(
        sensor_csv_path=sensor_csv_path,
        labels_csv_path=labels_csv_path,
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_rows_per_segment=min_rows_per_segment,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
    if X.size == 0:
        raise ValueError("No valid training samples were produced from the provided CSV files.")

    unique_action_labels = np.unique(y_action)
    label_names = [CANONICAL_LABELS[int(label_id)] for label_id in sorted(unique_action_labels)]
    evaluation_summary = _maybe_run_action_evaluation(
        X=X,
        y_action=y_action,
        output_dir=output_dir,
        label_names=label_names,
        rf_params=rf_params,
    )

    final_models = train_random_forest_models(
        X=X,
        y_action=y_action,
        y_standard=y_standard,
        rf_params=rf_params,
    )
    feature_config = build_feature_config_payload(
        node_order=metadata[0]["node_order"],
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
        top_k=top_k,
    )
    label_metadata = build_label_metadata_payload()
    artifact_paths = save_training_artifacts(
        output_dir=output_dir,
        action_model=final_models["action_model"],
        standard_model=final_models["standard_model"],
        feature_config=feature_config,
        label_metadata=label_metadata,
    )

    dataset_summary = {
        "task": "action_classification",
        "data_source": "csv_segment_dataset",
        "num_samples": int(X.shape[0]),
        "feature_dim": int(X.shape[1]),
        "labels": list(label_names),
    }
    training_summary = {
        "task": "action_classification",
        "num_samples": int(X.shape[0]),
        "feature_dim": int(X.shape[1]),
        "has_standard_model": final_models["standard_model"] is not None,
        "artifacts": {name: str(path) for name, path in artifact_paths.items()},
    }
    prediction_policy = {
        "task": "action_classification",
        "policy": "argmax",
        "top_k": int(top_k),
    }
    standard_artifacts = write_standard_artifact_bundle(
        output_dir=output_dir,
        dataset_summary=dataset_summary,
        training_summary=training_summary,
        evaluation_summary=(evaluation_summary or {}).get("evaluation_summary") if evaluation_summary else None,
        prediction_policy=prediction_policy,
    )

    return {
        "num_samples": int(X.shape[0]),
        "feature_dim": int(X.shape[1]),
        "has_standard_model": final_models["standard_model"] is not None,
        "evaluation": evaluation_summary,
        "artifacts": {name: str(path) for name, path in artifact_paths.items()},
        "standard_artifacts": standard_artifacts,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser for training."""
    parser = argparse.ArgumentParser(description="Train skating-rf-baseline random-forest models.")
    parser.add_argument("--sensor_csv", help="Path to the external training sensor CSV.")
    parser.add_argument("--label_csv", help="Path to the external training label CSV.")
    parser.add_argument(
        "--output_dir",
        default=str(DEFAULT_MODEL_OUTPUT_DIR),
        help="Directory for rf_action.pkl and metadata outputs.",
    )
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        if not args.sensor_csv or not args.label_csv:
            raise ValueError("Please provide --sensor_csv and --label_csv")

        result = run_training(
            sensor_csv_path=Path(args.sensor_csv),
            labels_csv_path=Path(args.label_csv),
            output_dir=Path(args.output_dir),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
