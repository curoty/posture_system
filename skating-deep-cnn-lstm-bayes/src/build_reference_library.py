"""Build a reference-action library for similarity-based quality scoring."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import torch

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    iter_jsonl_records,
    write_json,
)
from src.predict import load_action_model
from src.similarity_scoring import SimilarityScoringConfig


def _build_reference_id(record: Dict[str, Any], sample_index: int) -> str:
    for key in ("reference_id", "referenceId", "_id", "id"):
        value = record.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return f"reference_{sample_index:06d}"


def build_reference_library(
    jsonl_path: str | Path,
    action_model_path: str | Path,
    output_dir: str | Path,
    scoring_config: Optional[SimilarityScoringConfig] = None,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))
    action_model, checkpoint = load_action_model(action_model_path, device=device)
    sequence_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    label_name_to_id = {
        str(name): int(label_id)
        for name, label_id in checkpoint["label_metadata"]["action_label_to_id"].items()
    }

    sequences: List[np.ndarray] = []
    metadata_rows: List[Dict[str, Any]] = []
    skipped: Dict[str, int] = {}
    for sample_index, record in enumerate(iter_jsonl_records(jsonl_path)):
        sequence, label_id, metadata = convert_record_to_sequence(
            record=record,
            config=sequence_config,
            label_name_to_id=label_name_to_id,
            require_action_type=True,
        )
        if sequence is None or label_id is None:
            reason = str(metadata.get("reason", "unknown"))
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        metadata_rows.append(
            {
                "reference_id": _build_reference_id(record, sample_index),
                "sample_index": int(sample_index),
                "action_type": str(metadata.get("action_type", "")),
                "label_id": int(label_id),
                "jsonl_id": str(metadata.get("jsonl_id", "")),
                "session_id": str(metadata.get("session_id", "")),
                "duration_seconds": float(metadata.get("duration_seconds", 0.0)),
                "missing_node_ratio": float(metadata.get("missing_node_ratio", 0.0)),
                "valid_nodes": int(metadata.get("valid_nodes", 0)),
                "frame_count_raw": int(metadata.get("frame_count_raw", 0)),
            }
        )
        sequences.append(sequence)

    if not sequences:
        raise ValueError("No valid reference samples could be converted.")

    normalized_sequences = apply_normalization(np.stack(sequences).astype(np.float32), checkpoint["normalization"])
    with torch.no_grad():
        tensor = torch.as_tensor(normalized_sequences, dtype=torch.float32, device=device)
        logits, embeddings = action_model(tensor, return_embedding=True)
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()
        predicted_actions = np.argmax(probabilities, axis=1).astype(int)
        embeddings_array = embeddings.cpu().numpy().astype(np.float32)

    action_labels = {
        int(label_id): str(label_name)
        for label_id, label_name in checkpoint["label_metadata"]["action_labels"].items()
    }
    for row_index, metadata in enumerate(metadata_rows):
        predicted_action_id = int(predicted_actions[row_index])
        metadata["predicted_action_id"] = predicted_action_id
        metadata["predicted_action_name"] = action_labels[predicted_action_id]
        metadata["action_confidence"] = float(np.max(probabilities[row_index]))

    action_names = np.asarray([str(row["action_type"]) for row in metadata_rows])
    library_path = output_path / "reference_library.npz"
    np.savez_compressed(
        library_path,
        embeddings=embeddings_array,
        sequences=normalized_sequences.astype(np.float32),
        action_names=action_names,
    )

    config = scoring_config or SimilarityScoringConfig()
    metadata_payload = {
        "task": "reference_similarity_library",
        "raw_data_file": str(Path(jsonl_path)),
        "action_model_file": str(Path(action_model_path)),
        "reference_library_file": str(library_path),
        "samples": int(len(metadata_rows)),
        "skipped_samples": int(sum(skipped.values())),
        "skip_reasons": skipped,
        "sequence_config": sequence_config.to_dict(),
        "similarity_scoring_config": config.to_dict(),
        "references": metadata_rows,
    }
    metadata_path = write_json(output_path / "reference_metadata.json", metadata_payload)
    policy_path = write_json(
        output_path / "similarity_policy.json",
        {
            "task": "reference_similarity_scoring",
            "policy": "same_action_topk_weighted_similarity",
            "quality_score": "top-k weighted average similarity * score_multiplier",
            "score_range": [0, 100],
            "quality_thresholds": {
                "Fail": "[0, 60)",
                "Mid": "[60, 75)",
                "Good": "[75, 90)",
                "Excellent": "[90, 100]",
            },
            "similarity_scoring_config": config.to_dict(),
        },
    )

    return {
        "reference_library_file": str(library_path),
        "reference_metadata_file": str(metadata_path),
        "similarity_policy_file": str(policy_path),
        "samples": int(len(metadata_rows)),
        "skipped_samples": int(sum(skipped.values())),
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a standard-action reference library for similarity scoring.")
    parser.add_argument("--jsonl", required=True, help="JSONL file containing standard reference actions.")
    parser.add_argument("--action-model", required=True, help="Path to trained action_model.pt.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--embedding-weight", type=float, default=0.45)
    parser.add_argument("--temporal-weight", type=float, default=0.35)
    parser.add_argument("--duration-weight", type=float, default=0.10)
    parser.add_argument("--completeness-weight", type=float, default=0.10)
    parser.add_argument("--temporal-distance-scale", type=float, default=2.0)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    config = SimilarityScoringConfig(
        top_k=int(args.top_k),
        embedding_weight=float(args.embedding_weight),
        temporal_weight=float(args.temporal_weight),
        duration_weight=float(args.duration_weight),
        completeness_weight=float(args.completeness_weight),
        temporal_distance_scale=float(args.temporal_distance_scale),
    )
    try:
        result = build_reference_library(
            jsonl_path=args.jsonl,
            action_model_path=args.action_model,
            output_dir=args.output_dir,
            scoring_config=config,
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
