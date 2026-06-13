"""CNN + BiLSTM action classifier (ablation variant #2).

与完整模型的差异：
  - 保留：3层 Conv1D + BatchNorm + ReLU + Dropout + MaxPool1d（CNN骨干）
  - 保留：BiLSTM 时序建模层
  - 移除：Additive Self-Attention 层
  - 替代：LSTM 输出后使用全局平均池化（时间维度）替代 Attention 聚合

架构：
  Input (B, 128, 54)
    → Conv1d(54→64, k=5) → BN → ReLU → Dropout
    → Conv1d(64→128, k=5) → BN → ReLU → MaxPool1d(2) → Dropout
    → Conv1d(128→128, k=3) → BN → ReLU → Dropout
    → BiLSTM(128, h=128, bi) → (B, T', 256)
    → Global Mean Pool over time → (B, 256)
    → FC(256→128) → ReLU → Dropout → FC(128→7)

超参数与完整模型完全一致。
"""

from __future__ import annotations

from typing import Any, Tuple

import torch
import torch.nn as nn

# ---------------------------------------------------------------------------
# 模型标识
# ---------------------------------------------------------------------------

MODEL_NAME = "CNN+LSTM"
DESCRIPTION = "保留 CNN 骨干 + BiLSTM 时序建模，用平均池化替代 Self-Attention 进行时序聚合"


# ---------------------------------------------------------------------------
# 模型定义
# ---------------------------------------------------------------------------

class Model(nn.Module):
    """CNN + BiLSTM action classifier — no Attention.

    Input:  (B, T, C)  where T=128, C=54
    Output: (B, NUM_CLASSES) logits
    """

    def __init__(
        self,
        input_dim: int = 54,
        num_classes: int = 7,
        cnn_channels: Tuple[int, int, int] = (64, 128, 128),
        kernel_sizes: Tuple[int, int, int] = (5, 5, 3),
        lstm_hidden: int = 128,
        lstm_layers: int = 1,
        bidirectional: bool = True,
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

        # -------- BiLSTM（与完整模型一致）--------
        lstm_dropout = dropout if lstm_layers > 1 else 0.0
        self.lstm = nn.LSTM(
            input_size=c3,
            hidden_size=lstm_hidden,
            num_layers=lstm_layers,
            batch_first=True,
            dropout=lstm_dropout,
            bidirectional=bidirectional,
        )
        lstm_out = lstm_hidden * (2 if bidirectional else 1)  # 256

        # -------- 分类头 --------
        self.classifier = nn.Sequential(
            nn.Linear(lstm_out, fc_hidden),
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
        x = self.cnn(x)                     # (B, c3, T')
        x = x.transpose(1, 2)               # (B, T', c3)
        x, _ = self.lstm(x)                 # (B, T', lstm_out)

        # 全局平均池化（替代 Self-Attention）
        embedding = torch.mean(x, dim=1)     # (B, lstm_out)

        logits = self.classifier(embedding)  # (B, num_classes)

        if return_embedding:
            return logits, embedding
        return logits
