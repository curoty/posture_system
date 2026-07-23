"""
按 _id 分组切分 train/val/test。

同一条原始记录及其所有数据增强变体共享同一个 _id，必须整体分到同一个集合，
否则增强变体会把原始记录的"影子"泄漏到 val/test 里，导致评估指标虚高。

按 qualityTag 分层抽样，保证各集合的质量等级分布与整体一致。

用法:
    python tools/split_train_val_test.py \
        --input training_set.jsonl \
        --train-output training_set_train.jsonl \
        --val-output training_set_val.jsonl \
        --test-output training_set_test.jsonl \
        --val-ratio 0.1 --test-ratio 0.1 --seed 42
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np


def _parse_quality_tag(record: Dict[str, Any]) -> Optional[str]:
    label = record.get("label")
    if isinstance(label, dict):
        tag = label.get("qualityTag")
        if isinstance(tag, str) and tag.strip():
            return tag.strip()
    return None


def split(
    input_path: str | Path,
    train_output: str | Path,
    val_output: str | Path,
    test_output: str | Path,
    val_ratio: float = 0.1,
    test_ratio: float = 0.1,
    seed: int = 42,
) -> Dict[str, Any]:
    records: List[Dict[str, Any]] = []
    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))

    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    group_tag: Dict[str, str] = {}
    for r in records:
        rid = str(r.get("_id"))
        groups[rid].append(r)
        if rid not in group_tag:
            group_tag[rid] = _parse_quality_tag(r) or "unknown"

    by_tag: Dict[str, List[str]] = defaultdict(list)
    for rid, tag in group_tag.items():
        by_tag[tag].append(rid)

    rng = np.random.default_rng(seed)
    train_ids: List[str] = []
    val_ids: List[str] = []
    test_ids: List[str] = []

    for tag, ids in by_tag.items():
        ids = list(ids)
        rng.shuffle(ids)
        n = len(ids)
        n_test = min(n, max(1, round(n * test_ratio))) if n > 0 else 0
        n_val = min(n - n_test, max(1, round(n * val_ratio))) if n - n_test > 0 else 0
        test_ids.extend(ids[:n_test])
        val_ids.extend(ids[n_test:n_test + n_val])
        train_ids.extend(ids[n_test + n_val:])

    train_set, val_set, test_set = set(train_ids), set(val_ids), set(test_ids)
    if (train_set & val_set) or (train_set & test_set) or (val_set & test_set):
        raise RuntimeError("split groups overlap — this should never happen")

    def write(path: str | Path, ids: List[str]) -> int:
        n_written = 0
        with open(path, "w", encoding="utf-8") as f:
            for rid in ids:
                for rec in groups[rid]:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    n_written += 1
        return n_written

    Path(train_output).parent.mkdir(parents=True, exist_ok=True)
    n_train = write(train_output, train_ids)
    n_val = write(val_output, val_ids)
    n_test = write(test_output, test_ids)

    def tag_counts(ids: List[str]) -> Dict[str, int]:
        counts: Dict[str, int] = defaultdict(int)
        for rid in ids:
            counts[group_tag[rid]] += 1
        return dict(counts)

    return {
        "total_records": len(records),
        "total_groups": len(groups),
        "train_groups": len(train_ids), "train_records": n_train, "train_tag_dist": tag_counts(train_ids),
        "val_groups": len(val_ids), "val_records": n_val, "val_tag_dist": tag_counts(val_ids),
        "test_groups": len(test_ids), "test_records": n_test, "test_tag_dist": tag_counts(test_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="按 _id 分组切分 train/val/test（防止增强变体跨集合泄漏）")
    parser.add_argument("--input", required=True, help="增强后的 JSONL 文件")
    parser.add_argument("--train-output", default="training_set_train.jsonl")
    parser.add_argument("--val-output", default="training_set_val.jsonl")
    parser.add_argument("--test-output", default="training_set_test.jsonl")
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    stats = split(
        args.input, args.train_output, args.val_output, args.test_output,
        val_ratio=args.val_ratio, test_ratio=args.test_ratio, seed=args.seed,
    )

    print("=" * 55)
    print("数据切分完成（按 _id 分组，已校验 train/val/test 无重叠）")
    print("=" * 55)
    print(f"  总记录数: {stats['total_records']}  (去重后原始 _id 组数: {stats['total_groups']})")
    print(f"  train: {stats['train_groups']:>4} 组 / {stats['train_records']:>4} 条 -> {args.train_output}")
    print(f"    等级分布: {stats['train_tag_dist']}")
    print(f"  val:   {stats['val_groups']:>4} 组 / {stats['val_records']:>4} 条 -> {args.val_output}")
    print(f"    等级分布: {stats['val_tag_dist']}")
    print(f"  test:  {stats['test_groups']:>4} 组 / {stats['test_records']:>4} 条 -> {args.test_output}")
    print(f"    等级分布: {stats['test_tag_dist']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
