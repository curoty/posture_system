"""Dataset evaluator for training-oriented JSON/JSONL action samples."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from src.jsonl_data_loader import iter_jsonl_records, normalize_action_type


HIGH_RISK_THRESHOLD = 20
LOW_SAMPLE_THRESHOLD = 50


def load_json_or_jsonl_records(data_path: str | Path) -> List[Dict[str, Any]]:
    """Load records from either a standard JSON file or a JSONL file."""
    path = Path(data_path)
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return list(iter_jsonl_records(path))

    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = [payload]
    else:
        raise ValueError(f"Unsupported JSON top-level type: {type(payload).__name__}")

    if not all(isinstance(record, dict) for record in records):
        raise ValueError("JSON dataset records must all be objects.")
    return records


def classify_sample_risk(sample_count: int) -> str:
    """Classify a category by sample volume."""
    if sample_count < HIGH_RISK_THRESHOLD:
        return "高风险小样本"
    if sample_count <= LOW_SAMPLE_THRESHOLD:
        return "样本偏少"
    return "基本可用"


def infer_standard_label(record: Dict[str, Any]) -> Optional[str]:
    """Try to infer a standard/quality category from known fields."""
    direct_candidates = ("standard_label_name", "standard_name", "standard_label", "standard_id")
    for field_name in direct_candidates:
        field_value = record.get(field_name)
        if field_value is None:
            continue
        normalized_value = str(field_value).strip()
        if normalized_value:
            return normalized_value

    nested_label = record.get("label")
    if isinstance(nested_label, dict):
        for field_name in ("standard_label_name", "standard_name", "standard_label", "standard_id", "qualityTag"):
            field_value = nested_label.get(field_name)
            if field_value is None:
                continue
            normalized_value = str(field_value).strip()
            if normalized_value:
                return normalized_value
    return None


def summarize_counts(counts: Dict[str, int]) -> List[Dict[str, Any]]:
    """Build a sorted, annotated summary list."""
    return [
        {
            "类别": label_name,
            "样本数": sample_count,
            "风险等级": classify_sample_risk(sample_count),
        }
        for label_name, sample_count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def judge_imbalance(action_counts: Dict[str, int]) -> Dict[str, Any]:
    """Assess whether the action distribution is imbalanced."""
    if not action_counts:
        return {
            "是否不平衡": False,
            "判断依据": "没有可用动作类别样本。",
        }

    counts = list(action_counts.values())
    max_count = max(counts)
    min_count = min(counts)
    total_count = sum(counts)
    min_share = 0.0 if total_count <= 0 else float(min_count) / float(total_count)
    imbalance = bool(min_count == 0 or max_count / max(min_count, 1) >= 3.0 or min_share < 0.10)

    return {
        "是否不平衡": imbalance,
        "判断依据": (
            f"最大类/最小类比值={max_count / max(min_count, 1):.2f}，"
            f"最小类占比={min_share:.2%}。"
        ),
    }


def build_collection_advice(action_counts: Dict[str, int]) -> Dict[str, Any]:
    """Generate Chinese collection advice from action counts."""
    if not action_counts:
        return {
            "是否存在明显小样本类别": True,
            "是否建议继续采集数据": True,
            "优先补哪些类别": [],
            "中文判断": "当前没有可用动作样本，必须先补采数据。",
        }

    sorted_counts = sorted(action_counts.items(), key=lambda item: (item[1], item[0]))
    high_risk_labels = [label_name for label_name, count in sorted_counts if count < HIGH_RISK_THRESHOLD]
    low_sample_labels = [
        label_name for label_name, count in sorted_counts if HIGH_RISK_THRESHOLD <= count <= LOW_SAMPLE_THRESHOLD
    ]

    priority_labels = high_risk_labels or low_sample_labels[:3]
    should_collect_more = bool(high_risk_labels or low_sample_labels)

    if high_risk_labels:
        judgment = (
            "存在明显小样本类别，建议继续采集数据。"
            f"优先补采：{', '.join(priority_labels)}。"
        )
    elif low_sample_labels:
        judgment = (
            "目前没有高风险小样本类别，但仍有部分类别样本偏少。"
            f"建议优先补采：{', '.join(priority_labels)}。"
        )
    else:
        judgment = "各动作类别样本量整体处于基本可用范围，可先继续训练和验证，再视效果决定是否补采。"

    return {
        "是否存在明显小样本类别": bool(high_risk_labels),
        "是否建议继续采集数据": should_collect_more,
        "优先补哪些类别": priority_labels,
        "中文判断": judgment,
    }


def evaluate_json_dataset(data_path: str | Path) -> Dict[str, Any]:
    """Evaluate a JSON/JSONL dataset used for training."""
    records = load_json_or_jsonl_records(data_path)

    action_counts: Dict[str, int] = {}
    standard_counts: Dict[str, int] = {}
    invalid_action_records = 0

    for record in records:
        action_type = normalize_action_type(record.get("actionType"))
        if action_type is None:
            invalid_action_records += 1
            continue
        action_counts[action_type] = action_counts.get(action_type, 0) + 1

        standard_label = infer_standard_label(record)
        if standard_label is not None:
            standard_counts[standard_label] = standard_counts.get(standard_label, 0) + 1

    imbalance_summary = judge_imbalance(action_counts)
    collection_advice = build_collection_advice(action_counts)

    return {
        "数据文件": str(Path(data_path)),
        "总样本数": len(records),
        "动作类别统计": summarize_counts(action_counts),
        "标准类别统计": summarize_counts(standard_counts) if standard_counts else [],
        "类别分布是否不平衡": imbalance_summary,
        "采集建议": collection_advice,
        "附加信息": {
            "无效动作标签样本数": invalid_action_records,
            "动作类别总数": len(action_counts),
            "标准类别总数": len(standard_counts),
        },
    }


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser."""
    parser = argparse.ArgumentParser(description="评估训练用 JSON/JSONL 动作数据集。")
    parser.add_argument("--data", required=True, help="JSON 或 JSONL 数据文件路径。")
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = evaluate_json_dataset(args.data)
    except Exception as exc:
        print(json.dumps({"错误": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
