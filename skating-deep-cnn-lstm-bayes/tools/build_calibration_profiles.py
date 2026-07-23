"""Build bench calibration profiles from static analysis output."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np


ROLE_ALIASES = {
    "left_ankle": "left_foot",
    "right_ankle": "right_foot",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--profile-kind",
        choices=("auto", "bench_raw", "bench_residual"),
        default="auto",
        help="Interpret source data as raw bench data or post-firmware residuals.",
    )
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    profile_kind = args.profile_kind
    if profile_kind == "auto":
        statuses = [
            status
            for file_result in report.get("files", [])
            for status, count in file_result.get("calibration_status_counts", {}).items()
            for _ in range(int(count or 0))
        ]
        profile_kind = "bench_raw" if statuses and all(s == "invalid" for s in statuses) else "bench_residual"
    samples: dict[str, list[dict[str, Any]]] = {}
    for file_result in report.get("files", []):
        for raw_role, result in file_result.get("nodes", {}).items():
            role = ROLE_ALIASES.get(raw_role, raw_role)
            if result.get("calibration_round_suspect"):
                continue
            if profile_kind == "bench_raw":
                channels = result.get("channels", {})
                bias = [
                    channels.get(axis, {}).get("mean")
                    for axis in ("gx", "gy", "gz")
                ]
            else:
                bias = result.get("gyro_bias_median_dps")
            if isinstance(bias, list) and len(bias) == 3:
                samples.setdefault(role, []).append(
                    {
                        "bias": [float(value) for value in bias],
                        "file": str(file_result.get("file", "")),
                        "frame_count": int(result.get("frame_count") or 0),
                    }
                )

    nodes: dict[str, dict[str, Any]] = {}
    for role, entries in sorted(samples.items()):
        values = np.asarray([entry["bias"] for entry in entries], dtype=float)
        if profile_kind == "bench_raw":
            weights = np.asarray([entry["frame_count"] for entry in entries], dtype=float)
            aggregate = np.average(values, axis=0, weights=weights) if np.sum(weights) > 0 else np.mean(values, axis=0)
        else:
            aggregate = np.median(values, axis=0)
        nodes[role] = {
            "node_id": role,
            "sample_rate_hz": 50.0,
            "calibration_mode": (
                "uncalibrated_raw" if profile_kind == "bench_raw" else "firmware_calibrated"
            ),
            "reference_temperature_c": None,
            "acc_bias": [0.0, 0.0, 0.0],
            "gyro_bias": [round(float(value), 6) for value in aggregate],
            "acc_temperature_slope": [0.0, 0.0, 0.0],
            "gyro_temperature_slope": [0.0, 0.0, 0.0],
            "temperature_compensation_enabled": False,
            "metadata": {
                "bias_kind": (
                    "bench_raw_gyro_mean"
                    if profile_kind == "bench_raw"
                    else "post_firmware_calibration_residual"
                ),
                "source_report": str(args.report),
                "included_files": [entry["file"] for entry in entries],
                "included_round_count": len(entries),
                "excluded_suspect_rounds": True,
                "temperature_compensation_reason": "disabled_until_valid_dynamic_temperature_profile",
            },
        }

    output = {
        "schema_version": 2,
        "profile_kind": (
            "bench_raw_before_any_offset"
            if profile_kind == "bench_raw"
            else "bench_residual_after_firmware_calibration"
        ),
        "source_report": str(args.report),
        "raw_data_modified": False,
        "nodes": nodes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"wrote {args.output} ({len(nodes)} nodes)")


if __name__ == "__main__":
    main()
