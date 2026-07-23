"""Adapters that reshape RF inference results into the legacy API schema."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence


def build_top_predictions(
    classes: Sequence[int],
    probabilities: Sequence[float],
    action_labels: Dict[int, str],
    top_k: int,
) -> List[Dict[str, Any]]:
    """Convert predict_proba output into the legacy top_predictions list."""
    ranked = sorted(
        zip(classes, probabilities),
        key=lambda item: float(item[1]),
        reverse=True,
    )[:top_k]
    return [
        {
            "rank": rank,
            "label_id": int(label_id),
            "label_name": action_labels[int(label_id)],
            "probability": float(score),
        }
        for rank, (label_id, score) in enumerate(ranked, start=1)
    ]


def build_prediction_distribution(
    action_label_id: int,
    action_label_name: str,
    count: int = 1,
    total: int = 1,
) -> Dict[str, Dict[str, Any]]:
    """Build the legacy summary.prediction_distribution object."""
    percentage = 0.0 if total <= 0 else float(count) / float(total) * 100.0
    return {
        action_label_name: {
            "label_id": int(action_label_id),
            "count": int(count),
            "percentage": percentage,
        }
    }


def build_legacy_predict_response(
    *,
    filename: str,
    action_label_id: int,
    action_label_name: str,
    action_confidence: float,
    top_predictions: List[Dict[str, Any]],
    is_standard: Optional[bool],
    quality_prediction: Optional[Dict[str, Any]] = None,
    sample_index: int = 1,
    sensor_mode: str = "9node",
) -> Dict[str, Any]:
    """Build the old model-python API response shape expected by Spring Boot."""
    quality_level = None if quality_prediction is None else quality_prediction.get("label")
    quality_score = None if quality_prediction is None else quality_prediction.get("quality_score")
    return {
        "success": True,
        "filename": filename,
        "data": {
            "samples": 1,
            "window_size": None,
            "step_size": None,
            "sensor_mode": sensor_mode,
            "results": [
                {
                    "sample_index": int(sample_index),
                    "prediction": {
                        "label_id": int(action_label_id),
                        "label_name": action_label_name,
                        "confidence": float(action_confidence),
                    },
                    "quality_score": quality_score,
                    "quality_level": quality_level,
                    "quality_prediction": quality_prediction,
                    "similarity": None,
                    "is_standard": is_standard,
                    "top_predictions": top_predictions,
                }
            ],
            "summary": {
                "average_quality_score": quality_score,
                "best_quality_score": quality_score,
                "worst_quality_score": quality_score,
                "prediction_distribution": build_prediction_distribution(
                    action_label_id=action_label_id,
                    action_label_name=action_label_name,
                    count=1,
                    total=1,
                ),
            },
        },
    }
