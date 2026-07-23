"""
视觉管道统一配置
================
所有视觉相关配置集中管理，便于跨文件共享和版本控制。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List


# ============================================================
# COCO 17 关键点定义 (RTMPose 默认输出格式)
# ============================================================
KEYPOINT_NAMES = [
    "nose",           # 0
    "left_eye",       # 1
    "right_eye",      # 2
    "left_ear",       # 3
    "right_ear",      # 4
    "left_shoulder",  # 5
    "right_shoulder", # 6
    "left_elbow",     # 7
    "right_elbow",    # 8
    "left_wrist",     # 9
    "right_wrist",    # 10
    "left_hip",       # 11
    "right_hip",      # 12
    "left_knee",      # 13
    "right_knee",     # 14
    "left_ankle",     # 15
    "right_ankle",    # 16
]

NUM_JOINTS = 17
KEYPOINT_CHANNELS = 3  # x, y, confidence

# 骨骼连接 (用于邻接矩阵和可视化)
SKELETON_EDGES = [
    (5, 6),    # shoulders
    (5, 7),    # left upper arm
    (7, 9),    # left forearm
    (6, 8),    # right upper arm
    (8, 10),   # right forearm
    (5, 11),   # left torso
    (6, 12),   # right torso
    (11, 12),  # hips
    (11, 13),  # left thigh
    (13, 15),  # left shin
    (12, 14),  # right thigh
    (14, 16),  # right shin
    (0, 5),    # nose → left shoulder (neck approx)
    (0, 6),    # nose → right shoulder
    (0, 1),    # nose → left eye
    (0, 2),    # nose → right eye
    (1, 3),    # left eye → left ear
    (2, 4),    # right eye → right ear
]

# 身体中心关节点 (用于归一化)
CENTER_JOINTS = [11, 12]  # left_hip, right_hip → 取中点作为根节点


# ============================================================
# 滑冰重点关注的关键点 (用于手工特征提取)
# ============================================================
SKATING_FOCUS_JOINTS = {
    "head": [0],                          # 头部
    "shoulders": [5, 6],                  # 双肩
    "elbows": [7, 8],                     # 双肘
    "wrists": [9, 10],                    # 双手
    "hips": [11, 12],                     # 双髋
    "knees": [13, 14],                    # 双膝
    "ankles": [15, 16],                   # 双脚踝
}

# 上半身 / 下半身分区 (用于分区特征)
UPPER_BODY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
LOWER_BODY = [11, 12, 13, 14, 15, 16]


# ============================================================
# 训练 & 模型配置
# ============================================================
@dataclass
class STGCNConfig:
    """ST-GCN 模型超参数"""
    in_channels: int = 3          # x, y, confidence
    num_joints: int = NUM_JOINTS  # 17
    graph_args: dict = field(default_factory=lambda: {
        "layout": "coco_17",
        "strategy": "spatial",    # 分区策略: uniform | distance | spatial
    })
    edge_importance_weighting: bool = True

    # ST-GCN 各层的 channels
    stgcn_channels: List[int] = field(default_factory=lambda: [64, 64, 128, 128, 256, 256])

    # 时间卷积 kernel size
    temporal_kernel_size: int = 9
    # 时间卷积的 dropout
    dropout: float = 0.3

    # 分类头。
    # 警告: 绝不可设为 1 —— 单类别下 softmax 恒为 1.0，CrossEntropyLoss 恒为 0，
    # 梯度恒为 0，编码器一步都不会更新(IMU 侧踩过这个坑)。至少 2 类才能训练;
    # 若真的只有一类数据，应改用自监督(重建/对比)而非分类目标。
    num_action_classes: int = 2   # weight_shift + side_push_recover

    # 质量评分 embedding 维度
    embedding_dim: int = 256


@dataclass
class VisionTrainingConfig:
    """视觉训练配置"""
    # 数据
    window_seconds: float = 4.0
    step_seconds: float = 2.0
    fps: int = 30
    frames_per_window: int = 120  # 4s × 30fps

    # 训练
    batch_size: int = 16
    learning_rate: float = 1e-3
    weight_decay: float = 1e-4
    num_epochs: int = 200
    early_stop_patience: int = 30

    # 数据增强
    augment_rotation: float = 5.0   # 度，小角度旋转
    augment_scale: float = 0.05     # 缩放抖动
    augment_drop_joint: float = 0.1 # 随机丢弃关节概率
    augment_mask_frames: float = 0.1  # 随机遮罩帧比例

    # 路径
    checkpoint_dir: str = "experiments/vision_stgcn_v1"
    model_save_name: str = "stgcn_action_model.pt"

    # 日志
    log_interval: int = 10
    eval_interval: int = 1


@dataclass
class VisionInferenceConfig:
    """视觉推理配置"""
    # RTMPose
    rtmpose_device: str = "cuda"   # cuda | cpu
    rtmpose_model_name: str = "rtmpose-m"  # rtmpose-s | rtmpose-m | rtmpose-l
    rtmpose_det_model_name: str = "rtmdet-nano"  # 人体检测器
    rtmpose_conf_threshold: float = 0.5

    # 关键点后处理
    interpolate_missing: bool = True
    normalize_center: str = "hip"   # hip | torso | none
    smooth_window: int = 3         # 时域平滑窗口

    # 滑动窗口
    window_seconds: float = 4.0
    step_seconds: float = 2.0
    fps: int = 30

    # 模型
    model_checkpoint: str = "experiments/vision_stgcn_v1/stgcn_action_model.pt"
    confidence_threshold: float = 0.65
    top_margin_threshold: float = 0.15

    # 质量评分 —— 视觉侧**专属**的 LightGBM。
    # 不可指向 IMU 侧的 lgb_quality_*：两者特征体系与维度完全不同
    # (IMU: 深度embedding+加速度/角速度方差+jerk; 视觉: embedding+关节速度/对称性/重心)，
    # 混用会在 scaler.transform 处直接因特征维度不匹配而崩溃。
    quality_model_path: str = "experiments/vision_quality_v1/lgb_quality_model.pkl"

    # 输出
    save_visualization: bool = True
    visualization_dir: str = "vision_output"


@dataclass
class MultimodalConfig:
    """多模态融合配置"""
    # 时间对齐
    alignment_tolerance: float = 0.5  # 秒，两个 timestamp_end 差值在此范围内视为同一窗口

    # 融合策略
    fusion_strategy: str = "confidence_weighted"  # confidence_weighted | average | rule_based

    # 各模态的固定权重，**仅在 fusion_strategy="weighted" 时生效**。
    # 目前两侧均等 —— 在视觉模型训练完、并与 IMU 做过并行对比之前，
    # 任何非对称的权重都只是猜测。等拿到两个模态各自的验证集表现后，
    # 再按实测误差反比设定这两个值。
    imu_weight: float = 0.5
    vision_weight: float = 0.5
    weights_calibrated: bool = False  # 完成并行对比、标定权重后置为 True

    # 缺失模态处理
    fallback_to_single: bool = True

    # 时间戳来源。
    # 强烈建议 False(用采集时刻的帧时间戳)：wall-clock 打的是"推理完成时刻"，
    # 而推理延迟不固定，会把对齐锚点污染成"算得快慢"而非"何时发生"。
    use_wall_clock: bool = False


# ============================================================
# 全局单例配置
# ============================================================
STGCN_CONFIG = STGCNConfig()
TRAIN_CONFIG = VisionTrainingConfig()
INFER_CONFIG = VisionInferenceConfig()
MULTIMODAL_CONFIG = MultimodalConfig()

# 环境变量覆盖
INFER_CONFIG.rtmpose_device = os.getenv("VISION_DEVICE", INFER_CONFIG.rtmpose_device)
INFER_CONFIG.model_checkpoint = os.getenv(
    "VISION_MODEL_PATH", INFER_CONFIG.model_checkpoint
)
INFER_CONFIG.quality_model_path = os.getenv(
    "VISION_QUALITY_MODEL_PATH", INFER_CONFIG.quality_model_path
)
