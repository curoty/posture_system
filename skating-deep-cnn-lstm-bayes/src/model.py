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


# ---------------------------------------------------------------------------
# Structure-aware encoder for multi-class action recognition
# ---------------------------------------------------------------------------
#
# The flat [B, T, 54] input hides that channels come in groups of 6 per sensor
# node.  The baseline 1D-CNN convolves across the 54 dims as if they were
# unrelated, discarding that structure.  This encoder instead:
#   1. runs a *shared* per-node temporal CNN (9 nodes, weight-tied) — respects
#      the per-sensor grouping and is parameter-efficient (crucial for small
#      data);
#   2. applies cross-node self-attention (9 tokens) — explicitly models
#      inter-limb coordination, the intrinsic structure of a skating movement;
#   3. keeps the BiLSTM + temporal attention pooling for temporal dynamics.
#
# This borrows ST-GCN's core idea (respect body structure, model joint
# interaction) without ST-GCN's need for skeleton coordinates, which 9 sparse
# IMU nodes don't provide.


@dataclass(frozen=True)
class StructuredModelConfig:
    num_nodes: int = 9
    channels_per_node: int = 6          # 6 raw, or 8 with acc_mag/gyro_mag
    num_classes: int = 2
    node_conv_channels: Tuple[int, int] = (32, 48)
    node_kernel_sizes: Tuple[int, int] = (5, 3)
    cross_node_heads: int = 4
    lstm_hidden_dim: int = 128
    bidirectional: bool = True
    dropout: float = 0.3
    fc_hidden_dim: int = 128

    @property
    def node_feat_dim(self) -> int:
        return self.node_conv_channels[-1]

    @property
    def lstm_output_dim(self) -> int:
        return self.lstm_hidden_dim * (2 if self.bidirectional else 1)

    @property
    def embedding_dim(self) -> int:
        return self.lstm_output_dim

    def to_dict(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["node_conv_channels"] = list(self.node_conv_channels)
        payload["node_kernel_sizes"] = list(self.node_kernel_sizes)
        payload["node_feat_dim"] = int(self.node_feat_dim)
        payload["embedding_dim"] = int(self.embedding_dim)
        return payload

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "StructuredModelConfig":
        return cls(
            num_nodes=int(payload.get("num_nodes", 9)),
            channels_per_node=int(payload.get("channels_per_node", 6)),
            num_classes=int(payload["num_classes"]),
            node_conv_channels=tuple(int(c) for c in payload.get("node_conv_channels", (32, 48))),
            node_kernel_sizes=tuple(int(k) for k in payload.get("node_kernel_sizes", (5, 3))),
            cross_node_heads=int(payload.get("cross_node_heads", 4)),
            lstm_hidden_dim=int(payload.get("lstm_hidden_dim", 128)),
            bidirectional=bool(payload.get("bidirectional", True)),
            dropout=float(payload.get("dropout", 0.3)),
            fc_hidden_dim=int(payload.get("fc_hidden_dim", 128)),
        )


class StructuredIMUEncoder(nn.Module):
    """Node-aware encoder: per-node temporal conv -> cross-node attention ->
    BiLSTM -> attention pooling.  Input ``[B, T, num_nodes*channels_per_node]``.
    """

    def __init__(self, config: StructuredModelConfig) -> None:
        super().__init__()
        self.config = config
        n_ch = config.channels_per_node
        c1, c2 = config.node_conv_channels
        k1, k2 = config.node_kernel_sizes

        # (1) shared per-node temporal CNN — same weights applied to all 9 nodes
        self.node_conv = nn.Sequential(
            nn.Conv1d(n_ch, c1, kernel_size=k1, padding=k1 // 2),
            nn.BatchNorm1d(c1),
            nn.ReLU(),
            nn.Dropout(config.dropout * 0.5),
            nn.Conv1d(c1, c2, kernel_size=k2, padding=k2 // 2),
            nn.BatchNorm1d(c2),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2),
            nn.Dropout(config.dropout * 0.7),
        )

        # (2) cross-node self-attention over the 9 node tokens
        self.cross_node_attn = nn.MultiheadAttention(
            embed_dim=c2, num_heads=config.cross_node_heads,
            dropout=config.dropout, batch_first=True,
        )
        self.node_norm = nn.LayerNorm(c2)

        # (3) temporal model + attention pooling
        self.lstm = nn.LSTM(
            input_size=c2, hidden_size=config.lstm_hidden_dim,
            num_layers=1, batch_first=True, bidirectional=config.bidirectional,
        )
        self.temporal_attn = AdditiveSelfAttention(config.lstm_output_dim)

    def extract_embedding(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        b, t, flat = x.shape
        n, c = self.config.num_nodes, self.config.channels_per_node
        if flat != n * c:
            raise ValueError(f"Expected input dim {n*c}, got {flat}")

        # [B, T, N, C] -> per-node temporal conv (merge B and N, weight-shared)
        x = x.view(b, t, n, c).permute(0, 2, 3, 1).reshape(b * n, c, t)  # [B*N, C, T]
        feat = self.node_conv(x)                                         # [B*N, F, T']
        f, tp = feat.shape[1], feat.shape[2]
        feat = feat.view(b, n, f, tp).permute(0, 3, 1, 2).reshape(b * tp, n, f)  # [B*T', N, F]

        # cross-node attention over the N node tokens, residual + norm
        attended, _ = self.cross_node_attn(feat, feat, feat)
        feat = self.node_norm(feat + attended)
        fused = feat.mean(dim=1).view(b, tp, f)                          # [B, T', F]

        sequence, _ = self.lstm(fused)                                  # [B, T', 2H]
        context, weights = self.temporal_attn(sequence)                # [B, 2H]
        return context, weights


class StructuredActionClassifier(nn.Module):
    """Structure-aware multi-class action classifier.

    Mirrors ``CNNLSTMAttentionClassifier``'s forward interface so it is a
    drop-in for the downstream embedding-extraction / prediction code.
    """

    def __init__(self, config: StructuredModelConfig) -> None:
        super().__init__()
        self.config = config
        self.encoder = StructuredIMUEncoder(config)
        self.classifier = nn.Sequential(
            nn.Linear(config.embedding_dim, config.fc_hidden_dim),
            nn.ReLU(),
            nn.Dropout(config.dropout),
            nn.Linear(config.fc_hidden_dim, config.num_classes),
        )

    def extract_embedding(self, x: torch.Tensor) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
        return self.encoder.extract_embedding(x)

    def forward(
        self, x: torch.Tensor,
        return_embedding: bool = False, return_attention: bool = False,
    ) -> Any:
        embedding, attention_weights = self.encoder.extract_embedding(x)
        logits = self.classifier(embedding)
        if return_embedding and return_attention:
            return logits, embedding, attention_weights
        if return_embedding:
            return logits, embedding
        if return_attention:
            return logits, attention_weights
        return logits


# ---------------------------------------------------------------------------
# Self-supervised pretraining modules
# ---------------------------------------------------------------------------
#
# The single-class dataset makes a classification objective degenerate
# (softmax over one class is always 1.0 -> zero gradient -> the encoder never
# learns).  Instead we pretrain the encoder with a denoising-reconstruction
# autoencoder plus an optional contrastive objective.  The encoder is the exact
# same CNN-LSTM-Attention backbone as ``CNNLSTMAttentionClassifier`` so its
# learned weights can be loaded straight back into the classifier later for
# quality-feature extraction or, once multi-class data exists, a classifier
# head fine-tune.


class SequenceDecoder(nn.Module):
    """Reconstruct a full ``[B, T, input_dim]`` sequence from a pooled embedding.

    Reconstructing the whole motion from a single context vector forces the
    embedding to summarise the entire temporal trajectory (a strong bottleneck),
    which is exactly the representation the downstream quality model consumes.
    """

    def __init__(self, embedding_dim: int, sequence_length: int, output_dim: int,
                 hidden_dim: int = 128, dropout: float = 0.2) -> None:
        super().__init__()
        self.sequence_length = sequence_length
        self.expand = nn.Sequential(
            nn.Linear(embedding_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
        )
        self.rnn = nn.GRU(
            input_size=hidden_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.head = nn.Linear(hidden_dim * 2, output_dim)

    def forward(self, embedding: torch.Tensor) -> torch.Tensor:
        hidden = self.expand(embedding)                       # [B, H]
        repeated = hidden.unsqueeze(1).repeat(1, self.sequence_length, 1)  # [B, T, H]
        sequence, _ = self.rnn(repeated)                      # [B, T, 2H]
        return self.head(sequence)                            # [B, T, output_dim]


class ProjectionHead(nn.Module):
    """MLP projection head for contrastive (NT-Xent) learning."""

    def __init__(self, input_dim: int, hidden_dim: int = 128, output_dim: int = 64) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, output_dim),
        )

    def forward(self, embedding: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.net(embedding), dim=1)


class SSLPretrainer(nn.Module):
    """Wraps the classifier backbone with a decoder + projection head.

    The ``encoder`` attribute is a full ``CNNLSTMAttentionClassifier`` so that
    ``encoder.state_dict()`` is directly loadable by ``load_action_model`` — the
    downstream LightGBM pipeline needs no changes.  Only ``encoder.extract_embedding``
    is used during pretraining; the classifier head rides along unused.
    """

    def __init__(self, config: ActionModelConfig, sequence_length: int) -> None:
        super().__init__()
        self.encoder = CNNLSTMAttentionClassifier(config)
        self.decoder = SequenceDecoder(
            embedding_dim=config.embedding_dim,
            sequence_length=sequence_length,
            output_dim=config.input_dim,
        )
        self.projector = ProjectionHead(config.embedding_dim)

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        embedding, _attention = self.encoder.extract_embedding(x)
        return embedding

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        embedding = self.encode(x)
        reconstruction = self.decoder(embedding)
        projection = self.projector(embedding)
        return reconstruction, projection, embedding
