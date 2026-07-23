"""Clean raw action samples into a training-ready subset."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from src.evaluate_against_standard import load_json_or_jsonl_records
from src.jsonl_data_loader import normalize_action_type


TARGET_ACTION_TYPES = {"weight_shift", "side_push_recover"}
CRITICAL_RAW_NODES = {"head", "left_foot", "right_foot", "left_knee", "right_knee"}
MIN_FRAME_COUNT = 100
MAX_FRAME_COUNT = 400
MIN_UNIQUE_NODES = 8
MAX_FRAMECOUNT_DIFF_RATIO = 0.05
VALID_IMU_DIM = 6


def _is_finite_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _validate_frame_payload(frame: Dict[str, Any]) -> Optional[str]:
    if not isinstance(frame, dict):
        return "invalid_frame_object"
    if "t" not in frame or "p" not in frame:
        return "missing_frame_keys"
    if not _is_finite_number(frame.get("t")):
        return "invalid_timestamp"
    node_payload = frame.get("p")
    if not isinstance(node_payload, dict):
        return "invalid_node_payload"

    for raw_values in node_payload.values():
        if not isinstance(raw_values, list) or len(raw_values) != VALID_IMU_DIM:
            return "invalid_node_value_length"
        if not all(_is_finite_number(value) for value in raw_values):
            return "invalid_node_value_number"
    return None


def _check_framecount_consistency(record: Dict[str, Any], actual_frame_count: int) -> bool:
    raw_frame_count = record.get("frameCount")
    if raw_frame_count is None:
        return True
    try:
        declared_frame_count = int(raw_frame_count)
    except (TypeError, ValueError):
        return False
    tolerance = max(1, int(round(actual_frame_count * MAX_FRAMECOUNT_DIFF_RATIO)))
    return abs(declared_frame_count - actual_frame_count) <= tolerance


def validate_raw_record(record: Dict[str, Any]) -> Tuple[bool, str, Dict[str, Any]]:
    """Validate one raw record against training-readiness rules."""
    action_type = normalize_action_type(record.get("actionType"))
    if action_type not in TARGET_ACTION_TYPES:
        return False, "unsupported_action_type", {"action_type": action_type}

    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return False, "empty_frames", {"action_type": action_type}

    actual_frame_count = len(frames)
    if actual_frame_count < MIN_FRAME_COUNT or actual_frame_count > MAX_FRAME_COUNT:
        return False, "frame_count_out_of_range", {"action_type": action_type, "frame_count": actual_frame_count}

    if not _check_framecount_consistency(record, actual_frame_count):
        return False, "frame_count_mismatch", {"action_type": action_type, "frame_count": actual_frame_count}

    timestamps: List[float] = []
    unique_nodes = set()
    for frame in frames:
        frame_error = _validate_frame_payload(frame)
        if frame_error is not None:
            return False, frame_error, {"action_type": action_type, "frame_count": actual_frame_count}
        timestamp = float(frame["t"])
        timestamps.append(timestamp)
        unique_nodes.update((frame.get("p") or {}).keys())

    if any(next_ts <= current_ts for current_ts, next_ts in zip(timestamps, timestamps[1:])):
        return False, "non_monotonic_timestamps", {"action_type": action_type, "frame_count": actual_frame_count}

    if len(unique_nodes) < MIN_UNIQUE_NODES:
        return False, "insufficient_unique_nodes", {"action_type": action_type, "unique_nodes": len(unique_nodes)}

    if not CRITICAL_RAW_NODES.issubset(unique_nodes):
        return False, "missing_critical_nodes", {"action_type": action_type, "unique_nodes": sorted(unique_nodes)}

    return True, "ok", {
        "action_type": action_type,
        "frame_count": actual_frame_count,
        "unique_nodes": len(unique_nodes),
        "nodes_present": sorted(unique_nodes),
    }


def classify_cleaning_tier(record: Dict[str, Any]) -> Tuple[str, str, Dict[str, Any]]:
    """Classify one raw record into core/rescued/rejected tiers."""
    is_valid, reason, metadata = validate_raw_record(record)
    if is_valid:
        return "core", reason, metadata

    action_type = normalize_action_type(record.get("actionType"))
    frames = record.get("frames")
    if action_type in TARGET_ACTION_TYPES and isinstance(frames, list) and frames and reason == "insufficient_unique_nodes":
        unique_nodes = set()
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            node_payload = frame.get("p")
            if isinstance(node_payload, dict):
                unique_nodes.update(node_payload.keys())
        if len(unique_nodes) == 7 and CRITICAL_RAW_NODES.issubset(unique_nodes):
            return "rescued", "rescued_7node_with_critical_nodes", {
                "action_type": action_type,
                "frame_count": len(frames),
                "unique_nodes": len(unique_nodes),
                "nodes_present": sorted(unique_nodes),
            }

    return "rejected", reason, metadata


def _write_records(output_path: Path, records: Sequence[Dict[str, Any]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = output_path.suffix.lower()
    if suffix == ".json":
        output_path.write_text(json.dumps(list(records), ensure_ascii=False, indent=2), encoding="utf-8")
        return

    with output_path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")


def clean_raw_dataset(
    raw_data_path: str | Path,
    output_path: str | Path,
) -> Dict[str, Any]:
    """Filter a raw dataset into a training-ready subset and save a cleaning summary."""
    raw_records = load_json_or_jsonl_records(raw_data_path)
    core_records: List[Dict[str, Any]] = []
    rescued_records: List[Dict[str, Any]] = []
    cleaned_records: List[Dict[str, Any]] = []
    rejection_counts: Counter[str] = Counter()
    core_action_counts: Counter[str] = Counter()
    rescued_action_counts: Counter[str] = Counter()

    for record in raw_records:
        tier, reason, metadata = classify_cleaning_tier(record)
        if tier == "rejected":
            rejection_counts[reason] += 1
            continue
        if tier == "core":
            core_records.append(record)
            core_action_counts[str(metadata["action_type"])] += 1
        elif tier == "rescued":
            rescued_records.append(record)
            rescued_action_counts[str(metadata["action_type"])] += 1
        cleaned_records.append(record)

    output_path = Path(output_path)
    _write_records(output_path, cleaned_records)
    core_output_path = output_path.with_name(f"{output_path.stem}_core{output_path.suffix}")
    rescued_output_path = output_path.with_name(f"{output_path.stem}_rescued{output_path.suffix}")
    _write_records(core_output_path, core_records)
    _write_records(rescued_output_path, rescued_records)

    summary = {
        "raw_data_path": str(Path(raw_data_path)),
        "output_path": str(output_path),
        "total_records": int(len(raw_records)),
        "kept_records": int(len(cleaned_records)),
        "core_records": int(len(core_records)),
        "rescued_records": int(len(rescued_records)),
        "rejected_records": int(len(raw_records) - len(cleaned_records)),
        "core_output_path": str(core_output_path),
        "rescued_output_path": str(rescued_output_path),
        "kept_action_counts": {
            action_name: int(core_action_counts.get(action_name, 0) + rescued_action_counts.get(action_name, 0))
            for action_name in sorted(set(core_action_counts) | set(rescued_action_counts))
        },
        "core_action_counts": dict(core_action_counts),
        "rescued_action_counts": dict(rescued_action_counts),
        "rejection_counts": dict(rejection_counts),
        "rules": {
            "target_action_types": sorted(TARGET_ACTION_TYPES),
            "min_frame_count": MIN_FRAME_COUNT,
            "max_frame_count": MAX_FRAME_COUNT,
            "min_unique_nodes": MIN_UNIQUE_NODES,
            "rescued_unique_nodes": 7,
            "critical_raw_nodes": sorted(CRITICAL_RAW_NODES),
            "valid_imu_dim": VALID_IMU_DIM,
            "max_framecount_diff_ratio": MAX_FRAMECOUNT_DIFF_RATIO,
        },
    }

    summary_path = output_path.with_name(f"{output_path.stem}_cleaning_summary.json")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean raw action data into a training-ready subset.")
    parser.add_argument("--raw", required=True, help="Path to raw action JSON/JSONL file.")
    parser.add_argument("--output", required=True, help="Path for the cleaned output JSON/JSONL file.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = clean_raw_dataset(
            raw_data_path=Path(args.raw),
            output_path=Path(args.output),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
