"""Train a 4-class action-quality classifier."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import GridSearchCV, StratifiedKFold, train_test_split

from src.artifact_layout import write_standard_artifact_bundle
from src.config import (
    DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    DEFAULT_MISSING_NODE_FILL_VALUE,
    DEFAULT_RANDOM_FOREST_PARAMS,
    DEFAULT_RANDOM_SEED,
    DEFAULT_WINDOW_END_SECONDS,
    DEFAULT_WINDOW_START_SECONDS,
)
from src.data_augmentation import IMUAugmentor
from src.data_loader import ActionSegment
from src.evaluate_against_standard import load_json_or_jsonl_records
from src.feature_engineering import DEFAULT_FEATURE_CHANNELS, build_feature_dataset
from src.jsonl_data_loader import (
    build_dynamic_action_label_mapping,
    convert_jsonl_sample_to_action_segment,
    get_jsonl_node_mapping,
    normalize_action_type,
)
from src.quality_labels import QUALITY_CLASS_IDS, convert_score_to_quality_class
from src.train import build_feature_config_payload


QUALITY_AUGMENT_MULTIPLIER = 3
IMU_CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")
QUALITY_GRID_SEARCH_PARAM_GRID = {
    "n_estimators": [50, 100, 200],
    "max_depth": [None, 5, 8, 12],
    "min_samples_split": [2, 5, 10],
    "max_features": ["sqrt", "log2"],
}
QUALITY_SAMPLE_INDEX_KEY = "sample_index"


def convert_score_to_class(score: float) -> int:
    """Backward-compatible alias for the shared quality-label mapping."""
    return convert_score_to_quality_class(score)


def _summarize_class_distribution(labels: np.ndarray, split_name: str) -> Dict[str, int]:
    label_counts = Counter(int(label) for label in labels.tolist())
    ordered_counts = {str(class_id): int(label_counts.get(class_id, 0)) for class_id in QUALITY_CLASS_IDS}
    print(f"[train_quality_model] {split_name} class counts: {ordered_counts}")

    non_zero_counts = [count for count in ordered_counts.values() if count > 0]
    severe_imbalance = any(count == 0 for count in ordered_counts.values())
    if non_zero_counts and min(non_zero_counts) / max(non_zero_counts) < 0.3:
        severe_imbalance = True

    if severe_imbalance:
        print(f"[train_quality_model] Warning: severe class imbalance detected in {split_name}.")
    else:
        print(f"[train_quality_model] {split_name} class balance looks acceptable.")

    return ordered_counts


def load_quality_dataset_rows(dataset_path: str | Path) -> List[Dict[str, Any]]:
    """Load quality-dataset rows from CSV, JSON, or JSONL."""
    path = Path(dataset_path)
    suffix = path.suffix.lower()

    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as file:
            return [dict(row) for row in csv.DictReader(file)]

    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list) and all(isinstance(row, dict) for row in payload):
            return payload
        raise ValueError("Quality dataset JSON must be a list of objects.")

    return load_json_or_jsonl_records(path)


def _parse_sample_index(row: Dict[str, Any]) -> Optional[int]:
    candidate_keys = (
        QUALITY_SAMPLE_INDEX_KEY,
        "sample_index",
        "sample_id",
        "id",
    )
    for key in candidate_keys:
        try:
            return int(row.get(key))
        except (TypeError, ValueError):
            continue

    for key, value in row.items():
        key_lower = str(key).lower()
        if "sample" in key_lower or key_lower == "id":
            try:
                return int(value)
            except (TypeError, ValueError):
                continue

    for key, value in row.items():
        if str(key) in {"coachScore", "frameCount", "regression_label"}:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _parse_quality_score(row: Dict[str, Any]) -> Optional[float]:
    candidate_keys = ("coachScore", "score", "regression_label", "similarity")
    for key in candidate_keys:
        try:
            return float(row.get(key))
        except (TypeError, ValueError):
            continue

    for key, value in row.items():
        key_lower = str(key).lower()
        if "score" in key_lower or "regression" in key_lower or "similarity" in key_lower:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _build_quality_label_map(quality_rows: Sequence[Dict[str, Any]]) -> Dict[int, float]:
    label_map_by_sample: Dict[int, float] = {}
    for row in quality_rows:
        sample_index = _parse_sample_index(row)
        quality_score = _parse_quality_score(row)
        if sample_index is None or quality_score is None:
            continue
        label_map_by_sample[sample_index] = quality_score
    return label_map_by_sample


def _build_action_label_mapping_for_quality(
    raw_records: Sequence[Dict[str, Any]],
    label_map_by_sample: Dict[int, float],
) -> Tuple[Dict[str, int], Dict[int, str]]:
    selected_action_types: List[str] = []
    for sample_index in sorted(label_map_by_sample):
        if sample_index < 0 or sample_index >= len(raw_records):
            continue
        action_type = normalize_action_type(raw_records[sample_index].get("actionType"))
        if action_type is not None:
            selected_action_types.append(action_type)

    if not selected_action_types:
        raise ValueError("No valid action samples are available for quality classification training.")

    return build_dynamic_action_label_mapping(selected_action_types)


def _convert_sample_indices_to_segments(
    raw_records: Sequence[Dict[str, Any]],
    sample_indices: Sequence[int],
    label_name_to_id: Dict[str, int],
    min_observations_per_node: int,
) -> Tuple[List[ActionSegment], int]:
    node_mapping = get_jsonl_node_mapping()
    segments: List[ActionSegment] = []
    conversion_errors = 0

    for sample_index in sample_indices:
        if sample_index < 0 or sample_index >= len(raw_records):
            conversion_errors += 1
            continue
        segment, _validation = convert_jsonl_sample_to_action_segment(
            record=raw_records[sample_index],
            segment_id=sample_index,
            label_name_to_id=label_name_to_id,
            node_mapping=node_mapping,
            min_observations_per_node=min_observations_per_node,
        )
        if segment is None:
            conversion_errors += 1
            continue
        segments.append(segment)

    return segments, conversion_errors


def _segment_to_imu_matrix(segment: ActionSegment) -> Tuple[np.ndarray, np.ndarray]:
    sensor_frame = segment.sensor_frame.sort_values(["ts", "node"]).reset_index(drop=True)
    unique_ts = np.sort(sensor_frame["ts"].unique())
    matrix = np.zeros((len(unique_ts), len(segment.node_order) * len(IMU_CHANNELS)), dtype=float)

    for node_index, node_name in enumerate(segment.node_order):
        node_frame = (
            sensor_frame.loc[sensor_frame["node"] == node_name, ["ts", *IMU_CHANNELS]]
            .sort_values("ts")
            .drop_duplicates(subset=["ts"], keep="last")
            .set_index("ts")
            .reindex(unique_ts)
        )
        node_frame = node_frame.ffill().bfill().fillna(0.0)
        start = node_index * len(IMU_CHANNELS)
        matrix[:, start : start + len(IMU_CHANNELS)] = node_frame[list(IMU_CHANNELS)].to_numpy(dtype=float)

    return unique_ts.astype(float), matrix


def _imu_matrix_to_segment(segment: ActionSegment, ts_values: np.ndarray, matrix: np.ndarray) -> ActionSegment:
    rows: List[Dict[str, Any]] = []
    for time_index, ts in enumerate(ts_values):
        for node_index, node_name in enumerate(segment.node_order):
            start = node_index * len(IMU_CHANNELS)
            ax, ay, az, gx, gy, gz = matrix[time_index, start : start + len(IMU_CHANNELS)]
            rows.append(
                {
                    "ts": float(ts),
                    "node": node_name,
                    "ax": float(ax),
                    "ay": float(ay),
                    "az": float(az),
                    "gx": float(gx),
                    "gy": float(gy),
                    "gz": float(gz),
                }
            )

    augmented_frame = pd.DataFrame(rows).sort_values(["ts", "node"]).reset_index(drop=True)
    augmented_metadata = dict(segment.metadata)
    augmented_metadata["num_rows"] = int(len(augmented_frame))

    return ActionSegment(
        segment_id=segment.segment_id,
        start_ts=float(ts_values.min()),
        end_ts=float(ts_values.max()),
        action_label_id=segment.action_label_id,
        action_label_name=segment.action_label_name,
        standard_label_id=segment.standard_label_id,
        standard_label_name=segment.standard_label_name,
        sensor_frame=augmented_frame,
        node_order=list(segment.node_order),
        metadata=augmented_metadata,
    )


def _augment_training_segments(segments: Sequence[ActionSegment]) -> List[ActionSegment]:
    augmentor = IMUAugmentor(random_state=DEFAULT_RANDOM_SEED)
    augmented_segments: List[ActionSegment] = []

    for segment in segments:
        ts_values, matrix = _segment_to_imu_matrix(segment)
        augmented_segments.append(_imu_matrix_to_segment(segment, ts_values, augmentor.time_shift(matrix, shift_range=3)))
        augmented_segments.append(_imu_matrix_to_segment(segment, ts_values, augmentor.jitter(matrix, sigma=0.02)))
        augmented_segments.append(_imu_matrix_to_segment(segment, ts_values, augmentor.scaling(matrix, sigma=0.05)))

    return augmented_segments


def _predict_quality_classes(
    model: RandomForestClassifier,
    X: np.ndarray,
) -> np.ndarray:
    """Predict quality classes with plain argmax semantics."""
    if not hasattr(model, "predict_proba"):
        return model.predict(X)

    probabilities = model.predict_proba(X)
    class_ids = np.asarray(model.classes_, dtype=int)
    predictions: List[int] = []

    for row in probabilities:
        best_index = int(np.argmax(row))
        predictions.append(int(class_ids[best_index]))

    return np.asarray(predictions, dtype=int)


def train_quality_classifier(
    X_train: np.ndarray,
    y_train: np.ndarray,
    rf_params: Optional[Dict[str, Any]] = None,
) -> RandomForestClassifier:
    """Train a random-forest classifier with project-aligned defaults."""
    resolved_params = dict(DEFAULT_RANDOM_FOREST_PARAMS)
    if rf_params is not None:
        resolved_params.update(rf_params)
    model = RandomForestClassifier(**resolved_params)
    model.fit(X_train, y_train)
    return model


def search_quality_classifier_params(
    X_train: np.ndarray,
    y_train: np.ndarray,
    rf_params: Optional[Dict[str, Any]] = None,
) -> Tuple[RandomForestClassifier, Dict[str, Any]]:
    """Run a small GridSearchCV sweep and return the best fitted classifier."""
    resolved_params = dict(DEFAULT_RANDOM_FOREST_PARAMS)
    if rf_params is not None:
        resolved_params.update(rf_params)

    class_counts = Counter(int(label) for label in y_train.tolist())
    cv_splits = max(2, min(5, int(min(class_counts.values()))))
    cv = StratifiedKFold(n_splits=cv_splits, shuffle=True, random_state=DEFAULT_RANDOM_SEED)
    base_model = RandomForestClassifier(
        min_samples_leaf=resolved_params["min_samples_leaf"],
        bootstrap=resolved_params["bootstrap"],
        random_state=resolved_params["random_state"],
        n_jobs=resolved_params["n_jobs"],
    )
    grid_search = GridSearchCV(
        estimator=base_model,
        param_grid=QUALITY_GRID_SEARCH_PARAM_GRID,
        scoring="f1_macro",
        cv=cv,
        n_jobs=1,
        refit=True,
    )
    grid_search.fit(X_train, y_train)

    best_params = grid_search.best_params_
    search_summary = {
        "cv_strategy": "StratifiedKFold",
        "cv_folds": int(cv_splits),
        "scoring": "f1_macro",
        "param_grid": {key: list(values) for key, values in QUALITY_GRID_SEARCH_PARAM_GRID.items()},
        "best_params": {
            "n_estimators": int(best_params["n_estimators"]),
            "max_depth": None if best_params["max_depth"] is None else int(best_params["max_depth"]),
            "min_samples_split": int(best_params["min_samples_split"]),
            "max_features": str(best_params["max_features"]),
        },
        "best_cv_f1_macro": float(grid_search.best_score_),
    }
    return grid_search.best_estimator_, search_summary


def evaluate_classifier(
    model: RandomForestClassifier,
    X_test: np.ndarray,
    y_test: np.ndarray,
) -> Dict[str, Any]:
    """Compute classification metrics for the held-out split."""
    predictions = _predict_quality_classes(model=model, X=X_test)
    return {
        "accuracy": float(accuracy_score(y_test, predictions)),
        "macro_f1": float(f1_score(y_test, predictions, average="macro", zero_division=0)),
        "weighted_f1": float(f1_score(y_test, predictions, average="weighted", zero_division=0)),
        "classification_report": classification_report(
            y_test,
            predictions,
            labels=list(QUALITY_CLASS_IDS),
            output_dict=True,
            zero_division=0,
        ),
        "confusion_matrix": confusion_matrix(y_test, predictions, labels=list(QUALITY_CLASS_IDS)).tolist(),
    }


def run_quality_classification_training(
    raw_data_path: str | Path,
    quality_dataset_path: str | Path,
    output_dir: str | Path,
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_observations_per_node: int = 2,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    test_ratio: float = 0.2,
    rf_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """End-to-end quality classification training with train-only augmentation."""
    raw_records = load_json_or_jsonl_records(raw_data_path)
    quality_rows = load_quality_dataset_rows(quality_dataset_path)

    label_map_by_sample = _build_quality_label_map(quality_rows)
    label_name_to_id, _label_id_to_name = _build_action_label_mapping_for_quality(raw_records, label_map_by_sample)

    valid_sample_indices = [sample_index for sample_index in sorted(label_map_by_sample) if 0 <= sample_index < len(raw_records)]
    if len(valid_sample_indices) < 2:
        raise ValueError("Quality classification training requires at least 2 labeled samples.")

    sample_classes = np.asarray([convert_score_to_class(label_map_by_sample[sample_index]) for sample_index in valid_sample_indices], dtype=int)
    class_counts = Counter(int(label) for label in sample_classes.tolist())
    stratify_labels = sample_classes if min(class_counts.values()) >= 2 else None
    if stratify_labels is None:
        print("[train_quality_model] Warning: falling back to non-stratified split because at least one class has < 2 samples.")

    test_size = max(1, int(round(len(valid_sample_indices) * test_ratio)))
    test_size = min(test_size, len(valid_sample_indices) - 1)
    train_indices, test_indices = train_test_split(
        valid_sample_indices,
        test_size=test_size,
        random_state=DEFAULT_RANDOM_SEED,
        shuffle=True,
        stratify=stratify_labels,
    )

    train_segments_original, train_conversion_errors = _convert_sample_indices_to_segments(
        raw_records=raw_records,
        sample_indices=train_indices,
        label_name_to_id=label_name_to_id,
        min_observations_per_node=min_observations_per_node,
    )
    test_segments, test_conversion_errors = _convert_sample_indices_to_segments(
        raw_records=raw_records,
        sample_indices=test_indices,
        label_name_to_id=label_name_to_id,
        min_observations_per_node=min_observations_per_node,
    )

    if not train_segments_original:
        raise ValueError("No training samples survived segment conversion.")
    if not test_segments:
        raise ValueError("No test samples survived segment conversion.")

    train_segments_augmented = _augment_training_segments(train_segments_original)
    train_segments_combined = list(train_segments_original) + train_segments_augmented

    print(
        "[train_quality_model] Sample pool comparison: "
        f"train_before={len(train_segments_original)}, "
        f"train_after={len(train_segments_combined)}, "
        f"test_clean={len(test_segments)}"
    )

    X_train, _y_action_train, _y_standard_train, train_metadata_rows = build_feature_dataset(
        segments=train_segments_combined,
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
    X_test, _y_action_test, _y_standard_test, test_metadata_rows = build_feature_dataset(
        segments=test_segments,
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )

    if X_train.size == 0:
        raise ValueError("No feature-ready training samples were produced.")
    if X_test.size == 0:
        raise ValueError("No feature-ready test samples were produced.")

    y_train_scores = np.asarray([label_map_by_sample[int(metadata["segment_id"])] for metadata in train_metadata_rows], dtype=float)
    y_test_scores = np.asarray([label_map_by_sample[int(metadata["segment_id"])] for metadata in test_metadata_rows], dtype=float)
    y_train = np.asarray([convert_score_to_class(score) for score in y_train_scores], dtype=int)
    y_test = np.asarray([convert_score_to_class(score) for score in y_test_scores], dtype=int)

    train_class_counts = _summarize_class_distribution(y_train, split_name="train")
    test_class_counts = _summarize_class_distribution(y_test, split_name="test")

    model, hyperparameter_search = search_quality_classifier_params(
        X_train=X_train,
        y_train=y_train,
        rf_params=rf_params,
    )
    metrics = evaluate_classifier(model=model, X_test=X_test, y_test=y_test)
    hyperparameter_search["best_test_macro_f1"] = metrics["macro_f1"]
    hyperparameter_search["quality_prediction_policy"] = "argmax"
    print(
        "[train_quality_model] Best params from GridSearchCV: "
        f"{hyperparameter_search['best_params']}, "
        f"best_test_macro_f1={metrics['macro_f1']}, "
        "quality_prediction_policy=argmax"
    )

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    model_path = output_path / "rf_quality_classifier.pkl"
    feature_config_path = output_path / "feature_config.json"
    training_summary_path = output_path / "quality_training_summary.json"

    joblib.dump(model, model_path)
    feature_source_metadata = train_metadata_rows[0] if train_metadata_rows else test_metadata_rows[0]
    feature_config = build_feature_config_payload(
        node_order=feature_source_metadata["node_order"],
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
        top_k=3,
    )
    feature_config["quality_prediction_policy"] = "argmax"
    feature_config_path.write_text(json.dumps(feature_config, ensure_ascii=False, indent=2), encoding="utf-8")

    dataset_stats = {
        "quality_rows": int(len(quality_rows)),
        "labeled_samples": int(len(label_map_by_sample)),
        "train_split_samples": int(len(train_indices)),
        "test_split_samples": int(len(test_indices)),
        "train_converted_segments": int(len(train_segments_original)),
        "test_converted_segments": int(len(test_segments)),
        "train_conversion_errors": int(train_conversion_errors),
        "test_conversion_errors": int(test_conversion_errors),
        "augmentation_multiplier": int(QUALITY_AUGMENT_MULTIPLIER),
        "train_pool_before_augmentation": int(len(train_segments_original)),
        "train_augmented_segments": int(len(train_segments_augmented)),
        "train_pool_after_augmentation": int(len(train_segments_combined)),
        "feature_ready_train_samples": int(X_train.shape[0]),
        "feature_ready_test_samples": int(X_test.shape[0]),
        "train_class_counts": train_class_counts,
        "test_class_counts": test_class_counts,
        "split_strategy": "stratified" if stratify_labels is not None else "non_stratified_fallback",
    }

    summary = {
        "raw_data_file": str(Path(raw_data_path)),
        "quality_dataset_file": str(Path(quality_dataset_path)),
        "model_file": str(model_path),
        "feature_config_file": str(feature_config_path),
        "total_labeled_samples": int(len(valid_sample_indices)),
        "train_samples": int(len(train_segments_original)),
        "test_samples": int(len(test_segments)),
        "metrics": metrics,
        "hyperparameter_search": hyperparameter_search,
        "dataset_stats": dataset_stats,
        "quality_prediction_policy": "argmax",
        "split_strategy": "Split train/test before augmentation. Only train set is augmented; test set remains clean.",
    }
    training_summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    dataset_summary = {
        "task": "quality_classification",
        "data_source": "prepared_jsonl_plus_quality_csv",
        "raw_data_file": str(Path(raw_data_path)),
        "quality_dataset_file": str(Path(quality_dataset_path)),
        "total_labeled_samples": int(len(valid_sample_indices)),
        "train_class_counts": dict(train_class_counts),
        "test_class_counts": dict(test_class_counts),
    }
    prediction_policy = {
        "task": "quality_classification",
        "policy": "argmax",
        "quality_prediction_policy": "argmax",
    }
    standard_artifacts = write_standard_artifact_bundle(
        output_dir=output_dir,
        dataset_summary=dataset_summary,
        training_summary=summary,
        evaluation_summary=metrics,
        prediction_policy=prediction_policy,
    )

    return {
        **summary,
        "summary_file": str(training_summary_path),
        "standard_artifacts": standard_artifacts,
    }


def run_quality_regression_training(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    """Backward-compatible alias for the previous function name."""
    return run_quality_classification_training(*args, **kwargs)


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser for quality-classification training."""
    parser = argparse.ArgumentParser(description="Train action quality classification model.")
    parser.add_argument("--raw", required=True, help="Path to raw action JSON/JSONL file.")
    parser.add_argument("--dataset", required=True, help="Path to quality dataset JSON/JSONL/CSV file.")
    parser.add_argument("--output_dir", required=True, help="Directory for model and config outputs.")
    parser.add_argument("--test_ratio", type=float, default=0.2, help="Held-out test ratio. Default 0.2.")
    parser.add_argument("--min_observations_per_node", type=int, default=2, help="Minimum per-node observations per sample.")
    parser.add_argument("--min_samples_per_node", type=int, default=2, help="Minimum per-node observations per window.")
    parser.add_argument(
        "--min_valid_nodes_per_window",
        type=int,
        default=DEFAULT_MIN_VALID_NODES_PER_WINDOW,
        help="Minimum valid nodes required within each window.",
    )
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = run_quality_classification_training(
            raw_data_path=Path(args.raw),
            quality_dataset_path=Path(args.dataset),
            output_dir=Path(args.output_dir),
            test_ratio=float(args.test_ratio),
            min_observations_per_node=int(args.min_observations_per_node),
            min_samples_per_node=int(args.min_samples_per_node),
            min_valid_nodes_per_window=int(args.min_valid_nodes_per_window),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
