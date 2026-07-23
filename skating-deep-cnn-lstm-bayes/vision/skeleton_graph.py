"""
人体骨骼图定义
==============
为 ST-GCN 提供骨骼邻接矩阵、分区策略和图卷积工具。
基于 COCO 17 关键点格式 (RTMPose 默认输出)。
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np
import torch


# ============================================================
# COCO 17 关键点与邻接关系
# ============================================================

# 序号 → 名称映射 (索引即关键点编号)
KEYPOINT_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

NUM_NODES = 17

# 骨骼连接: (父节点, 子节点)
# 注意: 这里的连接是双向的 (图是无向的)
CONNECTIONS = [
    (0, 1), (0, 2),            # nose → eyes
    (1, 3), (2, 4),            # eyes → ears
    (0, 5), (0, 6),            # nose → shoulders (颈部近似)
    (5, 6),                     # 肩部连接
    (5, 7), (7, 9),            # 左臂
    (6, 8), (8, 10),           # 右臂
    (5, 11), (6, 12),          # 躯干
    (11, 12),                   # 髋部连接
    (11, 13), (13, 15),        # 左腿
    (12, 14), (14, 16),        # 右腿
]

# 身体中心: 左右髋中点
CENTER_NODES = [11, 12]

# 左右对称映射 (用于数据增强)
LEFT_RIGHT_SYMMETRY = {
    0: 0,      # nose → nose
    1: 2,      # left_eye → right_eye
    2: 1,      # right_eye → left_eye
    3: 4,      # left_ear → right_ear
    4: 3,      # right_ear → left_ear
    5: 6,      # left_shoulder → right_shoulder
    6: 5,      # right_shoulder → left_shoulder
    7: 8,      # left_elbow → right_elbow
    8: 7,      # right_elbow → left_elbow
    9: 10,     # left_wrist → right_wrist
    10: 9,     # right_wrist → left_wrist
    11: 12,    # left_hip → right_hip
    12: 11,    # right_hip → left_hip
    13: 14,    # left_knee → right_knee
    14: 13,    # right_knee → left_knee
    15: 16,    # left_ankle → right_ankle
    16: 15,    # right_ankle → left_ankle
}


# ============================================================
# 邻接矩阵构建
# ============================================================

def build_adjacency_matrix(
    connections: Optional[List[Tuple[int, int]]] = None,
    num_nodes: int = NUM_NODES,
    self_loop: bool = True,
) -> np.ndarray:
    """
    构建骨骼邻接矩阵 A。

    A[i, j] = 1 如果节点 i 和 j 之间有骨骼连接 (或 i==j 且有 self_loop)。

    参数:
        connections: 连接列表 [(parent, child), ...]
        num_nodes: 关节点数
        self_loop: 是否包含自连接

    返回:
        shape [num_nodes, num_nodes] 的邻接矩阵
    """
    if connections is None:
        connections = CONNECTIONS

    A = np.zeros((num_nodes, num_nodes), dtype=np.float32)

    for parent, child in connections:
        A[parent, child] = 1.0
        A[child, parent] = 1.0  # 无向图

    if self_loop:
        for i in range(num_nodes):
            A[i, i] = 1.0

    return A


def normalize_adjacency(A: np.ndarray) -> np.ndarray:
    """
    按列归一化邻接矩阵: A @ D^{-1}，即每个目标节点聚合邻居时取均值。
    这是 ST-GCN 原实现使用的归一化(而非对称归一化)。

    离心/向心子集可能存在**全零行或全零列**(某些节点没有该类邻居)，
    此处显式把零度节点的归一化系数置 0，避免 1e-6 兜底放大数值噪声。

    参数:
        A: 原始邻接矩阵 [V, V]

    返回:
        归一化后的邻接矩阵 [V, V]
    """
    D = np.sum(A, axis=0)                      # 入度(按列) [V]
    D_inv = np.zeros_like(D, dtype=np.float32)
    nonzero = D > 0
    D_inv[nonzero] = 1.0 / D[nonzero]          # 零度节点保持 0，不引入噪声
    return (A @ np.diag(D_inv)).astype(np.float32)


def build_distance_matrix(num_nodes: int = NUM_NODES) -> np.ndarray:
    """
    计算骨骼图上所有节点对之间的最短路径距离。
    使用 Floyd-Warshall 算法。

    返回:
        dist[i, j] = 节点 i 到 j 的最短路径长度 (骨骼连接数)
    """
    INF = 1e9
    dist = np.full((num_nodes, num_nodes), INF, dtype=np.float32)
    for i in range(num_nodes):
        dist[i, i] = 0

    for parent, child in CONNECTIONS:
        dist[parent, child] = 1
        dist[child, parent] = 1

    # Floyd-Warshall
    for k in range(num_nodes):
        for i in range(num_nodes):
            for j in range(num_nodes):
                if dist[i, k] + dist[k, j] < dist[i, j]:
                    dist[i, j] = dist[i, k] + dist[k, j]

    return dist


# ============================================================
# 分区策略 (Spatial Partitioning)
# ============================================================

def get_partition_adjacency(
    strategy: str = "spatial",
    num_nodes: int = NUM_NODES,
) -> Tuple[List[np.ndarray], int]:
    """
    根据 ST-GCN 的分区策略生成多个邻接矩阵。

    策略:
        - "uniform":  1 个子集 —— 所有邻居 + 自身，等价于普通 GCN。
        - "distance": 2 个子集 —— 子集0 自身(距离0)，子集1 直接邻居(距离1)。
        - "spatial":  3 个子集 —— ST-GCN 原版策略，按邻居相对根节点的
                      "向心 / 离心" 关系划分:
                        子集0: 根节点自身
                        子集1: 向心 —— 邻居比根节点更靠近骨骼重心
                        子集2: 离心 —— 邻居比根节点更远离骨骼重心

    "向心/离心" 用**骨骼图上到重心节点的跳数**判定(而非像素坐标):这是
    ST-GCN 原论文的做法，是固定的拓扑属性，不随输入帧变化，因此可以在
    构图时一次算好，无需在 forward 里动态计算。

    返回:
        A_list: 分区邻接矩阵列表, 每个 shape [V, V]
        num_subsets: 子集数 (== len(A_list)，保证一致)
    """
    A = build_adjacency_matrix(self_loop=False)
    identity = np.eye(num_nodes, dtype=np.float32)

    if strategy == "uniform":
        A_uniform = A + identity
        return [A_uniform], 1

    if strategy == "distance":
        # 子集0: 自身; 子集1: 1跳邻居
        return [identity, A.copy()], 2

    if strategy == "spatial":
        dist = build_distance_matrix(num_nodes)

        # 每个节点到"重心"的图距离 —— 重心取左右髋(CENTER_NODES)，
        # 一个节点到重心的距离 = 它到任一髋关节的最短跳数。
        dist_to_center = np.min(dist[:, CENTER_NODES], axis=1)  # [V]

        A_root = identity.copy()
        A_centripetal = np.zeros((num_nodes, num_nodes), dtype=np.float32)
        A_centrifugal = np.zeros((num_nodes, num_nodes), dtype=np.float32)

        # 约定 A[i, j] 表示"信息从 j 聚合到 i"(与 einsum 'bctv,vw->bctw' 一致，
        # 归一化后按列聚合)。对根节点 i 的每个邻居 j 判定向心/离心:
        for i in range(num_nodes):
            for j in range(num_nodes):
                if i == j or A[i, j] == 0:
                    continue
                if dist_to_center[j] < dist_to_center[i]:
                    A_centripetal[i, j] = 1.0   # 邻居更靠近重心 → 向心
                elif dist_to_center[j] > dist_to_center[i]:
                    A_centrifugal[i, j] = 1.0   # 邻居更远离重心 → 离心
                else:
                    # 同一层(如左右髋互连、双肩互连) → 归入向心子集，
                    # 保证每条边都被某个子集覆盖，不丢信息。
                    A_centripetal[i, j] = 1.0

        subsets = [A_root, A_centripetal, A_centrifugal]
        return subsets, len(subsets)

    raise ValueError(f"Unknown partition strategy: {strategy}")


class Graph:
    """
    骨骼图定义，管理邻接矩阵、分区策略和图元数据。

    使用方式:
        graph = Graph(layout="coco_17", strategy="spatial")
        A_list = graph.A  # 分区邻接矩阵列表
    """

    def __init__(
        self,
        layout: str = "coco_17",
        strategy: str = "spatial",
        num_nodes: int = NUM_NODES,
    ):
        self.layout = layout
        self.strategy = strategy
        self.num_nodes = num_nodes

        # 构建基础邻接矩阵 (无自连接，用于分区)
        self.A_raw = build_adjacency_matrix(self_loop=False)

        # 获取分区邻接矩阵
        self.A_list, self.num_subsets = get_partition_adjacency(strategy, num_nodes)

        # 不变式: 声明的子集数必须等于实际矩阵数，否则 SpatialGraphConv 会越界。
        if self.num_subsets != len(self.A_list):
            raise RuntimeError(
                f"分区策略 '{strategy}' 返回 {len(self.A_list)} 个邻接矩阵，"
                f"但声明 num_subsets={self.num_subsets}"
            )

        # 归一化每个子集
        self.A = [normalize_adjacency(A_mat) for A_mat in self.A_list]

        # 转为 PyTorch Tensor [num_subsets, V, V]
        self.register_A = torch.tensor(
            np.stack(self.A, axis=0), dtype=torch.float32
        )

    def get_adjacency(self, device: torch.device) -> torch.Tensor:
        """获取分区邻接张量 [num_subsets, V, V]"""
        return self.register_A.to(device)


# ============================================================
# 从关键点生成手工特征 (用于质量评分)
# ============================================================

def extract_handcrafted_features(
    keypoints: np.ndarray,
    confidence: np.ndarray,
) -> np.ndarray:
    """
    从关键点序列提取手工特征，用于质量评分。

    参数:
        keypoints: [T, V, 2] (x, y) 归一化坐标
        confidence: [T, V] 置信度

    返回:
        features: [D] 手工特征向量
    """
    T, V, _ = keypoints.shape
    features = []

    # 1. 以髋部中点为中心归一化 (如果还未归一化)
    hip_center = np.mean(keypoints[:, [11, 12], :], axis=1, keepdims=True)  # [T, 1, 2]
    keypoints_rel = keypoints - hip_center

    # 2. 关节速度: 相邻帧位移  [T-1, V, 2]
    velocity = np.diff(keypoints_rel, axis=0)
    vel_mag = np.linalg.norm(velocity, axis=2)  # [T-1, V]

    features.append(np.mean(vel_mag, axis=0))       # [V] 各关节平均速度
    features.append(np.std(vel_mag, axis=0))         # [V] 各关节速度标准差
    features.append(np.max(vel_mag, axis=0))         # [V] 各关节最大速度

    # 3. 关节活动范围: 位置标准差
    pos_std = np.std(keypoints_rel, axis=0)          # [V, 2]
    features.append(pos_std.flatten())               # [V*2]

    # 4. 各关节总位移
    total_disp = np.sum(vel_mag, axis=0)             # [V]
    features.append(total_disp)

    # 5. 上下半身运动比
    upper_vel = np.mean(vel_mag[:, :11])             # 上半身 (0-10)
    lower_vel = np.mean(vel_mag[:, 11:])             # 下半身 (11-16)
    features.append([upper_vel, lower_vel, upper_vel / (lower_vel + 1e-6)])

    # 6. 左右对称性: 左右对应关节速度比的负对数
    # 对称关节对: (7,8), (9,10), (13,14), (15,16)
    sym_pairs = [(7, 8), (9, 10), (13, 14), (15, 16)]
    for l, r in sym_pairs:
        l_vel = np.mean(vel_mag[:, l])
        r_vel = np.mean(vel_mag[:, r])
        sym_ratio = (l_vel + 1e-6) / (r_vel + 1e-6)
        # 对称性越好，ratio 越接近 1 → log(ratio) ≈ 0
        features.append([np.abs(np.log(sym_ratio))])

    # 7. 身体倾斜: 肩部连线与水平面的夹角变化
    shoulder_line = keypoints[:, 5, :] - keypoints[:, 6, :]  # [T, 2]
    shoulder_angle = np.arctan2(shoulder_line[:, 1], shoulder_line[:, 0])
    features.append([np.std(shoulder_angle)])          # 倾斜稳定性

    # 8. 重心高度变化 (髋部中点的 y 坐标)
    hip_y = keypoints[:, 11:13, 1].mean(axis=1)       # [T]
    features.append([np.mean(hip_y), np.std(hip_y), np.max(hip_y) - np.min(hip_y)])

    # 9. 平均置信度
    features.append([np.mean(confidence), np.min(confidence)])

    return np.concatenate([f.flatten() for f in features]).astype(np.float32)


def extract_velocity_features(keypoints: np.ndarray) -> np.ndarray:
    """
    提取关节速度特征 (用于 LightGBM 质量评分)。

    与 IMU 侧的 velocity_feature_engineering 对齐,
    但基于关键点坐标而非 IMU 信号。

    参数:
        keypoints: [T, V, 2] (x, y)

    返回:
        feat: [D] 特征向量
    """
    T, V, _ = keypoints.shape
    feat_list = []

    # 速度
    vel = np.diff(keypoints, axis=0)                     # [T-1, V, 2]
    vel_norm = np.linalg.norm(vel, axis=2)               # [T-1, V]

    # 各关节统计
    feat_list.append(np.mean(vel_norm, axis=0))           # [V] 平均速度
    feat_list.append(np.std(vel_norm, axis=0))            # [V] 速度标准差
    feat_list.append(np.percentile(vel_norm, 90, axis=0))  # [V] 峰值速度

    # 加速度
    acc = np.diff(vel, axis=0)                            # [T-2, V, 2]
    acc_norm = np.linalg.norm(acc, axis=2)                # [T-2, V]
    feat_list.append(np.mean(acc_norm, axis=0))           # [V] 平均加速度
    feat_list.append(np.std(acc_norm, axis=0))            # [V] 加速度标准差

    # 全局运动特征
    feat_list.append([np.mean(vel_norm)])                 # 整体平均速度
    feat_list.append([np.std(vel_norm)])                  # 整体速度变化
    feat_list.append([np.max(vel_norm)])                  # 最大瞬时速度

    return np.concatenate([f.flatten() for f in feat_list])
