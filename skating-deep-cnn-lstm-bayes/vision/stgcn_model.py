"""
ST-GCN (Spatial Temporal Graph Convolutional Network)
====================================================
基于骨架关键点的时空图卷积网络。

参考论文:
  - "Spatial Temporal Graph Convolutional Networks for Skeleton-Based Action Recognition"
    (AAAI 2018) - 原版 ST-GCN

本实现特点:
  - 基于 COCO 17 关键点
  - 空间图卷积 (GCN) + 时间卷积 (TCN) 交替堆叠
  - 可学习的边权重 (edge importance weighting)
  - 输出: 动作分类 logits + 质量评分 embedding
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .skeleton_graph import Graph


# ============================================================
# 工具模块
# ============================================================

class ConvTemporal(nn.Module):
    """
    时间卷积模块。
    沿时间维度进行 1D 卷积，捕捉时序依赖。

    参数:
        in_channels: 输入通道数
        out_channels: 输出通道数
        kernel_size: 时间卷积核大小
        stride: 步长
        dilation: 膨胀率
        dropout: dropout 率
    """

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int = 9,
        stride: int = 1,
        dilation: int = 1,
        dropout: float = 0.0,
    ):
        super().__init__()
        padding = ((kernel_size - 1) * dilation) // 2

        self.conv = nn.Conv2d(
            in_channels,
            out_channels,
            kernel_size=(kernel_size, 1),   # 只在时间维度卷积
            padding=(padding, 0),
            stride=(stride, 1),
            dilation=(dilation, 1),
        )
        self.bn = nn.BatchNorm2d(out_channels)
        self.dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        参数:
            x: [B, C, T, V]  (batch, channels, time, vertices)

        返回:
            [B, C', T', V]
        """
        return self.relu(self.dropout(self.bn(self.conv(x))))


# ============================================================
# 空间图卷积 (Spatial Graph Convolution)
# ============================================================

class SpatialGraphConv(nn.Module):
    """
    空间图卷积层。
    在每一帧内，沿骨骼邻接矩阵聚合邻居节点信息。

    对于 ST-GCN 的 spatial 分区策略，支持 3 个子集:
      - 子集 0: 根节点自身
      - 子集 1: 向心 (比根更靠近重心)
      - 子集 2: 离心 (比根更远离重心)

    参数:
        in_channels: 输入通道
        out_channels: 输出通道
        graph: Graph 实例，包含邻接矩阵
        A_size: 分区子集数
        edge_importance: 可学习的边权重
    """

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        graph: Graph,
        edge_importance: bool = True,
    ):
        super().__init__()
        self.graph = graph
        self.num_subsets = graph.num_subsets

        # 每个子集对应一个独立的卷积权重
        self.conv = nn.ModuleList([
            nn.Conv2d(in_channels, out_channels, kernel_size=1)
            for _ in range(self.num_subsets)
        ])

        # 可学习的边重要性权重
        if edge_importance:
            self.edge_importance = nn.Parameter(
                torch.ones(self.num_subsets, graph.num_nodes, graph.num_nodes)
            )
        else:
            self.register_buffer("edge_importance", torch.ones(
                self.num_subsets, graph.num_nodes, graph.num_nodes
            ))

    def forward(self, x: torch.Tensor, A: torch.Tensor) -> torch.Tensor:
        """
        参数:
            x: [B, C, T, V]
            A: [num_subsets, V, V] 分区邻接矩阵(已在构图时按向心/离心划分好)

        返回:
            [B, C', T, V]
        """
        if A.shape[0] != self.num_subsets:
            raise RuntimeError(
                f"邻接矩阵子集数 {A.shape[0]} != 期望的 {self.num_subsets}")

        out = None
        for i in range(self.num_subsets):
            A_i = A[i] * self.edge_importance[i]           # [V, V]，应用可学习边权重
            x_gc = torch.einsum("bctv,vw->bctw", x, A_i)   # 沿关节维度聚合邻居
            contribution = self.conv[i](x_gc)              # 每个子集独立的 1x1 卷积
            out = contribution if out is None else out + contribution

        return out


# ============================================================
# ST-GCN 基本块 (Spatial + Temporal)
# ============================================================

class STGCNBlock(nn.Module):
    """
    ST-GCN 基本块: 空间图卷积 → 时间卷积 → 残差连接。

    参数:
        in_channels: 输入通道
        out_channels: 输出通道
        graph: Graph 实例
        temporal_kernel: 时间卷积核大小
        stride: 时间维度步长
        dropout: dropout 率
        residual: 是否使用残差连接
    """

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        graph: Graph,
        temporal_kernel: int = 9,
        stride: int = 1,
        dropout: float = 0.0,
        residual: bool = True,
    ):
        super().__init__()

        # 空间图卷积
        self.spatial_conv = SpatialGraphConv(
            in_channels, out_channels, graph, edge_importance=True
        )
        self.spatial_bn = nn.BatchNorm2d(out_channels)
        self.spatial_relu = nn.ReLU(inplace=True)

        # 时间卷积
        self.temporal_conv = ConvTemporal(
            out_channels, out_channels,
            kernel_size=temporal_kernel,
            stride=stride,
            dropout=dropout,
        )

        # 残差连接
        self.residual = residual
        if residual:
            if in_channels != out_channels or stride != 1:
                self.residual_block = nn.Sequential(
                    nn.Conv2d(
                        in_channels, out_channels,
                        kernel_size=1, stride=(stride, 1)
                    ),
                    nn.BatchNorm2d(out_channels),
                )
            else:
                self.residual_block = nn.Identity()

    def forward(self, x: torch.Tensor, A: torch.Tensor) -> torch.Tensor:
        """
        参数:
            x: [B, C, T, V]
            A: [num_subsets, V, V]

        返回:
            [B, C', T', V]
        """
        # 空间图卷积
        out = self.spatial_conv(x, A)
        out = self.spatial_bn(out)
        out = self.spatial_relu(out)

        # 时间卷积
        out = self.temporal_conv(out)

        # 残差连接
        if self.residual:
            residual = self.residual_block(x)
            out = out + residual

        return out


# ============================================================
# ST-GCN 主干网络
# ============================================================

class STGCN(nn.Module):
    """
    ST-GCN 主干网络。

    架构:
        输入 [B, 3, T, 17] → BatchNorm → [ST-GCN Block × 6] → GAP → 分类头 + 嵌入

    参数:
        in_channels: 输入通道数 (默认 3: x, y, confidence)
        num_joints: 关节点数 (COCO 17)
        graph_args: 图参数字典
        edge_importance_weighting: 是否使用可学习边权重
        channels: 各层通道数 [c1, c2, ..., c6]
        temporal_kernel_size: 时间卷积核大小
        dropout: dropout 率
        num_action_classes: 动作类别数
        embedding_dim: 质量评分 embedding 维度
    """

    def __init__(
        self,
        in_channels: int = 3,
        num_joints: int = 17,
        graph_args: Optional[dict] = None,
        edge_importance_weighting: bool = True,
        channels: Optional[List[int]] = None,
        temporal_kernel_size: int = 9,
        dropout: float = 0.3,
        num_action_classes: int = 1,
        embedding_dim: int = 256,
    ):
        super().__init__()

        if graph_args is None:
            graph_args = {"layout": "coco_17", "strategy": "spatial"}
        if channels is None:
            channels = [64, 64, 128, 128, 256, 256]

        self.graph = Graph(**graph_args)
        self.num_subsets = self.graph.num_subsets

        # 输入归一化
        self.input_bn = nn.BatchNorm2d(in_channels)

        # ST-GCN 块堆叠
        num_layers = len(channels)
        self.stgcn_layers = nn.ModuleList()

        in_c = in_channels
        for i, out_c in enumerate(channels):
            stride = 2 if i in [2, 4] else 1  # 在第3、5层下采样时间维度
            self.stgcn_layers.append(STGCNBlock(
                in_channels=in_c,
                out_channels=out_c,
                graph=self.graph,
                temporal_kernel=temporal_kernel_size,
                stride=stride,
                dropout=dropout,
                residual=True,
            ))
            in_c = out_c

        # 全局平均池化 (空间 + 时间)
        self.gap = nn.AdaptiveAvgPool2d(1)  # 输出 [B, C, 1, 1]

        # 特征维度
        last_channels = channels[-1]

        # === 分类头 ===
        self.action_head = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(last_channels, 128),
            nn.ReLU(inplace=True),
            nn.Dropout(dropout * 0.5),
            nn.Linear(128, num_action_classes),
        )

        # === 质量评分 embedding 头 ===
        self.embedding_head = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(last_channels, embedding_dim),
            nn.ReLU(inplace=True),
            nn.LayerNorm(embedding_dim),
        )

        # 初始化权重
        self._init_weights()

    def _init_weights(self):
        """Xavier 初始化"""
        for m in self.modules():
            if isinstance(m, nn.Conv2d):
                nn.init.xavier_uniform_(m.weight, gain=1.0)
                if m.bias is not None:
                    nn.init.constant_(m.bias, 0)
            elif isinstance(m, nn.BatchNorm2d):
                nn.init.constant_(m.weight, 1)
                nn.init.constant_(m.bias, 0)
            elif isinstance(m, nn.Linear):
                nn.init.xavier_uniform_(m.weight, gain=1.0)
                if m.bias is not None:
                    nn.init.constant_(m.bias, 0)

    def forward(
        self, x: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        前向传播。

        参数:
            x: [B, C, T, V]  C=3 (x, y, confidence), T=帧数, V=17

        返回:
            action_logits: [B, num_classes] 动作分类 logits
            embedding: [B, embedding_dim] 质量评分嵌入
            A: [num_subsets, V, V] 实际使用的邻接矩阵
        """
        B, C, T, V = x.shape

        # 输入归一化
        x = self.input_bn(x)

        # 获取邻接矩阵
        A = self.graph.get_adjacency(x.device)  # [num_subsets, V, V]

        # ST-GCN 块
        for layer in self.stgcn_layers:
            x = layer(x, A)

        # 全局池化
        x = self.gap(x)  # [B, C, 1, 1]
        x = x.view(B, -1)  # [B, C]

        # 分类
        action_logits = self.action_head(x)  # [B, num_classes]

        # 嵌入
        embedding = self.embedding_head(x)  # [B, embedding_dim]

        return action_logits, embedding


# ============================================================
# 完整视觉推理模型 (ST-GCN + 质量评分)
# ============================================================

class VisionInferenceModel(nn.Module):
    """
    端到端视觉推理模型:
      ST-GCN (动作分类) + LightGBM (质量评分)

    注意: LightGBM 不是 PyTorch 模块, 通过 predict.py 调用。
    此处只提供 ST-GCN 部分, 质量评分在 inference_vision.py 中组合。
    """

    def __init__(self, stgcn: STGCN):
        super().__init__()
        self.stgcn = stgcn

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        参数:
            x: [B, C, T, V]

        返回:
            action_logits: [B, num_classes]
            embedding: [B, embedding_dim]
        """
        return self.stgcn(x)
