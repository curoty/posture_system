"""Deployment simulation: test model robustness to real-world perturbations.

Applies common sensor degradation patterns to test samples and compares
quality scores against clean predictions.  Large score swings under mild
perturbation indicate an unstable model.

Perturbations tested:
  1. Gaussian noise (σ = 0.05, 0.10, 0.20 × sensor std)
  2. Time scaling (0.8×, 1.2× speed)
  3. Amplitude variation (0.8×, 1.2× magnitude)
  4. Sensor dropout (random 1-2 nodes zeroed)
  5. Gyro drift (linear ramp on gyro channels)
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
from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    iter_jsonl_records,
)
from src.quality_labels import score_to_quality_label


def perturb_noise(sequence: np.ndarray, scale: float, rng: np.random.Generator) -> np.ndarray:
    """Add Gaussian noise scaled to the per-channel std."""
    out = sequence.copy()
    for c in range(sequence.shape[1]):
        ch_std = float(np.std(sequence[:, c]))
        noise_std = max(ch_std, 1e-8) * scale
        out[:, c] += rng.normal(0, noise_std, size=sequence.shape[0]).astype(np.float32)
    return out


def perturb_time_scale(sequence: np.ndarray, factor: float) -> np.ndarray:
    """Stretch or compress the temporal axis via linear interpolation."""
    T, C = sequence.shape
    if factor == 1.0:
        return sequence.copy()
    new_T = max(1, int(T * factor))
    src_x = np.linspace(0, 1, T)
    tgt_x = np.linspace(0, 1, new_T)
    out = np.empty((new_T, C), dtype=np.float32)
    for c in range(C):
        out[:, c] = np.interp(tgt_x, src_x, sequence[:, c])
    # Resample back to original length
    if new_T != T:
        final = np.empty((T, C), dtype=np.float32)
        src2_x = np.linspace(0, 1, new_T)
        tgt2_x = np.linspace(0, 1, T)
        for c in range(C):
            final[:, c] = np.interp(tgt2_x, src2_x, out[:, c])
        return final
    return out


def perturb_amplitude(sequence: np.ndarray, factor: float) -> np.ndarray:
    """Scale the magnitude of all IMU readings."""
    return (sequence * factor).astype(np.float32)


def perturb_dropout(sequence: np.ndarray, node_indices: List[int],
                    channels_per_node: int = 6, num_nodes: int = 9) -> np.ndarray:
    """Zero out entire sensor nodes."""
    out = sequence.copy()
    C_per_node = channels_per_node
    for ni in node_indices:
        start = ni * C_per_node
        end = start + C_per_node
        out[:, start:end] = 0.0
    return out


def perturb_gyro_drift(sequence: np.ndarray, drift_rate: float,
                       channels_per_node: int = 6, num_nodes: int = 9) -> np.ndarray:
    """Add a linear ramp to gyro channels (indices 3,4,5 within each node)."""
    out = sequence.copy()
    T = sequence.shape[0]
    ramp = np.linspace(0, drift_rate * T, T, dtype=np.float32)
    for ni in range(num_nodes):
        base = ni * channels_per_node
        for gi in range(3, 6):  # gyro channels
            out[:, base + gi] += ramp
    return out


def predict_single(
    sequence: np.ndarray,
    action_model,
    checkpoint: dict,
    lgb_bundle: Optional[dict],
    device,
    record: dict,
    reference_library=None,
) -> Optional[float]:
    """Run quality prediction on a single normalized sequence.  Returns score or None."""
    from src.predict import predict_record

    # Build a minimal record from the perturbed sequence
    # We piggyback on predict_record which needs a full record dict
    result = predict_record(
        record=record,
        action_model=action_model,
        checkpoint=checkpoint,
        device=device,
        lgb_quality_model_path=None,
        reference_library=reference_library,
    )

    if lgb_bundle is not None and result.get("success"):
        # Re-predict with LGB using the perturbed sequence embedding
        try:
            X_norm = apply_normalization(
                np.expand_dims(sequence, axis=0), checkpoint["normalization"])
            import torch
            t = torch.as_tensor(X_norm, dtype=torch.float32, device=device)
            with torch.no_grad():
                logits, emb = action_model(t, return_embedding=True)
                probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
                emb_arr = emb.cpu().numpy()[0]

            from src.predict import _extract_lgb_features_inference, _resolve_action_prob_names, _align_feature_names
            from src.quality_labels import apply_calibration

            seq_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
            action_labels = {
                int(lid): str(name)
                for lid, name in checkpoint["label_metadata"]["action_labels"].items()
            }
            pred_action_id = int(np.argmax(probs))
            action_name = action_labels.get(pred_action_id, "unknown")

            # Extract raw sequence from original record for motion stats
            from src.predict import _extract_raw_sequence_inference
            raw_seq = _extract_raw_sequence_inference(record, seq_config)

            meta = result.get("metadata", {})
            feature_names = lgb_bundle["feature_names"]
            action_prob_names = _resolve_action_prob_names(feature_names, len(probs))

            features = _extract_lgb_features_inference(
                normalized_sequence=X_norm[0],
                embedding=emb_arr,
                probabilities=probs,
                action_name=action_name,
                duration_seconds=float(meta.get("duration_seconds", 0.0)),
                missing_node_ratio=float(meta.get("missing_node_ratio", 0.0)),
                raw_sequence=raw_seq if raw_seq is not None else np.zeros((1, 9, 6), dtype=np.float32),
                node_order=seq_config.node_order,
                reference_library=reference_library,
                feature_names=feature_names,
            )
            features = _align_feature_names(features, feature_names, action_prob_names, probs)

            scaler = lgb_bundle["scaler"]
            booster = lgb_bundle["booster"]
            cal_params = lgb_bundle.get("calibration_params", {})

            X_scaled = scaler.transform(features)
            raw_score = float(booster.predict(X_scaled, num_iteration=booster.best_iteration)[0])

            if cal_params:
                score = apply_calibration(raw_score, cal_params)
            else:
                score = float(np.clip(raw_score, 0.0, 100.0))
            return float(np.clip(score, 0.0, 100.0))
        except Exception:
            pass

    return result.get("quality_score")


def run_simulation(
    jsonl_path: str,
    action_model_path: str,
    lgb_model_path: Optional[str],
    reference_library_path: Optional[str],
    num_samples: int = 10,
    output_path: Optional[str] = None,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    import torch

    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))
    action_model, checkpoint = load_action_model(action_model_path, device=device)

    lgb_bundle = None
    if lgb_model_path is not None:
        lgb_bundle = load_lgb_quality_model(lgb_model_path)

    reference_library = None
    if reference_library_path is not None:
        from src.similarity_scoring import load_reference_library
        ref_path = Path(reference_library_path)
        if ref_path.exists():
            try:
                reference_library = load_reference_library(ref_path)
            except Exception:
                pass

    records = list(iter_jsonl_records(jsonl_path))
    if len(records) > num_samples:
        rng = np.random.default_rng(42)
        indices = rng.choice(len(records), num_samples, replace=False)
        records = [records[i] for i in indices]
    else:
        num_samples = len(records)

    rng = np.random.default_rng(123)

    perturbations = {
        "noise_0.05": lambda s: perturb_noise(s, 0.05, rng),
        "noise_0.10": lambda s: perturb_noise(s, 0.10, rng),
        "noise_0.20": lambda s: perturb_noise(s, 0.20, rng),
        "time_fast_1.2x": lambda s: perturb_time_scale(s, 1.2),
        "time_slow_0.8x": lambda s: perturb_time_scale(s, 0.8),
        "amp_low_0.8x": lambda s: perturb_amplitude(s, 0.8),
        "amp_high_1.2x": lambda s: perturb_amplitude(s, 1.2),
        "dropout_1node": lambda s: perturb_dropout(
            s, [int(rng.integers(0, 9))]),
        "dropout_2nodes": lambda s: perturb_dropout(
            s, [int(rng.integers(0, 9)), int(rng.integers(0, 9))]),
        "gyro_drift": lambda s: perturb_gyro_drift(s, 0.01),
    }

    results: List[Dict[str, Any]] = []
    all_deltas: Dict[str, List[float]] = {name: [] for name in perturbations}

    seq_config = SequenceConfig.from_dict(checkpoint["sequence_config"])

    for si, record in enumerate(records):
        sequence, _, meta = convert_record_to_sequence(
            record, config=seq_config, label_name_to_id=None, require_action_type=False,
        )
        if sequence is None:
            continue

        clean_score = predict_single(
            sequence, action_model, checkpoint, lgb_bundle, device,
            record, reference_library,
        )
        if clean_score is None:
            continue

        sample_result = {
            "sample_index": int(si),
            "action_type": str(record.get("actionType", "")),
            "clean_score": round(clean_score, 2),
            "clean_label": score_to_quality_label(clean_score),
            "perturbations": {},
        }

        for pert_name, pert_fn in perturbations.items():
            try:
                perturbed_seq = pert_fn(sequence)
                pert_score = predict_single(
                    perturbed_seq, action_model, checkpoint,
                    lgb_bundle, device, record, reference_library,
                )
                if pert_score is not None:
                    delta = pert_score - clean_score
                    all_deltas[pert_name].append(delta)
                    sample_result["perturbations"][pert_name] = {
                        "score": round(pert_score, 2),
                        "delta": round(delta, 2),
                        "label": score_to_quality_label(pert_score),
                    }
            except Exception:
                sample_result["perturbations"][pert_name] = {"error": "perturbation_failed"}

        results.append(sample_result)

    # Summary statistics
    summary = {}
    for pert_name, deltas in all_deltas.items():
        if not deltas:
            summary[pert_name] = {"n": 0, "status": "no_data"}
            continue
        arr = np.array(deltas)
        summary[pert_name] = {
            "n": int(len(arr)),
            "mean_delta": round(float(np.mean(arr)), 3),
            "std_delta": round(float(np.std(arr)), 3),
            "max_abs_delta": round(float(np.max(np.abs(arr))), 3),
            "p95_abs_delta": round(float(np.percentile(np.abs(arr), 95)), 3),
            "label_shift_pct": round(
                100.0 * np.mean([
                    1.0 if score_to_quality_label(50.0 + d) != score_to_quality_label(50.0)
                    else 0.0
                    for d in arr
                ]), 1
            ),
            "status": (
                "stable" if float(np.std(arr)) < 3.0
                else "moderate" if float(np.std(arr)) < 8.0
                else "unstable"
            ),
        }

    report = {
        "config": {
            "jsonl_path": jsonl_path,
            "action_model": action_model_path,
            "lgb_model": lgb_model_path,
            "num_samples": int(num_samples),
        },
        "summary": summary,
        "details": results,
        "overall_status": (
            "stable" if all(s.get("status") == "stable" for s in summary.values() if s.get("n", 0) > 0)
            else "unstable" if any(s.get("status") == "unstable" for s in summary.values())
            else "moderate"
        ),
    }

    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    return report


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deployment robustness simulation.")
    parser.add_argument("--jsonl", required=True, help="Path to test JSONL samples.")
    parser.add_argument("--action-model", required=True, help="Path to action_model.pt.")
    parser.add_argument("--lgb-quality-model", default=None, help="Path to lgb_quality_model.pkl.")
    parser.add_argument("--reference-library", default=None, help="Path to reference library.")
    parser.add_argument("--num-samples", type=int, default=10)
    parser.add_argument("--output", default=None, help="Output JSON path.")
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        report = run_simulation(
            jsonl_path=args.jsonl,
            action_model_path=args.action_model,
            lgb_model_path=args.lgb_quality_model,
            reference_library_path=args.reference_library,
            num_samples=args.num_samples,
            output_path=args.output,
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
