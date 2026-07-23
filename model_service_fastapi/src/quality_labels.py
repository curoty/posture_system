"""Shared quality-label definitions and score-band helpers."""

from __future__ import annotations

from typing import Dict
from typing import Sequence

import numpy as np


QUALITY_CLASS_IDS = (0, 1, 2, 3)

QUALITY_CLASS_ID_TO_CODE: Dict[int, str] = {
    0: "Fail",
    1: "Mid",
    2: "Good",
    3: "Excellent",
}

QUALITY_CLASS_ID_TO_ZH: Dict[int, str] = {
    0: "不及格",
    1: "中等",
    2: "良好",
    3: "优秀",
}

QUALITY_SCORE_BANDS: Dict[int, str] = {
    0: "0-59",
    1: "60-74",
    2: "75-89",
    3: "90-100",
}

QUALITY_CLASS_ID_TO_REPRESENTATIVE_SCORE: Dict[int, float] = {
    0: 29.5,
    1: 67.0,
    2: 82.0,
    3: 95.0,
}


def convert_score_to_quality_class(score: float) -> int:
    """Convert a continuous quality score into a 4-class label."""
    score_value = float(score)
    if 90.0 <= score_value <= 100.0:
        return 3
    if 75.0 <= score_value < 90.0:
        return 2
    if 60.0 <= score_value < 75.0:
        return 1
    if 0.0 <= score_value < 60.0:
        return 0
    raise ValueError(f"Quality score is out of supported range [0, 100]: {score_value}")


def get_quality_code(class_id: int) -> str:
    return QUALITY_CLASS_ID_TO_CODE[int(class_id)]


def get_quality_label_zh(class_id: int) -> str:
    return QUALITY_CLASS_ID_TO_ZH[int(class_id)]


def get_quality_score_band(class_id: int) -> str:
    return QUALITY_SCORE_BANDS[int(class_id)]


def get_quality_representative_score(class_id: int) -> float:
    return float(QUALITY_CLASS_ID_TO_REPRESENTATIVE_SCORE[int(class_id)])


def estimate_quality_score_from_probabilities(class_ids: Sequence[int], probabilities: Sequence[float]) -> float:
    """Estimate a continuous quality score from class probabilities."""
    if len(class_ids) != len(probabilities):
        raise ValueError("class_ids and probabilities must have the same length.")
    if not class_ids:
        raise ValueError("At least one class probability is required.")

    class_ids_array = np.asarray(class_ids, dtype=int)
    probabilities_array = np.asarray(probabilities, dtype=float)
    total = float(np.sum(probabilities_array))
    if total <= 0.0:
        predicted_class = int(class_ids_array[int(np.argmax(probabilities_array))])
        return round(get_quality_representative_score(predicted_class), 2)

    normalized = probabilities_array / total
    expected_score = 0.0
    for class_id, probability in zip(class_ids_array.tolist(), normalized.tolist()):
        expected_score += get_quality_representative_score(int(class_id)) * float(probability)
    return round(float(expected_score), 2)
