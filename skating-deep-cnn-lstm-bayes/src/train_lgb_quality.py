"""Train a LightGBM Regressor for continuous quality scoring (0–100).

Replaces the GaussianNB quality classifier with a gradient-boosted regression
model that produces continuous scores directly, eliminating score collapse
and the fixed-82 problem.

Pipeline:
  action model checkpoint
  → convert quality-labeled samples to deep embeddings
  → build rich feature matrix (embedding + temporal + stability + similarity)
  → StandardScaler
  → LightGBM Regressor with early stopping
  → score calibration
  → save model artifacts
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import torch
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    iter_jsonl_records,
    write_json,
)
from src.model import ActionModelConfig, CNNLSTMAttentionClassifier
from src.quality_labels import (
    calibrate_scores,
    convert_score_to_quality_class,
    score_to_quality_code,
    score_to_quality_label,
)
from src.similarity_scoring import ReferenceLibrary, load_reference_library

# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def _compute_temporal_stats(sequence: np.ndarray) -> Dict[str, float]:
    """Aggregated temporal statistics across all channels."""
    flat = sequence.reshape(sequence.shape[0], -1)  # [T, C]
    frame_means = np.mean(np.abs(flat), axis=1)  # per-frame magnitude
    return {
        "temporal_mean": float(np.mean(frame_means)),
        "temporal_std": float(np.std(frame_means)),
        "temporal_max": float(np.max(frame_means)),
        "temporal_min": float(np.min(frame_means)),
    }


def _compute_motion_stability(raw_sequence: np.ndarray, node_order: Tuple[str, ...]) -> Dict[str, float]:
    """Per-node acceleration/gyro variance and global jerk roughness.

    Args:
        raw_sequence: [T, nodes, 6] with channels (ax, ay, az, gx, gy, gz).
        node_order: Tuple of node names matching the sequence axis.
    """
    features: Dict[str, float] = {}
    num_nodes = raw_sequence.shape[1]

    # Global motion stability
    acc = raw_sequence[:, :, 0:3]   # [T, nodes, 3]
    gyro = raw_sequence[:, :, 3:6]  # [T, nodes, 3]

    features["acc_var_global"] = float(np.var(acc))
    features["gyro_var_global"] = float(np.var(gyro))

    # Jerk: derivative of acceleration, roughness = mean(|jerk|)
    jerk = np.diff(acc, axis=0)
    features["jerk_roughness"] = float(np.mean(np.abs(jerk))) if jerk.size else 0.0

    # Per-node variance
    for ni in range(num_nodes):
        node_name = node_order[ni] if ni < len(node_order) else f"node_{ni}"
        features[f"node_{node_name}_acc_var"] = float(np.var(acc[:, ni, :]))
        features[f"node_{node_name}_gyro_var"] = float(np.var(gyro[:, ni, :]))

    return features


def _compute_similarity_features(
    embedding: np.ndarray,
    sequence: np.ndarray,
    action_name: str,
    duration_seconds: float,
    missing_node_ratio: float,
    reference_library: Optional[ReferenceLibrary],
) -> Dict[str, float]:
    """Extract similarity-based features when a reference library is available."""
    if reference_library is None:
        return {"sim_top1": 0.0, "sim_topk_mean": 0.0, "sim_temporal_align": 0.0}

    from src.similarity_scoring import score_sequence_against_references

    result = score_sequence_against_references(
        sequence=sequence,
        embedding=embedding,
        action_name=action_name,
        duration_seconds=duration_seconds,
        missing_node_ratio=missing_node_ratio,
        reference_library=reference_library,
        top_k=5,
    )
    if not result.get("success", False):
        return {"sim_top1": 0.0, "sim_topk_mean": 0.0, "sim_temporal_align": 0.0}

    matches = result.get("top_matches", [])
    if not matches:
        return {"sim_top1": 0.0, "sim_topk_mean": 0.0, "sim_temporal_align": 0.0}

    top1_sim = float(matches[0]["overall_similarity"])
    topk_mean = float(np.mean([m["overall_similarity"] for m in matches]))
    temporal_align = float(matches[0].get("temporal_similarity", 0.0))

    return {
        "sim_top1": top1_sim,
        "sim_topk_mean": topk_mean,
        "sim_temporal_align": temporal_align,
    }


def build_lgb_feature_matrix(
    model: CNNLSTMAttentionClassifier,
    checkpoint: Dict[str, Any],
    raw_records: List[Dict[str, Any]],
    sample_indices: List[int],
    device: torch.device,
    reference_library: Optional[ReferenceLibrary] = None,
) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]], List[str]]:
    """Build a rich feature matrix for LightGBM regression.

    Returns:
        features: [N, D] float32 feature matrix.
        quality_scores: [N] float32 target scores.
        metadata_rows: Per-sample metadata dicts.
        feature_names: Ordered list of feature column names.
    """
    sequence_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    node_order = sequence_config.node_order
    label_name_to_id = {
        str(name): int(label_id)
        for name, label_id in checkpoint["label_metadata"]["action_label_to_id"].items()
    }
    id_to_name = {
        int(label_id): str(name)
        for name, label_id in label_name_to_id.items()
    }
    num_actions = int(checkpoint["model_config"]["num_classes"])

    sequences_raw: List[np.ndarray] = []
    sequences_norm: List[np.ndarray] = []
    metadata_rows: List[Dict[str, Any]] = []
    action_labels: List[int] = []

    for sample_index in sample_indices:
        if sample_index < 0 or sample_index >= len(raw_records):
            continue
        # Store raw sequence before normalization for motion stats
        raw_record = raw_records[sample_index]
        sequence, label_id, meta = convert_record_to_sequence(
            raw_record,
            config=sequence_config,
            label_name_to_id=label_name_to_id,
            require_action_type=True,
        )
        if sequence is None or label_id is None:
            continue

        meta["sample_index"] = int(sample_index)
        metadata_rows.append(meta)
        sequences_raw.append(sequence)
        action_labels.append(int(label_id))

        # Re-extract the raw per-node sequence for motion-stability features
        raw_seq = _extract_raw_sequence(raw_record, sequence_config)
        sequences_norm.append(raw_seq if raw_seq is not None else sequence)

    if not sequences_raw:
        raise ValueError("No quality-labeled samples could be converted.")

    X_norm = apply_normalization(
        np.stack(sequences_raw).astype(np.float32),
        checkpoint["normalization"],
    )

    # Extract embeddings and action probabilities
    with torch.no_grad():
        tensor = torch.as_tensor(X_norm, dtype=torch.float32, device=device)
        logits, embeddings = model(tensor, return_embedding=True)
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()
        embeddings_array = embeddings.cpu().numpy().astype(np.float32)

    feature_blocks: List[np.ndarray] = []
    feature_names: List[str] = []

    # --- Block 1: Deep embedding ---
    emb_names = [f"emb_{i}" for i in range(embeddings_array.shape[1])]
    feature_blocks.append(embeddings_array)
    feature_names.extend(emb_names)

    # --- Block 2: Action probabilities ---
    prob_names = [f"action_prob_{id_to_name.get(i, f'class_{i}')}" for i in range(num_actions)]
    feature_blocks.append(probabilities.astype(np.float32))
    feature_names.extend(prob_names)

    # --- Block 3-5: Per-sample handcrafted features ---
    temporal_feats: List[Dict[str, float]] = []
    stability_feats: List[Dict[str, float]] = []
    similarity_feats: List[Dict[str, float]] = []
    scalar_feats: List[Dict[str, float]] = []

    for i, meta in enumerate(metadata_rows):
        temporal_feats.append(_compute_temporal_stats(sequences_raw[i]))
        stability_feats.append(_compute_motion_stability(sequences_norm[i], node_order))

        predicted_action_id = int(np.argmax(probabilities[i]))
        action_name = id_to_name.get(predicted_action_id, "unknown")
        meta["predicted_action_id"] = predicted_action_id
        meta["action_confidence"] = float(np.max(probabilities[i]))

        similarity_feats.append(_compute_similarity_features(
            embedding=embeddings_array[i],
            sequence=X_norm[i],
            action_name=action_name,
            duration_seconds=float(meta.get("duration_seconds", 0.0)),
            missing_node_ratio=float(meta.get("missing_node_ratio", 0.0)),
            reference_library=reference_library,
        ))

        scalar_feats.append({
            "duration_seconds": float(meta.get("duration_seconds", 0.0)),
            "missing_node_ratio": float(meta.get("missing_node_ratio", 0.0)),
        })

    # Collect feature block names (from first sample)
    for feat_dicts, block_tag in [
        (temporal_feats, ""),
        (stability_feats, ""),
        (similarity_feats, ""),
        (scalar_feats, ""),
    ]:
        if feat_dicts:
            keys = list(feat_dicts[0].keys())
            feature_blocks.append(
                np.array([[d[k] for k in keys] for d in feat_dicts], dtype=np.float32)
            )
            feature_names.extend(keys)

    features = np.concatenate(feature_blocks, axis=1).astype(np.float32)
    return features, np.array(action_labels, dtype=int), metadata_rows, feature_names


def _extract_raw_sequence(
    record: Dict[str, Any],
    config: SequenceConfig,
) -> Optional[np.ndarray]:
    """Extract raw [T, nodes, 6] sequence from a record for motion-stability stats."""
    from src.jsonl_sequence_dataset import (
        JSONL_TO_MODEL_NODE_MAPPING,
        RAW_IMU_CHANNELS,
        _fill_nan_vector,
    )

    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return None

    sorted_frames = sorted(
        [f for f in frames if isinstance(f, dict)],
        key=lambda item: float(item.get("t", 0.0)),
    )
    if not sorted_frames:
        return None

    node_to_index = {node: i for i, node in enumerate(config.node_order)}
    raw = np.full(
        (len(sorted_frames), len(config.node_order), len(RAW_IMU_CHANNELS)),
        np.nan,
        dtype=np.float32,
    )
    valid_mask = np.zeros((len(sorted_frames), len(config.node_order)), dtype=bool)

    for fi, frame in enumerate(sorted_frames):
        node_payload = frame.get("p")
        if not isinstance(node_payload, dict):
            continue
        for raw_node, values in node_payload.items():
            mapped = JSONL_TO_MODEL_NODE_MAPPING.get(str(raw_node))
            if mapped not in node_to_index:
                continue
            if not isinstance(values, list) or len(values) != len(RAW_IMU_CHANNELS):
                continue
            ni = node_to_index[mapped]
            raw[fi, ni, :] = np.asarray(values, dtype=np.float32)
            valid_mask[fi, ni] = True

    # NaN fill
    for ni in range(raw.shape[1]):
        for ci in range(raw.shape[2]):
            raw[:, ni, ci] = _fill_nan_vector(raw[:, ni, ci], 0.0)

    return raw


# ---------------------------------------------------------------------------
# Quality label loading
# ---------------------------------------------------------------------------

def load_quality_scores(
    dataset_path: str | Path,
) -> Dict[int, float]:
    """Load sample_index → continuous_score mapping from CSV/JSON/JSONL.

    Handles both legacy class-id labels and continuous coachScore values.
    """
    import csv

    path = Path(dataset_path)
    suffix = path.suffix.lower()
    rows: List[Dict[str, Any]] = []

    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as f:
            rows = [dict(r) for r in csv.DictReader(f)]
    elif suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            rows = [dict(r) for r in payload if isinstance(r, dict)]
        elif isinstance(payload, dict) and isinstance(payload.get("evaluation_rows"), list):
            rows = [dict(r) for r in payload["evaluation_rows"] if isinstance(r, dict)]
    else:
        # JSONL fallback
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    p = json.loads(stripped)
                    if isinstance(p, dict):
                        rows.append(p)

    score_map: Dict[int, float] = {}
    for row in rows:
        sample_index = None
        for key in ("sample_index", "sample_id", "id"):
            try:
                sample_index = int(row.get(key))
                break
            except (TypeError, ValueError):
                continue
        if sample_index is None:
            continue

        # Try continuous score first
        score = None
        for key in ("coachScore", "score", "quality_score", "regression_label",
                     "similarity_score", "similarity"):
            try:
                val = row.get(key)
                if val is not None:
                    score = float(val)
                    break
            except (TypeError, ValueError):
                continue

        # Fall back to class-id → representative score (legacy)
        if score is None:
            for key in ("quality_class", "class_id", "qualityClass"):
                try:
                    class_id = int(row.get(key))
                    # Map legacy class IDs to representative continuous scores
                    legacy_map = {0: 29.5, 1: 67.0, 2: 82.0, 3: 95.0}
                    score = legacy_map.get(class_id)
                    break
                except (TypeError, ValueError):
                    continue

        if score is not None:
            score_map[int(sample_index)] = float(np.clip(score, 0.0, 100.0))

    return score_map


# ---------------------------------------------------------------------------
# Training entry point
# ---------------------------------------------------------------------------

def run_lgb_training(
    raw_data_path: str | Path,
    quality_dataset_path: str | Path,
    action_model_path: str | Path,
    output_dir: str | Path,
    reference_library_path: Optional[str | Path] = None,
    only_correct_actions: bool = True,
    min_action_confidence: float = 0.0,
    val_ratio: float = 0.2,
    calibration_ratio: float = 0.1,
    seed: int = 42,
    device_name: Optional[str] = None,
    lgb_params: Optional[Dict[str, Any]] = None,
    calibration_target_mean: float = 72.0,
    calibration_target_std: float = 20.0,
) -> Dict[str, Any]:
    """Full LightGBM quality regression training pipeline."""
    import lightgbm as lgb

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

    # --- Load action model ---
    checkpoint = torch.load(action_model_path, map_location=device, weights_only=False)
    model_config = ActionModelConfig.from_dict(checkpoint["model_config"])
    action_model = CNNLSTMAttentionClassifier(model_config)
    action_model.load_state_dict(checkpoint["model_state_dict"])
    action_model.to(device)
    action_model.eval()

    # --- Load reference library ---
    reference_library = None
    if reference_library_path is not None:
        ref_path = Path(reference_library_path)
        if ref_path.exists():
            try:
                reference_library = load_reference_library(ref_path)
            except Exception:
                pass  # Reference library is optional

    # --- Load data ---
    raw_records = list(iter_jsonl_records(raw_data_path))
    quality_score_map = load_quality_scores(quality_dataset_path)
    if len(quality_score_map) < 2:
        raise ValueError("Need at least 2 quality-labeled samples for regression training.")

    # --- Label distribution analysis ---
    label_stats = _analyze_label_distribution(list(quality_score_map.values()))
    print(f"[labels] n={label_stats['n']}, mean={label_stats['mean']:.1f}, "
          f"std={label_stats['std']:.1f}, min={label_stats['min']:.1f}, max={label_stats['max']:.1f}")
    for bin_info in label_stats["bins"]:
        print(f"[labels]   [{bin_info['low']},{bin_info['high']}): "
              f"{bin_info['count']:4d} ({bin_info['pct']:.1f}%)")
    if label_stats["std"] < 8.0:
        print("[labels] WARNING: label std < 8 — model may struggle to produce spread scores")
    if label_stats["collapse_risk"]:
        print("[labels] WARNING: >60% labels concentrated in one bin — high collapse risk")

    # --- Build features ---
    ordered_indices = sorted(quality_score_map.keys())
    features, true_actions, metadata_rows, feature_names = build_lgb_feature_matrix(
        model=action_model,
        checkpoint=checkpoint,
        raw_records=raw_records,
        sample_indices=[int(i) for i in ordered_indices],
        device=device,
        reference_library=reference_library,
    )
    quality_scores = np.array(
        [quality_score_map[int(m["sample_index"])] for m in metadata_rows],
        dtype=np.float32,
    )

    # --- Filter: correct actions only ---
    predicted_actions = np.array(
        [int(m["predicted_action_id"]) for m in metadata_rows], dtype=int
    )
    success_mask = np.ones(len(metadata_rows), dtype=bool)
    if only_correct_actions:
        success_mask &= predicted_actions == true_actions
    if min_action_confidence > 0.0:
        success_mask &= np.array(
            [float(m["action_confidence"]) for m in metadata_rows]
        ) >= min_action_confidence

    selected_features = features[success_mask]
    selected_scores = quality_scores[success_mask]
    selected_meta = [m for m, keep in zip(metadata_rows, success_mask.tolist()) if keep]
    filter_policy = "correct_action_only" if only_correct_actions else "all_samples"

    if len(selected_features) < 4:
        selected_features = features
        selected_scores = quality_scores
        selected_meta = metadata_rows
        filter_policy = "fallback_all_samples"

    # --- Train / val / calibration split ---
    n_total = len(selected_features)
    n_cal = max(1, int(n_total * calibration_ratio))
    indices = np.arange(n_total)
    rng = np.random.default_rng(seed)
    rng.shuffle(indices)

    cal_indices = indices[:n_cal]
    remaining = indices[n_cal:]

    train_idx, val_idx = train_test_split(
        remaining,
        test_size=val_ratio,
        random_state=seed,
    )

    # --- Scale features ---
    scaler = StandardScaler()
    X_train = scaler.fit_transform(selected_features[train_idx])
    X_val = scaler.transform(selected_features[val_idx])
    X_cal = scaler.transform(selected_features[cal_indices])
    y_train = selected_scores[train_idx]
    y_val = selected_scores[val_idx]
    y_cal = selected_scores[cal_indices]

    # --- Train LightGBM ---
    default_params: Dict[str, Any] = {
        "objective": "regression",
        "metric": "rmse",
        "boosting_type": "gbdt",
        "num_leaves": 15,
        "learning_rate": 0.03,
        "feature_fraction": 0.7,
        "bagging_fraction": 0.7,
        "bagging_freq": 5,
        "min_data_in_leaf": 10,
        "min_child_samples": 10,
        "min_sum_hessian_in_leaf": 0.01,
        "lambda_l1": 0.5,
        "lambda_l2": 2.0,
        "verbose": -1,
        "random_state": seed,
        "num_threads": -1,
        "force_col_wise": True,
    }
    if lgb_params:
        default_params.update(lgb_params)

    train_data = lgb.Dataset(X_train, label=y_train)
    val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

    print(f"[train] n_train={len(train_idx)}, n_val={len(val_idx)}, n_cal={len(cal_indices)}")
    print(f"[train] n_features={selected_features.shape[1]}, params: leaves={default_params['num_leaves']}, "
          f"lr={default_params['learning_rate']}, l1={default_params['lambda_l1']}, l2={default_params['lambda_l2']}")

    booster = lgb.train(
        params=default_params,
        train_set=train_data,
        valid_sets=[train_data, val_data],
        valid_names=["train", "val"],
        num_boost_round=2000,
        callbacks=[
            lgb.early_stopping(stopping_rounds=50),
            lgb.log_evaluation(period=100),
        ],
    )

    # --- Evaluate ---
    y_pred_train = booster.predict(X_train, num_iteration=booster.best_iteration)
    y_pred_val = booster.predict(X_val, num_iteration=booster.best_iteration)
    y_pred_cal = booster.predict(X_cal, num_iteration=booster.best_iteration)

    # --- Calibration ---
    # target_mean=72.0 shifts the score distribution so ~15-20% of predictions
    # land above 88 (Excellent).  Lower to 65 for conservative scoring, raise to
    # 75 for more optimistic scoring.
    cal_params = _fit_calibration_params(
        y_pred_cal,
        target_mean=calibration_target_mean,
        target_std=calibration_target_std,
    )
    y_pred_val_calibrated = np.clip(
        (y_pred_val - cal_params["raw_mean"]) / max(cal_params["raw_std"], 1e-6)
        * cal_params["target_std"] + cal_params["target_mean"],
        0.0, 100.0,
    )

    train_metrics = _regression_metrics(y_train, y_pred_train)
    val_metrics = _regression_metrics(y_val, y_pred_val)
    val_cal_metrics = _regression_metrics(y_val, y_pred_val_calibrated)

    # --- Collapse detection ---
    collapse_result = _detect_collapse(y_pred_val, y_pred_val_calibrated)
    if collapse_result["collapse_detected"]:
        print(f"[collapse] WARNING: {collapse_result['warning']}")
    else:
        print(f"[collapse] OK — raw std={collapse_result['raw_std']:.1f}, "
              f"cal std={collapse_result['calibrated_std']:.1f}")

    # --- Feature importance ---
    importance = booster.feature_importance(importance_type="gain")
    importance_list = sorted(
        [
            {"feature": feature_names[i], "importance": float(importance[i])}
            for i in range(min(len(feature_names), len(importance)))
        ],
        key=lambda x: x["importance"],
        reverse=True,
    )[:30]

    # Show top features for diagnostics
    top_features_str = ", ".join(
        f"{item['feature']}({item['importance']:.1f})" for item in importance_list[:10]
    )

    # Feature importance by category
    importance_by_category = _analyze_feature_importance_by_category(importance_list)
    print(f"[features] top-5: {top_features_str}")
    for cat_name, cat_info in importance_by_category.items():
        print(f"[features]   {cat_name}: {cat_info['total_importance']:.1f} "
              f"({cat_info['pct']:.1f}%, n={cat_info['n_features']})")
    dominant = max(importance_by_category.items(), key=lambda x: x[1]["pct"])
    if dominant[1]["pct"] > 60.0:
        print(f"[features] WARNING: '{dominant[0]}' dominates ({dominant[1]['pct']:.0f}%) — "
              f"model may be over-reliant on one feature group")

    # Distribution diagnostics
    raw_dist = {
        "mean": float(np.mean(y_pred_val)),
        "std": float(np.std(y_pred_val)),
        "min": float(np.min(y_pred_val)),
        "max": float(np.max(y_pred_val)),
        "p25": float(np.percentile(y_pred_val, 25)),
        "p50": float(np.percentile(y_pred_val, 50)),
        "p75": float(np.percentile(y_pred_val, 75)),
    }
    cal_dist = {
        "mean": float(np.mean(y_pred_val_calibrated)),
        "std": float(np.std(y_pred_val_calibrated)),
        "min": float(np.min(y_pred_val_calibrated)),
        "max": float(np.max(y_pred_val_calibrated)),
        "p25": float(np.percentile(y_pred_val_calibrated, 25)),
        "p50": float(np.percentile(y_pred_val_calibrated, 50)),
        "p75": float(np.percentile(y_pred_val_calibrated, 75)),
    }

    # --- Save artifacts ---
    model_bundle = {
        "model_type": "lightgbm_regressor",
        "booster": booster,
        "scaler": scaler,
        "calibration_params": cal_params,
        "feature_names": feature_names,
        "feature_config": {
            "model_type": "LightGBM",
            "feature_source": "deep_embedding_plus_handcrafted",
            "feature_dim": int(selected_features.shape[1]),
            "embedding_dim": int(checkpoint["model_config"]["embedding_dim"]),
            "num_actions": int(checkpoint["model_config"]["num_classes"]),
            "handcrafted_groups": ["temporal_stats", "motion_stability", "similarity", "metadata"],
            "filter_policy": filter_policy,
            "only_correct_actions": bool(only_correct_actions),
            "min_action_confidence": float(min_action_confidence),
        },
        "version": "2.0.0",
    }

    model_path = output_path / "lgb_quality_model.pkl"
    joblib.dump(model_bundle, model_path)

    # --- Save metadata ---
    dataset_summary = {
        "task": "lightgbm_quality_regression",
        "raw_data_file": str(Path(raw_data_path)),
        "quality_dataset_file": str(Path(quality_dataset_path)),
        "action_model_file": str(Path(action_model_path)),
        "quality_rows": int(len(quality_score_map)),
        "converted_samples": int(len(features)),
        "selected_samples": int(len(selected_features)),
        "train_samples": int(len(train_idx)),
        "val_samples": int(len(val_idx)),
        "cal_samples": int(len(cal_indices)),
        "filter_policy": filter_policy,
        "score_distribution": {
            "train": {"mean": float(np.mean(y_train)), "std": float(np.std(y_train))},
            "val": {"mean": float(np.mean(y_val)), "std": float(np.std(y_val))},
        },
    }

    training_summary = {
        "task": "lightgbm_quality_regression",
        "model_file": str(model_path),
        "best_iteration": int(booster.best_iteration),
        "lgb_params": default_params,
        "metrics": {
            "train": train_metrics,
            "val_raw": val_metrics,
            "val_calibrated": val_cal_metrics,
        },
        "score_distribution": {
            "raw": raw_dist,
            "calibrated": cal_dist,
        },
        "top_features": importance_list,
        "feature_dim": int(selected_features.shape[1]),
        "num_features": len(feature_names),
    }

    prediction_policy = {
        "task": "lightgbm_quality_regression",
        "policy": "lightgbm_continuous_regression",
        "score_range": [0, 100],
        "thresholds": [
            {"range": [0, 60], "label": "不合格", "code": "Fail"},
            {"range": [60, 75], "label": "一般", "code": "Mid"},
            {"range": [75, 88], "label": "良好", "code": "Good"},
            {"range": [88, 100], "label": "优秀", "code": "Excellent"},
        ],
        "calibration": cal_params,
        "quality_gating": {
            "min_action_confidence": 0.65,
            "top_margin_threshold": 0.15,
            "embedding_collapse_threshold": 0.05,
        },
    }

    # --- Training report ---
    training_report = {
        "label_distribution": label_stats,
        "train_samples": int(len(train_idx)),
        "val_samples": int(len(val_idx)),
        "cal_samples": int(len(cal_indices)),
        "best_iteration": int(booster.best_iteration),
        "lgb_params": {k: v for k, v in default_params.items() if k != "num_threads"},
        "metrics": {
            "train": train_metrics,
            "val_raw": val_metrics,
            "val_calibrated": val_cal_metrics,
        },
        "score_distribution": {
            "raw": raw_dist,
            "calibrated": cal_dist,
            "y_true_dist": {
                "mean": float(np.mean(y_val)),
                "std": float(np.std(y_val)),
            },
        },
        "collapse_detected": bool(collapse_result["collapse_detected"]),
        "collapse_warning": collapse_result.get("warning"),
        "feature_importance": {
            "top20": importance_list[:20],
            "by_category": importance_by_category,
        },
        "calibration_params": cal_params,
    }

    artifacts = {
        "lgb_quality_model.pkl": str(model_path),
        "dataset_summary.json": str(write_json(output_path / "dataset_summary.json", dataset_summary)),
        "training_summary.json": str(write_json(output_path / "training_summary.json", training_summary)),
        "training_report.json": str(write_json(output_path / "training_report.json", training_report)),
        "prediction_policy.json": str(write_json(output_path / "prediction_policy.json", prediction_policy)),
        "feature_config.json": str(write_json(output_path / "feature_config.json", model_bundle["feature_config"])),
        "feature_names.json": str(write_json(output_path / "feature_names.json", {"names": feature_names})),
        "top_features.json": str(write_json(output_path / "top_features.json", importance_list)),
    }

    return {
        "model_file": str(model_path),
        "samples": int(len(selected_features)),
        "train_samples": int(len(train_idx)),
        "val_samples": int(len(val_idx)),
        "best_iteration": int(booster.best_iteration),
        "metrics": training_summary["metrics"],
        "score_distribution": training_summary["score_distribution"],
        "top_features": top_features_str,
        "collapse_detected": bool(collapse_result["collapse_detected"]),
        "artifacts": artifacts,
    }


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

def _fit_calibration_params(
    raw_scores: np.ndarray,
    target_mean: float = 65.0,
    target_std: float = 20.0,
) -> Dict[str, Any]:
    """Compute z-score calibration parameters from a calibration set.

    Stores the raw-score statistics so inference can apply the identical
    z-score stretch:  calibrated = (score - raw_mean)/raw_std * target_std + target_mean
    """
    raw = np.asarray(raw_scores, dtype=float).ravel()
    return {
        "method": "zscore_normalization",
        "raw_mean": float(np.mean(raw)),
        "raw_std": float(np.std(raw)),
        "target_mean": float(target_mean),
        "target_std": float(target_std),
    }


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, Any]:
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    yt = np.asarray(y_true, dtype=float)
    yp = np.asarray(y_pred, dtype=float)

    mae = float(mean_absolute_error(yt, yp))
    rmse = float(np.sqrt(mean_squared_error(yt, yp)))
    r2 = float(r2_score(yt, yp))

    # Per-bin metrics using score thresholds
    bin_metrics: Dict[str, Dict[str, Any]] = {}
    thresholds = [
        (0.0, 60.0, "Fail"),
        (60.0, 75.0, "Mid"),
        (75.0, 88.0, "Good"),
        (88.0, 100.0, "Excellent"),
    ]
    for low, high, code in thresholds:
        mask = (yt >= low) & (yt < high)
        if np.sum(mask) < 2:
            continue
        bin_metrics[code] = {
            "count": int(np.sum(mask)),
            "mae": float(mean_absolute_error(yt[mask], yp[mask])),
            "rmse": float(np.sqrt(mean_squared_error(yt[mask], yp[mask]))),
        }

    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "per_bin": bin_metrics,
    }


# ---------------------------------------------------------------------------
# Diagnostics helpers
# ---------------------------------------------------------------------------

def _analyze_label_distribution(scores: List[float]) -> Dict[str, Any]:
    """Analyze quality label distribution and detect collapse risk."""
    arr = np.asarray(scores, dtype=float)
    bins_def = [
        (0.0, 60.0, "Fail"),
        (60.0, 75.0, "Mid"),
        (75.0, 88.0, "Good"),
        (88.0, 100.0, "Excellent"),
    ]
    bin_counts = []
    max_pct = 0.0
    for low, high, code in bins_def:
        cnt = int(np.sum((arr >= low) & (arr < high)))
        pct = 100.0 * cnt / len(arr) if len(arr) > 0 else 0.0
        bin_counts.append({"low": low, "high": high, "code": code, "count": cnt, "pct": round(pct, 1)})
        max_pct = max(max_pct, pct)

    collapse_risk = max_pct > 60.0

    return {
        "n": int(len(arr)),
        "mean": round(float(np.mean(arr)), 2),
        "std": round(float(np.std(arr)), 2),
        "min": round(float(np.min(arr)), 2),
        "max": round(float(np.max(arr)), 2),
        "p25": round(float(np.percentile(arr, 25)), 2),
        "p50": round(float(np.percentile(arr, 50)), 2),
        "p75": round(float(np.percentile(arr, 75)), 2),
        "n_unique": int(len(np.unique(arr))),
        "bins": bin_counts,
        "collapse_risk": collapse_risk,
    }


def _detect_collapse(
    raw_preds: np.ndarray,
    calibrated_preds: np.ndarray,
    threshold: float = 5.0,
) -> Dict[str, Any]:
    """Detect score collapse: predicted std too narrow."""
    raw_std = float(np.std(raw_preds))
    cal_std = float(np.std(calibrated_preds))

    collapsed = raw_std < threshold
    warning = None
    if collapsed:
        warning = (
            f"Score collapse detected: raw pred std={raw_std:.2f} < {threshold}. "
            f"Calibrated std={cal_std:.2f}. "
            f"Consider: (1) adding more low-score training samples, "
            f"(2) reducing LGB regularization, (3) reviewing feature quality."
        )
    return {
        "collapse_detected": collapsed,
        "raw_std": round(raw_std, 2),
        "calibrated_std": round(cal_std, 2),
        "threshold": threshold,
        "warning": warning,
    }


def _analyze_feature_importance_by_category(
    importance_list: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """Group feature importance by category."""
    categories = {
        "embedding": {"prefixes": ["emb_"], "total": 0.0, "features": []},
        "action_prob": {"prefixes": ["action_prob_"], "total": 0.0, "features": []},
        "temporal": {"prefixes": ["temporal_"], "total": 0.0, "features": []},
        "motion_stability": {"prefixes": ["acc_var_", "gyro_var_", "jerk_", "node_"], "total": 0.0, "features": []},
        "similarity": {"prefixes": ["sim_"], "total": 0.0, "features": []},
        "metadata": {"prefixes": ["duration_", "missing_"], "total": 0.0, "features": []},
    }

    all_total = sum(item["importance"] for item in importance_list)
    if all_total <= 0:
        all_total = 1.0

    for item in importance_list:
        name = item["feature"]
        imp = item["importance"]
        matched = False
        for cat_name, cat_data in categories.items():
            for prefix in cat_data["prefixes"]:
                if name.startswith(prefix):
                    cat_data["total"] += imp
                    cat_data["features"].append(name)
                    matched = True
                    break
            if matched:
                break

    result = {}
    for cat_name, cat_data in categories.items():
        result[cat_name] = {
            "total_importance": round(cat_data["total"], 2),
            "pct": round(100.0 * cat_data["total"] / all_total, 1),
            "n_features": len(cat_data["features"]),
            "top_features": cat_data["features"][:5],
        }
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train LightGBM Regressor for continuous quality scoring."
    )
    parser.add_argument("--raw", required=True, help="Path to JSONL samples.")
    parser.add_argument("--quality-dataset", required=True, help="CSV/JSON/JSONL with sample_index and quality scores.")
    parser.add_argument("--action-model", required=True, help="Path to action_model.pt.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--reference-library", default=None, help="Optional reference library for similarity features.")
    parser.add_argument("--include-incorrect-actions", action="store_true")
    parser.add_argument("--min-action-confidence", type=float, default=0.0)
    parser.add_argument("--val-ratio", type=float, default=0.2)
    parser.add_argument("--calibration-target-mean", type=float, default=72.0,
                        help="Target mean for z-score calibration. 72 → ~15-20%% Excellent.")
    parser.add_argument("--calibration-target-std", type=float, default=20.0)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        result = run_lgb_training(
            raw_data_path=args.raw,
            quality_dataset_path=args.quality_dataset,
            action_model_path=args.action_model,
            output_dir=args.output_dir,
            reference_library_path=args.reference_library,
            only_correct_actions=not bool(args.include_incorrect_actions),
            min_action_confidence=float(args.min_action_confidence),
            val_ratio=float(args.val_ratio),
            device_name=args.device,
            calibration_target_mean=float(args.calibration_target_mean),
            calibration_target_std=float(args.calibration_target_std),
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
