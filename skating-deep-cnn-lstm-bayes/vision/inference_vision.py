"""
视觉推理管线
============
端到端推理: 视频 → 关键点 → ST-GCN → 动作分类 + 质量评分。

输出格式与 IMU 侧一致，便于多模态对齐。
"""
from __future__ import annotations

import json
import os
import time
import warnings
from dataclasses import asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import joblib
import numpy as np
import torch
import torch.nn.functional as F

from .config import (
    INFER_CONFIG,
    KEYPOINT_NAMES,
    NUM_JOINTS,
    STGCNConfig,
)
from .pose_extractor import (
    RTMPoseExtractor,
    interpolate_missing_keypoints,
    normalize_keypoints,
    sliding_windows,
    smooth_keypoints,
)
from .skeleton_graph import extract_handcrafted_features, extract_velocity_features
from .stgcn_model import STGCN, VisionInferenceModel


class VisionInferencePipeline:
    """
    视觉推理管线。

    流水线:
      视频 → RTMPose 关键点提取 → 预处理 → 滑动窗口
        → ST-GCN 推理 → 动作分类 + Embedding
        → 质量评分 (LightGBM) → 教练反馈 → 结果输出
    """

    def __init__(
        self,
        stgcn_checkpoint: Optional[str] = None,
        quality_model_path: Optional[str] = None,
        device: Optional[str] = None,
        config: Optional[type] = None,
    ):
        self.config = config or INFER_CONFIG
        self.device = device or self.config.rtmpose_device
        if self.device == "cuda" and not torch.cuda.is_available():
            self.device = "cpu"
            print("[警告] CUDA 不可用，回退到 CPU")

        # 初始化 RTMPose 提取器
        self.pose_extractor = RTMPoseExtractor(
            device=self.device,
            model_name=self.config.rtmpose_model_name,
            conf_threshold=self.config.rtmpose_conf_threshold,
        )

        # 加载 ST-GCN
        ckpt_path = stgcn_checkpoint or self.config.model_checkpoint
        self.stgcn = self._load_stgcn(ckpt_path)

        # 加载质量评分模型 (LightGBM)
        q_path = quality_model_path or self.config.quality_model_path
        self.quality_model = self._load_quality_model(q_path)

        print(f"[视觉推理管线] 就绪 | device={self.device}")

    def _load_stgcn(self, checkpoint_path: str) -> STGCN:
        """加载 ST-GCN 模型。

        模型结构与类别数一律**从 checkpoint 读取**，不写死。原实现硬编码
        ``num_action_classes=1``，既踩了单类别零梯度陷阱，又会在加载多类别
        权重时因分类头 shape 不匹配而崩溃。
        """
        if not os.path.exists(checkpoint_path):
            raise FileNotFoundError(
                f"ST-GCN 检查点不存在: {checkpoint_path}\n"
                f"  推理必须使用训练好的模型 —— 未训练的随机权重会输出无意义结果。"
            )

        ckpt = torch.load(checkpoint_path, map_location=self.device)
        if "model_state_dict" not in ckpt:
            raise ValueError(f"检查点缺少 model_state_dict: {checkpoint_path}")

        saved_cfg = ckpt.get("stgcn_config", {})
        self.label_map: Dict[str, int] = ckpt.get("label_map", {})
        if not self.label_map:
            raise ValueError(
                f"检查点缺少 label_map，无法把类别 id 还原成动作名: {checkpoint_path}"
            )
        self.id_to_label = {i: name for name, i in self.label_map.items()}

        model = STGCN(
            in_channels=saved_cfg.get("in_channels", 3),
            num_joints=saved_cfg.get("num_joints", NUM_JOINTS),
            graph_args=saved_cfg.get("graph_args", {"layout": "coco_17", "strategy": "spatial"}),
            edge_importance_weighting=saved_cfg.get("edge_importance_weighting", True),
            channels=saved_cfg.get("stgcn_channels", [64, 64, 128, 128, 256, 256]),
            temporal_kernel_size=saved_cfg.get("temporal_kernel_size", 9),
            dropout=saved_cfg.get("dropout", 0.3),
            num_action_classes=len(self.label_map),
            embedding_dim=saved_cfg.get("embedding_dim", 256),
        ).to(self.device)

        model.load_state_dict(ckpt["model_state_dict"])
        model.eval()
        print(f"[ST-GCN] 已加载: {checkpoint_path} | 类别={self.label_map}")
        return model

    def _load_quality_model(self, model_path: str):
        """加载视觉侧专属的 LightGBM 质量评分模型。"""
        if os.path.exists(model_path):
            model = joblib.load(model_path)
            print(f"[质量模型] 已加载: {model_path}")
            return model
        # 不静默返回 None 后又用 50.0 兜底——那会让"没模型"伪装成"评了个中等分"
        warnings.warn(
            f"视觉质量模型不存在: {model_path}\n"
            f"  → quality_score 将标记为 None(不可用)，而非伪造一个默认分。",
            stacklevel=2,
        )
        return None

    def process_video(
        self,
        video_path: str,
        max_frames: Optional[int] = None,
        frame_stride: int = 1,
        save_visualization: bool = False,
        progress_callback=None,
    ) -> List[Dict]:
        """
        处理单个视频文件。

        参数:
            video_path: 视频文件路径
            max_frames: 最多处理帧数
            frame_stride: 跳帧步长
            save_visualization: 是否保存骨骼可视化
            progress_callback: 进度回调

        返回:
            results: [
                {
                    "timestamp_start": float,
                    "timestamp_end": float,
                    "action_label": str,
                    "action_confidence": float,
                    "quality_score": float,
                    "quality_level": str,
                    "coaching_advice": str,
                    "embedding": [float],  # 原始嵌入
                }
            ]
        """
        video_start_time = time.time()
        print(f"\n[推理] 开始处理: {video_path}")

        # === 第1步: 提取关键点 ===
        print("[1/4] RTMPose 关键点提取...")
        keypoints, timestamps, fps = self.pose_extractor.extract_from_video(
            video_path, max_frames=max_frames, stride=frame_stride,
            progress_callback=progress_callback,
        )
        print(f"  → {keypoints.shape[0]} 帧, {fps:.1f} fps")

        # === 第2步: 预处理 ===
        print("[2/4] 预处理...")
        keypoints = interpolate_missing_keypoints(keypoints, method="linear")
        keypoints = normalize_keypoints(keypoints, center="hip")
        keypoints = smooth_keypoints(keypoints, window=self.config.smooth_window)
        print(f"  → 插值+归一化+平滑完成")

        # === 第3步: 滑动窗口推理 ===
        print("[3/4] ST-GCN 滑动窗口推理...")
        window_frames = int(self.config.window_seconds * self.config.fps)
        step_frames = int(self.config.step_seconds * self.config.fps)

        windows = sliding_windows(
            keypoints, timestamps,
            window_frames=window_frames,
            step_frames=step_frames,
        )
        print(f"  → {len(windows)} 个窗口")

        results = []
        for w_idx, window in enumerate(windows):
            result = self._infer_window(window, w_idx, len(windows))
            if result:
                results.append(result)

        # === 第4步: 可视化 (可选) ===
        if save_visualization and self.config.save_visualization:
            viz_dir = self.config.visualization_dir
            os.makedirs(viz_dir, exist_ok=True)
            from .pose_extractor import visualize_skeleton_sequence
            viz_path = os.path.join(
                viz_dir,
                Path(video_path).stem + "_skeleton.mp4"
            )
            visualize_skeleton_sequence(keypoints, viz_path, fps=fps)
            print(f"[4/4] 可视化 -> {viz_path}")

        elapsed = time.time() - video_start_time
        print(f"\n[推理] 完成! {len(results)} 个结果, 耗时 {elapsed:.1f}s")

        return results

    @torch.no_grad()
    def _infer_window(
        self,
        window: Dict,
        idx: int,
        total: int,
    ) -> Optional[Dict]:
        """对单个窗口进行推理。"""
        kps = window["keypoints"]  # [T, V, 3]

        # 检查关键点完整性
        valid_ratio = (kps[:, :, 2] > 0.01).mean()
        if valid_ratio < 0.5:
            return None

        # 转为模型输入 [1, 3, T, 17]
        input_tensor = (
            torch.from_numpy(kps)
            .permute(2, 0, 1)      # [3, T, 17]
            .unsqueeze(0)           # [1, 3, T, 17]
            .float()
            .to(self.device)
        )

        # ST-GCN 推理
        action_logits, embedding = self.stgcn(input_tensor)
        embedding_np = embedding.squeeze(0).cpu().numpy()

        # 多类别 softmax(原实现写死 sigmoid + "weight_shift"，无法支持多动作)
        probs = torch.softmax(action_logits, dim=1).squeeze(0)
        top_id = int(torch.argmax(probs).item())
        action_label = self.id_to_label[top_id]
        action_confidence = float(probs[top_id].item())

        # 鲁棒性门控: 置信度 + top1-top2 边际(与 IMU 侧同构)
        sorted_probs = torch.sort(probs, descending=True).values
        top_margin = float(
            (sorted_probs[0] - sorted_probs[1]).item()
        ) if probs.numel() > 1 else 1.0
        gated = (
            action_confidence >= self.config.confidence_threshold
            and top_margin >= self.config.top_margin_threshold
        )

        # 质量评分 —— 未通过门控或无质量模型时为 None，不伪造分数
        quality_score = self._predict_quality(kps, embedding_np) if gated else None
        quality_level = self._get_quality_level(quality_score) if quality_score is not None else None
        coaching_advice = (
            self._generate_coaching_advice(quality_score, quality_level, action_label)
            if quality_score is not None else ""
        )

        if idx % max(1, total // 5) == 0:
            q_str = f"{quality_score:.1f}" if quality_score is not None else "N/A"
            print(f"    窗口 {idx+1}/{total}: {action_label} "
                  f"(conf={action_confidence:.2f}, margin={top_margin:.2f}) "
                  f"quality={q_str}")

        return {
            "timestamp_start": window["timestamp_start"],
            "timestamp_end": window["timestamp_end"],
            "action_label": action_label,
            "action_confidence": round(action_confidence, 4),
            "top_margin": round(top_margin, 4),
            "gated": gated,
            "quality_score": round(float(quality_score), 2) if quality_score is not None else None,
            "quality_level": quality_level,
            "coaching_advice": coaching_advice,
            "embedding": embedding_np.tolist(),
            "modality": "vision",
        }

    def _predict_quality(
        self,
        keypoints: np.ndarray,
        embedding: np.ndarray,
    ) -> Optional[float]:
        """
        质量评分预测: ST-GCN embedding + 手工特征 → LightGBM 回归。

        模型缺失时返回 None(而非伪造 50 分)。特征维度不匹配等异常直接抛出，
        不再吞掉 —— 静默返回 50.0 会把"模型坏了"伪装成"这个动作中等"，
        是最难排查的一类故障。
        """
        if self.quality_model is None:
            return None

        handcrafted = extract_handcrafted_features(
            keypoints[:, :, :2], keypoints[:, :, 2]
        )
        velocity_feat = extract_velocity_features(keypoints[:, :, :2])
        features = np.concatenate([handcrafted, velocity_feat, embedding]).reshape(1, -1)

        # 训练时保存的是 bundle(含 booster/scaler/feature_names)，与 IMU 侧一致
        bundle = self.quality_model
        if isinstance(bundle, dict):
            scaler = bundle.get("scaler")
            booster = bundle.get("booster")
            if booster is None:
                raise ValueError("质量模型 bundle 缺少 'booster'")
            expected = bundle.get("feature_config", {}).get("num_features")
            if expected is not None and features.shape[1] != expected:
                raise ValueError(
                    f"特征维度不匹配: 当前 {features.shape[1]}，模型期望 {expected}。"
                    f"通常意味着加载了别的模态(如 IMU)的质量模型。"
                )
            if scaler is not None:
                features = scaler.transform(features)
            score = float(booster.predict(features)[0])
        else:
            score = float(bundle.predict(features)[0])

        return float(np.clip(score, 0, 100))

    def _get_quality_level(self, score: float) -> str:
        """等级阈值复用 IMU 侧的单一事实来源，避免两处阈值各自漂移。"""
        from src.quality_labels import score_to_quality_label
        return score_to_quality_label(score)

    def _generate_coaching_advice(
        self,
        score: float,
        level: str,
        action: str,
    ) -> str:
        """复用 IMU 侧的教练反馈逻辑 (简化版)。"""
        # 这里可以引入 coach_feedback.py 的规则引擎
        if score >= 88:
            return "动作标准，继续保持！"
        elif score >= 75:
            return "整体良好，注意细节优化。"
        elif score >= 60:
            return "基本动作框架正确，建议加强核心控制和身体姿态。"
        else:
            return "建议从基础动作开始重新训练，注意重心转移和身体对齐。"


# ============================================================
# 批量处理
# ============================================================

def batch_process_videos(
    video_dir: str,
    output_file: str = "vision_results.json",
    **pipeline_kwargs,
) -> List[Dict]:
    """
    批量处理目录下的所有视频。

    参数:
        video_dir: 视频目录路径
        output_file: 输出 JSON 文件路径

    返回:
        所有结果列表
    """
    pipeline = VisionInferencePipeline(**pipeline_kwargs)
    video_extensions = (".mp4", ".avi", ".mov", ".mkv", ".webm")

    all_results = []
    for fname in sorted(os.listdir(video_dir)):
        if fname.lower().endswith(video_extensions):
            video_path = os.path.join(video_dir, fname)
            try:
                results = pipeline.process_video(video_path)
                for r in results:
                    r["video_name"] = fname
                all_results.extend(results)
            except Exception as e:
                print(f"[错误] {fname}: {e}")

    # 保存结果
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)
    print(f"\n[批量] 完成! {len(all_results)} 条结果 -> {output_file}")

    return all_results


# ============================================================
# 命令行入口
# ============================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="视觉推理管线")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # 单视频推理
    infer_parser = subparsers.add_parser("infer", help="推理单个视频")
    infer_parser.add_argument("video", type=str, help="视频文件路径")
    infer_parser.add_argument("--checkpoint", type=str, default=None)
    infer_parser.add_argument("--quality-model", type=str, default=None)
    infer_parser.add_argument("--max-frames", type=int, default=None)
    infer_parser.add_argument("--visualize", action="store_true")
    infer_parser.add_argument("--output", type=str, default=None)

    # 批量推理
    batch_parser = subparsers.add_parser("batch", help="批量推理目录")
    batch_parser.add_argument("video_dir", type=str, help="视频目录")
    batch_parser.add_argument("--output", type=str, default="vision_results.json")

    args = parser.parse_args()

    if args.command == "infer":
        pipeline = VisionInferencePipeline(
            stgcn_checkpoint=args.checkpoint,
            quality_model_path=args.quality_model,
        )
        results = pipeline.process_video(
            args.video,
            max_frames=args.max_frames,
            save_visualization=args.visualize,
        )

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
            print(f"结果已保存 -> {args.output}")
        else:
            for r in results:
                print(
                    f"  [{r['timestamp_start']:.1f}s-{r['timestamp_end']:.1f}s] "
                    f"{r['action_label']} (Q:{r['quality_score']:.1f}) "
                    f"{r['quality_level']}"
                )

    elif args.command == "batch":
        batch_process_videos(
            args.video_dir,
            output_file=args.output,
        )


if __name__ == "__main__":
    main()
