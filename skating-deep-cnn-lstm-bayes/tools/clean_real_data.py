#!/usr/bin/env python3
"""Clean real-device JSONL data for training.

Steps:
  1. Unify actionType: sensor_session → weight_shift
  2. Detect frozen sensor nodes (per-node per-channel std ≈ 0)
  3. Remove records with ≥3 frozen nodes
  4. Set frozen-node channels to NaN (per frame)
  5. Fix non-monotonic timestamps
  6. Linear-interpolate NaN values per channel along time axis
  7. Output cleaned JSONL
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Set

import numpy as np

ALL_NODES = (
    "head",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_knee", "right_knee",
    "left_foot", "right_foot",
)

CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")
N_CHANNELS = len(CHANNELS)
FROZEN_STD_THRESHOLD = 0.01  # below this std → considered frozen


def detect_frozen_nodes(record: dict) -> Set[str]:
    """Return set of node names that are frozen (all channels constant across frames)."""
    frames = record["frames"]
    frozen: Set[str] = set()
    for node in ALL_NODES:
        all_vals = []
        for frame in frames:
            if node in frame["p"]:
                all_vals.append(frame["p"][node])
        if len(all_vals) < 2:
            frozen.add(node)
            continue
        arr = np.array(all_vals, dtype=np.float64)
        stds = np.std(arr, axis=0)
        if np.all(stds < FROZEN_STD_THRESHOLD):
            frozen.add(node)
    return frozen


def set_node_to_nan(record: dict, frozen_nodes: Set[str]) -> None:
    """Set all channels of frozen nodes to NaN in every frame."""
    nan_vec = [float("nan")] * N_CHANNELS
    for frame in record["frames"]:
        for node in frozen_nodes:
            frame["p"][node] = list(nan_vec)


def fix_timestamps(frames: list) -> int:
    """Make timestamps strictly monotonic. Returns number of fixes applied."""
    fixes = 0
    for i in range(1, len(frames)):
        if frames[i]["t"] <= frames[i - 1]["t"]:
            frames[i]["t"] = frames[i - 1]["t"] + 1  # +1ms minimum step
            fixes += 1
    return fixes


def interpolate_nan_frames(record: dict) -> int:
    """Per-node per-channel linear interpolation over NaN frames. Returns filled count."""
    frames = record["frames"]
    n_frames = len(frames)
    filled = 0

    # Build full array [T, N, C] with NaN where nodes are missing
    node_idx = {node: i for i, node in enumerate(ALL_NODES)}
    arr = np.full((n_frames, len(ALL_NODES), N_CHANNELS), np.nan, dtype=np.float64)

    for t, frame in enumerate(frames):
        for node, values in frame["p"].items():
            if node in node_idx:
                ni = node_idx[node]
                arr[t, ni, :] = np.asarray(values, dtype=np.float64)

    # Interpolate per node per channel
    t_axis = np.arange(n_frames, dtype=np.float64)
    for ni in range(len(ALL_NODES)):
        for ci in range(N_CHANNELS):
            col = arr[:, ni, ci]
            nan_mask = np.isnan(col)
            if not np.any(nan_mask):
                continue
            if np.all(nan_mask):
                continue  # can't interpolate all-NaN

            valid = ~nan_mask
            if np.sum(valid) == 1:
                # Single valid value → forward/backward fill
                col[nan_mask] = col[valid][0]
            else:
                col[nan_mask] = np.interp(
                    t_axis[nan_mask], t_axis[valid], col[valid]
                )
            filled += int(np.sum(nan_mask))

    # Write back
    for t, frame in enumerate(frames):
        for ni, node in enumerate(ALL_NODES):
            if not np.any(np.isnan(arr[t, ni, :])):
                frame["p"][node] = [round(float(v), 6) for v in arr[t, ni, :]]

    return filled


def ensure_all_nodes_present(record: dict) -> int:
    """Ensure all 9 nodes are present in every frame. Missing → NaN placeholder."""
    frames = record["frames"]
    added = 0
    for frame in frames:
        for node in ALL_NODES:
            if node not in frame["p"]:
                frame["p"][node] = [float("nan")] * N_CHANNELS
                added += 1
    return added


def clean_dataset(input_path: str, output_path: str) -> dict:
    """Run full cleaning pipeline, return stats."""
    stats: Dict[str, Any] = {
        "input_records": 0,
        "action_unified": 0,
        "removed_many_frozen": 0,
        "kept_records": 0,
        "frozen_node_distribution": {},
        "timestamp_fixes": 0,
        "nan_filled": 0,
        "nodes_added": 0,
    }

    with open(input_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    stats["input_records"] = len(lines)

    cleaned: List[str] = []
    frozen_node_counts: Dict[str, int] = {node: 0 for node in ALL_NODES}

    for line_no, line in enumerate(lines):
        record = json.loads(line.strip())

        # Step 1: Unify action type
        if record.get("actionType") == "sensor_session":
            record["actionType"] = "weight_shift"
            stats["action_unified"] += 1

        # Ensure all 9 nodes exist in every frame
        added = ensure_all_nodes_present(record)
        stats["nodes_added"] += added

        # Step 2: Detect frozen nodes
        frozen = detect_frozen_nodes(record)

        # Step 3: Remove if ≥3 frozen
        if len(frozen) >= 3:
            stats["removed_many_frozen"] += 1
            continue

        for node in frozen:
            frozen_node_counts[node] += 1

        # Step 4: Set frozen nodes to NaN
        if frozen:
            set_node_to_nan(record, frozen)

        # Step 5: Fix non-monotonic timestamps
        fixes = fix_timestamps(record["frames"])
        stats["timestamp_fixes"] += fixes

        # Step 6: Interpolate NaN values
        filled = interpolate_nan_frames(record)
        stats["nan_filled"] += filled

        # Ensure frameCount matches
        record["frameCount"] = len(record["frames"])

        cleaned.append(json.dumps(record, ensure_ascii=False))
        stats["kept_records"] += 1

    stats["frozen_node_distribution"] = frozen_node_counts

    # Write output
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(cleaned) + "\n", encoding="utf-8")

    return stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean real-device JSONL data.")
    parser.add_argument("--input", required=True, help="Input JSONL file.")
    parser.add_argument("--output", default="cleaned_data.jsonl", help="Output JSONL file.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not Path(args.input).exists():
        print(f"Error: input file not found: {args.input}")
        return 1

    stats = clean_dataset(args.input, args.output)

    print("=" * 60)
    print("DATA CLEANING REPORT")
    print("=" * 60)
    print(f"Input records:            {stats['input_records']}")
    print(f"Action type unified:      {stats['action_unified']}")
    print(f"Removed (≥3 frozen nodes): {stats['removed_many_frozen']}")
    print(f"Kept records:             {stats['kept_records']}")
    print(f"Timestamp fixes applied:  {stats['timestamp_fixes']}")
    print(f"NaN values interpolated:  {stats['nan_filled']}")
    print(f"Missing nodes added:      {stats['nodes_added']}")
    print()
    print("Frozen node distribution (in kept records):")
    for node, count in sorted(stats["frozen_node_distribution"].items(), key=lambda x: -x[1]):
        if count > 0:
            print(f"  {node:15s}: {count:4d}")
    print()
    print(f"Output: {Path(args.output).resolve()}")
    print(f"File size: {Path(args.output).stat().st_size / (1024*1024):.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
