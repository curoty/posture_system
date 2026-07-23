"""整合多类别训练数据集(weight_shift + side_push_recover)。

流程:合并多个导出文件 → 按 _id 去重 → 清洗(整段投票) → 按 _id 分层切分
→ 只增强训练集的少数类 → 输出 train/val/test。

与旧的单类别管道(clean_database_export + augment_data + split)的两点差异,均为
适配多类别的必要改动:
  1. 保留 side_push_recover(旧管道把它归档丢弃)。
  2. 节点完整性改用"整段投票"而非"前10帧投票"——前10帧因传感器启动延迟常缺节点,
     对 side_push_recover 误杀严重(89→23);整段投票保留 89→66,更公允。
  3. 先切分、再只增强训练集少数类 → 验证/测试集保持真实数据,评估更诚实。

用法:
    python tools/build_multiclass_dataset.py \
        --inputs "../database_export-...json" "C:/Users/xunyi/Desktop/样本.txt" \
        --output-dir data_multiclass --seed 42
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.augment_data import augment_record  # 复用已验证的增强函数

REQUIRED_NODES: Set[str] = {
    "head", "left_elbow", "left_wrist", "right_elbow", "right_wrist",
    "left_knee", "left_foot", "right_knee", "right_foot",
}
KEEP_ACTIONS = {"weight_shift", "side_push_recover"}
VOTE_RATIO = 0.5  # 整段完整帧占比阈值


def _frame_complete(frame: Dict[str, Any]) -> bool:
    p = frame.get("p") if isinstance(frame, dict) else None
    if not isinstance(p, dict):
        return False
    present = {
        n for n, v in p.items()
        if isinstance(v, list) and len(v) == 6 and any(abs(float(x)) > 1e-8 for x in v)
    }
    return present >= REQUIRED_NODES


def _clean_record(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    at = record.get("actionType")
    if at == "sensor_session":
        record["actionType"] = "weight_shift"
        at = "weight_shift"
    if at not in KEEP_ACTIONS:
        return None

    label = record.get("label")
    if isinstance(label, dict) and label.get("qualityTag") == "不及格":
        label["qualityTag"] = "不合格"

    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return None
    complete = sum(1 for fr in frames if _frame_complete(fr))
    if complete / len(frames) < VOTE_RATIO:
        return None
    return record


def _load_and_merge(input_paths: List[str]) -> List[Dict[str, Any]]:
    seen: Set[str] = set()
    merged: List[Dict[str, Any]] = []
    dup = 0
    for path in input_paths:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                rid = str(rec.get("_id"))
                if rid in seen:
                    dup += 1
                    continue
                seen.add(rid)
                merged.append(rec)
    print(f"  合并 {len(input_paths)} 个文件:{len(merged)} 条(跨文件去重丢弃 {dup} 条)")
    return merged


def _stratified_split_ids(
    records: List[Dict[str, Any]], val_ratio: float, test_ratio: float, seed: int,
):
    by_action: Dict[str, List[str]] = defaultdict(list)
    for r in records:
        by_action[r.get("actionType")].append(str(r.get("_id")))

    rng = np.random.default_rng(seed)
    train_ids, val_ids, test_ids = set(), set(), set()
    for action, ids in by_action.items():
        ids = list(dict.fromkeys(ids))  # 去重保序
        rng.shuffle(ids)
        n = len(ids)
        n_test = max(1, round(n * test_ratio)) if n > 1 else 0
        n_val = max(1, round(n * val_ratio)) if n - n_test > 1 else 0
        test_ids.update(ids[:n_test])
        val_ids.update(ids[n_test:n_test + n_val])
        train_ids.update(ids[n_test + n_val:])
    return train_ids, val_ids, test_ids


def build(
    input_paths: List[str],
    output_dir: str,
    val_ratio: float = 0.1,
    test_ratio: float = 0.1,
    minority_target: int = 600,
    seed: int = 42,
) -> Dict[str, Any]:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    print("[1/4] 合并 + 去重")
    merged = _load_and_merge(input_paths)

    print("[2/4] 清洗(整段投票 + 保留两类)")
    cleaned = [c for c in (_clean_record(r) for r in merged) if c is not None]
    action_dist = Counter(r.get("actionType") for r in cleaned)
    print(f"  清洗后:{len(cleaned)} 条,类别分布:{dict(action_dist)}")

    print("[3/4] 按 _id 分层切分(先切分,评估集保持真实数据)")
    train_ids, val_ids, test_ids = _stratified_split_ids(cleaned, val_ratio, test_ratio, seed)
    by_id: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in cleaned:
        by_id[str(r.get("_id"))].append(r)

    def collect(ids: Set[str]) -> List[Dict[str, Any]]:
        res = []
        for rid in ids:
            res.extend(by_id[rid])
        return res

    train = collect(train_ids)
    val = collect(val_ids)
    test = collect(test_ids)

    print("[4/4] 只增强训练集的少数类 side_push_recover")
    minority = [r for r in train if r.get("actionType") == "side_push_recover"]
    majority_train = sum(1 for r in train if r.get("actionType") == "weight_shift")
    target = min(minority_target, majority_train)
    rng = np.random.default_rng(seed + 7)
    augmented: List[Dict[str, Any]] = []
    if minority and len(minority) < target:
        need = target - len(minority)
        for _ in range(need):
            src = minority[int(rng.integers(0, len(minority)))]
            augmented.append(augment_record(src, rng))
    train_final = train + augmented
    rng.shuffle(train_final)

    def write(path: Path, recs: List[Dict[str, Any]]) -> None:
        with open(path, "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    write(out / "train.jsonl", train_final)
    write(out / "val.jsonl", val)
    write(out / "test.jsonl", test)

    def dist(recs):
        return dict(Counter(r.get("actionType") for r in recs))

    summary = {
        "inputs": input_paths,
        "cleaned_total": len(cleaned),
        "cleaned_action_dist": dict(action_dist),
        "train": {"total": len(train_final), "real": len(train), "augmented": len(augmented),
                  "action_dist": dist(train_final)},
        "val": {"total": len(val), "action_dist": dist(val)},
        "test": {"total": len(test), "action_dist": dist(test)},
        "note": "side_push_recover 真实样本稀少(数据饥饿),val/test 为真实数据,train 已增强少数类。",
    }
    with open(out / "dataset_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="整合多类别训练数据集")
    parser.add_argument("--inputs", nargs="+", required=True, help="一个或多个导出文件路径")
    parser.add_argument("--output-dir", default="data_multiclass")
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    parser.add_argument("--minority-target", type=int, default=600,
                        help="训练集少数类增强目标条数")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    summary = build(
        args.inputs, args.output_dir,
        val_ratio=args.val_ratio, test_ratio=args.test_ratio,
        minority_target=args.minority_target, seed=args.seed,
    )
    print("\n" + "=" * 58)
    print("多类别数据集构建完成")
    print("=" * 58)
    print(f"  清洗后类别分布: {summary['cleaned_action_dist']}")
    print(f"  train: {summary['train']['total']} 条 "
          f"(真实 {summary['train']['real']} + 增强 {summary['train']['augmented']}) "
          f"{summary['train']['action_dist']}")
    print(f"  val:   {summary['val']['total']} 条 {summary['val']['action_dist']}")
    print(f"  test:  {summary['test']['total']} 条 {summary['test']['action_dist']}")
    print(f"  输出目录: {args.output_dir}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
