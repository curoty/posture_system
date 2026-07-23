"""IMU 姿态解算 —— 加速度计 + 陀螺仪的互补融合。

为什么需要:
    系统此前把每个节点的 6 个通道 (ax,ay,az,gx,gy,gz) 当成 6 条互不相关的
    时间序列。但它们描述的是**同一个刚体**的运动，存在明确的物理关系:

      - 陀螺仪: 角速度积分 → 姿态。短期精确，但积分误差会**长期漂移**。
      - 加速度计: 静止时测到的是重力，可反推绝对倾角。长期不漂移，
        但运动时重力被运动加速度淹没，**短期噪声大**。

    互补滤波正是"短期信陀螺、长期用重力校正漂移"。解算后可得到:
      - 俯仰(pitch)/翻滚(roll): 有重力做绝对参考，**不漂移**，可靠。
      - 偏航(yaw): 重力在垂直轴上无分量，6 轴 IMU **无法校正偏航漂移**。

本实现采用 Mahony 互补滤波(比 Madgwick 更轻量，低采样率下更稳)。

⚠️ 本项目数据的现实约束(实测):
    - 采样率中位数仅 ~20Hz(建议 ≥50Hz)，积分步长偏大
    - 采样间隔变异系数中位数 0.43，78.8% 的样本抖动 >0.3

    因此本实现**必须使用每帧真实时间戳计算 dt**，绝不能假设固定采样率
    —— 否则近八成样本的积分会因 dt 失真而产生显著误差。

    即便如此，20Hz 下的解算精度仍然有限，且 yaw 必然漂移。使用前请通过
    A/B 实验验证其对下游任务是否真有增益，不要想当然。
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

# 重力加速度不参与数值计算，仅用于判定加速度计读数是否"可信"(接近静态重力)。
_GRAVITY_TOLERANCE = 0.35  # 允许 |a|/|g| 偏离 1 的相对范围


def _normalize(v: np.ndarray) -> Optional[np.ndarray]:
    """归一化向量；模长过小则返回 None(方向无意义)。"""
    norm = float(np.linalg.norm(v))
    if norm < 1e-8:
        return None
    return v / norm


def _quaternion_to_euler(q: np.ndarray) -> Tuple[float, float, float]:
    """四元数 (w,x,y,z) → 欧拉角 (roll, pitch, yaw)，单位弧度。

    pitch 在 ±90° 附近会遇到万向锁，此处对 sin(pitch) 做裁剪以避免 NaN。
    """
    w, x, y, z = q

    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = np.arctan2(sinr_cosp, cosr_cosp)

    sinp = np.clip(2.0 * (w * y - z * x), -1.0, 1.0)  # 裁剪防万向锁处 NaN
    pitch = np.arcsin(sinp)

    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = np.arctan2(siny_cosp, cosy_cosp)

    return float(roll), float(pitch), float(yaw)


class MahonyAHRS:
    """Mahony 互补滤波姿态解算器(单个 IMU 节点)。

    通过 PI 控制器，用加速度计观测到的重力方向去修正陀螺仪的积分漂移。

    Args:
        kp: 比例增益。越大越信任加速度计(收敛快，但易被运动加速度带偏)。
        ki: 积分增益。用于消除陀螺仪常值零偏。
        acc_unit_g: 加速度单位是否为 g。本项目数据量级约 ±1，判定为 g。
            仅影响"加速度是否接近静态重力"的可信度判断，不影响姿态数学。
    """

    def __init__(self, kp: float = 1.0, ki: float = 0.05, acc_unit_g: bool = True) -> None:
        self.kp = kp
        self.ki = ki
        self.acc_unit_g = acc_unit_g
        self.q = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float64)  # (w,x,y,z)
        self._integral_error = np.zeros(3, dtype=np.float64)

    def reset(self) -> None:
        self.q = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
        self._integral_error[:] = 0.0

    def _acc_is_trustworthy(self, acc: np.ndarray) -> bool:
        """剧烈运动时加速度计不再反映重力，此时应只靠陀螺仪积分。"""
        magnitude = float(np.linalg.norm(acc))
        reference = 1.0 if self.acc_unit_g else 9.80665
        if reference <= 0:
            return False
        return abs(magnitude / reference - 1.0) < _GRAVITY_TOLERANCE

    def update(self, gyro: np.ndarray, acc: np.ndarray, dt: float) -> np.ndarray:
        """推进一步。

        Args:
            gyro: [3] 角速度 (gx,gy,gz)，单位 rad/s。
            acc:  [3] 加速度 (ax,ay,az)，任意一致单位。
            dt:   与上一帧的**真实**时间间隔(秒)。

        Returns:
            [4] 更新后的四元数 (w,x,y,z)。
        """
        if dt <= 0.0 or not np.isfinite(dt):
            return self.q  # 时间戳异常(重复/倒退)，跳过该帧而非用错误的 dt 积分

        gyro = np.asarray(gyro, dtype=np.float64)
        acc = np.asarray(acc, dtype=np.float64)

        # 仅当加速度接近静态重力时，才用它去校正陀螺仪漂移。
        acc_dir = _normalize(acc) if self._acc_is_trustworthy(acc) else None
        if acc_dir is not None:
            w, x, y, z = self.q
            # 当前姿态下，重力方向在机体坐标系中的预期投影
            expected = np.array([
                2.0 * (x * z - w * y),
                2.0 * (w * x + y * z),
                w * w - x * x - y * y + z * z,
            ])
            # 观测方向与预期方向的叉积 = 姿态误差
            error = np.cross(acc_dir, expected)
            self._integral_error += error * self.ki * dt
            gyro = gyro + self.kp * error + self._integral_error

        # 四元数积分: q_dot = 0.5 * q ⊗ (0, gyro)
        w, x, y, z = self.q
        gx, gy, gz = gyro
        q_dot = 0.5 * np.array([
            -x * gx - y * gy - z * gz,
            w * gx + y * gz - z * gy,
            w * gy - x * gz + z * gx,
            w * gz + x * gy - y * gx,
        ])
        self.q = self.q + q_dot * dt

        norm = float(np.linalg.norm(self.q))
        if norm < 1e-8:  # 数值退化，重置而非产生 NaN 污染后续所有帧
            self.reset()
        else:
            self.q /= norm
        return self.q


def solve_attitude_sequence(
    raw_sequence: np.ndarray,
    timestamps: np.ndarray,
    gyro_in_degrees: bool = True,
    kp: float = 1.0,
    ki: float = 0.05,
) -> np.ndarray:
    """对一段多节点 IMU 序列逐节点解算姿态。

    Args:
        raw_sequence: [T, N, 6] 原始 IMU，通道顺序 (ax,ay,az,gx,gy,gz)。
        timestamps: [T] 每帧的**真实**时间戳(秒)。用于计算逐帧 dt ——
            本项目采样抖动大，固定 dt 会让多数样本积分失真。
        gyro_in_degrees: 陀螺仪是否为 deg/s。本项目数据量级达数百，判定为 deg/s。

    Returns:
        [T, N, 3] 每帧每节点的 (roll, pitch, yaw)，单位弧度。

        注意 yaw 由纯陀螺仪积分得到(6 轴 IMU 无磁力计可校正)，**必然漂移**，
        下游若使用应格外谨慎；roll/pitch 有重力校正，相对可靠。
    """
    if raw_sequence.ndim != 3 or raw_sequence.shape[2] != 6:
        raise ValueError(f"expected raw_sequence [T, N, 6], got {raw_sequence.shape}")
    num_frames, num_nodes, _ = raw_sequence.shape
    if timestamps.shape[0] != num_frames:
        raise ValueError("timestamps length must match raw_sequence frames")

    gyro_scale = np.pi / 180.0 if gyro_in_degrees else 1.0

    # 逐帧真实 dt。首帧无前驱，用后续 dt 的中位数兜底(而非臆造固定采样率)。
    deltas = np.diff(np.asarray(timestamps, dtype=np.float64))
    valid = deltas[(deltas > 0) & np.isfinite(deltas)]
    fallback_dt = float(np.median(valid)) if valid.size else 0.05
    dts = np.concatenate([[fallback_dt], deltas])

    # 上游在时间戳缺失时会退化成用帧序号(见 convert_record_to_sequence)，
    # 此时 dt≈1s，比真实的 ~0.05s 大 20 倍，积分会严重发散。把明显失真的
    # dt 收敛到中位数，宁可轻微失真也不让整段姿态被少数坏帧带崩。
    dts = np.clip(dts, 0.0, max(fallback_dt * 5.0, 1e-3))

    euler = np.zeros((num_frames, num_nodes, 3), dtype=np.float32)
    for node in range(num_nodes):
        filt = MahonyAHRS(kp=kp, ki=ki)
        for frame in range(num_frames):
            acc = raw_sequence[frame, node, 0:3]
            gyro = raw_sequence[frame, node, 3:6] * gyro_scale
            q = filt.update(gyro, acc, float(dts[frame]))
            euler[frame, node, :] = _quaternion_to_euler(q)
    return euler


def attitude_to_channels(euler: np.ndarray, drop_yaw: bool = True) -> np.ndarray:
    """把欧拉角转成适合喂给网络的通道，用 sin/cos 编码消除角度的周期性跳变。

    直接用弧度会在 ±π 处发生 2π 的阶跃，网络会把它误当成剧烈运动。
    sin/cos 编码让角度在圆周上连续。

    Args:
        euler: [T, N, 3] (roll, pitch, yaw)，弧度。
        drop_yaw: 是否丢弃 yaw。默认 True —— 6 轴 IMU 的 yaw 由纯陀螺仪积分
            得到，必然漂移，作为特征会引入随时间增长的伪信号。

    Returns:
        [T, N, C] 其中 C = 4 (roll/pitch 的 sin,cos) 或 6 (含 yaw)。
    """
    angles = euler[:, :, :2] if drop_yaw else euler
    return np.concatenate([np.sin(angles), np.cos(angles)], axis=2).astype(np.float32)
