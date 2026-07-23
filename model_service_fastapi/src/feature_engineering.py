"""Feature extraction pipeline for random forest baseline models."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
import warnings

import numpy as np
import pandas as pd

from src.config import (
    DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    DEFAULT_MISSING_NODE_FILL_VALUE,
    DEFAULT_MIN_VALID_NODES_PER_WINDOW,
    DEFAULT_WINDOW_END_SECONDS,
    DEFAULT_WINDOW_START_SECONDS,
)
from src.data_loader import ActionSegment, load_action_segments


DEFAULT_FEATURE_CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz", "acc_mag")
DEFAULT_WINDOW_STATS = ("mean", "std", "min", "max", "range", "energy", "slope")
DEFAULT_SEGMENT_STATS = ("mean", "std", "max", "skew", "kurtosis")
WINDOW_NAMES = ("start", "end")
DEFAULT_CORRELATION_CHANNELS = ("ax", "ay", "az", "acc_mag")
DEFAULT_FREQUENCY_CHANNELS = ("ax", "ay", "az")
DEFAULT_FFT_TOP_K = 3
DEFAULT_FREQUENCY_STATS = ("peak1_energy", "peak2_energy", "peak3_energy", "spectral_entropy")
DEFAULT_CORRELATION_NODE_PAIRS = (
    ("l_elbow", "r_elbow"),
    ("l_knee", "r_knee"),
    ("l_skate", "r_skate"),
    ("l_wrist", "r_wrist"),
)


def get_best_feature_config() -> Dict[str, Any]:
    """Return the currently selected feature families for training."""
    return {
        "feature_groups": ["window_features", "global_statistics"],
        "use_window_features": True,
        "use_global_statistics": True,
        "use_correlation_features": False,
        "use_frequency_features": False,
        "window_stats": list(DEFAULT_WINDOW_STATS),
        "global_stats": list(DEFAULT_SEGMENT_STATS),
    }


def estimate_sample_rate(ts_values: pd.Series) -> float:
    """Estimate sampling rate from timestamp deltas."""
    unique_ts = np.sort(ts_values.dropna().unique())
    if len(unique_ts) < 2:
        return 0.0

    deltas = np.diff(unique_ts)
    deltas = deltas[deltas > 0]
    if len(deltas) == 0:
        return 0.0

    return float(1.0 / np.median(deltas))


def _warn_if_ts_discontinuous(ts_values: np.ndarray, segment_id: int, window_name: str) -> None:
    if len(ts_values) < 3:
        return

    deltas = np.diff(np.sort(ts_values))
    deltas = deltas[deltas > 0]
    if len(deltas) < 2:
        return

    median_delta = float(np.median(deltas))
    if median_delta <= 0:
        return

    if np.any(deltas > median_delta * 1.5):
        warnings.warn(
            f"Segment {segment_id} {window_name} window has discontinuous ts values.",
            stacklevel=2,
        )


def _compute_acc_magnitude(frame: pd.DataFrame) -> pd.Series:
    return np.sqrt(frame["ax"] ** 2 + frame["ay"] ** 2 + frame["az"] ** 2)


def extract_segment_windows(
    segment: ActionSegment,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
) -> Tuple[pd.DataFrame, pd.DataFrame, float]:
    """Extract start and end windows from a full action segment."""
    segment_frame = segment.sensor_frame.copy()
    sample_rate_hz = estimate_sample_rate(segment_frame["ts"])

    start_window_end = min(segment.start_ts + start_window_seconds, segment.end_ts)
    end_window_start = max(segment.end_ts - end_window_seconds, segment.start_ts)

    start_window = (
        segment_frame.loc[(segment_frame["ts"] >= segment.start_ts) & (segment_frame["ts"] <= start_window_end)]
        .copy()
        .sort_values(["ts", "node"])
        .reset_index(drop=True)
    )
    end_window = (
        segment_frame.loc[(segment_frame["ts"] >= end_window_start) & (segment_frame["ts"] <= segment.end_ts)]
        .copy()
        .sort_values(["ts", "node"])
        .reset_index(drop=True)
    )

    for window_frame in (start_window, end_window):
        if "acc_mag" not in window_frame.columns and not window_frame.empty:
            window_frame["acc_mag"] = _compute_acc_magnitude(window_frame)

    return start_window, end_window, sample_rate_hz


def _calculate_slope(ts_values: np.ndarray, signal_values: np.ndarray) -> float:
    if len(signal_values) < 2:
        return 0.0
    return float(signal_values[-1] - signal_values[0])


def _calculate_skew(signal_values: np.ndarray) -> float:
    if len(signal_values) < 3:
        return 0.0
    centered = signal_values - np.mean(signal_values)
    std = float(np.std(signal_values))
    if std <= 1e-12:
        return 0.0
    normalized = centered / std
    return float(np.mean(np.power(normalized, 3)))


def _calculate_kurtosis(signal_values: np.ndarray) -> float:
    if len(signal_values) < 4:
        return 0.0
    centered = signal_values - np.mean(signal_values)
    std = float(np.std(signal_values))
    if std <= 1e-12:
        return 0.0
    normalized = centered / std
    return float(np.mean(np.power(normalized, 4)) - 3.0)


def _compute_signal_stats(ts_values: np.ndarray, signal_values: np.ndarray) -> Dict[str, float]:
    if len(signal_values) == 0:
        return {stat_name: 0.0 for stat_name in DEFAULT_WINDOW_STATS}

    signal_array = signal_values.astype(float)
    return {
        "mean": float(np.mean(signal_array)),
        "std": float(np.std(signal_array)),
        "min": float(np.min(signal_array)),
        "max": float(np.max(signal_array)),
        "range": float(np.max(signal_array) - np.min(signal_array)),
        "energy": float(np.mean(np.square(signal_array))),
        "slope": _calculate_slope(ts_values.astype(float), signal_array),
    }


def _compute_segment_stats(signal_values: np.ndarray) -> Dict[str, float]:
    if len(signal_values) == 0:
        return {stat_name: 0.0 for stat_name in DEFAULT_SEGMENT_STATS}

    signal_array = signal_values.astype(float)
    return {
        "mean": float(np.mean(signal_array)),
        "std": float(np.std(signal_array)),
        "max": float(np.max(signal_array)),
        "skew": _calculate_skew(signal_array),
        "kurtosis": _calculate_kurtosis(signal_array),
    }


def _safe_corrcoef(left_values: np.ndarray, right_values: np.ndarray) -> float:
    if len(left_values) < 2 or len(right_values) < 2:
        return 0.0
    left_std = float(np.std(left_values))
    right_std = float(np.std(right_values))
    if left_std <= 1e-12 or right_std <= 1e-12:
        return 0.0
    correlation = float(np.corrcoef(left_values, right_values)[0, 1])
    if np.isnan(correlation):
        return 0.0
    return correlation


def _compute_fft_features(signal_values: np.ndarray) -> Dict[str, float]:
    if len(signal_values) < 2:
        return {stat_name: 0.0 for stat_name in DEFAULT_FREQUENCY_STATS}

    centered = signal_values.astype(float) - float(np.mean(signal_values))
    spectrum = np.fft.rfft(centered)
    power = np.square(np.abs(spectrum))
    if len(power) <= 1:
        return {stat_name: 0.0 for stat_name in DEFAULT_FREQUENCY_STATS}

    positive_power = power[1:]
    if positive_power.size == 0:
        return {stat_name: 0.0 for stat_name in DEFAULT_FREQUENCY_STATS}

    sorted_peaks = np.sort(positive_power)[::-1]
    peak_values = [float(sorted_peaks[index]) if index < len(sorted_peaks) else 0.0 for index in range(DEFAULT_FFT_TOP_K)]

    total_power = float(np.sum(positive_power))
    if total_power <= 1e-12:
        spectral_entropy = 0.0
    else:
        probabilities = positive_power / total_power
        valid_probabilities = probabilities[probabilities > 1e-12]
        if valid_probabilities.size == 0:
            spectral_entropy = 0.0
        else:
            entropy = -float(np.sum(valid_probabilities * np.log(valid_probabilities)))
            spectral_entropy = float(entropy / np.log(valid_probabilities.size)) if valid_probabilities.size > 1 else 0.0

    return {
        "peak1_energy": peak_values[0],
        "peak2_energy": peak_values[1],
        "peak3_energy": peak_values[2],
        "spectral_entropy": spectral_entropy,
    }


def _build_feature_names(
    node_order: Sequence[str],
    channels: Sequence[str],
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
) -> List[str]:
    feature_names: List[str] = []
    for window_name in WINDOW_NAMES:
        for node in node_order:
            for channel in channels:
                for stat_name in DEFAULT_WINDOW_STATS:
                    feature_names.append(f"{window_name}_{node}_{channel}_{stat_name}")
            if enable_missing_flags:
                feature_names.append(f"{window_name}_{node}_missing_flag")
    for node in node_order:
        for channel in channels:
            for stat_name in DEFAULT_SEGMENT_STATS:
                feature_names.append(f"segment_{node}_{channel}_{stat_name}")
    # Temporarily disabled: correlation feature names.
    # for left_node, right_node in DEFAULT_CORRELATION_NODE_PAIRS:
    #     for channel in DEFAULT_CORRELATION_CHANNELS:
    #         feature_names.append(f"segment_corr_{left_node}_{right_node}_{channel}")
    # Temporarily disabled: FFT feature names.
    # for node in node_order:
    #     for channel in DEFAULT_FREQUENCY_CHANNELS:
    #         for stat_name in DEFAULT_FREQUENCY_STATS:
    #             feature_names.append(f"segment_fft_{node}_{channel}_{stat_name}")
    return feature_names


def build_feature_spec(
    node_order: Sequence[str],
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
) -> Dict[str, Any]:
    """Describe the current feature layout from the active extraction logic."""
    feature_names = _build_feature_names(
        node_order=node_order,
        channels=channels,
        enable_missing_flags=enable_missing_flags,
    )
    window_stats_dim = len(WINDOW_NAMES) * len(node_order) * len(channels) * len(DEFAULT_WINDOW_STATS)
    missing_flag_dim = len(WINDOW_NAMES) * len(node_order) if enable_missing_flags else 0
    segment_stats_dim = len(node_order) * len(channels) * len(DEFAULT_SEGMENT_STATS)
    correlation_dim = 0
    frequency_dim = 0
    total_feature_dim = window_stats_dim + missing_flag_dim + segment_stats_dim + correlation_dim + frequency_dim
    best_config = get_best_feature_config()
    return {
        "feature_names": feature_names,
        "feature_dim": len(feature_names),
        "feature_groups": list(best_config["feature_groups"]),
        "stats_per_channel": list(DEFAULT_WINDOW_STATS),
        "segment_stats_per_channel": list(DEFAULT_SEGMENT_STATS),
        "frequency_channels": [],
        "frequency_stats": [],
        "windows_used": list(WINDOW_NAMES),
        "missing_flags_per_window": int(len(node_order)) if enable_missing_flags else 0,
        "correlation_pairs": [],
        "correlation_channels": [],
        "expected_feature_dim_breakdown": {
            "window_stats_dim": int(window_stats_dim),
            "missing_flag_dim": int(missing_flag_dim),
            "segment_stats_dim": int(segment_stats_dim),
            "correlation_dim": int(correlation_dim),
            "frequency_dim": int(frequency_dim),
            "total_feature_dim": int(total_feature_dim),
        },
        "feature_name_count": int(len(feature_names)),
    }


def _extract_window_features(
    segment: ActionSegment,
    window_frame: pd.DataFrame,
    window_name: str,
    channels: Sequence[str],
    min_samples_per_node: int,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
) -> Optional[Tuple[List[float], int, List[str]]]:
    if window_frame.empty:
        warnings.warn(
            f"Segment {segment.segment_id} {window_name} window is empty and will be skipped.",
            stacklevel=2,
        )
        return None

    feature_values: List[float] = []
    valid_nodes = 0
    missing_nodes: List[str] = []
    for node in segment.node_order:
        node_frame = window_frame.loc[window_frame["node"] == node].copy()
        if len(node_frame) < min_samples_per_node:
            missing_nodes.append(node)
            for _ in channels:
                feature_values.extend(float(missing_fill_value) for _ in DEFAULT_WINDOW_STATS)
            if enable_missing_flags:
                feature_values.append(1.0)
            continue

        valid_nodes += 1
        ts_values = node_frame["ts"].to_numpy(dtype=float)
        _warn_if_ts_discontinuous(ts_values, segment.segment_id, window_name)

        for channel in channels:
            signal_values = node_frame[channel].to_numpy(dtype=float)
            stats = _compute_signal_stats(ts_values, signal_values)
            feature_values.extend(stats[stat_name] for stat_name in DEFAULT_WINDOW_STATS)
        if enable_missing_flags:
            feature_values.append(0.0)

    if valid_nodes < min_valid_nodes_per_window:
        warnings.warn(
            (
                f"Segment {segment.segment_id} {window_name} window has only {valid_nodes} valid nodes "
                f"(< {min_valid_nodes_per_window}) and will be skipped."
            ),
            stacklevel=2,
        )
        return None

    return feature_values, valid_nodes, missing_nodes


def _extract_segment_level_features(
    segment: ActionSegment,
    segment_frame: pd.DataFrame,
    channels: Sequence[str],
    min_samples_per_node: int,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
) -> Tuple[List[float], int, List[str]]:
    feature_values: List[float] = []
    valid_nodes = 0
    missing_nodes: List[str] = []

    for node in segment.node_order:
        node_frame = segment_frame.loc[segment_frame["node"] == node].copy()
        if len(node_frame) < min_samples_per_node:
            missing_nodes.append(node)
            for _ in channels:
                feature_values.extend(float(missing_fill_value) for _ in DEFAULT_SEGMENT_STATS)
            continue

        valid_nodes += 1
        for channel in channels:
            signal_values = node_frame[channel].to_numpy(dtype=float)
            stats = _compute_segment_stats(signal_values)
            feature_values.extend(stats[stat_name] for stat_name in DEFAULT_SEGMENT_STATS)

    return feature_values, valid_nodes, missing_nodes


def _extract_correlation_features(
    segment_frame: pd.DataFrame,
    min_samples_per_node: int,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
) -> List[float]:
    feature_values: List[float] = []
    for left_node, right_node in DEFAULT_CORRELATION_NODE_PAIRS:
        left_frame = segment_frame.loc[segment_frame["node"] == left_node].copy()
        right_frame = segment_frame.loc[segment_frame["node"] == right_node].copy()
        if len(left_frame) < min_samples_per_node or len(right_frame) < min_samples_per_node:
            feature_values.extend(float(missing_fill_value) for _ in DEFAULT_CORRELATION_CHANNELS)
            continue

        merged = left_frame[["ts", *DEFAULT_CORRELATION_CHANNELS]].merge(
            right_frame[["ts", *DEFAULT_CORRELATION_CHANNELS]],
            on="ts",
            how="inner",
            suffixes=("_left", "_right"),
        )
        if len(merged) < min_samples_per_node:
            feature_values.extend(float(missing_fill_value) for _ in DEFAULT_CORRELATION_CHANNELS)
            continue

        for channel in DEFAULT_CORRELATION_CHANNELS:
            left_values = merged[f"{channel}_left"].to_numpy(dtype=float)
            right_values = merged[f"{channel}_right"].to_numpy(dtype=float)
            feature_values.append(_safe_corrcoef(left_values, right_values))

    return feature_values


def _extract_frequency_features(
    segment: ActionSegment,
    segment_frame: pd.DataFrame,
    min_samples_per_node: int,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
) -> List[float]:
    feature_values: List[float] = []
    for node in segment.node_order:
        node_frame = segment_frame.loc[segment_frame["node"] == node].copy()
        if len(node_frame) < min_samples_per_node:
            feature_values.extend(float(missing_fill_value) for _ in range(len(DEFAULT_FREQUENCY_CHANNELS) * len(DEFAULT_FREQUENCY_STATS)))
            continue

        for channel in DEFAULT_FREQUENCY_CHANNELS:
            signal_values = node_frame[channel].to_numpy(dtype=float)
            fft_stats = _compute_fft_features(signal_values)
            feature_values.extend(fft_stats[stat_name] for stat_name in DEFAULT_FREQUENCY_STATS)
    return feature_values


def segment_to_feature_vector(
    segment: ActionSegment,
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
) -> Optional[Tuple[np.ndarray, Dict[str, Any]]]:
    """Convert one full action segment into a fixed-length feature vector."""
    if segment.end_ts <= segment.start_ts:
        warnings.warn(
            f"Segment {segment.segment_id} has invalid duration and will be skipped.",
            stacklevel=2,
        )
        return None

    start_window, end_window, sample_rate_hz = extract_segment_windows(
        segment,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
    )
    segment_frame = segment.sensor_frame.copy()
    if "acc_mag" not in segment_frame.columns and not segment_frame.empty:
        segment_frame["acc_mag"] = _compute_acc_magnitude(segment_frame)

    start_features = _extract_window_features(
        segment=segment,
        window_frame=start_window,
        window_name="start",
        channels=channels,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
    if start_features is None:
        return None

    end_features = _extract_window_features(
        segment=segment,
        window_frame=end_window,
        window_name="end",
        channels=channels,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
    if end_features is None:
        return None

    start_feature_values, start_valid_nodes, start_missing_nodes = start_features
    end_feature_values, end_valid_nodes, end_missing_nodes = end_features
    segment_feature_values, segment_valid_nodes, segment_missing_nodes = _extract_segment_level_features(
        segment=segment,
        segment_frame=segment_frame,
        channels=channels,
        min_samples_per_node=min_samples_per_node,
        missing_fill_value=missing_fill_value,
    )
    feature_values = (
        start_feature_values
        + end_feature_values
        + segment_feature_values
    )
    feature_spec = build_feature_spec(
        node_order=segment.node_order,
        channels=channels,
        enable_missing_flags=enable_missing_flags,
    )
    metadata = {
        **segment.metadata,
        "sample_rate_hz": sample_rate_hz,
        "start_window_num_rows": int(len(start_window)),
        "end_window_num_rows": int(len(end_window)),
        "start_window_seconds": float(start_window_seconds),
        "end_window_seconds": float(end_window_seconds),
        "feature_dim": len(feature_values),
        "feature_names": list(feature_spec["feature_names"]),
        "feature_groups": list(feature_spec["feature_groups"]),
        "channels": list(channels),
        "window_stats": list(DEFAULT_WINDOW_STATS),
        "segment_stats": list(DEFAULT_SEGMENT_STATS),
        "correlation_pairs": [],
        "correlation_channels": [],
        "frequency_channels": [],
        "frequency_stats": [],
        "node_order": list(segment.node_order),
        "enable_missing_flags": bool(enable_missing_flags),
        "missing_fill_value": float(missing_fill_value),
        "min_valid_nodes_per_window": int(min_valid_nodes_per_window),
        "start_valid_nodes": int(start_valid_nodes),
        "end_valid_nodes": int(end_valid_nodes),
        "segment_valid_nodes": int(segment_valid_nodes),
        "start_missing_nodes": list(start_missing_nodes),
        "end_missing_nodes": list(end_missing_nodes),
        "segment_missing_nodes": list(segment_missing_nodes),
    }
    return np.asarray(feature_values, dtype=float), metadata


def build_feature_dataset(
    segments: Sequence[ActionSegment],
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray], List[Dict[str, Any]]]:
    """Build a fixed-size feature dataset from normalized segments."""
    feature_rows: List[np.ndarray] = []
    y_action: List[int] = []
    y_standard: List[Optional[int]] = []
    metadata_rows: List[Dict[str, Any]] = []

    for segment in segments:
        result = segment_to_feature_vector(
            segment=segment,
            channels=channels,
            start_window_seconds=start_window_seconds,
            end_window_seconds=end_window_seconds,
            min_samples_per_node=min_samples_per_node,
            enable_missing_flags=enable_missing_flags,
            missing_fill_value=missing_fill_value,
            min_valid_nodes_per_window=min_valid_nodes_per_window,
        )
        if result is None:
            continue

        feature_vector, metadata = result
        feature_rows.append(feature_vector)
        y_action.append(segment.action_label_id)
        y_standard.append(segment.standard_label_id)
        metadata_rows.append(metadata)

    if not feature_rows:
        empty_y_standard: Optional[np.ndarray] = None
        if any(segment.standard_label_id is not None for segment in segments):
            empty_y_standard = np.empty((0,), dtype=object)
        return (
            np.empty((0, 0), dtype=float),
            np.empty((0,), dtype=int),
            empty_y_standard,
            metadata_rows,
        )

    X = np.vstack(feature_rows)
    y_action_array = np.asarray(y_action, dtype=int)

    if any(label is not None for label in y_standard):
        y_standard_array: Optional[np.ndarray] = np.asarray(y_standard, dtype=object)
    else:
        y_standard_array = None

    feature_spec = build_feature_spec(
        node_order=segments[0].node_order,
        channels=channels,
        enable_missing_flags=enable_missing_flags,
    )
    feature_names = feature_spec["feature_names"]
    for metadata in metadata_rows:
        metadata["feature_names"] = feature_names

    return X, y_action_array, y_standard_array, metadata_rows


def load_feature_dataset(
    sensor_csv_path: str | Path,
    labels_csv_path: str | Path,
    node_order: Optional[Sequence[str]] = None,
    channels: Sequence[str] = DEFAULT_FEATURE_CHANNELS,
    start_window_seconds: float = DEFAULT_WINDOW_START_SECONDS,
    end_window_seconds: float = DEFAULT_WINDOW_END_SECONDS,
    min_rows_per_segment: int = 2,
    min_samples_per_node: int = 2,
    enable_missing_flags: bool = DEFAULT_ENABLE_MISSING_NODE_FLAGS,
    missing_fill_value: float = DEFAULT_MISSING_NODE_FILL_VALUE,
    min_valid_nodes_per_window: int = DEFAULT_MIN_VALID_NODES_PER_WINDOW,
) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray], List[Dict[str, Any]]]:
    """Read CSVs, normalize action segments, and return RF-ready feature arrays."""
    segments = load_action_segments(
        sensor_csv_path=sensor_csv_path,
        labels_csv_path=labels_csv_path,
        node_order=node_order,
        min_rows_per_segment=min_rows_per_segment,
    )
    return build_feature_dataset(
        segments=segments,
        channels=channels,
        start_window_seconds=start_window_seconds,
        end_window_seconds=end_window_seconds,
        min_samples_per_node=min_samples_per_node,
        enable_missing_flags=enable_missing_flags,
        missing_fill_value=missing_fill_value,
        min_valid_nodes_per_window=min_valid_nodes_per_window,
    )
