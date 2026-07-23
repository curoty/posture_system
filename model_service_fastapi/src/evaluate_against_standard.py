"""Evaluate action samples against standard templates."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from src.data_loader import EXPECTED_9NODE_ORDER
from src.jsonl_data_loader import (
    get_jsonl_node_mapping,
    iter_jsonl_records,
    jsonl_frames_to_sensor_frame,
    normalize_action_type,
)


INTERPOLATION_POINTS = 32
MIN_REQUIRED_NODES_FOR_EVAL = 6
MIN_OBSERVATIONS_PER_NODE = 2
TRAJECTORY_WEIGHT = 0.6
ANGLE_WEIGHT = 0.4

POSITION_CHANNELS = ("ax", "ay", "az")
TORSO_PRIORITY_NODES = ("head", "l_elbow", "r_elbow", "l_knee", "r_knee")
BODY_SCALE_PAIRS = (
    ("l_elbow", "r_elbow"),
    ("l_knee", "r_knee"),
    ("head", "l_knee"),
    ("head", "r_knee"),
)
ANGLE_TRIPLETS = (
    ("head", "l_elbow", "l_wrist", "left_arm_angle"),
    ("head", "r_elbow", "r_wrist", "right_arm_angle"),
    ("head", "l_knee", "l_skate", "left_leg_angle"),
    ("head", "r_knee", "r_skate", "right_leg_angle"),
)


def load_json_or_jsonl_records(data_path: str | Path) -> List[Dict[str, Any]]:
    """Load either standard JSON or JSONL records."""
    path = Path(data_path)
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return list(iter_jsonl_records(path))

    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = [payload]
    else:
        raise ValueError(f"Unsupported JSON top-level type: {type(payload).__name__}")

    if not all(isinstance(record, dict) for record in records):
        raise ValueError("JSON dataset records must all be objects.")
    return records


def classify_similarity_level(score: float) -> str:
    """Convert similarity score into the required Chinese grade."""
    if score >= 90.0:
        return "非常好"
    if score >= 80.0:
        return "好"
    if score >= 60.0:
        return "中等"
    return "不合格"


def _interpolate_signal(ts_values: np.ndarray, signal_values: np.ndarray, target_grid: np.ndarray) -> np.ndarray:
    """Interpolate one 1D signal onto the shared normalized timeline."""
    if len(ts_values) < MIN_OBSERVATIONS_PER_NODE:
        raise ValueError("Not enough observations to interpolate one signal.")

    start_ts = float(np.min(ts_values))
    end_ts = float(np.max(ts_values))
    if end_ts <= start_ts:
        raise ValueError("Invalid time range for interpolation.")

    normalized_ts = (ts_values - start_ts) / (end_ts - start_ts)
    return np.interp(target_grid, normalized_ts, signal_values.astype(float))


def _frame_center(frame_positions: Dict[str, np.ndarray]) -> np.ndarray:
    """Choose a torso-centered origin from available pseudo-joint vectors."""
    torso_vectors = [frame_positions[node_name] for node_name in TORSO_PRIORITY_NODES if node_name in frame_positions]
    if torso_vectors:
        return np.mean(np.stack(torso_vectors), axis=0)
    return np.mean(np.stack(list(frame_positions.values())), axis=0)


def _estimate_body_scale(frame_positions: Dict[str, np.ndarray]) -> float:
    """Estimate a robust body scale from proxy joint spread."""
    distances: List[float] = []
    for left_node, right_node in BODY_SCALE_PAIRS:
        if left_node in frame_positions and right_node in frame_positions:
            distance = float(np.linalg.norm(frame_positions[left_node] - frame_positions[right_node]))
            if distance > 1e-6:
                distances.append(distance)

    if not distances:
        centered = np.stack(list(frame_positions.values()))
        distances = [float(np.linalg.norm(vector)) for vector in centered if np.linalg.norm(vector) > 1e-6]

    if not distances:
        return 1.0
    return max(float(np.mean(distances)), 1e-6)


def _compute_joint_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Compute one joint angle in radians from three proxy points."""
    ba = a - b
    bc = c - b
    norm_ba = float(np.linalg.norm(ba))
    norm_bc = float(np.linalg.norm(bc))
    if norm_ba <= 1e-6 or norm_bc <= 1e-6:
        return 0.0
    cosine_value = float(np.dot(ba, bc) / (norm_ba * norm_bc))
    cosine_value = max(-1.0, min(1.0, cosine_value))
    return float(np.arccos(cosine_value))


def _build_framewise_proxy_sequences(sensor_frame) -> Tuple[Optional[Dict[str, np.ndarray]], Optional[str]]:
    """Build normalized per-node trajectories and angle sequences from IMU proxy data."""
    if sensor_frame.empty:
        return None, "缺少可用传感器帧"

    target_grid = np.linspace(0.0, 1.0, INTERPOLATION_POINTS)
    per_node_signals: Dict[str, np.ndarray] = {}
    for node_name in EXPECTED_9NODE_ORDER:
        node_frame = sensor_frame.loc[sensor_frame["node"] == node_name].sort_values("ts")
        if len(node_frame) < MIN_OBSERVATIONS_PER_NODE:
            continue
        ts_values = node_frame["ts"].to_numpy(dtype=float)
        try:
            channels = [
                _interpolate_signal(ts_values, node_frame[channel_name].to_numpy(dtype=float), target_grid)
                for channel_name in POSITION_CHANNELS
            ]
        except ValueError:
            continue
        per_node_signals[node_name] = np.stack(channels, axis=1)

    if len(per_node_signals) < MIN_REQUIRED_NODES_FOR_EVAL:
        return None, f"有效关键点不足，少于 {MIN_REQUIRED_NODES_FOR_EVAL} 个节点"

    normalized_nodes: Dict[str, np.ndarray] = {node_name: np.zeros_like(signal) for node_name, signal in per_node_signals.items()}
    angle_series = np.zeros((INTERPOLATION_POINTS, len(ANGLE_TRIPLETS) + 1), dtype=float)

    for time_index in range(INTERPOLATION_POINTS):
        frame_positions = {node_name: signal[time_index] for node_name, signal in per_node_signals.items()}
        center = _frame_center(frame_positions)
        centered_positions = {node_name: value - center for node_name, value in frame_positions.items()}
        scale = _estimate_body_scale(centered_positions)
        normalized_positions = {node_name: value / scale for node_name, value in centered_positions.items()}

        for node_name, value in normalized_positions.items():
            normalized_nodes[node_name][time_index] = value

        angle_values: List[float] = []
        for start_node, joint_node, end_node, _angle_name in ANGLE_TRIPLETS:
            if start_node in normalized_positions and joint_node in normalized_positions and end_node in normalized_positions:
                angle_values.append(
                    _compute_joint_angle(
                        normalized_positions[start_node],
                        normalized_positions[joint_node],
                        normalized_positions[end_node],
                    )
                )
            else:
                angle_values.append(0.0)

        if "head" in normalized_positions and "l_knee" in normalized_positions and "r_knee" in normalized_positions:
            knee_center = 0.5 * (normalized_positions["l_knee"] + normalized_positions["r_knee"])
            trunk_vector = normalized_positions["head"] - knee_center
            angle_values.append(float(math.atan2(float(trunk_vector[0]), float(trunk_vector[1] + 1e-6))))
        else:
            angle_values.append(0.0)

        angle_series[time_index] = np.asarray(angle_values, dtype=float)

    return {
        "node_sequences": normalized_nodes,
        "angle_sequence": angle_series,
        "available_nodes": sorted(normalized_nodes.keys()),
    }, None


def build_template_features(record: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Convert one JSON/JSONL sample into normalized proxy trajectories."""
    action_type = normalize_action_type(record.get("actionType"))
    if action_type is None:
        return None, "动作类别缺失或非法"

    sensor_frame = jsonl_frames_to_sensor_frame(record, get_jsonl_node_mapping())
    if sensor_frame.empty:
        return None, "缺少可用传感器帧"

    proxy_features, error_message = _build_framewise_proxy_sequences(sensor_frame)
    if proxy_features is None:
        return None, error_message

    proxy_features["action_type"] = action_type
    return proxy_features, None


def _dtw_distance(sequence_a: np.ndarray, sequence_b: np.ndarray) -> float:
    """Compute a simple DTW distance between two frame sequences."""
    len_a, len_b = sequence_a.shape[0], sequence_b.shape[0]
    dp = np.full((len_a + 1, len_b + 1), np.inf, dtype=float)
    dp[0, 0] = 0.0

    for index_a in range(1, len_a + 1):
        for index_b in range(1, len_b + 1):
            frame_distance = float(np.mean(np.square(sequence_a[index_a - 1] - sequence_b[index_b - 1])))
            dp[index_a, index_b] = frame_distance + min(
                dp[index_a - 1, index_b],
                dp[index_a, index_b - 1],
                dp[index_a - 1, index_b - 1],
            )

    return float(dp[len_a, len_b] / max(len_a, len_b))


def _sliding_alignment_distance(sequence_a: np.ndarray, sequence_b: np.ndarray, max_shift: int = 4) -> float:
    """Compute a shift-tolerant frame distance and keep the best alignment."""
    best_distance = np.inf
    for shift in range(-max_shift, max_shift + 1):
        if shift >= 0:
            aligned_a = sequence_a[shift:]
            aligned_b = sequence_b[: len(aligned_a)]
        else:
            aligned_b = sequence_b[-shift:]
            aligned_a = sequence_a[: len(aligned_b)]
        if len(aligned_a) == 0 or len(aligned_b) == 0:
            continue
        current_distance = float(np.mean(np.square(aligned_a - aligned_b)))
        best_distance = min(best_distance, current_distance)
    return float(best_distance)


def _trajectory_distance(
    input_features: Dict[str, Any],
    standard_features: Dict[str, Any],
) -> Tuple[Optional[float], Optional[str]]:
    """Compute a combined trajectory distance from common node sequences."""
    common_nodes = sorted(set(input_features["node_sequences"]) & set(standard_features["node_sequences"]))
    if len(common_nodes) < MIN_REQUIRED_NODES_FOR_EVAL:
        return None, f"与标准动作的公共关键点不足，少于 {MIN_REQUIRED_NODES_FOR_EVAL} 个节点"

    input_sequence = np.concatenate([input_features["node_sequences"][node_name] for node_name in common_nodes], axis=1)
    standard_sequence = np.concatenate(
        [standard_features["node_sequences"][node_name] for node_name in common_nodes],
        axis=1,
    )
    if input_sequence.shape != standard_sequence.shape:
        return None, "标准动作与待评判动作的轨迹特征维度不一致"

    dtw_distance = _dtw_distance(input_sequence, standard_sequence)
    shifted_distance = _sliding_alignment_distance(input_sequence, standard_sequence)
    return float(min(dtw_distance, shifted_distance)), None


def _angle_distance(
    input_features: Dict[str, Any],
    standard_features: Dict[str, Any],
) -> Tuple[Optional[float], Optional[str]]:
    """Compute a shift-tolerant angular distance."""
    input_sequence = input_features["angle_sequence"]
    standard_sequence = standard_features["angle_sequence"]
    if input_sequence.shape != standard_sequence.shape:
        return None, "标准动作与待评判动作的角度特征维度不一致"

    dtw_distance = _dtw_distance(input_sequence, standard_sequence)
    shifted_distance = _sliding_alignment_distance(input_sequence, standard_sequence)
    return float(min(dtw_distance, shifted_distance)), None


def _distance_to_similarity(distance_value: float) -> float:
    """Map a distance into the requested similarity range."""
    similarity = 100.0 * math.exp(-0.35 * float(distance_value))
    return max(0.0, min(100.0, similarity))


def compute_similarity_score(
    input_features: Dict[str, Any],
    standard_features: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Compute one debug-rich similarity result between two samples."""
    trajectory_distance, trajectory_error = _trajectory_distance(input_features, standard_features)
    if trajectory_distance is None:
        return None, trajectory_error

    angle_distance, angle_error = _angle_distance(input_features, standard_features)
    if angle_distance is None:
        return None, angle_error

    trajectory_similarity = _distance_to_similarity(trajectory_distance)
    angle_similarity = _distance_to_similarity(angle_distance)
    final_similarity = TRAJECTORY_WEIGHT * trajectory_similarity + ANGLE_WEIGHT * angle_similarity
    final_similarity = max(0.0, min(100.0, final_similarity))

    return {
        "原始距离/误差": {
            "trajectory_distance": round(float(trajectory_distance), 6),
            "angle_distance": round(float(angle_distance), 6),
        },
        "轨迹相似度": round(float(trajectory_similarity), 2),
        "角度相似度": round(float(angle_similarity), 2),
        "最终相似度": round(float(final_similarity), 2),
    }, None


def build_standard_library(standard_records: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Build a per-action standard template library."""
    library: Dict[str, List[Dict[str, Any]]] = {}
    for index, record in enumerate(standard_records):
        action_type = normalize_action_type(record.get("actionType"))
        if action_type is None:
            continue
        features, error_message = build_template_features(record)
        if features is None:
            continue
        library.setdefault(action_type, []).append(
            {
                "standard_index": index,
                "features": features,
            }
        )
    return library


def evaluate_against_standard(
    standard_path: str | Path,
    input_path: str | Path,
) -> Dict[str, Any]:
    """Evaluate input action samples against standard templates."""
    standard_records = load_json_or_jsonl_records(standard_path)
    input_records = load_json_or_jsonl_records(input_path)
    standard_library = build_standard_library(standard_records)

    results: List[Dict[str, Any]] = []
    level_counts = {
        "非常好": 0,
        "好": 0,
        "中等": 0,
        "不合格": 0,
        "无法评判": 0,
    }
    successful_scores: List[float] = []

    for sample_index, record in enumerate(input_records):
        action_type = normalize_action_type(record.get("actionType"))
        if action_type is None:
            level_counts["无法评判"] += 1
            results.append(
                {
                    "样本编号": sample_index,
                    "动作类别": None,
                    "相似度": None,
                    "评判等级": "无法评判",
                    "原因": "动作类别缺失或非法",
                }
            )
            continue

        input_features, input_error = build_template_features(record)
        if input_features is None:
            level_counts["无法评判"] += 1
            results.append(
                {
                    "样本编号": sample_index,
                    "动作类别": action_type,
                    "相似度": None,
                    "评判等级": "无法评判",
                    "原因": input_error,
                }
            )
            continue

        standard_candidates = standard_library.get(action_type, [])
        if not standard_candidates:
            level_counts["无法评判"] += 1
            results.append(
                {
                    "样本编号": sample_index,
                    "动作类别": action_type,
                    "相似度": None,
                    "评判等级": "无法评判",
                    "原因": "标准库中没有同类别标准动作",
                }
            )
            continue

        candidate_scores: List[Dict[str, Any]] = []
        best_result: Optional[Dict[str, Any]] = None
        best_error: Optional[str] = None

        for candidate in standard_candidates:
            score_result, error_message = compute_similarity_score(
                input_features=input_features,
                standard_features=candidate["features"],
            )
            if score_result is None:
                best_error = error_message
                candidate_scores.append(
                    {
                        "标准样本编号": int(candidate["standard_index"]),
                        "相似度": None,
                        "原因": error_message,
                    }
                )
                continue

            candidate_payload = {
                "标准样本编号": int(candidate["standard_index"]),
                **score_result,
            }
            candidate_scores.append(candidate_payload)
            if best_result is None or candidate_payload["最终相似度"] > best_result["最终相似度"]:
                best_result = candidate_payload

        if best_result is None:
            level_counts["无法评判"] += 1
            results.append(
                {
                    "样本编号": sample_index,
                    "动作类别": action_type,
                    "相似度": None,
                    "评判等级": "无法评判",
                    "原因": best_error or "无法与标准动作建立可比特征",
                    "全部模板分数": candidate_scores,
                }
            )
            continue

        final_similarity = float(best_result["最终相似度"])
        level_name = classify_similarity_level(final_similarity)
        successful_scores.append(final_similarity)
        level_counts[level_name] += 1
        results.append(
            {
                "样本编号": sample_index,
                "动作类别": action_type,
                "相似度": round(final_similarity, 2),
                "评判等级": level_name,
                "原始距离/误差": best_result["原始距离/误差"],
                "轨迹相似度": best_result["轨迹相似度"],
                "角度相似度": best_result["角度相似度"],
                "最终相似度": best_result["最终相似度"],
                "使用的标准样本编号": best_result["标准样本编号"],
                "全部模板分数": candidate_scores,
            }
        )

    return {
        "数据文件": str(Path(input_path)),
        "标准文件": str(Path(standard_path)),
        "总评判样本数": len(input_records),
        "成功评判数": len(successful_scores),
        "逐样本结果": results,
        "每个等级的数量统计": level_counts,
        "平均相似度": round(float(np.mean(successful_scores)), 2) if successful_scores else None,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser."""
    parser = argparse.ArgumentParser(description="基于标准动作模板评判 JSON/JSONL 动作数据的相似度。")
    parser.add_argument("--standard", required=True, help="标准动作 JSON/JSONL 文件路径。")
    parser.add_argument("--input", required=True, help="待评判动作 JSON/JSONL 文件路径。")
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = evaluate_against_standard(
            standard_path=Path(args.standard),
            input_path=Path(args.input),
        )
    except Exception as exc:
        print(json.dumps({"错误": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
