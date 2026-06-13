"""Reference-action similarity scoring for quality estimation."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from src.quality_labels import convert_score_to_quality_class, get_quality_code, get_quality_label_zh


@dataclass(frozen=True)
class SimilarityScoringConfig:
    top_k: int = 5
    embedding_weight: float = 0.45
    temporal_weight: float = 0.35
    duration_weight: float = 0.10
    completeness_weight: float = 0.10
    temporal_distance_scale: float = 2.0
    score_multiplier: float = 100.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: Optional[Dict[str, Any]]) -> "SimilarityScoringConfig":
        if payload is None:
            return cls()
        return cls(
            top_k=int(payload.get("top_k", 5)),
            embedding_weight=float(payload.get("embedding_weight", 0.45)),
            temporal_weight=float(payload.get("temporal_weight", 0.35)),
            duration_weight=float(payload.get("duration_weight", 0.10)),
            completeness_weight=float(payload.get("completeness_weight", 0.10)),
            temporal_distance_scale=float(payload.get("temporal_distance_scale", 2.0)),
            score_multiplier=float(payload.get("score_multiplier", 100.0)),
        )


@dataclass(frozen=True)
class ReferenceLibrary:
    embeddings: np.ndarray
    sequences: np.ndarray
    action_names: np.ndarray
    metadata: List[Dict[str, Any]]
    config: SimilarityScoringConfig
    source_path: str


def _safe_normalize_rows(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    norms = np.where(norms < 1e-8, 1.0, norms)
    return values / norms


def _duration_similarity(candidate_duration: float, reference_durations: np.ndarray) -> np.ndarray:
    reference = reference_durations.astype(np.float32)
    candidate = float(candidate_duration)
    denominator = np.maximum(np.maximum(np.abs(reference), abs(candidate)), 1e-3)
    diff_ratio = np.abs(candidate - reference) / denominator
    return np.exp(-diff_ratio).astype(np.float32)


def _completeness_similarity(candidate_missing_ratio: float, reference_missing_ratios: np.ndarray) -> np.ndarray:
    candidate_valid_ratio = 1.0 - float(candidate_missing_ratio)
    reference_valid_ratio = 1.0 - reference_missing_ratios.astype(np.float32)
    return np.clip(np.minimum(candidate_valid_ratio, reference_valid_ratio), 0.0, 1.0).astype(np.float32)


def extract_similarity_features(
    sequence: np.ndarray,
    embedding: np.ndarray,
    action_name: str,
    duration_seconds: float,
    missing_node_ratio: float,
    reference_library: ReferenceLibrary,
    top_k: int = 5,
) -> Dict[str, float]:
    """Lightweight similarity feature extraction for LightGBM regression input.

    Returns a compact feature dict without the full scoring payload.
    Intended as a feature-engineering step before regression, not as a
    standalone quality score.
    """
    result = score_sequence_against_references(
        sequence=sequence,
        embedding=embedding,
        action_name=action_name,
        duration_seconds=duration_seconds,
        missing_node_ratio=missing_node_ratio,
        reference_library=reference_library,
        top_k=top_k,
    )
    if not result.get("success", False):
        return {
            "sim_top1": 0.0,
            "sim_topk_mean": 0.0,
            "sim_temporal_align": 0.0,
            "sim_embedding_best": 0.0,
            "sim_count": 0.0,
        }

    matches = result.get("top_matches", [])
    if not matches:
        return {
            "sim_top1": 0.0,
            "sim_topk_mean": 0.0,
            "sim_temporal_align": 0.0,
            "sim_embedding_best": 0.0,
            "sim_count": 0.0,
        }

    top1 = float(matches[0]["overall_similarity"])
    topk_mean = float(np.mean([m["overall_similarity"] for m in matches]))
    temporal_align = float(matches[0].get("temporal_similarity", 0.0))
    embedding_best = float(matches[0].get("embedding_similarity", 0.0))

    return {
        "sim_top1": top1,
        "sim_topk_mean": topk_mean,
        "sim_temporal_align": temporal_align,
        "sim_embedding_best": embedding_best,
        "sim_count": float(len(matches)),
    }


def load_reference_library(path: str | Path) -> ReferenceLibrary:
    library_path = Path(path)
    if library_path.is_dir():
        library_path = library_path / "reference_library.npz"
    metadata_path = library_path.with_name("reference_metadata.json")
    if not library_path.exists():
        raise FileNotFoundError(f"Reference library not found: {library_path}")
    if not metadata_path.exists():
        raise FileNotFoundError(f"Reference metadata not found: {metadata_path}")

    arrays = np.load(library_path, allow_pickle=False)
    metadata_payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    scoring_config = SimilarityScoringConfig.from_dict(metadata_payload.get("similarity_scoring_config"))
    return ReferenceLibrary(
        embeddings=arrays["embeddings"].astype(np.float32),
        sequences=arrays["sequences"].astype(np.float32),
        action_names=arrays["action_names"].astype(str),
        metadata=[dict(row) for row in metadata_payload.get("references", [])],
        config=scoring_config,
        source_path=str(library_path),
    )


def score_sequence_against_references(
    sequence: np.ndarray,
    embedding: np.ndarray,
    action_name: str,
    duration_seconds: float,
    missing_node_ratio: float,
    reference_library: ReferenceLibrary,
    top_k: Optional[int] = None,
) -> Dict[str, Any]:
    action_mask = reference_library.action_names == str(action_name)
    candidate_indices = np.flatnonzero(action_mask)
    if len(candidate_indices) == 0:
        return {
            "success": False,
            "skip_reason": "no_reference_for_action",
            "action_name": str(action_name),
            "scoring_model": "reference_similarity_v1",
        }

    config = reference_library.config
    effective_top_k = int(top_k or config.top_k)
    effective_top_k = max(1, min(effective_top_k, len(candidate_indices)))

    reference_embeddings = reference_library.embeddings[candidate_indices]
    reference_sequences = reference_library.sequences[candidate_indices]
    candidate_embedding = np.asarray(embedding, dtype=np.float32).reshape(1, -1)
    candidate_sequence = np.asarray(sequence, dtype=np.float32)

    embedding_similarity = (
        _safe_normalize_rows(reference_embeddings)
        @ _safe_normalize_rows(candidate_embedding).reshape(-1)
    )
    embedding_similarity = np.clip((embedding_similarity + 1.0) * 0.5, 0.0, 1.0).astype(np.float32)

    temporal_rmse = np.sqrt(np.mean((reference_sequences - candidate_sequence) ** 2, axis=(1, 2)))
    temporal_similarity = np.exp(-temporal_rmse / max(float(config.temporal_distance_scale), 1e-6)).astype(np.float32)

    reference_durations = np.asarray(
        [float(reference_library.metadata[int(index)].get("duration_seconds", 0.0)) for index in candidate_indices],
        dtype=np.float32,
    )
    reference_missing = np.asarray(
        [float(reference_library.metadata[int(index)].get("missing_node_ratio", 0.0)) for index in candidate_indices],
        dtype=np.float32,
    )
    duration_similarity = _duration_similarity(duration_seconds, reference_durations)
    completeness_similarity = _completeness_similarity(missing_node_ratio, reference_missing)

    weight_total = (
        config.embedding_weight
        + config.temporal_weight
        + config.duration_weight
        + config.completeness_weight
    )
    if weight_total <= 0.0:
        raise ValueError("Similarity scoring weights must sum to a positive value.")

    overall = (
        config.embedding_weight * embedding_similarity
        + config.temporal_weight * temporal_similarity
        + config.duration_weight * duration_similarity
        + config.completeness_weight * completeness_similarity
    ) / weight_total
    overall = np.clip(overall, 0.0, 1.0).astype(np.float32)

    ranked_local = np.argsort(overall)[::-1][:effective_top_k]
    top_overall = overall[ranked_local]
    softmax_weights = np.exp(top_overall - np.max(top_overall))
    softmax_weights = softmax_weights / np.sum(softmax_weights)
    aggregated_similarity = float(np.sum(top_overall * softmax_weights))
    score = round(float(np.clip(aggregated_similarity * config.score_multiplier, 0.0, 100.0)), 2)
    class_id = convert_score_to_quality_class(score)

    matches: List[Dict[str, Any]] = []
    for rank, local_index in enumerate(ranked_local.tolist(), start=1):
        reference_index = int(candidate_indices[local_index])
        reference_meta = dict(reference_library.metadata[reference_index])
        matches.append(
            {
                "rank": int(rank),
                "reference_index": reference_index,
                "reference_id": str(reference_meta.get("reference_id", reference_meta.get("jsonl_id", reference_index))),
                "action_name": str(reference_meta.get("action_type", action_name)),
                "overall_similarity": float(overall[local_index]),
                "embedding_similarity": float(embedding_similarity[local_index]),
                "temporal_similarity": float(temporal_similarity[local_index]),
                "duration_similarity": float(duration_similarity[local_index]),
                "completeness_similarity": float(completeness_similarity[local_index]),
            }
        )

    return {
        "success": True,
        "scoring_model": "reference_similarity_v1",
        "reference_library": reference_library.source_path,
        "action_name": str(action_name),
        "quality_score": score,
        "quality_level": get_quality_label_zh(class_id),
        "quality_code": get_quality_code(class_id),
        "class_id": int(class_id),
        "overall_similarity": aggregated_similarity,
        "top_k": int(effective_top_k),
        "components": {
            "embedding_weight": float(config.embedding_weight),
            "temporal_weight": float(config.temporal_weight),
            "duration_weight": float(config.duration_weight),
            "completeness_weight": float(config.completeness_weight),
        },
        "top_matches": matches,
    }
