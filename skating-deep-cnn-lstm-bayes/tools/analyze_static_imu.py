"""Analyze chunked ICM20602 static captures and build calibration diagnostics.

The input exports contain one JSON document per line: data chunks followed by a
manifest. This tool never rewrites the source exports.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.denoise import (  # noqa: E402
    CalibrationProfile,
    CHANNEL_NAMES,
    DEFAULT_SAMPLE_RATE_HZ,
    fit_temperature_bias,
    validate_timestamps,
)


def read_export_documents(path: Path) -> List[Dict[str, Any]]:
    documents: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                value = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
            if isinstance(value, dict):
                documents.append(value)
    return documents


def iter_node_rows(
    documents: Iterable[Dict[str, Any]],
) -> Iterable[Tuple[str, float, float, List[float]]]:
    for document in documents:
        frames = document.get("frames")
        if not isinstance(frames, list):
            continue
        for frame in frames:
            if not isinstance(frame, dict):
                continue
            timestamp = float(
                frame.get("unix_ts_ms", frame.get("t", frame.get("uptime_ms", 0)))
            )
            frame_temperature = frame.get("temperature_c")
            points = frame.get("points")
            if not isinstance(points, dict):
                continue
            node_temperatures = frame.get("node_temperature_c")
            if not isinstance(node_temperatures, dict):
                node_temperatures = {}
            for node_id, point in points.items():
                if not isinstance(point, dict):
                    continue
                values = [point.get(name) for name in CHANNEL_NAMES]
                if not all(isinstance(value, (int, float)) for value in values):
                    continue
                temperature = point.get(
                    "temperature_c",
                    node_temperatures.get(node_id, frame_temperature),
                )
                yield (
                    str(node_id),
                    timestamp,
                    float(temperature) if isinstance(temperature, (int, float)) else np.nan,
                    [float(value) for value in values],
                )


def robust_channel_stats(values: np.ndarray) -> Dict[str, Any]:
    center = np.nanmedian(values, axis=0)
    mad_sigma = 1.4826 * np.nanmedian(np.abs(values - center), axis=0)
    return {
        "median": dict(zip(CHANNEL_NAMES, center.tolist())),
        "robust_sigma": dict(zip(CHANNEL_NAMES, mad_sigma.tolist())),
        "minimum": dict(zip(CHANNEL_NAMES, np.nanmin(values, axis=0).tolist())),
        "maximum": dict(zip(CHANNEL_NAMES, np.nanmax(values, axis=0).tolist())),
    }


def analyze_file(path: Path) -> Dict[str, Any]:
    documents = read_export_documents(path)
    # Cloud database exports are not guaranteed to preserve chunk insertion
    # order. Restore capture order before timing analysis.
    chunk_docs = sorted(
        (
            document
            for document in documents
            if isinstance(document.get("frames"), list)
        ),
        key=lambda document: int(document.get("chunkIndex", 0)),
    )
    rows_by_node: Dict[str, List[Tuple[float, float, List[float]]]] = defaultdict(list)
    for node_id, timestamp, temperature, values in iter_node_rows(chunk_docs):
        rows_by_node[node_id].append((timestamp, temperature, values))

    sample_rates = [
        float(document.get("sampleRateHz", DEFAULT_SAMPLE_RATE_HZ))
        for document in chunk_docs
    ]
    sample_rate_hz = (
        float(np.median(sample_rates)) if sample_rates else DEFAULT_SAMPLE_RATE_HZ
    )
    result: Dict[str, Any] = {
        "path": str(path),
        "document_count": len(documents),
        "chunk_count": len(chunk_docs),
        "sample_rate_hz": sample_rate_hz,
        "nodes": {},
    }

    for node_id, rows in sorted(rows_by_node.items()):
        timestamps = np.asarray([row[0] for row in rows], dtype=np.float64)
        temperatures = np.asarray([row[1] for row in rows], dtype=np.float64)
        values = np.asarray([row[2] for row in rows], dtype=np.float64)
        finite_temperatures = temperatures[np.isfinite(temperatures)]
        node_report: Dict[str, Any] = {
            "frame_count": int(values.shape[0]),
            "timing": validate_timestamps(timestamps, sample_rate_hz),
            "channels": robust_channel_stats(values),
            "temperature": {
                "sample_count": int(finite_temperatures.size),
                "minimum_c": (
                    float(np.min(finite_temperatures))
                    if finite_temperatures.size
                    else None
                ),
                "maximum_c": (
                    float(np.max(finite_temperatures))
                    if finite_temperatures.size
                    else None
                ),
                "span_c": (
                    float(np.ptp(finite_temperatures))
                    if finite_temperatures.size
                    else None
                ),
            },
        }
        if finite_temperatures.size >= 20:
            finite = np.isfinite(temperatures)
            node_report["gyro_temperature_fit"] = fit_temperature_bias(
                temperatures[finite],
                values[finite, 3:6],
            )
            node_report["acc_temperature_fit"] = fit_temperature_bias(
                temperatures[finite],
                values[finite, :3],
            )
        result["nodes"][node_id] = node_report
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=PROJECT_ROOT.parent / "static_samples",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "experiments" / "imu_calibration" / "static_report.json",
    )
    parser.add_argument(
        "--profiles-output",
        type=Path,
        default=(
            PROJECT_ROOT
            / "experiments"
            / "imu_calibration"
            / "calibration_profiles.json"
        ),
    )
    args = parser.parse_args()

    files = sorted(args.input_dir.rglob("*.json"))
    if not files:
        raise SystemExit(f"no JSON files found under {args.input_dir}")
    file_reports = [analyze_file(path) for path in files]
    report = {
        "schema_version": 1,
        "source_directory": str(args.input_dir.resolve()),
        "files": file_reports,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    constant_biases: Dict[str, List[List[float]]] = defaultdict(list)
    constant_sources: Dict[str, List[str]] = defaultdict(list)
    for file_report in file_reports:
        if "constant_tem" not in Path(file_report["path"]).name:
            continue
        for node_id, node_report in file_report["nodes"].items():
            medians = node_report["channels"]["median"]
            constant_biases[node_id].append(
                [float(medians["gx"]), float(medians["gy"]), float(medians["gz"])]
            )
            constant_sources[node_id].append(file_report["path"])

    profiles: Dict[str, Any] = {"schema_version": 1, "nodes": {}}
    for node_id, biases in sorted(constant_biases.items()):
        gyro_bias = np.median(np.asarray(biases, dtype=np.float64), axis=0)
        profile = CalibrationProfile(
            node_id=node_id,
            sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
            calibration_mode="firmware_calibrated",
            gyro_bias=gyro_bias.tolist(),
            temperature_compensation_enabled=False,
            metadata={
                "bias_kind": "post_firmware_calibration_residual",
                "source_files": constant_sources[node_id],
                "temperature_compensation_reason": (
                    "disabled_until_repeated_capture_spans_at_least_3_c"
                ),
            },
        )
        profiles["nodes"][node_id] = profile.to_dict()

    args.profiles_output.parent.mkdir(parents=True, exist_ok=True)
    args.profiles_output.write_text(
        json.dumps(profiles, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"wrote {args.output} ({len(files)} captures) and "
        f"{args.profiles_output} ({len(profiles['nodes'])} nodes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
