"""
重训练脚本：动作分类模型 + 质量回归模型。

使用预划分的 train/val/test JSONL（按 _id 分组，80/10/10），
输出到 experiments/weight_shift_v2/ 和 experiments/lgb_quality_v3/。

用法:
    python tools/retrain_models.py \
        --train-jsonl training_set_train.jsonl \
        --val-jsonl training_set_val.jsonl \
        --test-jsonl training_set_test.jsonl \
        --action-output experiments/weight_shift_v2 \
        --quality-output experiments/lgb_quality_v3 \
        --seed 42
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
)
from torch.utils.data import DataLoader
from tqdm import tqdm

# Ensure src is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    SequenceTensorDataset,
    apply_normalization,
    convert_record_to_sequence,
    fit_normalization,
    write_json,
)
from src.model import ActionModelConfig, CNNLSTMAttentionClassifier
from src.quality_labels import score_to_quality_label


# ── 工具函数 ──────────────────────────────────────────────────────

def set_random_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_records(jsonl_path: str) -> List[Dict[str, Any]]:
    records = []
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))
    return records


def build_sequence_dataset(
    records: List[Dict[str, Any]],
    config: SequenceConfig,
    label_name_to_id: Dict[str, int],
    require_action_type: bool = False,
) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]], int]:
    sequences, labels, metas = [], [], []
    skipped = 0
    for record in records:
        seq, label_id, meta = convert_record_to_sequence(
            record, config=config, label_name_to_id=label_name_to_id,
            require_action_type=require_action_type,
        )
        if seq is None or (require_action_type and label_id is None):
            skipped += 1
            continue
        sequences.append(seq)
        labels.append(label_id if label_id is not None else 0)
        metas.append(meta)
    return np.stack(sequences).astype(np.float32), np.asarray(labels, dtype=np.int64), metas, skipped


# ── 动作模型训练 ──────────────────────────────────────────────────

def train_action_model(
    train_jsonl: str,
    val_jsonl: str,
    test_jsonl: str,
    output_dir: str,
    device: torch.device,
    batch_size: int = 32,
    max_epochs: int = 100,
    learning_rate: float = 1e-3,
    patience: int = 10,
) -> Dict[str, Any]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    config = SequenceConfig()
    label_name_to_id = {"weight_shift": 0}
    label_id_to_name = {0: "weight_shift"}

    print("Loading action training data...")
    X_train, y_train, train_meta, skip_train = build_sequence_dataset(
        load_records(train_jsonl), config, label_name_to_id, require_action_type=False)
    X_val, y_val, val_meta, skip_val = build_sequence_dataset(
        load_records(val_jsonl), config, label_name_to_id, require_action_type=False)
    X_test, y_test, test_meta, skip_test = build_sequence_dataset(
        load_records(test_jsonl), config, label_name_to_id, require_action_type=False)

    print(f"  Train: {len(X_train)} (skipped {skip_train}), Val: {len(X_val)}, Test: {len(X_test)}")

    # Fit normalization on train set
    normalization = fit_normalization(X_train)
    X_train = apply_normalization(X_train, normalization)
    X_val = apply_normalization(X_val, normalization)
    X_test = apply_normalization(X_test, normalization)

    train_dataset = SequenceTensorDataset(X_train, y_train)
    val_dataset = SequenceTensorDataset(X_val, y_val)
    test_dataset = SequenceTensorDataset(X_test, y_test)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)
    test_loader = DataLoader(test_dataset, batch_size=batch_size, shuffle=False)

    # Build model
    num_classes = len(label_name_to_id)
    model_config = ActionModelConfig(
        input_dim=config.input_dim,
        num_classes=num_classes,
    )
    model = CNNLSTMAttentionClassifier(model_config).to(device)

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="max", factor=0.5, patience=5,
    )

    best_val_f1 = 0.0
    best_state = None
    patience_counter = 0
    history = []

    print(f"\nTraining action model ({model_config.input_dim}d → {num_classes} classes)...")
    print(f"  Device: {device}, Epochs: {max_epochs}, Patience: {patience}")

    for epoch in range(1, max_epochs + 1):
        model.train()
        total_loss = 0.0
        for batch_x, batch_y in train_loader:
            batch_x, batch_y = batch_x.to(device), batch_y.to(device)
            optimizer.zero_grad()
            logits = model(batch_x)
            loss = criterion(logits, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * batch_x.size(0)

        train_loss = total_loss / len(train_dataset)

        # Validation
        model.eval()
        val_loss = 0.0
        all_preds, all_labels = [], []
        with torch.no_grad():
            for batch_x, batch_y in val_loader:
                batch_x, batch_y = batch_x.to(device), batch_y.to(device)
                logits = model(batch_x)
                val_loss += criterion(logits, batch_y).item() * batch_x.size(0)
                preds = torch.argmax(logits, dim=1)
                all_preds.extend(preds.cpu().tolist())
                all_labels.extend(batch_y.cpu().tolist())

        val_loss = val_loss / len(val_dataset)
        val_acc = accuracy_score(all_labels, all_preds)
        val_f1 = f1_score(all_labels, all_preds, average="macro")

        lr = optimizer.param_groups[0]["lr"]
        history.append({
            "epoch": epoch, "train_loss": round(train_loss, 6),
            "val_loss": round(val_loss, 6), "val_accuracy": round(val_acc, 4),
            "val_macro_f1": round(val_f1, 4), "learning_rate": lr,
        })
        print(f"  Epoch {epoch:3d} | train_loss={train_loss:.4f} val_loss={val_loss:.4f} "
              f"val_acc={val_acc:.4f} val_f1={val_f1:.4f} lr={lr:.1e}")

        scheduler.step(val_f1)

        if val_f1 > best_val_f1:
            best_val_f1 = val_f1
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            patience_counter = 0
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"  Early stopping at epoch {epoch}")
                break

    # Restore best
    model.load_state_dict(best_state)

    # Test evaluation
    model.eval()
    test_preds, test_labels = [], []
    with torch.no_grad():
        for batch_x, batch_y in test_loader:
            batch_x = batch_x.to(device)
            logits = model(batch_x)
            preds = torch.argmax(logits, dim=1)
            test_preds.extend(preds.cpu().tolist())
            test_labels.extend(batch_y.tolist())

    test_acc = accuracy_score(test_labels, test_preds)
    test_f1 = f1_score(test_labels, test_preds, average="macro")

    # Save
    model_path = output_path / "action_model.pt"
    checkpoint = {
        "model_config": model_config.to_dict(),
        "model_state_dict": best_state,
        "sequence_config": config.to_dict(),
        "label_metadata": {"action_labels": label_id_to_name, "num_classes": num_classes},
        "normalization": normalization,
        "training_summary": {
            "best_val_macro_f1": best_val_f1,
            "test_accuracy": test_acc,
            "test_macro_f1": test_f1,
            "history": history,
        },
    }
    torch.save(checkpoint, model_path)

    # Write metadata
    write_json(output_path / "dataset_summary.json", {
        "task": "deep_action_classification",
        "data_source": "jsonl_action_samples",
        "num_samples": int(len(X_train) + len(X_val) + len(X_test)),
        "train_samples": int(len(X_train)),
        "val_samples": int(len(X_val)),
        "test_samples": int(len(X_test)),
        "class_counts": {"weight_shift": int(len(X_train) + len(X_val) + len(X_test))},
    })
    write_json(output_path / "training_summary.json", {
        "task": "deep_action_classification",
        "model_file": str(model_path),
        "model_config": model_config.to_dict(),
        "sequence_config": config.to_dict(),
        "device": str(device),
        "best_val_macro_f1": best_val_f1,
        "test_accuracy": test_acc,
        "test_macro_f1": test_f1,
        "history": history,
    })
    write_json(output_path / "evaluation_summary.json", {
        "test_accuracy": test_acc, "test_macro_f1": test_f1,
    })
    write_json(output_path / "prediction_policy.json", {
        "confidence_threshold": 0.65, "top_margin_threshold": 0.15,
    })
    write_json(output_path / "label_metadata.json", {
        "action_labels": label_id_to_name, "num_classes": num_classes,
    })
    write_json(output_path / "deep_feature_config.json", config.to_dict())
    write_json(output_path / "normalization.json", normalization)

    print(f"\nAction model saved to {model_path}")
    print(f"  Test accuracy: {test_acc:.4f}, Test macro F1: {test_f1:.4f}")

    return {
        "test_accuracy": test_acc,
        "test_macro_f1": test_f1,
        "best_val_macro_f1": best_val_f1,
        "model_path": str(model_path),
    }


# ── 质量模型训练 ──────────────────────────────────────────────────

def train_quality_model(
    train_jsonl: str,
    val_jsonl: str,
    test_jsonl: str,
    output_dir: str,
    action_checkpoint_path: str,
    seed: int = 42,
) -> Dict[str, Any]:
    import joblib
    import lightgbm as lgb
    from sklearn.preprocessing import StandardScaler

    from src.predict import _extract_lgb_features_inference

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Load action model for feature extraction
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    checkpoint = torch.load(action_checkpoint_path, map_location=device, weights_only=False)
    action_model = CNNLSTMAttentionClassifier(
        ActionModelConfig.from_dict(checkpoint["model_config"])).to(device)
    action_model.load_state_dict(checkpoint["model_state_dict"])
    action_model.eval()
    seq_config = SequenceConfig.from_dict(checkpoint["sequence_config"])
    normalization = checkpoint["normalization"]
    node_order = seq_config.node_order

    print(f"\nExtracting features for quality model...")

    # First pass: extract one sample to discover feature names
    probe_rec = load_records(train_jsonl)[0]
    probe_seq, _, probe_meta = convert_record_to_sequence(
        probe_rec, config=seq_config, label_name_to_id=None, require_action_type=False)
    probe_norm = apply_normalization(np.expand_dims(probe_seq, axis=0), normalization)
    probe_tensor = torch.as_tensor(probe_norm, dtype=torch.float32, device=device)
    with torch.no_grad():
        probe_logits, probe_emb, _ = action_model(probe_tensor, return_embedding=True, return_attention=True)
    probe_raw = _extract_raw_seq(probe_rec, seq_config)
    probe_feats = _extract_lgb_features_inference(
        normalized_sequence=probe_norm[0],
        embedding=probe_emb.cpu().numpy()[0],
        probabilities=torch.softmax(probe_logits, dim=1).cpu().numpy()[0],
        action_name="weight_shift",
        duration_seconds=float(probe_meta.get("duration_seconds", 0)),
        missing_node_ratio=float(probe_meta.get("missing_node_ratio", 0)),
        raw_sequence=probe_raw,
        node_order=node_order,
        reference_library=None,
        feature_names=[],
    )
    # _extract_lgb_features_inference with empty feature_names returns empty array,
    # but populates feature_dict internally. We need to run it with known names.
    # Workaround: run with auto-generated feature names.
    n_emb = probe_emb.shape[1]
    n_probs = probe_logits.shape[1]
    auto_names = (
        [f"emb_{i}" for i in range(n_emb)]
        + [f"action_prob_{i}" for i in range(n_probs)]
        + ["temporal_mean", "temporal_std", "temporal_max", "temporal_min",
           "acc_var_global", "gyro_var_global", "jerk_roughness"]
        + [f"node_{n}_acc_var" for n in node_order]
        + [f"node_{n}_gyro_var" for n in node_order]
        + ["sim_top1", "sim_topk_mean", "sim_temporal_align",
           "duration_seconds", "missing_node_ratio"]
    )
    probe_feats_full = _extract_lgb_features_inference(
        normalized_sequence=probe_norm[0],
        embedding=probe_emb.cpu().numpy()[0],
        probabilities=torch.softmax(probe_logits, dim=1).cpu().numpy()[0],
        action_name="weight_shift",
        duration_seconds=float(probe_meta.get("duration_seconds", 0)),
        missing_node_ratio=float(probe_meta.get("missing_node_ratio", 0)),
        raw_sequence=probe_raw,
        node_order=node_order,
        reference_library=None,
        feature_names=auto_names,
    )
    feature_dim = probe_feats_full.shape[1]
    print(f"  Feature dim: {feature_dim}")

    def _extract_set(records, label):
        features_list, scores_list = [], []
        skipped_conv = 0
        skipped_no_score = 0
        for r in tqdm(records, desc=f"  {label}"):
            seq, _, meta = convert_record_to_sequence(
                r, config=seq_config, label_name_to_id=None, require_action_type=False)
            if seq is None:
                skipped_conv += 1
                continue
            l = r.get("label", {})
            score = l.get("coachScore") if isinstance(l, dict) else None
            if score is None:
                skipped_no_score += 1
                continue

            X_norm = apply_normalization(np.expand_dims(seq, axis=0), normalization)
            tensor = torch.as_tensor(X_norm, dtype=torch.float32, device=device)
            with torch.no_grad():
                logits, embedding, _ = action_model(tensor, return_embedding=True, return_attention=True)
                probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
                emb = embedding.cpu().numpy()[0]

            duration = float(meta.get("duration_seconds", 0))
            missing_ratio = float(meta.get("missing_node_ratio", 0))
            raw_seq = _extract_raw_seq(r, seq_config)

            feats = _extract_lgb_features_inference(
                normalized_sequence=X_norm[0],
                embedding=emb, probabilities=probs,
                action_name="weight_shift",
                duration_seconds=duration,
                missing_node_ratio=missing_ratio,
                raw_sequence=raw_seq,
                node_order=node_order,
                reference_library=None,
                feature_names=auto_names,
            )
            features_list.append(feats[0])
            scores_list.append(float(score))

        if skipped_conv or skipped_no_score:
            print(f"    skipped: {skipped_conv} conversion, {skipped_no_score} no-score")
        return np.array(features_list, dtype=np.float32), np.array(scores_list, dtype=np.float32)

    train_recs = load_records(train_jsonl)
    val_recs = load_records(val_jsonl)
    test_recs = load_records(test_jsonl)

    X_train, y_train = _extract_set(train_recs, "Train")
    X_val, y_val = _extract_set(val_recs, "Val")
    X_test, y_test = _extract_set(test_recs, "Test")

    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_val_scaled = scaler.transform(X_val)
    X_test_scaled = scaler.transform(X_test)

    print(f"  Train: {len(X_train)}, Val: {len(X_val)}, Test: {len(X_test)}")
    print(f"  Feature dim: {X_train.shape[1]}")

    # Train LightGBM
    print(f"\nTraining LightGBM regressor...")
    train_data = lgb.Dataset(X_train_scaled, label=y_train)
    val_data = lgb.Dataset(X_val_scaled, label=y_val, reference=train_data)

    params = {
        "objective": "regression",
        "metric": "rmse",
        "boosting_type": "gbdt",
        "num_leaves": 31,
        "learning_rate": 0.05,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbose": -1,
        "seed": seed,
    }

    booster = lgb.train(
        params, train_data,
        num_boost_round=500,
        valid_sets=[val_data],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(50)],
    )

    # Evaluate
    y_pred_train = booster.predict(X_train_scaled, num_iteration=booster.best_iteration)
    y_pred_val = booster.predict(X_val_scaled, num_iteration=booster.best_iteration)
    y_pred_test = booster.predict(X_test_scaled, num_iteration=booster.best_iteration)

    # Clip
    y_pred_train = np.clip(y_pred_train, 0, 100)
    y_pred_val = np.clip(y_pred_val, 0, 100)
    y_pred_test = np.clip(y_pred_test, 0, 100)

    def _metrics(y_true, y_pred, label):
        mae = mean_absolute_error(y_true, y_pred)
        rmse = np.sqrt(mean_squared_error(y_true, y_pred))
        r2 = r2_score(y_true, y_pred)
        # Quality level accuracy
        true_levels = [score_to_quality_label(s) for s in y_true]
        pred_levels = [score_to_quality_label(s) for s in y_pred]
        level_acc = accuracy_score(true_levels, pred_levels)
        return {
            "set": label, "mae": round(mae, 2), "rmse": round(rmse, 2),
            "r2": round(r2, 4), "level_accuracy": round(level_acc, 4),
        }

    train_metrics = _metrics(y_train, y_pred_train, "train")
    val_metrics = _metrics(y_val, y_pred_val, "val")
    test_metrics = _metrics(y_test, y_pred_test, "test")

    for m in [train_metrics, val_metrics, test_metrics]:
        print(f"  {m['set']}: MAE={m['mae']:.2f}, RMSE={m['rmse']:.2f}, "
              f"R²={m['r2']:.4f}, LevelAcc={m['level_accuracy']:.4f}")

    # Per-level accuracy
    print(f"\n  Per-level test accuracy:")
    for level_name in ["不合格", "及格", "良好", "优秀"]:
        mask = np.array([score_to_quality_label(s) for s in y_test]) == level_name
        if mask.sum() > 0:
            acc = accuracy_score(
                [score_to_quality_label(s) for s in y_test[mask]],
                [score_to_quality_label(s) for s in y_pred_test[mask]],
            )
            print(f"    {level_name}: {acc:.4f} (n={mask.sum()})")

    # Save
    bundle = {
        "model_type": "lightgbm_regressor",
        "booster": booster,
        "scaler": scaler,
        "feature_names": [f"feat_{i}" for i in range(X_train.shape[1])],
        "feature_config": {"num_features": X_train.shape[1]},
        "calibration_params": {},
        "best_iteration": booster.best_iteration,
    }
    model_path = output_path / "lgb_quality_model.pkl"
    joblib.dump(bundle, model_path)

    # Metadata
    write_json(output_path / "training_report.json", {
        "train": train_metrics, "val": val_metrics, "test": test_metrics,
    })
    write_json(output_path / "feature_config.json", {"num_features": X_train.shape[1]})
    write_json(output_path / "feature_names.json", bundle["feature_names"])
    write_json(output_path / "dataset_summary.json", {
        "train_samples": len(X_train), "val_samples": len(X_val), "test_samples": len(X_test),
    })
    write_json(output_path / "prediction_policy.json", {
        "confidence_threshold": 0.65, "top_margin_threshold": 0.15,
    })

    print(f"\nQuality model saved to {model_path}")

    return {
        "train": train_metrics,
        "val": val_metrics,
        "test": test_metrics,
        "model_path": str(model_path),
    }


def _extract_raw_seq(record, config):
    """Extract raw per-node IMU sequence."""
    from src.jsonl_sequence_dataset import (
        JSONL_TO_MODEL_NODE_MAPPING, RAW_IMU_CHANNELS, _fill_nan_vector,
    )
    frames = record.get("frames")
    if not isinstance(frames, list) or not frames:
        return np.zeros((1, 9, 6), dtype=np.float32)
    sorted_frames = sorted(
        [f for f in frames if isinstance(f, dict)], key=lambda x: float(x.get("t", 0.0)))
    if not sorted_frames:
        return np.zeros((1, 9, 6), dtype=np.float32)
    node_to_idx = {node: i for i, node in enumerate(config.node_order)}
    raw = np.full((len(sorted_frames), len(config.node_order), 6), np.nan, dtype=np.float32)
    for fi, frame in enumerate(sorted_frames):
        p = frame.get("p")
        if not isinstance(p, dict):
            continue
        for raw_node, values in p.items():
            mapped = JSONL_TO_MODEL_NODE_MAPPING.get(str(raw_node))
            if mapped not in node_to_idx:
                continue
            if not isinstance(values, list) or len(values) != len(RAW_IMU_CHANNELS):
                continue
            raw[fi, node_to_idx[mapped], :] = np.asarray(values, dtype=np.float32)
    for ni in range(raw.shape[1]):
        for ci in range(raw.shape[2]):
            raw[:, ni, ci] = _fill_nan_vector(raw[:, ni, ci], 0.0)
    return raw


# ── 主入口 ────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="重训练动作分类 + 质量回归模型")
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--test-jsonl", required=True)
    parser.add_argument("--action-output", default="experiments/weight_shift_v2")
    parser.add_argument("--quality-output", default="experiments/lgb_quality_v3")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-epochs", type=int, default=100)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--device", default=None)
    parser.add_argument("--skip-action", action="store_true")
    parser.add_argument("--skip-quality", action="store_true")
    args = parser.parse_args()

    set_random_seed(args.seed)
    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))

    results: Dict[str, Any] = {}

    # ── 模型一：动作分类 ──
    if not args.skip_action:
        print("=" * 60)
        print("模型一：CNN-LSTM 动作分类模型")
        print("=" * 60)
        action_results = train_action_model(
            train_jsonl=args.train_jsonl,
            val_jsonl=args.val_jsonl,
            test_jsonl=args.test_jsonl,
            output_dir=args.action_output,
            device=device,
            batch_size=args.batch_size,
            max_epochs=args.max_epochs,
            learning_rate=args.learning_rate,
            patience=args.patience,
        )
        results["action"] = action_results

    # ── 模型二：LightGBM 质量回归 ──
    if not args.skip_quality:
        print("\n" + "=" * 60)
        print("模型二：LightGBM 质量回归模型")
        print("=" * 60)
        quality_results = train_quality_model(
            train_jsonl=args.train_jsonl,
            val_jsonl=args.val_jsonl,
            test_jsonl=args.test_jsonl,
            output_dir=args.quality_output,
            action_checkpoint_path=str(
                Path(args.action_output) / "action_model.pt"),
            seed=args.seed,
        )
        results["quality"] = quality_results

    # ── 汇总 ──
    print("\n" + "=" * 60)
    print("训练完成")
    print("=" * 60)
    if "action" in results:
        a = results["action"]
        print(f"\n动作模型: {a['model_path']}")
        print(f"  Test Accuracy: {a['test_accuracy']:.4f}")
        print(f"  Test Macro F1: {a['test_macro_f1']:.4f}")
    if "quality" in results:
        q = results["quality"]["test"]
        print(f"\n质量模型: {results['quality']['model_path']}")
        print(f"  Test MAE: {q['mae']:.2f}")
        print(f"  Test RMSE: {q['rmse']:.2f}")
        print(f"  Test R²: {q['r2']:.4f}")
        print(f"  Test Level Acc: {q['level_accuracy']:.4f}")

    # Save results JSON
    with open("retrain_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2, default=str)
    print(f"\nResults saved to retrain_results.json")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
