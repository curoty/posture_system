"""Prepare segmented, normalized, labeled training samples from cleaned raw data."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np

from src.clean_raw_dataset import TARGET_ACTION_TYPES
from src.evaluate_against_standard import load_json_or_jsonl_records
from src.quality_labels import convert_score_to_quality_class, get_quality_code


TARGET_SAMPLE_RATE_HZ = 10.0
MIN_SEGMENT_DURATION_SECONDS = 2.0
MAX_SEGMENT_DURATION_SECONDS = 6.0
TARGET_SEGMENT_DURATION_SECONDS = 4.0
VALID_IMU_DIM = 6


def _quality_class_name(class_id: int) -> str:
    return get_quality_code(class_id)


def _sort_and_dedupe_frames(frames: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    valid_frames = [frame for frame in frames if isinstance(frame, dict) and "t" in frame and "p" in frame]
    sorted_frames = sorted(valid_frames, key=lambda frame: float(frame["t"]))
    deduped_frames: List[Dict[str, Any]] = []
    last_timestamp: float | None = None
    for frame in sorted_frames:
        timestamp = float(frame["t"])
        if last_timestamp is not None and timestamp == last_timestamp:
            continue
        deduped_frames.append(frame)
        last_timestamp = timestamp
    return deduped_frames


def _select_segment_window(frames: Sequence[Dict[str, Any]]) -> Tuple[float, float]:
    start_ms = float(frames[0]["t"])
    end_ms = float(frames[-1]["t"])
    duration_seconds = (end_ms - start_ms) / 1000.0
    if duration_seconds < MIN_SEGMENT_DURATION_SECONDS:
        raise ValueError("segment_too_short")

    if duration_seconds <= MAX_SEGMENT_DURATION_SECONDS:
        return start_ms, end_ms

    target_ms = TARGET_SEGMENT_DURATION_SECONDS * 1000.0
    center_ms = (start_ms + end_ms) / 2.0
    window_start_ms = center_ms - target_ms / 2.0
    window_end_ms = center_ms + target_ms / 2.0
    return window_start_ms, window_end_ms


def _slice_frames_by_window(frames: Sequence[Dict[str, Any]], window_start_ms: float, window_end_ms: float) -> List[Dict[str, Any]]:
    return [frame for frame in frames if window_start_ms <= float(frame["t"]) <= window_end_ms]


def _resample_segment_frames(frames: Sequence[Dict[str, Any]], sample_rate_hz: float = TARGET_SAMPLE_RATE_HZ) -> List[Dict[str, Any]]:
    if len(frames) < 2:
        raise ValueError("not_enough_frames_for_resample")

    timestamps_ms = np.asarray([float(frame["t"]) for frame in frames], dtype=float)
    start_ms = float(timestamps_ms[0])
    end_ms = float(timestamps_ms[-1])
    if end_ms <= start_ms:
        raise ValueError("invalid_segment_duration")

    step_ms = 1000.0 / float(sample_rate_hz)
    target_timestamps = np.arange(start_ms, end_ms + step_ms * 0.5, step_ms, dtype=float)
    node_names = sorted({node_name for frame in frames for node_name in (frame.get("p") or {}).keys()})

    per_node_series: Dict[str, Dict[str, np.ndarray]] = {}
    for node_name in node_names:
        node_ts: List[float] = []
        node_values: List[List[float]] = []
        for frame in frames:
            node_payload = frame.get("p") or {}
            raw_values = node_payload.get(node_name)
            if isinstance(raw_values, list) and len(raw_values) == VALID_IMU_DIM:
                node_ts.append(float(frame["t"]))
                node_values.append([float(value) for value in raw_values])
        if len(node_ts) < 2:
            continue

        node_ts_array = np.asarray(node_ts, dtype=float)
        node_value_array = np.asarray(node_values, dtype=float)
        interpolated = np.vstack(
            [
                np.interp(target_timestamps, node_ts_array, node_value_array[:, channel_index])
                for channel_index in range(VALID_IMU_DIM)
            ]
        ).T
        per_node_series[node_name] = {
            "ts": target_timestamps,
            "values": interpolated,
        }

    if not per_node_series:
        raise ValueError("no_resampleable_nodes")

    resampled_frames: List[Dict[str, Any]] = []
    for time_index, timestamp in enumerate(target_timestamps):
        node_payload: Dict[str, List[float]] = {}
        for node_name, series in per_node_series.items():
            node_payload[node_name] = [float(value) for value in series["values"][time_index]]
        if not node_payload:
            continue
        resampled_frames.append(
            {
                "t": int(round(float(timestamp))),
                "p": node_payload,
            }
        )

    return resampled_frames


def _build_segmented_record(record: Dict[str, Any], record_index: int) -> Dict[str, Any]:
    action_type = str(record.get("actionType"))
    if action_type not in TARGET_ACTION_TYPES:
        raise ValueError("unsupported_action_type")

    label_payload = record.get("label") if isinstance(record.get("label"), dict) else {}
    coach_score = label_payload.get("coachScore")
    if coach_score is None:
        raise ValueError("missing_coach_score")

    frames = _sort_and_dedupe_frames(record.get("frames", []))
    if len(frames) < 2:
        raise ValueError("not_enough_valid_frames")

    window_start_ms, window_end_ms = _select_segment_window(frames)
    segmented_frames = _slice_frames_by_window(frames, window_start_ms, window_end_ms)
    if len(segmented_frames) < 2:
        raise ValueError("segment_window_empty")

    resampled_frames = _resample_segment_frames(segmented_frames, sample_rate_hz=TARGET_SAMPLE_RATE_HZ)
    if len(resampled_frames) < int(MIN_SEGMENT_DURATION_SECONDS * TARGET_SAMPLE_RATE_HZ):
        raise ValueError("segment_too_short_after_resample")

    quality_class = convert_score_to_quality_class(float(coach_score))
    duration_seconds = (float(resampled_frames[-1]["t"]) - float(resampled_frames[0]["t"])) / 1000.0
    if duration_seconds < MIN_SEGMENT_DURATION_SECONDS or duration_seconds > MAX_SEGMENT_DURATION_SECONDS:
        raise ValueError("segment_duration_out_of_range_after_resample")

    output_record = dict(record)
    output_record["frames"] = resampled_frames
    output_record["frameCount"] = int(len(resampled_frames))
    output_record["actionLabel"] = action_type
    output_record["qualityScore"] = float(coach_score)
    output_record["qualityClass"] = int(quality_class)
    output_record["qualityClassName"] = _quality_class_name(quality_class)
    output_record["preprocessing"] = {
        "source_record_index": int(record_index),
        "segment_start_ms": int(round(window_start_ms)),
        "segment_end_ms": int(round(window_end_ms)),
        "target_sample_rate_hz": float(TARGET_SAMPLE_RATE_HZ),
        "segment_duration_seconds": float(duration_seconds),
        "original_frame_count": int(len(record.get("frames", []))),
        "segmented_frame_count": int(len(segmented_frames)),
        "resampled_frame_count": int(len(resampled_frames)),
    }
    return output_record


def _write_jsonl(output_path: Path, records: Sequence[Dict[str, Any]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")


def prepare_segmented_dataset(
    input_path: str | Path,
    output_path: str | Path,
) -> Dict[str, Any]:
    records = load_json_or_jsonl_records(input_path)
    prepared_records: List[Dict[str, Any]] = []
    action_counts: Counter[str] = Counter()
    quality_class_counts: Counter[str] = Counter()
    rejection_counts: Counter[str] = Counter()

    for record_index, record in enumerate(records):
        try:
            prepared_record = _build_segmented_record(record, record_index)
        except Exception as exc:
            rejection_counts[str(exc)] += 1
            continue
        prepared_records.append(prepared_record)
        action_counts[str(prepared_record["actionLabel"])] += 1
        quality_class_counts[str(prepared_record["qualityClass"])] += 1

    output_path = Path(output_path)
    _write_jsonl(output_path, prepared_records)

    summary = {
        "input_path": str(Path(input_path)),
        "output_path": str(output_path),
        "total_records": int(len(records)),
        "prepared_records": int(len(prepared_records)),
        "rejected_records": int(len(records) - len(prepared_records)),
        "action_counts": dict(action_counts),
        "quality_class_counts": dict(quality_class_counts),
        "rejection_counts": dict(rejection_counts),
        "normalization": {
            "target_sample_rate_hz": float(TARGET_SAMPLE_RATE_HZ),
            "min_segment_duration_seconds": float(MIN_SEGMENT_DURATION_SECONDS),
            "max_segment_duration_seconds": float(MAX_SEGMENT_DURATION_SECONDS),
            "target_segment_duration_seconds": float(TARGET_SEGMENT_DURATION_SECONDS),
        },
    }
    summary_path = output_path.with_name(f"{output_path.stem}_summary.json")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare segmented, normalized training samples.")
    parser.add_argument("--input", required=True, help="Path to cleaned input JSON/JSONL file.")
    parser.add_argument("--output", required=True, help="Path for segmented output JSONL file.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = prepare_segmented_dataset(
            input_path=Path(args.input),
            output_path=Path(args.output),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
