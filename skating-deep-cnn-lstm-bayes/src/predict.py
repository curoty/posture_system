"""Inference helpers for CNN-LSTM action model and LightGBM quality regressor.

Primary path (v2): LightGBM Regressor → continuous score 0–100.
Legacy path: GaussianNB classifier → discrete quality labels (kept for compat).
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import joblib
import numpy as np
import torch

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    apply_normalization,
    convert_record_to_sequence,
    iter_jsonl_records,
)
from src.coach_feedback import generate_coach_feedback
from src.model import (
    ActionModelConfig,
    CNNLSTMAttentionClassifier,
    StructuredActionClassifier,
    StructuredModelConfig,
)
from src.quality_labels import (
    score_to_quality_code,
    score_to_quality_label,
)
from src.similarity_scoring import ReferenceLibrary, load_reference_library, score_sequence_against_references

_LOGGER = logging.getLogger(__name__)

# LightGBM is optional at import time — loaded on demand
try:
    import lightgbm  # noqa: F401
    _LGB_AVAILABLE = True
except ImportError:
    _LGB_AVAILABLE = False


class _QualitySchemaMismatch(ValueError):
    """The action model and the LightGBM quality bundle come from different runs.

    Subclasses ``ValueError`` so ``api.py`` surfaces it as a 422 rather than a
    500 — the request is fine, the deployed artifacts are not.
    """


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

# Union type of every backbone the inference path can serve.  Both classes expose
# the same ``forward(x, return_embedding=..., return_attention=...)`` and
# ``extract_embedding(x)`` interface, so everything downstream is arch-agnostic.
ActionModel = Union[CNNLSTMAttentionClassifier, StructuredActionClassifier]

# checkpoint["arch"] -> (model class, config class).  Checkpoints written before
# the structured backbone existed have no "arch" key; they are always baseline.
_ARCH_REGISTRY: Dict[str, tuple[type, type]] = {
    "baseline": (CNNLSTMAttentionClassifier, ActionModelConfig),
    "structured": (StructuredActionClassifier, StructuredModelConfig),
}
_DEFAULT_ARCH = "baseline"


def load_action_model(
    model_path: str | Path, device: torch.device,
) -> tuple[ActionModel, Dict[str, Any]]:
    """Load an action model, dispatching on the architecture it was saved with.

    The two backbones are independent ``nn.Module`` classes with incompatible
    ``state_dict`` layouts, so the class must be chosen before loading weights.
    ``train_multiclass.py`` stamps ``checkpoint["arch"]``; older single-class
    checkpoints predate the structured backbone and default to ``"baseline"``.

    Raises:
        ValueError: on an unknown ``arch``, rather than silently falling back to
            the baseline — a wrong class would fail with a confusing
            ``state_dict`` key mismatch far from the real cause.
    """
    checkpoint = torch.load(model_path, map_location=device, weights_only=False)
    arch = str(checkpoint.get("arch", _DEFAULT_ARCH))

    if arch not in _ARCH_REGISTRY:
        raise ValueError(
            f"Unknown action-model arch {arch!r} in {model_path}. "
            f"Supported: {sorted(_ARCH_REGISTRY)}"
        )

    model_cls, config_cls = _ARCH_REGISTRY[arch]
    model = model_cls(config_cls.from_dict(checkpoint["model_config"]))
    model.load_state_dict(checkpoint["model_state_dict"])
    model.to(device)
    model.eval()
    return model, checkpoint


def _resolve_action_labels(checkpoint: Dict[str, Any]) -> Dict[int, str]:
    """Normalize the two label schemas into ``{class_id: action_name}``.

    The trainers disagree on both the key and the direction of the mapping:

    - ``train_action.py`` / SSL     -> ``action_labels``: {id: name}
    - ``train_multiclass.py``       -> ``label_map``:     {name: id}   (inverted)

    Reading the wrong one silently mislabels every prediction (e.g. calling a
    ``side_push_recover`` a ``weight_shift``), so handle both explicitly and
    fail loudly when neither is present.
    """
    metadata = checkpoint.get("label_metadata") or {}

    if "action_labels" in metadata:
        return {int(k): str(v) for k, v in metadata["action_labels"].items()}

    if "label_map" in metadata:  # inverted: name -> id
        return {int(v): str(k) for k, v in metadata["label_map"].items()}

    raise ValueError(
        "Checkpoint label_metadata has neither 'action_labels' nor 'label_map'; "
        "cannot map predicted class ids back to action names."
    )


def load_lgb_quality_model(
    model_path: str | Path,
) -> Optional[Dict[str, Any]]:
    """Load a LightGBM quality regression bundle.

    Returns None if the file doesn't exist or LightGBM is not installed.
    The bundle dict contains:
      - booster: trained LightGBM Booster
      - scaler: StandardScaler
      - calibration_params: dict for score calibration
      - feature_names: ordered list of feature column names
      - feature_config: metadata dict
    """
    if not _LGB_AVAILABLE:
        return None
    path = Path(model_path)
    if not path.exists():
        return None
    bundle = joblib.load(path)
    if not isinstance(bundle, dict):
        return None
    if bundle.get("model_type") != "lightgbm_regressor":
        return None
    return bundle


def _load_quality_bundle_legacy(
    global_quality_model_path: Optional[str | Path],
    by_action_quality_dir: Optional[str | Path],
    action_name: str,
) -> Optional[Dict[str, Any]]:
    """Legacy GaussianNB quality model loader (backward compat)."""
    if by_action_quality_dir is not None:
        action_path = Path(by_action_quality_dir) / f"{action_name}.pkl"
        if action_path.exists():
            return joblib.load(action_path)
    if global_quality_model_path is not None and Path(global_quality_model_path).exists():
        return joblib.load(global_quality_model_path)
    return None


# ---------------------------------------------------------------------------
# LightGBM feature extraction (inference)
# ---------------------------------------------------------------------------

def _action_prob_feature_name(class_id: int, action_labels: Dict[int, str]) -> str:
    """Column name for one action-probability feature.

    Must mirror ``train_lgb_quality.build_lgb_feature_matrix`` exactly::

        f"action_prob_{id_to_name.get(i, f'class_{i}')}"

    Naming these ``action_prob_{class_id}`` instead would look up a key that is
    absent from the trained ``feature_names``, and the probabilities would
    silently be filled with 0.0 for every sample.
    """
    return f"action_prob_{action_labels.get(int(class_id), f'class_{class_id}')}"


def _extract_lgb_features_inference(
    normalized_sequence: np.ndarray,
    embedding: np.ndarray,
    probabilities: np.ndarray,
    action_name: str,
    action_labels: Dict[int, str],
    duration_seconds: float,
    missing_node_ratio: float,
    raw_sequence: np.ndarray,
    node_order: tuple,
    reference_library: Optional[ReferenceLibrary],
    feature_names: List[str],
) -> np.ndarray:
    """Build the feature vector for a single sample matching the training schema.

    Args:
        normalized_sequence: [T, C] normalized IMU tensor.
        embedding: [D] deep embedding from the action model.
        probabilities: [num_actions] softmax output.
        action_name: Predicted action label name.
        action_labels: ``{class_id: action_name}`` from the checkpoint; names the
            probability columns the same way training did.
        duration_seconds: Segment duration.
        missing_node_ratio: Fraction of missing sensor readings.
        raw_sequence: [T, nodes, 6] raw per-node IMU for motion stats.
        node_order: Tuple of node names.
        reference_library: Optional reference library for similarity features.
        feature_names: Ordered list of feature names from training.

    Returns:
        [1, D] feature row matching the training feature order.
    """
    feature_dict: Dict[str, float] = {}

    # --- Embedding ---
    for i in range(len(embedding)):
        feature_dict[f"emb_{i}"] = float(embedding[i])

    # --- Action probabilities ---
    for i in range(len(probabilities)):
        feature_dict[_action_prob_feature_name(i, action_labels)] = float(probabilities[i])

    # --- Temporal stats ---
    flat = normalized_sequence.reshape(normalized_sequence.shape[0], -1)
    frame_means = np.mean(np.abs(flat), axis=1)
    feature_dict["temporal_mean"] = float(np.mean(frame_means))
    feature_dict["temporal_std"] = float(np.std(frame_means))
    feature_dict["temporal_max"] = float(np.max(frame_means))
    feature_dict["temporal_min"] = float(np.min(frame_means))

    # --- Motion stability ---
    if raw_sequence is not None and raw_sequence.ndim == 3:
        acc = raw_sequence[:, :, 0:3]
        gyro = raw_sequence[:, :, 3:6]
        feature_dict["acc_var_global"] = float(np.var(acc))
        feature_dict["gyro_var_global"] = float(np.var(gyro))
        jerk = np.diff(acc, axis=0)
        feature_dict["jerk_roughness"] = float(np.mean(np.abs(jerk))) if jerk.size else 0.0

        num_nodes = raw_sequence.shape[1]
        for ni in range(num_nodes):
            node_name = node_order[ni] if ni < len(node_order) else f"node_{ni}"
            feature_dict[f"node_{node_name}_acc_var"] = float(np.var(acc[:, ni, :]))
            feature_dict[f"node_{node_name}_gyro_var"] = float(np.var(gyro[:, ni, :]))
    else:
        # Fallback zeros if raw sequence unavailable
        feature_dict["acc_var_global"] = 0.0
        feature_dict["gyro_var_global"] = 0.0
        feature_dict["jerk_roughness"] = 0.0
        for ni in range(9):
            node_name = node_order[ni] if ni < len(node_order) else f"node_{ni}"
            feature_dict[f"node_{node_name}_acc_var"] = 0.0
            feature_dict[f"node_{node_name}_gyro_var"] = 0.0

    # --- Similarity features ---
    if reference_library is not None:
        sim_result = score_sequence_against_references(
            sequence=normalized_sequence,
            embedding=embedding,
            action_name=action_name,
            duration_seconds=duration_seconds,
            missing_node_ratio=missing_node_ratio,
            reference_library=reference_library,
            top_k=5,
        )
        if sim_result.get("success", False):
            matches = sim_result.get("top_matches", [])
            if matches:
                feature_dict["sim_top1"] = float(matches[0]["overall_similarity"])
                feature_dict["sim_topk_mean"] = float(np.mean([m["overall_similarity"] for m in matches]))
                feature_dict["sim_temporal_align"] = float(matches[0].get("temporal_similarity", 0.0))
            else:
                feature_dict["sim_top1"] = 0.0
                feature_dict["sim_topk_mean"] = 0.0
                feature_dict["sim_temporal_align"] = 0.0
        else:
            feature_dict["sim_top1"] = 0.0
            feature_dict["sim_topk_mean"] = 0.0
            feature_dict["sim_temporal_align"] = 0.0
    else:
        feature_dict["sim_top1"] = 0.0
        feature_dict["sim_topk_mean"] = 0.0
        feature_dict["sim_temporal_align"] = 0.0

    # --- Metadata ---
    feature_dict["duration_seconds"] = float(duration_seconds)
    feature_dict["missing_node_ratio"] = float(missing_node_ratio)

    # --- Assemble in training order ---
    feature_vector = np.array(
        [feature_dict.get(name, 0.0) for name in feature_names],
        dtype=np.float32,
    )
    return feature_vector.reshape(1, -1)


# ---------------------------------------------------------------------------
# Robustness checks
# ---------------------------------------------------------------------------

def _detect_embedding_collapse(embedding: np.ndarray, threshold: float = 0.05) -> bool:
    """Detect if the embedding has collapsed (near-constant values)."""
    std = float(np.std(embedding))
    return std < threshold


def _check_input_validity(sequence: np.ndarray) -> Optional[str]:
    """Check for obvious input anomalies. Returns None if OK, else reason string."""
    if np.any(np.isnan(sequence)):
        return "nan_values"
    if np.any(np.isinf(sequence)):
        return "inf_values"
    # Check for all-zero or near-zero input
    if float(np.max(np.abs(sequence))) < 1e-8:
        return "near_zero_input"
    return None


def _check_node_completeness(
    record: Dict[str, Any],
    min_complete_ratio: float = 0.7,
) -> Optional[str]:
    """Check that enough nodes have non-zero data in the raw record.

    This is a defense-in-depth guard that runs before tensor conversion.
    It inspects the raw frame payload to see whether the expected nodes
    are present and carry meaningful (non-zero) IMU readings.

    Args:
        record: Raw inference record dict with a ``frames`` key.
        min_complete_ratio: Minimum fraction of frames that must contain
            at least ``min_complete_ratio`` of the expected nodes with
            non-zero data.

    Returns:
        ``None`` if the record passes the check, otherwise a reason string.
    """
    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return "empty_frames"

    from src.jsonl_sequence_dataset import JSONL_TO_MODEL_NODE_MAPPING
    expected_nodes = set(JSONL_TO_MODEL_NODE_MAPPING.keys())
    min_nodes_per_frame = max(1, int(len(expected_nodes) * min_complete_ratio))

    complete_frame_count = 0
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        payload = frame.get("p")
        if not isinstance(payload, dict):
            continue
        # Count nodes that are present AND have at least one non-zero channel
        frame_nodes_present: set = set()
        for node_name, values in payload.items():
            if node_name in expected_nodes and isinstance(values, list) and len(values) == 6:
                if any(abs(float(v)) > 1e-8 for v in values):
                    frame_nodes_present.add(node_name)
        if len(frame_nodes_present) >= min_nodes_per_frame:
            complete_frame_count += 1

    ratio = complete_frame_count / len(frames) if frames else 0.0
    if ratio < min_complete_ratio:
        return (
            f"node_incomplete: only {ratio:.1%} of frames have sufficient nodes "
            f"(need {min_complete_ratio:.0%} with at least {min_nodes_per_frame} nodes)"
        )
    return None


def _build_top_predictions(
    probabilities: np.ndarray, action_labels: Dict[int, str], top_k: int,
) -> List[Dict[str, Any]]:
    ranked_indices = np.argsort(probabilities)[::-1][:top_k]
    return [
        {
            "rank": int(rank + 1),
            "label_id": int(label_id),
            "label_name": action_labels[int(label_id)],
            "probability": float(probabilities[int(label_id)]),
        }
        for rank, label_id in enumerate(ranked_indices.tolist())
    ]


# ---------------------------------------------------------------------------
# Main inference entry point
# ---------------------------------------------------------------------------

def predict_record(
    record: Dict[str, Any],
    action_model: ActionModel,
    checkpoint: Dict[str, Any],
    device: torch.device,
    global_quality_model_path: Optional[str | Path] = None,
    by_action_quality_dir: Optional[str | Path] = None,
    lgb_quality_model_path: Optional[str | Path] = None,
    reference_library: Optional[ReferenceLibrary] = None,
    top_k: int = 3,
    similarity_top_k: Optional[int] = None,
    confidence_threshold: float = 0.65,
    top_margin_threshold: float = 0.15,
    embedding_collapse_threshold: float = 0.05,
) -> Dict[str, Any]:
    """Run full inference: action classification → quality regression → feedback.

    Uses LightGBM regressor when available; falls back to legacy GaussianNB.
    """
    sequence_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    node_order = sequence_config.node_order
    sequence, _label_id, metadata = convert_record_to_sequence(
        record, config=sequence_config, label_name_to_id=None, require_action_type=False,
    )
    if sequence is None:
        return {"success": False, "reason": metadata.get("reason", "invalid_sample")}

    # Input validity check
    input_issue = _check_input_validity(sequence)
    if input_issue is not None:
        return {"success": False, "reason": input_issue}

    # Node completeness check (defense-in-depth)
    node_issue = _check_node_completeness(record)
    if node_issue is not None:
        return {"success": False, "reason": node_issue}

    X = apply_normalization(np.expand_dims(sequence, axis=0), checkpoint["normalization"])
    tensor = torch.as_tensor(X, dtype=torch.float32, device=device)

    with torch.no_grad():
        logits, embedding, attention = action_model(tensor, return_embedding=True, return_attention=True)
        probabilities = torch.softmax(logits, dim=1).cpu().numpy()[0]
        embedding_array = embedding.cpu().numpy()[0]
        attention_weights = None if attention is None else attention.cpu().numpy()[0].astype(float).tolist()

    predicted_action_id = int(np.argmax(probabilities))
    confidence = float(probabilities[predicted_action_id])
    sorted_probs = np.sort(probabilities)[::-1]
    top_margin = float(sorted_probs[0] - sorted_probs[1]) if len(sorted_probs) > 1 else float(sorted_probs[0])

    action_labels = _resolve_action_labels(checkpoint)
    action_name = action_labels[predicted_action_id]

    # --- Robustness gates ---
    embedding_collapsed = _detect_embedding_collapse(embedding_array, embedding_collapse_threshold)
    action_success = (
        confidence >= confidence_threshold
        and top_margin >= top_margin_threshold
        and not embedding_collapsed
    )

    duration_seconds = float(metadata.get("duration_seconds", 0.0))
    missing_node_ratio = float(metadata.get("missing_node_ratio", 0.0))

    # --- Extract raw sequence for motion-stability features ---
    raw_seq = _extract_raw_sequence_inference(record, sequence_config)

    # --- Reference similarity ---
    reference_similarity_prediction = None
    reference_similarity_skip_reason = None
    if action_success and reference_library is not None:
        reference_similarity_prediction = score_sequence_against_references(
            sequence=X[0],
            embedding=embedding_array,
            action_name=action_name,
            duration_seconds=duration_seconds,
            missing_node_ratio=missing_node_ratio,
            reference_library=reference_library,
            top_k=similarity_top_k,
        )
        if not reference_similarity_prediction.get("success", False):
            reference_similarity_skip_reason = str(
                reference_similarity_prediction.get("skip_reason", "reference_similarity_failed")
            )

    # --- Quality scoring ---
    quality_prediction = None
    quality_skip_reason = None
    lgb_used = False

    if not action_success:
        quality_skip_reason = (
            "embedding_collapse" if embedding_collapsed else "low_action_confidence"
        )

    if action_success:
        # Try LightGBM first
        lgb_bundle = None
        if lgb_quality_model_path is not None:
            lgb_bundle = load_lgb_quality_model(lgb_quality_model_path)

        if lgb_bundle is not None:
            try:
                quality_prediction = _predict_quality_lgb(
                    normalized_sequence=X[0],
                    embedding=embedding_array,
                    probabilities=probabilities,
                    action_name=action_name,
                    action_labels=action_labels,
                    duration_seconds=duration_seconds,
                    missing_node_ratio=missing_node_ratio,
                    raw_sequence=raw_seq,
                    node_order=node_order,
                    reference_library=reference_library,
                    lgb_bundle=lgb_bundle,
                )
                lgb_used = True
            except _QualitySchemaMismatch:
                # A mispaired action model + quality bundle is a deployment
                # error, not a runtime hiccup.  Falling back to GaussianNB here
                # would keep serving plausible-looking scores off a model that
                # was never trained for these labels.
                raise
            except Exception:
                _LOGGER.warning(
                    "LightGBM quality prediction failed; falling back to GaussianNB",
                    exc_info=True,
                )
                lgb_bundle = None

        if lgb_bundle is None and not lgb_used:
            # Legacy GaussianNB fallback
            quality_bundle = _load_quality_bundle_legacy(
                global_quality_model_path, by_action_quality_dir, action_name,
            )
            if quality_bundle is None:
                quality_skip_reason = "quality_model_not_loaded"
            else:
                quality_prediction = _predict_quality_legacy(
                    embedding=embedding_array,
                    probabilities=probabilities,
                    predicted_action_id=predicted_action_id,
                    duration_seconds=duration_seconds,
                    missing_node_ratio=missing_node_ratio,
                    quality_bundle=quality_bundle,
                )

    # --- Determine primary quality score ---
    primary_quality_score = None
    primary_quality_level = None
    if quality_prediction is not None:
        primary_quality_score = quality_prediction["quality_score"]
        primary_quality_level = quality_prediction.get("quality_label") or quality_prediction.get("label")
    elif reference_similarity_prediction is not None and reference_similarity_prediction.get("success", False):
        primary_quality_score = reference_similarity_prediction["quality_score"]
        primary_quality_level = reference_similarity_prediction["quality_level"]

    return {
        "success": True,
        "prediction": {
            "label_id": int(predicted_action_id),
            "label_name": action_name,
            "confidence": confidence,
        },
        "top_predictions": _build_top_predictions(probabilities, action_labels, top_k=top_k),
        "action_success": bool(action_success),
        "action_success_policy": {
            "confidence_threshold": float(confidence_threshold),
            "top_margin_threshold": float(top_margin_threshold),
            "top_margin": float(top_margin),
            "embedding_collapsed": bool(embedding_collapsed),
        },
        "quality_score": primary_quality_score,
        "quality_level": primary_quality_level,
        "quality_score_source": (
            "LightGBM" if lgb_used else ("GaussianNB" if not lgb_used and quality_prediction else None)
        ),
        "reference_similarity_score": (
            None if reference_similarity_prediction is None or not reference_similarity_prediction.get("success")
            else reference_similarity_prediction["quality_score"]
        ),
        "reference_similarity_level": (
            None if reference_similarity_prediction is None or not reference_similarity_prediction.get("success")
            else reference_similarity_prediction["quality_level"]
        ),
        "reference_similarity_prediction": reference_similarity_prediction,
        "reference_similarity_skip_reason": reference_similarity_skip_reason,
        "quality_prediction": quality_prediction,
        "quality_skip_reason": quality_skip_reason,
        "coach_feedback": generate_coach_feedback({
            "quality_score": primary_quality_score,
            "quality_label": primary_quality_level,
            "quality_prediction": quality_prediction,
            "action_label": action_name,
            "duration": duration_seconds,
            "missing_ratio": missing_node_ratio,
            "reference_similarity_score": (
                reference_similarity_prediction["quality_score"]
                if reference_similarity_prediction is not None and reference_similarity_prediction.get("success")
                else None
            ),
        }),
        "metadata": {
            "duration_seconds": duration_seconds,
            "missing_node_ratio": missing_node_ratio,
            "valid_nodes": int(metadata.get("valid_nodes", 0)),
            "attention_weights": attention_weights,
            "embedding_std": float(np.std(embedding_array)),
        },
    }


# ---------------------------------------------------------------------------
# LightGBM quality prediction
# ---------------------------------------------------------------------------

def _predict_quality_lgb(
    normalized_sequence: np.ndarray,
    embedding: np.ndarray,
    probabilities: np.ndarray,
    action_name: str,
    action_labels: Dict[int, str],
    duration_seconds: float,
    missing_node_ratio: float,
    raw_sequence: Optional[np.ndarray],
    node_order: tuple,
    reference_library: Optional[ReferenceLibrary],
    lgb_bundle: Dict[str, Any],
) -> Dict[str, Any]:
    """Predict quality score using LightGBM regressor."""
    booster = lgb_bundle["booster"]
    scaler = lgb_bundle["scaler"]
    cal_params = lgb_bundle.get("calibration_params", {})
    feature_names = lgb_bundle["feature_names"]

    _assert_action_prob_schema(feature_names, probabilities, action_labels)

    features = _extract_lgb_features_inference(
        normalized_sequence=normalized_sequence,
        embedding=embedding,
        probabilities=probabilities,
        action_name=action_name,
        action_labels=action_labels,
        duration_seconds=duration_seconds,
        missing_node_ratio=missing_node_ratio,
        raw_sequence=raw_sequence if raw_sequence is not None else np.zeros((1, 9, 6), dtype=np.float32),
        node_order=node_order,
        reference_library=reference_library,
        feature_names=feature_names,
    )

    X_scaled = scaler.transform(features)
    raw_score = float(booster.predict(X_scaled, num_iteration=booster.best_iteration)[0])

    # Apply calibration
    if cal_params:
        from src.quality_labels import apply_calibration
        score = apply_calibration(raw_score, cal_params)
    else:
        from src.quality_labels import calibrate_scores
        score = float(calibrate_scores(np.array([raw_score]), target_mean=65.0, target_std=20.0)[0])

    score = float(np.clip(score, 0.0, 100.0))
    label = score_to_quality_label(score)
    code = score_to_quality_code(score)

    return {
        "quality_score": round(score, 2),
        "quality_label": label,
        "quality_code": code,
        "raw_score": round(raw_score, 2),
        "scoring_model": "LightGBM",
        "score_range": [0, 100],
    }


def _assert_action_prob_schema(
    feature_names: List[str],
    probabilities: np.ndarray,
    action_labels: Dict[int, str],
) -> None:
    """Fail loudly when the checkpoint's labels don't match the quality bundle.

    ``_extract_lgb_features_inference`` assembles its row with
    ``feature_dict.get(name, 0.0)``, so a probability column the action model
    doesn't produce is not an error there — it is silently zero-filled, and the
    regressor scores every sample as if the classifier had been maximally
    unsure.  That failure is invisible in the output: scores stay in range, no
    exception is raised.  Catch the mismatch here instead, where the action
    model and the quality bundle are both in hand.
    """
    expected = {_action_prob_feature_name(i, action_labels) for i in range(len(probabilities))}
    trained = {name for name in feature_names if name.startswith("action_prob_")}
    if expected != trained:
        raise _QualitySchemaMismatch(
            "Action-model labels do not match the LightGBM quality bundle. "
            f"Model produces {sorted(expected)}; bundle was trained on "
            f"{sorted(trained)}. The two artifacts are from different runs — "
            "retrain the quality model against this action model."
        )


# ---------------------------------------------------------------------------
# Legacy GaussianNB quality prediction (backward compat)
# ---------------------------------------------------------------------------

def _predict_quality_legacy(
    embedding: np.ndarray,
    probabilities: np.ndarray,
    predicted_action_id: int,
    duration_seconds: float,
    missing_node_ratio: float,
    quality_bundle: Dict[str, Any],
) -> Dict[str, Any]:
    """GaussianNB quality prediction (legacy path)."""
    from src.quality_labels import estimate_quality_score_from_probabilities, get_quality_code

    predicted_one_hot = np.zeros(len(probabilities), dtype=np.float32)
    predicted_one_hot[int(predicted_action_id)] = 1.0
    scalars = np.asarray([duration_seconds, missing_node_ratio], dtype=np.float32)
    feature = np.concatenate([
        embedding.astype(np.float32),
        probabilities.astype(np.float32),
        predicted_one_hot,
        scalars,
    ]).astype(np.float32)

    model = quality_bundle["model"]
    nb_probs = model.predict_proba(feature.reshape(1, -1))[0]
    class_ids = [int(c) for c in model.classes_.tolist()]
    best_index = int(np.argmax(nb_probs))
    predicted_class = class_ids[best_index]

    return {
        "class_id": int(predicted_class),
        "code": get_quality_code(predicted_class),
        "label": score_to_quality_label(
            estimate_quality_score_from_probabilities(class_ids, nb_probs.tolist())
        ),
        "quality_score": estimate_quality_score_from_probabilities(class_ids, nb_probs.tolist()),
        "confidence": float(nb_probs[best_index]),
        "probabilities": {
            get_quality_code(cid): float(p)
            for cid, p in zip(class_ids, nb_probs.tolist())
        },
        "scoring_model": "GaussianNB",
    }


def _extract_raw_sequence_inference(
    record: Dict[str, Any],
    config: SequenceConfig,
) -> Optional[np.ndarray]:
    """Extract raw per-node IMU sequence for motion-stability feature calculation."""
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
        np.nan, dtype=np.float32,
    )

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

    for ni in range(raw.shape[1]):
        for ci in range(raw.shape[2]):
            raw[:, ni, ci] = _fill_nan_vector(raw[:, ni, ci], 0.0)

    # 必须与模型输入走同一套去噪配置。这条原始序列专供质量模型的手工特征
    # (acc_var_global / gyro_var_global / jerk_roughness / 逐节点方差)，
    # 而**方差和 jerk 对野值极其敏感** —— 单个 228g 的尖刺就能主导整个
    # acc_var_global。若此处不去噪而模型输入去了噪，训练与推理的特征分布
    # 将不一致。
    if config.denoise_spikes or config.denoise_lowpass_hz is not None:
        from src.denoise import denoise_sequence
        raw, _stats = denoise_sequence(
            raw,
            sample_rate_hz=config.sample_rate_hz,
            remove_spikes=config.denoise_spikes,
            lowpass_cutoff_hz=config.denoise_lowpass_hz,
        )

    return raw


# ---------------------------------------------------------------------------
# Batch inference
# ---------------------------------------------------------------------------

def predict_jsonl_file(
    jsonl_path: str | Path,
    action_model_path: str | Path,
    global_quality_model_path: Optional[str | Path] = None,
    by_action_quality_dir: Optional[str | Path] = None,
    lgb_quality_model_path: Optional[str | Path] = None,
    reference_library_path: Optional[str | Path] = None,
    output_path: Optional[str | Path] = None,
    top_k: int = 3,
    similarity_top_k: Optional[int] = None,
    confidence_threshold: float = 0.65,
    top_margin_threshold: float = 0.15,
    device_name: Optional[str] = None,
) -> Dict[str, Any]:
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))
    model, checkpoint = load_action_model(action_model_path, device=device)
    reference_library = None if reference_library_path is None else load_reference_library(reference_library_path)
    results = []

    for sample_index, record in enumerate(iter_jsonl_records(jsonl_path)):
        result = predict_record(
            record=record,
            action_model=model,
            checkpoint=checkpoint,
            device=device,
            global_quality_model_path=global_quality_model_path,
            by_action_quality_dir=by_action_quality_dir,
            lgb_quality_model_path=lgb_quality_model_path,
            reference_library=reference_library,
            top_k=top_k,
            similarity_top_k=similarity_top_k,
            confidence_threshold=confidence_threshold,
            top_margin_threshold=top_margin_threshold,
        )
        result["sample_index"] = int(sample_index)
        results.append(result)

    quality_scores = [
        float(r["quality_score"]) for r in results if r.get("quality_score") is not None
    ]
    reference_scores = [
        float(r["reference_similarity_score"])
        for r in results
        if r.get("reference_similarity_score") is not None
    ]
    lgb_scores = [
        float(r["quality_prediction"]["quality_score"])
        for r in results
        if r.get("quality_prediction") is not None
        and r["quality_prediction"].get("scoring_model") == "LightGBM"
    ]

    payload = {
        "success": True,
        "raw_file": str(Path(jsonl_path)),
        "action_model_file": str(Path(action_model_path)),
        "lgb_quality_model_file": str(lgb_quality_model_path) if lgb_quality_model_path else None,
        "reference_library_file": None if reference_library_path is None else str(Path(reference_library_path)),
        "samples": int(len(results)),
        "quality_scored_samples": int(len(quality_scores)),
        "average_quality_score": None if not quality_scores else round(float(np.mean(quality_scores)), 2),
        "reference_similarity_scored_samples": int(len(reference_scores)),
        "average_reference_similarity_score": (
            None if not reference_scores else round(float(np.mean(reference_scores)), 2)
        ),
        "lgb_scored_samples": int(len(lgb_scores)),
        "average_lgb_score": None if not lgb_scores else round(float(np.mean(lgb_scores)), 2),
        "results": results,
    }
    if output_path is not None:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run CNN-LSTM action + LightGBM quality inference.")
    parser.add_argument("--jsonl", required=True)
    parser.add_argument("--action-model", required=True)
    parser.add_argument("--lgb-quality-model", default=None, help="Path to lgb_quality_model.pkl (v2).")
    parser.add_argument("--quality-model", default=None, help="Path to bayes_quality_global.pkl (legacy).")
    parser.add_argument("--quality-by-action-dir", default=None)
    parser.add_argument("--reference-library", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--similarity-top-k", type=int, default=None)
    parser.add_argument("--confidence-threshold", type=float, default=0.65)
    parser.add_argument("--top-margin-threshold", type=float, default=0.15)
    parser.add_argument("--device", default=None)
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        payload = predict_jsonl_file(
            jsonl_path=args.jsonl,
            action_model_path=args.action_model,
            global_quality_model_path=args.quality_model,
            by_action_quality_dir=args.quality_by_action_dir,
            lgb_quality_model_path=args.lgb_quality_model,
            reference_library_path=args.reference_library,
            output_path=args.output,
            top_k=args.top_k,
            similarity_top_k=args.similarity_top_k,
            confidence_threshold=args.confidence_threshold,
            top_margin_threshold=args.top_margin_threshold,
            device_name=args.device,
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2))
        return 1

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
