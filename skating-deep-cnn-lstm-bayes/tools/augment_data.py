"""
数据增强脚本 — 对清洗后的训练数据进行质量等级均衡。

增强方法（每个变体随机组合 2–3 种）：
  1. 高斯噪声（必选）：加速度/陀螺仪通道分别加噪声，σ ∈ [0.005, 0.02]
  2. 时间裁剪（50% 概率）：取 ≥150 帧子窗口，线性插值重采样回 180 帧
  3. 时间缩放（50% 概率）：时间戳整体缩放 0.9–1.1 倍
  4. 左右镜像（30% 概率）：left/right 节点对调，ax/gx/gz 取反

等级判定：通过 label.qualityTag 字段（"不合格"/"及格"/"良好"/"优秀"）。

用法:
    python tools/augment_data.py \
        --input cleaned_training_set.jsonl \
        --output training_set.jsonl \
        --seed 42
"""

from __future__ import annotations

import argparse
import copy
import json
import random
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

# ── 节点配置 ──────────────────────────────────────────────────────

REQUIRED_NODES: Tuple[str, ...] = (
    "head",
    "left_elbow",
    "left_wrist",
    "right_elbow",
    "right_wrist",
    "left_knee",
    "left_foot",
    "right_knee",
    "right_foot",
)

# 左右镜像对
MIRROR_PAIRS: Dict[str, str] = {
    "left_elbow": "right_elbow",
    "right_elbow": "left_elbow",
    "left_wrist": "right_wrist",
    "right_wrist": "left_wrist",
    "left_knee": "right_knee",
    "right_knee": "left_knee",
    "left_foot": "right_foot",
    "right_foot": "left_foot",
}

#  IMU 通道索引
ACC_CHANNELS: Tuple[int, ...] = (0, 1, 2)   # ax, ay, az
GYRO_CHANNELS: Tuple[int, ...] = (3, 4, 5)  # gx, gy, gz
# 镜像时需要取反的通道（ax, gx, gz — x 轴加速度 + x/z 轴角速度）
FLIP_CHANNELS: Tuple[int, ...] = (0, 3, 5)

# ── 等级映射 ──────────────────────────────────────────────────────

QUALITY_TAGS = ("不合格", "及格", "良好", "优秀")

# 各等级目标数量：取最大值自动均衡，可通过常量覆盖
TARGET_PER_CLASS: int = 0  # 0 = 自动取各等级最大值


def _parse_quality_tag(record: Dict[str, Any]) -> Optional[str]:
    """从记录中提取 qualityTag。"""
    # 路径 1：label.qualityTag
    label = record.get("label")
    if isinstance(label, dict):
        tag = label.get("qualityTag")
        if isinstance(tag, str) and tag.strip():
            return tag.strip()
    # 路径 2：modelOutput.qualityTag (fallback)
    mo = record.get("modelOutput")
    if isinstance(mo, dict):
        tag = mo.get("qualityTag")
        if isinstance(tag, str) and tag.strip():
            return tag.strip()
    # 路径 3：顶层 qualityLevel / qualityTag
    for key in ("qualityLevel", "qualityTag"):
        tag = record.get(key)
        if isinstance(tag, str) and tag.strip():
            return tag.strip()
    return None


# ── 增强方法 ──────────────────────────────────────────────────────

def _add_noise(
    frames: List[Dict[str, Any]],
    rng: np.random.Generator,
) -> List[Dict[str, Any]]:
    """对每帧所有节点的 IMU 值加高斯噪声（加速度/陀螺仪分别采样 σ）。"""
    sigma_acc = rng.uniform(0.005, 0.02)
    sigma_gyro = rng.uniform(0.005, 0.02)

    result: List[Dict[str, Any]] = []
    for frame in frames:
        new_frame: Dict[str, Any] = {"t": frame.get("t")}
        payload = frame.get("p")
        if not isinstance(payload, dict):
            result.append(new_frame)
            continue
        new_payload: Dict[str, List[float]] = {}
        for node, values in payload.items():
            if not isinstance(values, list) or len(values) != 6:
                new_payload[node] = list(values) if isinstance(values, list) else []
                continue
            noisy = [float(v) for v in values]
            for ch in ACC_CHANNELS:
                noisy[ch] += rng.normal(0.0, sigma_acc)
            for ch in GYRO_CHANNELS:
                noisy[ch] += rng.normal(0.0, sigma_gyro)
            new_payload[node] = noisy
        new_frame["p"] = new_payload
        result.append(new_frame)
    return result


def _time_crop(
    frames: List[Dict[str, Any]],
    rng: np.random.Generator,
    min_frames: int = 150,
    target_frames: int = 180,
) -> List[Dict[str, Any]]:
    """从序列中随机取一段 ≥min_frames 的连续窗口，线性插值回 target_frames。"""
    n = len(frames)
    if n <= target_frames:
        return frames

    # 随机起始点，确保至少有 min_frames
    max_start = n - min_frames
    start = rng.integers(0, max_start + 1) if max_start > 0 else 0
    # 随机长度
    max_len = n - start
    length = rng.integers(min_frames, max_len + 1) if max_len > min_frames else max_len
    window = frames[start : start + length]

    if length == target_frames:
        return list(window)

    # 线性插值重采样
    src_x = np.linspace(0.0, 1.0, num=length, dtype=np.float64)
    tgt_x = np.linspace(0.0, 1.0, num=target_frames, dtype=np.float64)

    result: List[Dict[str, Any]] = []
    # 收集所有节点名
    all_nodes: Set[str] = set()
    for f in window:
        p = f.get("p")
        if isinstance(p, dict):
            all_nodes.update(p.keys())

    for ti in range(target_frames):
        # 找到最近的两帧做线性插值
        pos = tgt_x[ti]
        idx = np.searchsorted(src_x, pos)
        if idx <= 0:
            result.append(copy.deepcopy(window[0]))
        elif idx >= length:
            result.append(copy.deepcopy(window[-1]))
        else:
            f0, f1 = window[idx - 1], window[idx]
            t0, t1 = src_x[idx - 1], src_x[idx]
            alpha = float((pos - t0) / (t1 - t0))
            new_frame: Dict[str, Any] = {"t": f0.get("t")}
            new_p: Dict[str, List[float]] = {}
            p0 = f0.get("p") if isinstance(f0.get("p"), dict) else {}
            p1 = f1.get("p") if isinstance(f1.get("p"), dict) else {}
            for node in all_nodes:
                v0 = p0.get(node, [0.0] * 6)
                v1 = p1.get(node, [0.0] * 6)
                if len(v0) != 6 or len(v1) != 6:
                    new_p[node] = list(v0) if v0 else [0.0] * 6
                else:
                    new_p[node] = [
                        float(v0[ch]) + alpha * (float(v1[ch]) - float(v0[ch]))
                        for ch in range(6)
                    ]
            new_frame["p"] = new_p
            result.append(new_frame)

    return result


def _time_scale(
    frames: List[Dict[str, Any]],
    rng: np.random.Generator,
) -> List[Dict[str, Any]]:
    """对时间戳做 0.9–1.1 倍缩放，模拟动作快慢变化。"""
    scale = rng.uniform(0.9, 1.1)
    result: List[Dict[str, Any]] = []
    for frame in frames:
        new_frame = copy.deepcopy(frame)
        t = new_frame.get("t")
        if isinstance(t, (int, float)):
            new_frame["t"] = float(t) * scale
        result.append(new_frame)
    return result


def _mirror(
    frames: List[Dict[str, Any]],
    rng: np.random.Generator,
) -> List[Dict[str, Any]]:
    """左右镜像：对调 left/right 节点，flip ax/gx/gz。"""
    result: List[Dict[str, Any]] = []
    for frame in frames:
        new_frame: Dict[str, Any] = {"t": frame.get("t")}
        payload = frame.get("p")
        if not isinstance(payload, dict):
            result.append(new_frame)
            continue
        new_payload: Dict[str, List[float]] = {}
        processed: Set[str] = set()
        for node, values in payload.items():
            if node in processed:
                continue
            mirrored = MIRROR_PAIRS.get(node)
            if mirrored is not None and mirrored in payload:
                # 对调
                v_self = [float(v) for v in values] if isinstance(values, list) else []
                v_other = [float(v) for v in payload[mirrored]] if isinstance(payload[mirrored], list) else []
                if len(v_self) == 6:
                    for ch in FLIP_CHANNELS:
                        v_self[ch] = -v_self[ch]
                if len(v_other) == 6:
                    for ch in FLIP_CHANNELS:
                        v_other[ch] = -v_other[ch]
                new_payload[node] = v_other
                new_payload[mirrored] = v_self
                processed.add(node)
                processed.add(mirrored)
            else:
                new_payload[node] = [float(v) for v in values] if isinstance(values, list) else []
                processed.add(node)
        new_frame["p"] = new_payload
        result.append(new_frame)
    return result


def _filter_complete(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """过滤出所有帧都包含全部 9 个非零节点的记录。"""
    result: List[Dict[str, Any]] = []
    for r in records:
        frames = r.get("frames", [])
        if not isinstance(frames, list):
            continue
        all_ok = True
        for f in frames:
            p = f.get("p") if isinstance(f, dict) else {}
            present: Set[str] = set()
            for node, values in (p.items() if isinstance(p, dict) else []):
                if isinstance(values, list) and len(values) == 6:
                    if any(abs(float(v)) > 1e-8 for v in values):
                        present.add(node)
            if not present >= set(REQUIRED_NODES):
                all_ok = False
                break
        if all_ok:
            result.append(r)
    return result


# ── 增强调度 ──────────────────────────────────────────────────────

def augment_record(
    record: Dict[str, Any],
    rng: np.random.Generator,
) -> Dict[str, Any]:
    """对单条记录应用随机 2–3 种增强方法。"""
    frames = record.get("frames", [])
    if not isinstance(frames, list) or not frames:
        return copy.deepcopy(record)

    # 方法池：噪声必选 + 随机 1–2 种其他方法
    candidates = [
        ("noise", _add_noise),
        ("crop", _time_crop),
        ("scale", _time_scale),
        ("mirror", _mirror),
    ]

    # 噪声必选
    chosen: List[Tuple[str, Any]] = [candidates[0]]

    # 其余 3 种按概率决定是否参与
    for name, func in candidates[1:]:
        prob = {"crop": 0.5, "scale": 0.5, "mirror": 0.3}[name]
        if rng.random() < prob:
            chosen.append((name, func))

    # 如果只选了噪声（概率较低但可能），再加一个随机方法
    if len(chosen) < 2:
        extra = rng.choice(candidates[1:])
        chosen.append(extra)

    # 随机打乱顺序（噪声不一定要最先，但始终参与）
    method_order = list(chosen)
    rng.shuffle(method_order)

    augmented_frames = list(frames)
    applied_methods: List[str] = []
    for name, func in method_order:
        augmented_frames = func(augmented_frames, rng)
        applied_methods.append(name)

    result = copy.deepcopy(record)
    result["frames"] = augmented_frames
    result["augmented"] = True
    result["augment_methods"] = applied_methods
    return result


# ── 主流程 ────────────────────────────────────────────────────────

def run(
    input_path: str | Path,
    output_path: str | Path,
    seed: int = 42,
) -> Dict[str, Any]:
    input_path = Path(input_path)
    output_path = Path(output_path)

    # 1. 读取
    records: List[Dict[str, Any]] = []
    with open(input_path, "r", encoding="utf-8") as f_in:
        for line in f_in:
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))

    # 2. 按等级分组
    by_tag: Dict[str, List[Dict[str, Any]]] = {tag: [] for tag in QUALITY_TAGS}
    unknown: List[Dict[str, Any]] = []
    for r in records:
        tag = _parse_quality_tag(r)
        if tag in by_tag:
            by_tag[tag].append(r)
        else:
            unknown.append(r)

    before_counts = {tag: len(by_tag[tag]) for tag in QUALITY_TAGS}

    # 3. 确定目标数量
    target = TARGET_PER_CLASS if TARGET_PER_CLASS > 0 else max(before_counts.values())

    # 4. 增强
    rng = np.random.default_rng(seed)
    random.seed(seed)

    augmented_count: Dict[str, int] = {}
    all_output: List[Dict[str, Any]] = []

    for tag in QUALITY_TAGS:
        originals = by_tag[tag]
        # 只从完全完整的记录中增强（每帧都含全部 9 个节点）
        complete_originals = _filter_complete(originals)
        skipped = len(originals) - len(complete_originals)

        all_output.extend(originals)  # 先放原始记录（包括不完整的）
        need = target - len(originals)
        if need <= 0:
            augmented_count[tag] = 0
            continue

        if not complete_originals:
            print(f"  ⚠ {tag}: 无完全完整记录可增强（需 {need} 条，但 0 条满足条件），跳过")
            augmented_count[tag] = 0
            continue

        generated = 0
        attempts = 0
        max_attempts = need * 3
        while generated < need and attempts < max_attempts:
            src = complete_originals[rng.integers(0, len(complete_originals))]
            aug = augment_record(src, rng)
            all_output.append(aug)
            generated += 1
            attempts += 1

        augmented_count[tag] = generated

    # 未知标签也保留
    all_output.extend(unknown)

    # 5. 打乱
    rng_shuffle = np.random.default_rng(seed + 1)
    indices = list(range(len(all_output)))
    rng_shuffle.shuffle(indices)
    shuffled = [all_output[i] for i in indices]

    # 6. 写入
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f_out:
        for rec in shuffled:
            f_out.write(json.dumps(rec, ensure_ascii=False) + "\n")

    after_counts = {
        tag: before_counts[tag] + augmented_count.get(tag, 0)
        for tag in QUALITY_TAGS
    }

    return {
        "total": len(shuffled),
        "before": before_counts,
        "augmented": augmented_count,
        "after": after_counts,
        "target": target,
        "unknown": len(unknown),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="训练数据增强与等级均衡")
    parser.add_argument("--input", required=True, help="清洗后的 JSONL 文件")
    parser.add_argument("--output", default="training_set.jsonl", help="输出路径")
    parser.add_argument("--seed", type=int, default=42, help="随机种子")
    parser.add_argument("--target", type=int, default=0, help="每等级目标数量（0=自动取最大值）")
    args = parser.parse_args()

    global TARGET_PER_CLASS
    TARGET_PER_CLASS = args.target

    stats = run(args.input, args.output, seed=args.seed)

    print("=" * 55)
    print("数据增强完成")
    print("=" * 55)
    print(f"  目标/等级: {stats['target']}")
    print()
    print(f"  {'等级':<8} {'增强前':>6} {'增强':>6} {'增强后':>6}")
    print(f"  {'─' * 30}")
    for tag in QUALITY_TAGS:
        print(f"  {tag:<8} {stats['before'][tag]:>6} {stats['augmented'][tag]:>6} {stats['after'][tag]:>6}")
    if stats["unknown"]:
        print(f"  {'(未知)':<8} {stats['unknown']:>6} {'0':>6} {stats['unknown']:>6}")
    print(f"  {'─' * 30}")
    print(f"  {'合计':<8} {sum(stats['before'].values()) + stats['unknown']:>6} "
          f"{sum(stats['augmented'].values()):>6} {stats['total']:>6}")
    print()
    print(f"  原始: {sum(stats['before'].values())}")
    print(f"  增强: {sum(stats['augmented'].values())}")
    print(f"  输出: {stats['total']} 条 → {args.output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
