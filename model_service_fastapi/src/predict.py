"""Inference entrypoint for skating random forest baseline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np

from src.data_loader import ActionSegment, load_action_segments
from src.feature_engineering import DEFAULT_FEATURE_CHANNELS, segment_to_feature_vector
from src.labels import CANONICAL_LABELS, normalize_label_name


def load_json_file(json_path: str | Path) -> Dict[str, Any]:
    """Load a JSON file into a dictionary."""
    with open(json_path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError(f"JSON payload at {json_path} must be an object.")
    return payload


def load_feature_config(config_path: str | Path) -> Dict[str, Any]:
    """Load feature extraction settings used during training."""
    payload = load_json_file(config_path)
    node_order = payload.get("node_order")
    if not isinstance(node_order, list) or not node_order:
        raise ValueError("feature_config.json must contain a non-empty 'node_order' list.")

    channels = payload.get("channels", list(DEFAULT_FEATURE_CHANNELS))
    if not isinstance(channels, list) or not channels:
        raise ValueError("feature_config.json 'channels' must be a non-empty list.")

    return {
        "node_order": [str(node) for node in node_order],
        "channels": [str(channel) for channel in channels],
        "start_window_seconds": float(payload.get("start_window_seconds", 1.0)),
        "end_window_seconds": float(payload.get("end_window_seconds", 1.0)),
        "min_samples_per_node": int(payload.get("min_samples_per_node", 2)),
        "enable_missing_flags": bool(payload.get("enable_missing_flags", True)),
        "missing_fill_value": float(payload.get("missing_fill_value", 0.0)),
        "min_valid_nodes_per_window": int(payload.get("min_valid_nodes_per_window", 6)),
        "top_k": int(payload.get("top_k", 3)),
        "quality_prediction_policy": payload.get("quality_prediction_policy", "argmax"),
    }


def load_label_metadata(metadata_path: str | Path) -> Dict[str, Any]:
    """Load label metadata and validate canonical action labels."""
    payload = load_json_file(metadata_path)
    action_labels = payload.get("action_labels")
    if not isinstance(action_labels, dict) or not action_labels:
        raise ValueError("label_metadata.json must contain an 'action_labels' object.")

    label_schema = str(payload.get("label_schema", "canonical"))
    if label_schema == "canonical":
        resolved_action_labels = {
            int(label_id): normalize_label_name(str(label_name))
            for label_id, label_name in action_labels.items()
        }
        if resolved_action_labels != CANONICAL_LABELS:
            raise ValueError("label_metadata.json action_labels do not match the project's canonical labels.")
    elif label_schema == "dynamic_jsonl":
        resolved_action_labels = {
            int(label_id): str(label_name).strip() for label_id, label_name in action_labels.items()
        }
        if any(not label_name for label_name in resolved_action_labels.values()):
            raise ValueError("label_metadata.json contains empty action labels for dynamic_jsonl schema.")
    else:
        raise ValueError(f"Unsupported label schema in label_metadata.json: {label_schema}")

    return {
        "label_schema": label_schema,
        "action_labels": resolved_action_labels,
        "action_label_to_id": {
            str(label_name): int(label_id)
            for label_name, label_id in payload.get("action_label_to_id", {}).items()
        },
        "standard_positive_label": int(payload.get("standard_positive_label", 1)),
        "standard_labels": payload.get("standard_labels", {}),
    }


def build_prediction_segment(
    sensor_csv_path: str | Path,
    labels_csv_path: str | Path,
    node_order: Optional[Sequence[str]] = None,
    segment_index: int = 0,
) -> ActionSegment:
    """Load one labeled segment from an external dataset for inference."""
    segments = load_action_segments(
        sensor_csv_path=sensor_csv_path,
        labels_csv_path=labels_csv_path,
        node_order=node_order,
    )
    if not segments:
        raise ValueError("No valid segments were produced from the provided CSV files.")
    if segment_index < 0 or segment_index >= len(segments):
        raise ValueError(f"segment_index {segment_index} is out of range for {len(segments)} segments.")
    return segments[segment_index]


def _normalize_probability_output(probabilities: np.ndarray) -> np.ndarray:
    if probabilities.ndim == 2:
        return probabilities[0]
    return probabilities


def _predict_class_and_confidence(model: Any, feature_vector: np.ndarray) -> Tuple[int, float, np.ndarray]:
    if hasattr(model, "predict_proba"):
        probabilities = _normalize_probability_output(model.predict_proba(feature_vector))
        class_index = int(np.argmax(probabilities))
        predicted_label = int(model.classes_[class_index])
        confidence = float(probabilities[class_index])
        return predicted_label, confidence, probabilities

    predicted_label = int(model.predict(feature_vector)[0])
    return predicted_label, 1.0, np.asarray([], dtype=float)


def _build_top_k(
    model: Any,
    probabilities: np.ndarray,
    action_labels: Dict[int, str],
    top_k: int,
    predicted_label: int,
    predicted_confidence: float,
) -> List[Dict[str, Any]]:
    if probabilities.size == 0:
        return [
            {
                "label_id": predicted_label,
                "label_name": action_labels[predicted_label],
                "confidence": predicted_confidence,
            }
        ]

    ranked_pairs = sorted(
        zip(model.classes_, probabilities),
        key=lambda item: item[1],
        reverse=True,
    )[:top_k]
    return [
        {
            "label_id": int(label_id),
            "label_name": action_labels[int(label_id)],
            "confidence": float(score),
        }
        for label_id, score in ranked_pairs
    ]


def predict_action(
    action_model: Any,
    feature_vector: np.ndarray,
    action_labels: Dict[int, str],
    top_k: int,
    label_schema: str = "canonical",
) -> Dict[str, Any]:
    """Run action classification and format a canonical result payload."""
    label_id, confidence, probabilities = _predict_class_and_confidence(action_model, feature_vector)
    if label_schema == "canonical":
        predicted_name = normalize_label_name(action_labels[label_id])
    else:
        predicted_name = action_labels[label_id]
    return {
        "label_id": label_id,
        "label_name": predicted_name,
        "confidence": confidence,
        "top_k": _build_top_k(
            action_model,
            probabilities,
            action_labels,
            top_k,
            predicted_label=label_id,
            predicted_confidence=confidence,
        ),
    }


def predict_standard(
    standard_model: Any,
    feature_vector: np.ndarray,
    standard_positive_label: int = 1,
) -> Dict[str, Any]:
    """Run optional standard-vs-nonstandard prediction."""
    label_id, confidence, probabilities = _predict_class_and_confidence(standard_model, feature_vector)

    if probabilities.size > 0:
        class_to_probability = {
            int(class_label): float(probability)
            for class_label, probability in zip(standard_model.classes_, probabilities)
        }
        positive_confidence = class_to_probability.get(standard_positive_label, confidence)
    else:
        positive_confidence = confidence if label_id == standard_positive_label else 0.0

    return {
        "is_standard": bool(label_id == standard_positive_label),
        "confidence": float(positive_confidence),
    }


def run_prediction(
    sensor_csv_path: str | Path,
    labels_csv_path: str | Path,
    action_model_path: str | Path,
    feature_config_path: str | Path,
    label_metadata_path: str | Path,
    standard_model_path: Optional[str | Path] = None,
    segment_index: int = 0,
) -> Dict[str, Any]:
    """End-to-end RF inference using the training-time feature configuration."""
    feature_config = load_feature_config(feature_config_path)
    label_metadata = load_label_metadata(label_metadata_path)

    segment = build_prediction_segment(
        sensor_csv_path=sensor_csv_path,
        labels_csv_path=labels_csv_path,
        node_order=feature_config["node_order"],
        segment_index=segment_index,
    )
    feature_result = segment_to_feature_vector(
        segment=segment,
        channels=feature_config["channels"],
        start_window_seconds=feature_config["start_window_seconds"],
        end_window_seconds=feature_config["end_window_seconds"],
        min_samples_per_node=feature_config["min_samples_per_node"],
        enable_missing_flags=feature_config["enable_missing_flags"],
        missing_fill_value=feature_config["missing_fill_value"],
        min_valid_nodes_per_window=feature_config["min_valid_nodes_per_window"],
    )
    if feature_result is None:
        raise ValueError("Unable to build a feature vector from the provided sensor CSV.")

    feature_vector, feature_metadata = feature_result
    feature_vector = feature_vector.reshape(1, -1)

    action_model = joblib.load(action_model_path)
    expected_feature_dim = getattr(action_model, "n_features_in_", feature_vector.shape[1])
    if int(expected_feature_dim) != int(feature_vector.shape[1]):
        raise ValueError(
            "Feature dimension mismatch between feature_config/model and generated features: "
            f"expected {expected_feature_dim}, got {feature_vector.shape[1]}."
        )

    action_prediction = predict_action(
        action_model=action_model,
        feature_vector=feature_vector,
        action_labels=label_metadata["action_labels"],
        top_k=feature_config["top_k"],
        label_schema=label_metadata["label_schema"],
    )

    result: Dict[str, Any] = {
        "action_prediction": action_prediction,
        "metadata": {
            **feature_metadata,
            "feature_config_path": str(feature_config_path),
            "label_metadata_path": str(label_metadata_path),
            "action_model_path": str(action_model_path),
            "standard_model_path": str(standard_model_path) if standard_model_path else None,
            "standard_model_available": bool(standard_model_path and Path(standard_model_path).exists()),
            "sensor_csv_path": str(sensor_csv_path),
            "label_csv_path": str(labels_csv_path),
            "segment_index": int(segment_index),
        },
    }

    if standard_model_path and Path(standard_model_path).exists():
        standard_model = joblib.load(standard_model_path)
        result["standard_prediction"] = predict_standard(
            standard_model=standard_model,
            feature_vector=feature_vector,
            standard_positive_label=label_metadata["standard_positive_label"],
        )

    return result


def build_arg_parser() -> argparse.ArgumentParser:
    """Build the CLI parser for RF inference."""
    parser = argparse.ArgumentParser(description="Run inference for skating-rf-baseline.")
    parser.add_argument("--sensor_csv", help="Path to the external sensor CSV.")
    parser.add_argument("--label_csv", help="Path to the external label CSV.")
    parser.add_argument("--action_model", required=True, help="Path to rf_action.pkl.")
    parser.add_argument("--standard_model", help="Optional path to rf_standard.pkl.")
    parser.add_argument("--feature_config", required=True, help="Path to feature_config.json.")
    parser.add_argument("--label_metadata", required=True, help="Path to label_metadata.json.")
    parser.add_argument("--segment_index", type=int, default=0, help="Which labeled segment to predict.")
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        if not args.sensor_csv or not args.label_csv:
            raise ValueError("Please provide --sensor_csv and --label_csv")

        result = run_prediction(
            sensor_csv_path=Path(args.sensor_csv),
            labels_csv_path=Path(args.label_csv),
            action_model_path=Path(args.action_model),
            standard_model_path=Path(args.standard_model) if args.standard_model else None,
            feature_config_path=Path(args.feature_config),
            label_metadata_path=Path(args.label_metadata),
            segment_index=args.segment_index,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
