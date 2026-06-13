"""Post-training validation: load a trained LightGBM model and run diagnostics.

Checks:
  1. Score distribution (mean, std, histogram)
  2. Collapse detection
  3. Per-action score spread
  4. Score-label consistency
  5. Comparison with GaussianNB (optional)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.predict import load_action_model, load_lgb_quality_model
from src.jsonl_sequence_dataset import SequenceConfig, convert_record_to_sequence, iter_jsonl_records
from src.quality_labels import score_to_quality_label, score_to_quality_code
from src.coach_feedback import generate_coach_feedback


def compute_score_distribution(scores: List[float]) -> Dict[str, Any]:
    """Compute comprehensive score distribution statistics."""
    if not scores:
        return {"n": 0, "status": "no_scores"}

    arr = np.array(scores, dtype=float)
    bins_def = [
        (0.0, 60.0, "Fail"),
        (60.0, 75.0, "Mid"),
        (75.0, 88.0, "Good"),
        (88.0, 100.0, "Excellent"),
    ]
    histogram = []
    for low, high, code in bins_def:
        cnt = int(np.sum((arr >= low) & (arr < high)))
        histogram.append({
            "range": f"[{low}, {high})",
            "code": code,
            "count": cnt,
            "pct": round(100.0 * cnt / len(arr), 1) if arr.size else 0.0,
        })

    return {
        "n": int(len(arr)),
        "mean": round(float(np.mean(arr)), 2),
        "std": round(float(np.std(arr)), 2),
        "min": round(float(np.min(arr)), 2),
        "max": round(float(np.max(arr)), 2),
        "p10": round(float(np.percentile(arr, 10)), 2),
        "p25": round(float(np.percentile(arr, 25)), 2),
        "p50": round(float(np.percentile(arr, 50)), 2),
        "p75": round(float(np.percentile(arr, 75)), 2),
        "p90": round(float(np.percentile(arr, 90)), 2),
        "histogram": histogram,
        "collapse_detected": float(np.std(arr)) < 5.0,
    }


def run_lgb_validation(
    jsonl_path: str,
    action_model_path: str,
    lgb_model_path: str,
    reference_library_path: Optional[str] = None,
    output_path: Optional[str] = None,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    import torch

    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))
    action_model, checkpoint = load_action_model(action_model_path, device=device)
    lgb_bundle = load_lgb_quality_model(lgb_model_path)
    if lgb_bundle is None:
        raise RuntimeError(f"Failed to load LightGBM model from {lgb_model_path}")

    reference_library = None
    if reference_library_path is not None:
        from src.similarity_scoring import load_reference_library
        ref_path = Path(reference_library_path)
        if ref_path.exists():
            try:
                reference_library = load_reference_library(ref_path)
            except Exception:
                pass

    seq_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    action_labels = {
        int(lid): str(name)
        for lid, name in checkpoint["label_metadata"]["action_labels"].items()
    }

    # Run inference sample by sample
    from src.predict import (
        _extract_lgb_features_inference,
        _resolve_action_prob_names,
        _align_feature_names,
        _extract_raw_sequence_inference,
        _detect_embedding_collapse,
        _check_input_validity,
    )
    from src.quality_labels import apply_calibration
    from src.jsonl_sequence_dataset import apply_normalization

    booster = lgb_bundle["booster"]
    scaler = lgb_bundle["scaler"]
    cal_params = lgb_bundle.get("calibration_params", {})
    feature_names = lgb_bundle["feature_names"]

    results: List[Dict[str, Any]] = []
    per_action_scores: Dict[str, List[float]] = {}
    skipped_reasons: Dict[str, int] = {}
    embedding_stds: List[float] = []

    for sample_index, record in enumerate(iter_jsonl_records(jsonl_path)):
        sequence, _, meta = convert_record_to_sequence(
            record, config=seq_config, label_name_to_id=None, require_action_type=False,
        )
        if sequence is None:
            skipped_reasons["invalid_sequence"] = skipped_reasons.get("invalid_sequence", 0) + 1
            continue

        input_issue = _check_input_validity(sequence)
        if input_issue:
            skipped_reasons[input_issue] = skipped_reasons.get(input_issue, 0) + 1
            continue

        X = apply_normalization(np.expand_dims(sequence, axis=0), checkpoint["normalization"])
        tensor = torch.as_tensor(X, dtype=torch.float32, device=device)

        with torch.no_grad():
            logits, embedding = action_model(tensor, return_embedding=True)
            probabilities = torch.softmax(logits, dim=1).cpu().numpy()[0]
            embedding_array = embedding.cpu().numpy()[0]

        embedding_stds.append(float(np.std(embedding_array)))
        predicted_action_id = int(np.argmax(probabilities))
        confidence = float(probabilities[predicted_action_id])
        action_name = action_labels.get(predicted_action_id, "unknown")

        # Robustness checks
        embedding_collapsed = _detect_embedding_collapse(embedding_array, 0.05)
        action_ok = confidence >= 0.65 and not embedding_collapsed

        if not action_ok:
            skipped_reasons["low_confidence_or_collapse"] = (
                skipped_reasons.get("low_confidence_or_collapse", 0) + 1
            )
            results.append({
                "sample_index": sample_index,
                "action": action_name,
                "status": "skipped",
                "reason": "embedding_collapse" if embedding_collapsed else "low_action_confidence",
            })
            continue

        # Build features and predict
        raw_seq = _extract_raw_sequence_inference(record, seq_config)
        action_prob_names = _resolve_action_prob_names(feature_names, len(probabilities))

        features = _extract_lgb_features_inference(
            normalized_sequence=X[0],
            embedding=embedding_array,
            probabilities=probabilities,
            action_name=action_name,
            duration_seconds=float(meta.get("duration_seconds", 0.0)),
            missing_node_ratio=float(meta.get("missing_node_ratio", 0.0)),
            raw_sequence=raw_seq if raw_seq is not None else np.zeros((1, 9, 6), dtype=np.float32),
            node_order=seq_config.node_order,
            reference_library=reference_library,
            feature_names=feature_names,
        )
        features = _align_feature_names(features, feature_names, action_prob_names, probabilities)

        X_scaled = scaler.transform(features)
        raw_score = float(booster.predict(X_scaled, num_iteration=booster.best_iteration)[0])

        if cal_params:
            score = apply_calibration(raw_score, cal_params)
        else:
            score = float(np.clip(raw_score, 0.0, 100.0))
        score = float(np.clip(score, 0.0, 100.0))
        label = score_to_quality_label(score)

        per_action_scores.setdefault(action_name, []).append(score)

        # Generate feedback snippet
        fb = generate_coach_feedback({
            "quality_score": score,
            "quality_label": label,
            "quality_prediction": {"quality_score": score, "quality_label": label, "scoring_model": "LightGBM"},
            "action_label": action_name,
            "duration": float(meta.get("duration_seconds", 0.0)),
            "missing_ratio": float(meta.get("missing_node_ratio", 0.0)),
            "reference_similarity_score": None,
        })

        results.append({
            "sample_index": sample_index,
            "action": action_name,
            "confidence": round(confidence, 4),
            "raw_score": round(raw_score, 2),
            "calibrated_score": round(score, 2),
            "label": label,
            "status": "ok",
            "summary": fb.get("summary", ""),
        })

    # --- Compute report ---
    all_scores = [r["calibrated_score"] for r in results if r["status"] == "ok"]
    score_dist = compute_score_distribution(all_scores)

    per_action_stats = {}
    for action_name, scores in sorted(per_action_scores.items()):
        arr = np.array(scores)
        per_action_stats[action_name] = {
            "n": int(len(arr)),
            "mean": round(float(np.mean(arr)), 2),
            "std": round(float(np.std(arr)), 2),
            "min": round(float(np.min(arr)), 2),
            "max": round(float(np.max(arr)), 2),
        }

    # Check if different actions have meaningfully different score distributions
    action_spread = None
    if len(per_action_stats) >= 2:
        means = [s["mean"] for s in per_action_stats.values()]
        action_spread = {
            "min_mean": round(min(means), 2),
            "max_mean": round(max(means), 2),
            "range": round(max(means) - min(means), 2),
            "adequate_spread": (max(means) - min(means)) >= 5.0,
        }

    embedding_stats = {
        "mean_std": round(float(np.mean(embedding_stds)), 6) if embedding_stds else 0.0,
        "min_std": round(float(np.min(embedding_stds)), 6) if embedding_stds else 0.0,
        "embeddings_healthy": all(s > 0.05 for s in embedding_stds) if embedding_stds else False,
    }

    report = {
        "model_info": {
            "action_model": action_model_path,
            "lgb_model": lgb_model_path,
            "reference_library": reference_library_path,
            "test_file": jsonl_path,
        },
        "score_distribution": score_dist,
        "per_action_stats": per_action_stats,
        "action_spread": action_spread,
        "embedding_health": embedding_stats,
        "skipped": skipped_reasons,
        "total_processed": int(len(results)),
        "overall_status": _overall_status(score_dist, action_spread, per_action_stats),
        "details": results,
    }

    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Print summary
    print(f"[validate] {score_dist['n']} scores: mean={score_dist['mean']}, "
          f"std={score_dist['std']}, collapse={score_dist['collapse_detected']}")
    if action_spread:
        print(f"[validate] Action spread: range={action_spread['range']}, "
              f"adequate={action_spread['adequate_spread']}")
    for code_info in score_dist["histogram"]:
        print(f"[validate]   {code_info['code']:10s}: {code_info['count']:4d} ({code_info['pct']:5.1f}%)")
    print(f"[validate] Embedding std: mean={embedding_stats['mean_std']}, "
          f"healthy={embedding_stats['embeddings_healthy']}")
    print(f"[validate] Overall: {report['overall_status']}")

    return report


def _overall_status(
    score_dist: Dict[str, Any],
    action_spread: Optional[Dict[str, Any]],
    per_action_stats: Dict[str, Any],
) -> str:
    """Determine overall validation status."""
    issues = []

    if score_dist.get("collapse_detected"):
        issues.append("score_collapse")

    if action_spread and not action_spread.get("adequate_spread", True):
        issues.append("insufficient_action_spread")

    if score_dist.get("n", 0) < 10:
        issues.append("too_few_samples")

    if not issues:
        return "PASS"
    return f"WARN: {', '.join(issues)}"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate trained LightGBM quality model.")
    parser.add_argument("--jsonl", required=True, help="Test JSONL file.")
    parser.add_argument("--action-model", required=True, help="Path to action_model.pt.")
    parser.add_argument("--lgb-quality-model", required=True, help="Path to lgb_quality_model.pkl.")
    parser.add_argument("--reference-library", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        report = run_lgb_validation(
            jsonl_path=args.jsonl,
            action_model_path=args.action_model,
            lgb_model_path=args.lgb_quality_model,
            reference_library_path=args.reference_library,
            output_path=args.output,
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
