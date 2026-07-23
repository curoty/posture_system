"""IMU 信号去噪 —— 野值剔除 + 低通平滑。

与姿态解算(src/attitude.py)的区别:
    - 姿态解算是**跨传感器**融合(acc ↔ gyro)，产出新的物理量(倾角)。
    - 本模块是**沿时间轴**的信号净化，输入输出通道数不变。
    去噪应在姿态解算**之前**执行 —— 否则野值会被陀螺积分放大。

处理顺序不可颠倒 (先去尖刺，再去抖动):
    中值滤波剔除孤立野值 → 低通滤波抑制高频抖动

    若先低通，尖刺会被"抹开"污染整个邻域，中值再也救不回来。
    反之，中值滤波按大小排序取中位，野值被直接排除，邻居毫发无损。
    **绝不能用均值/低通去尖刺** —— 均值会把野值的能量摊到周围所有帧上。

本项目数据的实测噪声特性(300 样本, 301 万通道点):
    - 野值尖刺: acc 0.672%, gyro 0.766%  (稳健 Z>6, 基于 MAD)
      acc 最大值达 228 g —— 物理上不可能(人体运动极限约 10-20 g)
    - 高频抖动: acc 相邻帧差分仅占信号幅值 2%, gyro 约 0%

    结论: **尖刺是主要矛盾，抖动几乎可以忽略**。因此默认配置重去尖刺、
    轻去抖动。盲目上强低通只会抹掉真实的快速运动。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

import numpy as np

# 人体运动的物理上限。超出此范围的读数只可能来自传感器故障或传输错误，
# 直接判为野值。留出宽裕余量以免误杀真实的冲击(如落冰、蹬冰)。
#
# 实测本项目数据: acc 99.9% 分位仅 1.99 g 但最大值达 228 g；
#                gyro 99.9% 分位 559 dps 但最大值 1420 dps。
# 这些极端值比正常信号高出两个数量级，是传感器故障而非真实运动。
PHYSICAL_ACC_LIMIT_G = 16.0        # 人体运动极限约 10-20 g
PHYSICAL_GYRO_LIMIT_DPS = 1000.0   # 人体肢体角速度极限；再高只可能是故障
DEFAULT_SAMPLE_RATE_HZ = 50.0
CHANNEL_NAMES = ("ax", "ay", "az", "gx", "gy", "gz")

_MAD_TO_STD = 1.4826  # 正态分布下 MAD → 标准差的换算常数


@dataclass
class CalibrationProfile:
    """单个实体 IMU 节点的校准参数。

    ``firmware_calibrated`` 表示固件已经执行启动陀螺仪校准；此时
    ``gyro_bias`` 仅表示其后的残余静止偏置，而不是芯片原始零偏。
    """

    node_id: str
    sample_rate_hz: float = DEFAULT_SAMPLE_RATE_HZ
    calibration_mode: str = "firmware_calibrated"
    reference_temperature_c: Optional[float] = None
    acc_bias: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    gyro_bias: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    acc_temperature_slope: list[float] = field(
        default_factory=lambda: [0.0, 0.0, 0.0]
    )
    gyro_temperature_slope: list[float] = field(
        default_factory=lambda: [0.0, 0.0, 0.0]
    )
    temperature_compensation_enabled: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Dict[str, Any]) -> "CalibrationProfile":
        return cls(**value)


def validate_timestamps(
    timestamps_ms: Sequence[float],
    sample_rate_hz: float = DEFAULT_SAMPLE_RATE_HZ,
    tolerance_ratio: float = 0.35,
) -> Dict[str, Any]:
    """检查单节点时间戳的重复、倒退、缺口和采样间隔抖动。"""
    ts = np.asarray(timestamps_ms, dtype=np.float64)
    if ts.ndim != 1:
        raise ValueError(f"timestamps must be 1-D, got {ts.shape}")
    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")
    if ts.size < 2:
        return {
            "frame_count": int(ts.size),
            "duplicate_count": 0,
            "backward_count": 0,
            "gap_count": 0,
            "estimated_missing_frames": 0,
            "median_interval_ms": None,
            "jitter_p95_ms": None,
        }

    delta = np.diff(ts)
    expected_ms = 1000.0 / sample_rate_hz
    positive = delta[delta > 0]
    median_interval = float(np.median(positive)) if positive.size else None
    gap_mask = delta > expected_ms * (1.0 + tolerance_ratio)
    estimated_missing = np.maximum(
        np.rint(delta[gap_mask] / expected_ms).astype(int) - 1,
        0,
    )
    jitter = np.abs(positive - expected_ms)
    return {
        "frame_count": int(ts.size),
        "duplicate_count": int(np.count_nonzero(delta == 0)),
        "backward_count": int(np.count_nonzero(delta < 0)),
        "gap_count": int(np.count_nonzero(gap_mask)),
        "estimated_missing_frames": int(estimated_missing.sum()),
        "median_interval_ms": median_interval,
        "jitter_p95_ms": (
            float(np.percentile(jitter, 95)) if jitter.size else None
        ),
    }


def estimate_static_bias(
    sequence: np.ndarray,
    expected_gravity_g: Optional[Sequence[float]] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """用静止数据的稳健中位数估计加速度偏置和陀螺仪残余偏置。

    未提供 ``expected_gravity_g`` 时不会猜测设备姿态，加速度偏置返回零。
    """
    if sequence.ndim != 3 or sequence.shape[2] != 6:
        raise ValueError(f"expected [T, N, 6], got {sequence.shape}")
    if sequence.shape[0] < 10:
        raise ValueError("at least 10 static frames are required")

    center = np.nanmedian(sequence.astype(np.float64), axis=0)
    robust_sigma = _MAD_TO_STD * np.nanmedian(
        np.abs(sequence.astype(np.float64) - center[None, :, :]),
        axis=0,
    )
    gyro_bias = center[:, 3:6]
    if expected_gravity_g is None:
        acc_bias = np.zeros_like(center[:, :3])
    else:
        gravity = np.asarray(expected_gravity_g, dtype=np.float64)
        if gravity.shape == (3,):
            gravity = np.repeat(gravity[None, :], sequence.shape[1], axis=0)
        if gravity.shape != (sequence.shape[1], 3):
            raise ValueError(
                "expected_gravity_g must have shape [3] or [N, 3], "
                f"got {gravity.shape}"
            )
        acc_bias = center[:, :3] - gravity

    return (
        acc_bias.astype(np.float32),
        gyro_bias.astype(np.float32),
        {
            "median": center.tolist(),
            "robust_sigma": robust_sigma.tolist(),
            "acc_bias_estimated": expected_gravity_g is not None,
        },
    )


def fit_temperature_bias(
    temperatures_c: Sequence[float],
    static_values: np.ndarray,
    min_temperature_span_c: float = 3.0,
) -> Dict[str, Any]:
    """拟合 ``bias(T)=intercept+slope*(T-reference)``。

    温度跨度不足时返回诊断但禁用补偿，防止把随机噪声拟合成温漂。
    ``static_values`` 可为 [T, C]，通常 C=3（陀螺仪三轴）。
    """
    temperatures = np.asarray(temperatures_c, dtype=np.float64)
    values = np.asarray(static_values, dtype=np.float64)
    if values.ndim == 1:
        values = values[:, None]
    if temperatures.ndim != 1 or values.ndim != 2:
        raise ValueError("temperatures must be [T] and static_values must be [T, C]")
    if temperatures.shape[0] != values.shape[0]:
        raise ValueError("temperature/value length mismatch")

    finite = np.isfinite(temperatures) & np.all(np.isfinite(values), axis=1)
    temperatures = temperatures[finite]
    values = values[finite]
    if temperatures.size < 20:
        raise ValueError("at least 20 finite temperature samples are required")

    span = float(np.ptp(temperatures))
    reference = float(np.median(temperatures))
    centered = temperatures - reference
    design = np.column_stack([np.ones_like(centered), centered])
    coefficients, _, _, _ = np.linalg.lstsq(design, values, rcond=None)
    predicted = design @ coefficients
    residual = values - predicted
    ss_res = np.sum(residual**2, axis=0)
    centered_values = values - np.mean(values, axis=0)
    ss_total = np.sum(centered_values**2, axis=0)
    r_squared = np.where(ss_total > 1e-12, 1.0 - ss_res / ss_total, 0.0)
    enabled = span >= min_temperature_span_c
    return {
        "enabled": bool(enabled),
        "reason": (
            "ok"
            if enabled
            else f"temperature_span_too_small:{span:.3f}<{min_temperature_span_c:.3f}"
        ),
        "reference_temperature_c": reference,
        "temperature_span_c": span,
        "intercept": coefficients[0].tolist(),
        "slope_per_c": coefficients[1].tolist(),
        "r_squared": r_squared.tolist(),
        "residual_std": np.std(residual, axis=0).tolist(),
        "sample_count": int(temperatures.size),
    }


def apply_calibration(
    sequence: np.ndarray,
    profile: CalibrationProfile,
    temperatures_c: Optional[Sequence[float]] = None,
) -> np.ndarray:
    """应用单节点零偏与可选线性温漂补偿。"""
    if sequence.ndim != 3 or sequence.shape[1:] != (1, 6):
        raise ValueError(
            "apply_calibration handles one physical node at a time; "
            f"expected [T, 1, 6], got {sequence.shape}"
        )
    result = sequence.astype(np.float64).copy()
    result[:, 0, :3] -= np.asarray(profile.acc_bias, dtype=np.float64)
    result[:, 0, 3:6] -= np.asarray(profile.gyro_bias, dtype=np.float64)

    if profile.temperature_compensation_enabled:
        if temperatures_c is None:
            raise ValueError("temperatures_c is required when compensation is enabled")
        temperatures = np.asarray(temperatures_c, dtype=np.float64)
        if temperatures.shape != (sequence.shape[0],):
            raise ValueError(
                f"expected temperatures shape {(sequence.shape[0],)}, "
                f"got {temperatures.shape}"
            )
        if profile.reference_temperature_c is None:
            raise ValueError("reference_temperature_c is required")
        delta_t = temperatures - float(profile.reference_temperature_c)
        result[:, 0, :3] -= (
            delta_t[:, None]
            * np.asarray(profile.acc_temperature_slope, dtype=np.float64)[None, :]
        )
        result[:, 0, 3:6] -= (
            delta_t[:, None]
            * np.asarray(profile.gyro_temperature_slope, dtype=np.float64)[None, :]
        )
    return result.astype(np.float32)


def _median_filter_1d(signal: np.ndarray, kernel_size: int) -> np.ndarray:
    """一维中值滤波(边界用边缘值填充)。

    比 scipy.signal.medfilt 多做的事: 显式处理 NaN —— 本项目上游会用 0 填充
    缺失节点，但下游仍可能引入 NaN，中位数遇 NaN 会污染整个窗口。
    """
    if kernel_size < 3 or kernel_size % 2 == 0:
        raise ValueError(f"kernel_size must be odd and >= 3, got {kernel_size}")
    pad = kernel_size // 2
    padded = np.pad(signal, pad, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, kernel_size)
    return np.nanmedian(windows, axis=-1).astype(signal.dtype)


def _hampel_mask(signal: np.ndarray, window: int, n_sigma: float) -> np.ndarray:
    """Hampel 野值检测: 用滑动中位数与 MAD 判定离群点。

    为什么不用"均值 ± k 倍标准差": 均值和标准差本身会被野值带偏 —— 一个
    228 g 的尖刺会把标准差撑大，反而让自己看起来"不那么离群"。中位数和
    MAD 是稳健统计量，不受少数极端值影响。

    Returns:
        [T] 布尔数组，True 表示该点是野值。
    """
    pad = window // 2
    padded = np.pad(signal, pad, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, window)
    local_median = np.nanmedian(windows, axis=-1)
    local_mad = np.nanmedian(np.abs(windows - local_median[:, None]), axis=-1)
    deviation = np.abs(signal - local_median)

    scale = _MAD_TO_STD * local_mad
    degenerate = scale < 1e-9  # 窗口内信号近乎恒定 → MAD≈0

    # MAD≈0 时不能除以 scale。此处**不能**把 scale 置为 inf —— 那会让恒定
    # 信号里的孤立尖刺永远判不出来(一条全 0 通道里混入 1420dps 就会漏网)。
    # 正确做法: 恒定窗口内任何非平凡偏离都是野值，改用与整条通道尺度相关
    # 的绝对阈值来判定。
    channel_scale = _MAD_TO_STD * np.nanmedian(np.abs(signal - np.nanmedian(signal)))
    absolute_floor = max(float(channel_scale), 1e-6)

    flagged = np.empty_like(deviation, dtype=bool)
    flagged[~degenerate] = deviation[~degenerate] > n_sigma * scale[~degenerate]
    flagged[degenerate] = deviation[degenerate] > n_sigma * absolute_floor
    return flagged


def remove_outliers(
    sequence: np.ndarray,
    acc_limit: float = PHYSICAL_ACC_LIMIT_G,
    gyro_limit: float = PHYSICAL_GYRO_LIMIT_DPS,
    hampel_window: int = 7,
    hampel_sigma: float = 5.0,
) -> Tuple[np.ndarray, int]:
    """剔除野值尖刺，用局部中位数替换。

    两道防线:
      1. 物理量程: 超出人体运动可能范围的读数，无条件判为野值。
      2. Hampel 检测: 量程内但相对邻域显著离群的点。

    Args:
        sequence: [T, N, 6] 原始 IMU，通道顺序 (ax,ay,az,gx,gy,gz)。

    Returns:
        (清理后的序列, 被替换的点数)
    """
    if sequence.ndim != 3 or sequence.shape[2] != 6:
        raise ValueError(f"expected [T, N, 6], got {sequence.shape}")

    cleaned = sequence.astype(np.float64).copy()
    num_frames = cleaned.shape[0]
    replaced = 0

    # 序列太短则无法可靠估计局部中位数，只做物理量程裁剪。
    can_hampel = num_frames >= hampel_window

    for node in range(cleaned.shape[1]):
        for channel in range(6):
            signal = cleaned[:, node, channel]
            limit = acc_limit if channel < 3 else gyro_limit

            outliers = ~np.isfinite(signal) | (np.abs(signal) > limit)
            if can_hampel:
                outliers |= _hampel_mask(signal, hampel_window, hampel_sigma)

            if not outliers.any():
                continue

            # 用局部中位数替换，而非直接置 0 —— 置 0 会在信号中引入一个
            # 人为的阶跃，对下游的差分/积分特征危害更大。
            reference = signal.copy()
            reference[outliers] = np.nan
            if np.all(np.isnan(reference)):
                signal[outliers] = 0.0  # 整条通道都是野值，无从参考
            else:
                filled = _median_filter_1d(
                    np.where(np.isnan(reference), np.nanmedian(reference), reference),
                    kernel_size=min(hampel_window, num_frames | 1),
                )
                signal[outliers] = filled[outliers]

            replaced += int(outliers.sum())

    return cleaned.astype(np.float32), replaced


def butterworth_lowpass(
    sequence: np.ndarray,
    cutoff_hz: float | Sequence[float],
    sample_rate_hz: float,
    order: int = 2,
) -> np.ndarray:
    """零相位 Butterworth 低通滤波，抑制高频抖动。

    使用 filtfilt(正向+反向各滤一次)以实现**零相位延迟** —— 普通滤波会让
    信号整体后移，破坏时序对齐，进而污染速度/加速度等差分特征。

    ⚠️ 截止频率必须低于奈奎斯特频率(sample_rate/2)。当前 ICM20602 测试
    固件为 50Hz，奈奎斯特频率 25Hz；实际截止频率仍应通过动态动作 A/B
    验证，不能只根据静止曲线决定。

    Args:
        sequence: [T, N, 6]
        cutoff_hz: 截止频率(Hz)
        sample_rate_hz: 采样率(Hz)
    """
    from scipy.signal import butter, filtfilt

    nyquist = sample_rate_hz / 2.0
    channel_count = sequence.shape[2]
    cutoffs = np.asarray(cutoff_hz, dtype=np.float64)
    if cutoffs.ndim == 0:
        cutoffs = np.repeat(cutoffs, channel_count)
    if cutoffs.shape != (channel_count,):
        raise ValueError(
            f"cutoff_hz must be a scalar or {channel_count} channel cutoffs"
        )
    if np.any(cutoffs <= 0) or np.any(cutoffs >= nyquist):
        raise ValueError(
            f"all cutoffs must be in (0, {nyquist}) for "
            f"sample_rate={sample_rate_hz}Hz, got {cutoffs.tolist()}"
        )

    # filtfilt 需要的最小长度，太短则跳过滤波而非报错。
    min_length = 3 * (order + 1)
    if sequence.shape[0] <= min_length:
        return sequence.astype(np.float32)

    filtered = sequence.astype(np.float64).copy()
    for channel, channel_cutoff in enumerate(cutoffs):
        b, a = butter(order, float(channel_cutoff) / nyquist, btype="low")
        filtered[:, :, channel] = filtfilt(
            b,
            a,
            filtered[:, :, channel],
            axis=0,
        )
    return filtered.astype(np.float32)


def denoise_sequence(
    sequence: np.ndarray,
    sample_rate_hz: float = DEFAULT_SAMPLE_RATE_HZ,
    remove_spikes: bool = True,
    lowpass_cutoff_hz: Optional[float | Sequence[float]] = None,
) -> Tuple[np.ndarray, dict]:
    """完整去噪流程: 先去尖刺，再(可选)低通平滑。

    Args:
        sequence: [T, N, 6] 原始 IMU。
        sample_rate_hz: 实际采样率。本项目实测中位数约 20Hz。
        lowpass_cutoff_hz: 低通截止频率。**默认 None(不做低通)** ——
            低通收益需要用当前 50Hz 五节点动态数据重新评估，
            反而有抹掉真实快速运动的风险。需要时显式开启，并用 A/B 验证。

    Returns:
        (去噪后的序列, 统计信息)
    """
    stats = {"outliers_replaced": 0, "lowpass_applied": False}
    result = sequence

    if remove_spikes:
        result, replaced = remove_outliers(result)
        stats["outliers_replaced"] = replaced

    if lowpass_cutoff_hz is not None:
        result = butterworth_lowpass(result, lowpass_cutoff_hz, sample_rate_hz)
        stats["lowpass_applied"] = True

    return result, stats


def process_single_node_sequence(
    sequence: np.ndarray,
    profile: Optional[CalibrationProfile] = None,
    temperatures_c: Optional[Sequence[float]] = None,
    sample_rate_hz: float = DEFAULT_SAMPLE_RATE_HZ,
    remove_spikes: bool = True,
    acc_cutoff_hz: Optional[float] = None,
    gyro_cutoff_hz: Optional[float] = None,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """单节点生产顺序：尖峰 → 零偏/温漂 → 可选低通。

    加速度计与陀螺仪允许不同截止频率。仅设置其中一类截止频率时，另一类
    通道保持不滤波，避免使用近奈奎斯特的伪截止频率。
    """
    if sequence.ndim != 3 or sequence.shape[1:] != (1, 6):
        raise ValueError(f"expected [T, 1, 6], got {sequence.shape}")

    result = sequence.astype(np.float32)
    stats: Dict[str, Any] = {
        "sample_rate_hz": float(sample_rate_hz),
        "outliers_replaced": 0,
        "calibration_applied": False,
        "temperature_compensation_applied": False,
        "lowpass_applied": False,
    }
    if remove_spikes:
        result, replaced = remove_outliers(result)
        stats["outliers_replaced"] = int(replaced)

    if profile is not None:
        result = apply_calibration(result, profile, temperatures_c)
        stats["calibration_applied"] = True
        stats["temperature_compensation_applied"] = bool(
            profile.temperature_compensation_enabled
        )
        stats["calibration_mode"] = profile.calibration_mode

    if acc_cutoff_hz is not None or gyro_cutoff_hz is not None:
        # 对未请求滤波的通道保留原值，只对相应三轴调用滤波器。
        filtered = result.copy()
        if acc_cutoff_hz is not None:
            filtered[:, :, :3] = butterworth_lowpass(
                result[:, :, :3],
                float(acc_cutoff_hz),
                sample_rate_hz,
            )
        if gyro_cutoff_hz is not None:
            filtered[:, :, 3:6] = butterworth_lowpass(
                result[:, :, 3:6],
                float(gyro_cutoff_hz),
                sample_rate_hz,
            )
        result = filtered
        stats["lowpass_applied"] = True
        stats["acc_cutoff_hz"] = acc_cutoff_hz
        stats["gyro_cutoff_hz"] = gyro_cutoff_hz

    return result.astype(np.float32), stats


def process_training_frames(
    frames: Sequence[Mapping[str, Any]],
    roles: Optional[Sequence[str]] = None,
    profiles: Optional[Mapping[str, CalibrationProfile | Mapping[str, Any]]] = None,
    sample_rate_hz: float = DEFAULT_SAMPLE_RATE_HZ,
    remove_spikes: bool = True,
    acc_cutoff_hz: Optional[float] = None,
    gyro_cutoff_hz: Optional[float] = None,
) -> Tuple[list[Dict[str, Any]], Dict[str, Any]]:
    """处理 ``train_samples_nofiltering.frames`` 并保留 ``t``/``p`` 结构。

    每个节点只处理实际存在的样本，不插值、不伪造缺失节点。校准参数必须由
    调用方显式传入；未传入时只做尖峰处理，避免把动态动作均值误当成零偏。
    """
    if sample_rate_hz <= 0:
        raise ValueError("sample_rate_hz must be positive")

    source_frames = [dict(frame) for frame in frames]
    discovered_roles = {
        str(role)
        for frame in source_frames
        for field_name in ("p", "points")
        for role in (
            frame.get(field_name, {}).keys()
            if isinstance(frame.get(field_name), Mapping)
            else ()
        )
    }
    requested_roles = (
        list(dict.fromkeys(str(role) for role in roles))
        if roles is not None
        else sorted(discovered_roles)
    )
    profile_map = profiles or {}
    output_frames: list[Dict[str, Any]] = []
    for frame in source_frames:
        copied = dict(frame)
        if isinstance(frame.get("p"), Mapping):
            copied["p"] = dict(frame["p"])
        if isinstance(frame.get("points"), Mapping):
            copied["points"] = {
                str(role): dict(value) if isinstance(value, Mapping) else value
                for role, value in frame["points"].items()
            }
        output_frames.append(copied)

    report: Dict[str, Any] = {
        "schema_version": "training_denoise_v1",
        "frame_count": len(source_frames),
        "sample_rate_hz": float(sample_rate_hz),
        "temperature_compensation_enabled": False,
        "lowpass_requested": bool(
            acc_cutoff_hz is not None or gyro_cutoff_hz is not None
        ),
        "roles": {},
    }

    for role in requested_roles:
        frame_indices: list[int] = []
        timestamps: list[float] = []
        vectors: list[list[float]] = []
        frame_formats: list[str] = []
        for index, frame in enumerate(source_frames):
            compact_points = frame.get("p")
            verbose_points = frame.get("points")
            vector = (
                compact_points.get(role)
                if isinstance(compact_points, Mapping)
                else None
            )
            frame_format = "p"
            if vector is None and isinstance(verbose_points, Mapping):
                vector = verbose_points.get(role)
                frame_format = "points"
            if isinstance(vector, Mapping):
                vector = [
                    vector.get("ax", vector.get("accX", vector.get("acc_x", 0))),
                    vector.get("ay", vector.get("accY", vector.get("acc_y", 0))),
                    vector.get("az", vector.get("accZ", vector.get("acc_z", 0))),
                    vector.get("gx", vector.get("gyroX", vector.get("gyro_x", 0))),
                    vector.get("gy", vector.get("gyroY", vector.get("gyro_y", 0))),
                    vector.get("gz", vector.get("gyroZ", vector.get("gyro_z", 0))),
                ]
            if (
                not isinstance(vector, Sequence)
                or isinstance(vector, (str, bytes))
                or len(vector) < 6
            ):
                continue
            values = [float(value) for value in vector[:6]]
            if not np.all(np.isfinite(values)):
                continue
            frame_indices.append(index)
            frame_formats.append(frame_format)
            timestamps.append(
                float(frame.get("t", index * 1000.0 / sample_rate_hz))
            )
            vectors.append(values)

        role_report: Dict[str, Any] = {
            "sample_count": len(vectors),
            "missing_frame_count": len(source_frames) - len(vectors),
            "coverage_ratio": (
                float(len(vectors) / len(source_frames)) if source_frames else 0.0
            ),
        }
        if not vectors:
            role_report["status"] = "missing"
            report["roles"][role] = role_report
            continue

        profile_value = profile_map.get(role)
        profile: Optional[CalibrationProfile]
        if isinstance(profile_value, CalibrationProfile):
            profile = profile_value
        elif isinstance(profile_value, Mapping):
            profile = CalibrationProfile.from_dict(dict(profile_value))
        else:
            profile = None

        sequence = np.asarray(vectors, dtype=np.float32)[:, None, :]
        processed, stats = process_single_node_sequence(
            sequence,
            profile=profile,
            temperatures_c=None,
            sample_rate_hz=sample_rate_hz,
            remove_spikes=remove_spikes,
            acc_cutoff_hz=acc_cutoff_hz,
            gyro_cutoff_hz=gyro_cutoff_hz,
        )
        for local_index, frame_index in enumerate(frame_indices):
            values = [
                round(float(value), 6) for value in processed[local_index, 0]
            ]
            if frame_formats[local_index] == "p":
                output_frames[frame_index]["p"][role] = values
            else:
                original = output_frames[frame_index]["points"].get(role)
                if isinstance(original, Mapping):
                    updated = dict(original)
                    for name, value in zip(CHANNEL_NAMES, values):
                        updated[name] = value
                    output_frames[frame_index]["points"][role] = updated
                else:
                    output_frames[frame_index]["points"][role] = values

        role_report.update(stats)
        if profile is not None:
            profile_metadata = profile.metadata if isinstance(profile.metadata, Mapping) else {}
            role_report["calibration_source"] = str(
                profile_metadata.get("calibration_source", "explicit")
            )
        role_report["timestamp_quality"] = validate_timestamps(
            timestamps,
            sample_rate_hz=sample_rate_hz,
        )
        role_report["status"] = "processed"
        report["roles"][role] = role_report

    report["total_outliers_replaced"] = int(
        sum(
            int(item.get("outliers_replaced", 0))
            for item in report["roles"].values()
        )
    )
    return output_frames, report
