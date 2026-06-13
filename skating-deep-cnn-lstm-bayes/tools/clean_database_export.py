"""
清洗 database_export JSONL 数据集。

规则：
  1. actionType = "sensor_session" → 重命名为 "weight_shift"
  2. qualityTag = "不及格" → 统一为 "不合格"
  3. 前 10 帧投票：>50%（≥6 帧）包含完整 9 节点 + 非零数据 → 保留，否则丢弃
  4. actionType = "side_push_recover" → 归档到独立文件
  5. 完整 9 节点但得 0 分 → 保留（错误动作负样本）

用法:
    python tools/clean_database_export.py \
        --input database_export-...json \
        --output cleaned_training_set.jsonl \
        --archive archived_side_push_recover.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

# 必须全部存在的 9 个语义节点（与 SensorNodeMapping.REQUIRED_NODES 一致）
REQUIRED_NODES: Set[str] = {
    "head",
    "left_elbow",
    "left_wrist",
    "right_elbow",
    "right_wrist",
    "left_knee",
    "left_foot",
    "right_knee",
    "right_foot",
}

# 前 N 帧投票阈值
VOTE_FRAMES: int = 10
VOTE_MAJORITY: int = 6  # >50% of 10


def _count_complete_frames(record: Dict[str, Any]) -> Tuple[int, int]:
    """统计前 VOTE_FRAMES 帧中包含全部 9 个非零节点的帧数。

    Returns:
        (complete_count, total_checked) — total_checked 可能小于 VOTE_FRAMES。
    """
    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return 0, 0

    checked = 0
    complete = 0
    for frame in frames[:VOTE_FRAMES]:
        if not isinstance(frame, dict):
            continue
        payload = frame.get("p")
        if not isinstance(payload, dict):
            continue
        checked += 1

        present: Set[str] = set()
        for node_name, values in payload.items():
            if not isinstance(values, list) or len(values) != 6:
                continue
            if any(abs(float(v)) > 1e-8 for v in values):
                present.add(node_name)

        if present >= REQUIRED_NODES:
            complete += 1

    return complete, checked


def clean(
    input_path: str | Path,
    output_path: str | Path,
    archive_path: str | Path | None = None,
) -> dict:
    input_path = Path(input_path)
    output_path = Path(output_path)

    stats: Dict[str, int] = Counter()

    kept: List[Dict[str, Any]] = []
    archived: List[Dict[str, Any]] = []

    with open(input_path, "r", encoding="utf-8") as f_in:
        for line in f_in:
            stripped = line.strip()
            if not stripped:
                continue
            stats["total"] += 1
            record = json.loads(stripped)

            # ── 规则 1：sensor_session → weight_shift ──
            action_type = record.get("actionType")
            if action_type == "sensor_session":
                record["actionType"] = "weight_shift"
                stats["renamed_sensor_session"] += 1

            # ── 规则 2："不及格" → "不合格" ──
            label = record.get("label")
            if isinstance(label, dict) and label.get("qualityTag") == "不及格":
                label["qualityTag"] = "不合格"
                stats["normalized_quality_tag"] += 1

            # ── 规则 4：side_push_recover 归档 ──
            if record.get("actionType") == "side_push_recover":
                archived.append(record)
                stats["archived_side_push_recover"] += 1
                continue

            # ── 规则 3：前 10 帧投票 → 节点完整性判定 ──
            complete_count, total_checked = _count_complete_frames(record)
            if total_checked == 0:
                stats["dropped_no_frames"] += 1
                continue

            if complete_count < VOTE_MAJORITY:
                stats["dropped_node_incomplete"] += 1
                continue

            # ── 规则 5：完整 9 节点但得 0 分 → 保留（负样本）──
            score = label.get("coachScore") if isinstance(label, dict) else None
            if score == 0:
                stats["kept_zero_score_negative"] += 1

            kept.append(record)

    # 写入清洗后数据
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f_out:
        for record in kept:
            f_out.write(json.dumps(record, ensure_ascii=False) + "\n")

    stats["kept"] = len(kept)

    # 写入归档
    if archive_path and archived:
        archive_path = Path(archive_path)
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        with open(archive_path, "w", encoding="utf-8") as f_arch:
            for record in archived:
                f_arch.write(json.dumps(record, ensure_ascii=False) + "\n")
        stats["archived_written"] = len(archived)

    return dict(stats)


def main() -> int:
    parser = argparse.ArgumentParser(description="清洗 database_export JSONL 数据集")
    parser.add_argument("--input", required=True, help="输入 JSONL 文件路径")
    parser.add_argument("--output", default="cleaned_training_set.jsonl", help="输出路径")
    parser.add_argument("--archive", default=None, help="归档文件路径（side_push_recover）")
    args = parser.parse_args()

    stats = clean(args.input, args.output, args.archive)

    print("=" * 55)
    print("清洗完成")
    print("=" * 55)
    print(f"  总输入:                       {stats.get('total', 0):>5}")
    print(f"  sensor_session -> weight_shift: {stats.get('renamed_sensor_session', 0):>5}")
    print(f"  不及格 -> 不合格:              {stats.get('normalized_quality_tag', 0):>5}")
    print(f"  归档 (side_push_recover):       {stats.get('archived_side_push_recover', 0):>5}")
    print(f"  丢弃 (无有效帧):                {stats.get('dropped_no_frames', 0):>5}")
    print(f"  丢弃 (前10帧投票 <{VOTE_MAJORITY}/{VOTE_FRAMES}):   {stats.get('dropped_node_incomplete', 0):>5}")
    print(f"  保留 (含 0 分负样本):           {stats.get('kept_zero_score_negative', 0):>5}")
    print(f"  {'─' * 40}")
    print(f"  最终保留:                     {stats.get('kept', 0):>5}")
    if stats.get("archived_written", 0) > 0:
        print(f"  归档写入:                     {stats.get('archived_written', 0):>5}")
    print(f"  输出文件: {args.output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
