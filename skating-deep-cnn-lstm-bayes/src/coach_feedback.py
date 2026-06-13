"""Rule-based coach feedback engine — continuous score edition.

Generates structured score cards and Chinese coaching advice driven by
continuous quality scores (0–100) rather than discrete class labels.
"""

from __future__ import annotations

from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# Duration thresholds by action type (seconds)
# ---------------------------------------------------------------------------
DURATION_RANGES: Dict[str, tuple[float, float]] = {
    "weight_shift": (3.0, 6.0),
}

DEFAULT_DURATION_RANGE: tuple[float, float] = (2.0, 8.0)

# ---------------------------------------------------------------------------
# Threshold constants
# ---------------------------------------------------------------------------
MISSING_RATIO_HIGH = 0.15
MISSING_RATIO_LOW = 0.05
SIMILARITY_HIGH = 0.75
SIMILARITY_LOW = 0.40


def generate_coach_feedback(prediction: dict) -> dict:
    """Generate structured score card and coaching feedback from a prediction.

    Args:
        prediction: Inference result dict containing:
            - quality_score (float): 0-100 continuous quality score.
            - quality_label (str): Chinese label (优秀/良好/一般/不合格).
            - quality_prediction (dict or None): Model prediction details.
            - reference_similarity_score (float or None): 0-100 similarity.
            - action_label (str): Predicted action name.
            - duration (float): Segment duration in seconds.
            - missing_ratio (float): Fraction of missing sensor data.

    Returns:
        dict with keys ``score_card``, ``label``, ``summary``,
        ``positives``, ``issues``, ``advice``.
    """
    action_name: str = _extract_action_name(prediction)
    quality_score: float = float(prediction.get("quality_score", 0) or 0)
    quality_label: str = _extract_quality_label(prediction)
    duration: float = float(prediction.get("duration", 0.0))
    missing_ratio: float = float(prediction.get("missing_ratio", 0.0))
    raw_sim: float = float(prediction.get("reference_similarity_score") or 0)
    sim_score: float = raw_sim / 100.0 if raw_sim > 1.0 else raw_sim

    completeness: int = round((1.0 - missing_ratio) * 100)
    duration_ok: bool = _check_duration(action_name, duration)
    similarity_int: int = round(sim_score * 100)

    score_card: dict = {
        "overall": round(quality_score, 1),
        "completeness": completeness,
        "duration_ok": duration_ok,
        "similarity": similarity_int,
    }

    positives: list[str] = []
    issues: list[str] = []
    advice: list[str] = []

    _evaluate_completeness(missing_ratio, completeness, positives, issues)
    _evaluate_duration(action_name, duration, duration_ok, positives, issues, advice)
    _evaluate_continuous_score(quality_score, quality_label, positives, issues, advice)
    _evaluate_similarity(sim_score, positives, issues)

    summary: str = _build_summary(quality_label, quality_score)

    return {
        "score_card": score_card,
        "label": quality_label or "未知",
        "summary": summary,
        "positives": positives,
        "issues": issues,
        "advice": advice,
    }


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

def _extract_action_name(prediction: dict) -> str:
    action_label = prediction.get("action_label")
    if action_label:
        return str(action_label)
    pred_block = prediction.get("prediction")
    if isinstance(pred_block, dict):
        return str(pred_block.get("label_name", "unknown"))
    return "unknown"


def _extract_quality_label(prediction: dict) -> str:
    label = prediction.get("quality_label")
    if label:
        return str(label)
    qp = prediction.get("quality_prediction")
    if isinstance(qp, dict):
        # LightGBM path
        lgb_label = qp.get("quality_label")
        if lgb_label:
            return str(lgb_label)
        # Legacy GaussianNB path
        label = qp.get("label")
        if label:
            return str(label)
    return str(prediction.get("quality_level", ""))


# ---------------------------------------------------------------------------
# Duration
# ---------------------------------------------------------------------------

def _check_duration(action_name: str, duration: float) -> bool:
    low, high = DURATION_RANGES.get(action_name, DEFAULT_DURATION_RANGE)
    return low <= duration <= high


def _evaluate_duration(
    action_name: str,
    duration: float,
    duration_ok: bool,
    positives: list[str],
    issues: list[str],
    advice: list[str],
) -> None:
    if duration <= 0.0:
        return

    low, high = DURATION_RANGES.get(action_name, DEFAULT_DURATION_RANGE)

    if duration_ok:
        positives.append(f"动作时长 {duration:.1f}s，在合理范围内")
    elif duration < low:
        issues.append(f"动作时长 {duration:.1f}s，偏短（建议 {low:.0f}-{high:.0f}s）")
        advice.append("动作节奏偏快，建议放慢速度，确保每次重心转移充分到位")
    else:
        issues.append(f"动作时长 {duration:.1f}s，偏长（建议 {low:.0f}-{high:.0f}s）")
        advice.append("动作过程中可能有停顿，建议提高连贯性，减少中间停留")


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------

def _evaluate_completeness(
    missing_ratio: float,
    completeness: int,
    positives: list[str],
    issues: list[str],
) -> None:
    if missing_ratio > MISSING_RATIO_HIGH:
        issues.append(f"传感器数据缺失严重（完整度 {completeness}%），影响评估准确性")
    elif missing_ratio > MISSING_RATIO_LOW:
        issues.append(f"部分传感器节点数据缺失（完整度 {completeness}%），建议检查设备佩戴")
    else:
        positives.append(f"传感器数据完整（完整度 {completeness}%）")


# ---------------------------------------------------------------------------
# Continuous score evaluation — core of the new feedback engine
# ---------------------------------------------------------------------------

def _evaluate_continuous_score(
    quality_score: float,
    quality_label: str,
    positives: list[str],
    issues: list[str],
    advice: list[str],
) -> None:
    """Generate feedback based on continuous score bands with fine granularity."""
    score = quality_score

    # --- Score-band feedback (more granular than 4-class) ---
    if score >= 92.0:
        positives.append("动作完成度非常高，表现接近标准示范水平")
        positives.append("动作节奏、发力方式和身体控制均达到优秀水准")
        advice.append("保持当前动作质量和稳定性，可作为示范参考")
    elif score >= 85.0:
        positives.append("动作完成质量优秀，整体表现稳定")
        advice.append("保持当前动作节奏和稳定性，可作为示范参考")
    elif score >= 78.0:
        positives.append("动作完成质量良好，整体结构正确")
        issues.append("细节方面仍有提升空间，继续优化动作连贯性和发力节奏")
        advice.append("细节上仍有提升空间，注意重心转移的平滑度和节奏控制")
        advice.append("关注每次重心转移的完整性，避免局部代偿")
    elif score >= 70.0:
        issues.append("动作基本完成，但流畅度和稳定性存在不足")
        advice.append("建议降低练习速度，优先保证动作规范性和重心控制")
        advice.append("可分阶段练习：先稳定重心→再强化发力→最后连贯组合")
    elif score >= 62.0:
        issues.append("动作质量中等偏下，存在较明显的改进空间")
        advice.append("建议降低练习速度，优先保证动作规范性和重心控制")
        advice.append("可分阶段练习：先稳定重心→再强化发力→最后连贯组合")
        advice.append("关注发力链条的完整性，避免上半身过度代偿")
    elif score >= 55.0:
        issues.append("动作结构存在明显问题，与标准动作差距较大")
        advice.append("建议从基础分解动作开始练习，重点纠正发力方式")
        advice.append("可请教练进行一对一指导，纠正动作模式")
    elif score >= 40.0:
        issues.append("动作未达标，存在显著的结构性错误")
        advice.append("建议从基础动作开始重新练习，重点关注正确的发力方式")
        advice.append("可请教练进行一对一指导，纠正动作模式")
        advice.append("暂时不要追求速度，优先建立正确的动作框架")
    else:
        issues.append("动作严重偏离标准，可能代表错误的动作模式")
        advice.append("建议停止当前练习方式，请教练重新讲解动作要领")
        advice.append("从最基础的分解动作重新开始，确保每个环节规范后再组合")

    # --- Stability hints based on score proximity to thresholds ---
    # Scores near a threshold boundary indicate inconsistency
    fractional = score - int(score)
    near_lower = fractional < 0.3
    near_upper = fractional > 0.7

    if near_lower and score >= 60.0:
        advice.append("当前评分处于等级边缘，动作稳定性有波动，建议加强核心控制训练")
    elif near_upper and score >= 55.0:
        advice.append("评分接近更高等级，继续优化即可晋级，重点打磨细节")


# ---------------------------------------------------------------------------
# Reference similarity
# ---------------------------------------------------------------------------

def _evaluate_similarity(
    sim_score: float,
    positives: list[str],
    issues: list[str],
) -> None:
    if sim_score <= 0.0:
        return  # No similarity data available

    if sim_score > SIMILARITY_HIGH:
        positives.append("与优秀示范动作高度相似，运动模式接近标准")
    elif sim_score > 0.60:
        # Moderate similarity — no explicit issue, no praise
        pass
    elif sim_score > SIMILARITY_LOW:
        issues.append("与标准示范动作存在一定差异，建议对照示范调整动作路径")
    else:
        issues.append("与标准示范动作存在较大差异，建议对照示范视频调整动作路径和发力方式")


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def _build_summary(quality_label: str, quality_score: float) -> str:
    """Build a natural-language summary from the continuous score."""
    score = quality_score

    if score >= 92.0:
        return f"整体评分 {score:.1f} 分，动作完成度非常高，接近示范水准，继续保持。"
    elif score >= 85.0:
        return f"整体评分 {score:.1f} 分，动作完成优秀，整体结构扎实。"
    elif score >= 78.0:
        return f"整体评分 {score:.1f} 分，动作完成良好，仍有细节优化空间。"
    elif score >= 70.0:
        return f"整体评分 {score:.1f} 分，动作基本完成，稳定性和流畅度有待提升。"
    elif score >= 62.0:
        return f"整体评分 {score:.1f} 分，动作质量一般，存在较明显的改进空间，建议针对性优化。"
    elif score >= 55.0:
        return f"整体评分 {score:.1f} 分，动作存在结构性问题，需要从基础环节加强练习。"
    elif score >= 40.0:
        return f"整体评分 {score:.1f} 分，动作未达标，建议重新学习分解动作，打好基础。"
    else:
        return f"整体评分 {score:.1f} 分，动作严重偏离标准，建议在教练指导下重新练习。"
