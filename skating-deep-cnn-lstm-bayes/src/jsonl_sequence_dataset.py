"""JSONL sequence adapter for 9-node skating IMU samples."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset


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

BASELINE_NODE_ORDER = (
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

JSONL_TO_MODEL_NODE_MAPPING = {
    "head": "head",
    "left_elbow": "l_elbow",
    "right_elbow": "r_elbow",
    "left_wrist": "l_wrist",
    "right_wrist": "r_wrist",
    "left_knee": "l_knee",
    "right_knee": "r_knee",
    "left_foot": "l_skate",
    "right_foot": "r_skate",
}

RAW_IMU_CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")

# "attitude" 展开为 4 个通道: roll/pitch 各自的 sin 与 cos。
# 它与 acc_mag/gyro_mag 有本质区别 —— 后者只是单个传感器的模长，而 attitude
# 是**加速度计与陀螺仪互补融合**的产物(见 src/attitude.py)，提供了原始通道里
# 不存在的物理量: 相对重力的绝对倾角。
SUPPORTED_DERIVED_CHANNELS = ("acc_mag", "gyro_mag", "attitude")

_ATTITUDE_CHANNEL_COUNT = 4  # sin(roll), sin(pitch), cos(roll), cos(pitch)


@dataclass(frozen=True)
class SequenceConfig:
    sequence_length: int = 180
    node_order: Tuple[str, ...] = BASELINE_NODE_ORDER
    raw_channels: Tuple[str, ...] = RAW_IMU_CHANNELS
    derived_channels: Tuple[str, ...] = ()
    missing_fill_value: float = 0.0
    min_valid_nodes: int = 6

    # --- 去噪 (src/denoise.py) ---
    # 随 checkpoint 持久化，保证推理端复现训练时的预处理。若训练开了去噪而
    # 推理没开(或反之)，输入分布会漂移，模型表现会莫名下降且极难排查。
    #
    # denoise_spikes: 剔除野值尖刺。默认 False 以保持既有模型行为不变；
    #   新模型建议开启 —— 实测本项目野值率 0.7%，acc 峰值达 228g(物理不可能)，
    #   会严重污染 z-score 归一化以及质量模型的方差/jerk 特征。
    #   去噪必须在姿态解算**之前**，否则野值会被陀螺积分放大。
    denoise_spikes: bool = False
    # denoise_lowpass_hz: 低通截止频率(Hz)，None = 不做低通。
    #   实测本项目高频抖动仅占信号幅值 2%，低通收益极小，且有抹掉真实快速
    #   运动(蹬冰/落冰)的风险，故默认关闭。
    denoise_lowpass_hz: Optional[float] = None
    # 实际采样率，仅低通滤波需要。本项目实测中位数约 20Hz。
    sample_rate_hz: float = 20.0

    @property
    def channels(self) -> Tuple[str, ...]:
        """展开后的**逐节点**通道名。

        注意 ``attitude`` 并非单通道 —— 它展开成 4 个 (roll/pitch 的 sin,cos)。
        因此不能简单地把 derived_channels 拼接进来，否则 input_dim 会算错，
        导致模型输入维度与实际张量不符。
        """
        expanded: list[str] = list(self.raw_channels)
        for name in self.derived_channels:
            if name == "attitude":
                expanded += ["roll_sin", "pitch_sin", "roll_cos", "pitch_cos"]
            else:
                expanded.append(name)
        return tuple(expanded)

    @property
    def input_dim(self) -> int:
        return len(self.node_order) * len(self.channels)

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["node_order"] = list(self.node_order)
        payload["raw_channels"] = list(self.raw_channels)
        payload["derived_channels"] = list(self.derived_channels)
        payload["channels"] = list(self.channels)
        payload["input_dim"] = int(self.input_dim)
        return payload

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "SequenceConfig":
        lowpass = payload.get("denoise_lowpass_hz")
        return cls(
            sequence_length=int(payload.get("sequence_length", 180)),
            node_order=tuple(str(item) for item in payload.get("node_order", BASELINE_NODE_ORDER)),
            raw_channels=tuple(str(item) for item in payload.get("raw_channels", RAW_IMU_CHANNELS)),
            derived_channels=tuple(str(item) for item in payload.get("derived_channels", ())),
            missing_fill_value=float(payload.get("missing_fill_value", 0.0)),
            min_valid_nodes=int(payload.get("min_valid_nodes", 6)),
            denoise_spikes=bool(payload.get("denoise_spikes", False)),
            denoise_lowpass_hz=None if lowpass is None else float(lowpass),
            sample_rate_hz=float(payload.get("sample_rate_hz", 20.0)),
        )


def iter_jsonl_records(jsonl_path: str | Path) -> Iterable[Dict[str, Any]]:
    with open(jsonl_path, "r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            payload = json.loads(stripped)
            if not isinstance(payload, dict):
                raise ValueError(f"JSONL line {line_number} must decode to an object.")
            yield payload


def normalize_action_type(action_type: Any) -> Optional[str]:
    if not isinstance(action_type, str):
        return None
    normalized = action_type.strip()
    return normalized or None


def build_dynamic_action_label_mapping(action_types: Sequence[str]) -> Tuple[Dict[str, int], Dict[int, str]]:
    names = sorted(set(action_types))
    label_name_to_id = {name: index for index, name in enumerate(names)}
    label_id_to_name = {index: name for name, index in label_name_to_id.items()}
    return label_name_to_id, label_id_to_name


def _fill_nan_vector(values: np.ndarray, fill_value: float) -> np.ndarray:
    values = values.astype(np.float32, copy=True)
    valid = np.isfinite(values)
    if not np.any(valid):
        return np.full_like(values, fill_value, dtype=np.float32)
    indices = np.arange(len(values), dtype=np.float32)
    return np.interp(indices, indices[valid], values[valid]).astype(np.float32)


def _resample_sequence(sequence: np.ndarray, target_length: int) -> np.ndarray:
    if sequence.shape[0] == target_length:
        return sequence.astype(np.float32, copy=False)
    if sequence.shape[0] == 1:
        return np.repeat(sequence, target_length, axis=0).astype(np.float32)

    source_x = np.linspace(0.0, 1.0, num=sequence.shape[0], dtype=np.float32)
    target_x = np.linspace(0.0, 1.0, num=target_length, dtype=np.float32)
    flat = sequence.reshape(sequence.shape[0], -1)
    resampled = np.empty((target_length, flat.shape[1]), dtype=np.float32)
    for column_index in range(flat.shape[1]):
        resampled[:, column_index] = np.interp(target_x, source_x, flat[:, column_index])
    return resampled.reshape(target_length, *sequence.shape[1:]).astype(np.float32)


def _append_derived_channels(
    sequence: np.ndarray,
    derived_channels: Sequence[str],
    timestamps: Optional[np.ndarray] = None,
) -> np.ndarray:
    """在原始 6 通道之后追加派生通道。

    Args:
        sequence: [T, N, 6] 原始 IMU。
        timestamps: [T] 每帧真实时间戳(秒)。仅 ``attitude`` 需要 —— 姿态解算
            靠陀螺仪积分，必须用真实 dt。本项目采样抖动大(78.8% 的样本
            变异系数 >0.3)，用固定 dt 会让多数样本积分失真。

    重要: 本函数必须在**重采样之前**调用。重采样会把序列插值到固定长度，
    真实的帧间时间间隔随之失去意义，届时再解算姿态就是错的。
    """
    if not derived_channels:
        return sequence

    pieces = [sequence]
    for channel in derived_channels:
        if channel == "acc_mag":
            pieces.append(np.linalg.norm(sequence[:, :, 0:3], axis=2, keepdims=True))
        elif channel == "gyro_mag":
            pieces.append(np.linalg.norm(sequence[:, :, 3:6], axis=2, keepdims=True))
        elif channel == "attitude":
            if timestamps is None:
                raise ValueError("derived channel 'attitude' requires timestamps")
            from src.attitude import attitude_to_channels, solve_attitude_sequence

            euler = solve_attitude_sequence(sequence, timestamps)
            # 丢弃 yaw: 6 轴 IMU 无磁力计，yaw 由纯陀螺积分而来，必然漂移。
            pieces.append(attitude_to_channels(euler, drop_yaw=True))
        else:
            raise ValueError(f"Unsupported derived channel: {channel}")
    return np.concatenate(pieces, axis=2).astype(np.float32)


def convert_record_to_sequence(
    record: Dict[str, Any],
    config: SequenceConfig,
    label_name_to_id: Optional[Dict[str, int]] = None,
    require_action_type: bool = True,
) -> Tuple[Optional[np.ndarray], Optional[int], Dict[str, Any]]:
    action_type = normalize_action_type(record.get("actionType"))
    if require_action_type and action_type is None:
        return None, None, {"ok": False, "reason": "invalid_action_type"}

    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return None, None, {"ok": False, "reason": "empty_frames", "action_type": action_type}

    sorted_frames = sorted(
        [frame for frame in frames if isinstance(frame, dict)],
        key=lambda item: float(item.get("t", 0.0)),
    )
    if not sorted_frames:
        return None, None, {"ok": False, "reason": "empty_frames", "action_type": action_type}

    node_to_index = {node: index for index, node in enumerate(config.node_order)}
    raw_sequence = np.full(
        (len(sorted_frames), len(config.node_order), len(RAW_IMU_CHANNELS)),
        np.nan,
        dtype=np.float32,
    )
    valid_node_frames = np.zeros((len(sorted_frames), len(config.node_order)), dtype=bool)
    timestamps: List[float] = []
    invalid_node_value_length = False

    for frame_index, frame in enumerate(sorted_frames):
        try:
            timestamps.append(float(frame.get("t")) / 1000.0)
        except (TypeError, ValueError):
            timestamps.append(float(frame_index))

        node_payload = frame.get("p")
        if not isinstance(node_payload, dict):
            continue

        for raw_node_name, raw_values in node_payload.items():
            mapped_node = JSONL_TO_MODEL_NODE_MAPPING.get(str(raw_node_name))
            if mapped_node not in node_to_index:
                continue
            if not isinstance(raw_values, list) or len(raw_values) != len(RAW_IMU_CHANNELS):
                invalid_node_value_length = True
                continue
            node_index = node_to_index[mapped_node]
            raw_sequence[frame_index, node_index, :] = np.asarray(raw_values, dtype=np.float32)
            valid_node_frames[frame_index, node_index] = True

    if invalid_node_value_length:
        return None, None, {"ok": False, "reason": "invalid_node_value_length", "action_type": action_type}

    valid_nodes = np.sum(np.any(valid_node_frames, axis=0))
    if int(valid_nodes) < config.min_valid_nodes:
        return None, None, {
            "ok": False,
            "reason": "incomplete_nodes",
            "action_type": action_type,
            "valid_nodes": int(valid_nodes),
        }

    for node_index in range(raw_sequence.shape[1]):
        for channel_index in range(raw_sequence.shape[2]):
            raw_sequence[:, node_index, channel_index] = _fill_nan_vector(
                raw_sequence[:, node_index, channel_index],
                fill_value=config.missing_fill_value,
            )

    # 去噪必须在 NaN 填充**之后**(否则中位数被 NaN 污染)、姿态解算**之前**
    # (否则 228g 量级的野值会被陀螺积分放大，姿态瞬间发散)。
    outliers_replaced = 0
    if config.denoise_spikes or config.denoise_lowpass_hz is not None:
        from src.denoise import denoise_sequence
        raw_sequence, denoise_stats = denoise_sequence(
            raw_sequence,
            sample_rate_hz=config.sample_rate_hz,
            remove_spikes=config.denoise_spikes,
            lowpass_cutoff_hz=config.denoise_lowpass_hz,
        )
        outliers_replaced = denoise_stats["outliers_replaced"]

    # 派生通道必须在重采样**之前**计算: 姿态解算依赖真实帧间隔 dt，
    # 而重采样会把序列插值到固定长度，真实时间间隔随之失效。
    timestamps_for_attitude = np.asarray(timestamps, dtype=np.float64)
    sequence = _append_derived_channels(
        raw_sequence, config.derived_channels, timestamps=timestamps_for_attitude,
    )
    sequence = _resample_sequence(sequence, config.sequence_length)
    sequence = sequence.reshape(config.sequence_length, config.input_dim).astype(np.float32)

    label_id: Optional[int] = None
    if action_type is not None and label_name_to_id is not None:
        if action_type not in label_name_to_id:
            return None, None, {"ok": False, "reason": "unknown_action_type", "action_type": action_type}
        label_id = int(label_name_to_id[action_type])

    timestamps_array = np.asarray(timestamps, dtype=np.float32)
    metadata = {
        "ok": True,
        "reason": None,
        "action_type": action_type,
        "jsonl_id": str(record.get("_id", "")),
        "session_id": str(record.get("sessionId", "")),
        "frame_count_raw": int(record.get("frameCount", len(sorted_frames))),
        "duration_seconds": float(np.max(timestamps_array) - np.min(timestamps_array)) if len(timestamps_array) > 1 else 0.0,
        "valid_nodes": int(valid_nodes),
        "missing_node_ratio": float(1.0 - np.mean(valid_node_frames)),
        # 被替换的野值点数。生产环境可据此监控传感器健康度 —— 该值突然升高
        # 通常意味着某个节点的传感器或链路出了问题。
        "outliers_replaced": int(outliers_replaced),
        "input_dim": int(config.input_dim),
        "sequence_length": int(config.sequence_length),
    }
    return sequence, label_id, metadata


def fit_normalization(sequences: np.ndarray) -> Dict[str, Any]:
    mean = np.mean(sequences, axis=(0, 1))
    std = np.std(sequences, axis=(0, 1))
    std = np.where(std < 1e-6, 1.0, std)
    return {"mean": mean.astype(float).tolist(), "std": std.astype(float).tolist()}


def apply_normalization(sequences: np.ndarray, normalization: Dict[str, Any]) -> np.ndarray:
    mean = np.asarray(normalization["mean"], dtype=np.float32)
    std = np.asarray(normalization["std"], dtype=np.float32)
    return ((sequences.astype(np.float32) - mean) / std).astype(np.float32)


def load_sequence_dataset_from_jsonl(
    jsonl_path: str | Path,
    config: SequenceConfig,
    label_name_to_id: Optional[Dict[str, int]] = None,
) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]], Dict[str, int], Dict[int, str], Dict[str, Any]]:
    records = list(iter_jsonl_records(jsonl_path))
    if label_name_to_id is None:
        action_types = [
            action_type
            for action_type in (normalize_action_type(record.get("actionType")) for record in records)
            if action_type is not None
        ]
        label_name_to_id, label_id_to_name = build_dynamic_action_label_mapping(action_types)
    else:
        label_id_to_name = {label_id: label_name for label_name, label_id in label_name_to_id.items()}

    sequences: List[np.ndarray] = []
    labels: List[int] = []
    metadata_rows: List[Dict[str, Any]] = []
    error_counts: Dict[str, int] = {}

    for record_index, record in enumerate(records):
        sequence, label_id, metadata = convert_record_to_sequence(
            record=record,
            config=config,
            label_name_to_id=label_name_to_id,
            require_action_type=True,
        )
        if sequence is None or label_id is None:
            reason = str(metadata.get("reason", "unknown"))
            error_counts[reason] = error_counts.get(reason, 0) + 1
            continue
        metadata["sample_index"] = int(record_index)
        sequences.append(sequence)
        labels.append(int(label_id))
        metadata_rows.append(metadata)

    if not sequences:
        raise ValueError("No valid JSONL samples could be converted to sequence tensors.")

    stats = {
        "total_records": int(len(records)),
        "converted_samples": int(len(sequences)),
        "skipped_samples": int(len(records) - len(sequences)),
        "error_counts": error_counts,
        "label_mapping": {name: int(label_id) for name, label_id in label_name_to_id.items()},
    }
    return (
        np.stack(sequences).astype(np.float32),
        np.asarray(labels, dtype=np.int64),
        metadata_rows,
        label_name_to_id,
        label_id_to_name,
        stats,
    )


class SequenceTensorDataset(Dataset):
    def __init__(self, sequences: np.ndarray, labels: Optional[np.ndarray] = None) -> None:
        self.sequences = torch.as_tensor(sequences, dtype=torch.float32)
        self.labels = None if labels is None else torch.as_tensor(labels, dtype=torch.long)

    def __len__(self) -> int:
        return int(self.sequences.shape[0])

    def __getitem__(self, index: int) -> Any:
        if self.labels is None:
            return self.sequences[index]
        return self.sequences[index], self.labels[index]


def write_json(path: str | Path, payload: Dict[str, Any]) -> Path:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return output_path
