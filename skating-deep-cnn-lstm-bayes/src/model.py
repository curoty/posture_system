"""1D-CNN + BiLSTM + optional self-attention action classifier."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass(frozen=True)
class ActionModelConfig:
    input_dim: int
    num_classes: int
    cnn_channels: Tuple[int, int, int] = (64, 128, 128)
    kernel_sizes: Tuple[int, int, int] = (5, 5, 3)
    lstm_hidden_dim: int = 128
    lstm_layers: int = 1
    bidirectional: bool = True
    use_attention: bool = True
    dropout: float = 0.3
    fc_hidden_dim: int = 128

    @property
    def lstm_output_dim(self) -> int:
        return self.lstm_hidden_dim * (2 if self.bidirectional else 1)

    @property
    def embedding_dim(self) -> int:
        return self.lstm_output_dim

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["cnn_channels"] = list(self.cnn_channels)
        payload["kernel_sizes"] = list(self.kernel_sizes)
        payload["lstm_output_dim"] = int(self.lstm_output_dim)
        payload["embedding_dim"] = int(self.embedding_dim)
        return payload

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "ActionModelConfig":
        return cls(
            input_dim=int(payload["input_dim"]),
            num_classes=int(payload["num_classes"]),
            cnn_channels=tuple(int(item) for item in payload.get("cnn_channels", (64, 128, 128))),
            kernel_sizes=tuple(int(item) for item in payload.get("kernel_sizes", (5, 5, 3))),
            lstm_hidden_dim=int(payload.get("lstm_hidden_dim", 128)),
            lstm_layers=int(payload.get("lstm_layers", 1)),
            bidirectional=bool(payload.get("bidirectional", True)),
            use_attention=bool(payload.get("use_attention", True)),
            dropout=float(payload.get("dropout", 0.3)),
            fc_hidden_dim=int(payload.get("fc_hidden_dim", 128)),
        )


class AdditiveSelfAttention(nn.Module):
    def __init__(self, input_dim: int) -> None:
        super().__init__()
        self.score = nn.Sequential(
            nn.Linear(input_dim, input_dim),
            nn.Tanh(),
            nn.Linear(input_dim, 1),
        )

    def forward(self, sequence: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        scores = self.score(sequence).squeeze(-1)
        weights = F.softmax(scores, dim=1)
        context = torch.sum(sequence * weights.unsqueeze(-1), dim=1)
        return context, weights


class CNNLSTMAttentionClassifier(nn.Module):
    """Temporal action classifier for fixed-length IMU tensors.

    Input shape: ``[batch, sequence_length, input_dim]``.
    """

    def __init__(self, config: ActionModelConfig) -> None:
        super().__init__()
        self.config = config

        c1, c2, c3 = config.cnn_channels
        k1, k2, k3 = config.kernel_sizes
        self.cnn = nn.Sequential(
            nn.Conv1d(config.input_dim, c1, kernel_size=k1, padding=k1 // 2),
            nn.BatchNorm1d(c1),
            nn.ReLU(),
            nn.Dropout(config.dropout * 0.5),
            nn.Conv1d(c1, c2, kernel_size=k2, padding=k2 // 2),
            nn.BatchNorm1d(c2),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2),
            nn.Dropout(config.dropout * 0.7),
            nn.Conv1d(c2, c3, kernel_size=k3, padding=k3 // 2),
            nn.BatchNorm1d(c3),
            nn.ReLU(),
            nn.Dropout(config.dropout * 0.7),
        )
        self.lstm = nn.LSTM(
            input_size=c3,
            hidden_size=config.lstm_hidden_dim,
            num_layers=config.lstm_layers,
            batch_first=True,
            dropout=config.dropout if config.lstm_layers > 1 else 0.0,
            bidirectional=config.bidirectional,
        )
        self.attention: Optional[AdditiveSelfAttention]
        self.attention = AdditiveSelfAttention(config.lstm_output_dim) if config.use_attention else None
        self.classifier = nn.Sequential(
            nn.Linear(config.embedding_dim, config.fc_hidden_dim),
            nn.ReLU(),
            nn.Dropout(config.dropout),
            nn.Linear(config.fc_hidden_dim, config.num_classes),
        )

    def extract_embedding(self, x: torch.Tensor) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
        if x.ndim != 3:
            raise ValueError(f"Expected input shape [B, T, C], got {tuple(x.shape)}")
        if x.shape[-1] != self.config.input_dim:
            raise ValueError(f"Expected input_dim={self.config.input_dim}, got {x.shape[-1]}")

        x = x.transpose(1, 2)
        x = self.cnn(x)
        x = x.transpose(1, 2)
        sequence, _ = self.lstm(x)

        if self.attention is not None:
            return self.attention(sequence)

        return torch.mean(sequence, dim=1), None

    def forward(
        self,
        x: torch.Tensor,
        return_embedding: bool = False,
        return_attention: bool = False,
    ) -> Any:
        embedding, attention_weights = self.extract_embedding(x)
        logits = self.classifier(embedding)

        if return_embedding and return_attention:
            return logits, embedding, attention_weights
        if return_embedding:
            return logits, embedding
        if return_attention:
            return logits, attention_weights
        return logits


def build_model_from_config(payload: Dict[str, Any]) -> CNNLSTMAttentionClassifier:
    return CNNLSTMAttentionClassifier(ActionModelConfig.from_dict(payload))
