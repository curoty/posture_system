"""JSONL sequence adapter for multi-node skating IMU samples.

支持两种节点预设 (NodePreset):
  - full_body_9: 全身 9 节点 (向后兼容)
  - lower_body_5: 下肢 5 节点 (当前固件, waist+2膝+2踝)

SequenceConfig 通过 node_preset_name 自动选择节点配置,
无需在代码中硬编码 9 或 5。

旧 checkpoint (无 node_preset_name 字段) 默认按 full_body_9 解析。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset


# ---------------------------------------------------------------------------
# Node presets
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodePreset:
    """节点预设: 定义 JSONL 键名到模型内部节点名的映射。"""
    name: str
    jsonl_keys: Tuple[str, ...]          # 数据存档/云函数侧的键名
    model_node_order: Tuple[str, ...]    # 模型内部节点名（决定张量通道顺序）
    jsonl_to_model: Dict[str, str]       # jsonl_keys → model_node_order 映射
    min_valid_ratio: float = 0.8         # 最少有效节点比例

    @property
    def num_nodes(self) -> int:
        return len(self.model_node_order)

    @property
    def min_valid_nodes(self) -> int:
        return max(1, int(self.num_nodes * self.min_valid_ratio))


NODE_PRESETS: Dict[str, NodePreset] = {
    "full_body_9": NodePreset(
        name="full_body_9",
        jsonl_keys=("head", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
                    "left_knee", "right_knee", "left_foot", "right_foot"),
        model_node_order=("head", "l_elbow", "l_knee", "l_skate", "l_wrist",
                          "r_elbow", "r_knee", "r_skate", "r_wrist"),
        jsonl_to_model={
            "head": "head", "left_elbow": "l_elbow", "right_elbow": "r_elbow",
            "left_wrist": "l_wrist", "right_wrist": "r_wrist",
            "left_knee": "l_knee", "right_knee": "r_knee",
            "left_foot": "l_skate", "right_foot": "r_skate",
        },
        min_valid_ratio=0.67,  # 9*0.67≈6, 等价旧 min_valid_nodes=6
    ),
    "lower_body_5": NodePreset(
        name="lower_body_5",
        jsonl_keys=("waist", "left_knee", "right_knee", "left_foot", "right_foot"),
        model_node_order=("waist", "l_knee", "r_knee", "l_skate", "r_skate"),
        jsonl_to_model={
            "waist": "waist",
            "left_knee": "l_knee", "right_knee": "r_knee",
            "left_foot": "l_skate", "right_foot": "r_skate",
        },
        min_valid_ratio=0.8,  # 5*0.8=4, 允许丢 1 个节点
    ),
}

# 向后兼容: 保留模块级常量, 作为 full_body_9 预设的来源
BASELINE_NODE_ORDER: Tuple[str, ...] = NODE_PRESETS["full_body_9"].model_node_order
JSONL_TO_MODEL_NODE_MAPPING: Dict[str, str] = NODE_PRESETS["full_body_9"].jsonl_to_model

RAW_IMU_CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")

# "attitude" 展开为 4 个通道: roll/pitch 各自的 sin 与 cos。
# 它与 acc_mag/gyro_mag 有本质区别 —— 后者只是单个传感器的模长，而 attitude
# 是**加速度计与陀螺仪互补融合**的产物(见 src/attitude.py)，提供了原始通道里
# 不存在的物理量: 相对重力的绝对倾角。
SUPPORTED_DERIVED_CHANNELS = ("acc_mag", "gyro_mag", "attitude")

_ATTITUDE_CHANNEL_COUNT = 4  # sin(roll), sin(pitch), cos(roll), cos(pitch)


@dataclass(frozen=True)
class SequenceConfig:
    """序列配置: 节点预设驱动, 向后兼容 9 节点旧 checkpoint。"""
    sequence_length: int = 350                     # 新数据 7s @ 50fps = 350 帧
    node_preset_name: str = "full_body_9"           # 新增: 预设名, 旧 ckpt 缺省 = full_body_9
    node_order: Tuple[str, ...] = ()                # 空 = 从预设派生; 非空 = 显式覆盖(旧 ckpt)
    raw_channels: Tuple[str, ...] = RAW_IMU_CHANNELS
    derived_channels: Tuple[str, ...] = ()
    missing_fill_value: float = 0.0
    min_valid_nodes: int = 0                        # 0 = 从预设的 min_valid_ratio 派生

    # --- 去噪 (src/denoise.py) ---
    denoise_spikes: bool = False
    denoise_lowpass_hz: Optional[float] = None
    sample_rate_hz: float = 50.0                    # 新数据 50fps

    # ------------------------------------------------------------------ #
    # 后方便:
    # node_order / min_valid_nodes / jsonl_to_model_node_mapping
    # 全部从 node_preset_name 和 NodePreset 派生，不再硬编码 9 或 5。
    # 但 node_order 和 min_valid_nodes 仍作为字段保留(向后兼容)；
    # 当它们为空/零时自动从预设派生。
    # ------------------------------------------------------------------ #

    @property
    def node_preset(self) -> "NodePreset":
        return NODE_PRESETS.get(self.node_preset_name, NODE_PRESETS["full_body_9"])

    @property
    def resolved_node_order(self) -> Tuple[str, ...]:
        if self.node_order:
            return self.node_order
        return self.node_preset.model_node_order

    @property
    def resolved_min_valid_nodes(self) -> int:
        if self.min_valid_nodes > 0:
            return self.min_valid_nodes
        return self.node_preset.min_valid_nodes

    @property
    def jsonl_to_model_node_mapping(self) -> Dict[str, str]:
        return self.node_preset.jsonl_to_model

    @property
    def channels(self) -> Tuple[str, ...]:
        """展开后的**逐节点**通道名。"""
        expanded: list[str] = list(self.raw_channels)
        for name in self.derived_channels:
            if name == "attitude":
                expanded += ["roll_sin", "pitch_sin", "roll_cos", "pitch_cos"]
            else:
                expanded.append(name)
        return tuple(expanded)

    @property
    def input_dim(self) -> int:
        return len(self.resolved_node_order) * len(self.channels)

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["node_order"] = list(self.resolved_node_order)
        payload["raw_channels"] = list(self.raw_channels)
        payload["derived_channels"] = list(self.derived_channels)
        payload["channels"] = list(self.channels)
        payload["input_dim"] = int(self.input_dim)
        payload["node_preset_name"] = str(self.node_preset_name)
        return payload

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "SequenceConfig":
        lowpass = payload.get("denoise_lowpass_hz")

        # 旧 checkpoint (无 node_preset_name) -> 用 node_order 直接; 新 checkpoint 从预设派生
        if "node_preset_name" in payload:
            node_preset_name = str(payload["node_preset_name"])
            preset = NODE_PRESETS.get(node_preset_name, NODE_PRESETS["full_body_9"])
            node_order = tuple(str(item) for item in payload.get("node_order", preset.model_node_order))
            min_valid_nodes = int(payload.get("min_valid_nodes", preset.min_valid_nodes))
        else:
            node_preset_name = "full_body_9"
            node_order = tuple(str(item) for item in payload.get("node_order", BASELINE_NODE_ORDER))
            min_valid_nodes = int(payload.get("min_valid_nodes", 6))

        return cls(
            sequence_length=int(payload.get("sequence_length", 350)),
            node_preset_name=node_preset_name,
            node_order=node_order,
            raw_channels=tuple(str(item) for item in payload.get("raw_channels", RAW_IMU_CHANNELS)),
            derived_channels=tuple(str(item) for item in payload.get("derived_channels", ())),
            missing_fill_value=float(payload.get("missing_fill_value", 0.0)),
            min_valid_nodes=min_valid_nodes,
            denoise_spikes=bool(payload.get("denoise_spikes", False)),
            denoise_lowpass_hz=None if lowpass is None else float(lowpass),
            sample_rate_hz=float(payload.get("sample_rate_hz", 50.0)),
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

    resolved_node_order = config.resolved_node_order
    node_to_index = {node: index for index, node in enumerate(resolved_node_order)}
    raw_sequence = np.full(
        (len(sorted_frames), len(resolved_node_order), len(RAW_IMU_CHANNELS)),
        np.nan,
        dtype=np.float32,
    )
    valid_node_frames = np.zeros((len(sorted_frames), len(resolved_node_order)), dtype=bool)
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
            mapped_node = config.jsonl_to_model_node_mapping.get(str(raw_node_name))
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
    if int(valid_nodes) < config.resolved_min_valid_nodes:
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
