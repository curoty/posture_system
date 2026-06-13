"""CNN-only action classifier (ablation variant #1).

与完整模型的差异：
  - 保留：3层 Conv1D + BatchNorm + ReLU + Dropout + MaxPool1d（CNN骨干）
  - 移除：BiLSTM 层
  - 移除：Additive Self-Attention 层
  - 替代：CNN 输出后使用全局平均池化（时间维度）聚合为固定长度向量

架构：
  Input (B, 128, 54)
    → Conv1d(54→64, k=5) → BN → ReLU → Dropout
    → Conv1d(64→128, k=5) → BN → ReLU → MaxPool1d(2) → Dropout
    → Conv1d(128→128, k=3) → BN → ReLU → Dropout
    → Global Mean Pool over time → (B, 128)
    → FC(128→128) → ReLU → Dropout → FC(128→7)

超参数与完整模型完全一致。
"""

from __future__ import annotations

from typing import Any, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

# ---------------------------------------------------------------------------
# 模型标识
# ---------------------------------------------------------------------------

MODEL_NAME = "CNN-only"
DESCRIPTION = "仅保留 CNN 骨干，用全局平均池化替代 LSTM 和 Attention 进行时序聚合"


# ---------------------------------------------------------------------------
# 模型定义
# ---------------------------------------------------------------------------

class Model(nn.Module):
    """CNN-only action classifier — no LSTM, no Attention.

    Input:  (B, T, C)  where T=128, C=54
    Output: (B, NUM_CLASSES) logits
    """

    def __init__(
        self,
        input_dim: int = 54,
        num_classes: int = 7,
        cnn_channels: Tuple[int, int, int] = (64, 128, 128),
        kernel_sizes: Tuple[int, int, int] = (5, 5, 3),
        dropout: float = 0.3,
        fc_hidden: int = 128,
    ) -> None:
        super().__init__()
        c1, c2, c3 = cnn_channels
        k1, k2, k3 = kernel_sizes

        # -------- CNN backbone（与完整模型一致）--------
        self.cnn = nn.Sequential(
            nn.Conv1d(input_dim, c1, k1, padding=k1 // 2),
            nn.BatchNorm1d(c1),
            nn.ReLU(),
            nn.Dropout(dropout * 0.5),
            nn.Conv1d(c1, c2, k2, padding=k2 // 2),
            nn.BatchNorm1d(c2),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2),
            nn.Dropout(dropout * 0.7),
            nn.Conv1d(c2, c3, k3, padding=k3 // 2),
            nn.BatchNorm1d(c3),
            nn.ReLU(),
            nn.Dropout(dropout * 0.7),
        )

        # CNN 输出通道数 = c3 = 128
        # 聚合后的向量维度 = c3（全局平均池化后每个通道一个值）
        embed_dim = c3

        # -------- 分类头 --------
        self.classifier = nn.Sequential(
            nn.Linear(embed_dim, fc_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(fc_hidden, num_classes),
        )

    def forward(
        self,
        x: torch.Tensor,
        return_embedding: bool = False,
    ) -> Any:
        # x: (B, T, C) → (B, C, T) for Conv1d
        if x.ndim != 3:
            raise ValueError(f"Expected input shape [B, T, C], got {tuple(x.shape)}")
        x = x.transpose(1, 2)
        x = self.cnn(x)                    # (B, c3, T')
        x = x.transpose(1, 2)              # (B, T', c3)

        # 全局平均池化（替代 LSTM + Attention）
        embedding = torch.mean(x, dim=1)    # (B, c3)

        logits = self.classifier(embedding)  # (B, num_classes)

        if return_embedding:
            return logits, embedding
        return logits
