"""Analyze a prepared quality-labeled JSONL dataset."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

from src.artifact_layout import write_standard_artifact_bundle, write_json_artifact
from src.evaluate_against_standard import load_json_or_jsonl_records
from src.quality_labels import QUALITY_CLASS_IDS, QUALITY_SCORE_BANDS, get_quality_code


def analyze_prepared_quality_dataset(data_path: str | Path) -> Dict[str, Any]:
    records = load_json_or_jsonl_records(data_path)
    action_counts: Counter[str] = Counter()
    quality_counts: Counter[str] = Counter()
    action_quality: Dict[str, Counter[str]] = {}
    session_counts: Counter[str] = Counter()
    user_counts: Counter[str] = Counter()

    for record in records:
        action = str(record.get("actionLabel") or record.get("actionType") or "unknown")
        quality_class = int(record.get("qualityClass"))
        session_id = str(record.get("sessionId") or "")
        user_id = str(record.get("userId") or "")

        action_counts[action] += 1
        quality_counts[str(quality_class)] += 1
        session_counts[session_id] += 1
        user_counts[user_id] += 1
        action_quality.setdefault(action, Counter())[str(quality_class)] += 1

    return {
        "data_file": str(Path(data_path)),
        "total_records": len(records),
        "action_counts": dict(action_counts),
        "quality_class_counts": dict(quality_counts),
        "quality_mapping": {
            str(class_id): {
                "code": get_quality_code(class_id),
                "score_band": QUALITY_SCORE_BANDS[class_id],
            }
            for class_id in QUALITY_CLASS_IDS
        },
        "action_quality_crosstab": {
            action: {str(class_id): int(counter.get(str(class_id), 0)) for class_id in QUALITY_CLASS_IDS}
            for action, counter in sorted(action_quality.items())
        },
        "session_count": len([key for key in session_counts if key]),
        "user_id_count": len([key for key in user_counts if key]),
        "session_distribution_top": dict(session_counts.most_common(10)),
        "user_distribution_top": dict(user_counts.most_common(10)),
        "identity_note": (
            "userId/openid may identify a shared collection device or operator account rather than a unique athlete. "
            "Do not treat user_id_count as a reliable person count without external metadata."
        ),
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze a prepared quality-labeled JSON/JSONL dataset.")
    parser.add_argument("--data", required=True, help="Path to prepared JSON/JSONL dataset.")
    parser.add_argument("--output", required=False, help="Optional JSON output path.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = analyze_prepared_quality_dataset(Path(args.data))
        if args.output:
            output_path = Path(args.output)
            write_json_artifact(output_path, result)
            write_standard_artifact_bundle(
                output_dir=output_path.parent,
                dataset_summary=result,
                training_summary={
                    "task": "dataset_analysis",
                    "status": "not_applicable",
                    "input_file": str(Path(args.data)),
                },
                evaluation_summary=None,
                prediction_policy={
                    "task": "dataset_analysis",
                    "policy": "not_applicable",
                },
            )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
