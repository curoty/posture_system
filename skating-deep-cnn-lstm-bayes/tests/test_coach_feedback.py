"""Tests for the continuous-score coach_feedback engine."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.coach_feedback import generate_coach_feedback


def _make_prediction(
    quality_score: float,
    quality_label: str,
    duration: float = 4.5,
    missing_ratio: float = 0.02,
    sim_score: float | None = 85.0,
    action_name: str = "weight_shift",
) -> Dict[str, Any]:
    return {
        "quality_score": quality_score,
        "quality_label": quality_label,
        "quality_prediction": {
            "quality_score": quality_score,
            "quality_label": quality_label,
            "quality_code": quality_label,
            "scoring_model": "LightGBM",
        },
        "reference_similarity_score": sim_score,
        "prediction": {"label_name": action_name},
        "duration": duration,
        "missing_ratio": missing_ratio,
    }


def _has_text(items: list[str], keyword: str) -> bool:
    return any(keyword in item for item in items)


# ---------------------------------------------------------------------------
# Test 1: Score >= 92 + normal duration + low missing
# ---------------------------------------------------------------------------
def test_excellent_high_score() -> None:
    pred = _make_prediction(quality_score=95, quality_label="优秀")
    result = generate_coach_feedback(pred)

    assert result["label"] == "优秀"
    assert result["score_card"]["overall"] == 95.0
    assert result["score_card"]["completeness"] == 98
    assert result["score_card"]["duration_ok"] is True
    assert result["score_card"]["similarity"] == 85
    assert "95" in result["summary"]
    assert _has_text(result["positives"], "非常高")
    assert _has_text(result["positives"], "完整")
    assert _has_text(result["positives"], "合理")
    assert _has_text(result["positives"], "高度相似")
    assert len(result["issues"]) == 0


# ---------------------------------------------------------------------------
# Test 2: Score 78-85 + normal duration
# ---------------------------------------------------------------------------
def test_good_normal() -> None:
    pred = _make_prediction(quality_score=82, quality_label="良好")
    result = generate_coach_feedback(pred)

    assert result["label"] == "良好"
    assert result["score_card"]["overall"] == 82.0
    assert result["score_card"]["duration_ok"] is True
    assert "良好" in result["summary"]
    assert _has_text(result["positives"], "良好")
    assert _has_text(result["positives"], "完整")
    assert _has_text(result["positives"], "合理")
    # For score 78-85 band, "细节" is in issues
    assert any("细节" in item for item in result["issues"])
    assert any("重心" in item for item in result["advice"])


# ---------------------------------------------------------------------------
# Test 3: Score 62-70 + duration too short
# ---------------------------------------------------------------------------
def test_mid_short_duration() -> None:
    pred = _make_prediction(quality_score=65, quality_label="一般", duration=2.0, sim_score=60.0)
    result = generate_coach_feedback(pred)

    assert result["label"] == "一般"
    assert result["score_card"]["duration_ok"] is False
    assert "65" in result["summary"]
    assert _has_text(result["issues"], "偏短")
    assert _has_text(result["issues"], "中等偏下")
    assert any("节奏偏快" in item for item in result["advice"])
    assert any("降低练习速度" in item for item in result["advice"])


# ---------------------------------------------------------------------------
# Test 4: Score < 40 + duration too long + high missing
# ---------------------------------------------------------------------------
def test_fail_long_duration_high_missing() -> None:
    pred = _make_prediction(
        quality_score=35, quality_label="不合格", duration=8.0, missing_ratio=0.25, sim_score=30.0,
    )
    result = generate_coach_feedback(pred)

    assert result["label"] == "不合格"
    assert result["score_card"]["overall"] == 35.0
    assert result["score_card"]["completeness"] == 75
    assert result["score_card"]["duration_ok"] is False
    assert _has_text(result["issues"], "偏长")
    assert _has_text(result["issues"], "缺失严重")
    assert _has_text(result["issues"], "严重偏离")
    assert _has_text(result["issues"], "较大差异")
    assert any("停止当前练习" in item for item in result["advice"])
    assert any("重新讲解" in item for item in result["advice"])


# ---------------------------------------------------------------------------
# Test 5: High missing ratio warning
# ---------------------------------------------------------------------------
def test_high_missing_warning() -> None:
    pred = _make_prediction(quality_score=80, quality_label="良好", missing_ratio=0.20)
    result = generate_coach_feedback(pred)

    assert result["score_card"]["completeness"] == 80
    assert _has_text(result["issues"], "缺失严重")
    assert not _has_text(result["positives"], "完整度") or not any(
        "完整度 100" in item for item in result["positives"]
    )


# ---------------------------------------------------------------------------
# Test 6: Low similarity hint
# ---------------------------------------------------------------------------
def test_low_similarity_hint() -> None:
    pred = _make_prediction(quality_score=60, quality_label="一般", sim_score=35.0)
    result = generate_coach_feedback(pred)

    assert result["score_card"]["similarity"] == 35
    assert _has_text(result["issues"], "较大差异")
    assert not _has_text(result["positives"], "高度相似")


# ---------------------------------------------------------------------------
# Test 7: Score near threshold boundary (edge case)
# ---------------------------------------------------------------------------
def test_near_threshold_hint() -> None:
    """Score near a boundary should generate stability advice."""
    pred = _make_prediction(quality_score=60.2, quality_label="一般")
    result = generate_coach_feedback(pred)

    # Should hint about being near a grade boundary
    assert any("边缘" in item for item in result["advice"])
    assert result["score_card"]["overall"] == 60.2


# ---------------------------------------------------------------------------
# Test 8: Very high score (>=92)
# ---------------------------------------------------------------------------
def test_very_high_score() -> None:
    pred = _make_prediction(quality_score=94, quality_label="优秀")
    result = generate_coach_feedback(pred)

    assert result["label"] == "优秀"
    assert _has_text(result["positives"], "非常高")
    assert "示范" in result["summary"]
    assert len(result["issues"]) == 0
