"""
多模态对齐器 (Late Fusion Aligner)
===================================
通过时间戳对齐视频和 IMU 的推理结果。

核心设计 (你提出的方案):
  - 两个管道各自独立推理 → 输出带 timestamp_end 的结果
  - Aligner 按 timestamp_end 匹配"同一窗口"的结果对
  - 匹配成功 → 融合; 匹配失败 → 单模态兜底

使用方式:
    aligner = MultimodalAligner()
    aligned = aligner.align(imu_results, vision_results)
    # aligned: [{"imu": ..., "vision": ..., "fused": {...}}, ...]
"""
from __future__ import annotations

import json
import time
import warnings
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

from .config import MULTIMODAL_CONFIG


# ============================================================
# 结果数据结构
# ============================================================

@dataclass
class InferenceResult:
    """统一推理结果。"""
    timestamp_start: float          # 窗口起始时间 (秒)
    timestamp_end: float            # 窗口结束时间 (秒) ← 这是对齐锚点
    action_label: str               # 动作类别
    action_confidence: float        # 动作置信度 [0, 1]
    quality_score: float            # 质量评分 [0, 100]
    quality_level: str              # 质量等级
    coaching_advice: str            # 教练建议
    embedding: Optional[List[float]] = None  # 特征嵌入
    modality: str = "unknown"       # "imu" | "vision"
    metadata: Dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict) -> "InferenceResult":
        return cls(
            timestamp_start=d.get("timestamp_start", 0.0),
            timestamp_end=d.get("timestamp_end", 0.0),
            action_label=d.get("action_label", "unknown"),
            action_confidence=d.get("action_confidence", 0.0),
            quality_score=d.get("quality_score", 50.0),
            quality_level=d.get("quality_level", "一般"),
            coaching_advice=d.get("coaching_advice", ""),
            embedding=d.get("embedding"),
            modality=d.get("modality", "unknown"),
            metadata=d.get("metadata", {}),
        )


@dataclass
class AlignedPair:
    """对齐后的一对结果。"""
    imu: Optional[InferenceResult] = None
    vision: Optional[InferenceResult] = None
    time_diff: float = 0.0  # 时间戳差值的绝对值

    @property
    def is_paired(self) -> bool:
        """是否成功配对 (双模态都有结果)。"""
        return self.imu is not None and self.vision is not None

    @property
    def is_single(self) -> bool:
        """是否只有单模态。"""
        return (self.imu is None) != (self.vision is None)


@dataclass
class FusedResult:
    """融合后的最终结果。"""
    timestamp_start: float
    timestamp_end: float
    action_label: str
    action_confidence: float
    quality_score: float
    quality_level: str
    coaching_advice: str
    fusion_strategy: str           # 使用的融合策略
    imu_available: bool
    vision_available: bool
    modality_agreement: Optional[bool] = None  # 双模态动作标签是否一致


# ============================================================
# 核心对齐器
# ============================================================

class MultimodalAligner:
    """
    多模态结果对齐器 (晚融合)。

    策略:
      1. 将 IMU 和视觉结果按 timestamp_end 排序
      2. 用最近邻匹配对齐对 (容忍时间差 ≤ tolerance)
      3. 配对成功 → 融合; 未配对 → 单模态兜底
    """

    def __init__(
        self,
        tolerance: float = 0.5,              # 对齐容忍度 (秒)
        fusion_strategy: str = "confidence_weighted",  # 融合策略
        imu_weight: float = 0.5,             # IMU 权重(未标定前保持均等)
        vision_weight: float = 0.5,           # 视觉权重
        fallback_to_single: bool = True,       # 允许单模态兜底
        weights_calibrated: bool = False,      # 是否已用实测表现标定过权重
    ):
        self.tolerance = tolerance
        self.fusion_strategy = fusion_strategy
        self.imu_weight = imu_weight
        self.vision_weight = vision_weight
        self.fallback_to_single = fallback_to_single
        self.weights_calibrated = weights_calibrated

        if fusion_strategy == "weighted" and not weights_calibrated:
            warnings.warn(
                "使用固定权重融合，但权重尚未标定 —— 在两个模态各自训练完并做过"
                "并行对比之前，任何非均等权重都是猜测。建议先用 "
                "'confidence_weighted'(按模型自身置信度动态加权)。",
                stacklevel=2,
            )

    def align(
        self,
        imu_results: List[Dict],
        vision_results: List[Dict],
    ) -> List[FusedResult]:
        """
        对齐 IMU 和视觉的推理结果。

        参数:
            imu_results: IMU 推理结果列表 (含 timestamp_end 等)
            vision_results: 视觉推理结果列表

        返回:
            fused_results: 融合后的统一结果列表
        """
        # 转为内部数据结构
        imu_list = [
            InferenceResult.from_dict(r) for r in imu_results
        ]
        vision_list = [
            InferenceResult.from_dict(r) for r in vision_results
        ]

        # 按 timestamp_end 排序
        imu_list.sort(key=lambda r: r.timestamp_end)
        vision_list.sort(key=lambda r: r.timestamp_end)

        # 最近邻匹配 (贪心)
        pairs = self._match_pairs(imu_list, vision_list)

        # 融合
        fused = []
        for pair in pairs:
            result = self._fuse(pair)
            if result is not None:
                fused.append(result)

        return fused

    def _match_pairs(
        self,
        imu_list: List[InferenceResult],
        vision_list: List[InferenceResult],
    ) -> List[AlignedPair]:
        """
        双指针最近邻匹配(两个列表均已按 timestamp_end 升序)。

        每个结果最多被消费一次:配对成功则双方同时前进; 否则把**时间戳更早**
        的那一个作为未配对结果输出并前进 —— 因为对方及其后续都只会更晚，
        这个更早的结果不可能再找到配对。

        原实现用 ``used_vision`` 集合追踪已配对索引，但主循环里对 ``j`` 的
        推进与该集合并不同步(配对后 j 已自增，集合判断永远为假)，导致收尾阶段
        可能重复输出或漏掉视觉结果。改为纯双指针后，每个元素恰好被处理一次，
        无需该集合。
        """
        pairs: List[AlignedPair] = []
        i, j = 0, 0

        while i < len(imu_list) and j < len(vision_list):
            imu = imu_list[i]
            vision = vision_list[j]
            time_diff = abs(imu.timestamp_end - vision.timestamp_end)

            if time_diff <= self.tolerance:
                pairs.append(AlignedPair(imu=imu, vision=vision, time_diff=time_diff))
                i += 1
                j += 1
            elif imu.timestamp_end < vision.timestamp_end:
                # IMU 更早且超出容忍度 → 它再也配不上任何视觉结果
                if self.fallback_to_single:
                    pairs.append(AlignedPair(imu=imu))
                i += 1
            else:
                # 视觉更早且超出容忍度 → 它再也配不上任何 IMU 结果
                if self.fallback_to_single:
                    pairs.append(AlignedPair(vision=vision))
                j += 1

        # 收尾:任一列表的剩余元素都不可能再配对
        if self.fallback_to_single:
            while i < len(imu_list):
                pairs.append(AlignedPair(imu=imu_list[i]))
                i += 1
            while j < len(vision_list):
                pairs.append(AlignedPair(vision=vision_list[j]))
                j += 1

        return pairs

    def _fuse(self, pair: AlignedPair) -> Optional[FusedResult]:
        """融合一对对齐的结果。"""
        if not pair.is_paired and not self.fallback_to_single:
            return None

        if pair.is_paired:
            # === 双模态融合 ===
            imu = pair.imu
            vis = pair.vision

            # 动作标签: 取置信度高的
            if imu.action_confidence >= vis.action_confidence:
                action_label = imu.action_label
                action_conf = imu.action_confidence
            else:
                action_label = vis.action_label
                action_conf = vis.action_confidence

            # 动作一致性检查
            modality_agreement = (imu.action_label == vis.action_label)

            # 质量评分: 按策略融合
            quality_score = self._fuse_quality(
                imu.quality_score, vis.quality_score,
                imu.action_confidence, vis.action_confidence,
            )

            # 融合策略描述
            fusion_strategy = (
                f"{self.fusion_strategy} (imu_w={self.imu_weight:.1f}, "
                f"vis_w={self.vision_weight:.1f})"
            )

            # 教练建议: 双模态都提供则拼接
            advice_parts = []
            if imu.coaching_advice:
                advice_parts.append(f"[IMU] {imu.coaching_advice}")
            if vis.coaching_advice:
                advice_parts.append(f"[视觉] {vis.coaching_advice}")
            coaching_advice = " | ".join(advice_parts)

            # 最终时间戳: 取平均
            ts_start = (imu.timestamp_start + vis.timestamp_start) / 2
            ts_end = (imu.timestamp_end + vis.timestamp_end) / 2

        elif pair.imu is not None:
            # === 纯 IMU 兜底 ===
            imu = pair.imu
            action_label = imu.action_label
            action_conf = imu.action_confidence
            quality_score = imu.quality_score
            coaching_advice = f"[单模态-IMU] {imu.coaching_advice}"
            ts_start, ts_end = imu.timestamp_start, imu.timestamp_end
            fusion_strategy = "imu_only_fallback"
            modality_agreement = None

        elif pair.vision is not None:
            # === 纯视觉兜底 ===
            vis = pair.vision
            action_label = vis.action_label
            action_conf = vis.action_confidence
            quality_score = vis.quality_score
            coaching_advice = f"[单模态-视觉] {vis.coaching_advice}"
            ts_start, ts_end = vis.timestamp_start, vis.timestamp_end
            fusion_strategy = "vision_only_fallback"
            modality_agreement = None

        else:
            return None

        # 质量等级
        quality_level = self._get_quality_level(quality_score)

        return FusedResult(
            timestamp_start=ts_start,
            timestamp_end=ts_end,
            action_label=action_label,
            action_confidence=round(action_conf, 4),
            quality_score=round(quality_score, 2),
            quality_level=quality_level,
            coaching_advice=coaching_advice,
            fusion_strategy=fusion_strategy,
            imu_available=pair.imu is not None,
            vision_available=pair.vision is not None,
            modality_agreement=modality_agreement,
        )

    def _fuse_quality(
        self,
        imu_q: float,
        vis_q: float,
        imu_conf: float,
        vis_conf: float,
    ) -> float:
        """
        质量评分融合。

        策略:
          - confidence_weighted: 按动作置信度加权平均
          - average: 简单平均
          - rule_based: 规则决策
        """
        if self.fusion_strategy == "average":
            return (imu_q + vis_q) / 2

        elif self.fusion_strategy == "confidence_weighted":
            total_conf = imu_conf + vis_conf
            if total_conf < 1e-6:
                return (imu_q + vis_q) / 2
            return (imu_q * imu_conf + vis_q * vis_conf) / total_conf

        elif self.fusion_strategy == "rule_based":
            # 规则: 如果 IMU 和视觉相差太大，取低分 (保守评估)
            diff = abs(imu_q - vis_q)
            if diff > 20:
                return min(imu_q, vis_q)  # 差异大 → 保守取低分
            else:
                return (imu_q + vis_q) / 2  # 差异小 → 平均

        else:
            # 加权平均
            w_sum = self.imu_weight + self.vision_weight
            return (
                imu_q * self.imu_weight + vis_q * self.vision_weight
            ) / w_sum

    def _get_quality_level(self, score: float) -> str:
        """等级阈值直接复用 IMU 侧的单一事实来源，避免两处阈值漂移。"""
        from src.quality_labels import score_to_quality_label
        return score_to_quality_label(score)

    def print_summary(self, fused_results: List[FusedResult]):
        """打印融合结果摘要。"""
        if not fused_results:
            print("无融合结果")
            return

        paired = sum(1 for r in fused_results if r.imu_available and r.vision_available)
        imu_only = sum(1 for r in fused_results if r.imu_available and not r.vision_available)
        vis_only = sum(1 for r in fused_results if r.vision_available and not r.imu_available)
        agreed = sum(
            1 for r in fused_results
            if r.modality_agreement is True
        )
        disagreed = sum(
            1 for r in fused_results
            if r.modality_agreement is False
        )

        avg_quality = np.mean([r.quality_score for r in fused_results])

        print(f"\n{'='*50}")
        print("多模态融合摘要")
        print(f"{'='*50}")
        print(f"总结果数:    {len(fused_results)}")
        print(f"双模态配对:  {paired}")
        print(f"仅 IMU:      {imu_only}")
        print(f"仅视觉:      {vis_only}")
        print(f"动作一致:    {agreed}")
        print(f"动作分歧:    {disagreed}")
        print(f"平均质量分:  {avg_quality:.1f}")
        print(f"=  融合策略:  {self.fusion_strategy}")


# ============================================================
# 命令行入口 (测试/演示)
# ============================================================

def demo_alignment():
    """演示对齐流程。"""
    # 模拟 IMU 结果
    imu_results = [
        {"timestamp_end": 2.0, "action_label": "weight_shift",
         "action_confidence": 0.92, "quality_score": 78.5, "modality": "imu"},
        {"timestamp_end": 4.0, "action_label": "weight_shift",
         "action_confidence": 0.88, "quality_score": 82.0, "modality": "imu"},
        {"timestamp_end": 6.0, "action_label": "weight_shift",
         "action_confidence": 0.95, "quality_score": 85.0, "modality": "imu"},
    ]

    # 模拟视觉结果
    vision_results = [
        {"timestamp_end": 2.1, "action_label": "weight_shift",
         "action_confidence": 0.85, "quality_score": 80.0, "modality": "vision"},
        {"timestamp_end": 4.2, "action_label": "weight_shift",
         "action_confidence": 0.76, "quality_score": 76.0, "modality": "vision"},
    ]

    aligner = MultimodalAligner(
        tolerance=0.5,
        fusion_strategy="confidence_weighted",
    )

    fused = aligner.align(imu_results, vision_results)
    aligner.print_summary(fused)

    print(f"\n详细结果:")
    for r in fused:
        print(
            f"  [{r.timestamp_end:.1f}s] {r.action_label} "
            f"(conf={r.action_confidence:.2f}) "
            f"Q={r.quality_score:.1f} {r.quality_level} "
            f"| {'✅' if r.modality_agreement else '⚠️' if r.modality_agreement is False else '➖'}"
            f" | {r.fusion_strategy}"
        )


if __name__ == "__main__":
    demo_alignment()
