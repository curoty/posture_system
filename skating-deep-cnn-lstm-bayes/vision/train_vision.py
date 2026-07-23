"""
视觉模型训练管线
================
基于骨架关键点的 ST-GCN 动作分类和质量评分训练。

训练流程:
  1. 加载 JSONL 格式的关键点数据
  2. 数据增强 (旋转/缩放/关节丢弃/时域遮罩)
  3. ST-GCN 前向 → 动作分类损失交叉熵
  4. 可选: embedding + LightGBM 质量回归 (独立训练)
  5. 验证/测试评估
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
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

from .config import (
    KEYPOINT_NAMES,
    NUM_JOINTS,
    STGCNConfig,
    VisionTrainingConfig as TrainConfig,
)
from .pose_extractor import (
    interpolate_missing_keypoints,
    normalize_keypoints,
    smooth_keypoints,
)
from .skeleton_graph import extract_handcrafted_features, extract_velocity_features
from .stgcn_model import STGCN

# ============================================================
# 警告抑制
# ============================================================
warnings.filterwarnings("ignore", message=".*torch.tensor results are registered as parameters.*")


# ============================================================
# 关键点数据集
# ============================================================

class SkeletonDataset(Dataset):
    """
    骨架关键点数据集。

    从 JSONL 文件加载，支持滑动窗口采样和数据增强。

    每行 JSONL 格式:
    {
        "video_path": str,
        "frame_index": int,
        "timestamp": float,
        "keypoints": [[x, y, conf], ...],  # [17, 3]
        "label": str  (可选)
        "quality_score": float  (可选)
    }
    """

    def __init__(
        self,
        jsonl_paths: List[str],
        window_frames: int = 120,
        step_frames: int = 60,
        augment: bool = False,
        augment_config: Optional[Dict] = None,
        max_samples: Optional[int] = None,
    ):
        self.window_frames = window_frames
        self.step_frames = step_frames
        self.augment = augment
        self.augment_config = augment_config or {
            "rotation": 5.0,         # 度
            "scale": 0.05,
            "drop_joint": 0.1,
            "mask_frames": 0.1,
        }

        # 从所有 JSONL 加载并切分窗口
        self.samples = []
        action_to_label = {}

        for jsonl_path in jsonl_paths:
            records = self._load_jsonl(jsonl_path)
            if len(records) == 0:
                continue

            # 提取关键点序列和时间戳
            keypoints, timestamps = self._records_to_array(records)

            # 预处理: 插值缺失 → 归一化 → 平滑
            keypoints = interpolate_missing_keypoints(keypoints)
            keypoints = normalize_keypoints(keypoints, center="hip")
            keypoints = smooth_keypoints(keypoints, window=3)

            # 获取标签 (所有帧应该一致)
            labels = set()
            quality_scores = set()
            for rec in records:
                if "label" in rec and rec["label"]:
                    labels.add(rec["label"])
                if "quality_score" in rec and rec["quality_score"] is not None:
                    quality_scores.add(float(rec["quality_score"]))

            label = list(labels)[0] if len(labels) == 1 else None
            quality_score = list(quality_scores)[0] if len(quality_scores) == 1 else None

            # 滑动窗口采样
            T = keypoints.shape[0]
            for start in range(0, T - window_frames + 1, step_frames):
                end = start + window_frames
                self.samples.append({
                    "keypoints": keypoints[start:end].copy(),
                    "label": label,
                    "quality_score": quality_score,
                    "timestamp_start": float(timestamps[start]),
                    "timestamp_end": float(timestamps[end - 1]),
                    "video_path": jsonl_path,
                })

        if max_samples:
            self.samples = self.samples[:max_samples]

        print(f"[数据集] 加载 {len(jsonl_paths)} 个文件 → {len(self.samples)} 个窗口样本")

    def _load_jsonl(self, jsonl_path: str) -> List[Dict]:
        """加载 JSONL 文件。"""
        records = []
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
        return records

    def _records_to_array(
        self, records: List[Dict]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """将记录列表转为数组。"""
        T = len(records)
        keypoints = np.zeros((T, NUM_JOINTS, 3), dtype=np.float32)
        timestamps = np.zeros(T, dtype=np.float32)

        for t, rec in enumerate(records):
            if "keypoints" in rec:
                kps = np.array(rec["keypoints"], dtype=np.float32)
                if kps.shape == (NUM_JOINTS, 3):
                    keypoints[t] = kps
            timestamps[t] = rec.get("timestamp", t / 30.0)

        return keypoints, timestamps

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Dict:
        sample = self.samples[idx]

        # 数据增强 (可训练时使用)
        keypoints = sample["keypoints"]
        if self.augment:
            keypoints = self._augment(keypoints)

        # 转为 [C, T, V] 格式
        # keypoints shape: [T, V, C] → [C, T, V]
        kp_tensor = torch.from_numpy(keypoints).permute(2, 0, 1).float()

        result = {
            "keypoints": kp_tensor,                          # [3, T, 17]
            "label": sample["label"],
            "quality_score": sample.get("quality_score"),
            "timestamp_start": sample["timestamp_start"],
            "timestamp_end": sample["timestamp_end"],
        }

        return result

    def _augment(self, keypoints: np.ndarray) -> np.ndarray:
        """数据增强。"""
        aug = self.augment_config
        kps = keypoints.copy()
        T, V = kps.shape[0], kps.shape[1]

        # 1. 小角度旋转 (绕中心)
        if np.random.random() < 0.5:
            angle = np.random.uniform(-aug["rotation"], aug["rotation"])
            rad = np.deg2rad(angle)
            cos_a, sin_a = np.cos(rad), np.sin(rad)
            center = kps[:, :, :2].mean(axis=(0, 1), keepdims=True)
            kps[:, :, :2] = kps[:, :, :2] - center
            R = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
            kps[:, :, :2] = kps[:, :, :2] @ R.T
            kps[:, :, :2] = kps[:, :, :2] + center

        # 2. 缩放抖动
        if np.random.random() < 0.5:
            scale = np.random.uniform(1.0 - aug["scale"], 1.0 + aug["scale"])
            kps[:, :, :2] = kps[:, :, :2] * scale

        # 3. 随机丢弃关节 (将置信度设为0, 坐标设为0)
        if np.random.random() < 0.5:
            drop_prob = np.random.uniform(0, aug["drop_joint"])
            drop_mask = np.random.random((V,)) < drop_prob
            kps[:, drop_mask, :] = 0.0

        # 4. 随机遮罩帧
        if np.random.random() < 0.3:
            mask_prob = np.random.uniform(0, aug["mask_frames"])
            mask_frames = np.random.random(T) < mask_prob
            kps[mask_frames, :, :2] = 0.0
            kps[mask_frames, :, 2] = 0.0

        return kps

    def get_label_mapping(self) -> Dict[str, int]:
        """获取标签到 ID 的映射。"""
        labels = sorted(set(s["label"] for s in self.samples if s["label"]))
        return {label: i for i, label in enumerate(labels)}


# ============================================================
# 训练器
# ============================================================

class VisionTrainer:
    """
    视觉模型训练器.

    管理训练循环、验证、检查点保存和评估。
    """

    def __init__(
        self,
        label_map: Dict[str, int],
        stgcn_config: Optional[STGCNConfig] = None,
        train_config: Optional[TrainConfig] = None,
        device: Optional[str] = None,
        class_weights: Optional[torch.Tensor] = None,
    ):
        """
        参数:
            label_map: {动作名: 类别id}。**必须由数据集提供**，模型的
                num_action_classes 由它决定，避免配置与数据不一致。
            class_weights: [num_classes] 类别权重，用于缓解类别失衡。
        """
        self.stgcn_config = stgcn_config or STGCNConfig()
        self.train_config = train_config or TrainConfig()
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")

        self.label_map = dict(label_map)
        self.id_to_label = {i: name for name, i in self.label_map.items()}
        num_classes = len(self.label_map)

        # 单类别下 softmax 恒为 1.0 → 损失恒 0 → 梯度恒 0，编码器一步都不会更新。
        # IMU 侧已实测踩过这个坑，这里直接拒绝启动而不是训出一个废模型。
        if num_classes < 2:
            raise ValueError(
                f"分类训练至少需要 2 个动作类别，当前只有 {num_classes} 个: "
                f"{list(self.label_map)}。\n"
                f"若确实只有一类数据，请改用自监督(重建/对比)目标预训练编码器，"
                f"而不是分类目标。"
            )

        # 以数据推导出的类别数为准，覆盖配置里的值
        self.stgcn_config.num_action_classes = num_classes

        self.model = STGCN(
            in_channels=self.stgcn_config.in_channels,
            num_joints=self.stgcn_config.num_joints,
            graph_args=self.stgcn_config.graph_args,
            edge_importance_weighting=self.stgcn_config.edge_importance_weighting,
            channels=self.stgcn_config.stgcn_channels,
            temporal_kernel_size=self.stgcn_config.temporal_kernel_size,
            dropout=self.stgcn_config.dropout,
            num_action_classes=num_classes,
            embedding_dim=self.stgcn_config.embedding_dim,
        ).to(self.device)

        # 优化器
        self.optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=self.train_config.learning_rate,
            weight_decay=self.train_config.weight_decay,
        )

        # 学习率调度器
        self.scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            self.optimizer,
            T_max=self.train_config.num_epochs,
            eta_min=1e-6,
        )

        # 多类别分类用 CrossEntropyLoss(模型输出的是 [B, num_classes] logits)。
        # 原实现用 BCEWithLogitsLoss，与多类 logits 不匹配。
        if class_weights is not None:
            class_weights = class_weights.to(self.device)
        self.cls_loss = nn.CrossEntropyLoss(weight=class_weights)

        # 训练状态
        self.epoch = 0
        self.best_val_loss = float("inf")
        self.best_val_macro_f1 = -1.0
        self.patience_counter = 0
        self.history = {"train_loss": [], "val_loss": [], "val_accuracy": [], "val_macro_f1": []}

        # 创建检查点目录
        os.makedirs(self.train_config.checkpoint_dir, exist_ok=True)

        print(f"[训练器] device={self.device}, 类别={self.label_map}, "
              f"模型参数={sum(p.numel() for p in self.model.parameters()):,}")

    def _collate_fn(self, batch: List[Dict]) -> Dict:
        """批处理。

        关键: 把字符串标签映射成 ``action_labels`` 张量。原实现只放了字符串
        列表 ``labels``，而 train_epoch 取的是 ``action_labels``，永远拿到
        None → 每个 batch 都掉进自监督分支，分类头一次都没训过。
        """
        keypoints = torch.stack([b["keypoints"] for b in batch])  # [B, 3, T, 17]

        # 丢弃无标签样本(分类训练必须有标签)
        label_ids = []
        for b in batch:
            name = b["label"]
            if name is None or name not in self.label_map:
                raise ValueError(
                    f"样本标签 {name!r} 不在 label_map {list(self.label_map)} 中。"
                    f"请先过滤掉无标签样本，或补全 label_map。"
                )
            label_ids.append(self.label_map[name])

        result = {
            "keypoints": keypoints.to(self.device),
            "action_labels": torch.tensor(label_ids, dtype=torch.long, device=self.device),
        }

        # 质量评分(供 LightGBM 阶段使用，分类训练不用)
        quality_scores = [b.get("quality_score") for b in batch]
        if any(qs is not None for qs in quality_scores):
            result["quality_scores"] = torch.tensor(
                [qs if qs is not None else 0.0 for qs in quality_scores],
                dtype=torch.float32, device=self.device
            )

        return result

    def train_epoch(self, loader: DataLoader) -> float:
        """训练一个 epoch。"""
        self.model.train()
        total_loss = 0.0
        num_batches = 0

        for batch in tqdm(loader, desc=f"Epoch {self.epoch}", leave=False):
            x = batch["keypoints"]
            action_logits, _embedding = self.model(x)
            loss = self.cls_loss(action_logits, batch["action_labels"])

            self.optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 5.0)
            self.optimizer.step()

            total_loss += loss.item()
            num_batches += 1

        return total_loss / max(1, num_batches)

    @torch.no_grad()
    def evaluate(self, loader: DataLoader) -> Dict[str, float]:
        """评估。

        类别失衡时 accuracy 会误导(全预测多数类也能很高)，
        因此同时报告 macro-F1，并以它为模型选择的主指标。
        """
        from sklearn.metrics import accuracy_score, f1_score

        self.model.eval()
        total_loss = 0.0
        all_preds: List[int] = []
        all_labels: List[int] = []

        for batch in tqdm(loader, desc="Validation", leave=False):
            action_logits, _embedding = self.model(batch["keypoints"])
            labels = batch["action_labels"]
            total_loss += self.cls_loss(action_logits, labels).item()
            all_preds.extend(torch.argmax(action_logits, dim=1).cpu().tolist())
            all_labels.extend(labels.cpu().tolist())

        return {
            "val_loss": total_loss / max(1, len(loader)),
            "val_accuracy": float(accuracy_score(all_labels, all_preds)) if all_labels else 0.0,
            "val_macro_f1": float(
                f1_score(all_labels, all_preds, average="macro", zero_division=0)
            ) if all_labels else 0.0,
        }

    def save_checkpoint(self, is_best: bool = False):
        """保存检查点。"""
        checkpoint = {
            "epoch": self.epoch,
            "model_state_dict": self.model.state_dict(),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scheduler_state_dict": self.scheduler.state_dict(),
            "history": self.history,
            "stgcn_config": asdict(self.stgcn_config),
            "train_config": asdict(self.train_config),
            # 推理端必须靠它把类别 id 还原成动作名，否则只能瞎猜
            "label_map": self.label_map,
        }

        # 最新
        latest_path = os.path.join(
            self.train_config.checkpoint_dir, "latest.pt"
        )
        torch.save(checkpoint, latest_path)

        # 最优
        if is_best:
            best_path = os.path.join(
                self.train_config.checkpoint_dir,
                self.train_config.model_save_name,
            )
            torch.save(checkpoint, best_path)

    def load_checkpoint(self, checkpoint_path: str):
        """加载检查点。"""
        checkpoint = torch.load(checkpoint_path, map_location=self.device)
        self.model.load_state_dict(checkpoint["model_state_dict"])
        self.optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
        self.scheduler.load_state_dict(checkpoint["scheduler_state_dict"])
        self.history = checkpoint["history"]
        self.epoch = checkpoint.get("epoch", 0)
        print(f"[检查点] 已加载: {checkpoint_path} (epoch={self.epoch})")

    def fit(
        self,
        train_loader: DataLoader,
        val_loader: Optional[DataLoader] = None,
    ):
        """完整训练循环。"""
        print("=" * 60)
        print(f"开始训练 | epochs={self.train_config.num_epochs}")
        print(f"           | train_batches={len(train_loader)}")
        if val_loader:
            print(f"           | val_batches={len(val_loader)}")
        print("=" * 60)

        for epoch in range(self.epoch, self.train_config.num_epochs):
            self.epoch = epoch + 1

            # 训练
            train_loss = self.train_epoch(train_loader)
            self.history["train_loss"].append(train_loss)

            # 验证
            val_metrics = {}
            if val_loader and epoch % self.train_config.eval_interval == 0:
                val_metrics = self.evaluate(val_loader)
                self.history["val_loss"].append(val_metrics["val_loss"])
                self.history["val_accuracy"].append(val_metrics["val_accuracy"])
                self.history["val_macro_f1"].append(val_metrics["val_macro_f1"])

            # 学习率调整
            self.scheduler.step()
            current_lr = self.scheduler.get_last_lr()[0]

            # 日志
            if epoch % self.train_config.log_interval == 0:
                log_msg = (
                    f"Epoch {epoch:3d}/{self.train_config.num_epochs} | "
                    f"train_loss={train_loss:.4f}"
                )
                if val_metrics:
                    log_msg += f" | val_loss={val_metrics['val_loss']:.4f}"
                    log_msg += f" | val_acc={val_metrics['val_accuracy']:.3f}"
                    log_msg += f" | val_macroF1={val_metrics['val_macro_f1']:.3f}"
                log_msg += f" | lr={current_lr:.2e}"
                print(log_msg)

            # 模型选择: 以 macro-F1 为主(失衡下 accuracy/loss 会误导)；
            # 小验证集上 macro-F1 容易饱和打平，此时以更低的 val_loss 破平局。
            is_best = False
            if val_metrics:
                score = (val_metrics["val_macro_f1"], -val_metrics["val_loss"])
                best = (self.best_val_macro_f1, -self.best_val_loss)
                if score > best:
                    self.best_val_macro_f1 = val_metrics["val_macro_f1"]
                    self.best_val_loss = val_metrics["val_loss"]
                    self.patience_counter = 0
                    is_best = True
                else:
                    self.patience_counter += 1

            # 定期保存
            if epoch % 10 == 0 or is_best:
                self.save_checkpoint(is_best=is_best)

            # Early stopping
            if self.patience_counter >= self.train_config.early_stop_patience:
                print(f"[早停] {self.train_config.early_stop_patience} epochs 无改善")
                break

        print(f"\n训练完成! 最佳 val_macro_f1={self.best_val_macro_f1:.4f} "
              f"(val_loss={self.best_val_loss:.4f})")


# ============================================================
# 质量评分训练 (LightGBM, 复用 IMU 侧方法)
# ============================================================

def extract_quality_features(
    keypoints: np.ndarray,
) -> np.ndarray:
    """
    从关键点窗口提取质量评分特征。

    参数:
        keypoints: [T, 17, 3] 归一化关键点

    返回:
        features: [D] 特征向量
    """
    # 手工特征 (基于关节速度、对称性、重心等)
    handcrafted = extract_handcrafted_features(
        keypoints[:, :, :2], keypoints[:, :, 2]
    )

    # 速度特征 (与 IMU 侧对齐)
    velocity_feat = extract_velocity_features(keypoints[:, :, :2])

    return np.concatenate([handcrafted, velocity_feat])


def train_quality_regressor(
    dataset_paths: List[str],
    checkpoint_dir: str = "experiments/vision_quality_v1",
    label_name: str = "quality_score",
):
    """
    训练质量评分回归器 (LightGBM, 复用 IMU 侧).

    与 IMU 侧的 train_lgb_quality.py 逻辑一致,
    只是特征来自关键点而非 IMU 信号。
    """
    try:
        import lightgbm as lgb
    except ImportError:
        print("请安装 lightgbm: pip install lightgbm")
        return

    os.makedirs(checkpoint_dir, exist_ok=True)

    # 加载数据并提取特征
    X_list, y_list = [], []

    for jsonl_path in dataset_paths:
        records = []
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    records.append(json.loads(line))

        # 按视频分组，取滑动窗口
        video_groups = {}
        for rec in records:
            video = rec.get("video_path", "unknown")
            video_groups.setdefault(video, []).append(rec)

        for video, recs in video_groups.items():
            recs.sort(key=lambda r: r.get("timestamp", 0))
            keypoints = np.array([r["keypoints"] for r in recs], dtype=np.float32)
            quality = recs[0].get(label_name)

            if quality is None:
                continue

            # 滑动窗口提取特征
            T = keypoints.shape[0]
            window_frames = 120
            step_frames = 60

            for start in range(0, T - window_frames + 1, step_frames):
                end = start + window_frames
                window_kps = keypoints[start:end]
                features = extract_quality_features(window_kps)
                X_list.append(features)
                y_list.append(float(quality))

    X = np.stack(X_list, axis=0)
    y = np.array(y_list, dtype=np.float32)

    print(f"[质量训练] 样本数: {X.shape[0]}, 特征维度: {X.shape[1]}")

    # 训练 LightGBM
    dataset = lgb.Dataset(X, label=y)
    params = {
        "objective": "regression",
        "metric": "mae",
        "boosting_type": "gbdt",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
    }

    model = lgb.train(
        params,
        dataset,
        num_boost_round=1000,
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
    )

    # 保存
    model_path = os.path.join(checkpoint_dir, "vision_quality_model.pkl")
    joblib.dump(model, model_path)
    print(f"[质量模型] 已保存 -> {model_path}")

    return model


# ============================================================
# 主入口
# ============================================================

def main():
    """
    训练入口。使用示例:
        python -m vision.train_vision \\
            --train data_multiclass/train.jsonl \\
            --val data_multiclass/val.jsonl
    """
    import argparse

    parser = argparse.ArgumentParser(description="训练视觉 ST-GCN 模型")
    parser.add_argument("--train", type=str, required=True, help="训练集 JSONL")
    parser.add_argument("--val", type=str, default=None, help="验证集 JSONL")
    parser.add_argument("--epochs", type=int, default=200, help="训练轮数")
    parser.add_argument("--batch", type=int, default=16, help="批次大小")
    parser.add_argument("--lr", type=float, default=1e-3, help="学习率")
    parser.add_argument("--checkpoint", type=str, default="experiments/vision_stgcn_v1")
    parser.add_argument("--resume", type=str, default=None, help="从检查点恢复")
    parser.add_argument("--device", type=str, default=None, help="设备")
    args = parser.parse_args()

    # 配置
    train_cfg = TrainConfig(
        batch_size=args.batch,
        learning_rate=args.lr,
        num_epochs=args.epochs,
        checkpoint_dir=args.checkpoint,
    )

    # 数据集
    train_paths = [args.train]
    val_paths = [args.val] if args.val else []

    train_dataset = SkeletonDataset(
        train_paths,
        window_frames=train_cfg.frames_per_window,
        augment=True,
    )
    train_loader = DataLoader(
        train_dataset,
        batch_size=train_cfg.batch_size,
        shuffle=True,
        num_workers=0,
        collate_fn=lambda b: {
            "keypoints": torch.stack([x["keypoints"] for x in b]).to(
                args.device or ("cuda" if torch.cuda.is_available() else "cpu")
            ),
        },
        drop_last=True,
    )

    val_loader = None
    if val_paths:
        val_dataset = SkeletonDataset(
            val_paths,
            window_frames=train_cfg.frames_per_window,
            augment=False,
        )
        val_loader = DataLoader(
            val_dataset,
            batch_size=train_cfg.batch_size,
            shuffle=False,
            num_workers=0,
            collate_fn=lambda b: {
                "keypoints": torch.stack([x["keypoints"] for x in b]).to(
                    args.device or ("cuda" if torch.cuda.is_available() else "cpu")
                ),
            },
        )

    # 训练器
    trainer = VisionTrainer(
        stgcn_config=STGCNConfig(),
        train_config=train_cfg,
        device=args.device,
    )

    if args.resume:
        trainer.load_checkpoint(args.resume)

    # 开始训练
    trainer.fit(train_loader, val_loader)


if __name__ == "__main__":
    main()
