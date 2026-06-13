"""CNN + Attention action classifier (ablation variant #3).

与完整模型的差异：
  - 保留：3层 Conv1D + BatchNorm + ReLU + Dropout + MaxPool1d（CNN骨干）
  - 保留：Additive Self-Attention 时序聚合层
  - 移除：BiLSTM 层
  - 替代：Attention 直接作用于 CNN 输出（而非 LSTM 输出）

架构：
  Input (B, 128, 54)
    → Conv1d(54→64, k=5) → BN → ReLU → Dropout
    → Conv1d(64→128, k=5) → BN → ReLU → MaxPool1d(2) → Dropout
    → Conv1d(128→128, k=3) → BN → ReLU → Dropout
    → AdditiveSelfAttention(128) → (B, 128)
    → FC(128→128) → ReLU → Dropout → FC(128→7)

注意：Attention 输入维度为 c3=128（CNN 输出通道），而非完整模型的 256（LSTM 输出维度）。

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

MODEL_NAME = "CNN+Attention"
DESCRIPTION = "保留 CNN 骨干 + Self-Attention 时序聚合，移除 BiLSTM 层"


# ---------------------------------------------------------------------------
# Self-Attention 模块（与完整模型一致）
# ---------------------------------------------------------------------------

class AdditiveSelfAttention(nn.Module):
    """Bahdanau-style additive attention for temporal aggregation."""

    def __init__(self, input_dim: int) -> None:
        super().__init__()
        self.score = nn.Sequential(
            nn.Linear(input_dim, input_dim),
            nn.Tanh(),
            nn.Linear(input_dim, 1),
        )

    def forward(self, sequence: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        scores = self.score(sequence).squeeze(-1)   # (B, T)
        weights = F.softmax(scores, dim=1)
        context = torch.sum(sequence * weights.unsqueeze(-1), dim=1)  # (B, D)
        return context, weights


# ---------------------------------------------------------------------------
# 模型定义
# ---------------------------------------------------------------------------

class Model(nn.Module):
    """CNN + Self-Attention action classifier — no LSTM.

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

        # -------- Self-Attention 直接作用于 CNN 输出 --------
        # Attention 输入维度 = CNN 输出通道 = c3 = 128
        self.attention = AdditiveSelfAttention(c3)

        # -------- 分类头 --------
        self.classifier = nn.Sequential(
            nn.Linear(c3, fc_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(fc_hidden, num_classes),
        )

    def forward(
        self,
        x: torch.Tensor,
        return_embedding: bool = False,
    ) -> Any:
        if x.ndim != 3:
            raise ValueError(f"Expected input shape [B, T, C], got {tuple(x.shape)}")
        x = x.transpose(1, 2)
        x = self.cnn(x)                     # (B, c3, T')
        x = x.transpose(1, 2)               # (B, T', c3)

        # Self-Attention 聚合（替代 LSTM 的时序编码 + Attention 聚合两步）
        embedding, _ = self.attention(x)     # (B, c3)

        logits = self.classifier(embedding)  # (B, num_classes)

        if return_embedding:
            return logits, embedding
        return logits
