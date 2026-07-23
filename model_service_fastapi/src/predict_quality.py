"""Run quality-classification inference on raw JSON/JSONL action data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Sequence

import joblib
import numpy as np

from src.evaluate_against_standard import load_json_or_jsonl_records
from src.feature_engineering import segment_to_feature_vector
from src.jsonl_data_loader import (
    build_dynamic_action_label_mapping,
    convert_jsonl_sample_to_action_segment,
    get_jsonl_node_mapping,
    normalize_action_type,
)
from src.predict import load_feature_config
from src.quality_labels import estimate_quality_score_from_probabilities, get_quality_code, get_quality_representative_score


def _collect_action_types(raw_records: Sequence[Dict[str, Any]]) -> List[str]:
    action_types: List[str] = []
    for record in raw_records:
        action_type = normalize_action_type(record.get("actionType"))
        if action_type is not None:
            action_types.append(action_type)
    return action_types


def classify_quality_level(class_id: int) -> str:
    """Map a predicted class id into the configured quality band."""
    return get_quality_code(class_id)


def _predict_quality_class(model: Any, feature_vector: np.ndarray) -> tuple[int, float, float]:
    if not hasattr(model, "predict_proba"):
        predicted_class = int(model.predict(feature_vector)[0])
        return predicted_class, 1.0, round(get_quality_representative_score(predicted_class), 2)

    probabilities = model.predict_proba(feature_vector)[0]
    class_ids = np.asarray(model.classes_, dtype=int)
    best_index = int(np.argmax(probabilities))
    predicted_class = int(class_ids[best_index])
    confidence = float(probabilities[best_index])
    quality_score = estimate_quality_score_from_probabilities(
        class_ids=class_ids.tolist(),
        probabilities=probabilities.tolist(),
    )

    return predicted_class, confidence, quality_score


def predict_quality_scores(
    raw_data_path: str | Path,
    model_path: str | Path,
    feature_config_path: str | Path,
) -> Dict[str, Any]:
    """Predict quality classes for each raw segment with training-time feature settings."""
    raw_records = load_json_or_jsonl_records(raw_data_path)
    feature_config = load_feature_config(feature_config_path)
    model = joblib.load(model_path)

    action_types = _collect_action_types(raw_records)
    if not action_types:
        raise ValueError("原始动作数据中没有可用的 actionType，无法构建预测样本。")

    label_name_to_id, _ = build_dynamic_action_label_mapping(action_types)
    node_mapping = get_jsonl_node_mapping()
    predictions: List[Dict[str, Any]] = []
    predicted_segments = 0
    skipped_segments = 0

    for segment_id, raw_record in enumerate(raw_records):
        segment, validation = convert_jsonl_sample_to_action_segment(
            record=raw_record,
            segment_id=segment_id,
            label_name_to_id=label_name_to_id,
            node_mapping=node_mapping,
            min_observations_per_node=feature_config["min_samples_per_node"],
        )
        if segment is None:
            skipped_segments += 1
            predictions.append(
                {
                    "segment_id": int(segment_id),
                    "reason": str(validation.get("reason", "无法将原始样本转换为 ActionSegment。")),
                }
            )
            continue

        feature_result = segment_to_feature_vector(
            segment=segment,
            channels=feature_config["channels"],
            start_window_seconds=feature_config["start_window_seconds"],
            end_window_seconds=feature_config["end_window_seconds"],
            min_samples_per_node=feature_config["min_samples_per_node"],
            enable_missing_flags=feature_config["enable_missing_flags"],
            missing_fill_value=feature_config["missing_fill_value"],
            min_valid_nodes_per_window=feature_config["min_valid_nodes_per_window"],
        )
        if feature_result is None:
            skipped_segments += 1
            predictions.append(
                {
                    "segment_id": int(segment_id),
                    "reason": "当前样本无法按训练配置提取有效特征。",
                }
            )
            continue

        feature_vector, _metadata = feature_result
        expected_feature_dim = int(getattr(model, "n_features_in_", feature_vector.shape[0]))
        if int(feature_vector.shape[0]) != expected_feature_dim:
            raise ValueError(
                "质量模型与当前提取特征维度不一致："
                f"模型需要 {expected_feature_dim} 维，当前生成 {feature_vector.shape[0]} 维。"
            )

        predicted_class, confidence, quality_score = _predict_quality_class(
            model=model,
            feature_vector=feature_vector.reshape(1, -1),
        )
        predicted_segments += 1
        predictions.append(
            {
                "segment_id": int(segment_id),
                "predicted_quality_class": predicted_class,
                "quality_level": classify_quality_level(predicted_class),
                "quality_score": float(quality_score),
                "confidence": round(confidence, 4),
            }
        )

    return {
        "raw_file": str(Path(raw_data_path)),
        "model_file": str(Path(model_path)),
        "total_segments": int(len(raw_records)),
        "predicted_segments": int(predicted_segments),
        "skipped_segments": int(skipped_segments),
        "predictions": predictions,
    }


def save_prediction_result(output_path: str | Path, payload: Dict[str, Any]) -> None:
    """Save prediction results as UTF-8 JSON."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI parser for quality-classification prediction."""
    parser = argparse.ArgumentParser(description="使用训练好的质量分类模型预测原始动作样本的质量等级。")
    parser.add_argument("--raw", required=True, help="原始动作数据 JSON/JSONL 路径。")
    parser.add_argument("--model", required=True, help="训练好的质量分类模型 pkl 路径。")
    parser.add_argument("--feature-config", required=True, help="训练时保存的 feature_config.json 路径。")
    parser.add_argument("--output", required=True, help="输出预测结果 JSON 路径。")
    return parser


def main() -> int:
    """CLI entrypoint."""
    parser = build_arg_parser()
    args = parser.parse_args()

    try:
        result = predict_quality_scores(
            raw_data_path=Path(args.raw),
            model_path=Path(args.model),
            feature_config_path=Path(args.feature_config),
        )
        save_prediction_result(args.output, result)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
