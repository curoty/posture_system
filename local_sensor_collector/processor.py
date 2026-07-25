"""
processor.py — 传感器帧处理管线
===================================
链路：原始帧 → 时间戳提取 → 去重 → 多节点对齐 → 试验台零偏校正
与 sensor_api.py / denoise.py 中的逻辑保持一致。
"""

from __future__ import annotations

import json
import logging
import os
from bisect import bisect_left
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

_LOGGER = logging.getLogger(__name__)

# ─── 试验台校准偏置（V3 raw bench） ──────────────────────────────────────
# 从项目根目录的 calibration_profiles_v3_raw*.json 加载
PROJECT_ROOT = Path(__file__).resolve().parents[1]

CALIBRATION_WAIST_PATH = PROJECT_ROOT / "calibration_profiles_v3_raw.json"
CALIBRATION_NODES_PATH = PROJECT_ROOT / "calibration_profiles_v3_raw_per_node.json"

# 默认偏置（文件加载失败时的后备）
FALLBACK_GYRO_BIAS: Dict[str, List[float]] = {
    "waist":       [-0.386265,  1.004558, -1.252487],
    "left_knee":   [-0.977723, -0.023086,  0.196245],
    "right_knee":  [-0.564320, -0.327964, -0.342689],
    "left_foot":   [ 1.240932,  0.725099,  0.319416],
    "right_foot":  [ 1.087782,  0.026584, -0.573907],
}

# ─── 物理极限（用于野值判别） ─────────────────────────────────────────────
PHYSICAL_ACC_LIMIT_G = 16.0
PHYSICAL_GYRO_LIMIT_DPS = 1000.0

# ─── 对齐容忍度 ──────────────────────────────────────────────────────────
DEFAULT_ASSEMBLY_TOLERANCE_MS = 25


# ═══════════════════════════════════════════════════════════════════════════
# 1. 加载试验台校准
# ═══════════════════════════════════════════════════════════════════════════

def load_bench_calibration() -> Dict[str, Dict[str, Any]]:
    """从项目根目录加载 V3 试验台基准偏置。

    返回: {role: {"gyro_bias": [x,y,z], "acc_bias": [x,y,z]}}
    """
    profiles: Dict[str, Dict[str, Any]] = {}

    # 加载腰部配置
    try:
        with open(CALIBRATION_WAIST_PATH, "r", encoding="utf-8") as f:
            waist_data = json.load(f)
        nodes = waist_data.get("nodes", {})
        for role, cfg in nodes.items():
            profiles[role] = {
                "gyro_bias": cfg.get("gyro_bias", [0, 0, 0]),
                "acc_bias":  cfg.get("acc_bias", [0, 0, 0]),
            }
    except (FileNotFoundError, json.JSONDecodeError) as e:
        _LOGGER.warning("腰部校准文件加载失败: %s，使用后备偏置", e)

    # 加载四节点配置
    try:
        with open(CALIBRATION_NODES_PATH, "r", encoding="utf-8") as f:
            nodes_data = json.load(f)
        nodes = nodes_data.get("nodes", {})
        for role, cfg in nodes.items():
            profiles[role] = {
                "gyro_bias": cfg.get("gyro_bias", [0, 0, 0]),
                "acc_bias":  cfg.get("acc_bias", [0, 0, 0]),
            }
    except (FileNotFoundError, json.JSONDecodeError) as e:
        _LOGGER.warning("四节点校准文件加载失败: %s，使用后备偏置", e)

    # 对缺少的节点用后备值补全
    for role, bias in FALLBACK_GYRO_BIAS.items():
        if role not in profiles:
            profiles[role] = {"gyro_bias": bias, "acc_bias": [0, 0, 0]}

    return profiles


# 模块级缓存
_BENCH_PROFILES: Optional[Dict[str, Dict[str, Any]]] = None


def get_bench_profiles() -> Dict[str, Dict[str, Any]]:
    global _BENCH_PROFILES
    if _BENCH_PROFILES is None:
        _BENCH_PROFILES = load_bench_calibration()
        _LOGGER.info("已加载 %d 个节点的试验台偏置", len(_BENCH_PROFILES))
    return _BENCH_PROFILES


def get_gyro_bias(role: str) -> List[float]:
    """获取指定角色的陀螺仪偏置。"""
    profiles = get_bench_profiles()
    return profiles.get(role, {}).get("gyro_bias", [0, 0, 0])


# ═══════════════════════════════════════════════════════════════════════════
# 2. 应用零偏校正
# ═══════════════════════════════════════════════════════════════════════════

def apply_gyro_bias(point: Dict[str, float], role: str) -> Dict[str, float]:
    """对单点的陀螺仪通道减去试验台偏置。"""
    bias = get_gyro_bias(role)
    return {
        "ax": round(float(point.get("ax", 0)), 3),
        "ay": round(float(point.get("ay", 0)), 3),
        "az": round(float(point.get("az", 0)), 3),
        "gx": round(float(point.get("gx", 0)) - bias[0], 3),
        "gy": round(float(point.get("gy", 0)) - bias[1], 3),
        "gz": round(float(point.get("gz", 0)) - bias[2], 3),
    }


def apply_bench_offset_to_frame(frame: Dict[str, Any]) -> Dict[str, Any]:
    """对一帧中所有节点的陀螺仪施加偏置校正。"""
    points = frame.get("points", {})
    corrected = {}
    for role, pt in points.items():
        if isinstance(pt, dict):
            corrected[role] = apply_gyro_bias(pt, role)
        else:
            corrected[role] = pt
    return {**frame, "points": corrected, "bench_bias_applied": True}


# ═══════════════════════════════════════════════════════════════════════════
# 3. 时间戳提取
# ═══════════════════════════════════════════════════════════════════════════

def extract_timestamp_ms(frame: Dict[str, Any]) -> Optional[int]:
    """从帧中提取可靠的 Unix 毫秒时间戳。

    优先顺序: unix_ts_ms (time_synced) → t (大时间戳) → uptime_ms
    """
    unix_ms = int(frame.get("unix_ts_ms", 0) or 0)
    if bool(frame.get("time_synced")) and unix_ms >= 1_700_000_000_000:
        return unix_ms

    raw_t = int(frame.get("t", 0) or 0)
    if raw_t >= 1_700_000_000_000:
        return raw_t

    uptime = int(frame.get("uptime_ms", 0) or 0)
    if uptime > 0:
        return uptime

    return None


def ensure_timestamp(frame: Dict[str, Any], fallback_ms: int) -> Dict[str, Any]:
    """确保帧有有效的时间戳，缺失则用后备值。"""
    ts = extract_timestamp_ms(frame)
    if ts is not None:
        return frame
    return {**frame, "t": fallback_ms, "unix_ts_ms": fallback_ms,
            "time_synced": False}


# ═══════════════════════════════════════════════════════════════════════════
# 4. 帧去重
# ═══════════════════════════════════════════════════════════════════════════

def deduplicate_frames(frames: List[Dict[str, Any]],
                       time_key: str = "t") -> List[Dict[str, Any]]:
    """按时间戳去重，保留首次出现的帧。"""
    seen: set = set()
    result: List[Dict[str, Any]] = []
    for frame in frames:
        ts = int(frame.get(time_key, 0))
        if ts not in seen:
            seen.add(ts)
            result.append(frame)
    return result


# ═══════════════════════════════════════════════════════════════════════════
# 5. 多节点对齐（组装同步帧）
# ═══════════════════════════════════════════════════════════════════════════

def assemble_synchronized_frames(
    raw_frames: List[Dict[str, Any]],
    roles: Optional[List[str]] = None,
    tolerance_ms: int = DEFAULT_ASSEMBLY_TOLERANCE_MS,
) -> List[Dict[str, Any]]:
    """把独立单节点帧组装成同步复合帧。

    与 sensor_api.py 中的 _assemble_synchronized_frames 逻辑一致。
    """
    if not raw_frames:
        return []

    # 收集所有出现过的角色
    discovered_roles: set = set()
    role_series: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {}
    for frame in raw_frames:
        pts = frame.get("points")
        if not isinstance(pts, dict):
            continue
        ts = extract_timestamp_ms(frame)
        if ts is None:
            continue
        for role in pts:
            if isinstance(pts[role], dict):
                discovered_roles.add(role)
                if role not in role_series:
                    role_series[role] = []
                role_series[role].append((ts, frame))

    active_roles = [r for r in (roles or list(discovered_roles)) if r in role_series]
    if len(active_roles) < 1:
        return []

    # 各角色按时间排序
    for role in active_roles:
        role_series[role].sort(key=lambda x: x[0])

    timestamps = {r: [x[0] for x in role_series[r]] for r in active_roles}
    next_positions = {r: 0 for r in active_roles}
    anchor_role = active_roles[0]
    composites: List[Dict[str, Any]] = []

    for anchor_idx, (anchor_ms, anchor_frame) in enumerate(role_series[anchor_role]):
        selected: Dict[str, Tuple[int, Dict[str, Any]]] = {
            anchor_role: (anchor_idx, anchor_frame)
        }
        complete = True

        for role in active_roles[1:]:
            role_ts_list = timestamps[role]
            start_pos = next_positions[role]
            pos = bisect_left(role_ts_list, anchor_ms, lo=start_pos)

            candidates = []
            if pos < len(role_ts_list):
                candidates.append(pos)
            if pos - 1 >= start_pos:
                candidates.append(pos - 1)
            if not candidates:
                complete = False
                break

            nearest = min(candidates,
                          key=lambda i: abs(role_ts_list[i] - anchor_ms))
            if abs(role_ts_list[nearest] - anchor_ms) > tolerance_ms:
                complete = False
                break

            selected[role] = (nearest, role_series[role][nearest][1])

        if complete:
            for role, (idx, _) in selected.items():
                next_positions[role] = idx + 1

            merged_points = {}
            for role, (_, sel_frame) in selected.items():
                pts = sel_frame.get("points", {})
                if isinstance(pts.get(role), dict):
                    merged_points[role] = dict(pts[role])

            composites.append({
                "t": anchor_ms,
                "unix_ts_ms": anchor_ms,
                "time_synced": True,
                "points": merged_points,
            })

    return composites


# ═══════════════════════════════════════════════════════════════════════════
# 6. 完整处理管线（一站式）
# ═══════════════════════════════════════════════════════════════════════════

def process_raw_frames(
    raw_frames: List[Dict[str, Any]],
    roles: Optional[List[str]] = None,
    apply_bias: bool = True,
    do_dedup: bool = True,
    do_align: bool = True,
    tolerance_ms: int = DEFAULT_ASSEMBLY_TOLERANCE_MS,
    sample_interval_ms: int = 20,
) -> List[Dict[str, Any]]:
    """一站式处理管线：标准化 → 去重 → 对齐 → 零偏校正。

    参数:
        raw_frames: 原始帧列表
        roles: 期望的角色列表（None = 自动发现）
        apply_bias: 是否施加试验台零偏
        do_dedup: 是否去重
        do_align: 是否多节点对齐
        tolerance_ms: 对齐容忍度（毫秒）

    返回:
        处理后的帧列表
    """
    if not raw_frames:
        return []

    # Step 1: 确保帧有 points 字典
    cleaned = []
    for f in raw_frames:
        if isinstance(f, dict) and isinstance(f.get("points"), dict):
            cleaned.append(f)
    if not cleaned:
        return []

    # Step 2: 去重
    if do_dedup:
        cleaned = deduplicate_frames(cleaned)

    # Step 3: 多节点对齐
    if do_align:
        cleaned = assemble_synchronized_frames(
            cleaned, roles=roles, tolerance_ms=tolerance_ms,
        )

    # Step 4: 施加零偏
    if apply_bias:
        cleaned = [apply_bench_offset_to_frame(f) for f in cleaned]

    return cleaned


# ═══════════════════════════════════════════════════════════════════════════
# 7. 简单野值过滤（轻量去噪）
# ═══════════════════════════════════════════════════════════════════════════

def filter_physical_outliers(
    frames: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """剔除物理上不可能的数据（传感器故障/传输错误导致的野值）。

    与 denoise.py 不同：这里是 **整帧级处理**（对齐后的复合帧），
    不丢弃整帧，只把异常节点的数据清零，其他正常节点保留。
    """
    result = []
    for frame in frames:
        points = frame.get("points", {})
        cleaned_points = {}
        for role, pt in points.items():
            if not isinstance(pt, dict):
                continue
            ax = abs(float(pt.get("ax", 0)))
            ay = abs(float(pt.get("ay", 0)))
            az = abs(float(pt.get("az", 0)))
            gx = abs(float(pt.get("gx", 0)))
            gy = abs(float(pt.get("gy", 0)))
            gz = abs(float(pt.get("gz", 0)))
            acc_norm = np.sqrt(ax**2 + ay**2 + az**2)
            gyro_norm = np.sqrt(gx**2 + gy**2 + gz**2)

            if acc_norm > PHYSICAL_ACC_LIMIT_G or gyro_norm > PHYSICAL_GYRO_LIMIT_DPS:
                # 只清零这个异常节点，不丢整帧
                _LOGGER.debug("野值节点 %s: acc_norm=%.1f  gyro_norm=%.0f", role, acc_norm, gyro_norm)
                cleaned_points[role] = {"ax": 0, "ay": 0, "az": 0,
                                        "gx": 0, "gy": 0, "gz": 0}
            else:
                cleaned_points[role] = pt

        if cleaned_points:
            result.append({**frame, "points": cleaned_points})
    return result
