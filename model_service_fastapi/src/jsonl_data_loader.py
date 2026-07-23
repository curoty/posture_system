"""JSON Lines data adapter for skating action samples."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import pandas as pd

from src.data_loader import ActionSegment, EXPECTED_9NODE_ORDER


JSONL_EXPECTED_NODE_ORDER = (
    "head",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_knee",
    "right_knee",
    "left_foot",
    "right_foot",
)

JSONL_TO_BASELINE_NODE_MAPPING = {
    "head": "head",
    "left_elbow": "l_elbow",
    "right_elbow": "r_elbow",
    "left_wrist": "l_wrist",
    "right_wrist": "r_wrist",
    "left_knee": "l_knee",
    "right_knee": "r_knee",
    # First-stage approximation: JSONL foot sensors map onto baseline skate nodes.
    "left_foot": "l_skate",
    "right_foot": "r_skate",
}

DATA_ERROR_REASONS = (
    "empty_frames",
    "invalid_action_type",
    "invalid_node_value_length",
)
FILTERED_OUT_REASONS = ("incomplete_nodes",)


def iter_jsonl_records(jsonl_path: str | Path) -> Iterable[Dict[str, Any]]:
    """Yield one JSON object per non-empty line."""
    with open(jsonl_path, "r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            stripped_line = line.strip()
            if not stripped_line:
                continue
            payload = json.loads(stripped_line)
            if not isinstance(payload, dict):
                raise ValueError(f"JSONL line {line_number} must decode to an object.")
            yield payload


def get_jsonl_node_mapping() -> Dict[str, str]:
    """Return the JSONL-node to baseline-node mapping."""
    return dict(JSONL_TO_BASELINE_NODE_MAPPING)


def normalize_action_type(action_type: Any) -> Optional[str]:
    """Validate one actionType value."""
    if not isinstance(action_type, str):
        return None
    normalized = action_type.strip()
    if not normalized:
        return None
    return normalized


def build_dynamic_action_label_mapping(
    action_types: Sequence[str],
) -> Tuple[Dict[str, int], Dict[int, str]]:
    """Build a stable label mapping for JSONL action types."""
    sorted_action_types = sorted(set(action_types))
    label_name_to_id = {label_name: label_id for label_id, label_name in enumerate(sorted_action_types)}
    label_id_to_name = {label_id: label_name for label_name, label_id in label_name_to_id.items()}
    return label_name_to_id, label_id_to_name


def count_node_observations(record: Dict[str, Any], node_mapping: Dict[str, str]) -> Dict[str, int]:
    """Count valid observations per mapped node within one sample."""
    counts = {mapped_name: 0 for mapped_name in EXPECTED_9NODE_ORDER}
    for frame in record.get("frames", []):
        if not isinstance(frame, dict):
            continue
        node_payload = frame.get("p")
        if not isinstance(node_payload, dict):
            continue
        for raw_node_name, raw_values in node_payload.items():
            mapped_node_name = node_mapping.get(str(raw_node_name))
            if mapped_node_name is None:
                continue
            if isinstance(raw_values, list) and len(raw_values) == 6:
                counts[mapped_node_name] += 1
    return counts


def validate_jsonl_sample(
    record: Dict[str, Any],
    node_mapping: Dict[str, str],
    min_observations_per_node: int,
) -> Dict[str, Any]:
    """Validate one JSONL sample and classify failures."""
    action_type = normalize_action_type(record.get("actionType"))
    if action_type is None:
        return {"ok": False, "kind": "data_error", "reason": "invalid_action_type", "action_type": None}

    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return {"ok": False, "kind": "data_error", "reason": "empty_frames", "action_type": action_type}

    invalid_length_found = False
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        node_payload = frame.get("p")
        if not isinstance(node_payload, dict):
            continue
        for raw_values in node_payload.values():
            if isinstance(raw_values, list) and len(raw_values) == 6:
                continue
            invalid_length_found = True
            break
        if invalid_length_found:
            break

    if invalid_length_found:
        return {
            "ok": False,
            "kind": "data_error",
            "reason": "invalid_node_value_length",
            "action_type": action_type,
        }

    node_counts = count_node_observations(record, node_mapping)
    return {
        "ok": True,
        "kind": "ok",
        "reason": None,
        "action_type": action_type,
        "node_counts": node_counts,
    }


def jsonl_frames_to_sensor_frame(
    record: Dict[str, Any],
    node_mapping: Dict[str, str],
) -> pd.DataFrame:
    """Flatten JSONL frame payload into the RF baseline sensor-frame schema."""
    rows: List[Dict[str, Any]] = []
    for frame in record.get("frames", []):
        if not isinstance(frame, dict):
            continue
        timestamp_ms = frame.get("t")
        node_payload = frame.get("p")
        if not isinstance(node_payload, dict):
            continue
        try:
            ts_seconds = float(timestamp_ms) / 1000.0
        except (TypeError, ValueError):
            continue

        for raw_node_name, raw_values in node_payload.items():
            mapped_node_name = node_mapping.get(str(raw_node_name))
            if mapped_node_name is None:
                continue
            if not isinstance(raw_values, list) or len(raw_values) != 6:
                continue
            ax, ay, az, gx, gy, gz = [float(value) for value in raw_values]
            rows.append(
                {
                    "ts": ts_seconds,
                    "node": mapped_node_name,
                    "ax": ax,
                    "ay": ay,
                    "az": az,
                    "gx": gx,
                    "gy": gy,
                    "gz": gz,
                }
            )

    sensor_frame = pd.DataFrame(rows, columns=["ts", "node", "ax", "ay", "az", "gx", "gy", "gz"])
    if sensor_frame.empty:
        return sensor_frame
    return sensor_frame.sort_values(["ts", "node"]).reset_index(drop=True)


def convert_jsonl_sample_to_action_segment(
    record: Dict[str, Any],
    segment_id: int,
    label_name_to_id: Dict[str, int],
    node_mapping: Dict[str, str],
    min_observations_per_node: int,
) -> Tuple[Optional[ActionSegment], Dict[str, Any]]:
    """Convert one JSONL sample into an ActionSegment or return a structured failure."""
    validation = validate_jsonl_sample(
        record=record,
        node_mapping=node_mapping,
        min_observations_per_node=min_observations_per_node,
    )
    if not validation["ok"]:
        return None, validation

    action_label_name = validation["action_type"]
    sensor_frame = jsonl_frames_to_sensor_frame(record, node_mapping)
    if sensor_frame.empty:
        return None, {"ok": False, "kind": "data_error", "reason": "empty_frames", "action_type": action_label_name}

    start_ts = float(sensor_frame["ts"].min())
    end_ts = float(sensor_frame["ts"].max())
    metadata = {
        "segment_id": int(segment_id),
        "start_ts": start_ts,
        "end_ts": end_ts,
        "label_id": int(label_name_to_id[action_label_name]),
        "label_name": action_label_name,
        "duration_seconds": end_ts - start_ts,
        "num_rows": int(len(sensor_frame)),
        "nodes_present": sorted(sensor_frame["node"].drop_duplicates().tolist()),
        "source_format": "jsonl",
        "jsonl_id": str(record.get("_id", segment_id)),
        "session_id": str(record.get("sessionId", "")),
        "action_type_raw": action_label_name,
        "action_type_mapped": action_label_name,
        "frame_count_raw": int(record.get("frameCount", len(record.get("frames", [])))),
        "node_observations": validation["node_counts"],
    }

    return (
        ActionSegment(
            segment_id=int(segment_id),
            start_ts=start_ts,
            end_ts=end_ts,
            action_label_id=int(label_name_to_id[action_label_name]),
            action_label_name=action_label_name,
            standard_label_id=None,
            standard_label_name=None,
            sensor_frame=sensor_frame,
            node_order=list(EXPECTED_9NODE_ORDER),
            metadata=metadata,
        ),
        validation,
    )


def load_action_segments_from_jsonl(
    jsonl_path: str | Path,
    min_observations_per_node: int = 2,
) -> Tuple[List[ActionSegment], Dict[str, int], Dict[int, str], Dict[str, Any]]:
    """Load JSONL action samples and convert valid records into ActionSegments."""
    node_mapping = get_jsonl_node_mapping()
    raw_records = list(iter_jsonl_records(jsonl_path))

    valid_action_types: List[str] = []
    data_error_counts = {reason: 0 for reason in DATA_ERROR_REASONS}
    filtered_out_counts = {reason: 0 for reason in FILTERED_OUT_REASONS}

    for record in raw_records:
        validation = validate_jsonl_sample(
            record=record,
            node_mapping=node_mapping,
            min_observations_per_node=min_observations_per_node,
        )
        if validation["ok"]:
            valid_action_types.append(validation["action_type"])
            continue
        if validation["kind"] == "data_error":
            data_error_counts[validation["reason"]] += 1
        else:
            filtered_out_counts[validation["reason"]] += 1

    label_name_to_id, label_id_to_name = build_dynamic_action_label_mapping(valid_action_types)
    segments: List[ActionSegment] = []

    for record in raw_records:
        segment, validation = convert_jsonl_sample_to_action_segment(
            record=record,
            segment_id=len(segments),
            label_name_to_id=label_name_to_id,
            node_mapping=node_mapping,
            min_observations_per_node=min_observations_per_node,
        )
        if segment is None:
            continue
        segments.append(segment)

    action_type_counts_raw: Dict[str, int] = {}
    for record in raw_records:
        action_type = normalize_action_type(record.get("actionType"))
        if action_type is None:
            continue
        action_type_counts_raw[action_type] = action_type_counts_raw.get(action_type, 0) + 1

    action_type_counts_converted: Dict[str, int] = {}
    for segment in segments:
        action_type_counts_converted[segment.action_label_name] = (
            action_type_counts_converted.get(segment.action_label_name, 0) + 1
        )

    stats = {
        "total_records": len(raw_records),
        "data_errors": data_error_counts,
        "filtered_out": filtered_out_counts,
        "converted_action_segments": len(segments),
        "min_observations_per_node": int(min_observations_per_node),
        "action_type_counts_raw": action_type_counts_raw,
        "action_type_counts_converted": action_type_counts_converted,
        "label_mapping": {label_name: int(label_id) for label_name, label_id in label_name_to_id.items()},
    }
    return segments, label_name_to_id, label_id_to_name, stats
