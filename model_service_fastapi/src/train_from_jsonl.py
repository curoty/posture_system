"""Training entrypoint for JSONL skating action samples."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import numpy as np

from src.artifact_layout import write_standard_artifact_bundle
from src.config import (
    DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    DEFAULT_MODEL_OUTPUT_DIR,
    DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    DEFAULT_MISSING_NODE_FILL_VALUE,
    DEFAULT_WINDOW_END_SECONDS,
    DEFAULT_WINDOW_START_SECONDS,
)
from src.feature_engineering import DEFAULT_FEATURE_CHANNELS, build_feature_dataset
from src.jsonl_data_loader import load_action_segments_from_jsonl
from src.train import (
    _maybe_run_action_evaluation,
    build_feature_config_payload,
    build_label_metadata_payload,
    save_training_artifacts,
    train_random_forest_models,
)


def run_training_from_jsonl(
    jsonl_path: str | Path,
    output_dir: str | Path = DEFAULT_MODEL_OUTPUT_DIR,
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_observations_per_node: int = 2,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    top_k: int = 3,
    rf_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Load JSONL samples, train the RF action model, and save artifacts."""
    segments, label_name_to_id, label_id_to_name, jsonl_stats = load_action_segments_from_jsonl(
        jsonl_path=jsonl_path,
        min_observations_per_node=min_observations_per_node,
    )
    if not segments:
        raise ValueError("No JSONL samples survived validation and filtering.")

    X, y_action, y_standard, metadata = build_feature_dataset(
        segments=segments,
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
    if X.size == 0:
        raise ValueError("No valid training samples were produced from the provided JSONL file.")

    unique_action_labels = np.unique(y_action)
    label_names = [label_id_to_name[int(label_id)] for label_id in sorted(unique_action_labels)]
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
    label_metadata = build_label_metadata_payload(
        action_labels=label_id_to_name,
        action_label_to_id=label_name_to_id,
        label_schema="dynamic_jsonl",
    )
    artifact_paths = save_training_artifacts(
        output_dir=output_dir,
        action_model=final_models["action_model"],
        standard_model=final_models["standard_model"],
        feature_config=feature_config,
        label_metadata=label_metadata,
    )

    dataset_summary = {
        "task": "action_classification",
        "data_source": "jsonl_action_samples",
        "input_file": str(Path(jsonl_path)),
        "total_records": int(jsonl_stats["total_records"]),
        "converted_action_segments": int(jsonl_stats["converted_action_segments"]),
        "feature_ready_segments": int(X.shape[0]),
        "action_type_counts_raw": dict(jsonl_stats["action_type_counts_raw"]),
        "action_type_counts_converted": dict(jsonl_stats["action_type_counts_converted"]),
    }
    training_summary = {
        "task": "action_classification",
        "num_samples": int(X.shape[0]),
        "feature_dim": int(X.shape[1]),
        "has_standard_model": final_models["standard_model"] is not None,
        "artifacts": {name: str(path) for name, path in artifact_paths.items()},
        "jsonl_stats": {
            **jsonl_stats,
            "feature_ready_segments": int(X.shape[0]),
        },
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
        "jsonl_stats": {
            **jsonl_stats,
            "feature_ready_segments": int(X.shape[0]),
        },
    }


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser for JSONL training."""
    parser = argparse.ArgumentParser(description="Train skating-rf-baseline models from JSONL action samples.")
    parser.add_argument("--jsonl", required=True, help="Path to the JSONL training file.")
    parser.add_argument(
        "--output_dir",
        default=str(DEFAULT_MODEL_OUTPUT_DIR),
        help="Directory for rf_action.pkl and metadata outputs.",
    )
    parser.add_argument(
        "--min_observations_per_node",
        type=int,
        default=2,
        help="Minimum total observations per node required for a JSONL sample to survive filtering.",
    )
    parser.add_argument(
        "--min_samples_per_node",
        type=int,
        default=2,
        help="Minimum per-window samples per node required by feature extraction.",
    )
    parser.add_argument(
        "--min_valid_nodes_per_window",
        type=int,
        default=DEFAULT_MIN_VALID_NODES_PER_WINDOW,
        help="Minimum valid nodes required within each window after missing-node handling.",
    )
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = run_training_from_jsonl(
            jsonl_path=Path(args.jsonl),
            output_dir=Path(args.output_dir),
            min_observations_per_node=args.min_observations_per_node,
            min_samples_per_node=args.min_samples_per_node,
            min_valid_nodes_per_window=args.min_valid_nodes_per_window,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
