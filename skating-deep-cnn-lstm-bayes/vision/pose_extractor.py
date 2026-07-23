"""
视频关键点提取器
===============
基于 MMPose/RTMPose 从视频中提取人体关键点序列。

支持:
  - 单视频文件 → 关键点序列 [T, 17, 3] (x, y, confidence)
  - 缺失关节点插值 (线性/样条)
  - 中心归一化 (以髋部中点为原点)
  - 滑动窗口生成
  - 可视化 (可选，调试用)
"""
from __future__ import annotations

import json
import os
import warnings
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import torch

import cv2
import numpy as np

from .config import KEYPOINT_NAMES, NUM_JOINTS, KEYPOINT_CHANNELS


# ============================================================
# RTMPose 推理封装
# ============================================================

class RTMPoseExtractor:
    """
    RTMPose 关键点提取器。

    使用 MMPose 的推理 API。需要安装 mmpose 和相关依赖:
      pip install mmpose mmdet opencv-python

    如果 MMPose 不可用，会回退到模拟模式 (用于开发和测试)。
    """

    def __init__(
        self,
        device: str = "cuda",
        model_name: str = "rtmpose-m",
        det_model_name: str = "rtmdet-nano",
        conf_threshold: float = 0.5,
        allow_synthetic: bool = False,
    ):
        """
        参数:
            allow_synthetic: 仅供单元测试使用。开启后，MMPose 缺失时会返回
                随机关键点。**绝不可在训练或推理中开启** —— 随机数据会让模型
                "训得动但学不到东西"，且不会报错，极难排查。
        """
        self.device = device
        self.model_name = model_name
        self.det_model_name = det_model_name
        self.conf_threshold = conf_threshold
        self.allow_synthetic = allow_synthetic
        self._model = None  # 惰性加载
        self._model_loaded = False

    def _load_model(self):
        """惰性加载 MMPose 模型。MMPose 不可用时直接失败，不静默降级。"""
        try:
            from mmpose.apis import inference_topdown, init_model
            from mmpose.utils import adapt_mmdet_pipeline
            import mmdet  # noqa: F401

            # 使用 MMPose 预训练模型配置
            config = f"configs/body_2d_keypoint/rtmpose/{self.model_name}.py"
            checkpoint = f"https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/{self.model_name}_pytorch.pth"

            self._model = init_model(config, checkpoint, device=self.device)
            # 初始化检测器
            det_config = (
                f"configs/mmdet/_base_/models/{self.det_model_name}.py"
            )
            self._detector = init_model(
                det_config,
                f"https://download.openmmlab.com/mmdet/v3/{self.det_model_name}_pth.tar",
                device=self.device,
            )
            self._detector = adapt_mmdet_pipeline(self._detector)
            self._model_loaded = True
            print(f"[RTMPose] 模型 {self.model_name} 加载成功 (device={self.device})")

        except ImportError as exc:
            self._model_loaded = False
            if self.allow_synthetic:
                warnings.warn(
                    "MMPose 未安装，allow_synthetic=True → 返回随机关键点。"
                    "仅限单元测试，训练/推理结果无意义。"
                )
                return
            raise RuntimeError(
                "MMPose / mmdet 未安装，无法提取关键点。\n"
                "  安装: pip install mmpose mmdet\n"
                "  (若确为单元测试且不关心关键点数值，可显式传 allow_synthetic=True)"
            ) from exc

    @torch.no_grad()
    def extract_from_image(self, image: np.ndarray) -> np.ndarray:
        """
        从单帧图像提取关键点。

        参数:
            image: [H, W, 3] BGR 图像

        返回:
            keypoints: [17, 3] (x, y, confidence)
            如果未检测到人体，返回全零。
        """
        if self._model is None:
            self._load_model()  # MMPose 缺失时会直接抛错，除非 allow_synthetic

        if not self._model_loaded:
            # 只有显式开启 allow_synthetic（单元测试）才会走到这里
            kps = np.random.randn(17, 3).astype(np.float32)
            kps[:, 0] = kps[:, 0] * 100 + 320  # x
            kps[:, 1] = kps[:, 1] * 100 + 240  # y
            kps[:, 2] = np.random.uniform(0.7, 1.0, (17,)).astype(np.float32)  # conf
            return kps

        # 真实 RTMPose 推理
        from mmpose.apis import inference_topdown

        # 人体检测
        det_result = self._detector(image)
        pred_instance = det_result.pred_instances.cpu().numpy()
        bboxes = pred_instance.bboxes
        scores = pred_instance.scores

        if len(bboxes) == 0 or scores[0] < self.conf_threshold:
            return np.zeros((17, 3), dtype=np.float32)

        # 取最高分的人体框
        best_idx = np.argmax(scores)
        bbox = bboxes[best_idx]

        # 关键点检测
        pose_results = inference_topdown(self._model, image, [bbox])
        if len(pose_results) == 0:
            return np.zeros((17, 3), dtype=np.float32)

        keypoints = pose_results[0].pred_instances.keypoints[0]  # [17, 2]
        keypoint_scores = pose_results[0].pred_instances.keypoint_scores[0]  # [17]

        result = np.zeros((17, 3), dtype=np.float32)
        result[:, :2] = keypoints
        result[:, 2] = keypoint_scores

        return result

    def extract_from_video(
        self,
        video_path: str,
        max_frames: Optional[int] = None,
        stride: int = 1,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[np.ndarray, np.ndarray, float]:
        """
        从视频文件提取所有帧的关键点。

        参数:
            video_path: 视频文件路径
            max_frames: 最多提取帧数 (None = 全部)
            stride: 跳帧步长 (1 = 每帧都提取)
            progress_callback: 进度回调 fn(current, total)

        返回:
            keypoints: [T, 17, 3] (x, y, confidence)
            timestamps: [T] 每帧的时间戳 (秒)
            fps: 视频帧率
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise IOError(f"无法打开视频: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if max_frames:
            total_frames = min(total_frames, max_frames)

        all_keypoints = []
        all_timestamps = []
        frame_idx = 0

        while True:
            ret, frame = cap.read()
            if not ret or (max_frames and frame_idx >= max_frames):
                break

            if frame_idx % stride == 0:
                timestamp = frame_idx / fps
                kps = self.extract_from_image(frame)
                all_keypoints.append(kps)
                all_timestamps.append(timestamp)

                if progress_callback:
                    progress_callback(frame_idx, total_frames)

            frame_idx += 1

            # 进度汇报
            if progress_callback and frame_idx % 30 == 0:
                progress_callback(frame_idx, total_frames)

        cap.release()

        if len(all_keypoints) == 0:
            raise ValueError(f"未从视频中提取到任何关键点: {video_path}")

        return (
            np.stack(all_keypoints, axis=0).astype(np.float32),
            np.array(all_timestamps, dtype=np.float32),
            fps,
        )


# ============================================================
# 视频直接提取 (使用 OpenCV 捕捉)

def extract_frames_from_video(
    video_path: str,
    target_fps: float = 30.0,
    max_frames: Optional[int] = None,
) -> Tuple[List[np.ndarray], float]:
    """
    从视频中提取帧，按目标帧率采样。

    参数:
        video_path: 视频文件路径
        target_fps: 目标帧率
        max_frames: 最多帧数

    返回:
        frames: 图像列表 [T, H, W, 3] BGR
        actual_fps: 实际采样帧率
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise IOError(f"无法打开视频: {video_path}")

    orig_fps = cap.get(cv2.CAP_PROP_FPS)
    sample_interval = max(1, round(orig_fps / target_fps))

    frames = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample_interval == 0:
            frames.append(frame)
            if max_frames and len(frames) >= max_frames:
                break
        frame_idx += 1

    cap.release()

    actual_fps = orig_fps / sample_interval
    return frames, actual_fps


# ============================================================
# 关键点后处理
# ============================================================

def interpolate_missing_keypoints(
    keypoints: np.ndarray,
    method: str = "linear",
) -> np.ndarray:
    """
    对缺失 (置信度为0) 的关键点进行插值。

    参数:
        keypoints: [T, 17, 3] (x, y, confidence)
        method: "linear" | "cubic" | "nearest"

    返回:
        [T, 17, 3] 插值后的关键点
    """
    T = keypoints.shape[0]
    result = keypoints.copy()

    for j in range(NUM_JOINTS):
        # 找到有效帧 (confidence > 0) 和缺失帧
        valid = keypoints[:, j, 2] > 0.01
        if valid.sum() < 2:
            # 有效帧太少，无法插值，跳过
            continue

        valid_indices = np.where(valid)[0]
        missing_indices = np.where(~valid)[0]

        if len(missing_indices) == 0:
            continue

        # 对 x, y 分别插值
        for coord in [0, 1]:
            valid_vals = keypoints[valid_indices, j, coord]

            if method == "linear":
                result[missing_indices, j, coord] = np.interp(
                    missing_indices, valid_indices, valid_vals
                )
            elif method == "cubic":
                from scipy.interpolate import CubicSpline
                cs = CubicSpline(valid_indices, valid_vals, bc_type="natural")
                result[missing_indices, j, coord] = cs(missing_indices)
            else:
                # nearest
                for m_idx in missing_indices:
                    nearest = valid_indices[np.argmin(np.abs(valid_indices - m_idx))]
                    result[m_idx, j, coord] = keypoints[nearest, j, coord]

        # 插值后的置信度设为较低的固定值
        result[missing_indices, j, 2] = 0.3

    return result


def normalize_keypoints(
    keypoints: np.ndarray,
    center: str = "hip",
    img_size: Optional[Tuple[int, int]] = None,
) -> np.ndarray:
    """
    中心归一化关键点坐标。

    参数:
        keypoints: [T, 17, 3] (x, y, confidence)
        center: "hip" (以髋部中点为原点) | "torso" (以躯干中心为原点) | "none"
        img_size: (W, H) 图像尺寸，用于缩放归一化

    返回:
        [T, 17, 3] 归一化后的关键点
    """
    result = keypoints.copy()
    T = keypoints.shape[0]

    for t in range(T):
        frame_kps = keypoints[t]

        if center == "hip":
            # 髋部中点: 左右髋的平均
            hip_left = frame_kps[11, :2]
            hip_right = frame_kps[12, :2]
            center_pt = (hip_left + hip_right) / 2
        elif center == "torso":
            # 躯干中心: 肩部中点 + 髋部中点 的平均
            shoulder_center = (frame_kps[5, :2] + frame_kps[6, :2]) / 2
            hip_center = (frame_kps[11, :2] + frame_kps[12, :2]) / 2
            center_pt = (shoulder_center + hip_center) / 2
        else:
            continue

        # 平移
        result[t, :, :2] = frame_kps[:, :2] - center_pt

    # 缩放: 如果用图像尺寸归一化
    if img_size is not None:
        w, h = img_size
        scale = max(w, h) / 2.0
        result[:, :, :2] = result[:, :, :2] / scale

    return result


def smooth_keypoints(
    keypoints: np.ndarray,
    window: int = 3,
) -> np.ndarray:
    """
    时域平滑: 用滑动平均去除抖动。

    参数:
        keypoints: [T, 17, 3]
        window: 平滑窗口大小

    返回:
        [T, 17, 3] 平滑后的关键点
    """
    from scipy.ndimage import uniform_filter1d

    result = keypoints.copy()
    result[:, :, :2] = uniform_filter1d(
        keypoints[:, :, :2], size=window, axis=0, mode="nearest"
    )
    return result


# ============================================================
# 滑动窗口生成
# ============================================================

def sliding_windows(
    keypoints: np.ndarray,
    timestamps: np.ndarray,
    window_frames: int = 120,   # 4s × 30fps
    step_frames: int = 60,      # 2s × 30fps
    min_frames: int = 10,
) -> List[Dict]:
    """
    将关键点序列切分为滑动窗口。

    参数:
        keypoints: [T, 17, 3]
        timestamps: [T]
        window_frames: 每个窗口的帧数
        step_frames: 滑动步长 (帧数)
        min_frames: 最小帧数，少于则跳过

    返回:
        windows: [
            {
                "keypoints": [window_frames, 17, 3],
                "timestamp_start": float,
                "timestamp_end": float,
                "frame_indices": [start, end],
            }
        ]
    """
    T = keypoints.shape[0]
    windows = []

    for start in range(0, T - window_frames + 1, step_frames):
        end = start + window_frames
        window_kps = keypoints[start:end]
        windows.append({
            "keypoints": window_kps,
            "timestamp_start": float(timestamps[start]),
            "timestamp_end": float(timestamps[end - 1]),
            "frame_indices": (start, end),
        })

    return windows


# ============================================================
# 数据保存/导出
# ============================================================

def save_keypoints_to_jsonl(
    keypoints: np.ndarray,
    timestamps: np.ndarray,
    video_path: str,
    output_path: str,
    labels: Optional[Dict[int, str]] = None,
):
    """
    将关键点序列保存为 JSONL 格式 (与 IMU 数据格式对齐)。

    每行:
    {
        "video_path": ...,
        "frame_index": int,
        "timestamp": float,
        "keypoints": [[x, y, conf], ...],  # 17 个关键点
        "label": "..." (可选)
    }
    """
    T = keypoints.shape[0]
    video_name = os.path.basename(video_path)
    records = []

    for t in range(T):
        record = {
            "video_path": video_name,
            "frame_index": t,
            "timestamp": float(timestamps[t]),
            "keypoints": keypoints[t].tolist(),
        }
        if labels and t in labels:
            record["label"] = labels[t]
        records.append(record)

    with open(output_path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"[保存] 关键点序列 -> {output_path} ({T} 帧)")


def load_keypoints_from_jsonl(jsonl_path: str) -> Tuple[np.ndarray, np.ndarray, List[Dict]]:
    """
    从 JSONL 加载关键点序列。

    返回:
        keypoints: [T, 17, 3]
        timestamps: [T]
        raw_records: 原始记录列表
    """
    records = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    T = len(records)
    keypoints = np.zeros((T, NUM_JOINTS, KEYPOINT_CHANNELS), dtype=np.float32)
    timestamps = np.zeros(T, dtype=np.float32)

    for t, rec in enumerate(records):
        keypoints[t] = np.array(rec["keypoints"], dtype=np.float32)
        timestamps[t] = rec["timestamp"]

    return keypoints, timestamps, records


# ============================================================
# 可视化 (调试用)
# ============================================================

SKELETON_VIZ_COLORS = [
    (255, 0, 0),    # 红色 - 头部
    (255, 85, 0),   # 橙色 - 躯干
    (255, 170, 0),  # 黄色 - 左臂
    (170, 255, 0),  # 黄绿 - 右臂
    (0, 255, 0),    # 绿色 - 左腿
    (0, 170, 255),  # 青色 - 右腿
]

# 关键点连接的绘图索引
SKELETON_VIZ_CONNECTIONS = [
    (0, 1), (0, 2), (1, 3), (2, 4),
    (0, 5), (0, 6), (5, 6),
    (5, 7), (7, 9), (6, 8), (8, 10),
    (5, 11), (6, 12), (11, 12),
    (11, 13), (13, 15), (12, 14), (14, 16),
]


def draw_keypoints(
    image: np.ndarray,
    keypoints: np.ndarray,
    threshold: float = 0.3,
) -> np.ndarray:
    """
    在图像上绘制关键点和骨骼连接。

    参数:
        image: [H, W, 3] BGR
        keypoints: [17, 3] (x, y, confidence)
        threshold: 置信度阈值

    返回:
        绘制后的图像
    """
    vis_img = image.copy()
    h, w = vis_img.shape[:2]

    # 绘制骨骼连接
    for (i, j) in SKELETON_VIZ_CONNECTIONS:
        if (keypoints[i, 2] > threshold and keypoints[j, 2] > threshold):
            pt1 = (int(keypoints[i, 0]), int(keypoints[i, 1]))
            pt2 = (int(keypoints[j, 0]), int(keypoints[j, 1]))
            cv2.line(vis_img, pt1, pt2, (0, 255, 255), 2)

    # 绘制关键点
    for i in range(NUM_JOINTS):
        if keypoints[i, 2] > threshold:
            cx, cy = int(keypoints[i, 0]), int(keypoints[i, 1])
            color = (0, 255, 0) if keypoints[i, 2] > 0.5 else (0, 165, 255)
            cv2.circle(vis_img, (cx, cy), 4, color, -1)
            cv2.circle(vis_img, (cx, cy), 4, color, 2)

    return vis_img


def visualize_skeleton_sequence(
    keypoints: np.ndarray,
    output_path: str,
    fps: float = 30.0,
    video_width: int = 640,
    video_height: int = 480,
):
    """
    将关键点序列渲染为视频 (用于调试查看)。

    参数:
        keypoints: [T, 17, 3] 归一化坐标
        output_path: 输出视频路径
        fps: 帧率
        video_width/video_height: 输出视频尺寸
    """
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, fps, (video_width, video_height))

    # 将归一化坐标映射回像素
    scale = min(video_width, video_height) * 0.4
    center_x, center_y = video_width // 2, video_height // 2

    for t in range(keypoints.shape[0]):
        frame = np.zeros((video_height, video_width, 3), dtype=np.uint8)

        # 将归一化坐标转为像素
        kps = keypoints[t].copy()
        kps[:, 0] = kps[:, 0] * scale + center_x
        kps[:, 1] = kps[:, 1] * scale + center_y

        # 绘制
        for (i, j) in SKELETON_VIZ_CONNECTIONS:
            if kps[i, 2] > 0.01 and kps[j, 2] > 0.01:
                pt1 = (int(kps[i, 0]), int(kps[i, 1]))
                pt2 = (int(kps[j, 0]), int(kps[j, 1]))
                cv2.line(frame, pt1, pt2, (0, 255, 255), 2)

        for i in range(NUM_JOINTS):
            if kps[i, 2] > 0.01:
                cx, cy = int(kps[i, 0]), int(kps[i, 1])
                cv2.circle(frame, (cx, cy), 4, (0, 255, 0), -1)

        out.write(frame)

    out.release()
    print(f"[可视化] 骨骼序列已保存 -> {output_path}")
