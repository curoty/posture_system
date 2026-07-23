"""Independent data loading utilities for skating action datasets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence
import warnings

import pandas as pd

from src.labels import get_label_id, get_label_name, normalize_label_name


REQUIRED_SENSOR_COLUMNS = ("ts", "node", "ax", "ay", "az", "gx", "gy", "gz")
REQUIRED_LABEL_COLUMNS = ("start_ts", "end_ts")
OPTIONAL_STANDARD_NAME_COLUMNS = ("standard_label_name", "standard_name")
OPTIONAL_STANDARD_ID_COLUMNS = ("standard_label", "standard_id")
EXPECTED_9NODE_ORDER = (
    "head",
    "l_elbow",
    "l_knee",
    "l_skate",
    "l_wrist",
    "r_elbow",
    "r_knee",
    "r_skate",
    "r_wrist",
)


@dataclass(frozen=True)
class ActionSegment:
    """Normalized action segment sliced from sensor data."""

    segment_id: int
    start_ts: float
    end_ts: float
    action_label_id: int
    action_label_name: str
    standard_label_id: Optional[int]
    standard_label_name: Optional[str]
    sensor_frame: pd.DataFrame
    node_order: List[str]
    metadata: Dict[str, Any]

    @property
    def label_id(self) -> int:
        return self.action_label_id

    @property
    def label_name(self) -> str:
        return self.action_label_name


def _validate_required_columns(frame: pd.DataFrame, required_columns: Iterable[str], frame_name: str) -> None:
    missing_columns = [column for column in required_columns if column not in frame.columns]
    if missing_columns:
        raise ValueError(f"{frame_name} is missing required columns: {missing_columns}")


def infer_node_order(sensor_df: pd.DataFrame) -> List[str]:
    """Infer a stable node order from first appearance in the sensor CSV."""
    return sensor_df["node"].drop_duplicates().tolist()


def validate_9node_sensor_layout(sensor_df: pd.DataFrame, expected_nodes: Sequence[str] = EXPECTED_9NODE_ORDER) -> List[str]:
    """Validate that sensor data contains the expected 9-node layout."""
    observed_nodes = sensor_df["node"].dropna().astype(str).str.strip().drop_duplicates().tolist()
    missing_nodes = [node for node in expected_nodes if node not in observed_nodes]
    unexpected_nodes = [node for node in observed_nodes if node not in expected_nodes]

    if missing_nodes:
        raise ValueError(f"sensor CSV is missing required 9-node entries: {missing_nodes}")
    if unexpected_nodes:
        warnings.warn(
            f"sensor CSV contains extra nodes outside the expected 9-node layout: {unexpected_nodes}",
            stacklevel=2,
        )

    return list(expected_nodes)


def load_sensor_csv(sensor_csv_path: str | Path) -> pd.DataFrame:
    """Load and validate a legacy-compatible 9-node sensor CSV."""
    sensor_df = pd.read_csv(sensor_csv_path)
    _validate_required_columns(sensor_df, REQUIRED_SENSOR_COLUMNS, "sensor CSV")

    sensor_df = sensor_df.copy()
    numeric_columns = [column for column in REQUIRED_SENSOR_COLUMNS if column != "node"]
    for column in numeric_columns:
        sensor_df[column] = pd.to_numeric(sensor_df[column], errors="coerce")

    sensor_df["node"] = sensor_df["node"].astype(str).str.strip()
    sensor_df = sensor_df.dropna(subset=numeric_columns + ["node"])
    sensor_df = sensor_df.sort_values(["ts", "node"]).reset_index(drop=True)
    validate_9node_sensor_layout(sensor_df)

    return sensor_df


def load_labels_csv(labels_csv_path: str | Path) -> pd.DataFrame:
    """Load, validate, and normalize a legacy-compatible label CSV."""
    labels_df = pd.read_csv(labels_csv_path)
    _validate_required_columns(labels_df, REQUIRED_LABEL_COLUMNS, "label CSV")

    labels_df = labels_df.copy()
    labels_df["start_ts"] = pd.to_numeric(labels_df["start_ts"], errors="coerce")
    labels_df["end_ts"] = pd.to_numeric(labels_df["end_ts"], errors="coerce")
    labels_df = labels_df.dropna(subset=["start_ts", "end_ts"]).reset_index(drop=True)

    if "label_name" in labels_df.columns:
        labels_df["label_name"] = labels_df["label_name"].map(normalize_label_name)
        labels_df["label"] = labels_df["label_name"].map(get_label_id)
    elif "label" in labels_df.columns:
        labels_df["label"] = pd.to_numeric(labels_df["label"], errors="raise").astype(int)
        labels_df["label_name"] = labels_df["label"].map(get_label_name)
    else:
        raise ValueError("label CSV must contain either 'label_name' or 'label'.")

    standard_name_column = next(
        (column for column in OPTIONAL_STANDARD_NAME_COLUMNS if column in labels_df.columns),
        None,
    )
    standard_id_column = next(
        (column for column in OPTIONAL_STANDARD_ID_COLUMNS if column in labels_df.columns),
        None,
    )

    if standard_name_column:
        labels_df["standard_label_name"] = labels_df[standard_name_column].fillna("").astype(str).str.strip()
        labels_df.loc[labels_df["standard_label_name"] == "", "standard_label_name"] = pd.NA
    else:
        labels_df["standard_label_name"] = pd.NA

    if standard_id_column:
        labels_df["standard_label"] = pd.to_numeric(labels_df[standard_id_column], errors="coerce")
    else:
        labels_df["standard_label"] = pd.NA

    labels_df = labels_df.sort_values(["start_ts", "end_ts"]).reset_index(drop=True)
    return labels_df


def build_action_segments(
    sensor_df: pd.DataFrame,
    labels_df: pd.DataFrame,
    node_order: Optional[Sequence[str]] = None,
    min_rows_per_segment: int = 2,
) -> List[ActionSegment]:
    """Slice old-format sensor/label CSVs into action segments.

    Each label row becomes one segment sample. No sliding window logic is used.
    """
    if node_order is None:
        node_order = validate_9node_sensor_layout(sensor_df)

    normalized_segments: List[ActionSegment] = []
    ordered_nodes = list(node_order)

    for segment_id, row in labels_df.iterrows():
        start_ts = float(row["start_ts"])
        end_ts = float(row["end_ts"])
        if end_ts <= start_ts:
            warnings.warn(
                f"Segment {segment_id} has non-positive duration and will be skipped.",
                stacklevel=2,
            )
            continue

        segment_frame = sensor_df.loc[(sensor_df["ts"] >= start_ts) & (sensor_df["ts"] <= end_ts)].copy()
        segment_frame = segment_frame.loc[segment_frame["node"].isin(ordered_nodes)].reset_index(drop=True)

        if len(segment_frame) < min_rows_per_segment:
            warnings.warn(
                f"Segment {segment_id} is too short after slicing and will be skipped.",
                stacklevel=2,
            )
            continue

        missing_nodes = [node for node in ordered_nodes if node not in segment_frame["node"].unique()]
        if missing_nodes:
            raise ValueError(
                f"Segment {segment_id} [{start_ts}, {end_ts}] is missing required 9-node entries: {missing_nodes}"
            )

        standard_label_name = row["standard_label_name"] if pd.notna(row["standard_label_name"]) else None
        standard_label_id = int(row["standard_label"]) if pd.notna(row["standard_label"]) else None

        metadata = {
            "segment_id": int(segment_id),
            "start_ts": start_ts,
            "end_ts": end_ts,
            "label_id": int(row["label"]),
            "label_name": str(row["label_name"]),
            "duration_seconds": end_ts - start_ts,
            "num_rows": int(len(segment_frame)),
            "nodes_present": sorted(segment_frame["node"].unique().tolist()),
        }

        normalized_segments.append(
            ActionSegment(
                segment_id=int(segment_id),
                start_ts=start_ts,
                end_ts=end_ts,
                action_label_id=int(row["label"]),
                action_label_name=str(row["label_name"]),
                standard_label_id=standard_label_id,
                standard_label_name=standard_label_name,
                sensor_frame=segment_frame,
                node_order=ordered_nodes,
                metadata=metadata,
            )
        )

    return normalized_segments


def load_action_segments(
    sensor_csv_path: str | Path,
    labels_csv_path: str | Path,
    node_order: Optional[Sequence[str]] = None,
    min_rows_per_segment: int = 2,
) -> List[ActionSegment]:
    """Read old-format sensor/label CSVs and return one segment per label row."""
    sensor_df = load_sensor_csv(sensor_csv_path)
    labels_df = load_labels_csv(labels_csv_path)
    return build_action_segments(
        sensor_df=sensor_df,
        labels_df=labels_df,
        node_order=node_order,
        min_rows_per_segment=min_rows_per_segment,
    )
