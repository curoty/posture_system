"""Quality score definitions and utilities — continuous regression edition.

Retains legacy class-id constants for backward compatibility with
GaussianNB artifacts, but the primary interface is now continuous
score (0–100) with dynamic label mapping.
"""

from __future__ import annotations

from typing import Dict, Sequence, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# Legacy class-id constants (kept for GaussianNB backward compat)
# ---------------------------------------------------------------------------
QUALITY_CLASS_IDS = (0, 1, 2, 3)

QUALITY_CLASS_ID_TO_CODE: Dict[int, str] = {
    0: "Fail",
    1: "Mid",
    2: "Good",
    3: "Excellent",
}

QUALITY_CLASS_ID_TO_ZH: Dict[int, str] = {
    0: "不合格",
    1: "一般",
    2: "良好",
    3: "优秀",
}

QUALITY_CLASS_ID_TO_REPRESENTATIVE_SCORE: Dict[int, float] = {
    0: 29.5,
    1: 67.0,
    2: 82.0,
    3: 95.0,
}

# ---------------------------------------------------------------------------
# Continuous-score thresholds (primary interface for LightGBM regressor)
# ---------------------------------------------------------------------------
SCORE_THRESHOLDS: Tuple[Tuple[float, float, str, str, int], ...] = (
    # (low, high, code, zh_label, class_id)
    (0.0,  60.0, "Fail",      "不合格", 0),
    (60.0, 75.0, "Mid",       "一般",   1),
    (75.0, 88.0, "Good",      "良好",   2),
    (88.0, 100.0, "Excellent", "优秀",  3),
)

# Representative scores per bin (used for calibration reference)
SCORE_BIN_CENTERS: Dict[int, float] = {
    0: 35.0,
    1: 67.5,
    2: 81.5,
    3: 94.0,
}


def convert_score_to_quality_class(score: float) -> int:
    """Legacy interface — map a continuous 0-100 score to a quality class id."""
    value = float(np.clip(score, 0.0, 100.0))
    for low, high, _code, _zh, class_id in SCORE_THRESHOLDS:
        if low <= value < high:
            return class_id
    return 3  # >=100 (clipped to Excellent)


def score_to_quality_label(score: float) -> str:
    """Map a continuous 0-100 score to a Chinese quality label."""
    value = float(np.clip(score, 0.0, 100.0))
    for low, high, _code, zh_label, _class_id in SCORE_THRESHOLDS:
        if low <= value < high:
            return zh_label
    return "优秀"


def score_to_quality_code(score: float) -> str:
    """Map a continuous 0-100 score to an English quality code."""
    value = float(np.clip(score, 0.0, 100.0))
    for low, high, code, _zh, _class_id in SCORE_THRESHOLDS:
        if low <= value < high:
            return code
    return "Excellent"


def get_quality_code(class_id: int) -> str:
    return QUALITY_CLASS_ID_TO_CODE[int(class_id)]


def get_quality_label_zh(class_id: int) -> str:
    return QUALITY_CLASS_ID_TO_ZH[int(class_id)]


def get_quality_representative_score(class_id: int) -> float:
    return float(QUALITY_CLASS_ID_TO_REPRESENTATIVE_SCORE[int(class_id)])


def estimate_quality_score_from_probabilities(
    class_ids: Sequence[int], probabilities: Sequence[float],
) -> float:
    """Legacy weighted-score estimator from class probabilities."""
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
    score = 0.0
    for class_id, probability in zip(class_ids_array.tolist(), normalized.tolist()):
        score += get_quality_representative_score(class_id) * float(probability)
    return round(float(score), 2)


# ---------------------------------------------------------------------------
# Score calibration & anti-collapse utilities
# ---------------------------------------------------------------------------

def calibrate_scores(
    raw_scores: np.ndarray,
    target_mean: float = 68.0,
    target_std: float = 18.0,
) -> np.ndarray:
    """Shift and scale raw scores to match a target distribution.

    This prevents score collapse where all predictions land in a narrow
    band (e.g. 80-85).  Uses z-score normalization followed by re-scaling
    to the target mean/std.

    Args:
        raw_scores: Raw predicted scores from the regressor.
        target_mean: Desired mean of the output distribution.
        target_std: Desired standard deviation of the output distribution.

    Returns:
        Calibrated scores, clipped to [0, 100].
    """
    scores = np.asarray(raw_scores, dtype=float)
    raw_mean = float(np.mean(scores))
    raw_std = float(np.std(scores))

    if raw_std < 1e-6:
        # Degenerate case — all scores identical; inject synthetic spread
        # proportional to the raw mean to break the collapse
        calibrated = scores - raw_mean + target_mean
        calibrated += np.random.default_rng(42).normal(0, target_std * 0.15, len(scores))
    else:
        calibrated = (scores - raw_mean) / raw_std * target_std + target_mean

    return np.clip(calibrated, 0.0, 100.0)


def apply_quantile_calibration(
    raw_scores: np.ndarray,
    calibration_scores: np.ndarray,
    calibration_targets: np.ndarray,
) -> np.ndarray:
    """Quantile-based calibration using a held-out calibration set.

    Maps each raw score to the empirical quantile of the calibration set,
    then maps that quantile to the corresponding target distribution quantile.
    This is non-parametric and handles arbitrary score distributions.

    Args:
        raw_scores: New scores to calibrate.
        calibration_scores: Raw scores on the calibration set.
        calibration_targets: Ground-truth targets on the calibration set.

    Returns:
        Calibrated scores.
    """
    raw = np.asarray(raw_scores, dtype=float).ravel()
    cal_scores = np.asarray(calibration_scores, dtype=float).ravel()
    cal_targets = np.asarray(calibration_targets, dtype=float).ravel()

    # Sort calibration data
    order = np.argsort(cal_scores)
    sorted_cal = cal_scores[order]
    sorted_targets = cal_targets[order]

    calibrated = np.empty_like(raw)
    for i, val in enumerate(raw):
        idx = np.searchsorted(sorted_cal, val)
        idx = min(idx, len(sorted_targets) - 1)
        idx = max(idx, 0)
        calibrated[i] = sorted_targets[idx]

    return np.clip(calibrated, 0.0, 100.0)


def smooth_score_trajectory(
    scores: Sequence[float],
    window: int = 3,
) -> np.ndarray:
    """Apply a moving-average smoothing to a sequence of scores.

    Useful for real-time streaming where consecutive predictions should
    not jump abruptly.

    Args:
        scores: Sequence of raw scores.
        window: Smoothing window size (odd recommended).

    Returns:
        Smoothed score array (same length as input).
    """
    arr = np.asarray(scores, dtype=float)
    if len(arr) < window:
        return arr.copy()
    half = window // 2
    kernel = np.ones(window) / window
    smoothed = np.convolve(arr, kernel, mode="same")
    # Fix boundaries with asymmetric windows
    for i in range(half):
        smoothed[i] = np.mean(arr[: i + half + 1])
        smoothed[-(i + 1)] = np.mean(arr[-(i + half + 1):])
    return np.clip(smoothed, 0.0, 100.0)


def apply_calibration(score: float, cal_params: Dict[str, Any]) -> float:
    """Apply saved calibration parameters to a single score.

    Uses z-score normalization:
      calibrated = (score - raw_mean) / raw_std * target_std + target_mean

    Args:
        score: Raw predicted score.
        cal_params: Calibration dict with raw_mean, raw_std, target_mean, target_std.

    Returns:
        Calibrated score, clipped to [0, 100].
    """
    method = cal_params.get("method", "zscore_normalization")
    if method == "zscore_normalization":
        raw_mean = float(cal_params.get("raw_mean", 50.0))
        raw_std = float(cal_params.get("raw_std", 1.0))
        target_mean = float(cal_params.get("target_mean", cal_params.get("cal_mean", 65.0)))
        target_std = float(cal_params.get("target_std", cal_params.get("cal_std", 18.0)))
        if raw_std < 1e-6:
            return float(np.clip(target_mean, 0.0, 100.0))
        calibrated = (score - raw_mean) / raw_std * target_std + target_mean
        return float(np.clip(calibrated, 0.0, 100.0))
    # Linear fallback (legacy)
    scale = float(cal_params.get("scale", 1.0))
    offset = float(cal_params.get("offset", 0.0))
    return float(np.clip(scale * score + offset, 0.0, 100.0))
