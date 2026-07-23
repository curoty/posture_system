"""Analyze newline-delimited static IMU exports without modifying raw data."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")
GYRO_CHANNELS = ("gx", "gy", "gz")
CHUNK_RECORD_TYPES = {"static_raw_chunk", "four_node_static_chunk"}


def _load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON") from exc
            if isinstance(value, dict):
                records.append(value)
    return records


def _normalized_timestamp_ms(frame: dict[str, Any]) -> tuple[float, str]:
    unix_ms = float(frame.get("unix_ts_ms") or 0)
    if bool(frame.get("time_synced")) and unix_ms >= 1_000_000_000_000:
        return unix_ms, "unix_ts_ms"
    uptime_ms = float(frame.get("uptime_ms") or 0)
    if uptime_ms > 0:
        return uptime_ms, "uptime_ms"
    return float(frame.get("t") or 0), "t"


def _robust_summary(values: np.ndarray) -> dict[str, float]:
    median = float(np.nanmedian(values))
    mad = float(np.nanmedian(np.abs(values - median)))
    return {
        "mean": float(np.nanmean(values)),
        "median": median,
        "std": float(np.nanstd(values)),
        "robust_sigma": 1.4826 * mad,
        "min": float(np.nanmin(values)),
        "max": float(np.nanmax(values)),
    }


def analyze_file(path: Path) -> dict[str, Any]:
    records = _load_records(path)
    chunks = [
        item for item in records if item.get("recordType") in CHUNK_RECORD_TYPES
    ]
    chunks.sort(key=lambda item: int(item.get("chunkIndex") or 0))
    frames = [
        frame
        for chunk in chunks
        for frame in chunk.get("frames", [])
        if isinstance(frame, dict)
    ]
    if not frames:
        raise ValueError(f"{path}: no static frames found")

    timestamps = [_normalized_timestamp_ms(frame) for frame in frames]
    timestamp_sources = defaultdict(int)
    for _, source in timestamps:
        timestamp_sources[source] += 1
    timestamp_values = np.asarray([item[0] for item in timestamps], dtype=np.float64)
    timestamp_deltas = np.diff(timestamp_values)
    positive_deltas = timestamp_deltas[timestamp_deltas > 0]

    node_values: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    node_temperatures: dict[str, list[float]] = defaultdict(list)
    node_sequences: dict[str, list[int]] = defaultdict(list)
    calibration_statuses: dict[str, int] = defaultdict(int)
    for chunk in chunks:
        calibration = chunk.get("calibration")
        if isinstance(calibration, dict):
            status = str(calibration.get("status") or "unknown")
            calibration_statuses[status] += int(chunk.get("frameCount") or 0)

    for frame in frames:
        calibration = frame.get("calibration")
        if isinstance(calibration, dict):
            status = str(calibration.get("status") or "unknown")
            calibration_statuses[status] += 1
        points = frame.get("points")
        if not isinstance(points, dict):
            continue
        node_seq = frame.get("node_seq")
        for node, point in points.items():
            if not isinstance(point, dict):
                continue
            for channel in CHANNELS:
                value = point.get(channel)
                if isinstance(value, (int, float)) and np.isfinite(value):
                    node_values[str(node)][channel].append(float(value))
            temperature = point.get(
                "temperature_c", frame.get("temperature_c")
            )
            if isinstance(temperature, (int, float)) and np.isfinite(temperature):
                node_temperatures[str(node)].append(float(temperature))
            sequence = (
                node_seq.get(node)
                if isinstance(node_seq, dict)
                else frame.get("seq")
            )
            if isinstance(sequence, (int, float)):
                node_sequences[str(node)].append(int(sequence))

    nodes: dict[str, Any] = {}
    for node, channel_values in sorted(node_values.items()):
        channel_stats = {
            channel: _robust_summary(np.asarray(values, dtype=np.float64))
            for channel, values in channel_values.items()
            if values
        }
        sequences = node_sequences.get(node, [])
        missing = sum(
            max(0, current - previous - 1)
            for previous, current in zip(sequences, sequences[1:])
        )
        duplicates = len(sequences) - len(set(sequences))
        temperatures = np.asarray(node_temperatures.get(node, []), dtype=np.float64)
        nodes[node] = {
            "frame_count": len(channel_values.get("gx", [])),
            "channels": channel_stats,
            "gyro_bias_median_dps": [
                channel_stats[channel]["median"] for channel in GYRO_CHANNELS
            ],
            "gyro_noise_robust_sigma_dps": [
                channel_stats[channel]["robust_sigma"]
                for channel in GYRO_CHANNELS
            ],
            "temperature": (
                {
                    "min_c": float(np.min(temperatures)),
                    "max_c": float(np.max(temperatures)),
                    "span_c": float(np.ptp(temperatures)),
                    "median_c": float(np.median(temperatures)),
                }
                if temperatures.size
                else None
            ),
            "sequence_missing_count": int(missing),
            "sequence_duplicate_count": int(duplicates),
        }

    return {
        "file": path.name,
        "capture_id": str(chunks[0].get("captureId") or ""),
        "chunk_count": len(chunks),
        "frame_count": len(frames),
        "timestamp_sources": dict(timestamp_sources),
        "timestamp": {
            "backward_count": int(np.count_nonzero(timestamp_deltas < 0)),
            "duplicate_count": int(np.count_nonzero(timestamp_deltas == 0)),
            "median_interval_ms": (
                float(np.median(positive_deltas))
                if positive_deltas.size
                else None
            ),
        },
        "calibration_status_counts": dict(calibration_statuses),
        "nodes": nodes,
    }


def _mark_inconsistent_rounds(files: list[dict[str, Any]]) -> None:
    by_node: dict[str, list[tuple[dict[str, Any], np.ndarray]]] = defaultdict(list)
    for file_result in files:
        for node, node_result in file_result["nodes"].items():
            by_node[node].append(
                (
                    file_result,
                    np.asarray(
                        node_result["gyro_bias_median_dps"], dtype=np.float64
                    ),
                )
            )

    for node, rounds in by_node.items():
        if len(rounds) < 3:
            continue
        biases = np.stack([item[1] for item in rounds])
        center = np.median(biases, axis=0)
        distances = np.linalg.norm(biases - center[None, :], axis=1)
        distance_center = float(np.median(distances))
        distance_mad = float(np.median(np.abs(distances - distance_center)))
        threshold = max(0.25, distance_center + 6.0 * 1.4826 * distance_mad)
        for (file_result, _), distance in zip(rounds, distances):
            node_result = file_result["nodes"][node]
            node_result["cross_round_bias_distance_dps"] = float(distance)
            node_result["calibration_round_suspect"] = bool(distance > threshold)
            node_result["calibration_round_reason"] = (
                "cross_round_gyro_bias_inconsistent"
                if distance > threshold
                else "consistent"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    paths = sorted(args.input_dir.glob("*.json"))
    if not paths:
        raise SystemExit(f"no JSON files found in {args.input_dir}")
    file_results = [analyze_file(path) for path in paths]
    _mark_inconsistent_rounds(file_results)

    report = {
        "schema_version": 1,
        "input_directory": str(args.input_dir),
        "raw_data_modified": False,
        "files": file_results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"wrote {args.output} ({len(file_results)} files)")


if __name__ == "__main__":
    main()
