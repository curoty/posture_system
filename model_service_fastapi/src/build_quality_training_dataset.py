"""Build a clean quality-training dataset from raw action data and evaluation results."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from src.evaluate_against_standard import load_json_or_jsonl_records
from src.jsonl_data_loader import normalize_action_type
from src.quality_labels import convert_score_to_quality_class, get_quality_code, get_quality_label_zh


UNJUDGEABLE_GRADES = {"不可评估", "未评估", "unjudgeable", "unjudged"}
LEGACY_GRADE_TO_SCORE_BAND = {
    "非常好": 3,
    "优秀": 3,
    "好": 2,
    "良好": 2,
    "中等": 1,
    "及格": 1,
    "不合格": 0,
    "不通过": 0,
}
EVALUATION_ROWS_KEYS = ("evaluation_rows", "samples", "逐样本结果", "结果明细", "评价结果", "详细结果")
SAMPLE_INDEX_KEYS = ("sample_index", "sample_id", "样本编号")
ACTION_TYPE_KEYS = ("actionType", "action_type", "动作类型", "动作类别")
SCORE_KEYS = ("similarity_score", "score", "regression_label", "相似度评分", "相似度")
GRADE_KEYS = ("grade_name", "quality_grade", "quality_band", "评级", "质量等级", "评判等级")


def _first_present(mapping: Dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def _load_evaluation_rows(evaluation_result_path: str | Path) -> List[Dict[str, Any]]:
    payload = json.loads(Path(evaluation_result_path).read_text(encoding="utf-8"))
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = None
        for key in EVALUATION_ROWS_KEYS:
            candidate = payload.get(key)
            if isinstance(candidate, list):
                rows = candidate
                break
        if rows is None:
            raise ValueError("Evaluation payload must contain a list under a supported rows key.")
    else:
        raise ValueError("Evaluation payload must be a JSON object or JSON array.")

    return [row for row in rows if isinstance(row, dict)]


def _parse_sample_index(row: Dict[str, Any]) -> int | None:
    value = _first_present(row, SAMPLE_INDEX_KEYS)
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None


def _parse_score(row: Dict[str, Any]) -> float | None:
    value = _first_present(row, SCORE_KEYS)
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _parse_grade_name(row: Dict[str, Any], score: float | None) -> str:
    raw_grade = _first_present(row, GRADE_KEYS)
    if raw_grade is not None:
        grade_name = str(raw_grade).strip()
        if grade_name:
            return grade_name
    if score is None:
        return "Unknown"
    return get_quality_label_zh(convert_score_to_quality_class(score))


def _is_unjudgeable_grade(grade_name: str) -> bool:
    return grade_name.strip().lower() in {item.lower() for item in UNJUDGEABLE_GRADES}


def _resolve_quality_class(grade_name: str, score: float) -> int:
    normalized_grade = grade_name.strip()
    if normalized_grade in LEGACY_GRADE_TO_SCORE_BAND:
        return int(LEGACY_GRADE_TO_SCORE_BAND[normalized_grade])
    return convert_score_to_quality_class(score)


def _build_output_row(
    sample_index: int,
    raw_record: Dict[str, Any],
    evaluation_row: Dict[str, Any],
) -> Dict[str, Any]:
    label_payload = raw_record.get("label", {}) if isinstance(raw_record.get("label"), dict) else {}
    similarity_score = float(_parse_score(evaluation_row))
    grade_name = _parse_grade_name(evaluation_row, similarity_score)
    quality_class = _resolve_quality_class(grade_name, similarity_score)

    return {
        "sample_index": int(sample_index),
        "action_type": normalize_action_type(
            _first_present(evaluation_row, ACTION_TYPE_KEYS) or raw_record.get("actionType")
        ),
        "similarity_score": similarity_score,
        "grade_name": grade_name,
        "coach_score": label_payload.get("coachScore"),
        "quality_tag": label_payload.get("qualityTag"),
        "session_id": raw_record.get("sessionId"),
        "user_id": raw_record.get("userId"),
        "frame_count": raw_record.get("frameCount"),
        "regression_label": similarity_score,
        "quality_class": int(quality_class),
        "quality_code": get_quality_code(quality_class),
        "quality_label_zh": get_quality_label_zh(quality_class),
    }


def _write_rows(output_path: Path, rows: List[Dict[str, Any]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = output_path.suffix.lower()

    if suffix == ".csv":
        if not rows:
            output_path.write_text("", encoding="utf-8")
            return
        with output_path.open("w", encoding="utf-8", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        return

    if suffix == ".json":
        output_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        return

    with output_path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def build_quality_training_dataset(
    raw_data_path: str | Path,
    evaluation_result_path: str | Path,
    output_path: str | Path,
) -> Dict[str, Any]:
    """Merge raw action data with evaluation results into a clean training dataset."""
    raw_records = load_json_or_jsonl_records(raw_data_path)
    evaluation_rows = _load_evaluation_rows(evaluation_result_path)

    evaluation_by_sample_id: Dict[int, Dict[str, Any]] = {}
    for row in evaluation_rows:
        sample_id = _parse_sample_index(row)
        if sample_id is not None:
            evaluation_by_sample_id[sample_id] = row

    output_rows: List[Dict[str, Any]] = []
    grade_counts: Dict[str, int] = {}
    quality_code_counts: Dict[str, int] = {}
    action_counts: Dict[str, int] = {}

    for sample_index, raw_record in enumerate(raw_records):
        evaluation_row = evaluation_by_sample_id.get(sample_index)
        if evaluation_row is None:
            continue

        score = _parse_score(evaluation_row)
        grade_name = _parse_grade_name(evaluation_row, score)
        if score is None or _is_unjudgeable_grade(grade_name):
            continue

        output_row = _build_output_row(sample_index, raw_record, evaluation_row)
        output_rows.append(output_row)

        grade_counts[output_row["grade_name"]] = grade_counts.get(output_row["grade_name"], 0) + 1
        quality_code_counts[output_row["quality_code"]] = quality_code_counts.get(output_row["quality_code"], 0) + 1
        action_type = str(output_row["action_type"])
        action_counts[action_type] = action_counts.get(action_type, 0) + 1

    output_path = Path(output_path)
    _write_rows(output_path, output_rows)

    return {
        "raw_data_file": str(Path(raw_data_path)),
        "evaluation_result_file": str(Path(evaluation_result_path)),
        "output_file": str(output_path),
        "total_rows": len(output_rows),
        "grade_counts": grade_counts,
        "quality_code_counts": quality_code_counts,
        "action_counts": action_counts,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a clean quality training dataset from raw data and evaluations.")
    parser.add_argument("--raw", required=True, help="Path to raw action JSON/JSONL file.")
    parser.add_argument("--evaluation", required=True, help="Path to evaluation JSON file.")
    parser.add_argument("--output", required=True, help="Output JSONL/CSV/JSON path.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = build_quality_training_dataset(
            raw_data_path=Path(args.raw),
            evaluation_result_path=Path(args.evaluation),
            output_path=Path(args.output),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
