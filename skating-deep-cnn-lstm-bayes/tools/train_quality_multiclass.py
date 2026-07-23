# -*- coding: utf-8 -*-
"""在多类别数据 + 结构感知编码器上训练 LightGBM 质量回归模型。

与 retrain_models.train_quality_model 的差异:
  - 按 checkpoint["arch"] 自适应加载编码器(structured / baseline);
  - 动态确定 embedding 维度与动作概率维度(2分类 → action_prob 有2维),
    自动生成对应的特征名,避免维度写死。

评分模型是全局的(weight_shift + side_push_recover 混合训练),动作 embedding
让 LightGBM 能按动作条件化。side_push 样本稀少,其评分精度仅供参考。

用法:
    python tools/train_quality_multiclass.py \
        --data-dir data_multiclass \
        --action-model experiments/multiclass_structured/action_model.pt \
        --output-dir experiments/lgb_quality_multiclass --seed 42
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.jsonl_sequence_dataset import SequenceConfig, apply_normalization, convert_record_to_sequence
from src.model import (
    ActionModelConfig, CNNLSTMAttentionClassifier,
    StructuredActionClassifier, StructuredModelConfig,
)
from src.predict import _extract_lgb_features_inference
from src.quality_labels import score_to_quality_label
from tools.retrain_models import _extract_raw_seq, load_records


def load_encoder(path: str, device: torch.device):
    ckpt = torch.load(path, map_location=device, weights_only=False)
    arch = ckpt.get("arch", "baseline")
    if arch == "structured":
        model = StructuredActionClassifier(StructuredModelConfig.from_dict(ckpt["model_config"]))
    else:
        model = CNNLSTMAttentionClassifier(ActionModelConfig.from_dict(ckpt["model_config"]))
    model.load_state_dict(ckpt["model_state_dict"])
    model.to(device).eval()
    return model, ckpt, arch


def build_feature_names(n_emb: int, n_probs: int, node_order) -> List[str]:
    return (
        [f"emb_{i}" for i in range(n_emb)]
        + [f"action_prob_{i}" for i in range(n_probs)]
        + ["temporal_mean", "temporal_std", "temporal_max", "temporal_min",
           "acc_var_global", "gyro_var_global", "jerk_roughness"]
        + [f"node_{n}_acc_var" for n in node_order]
        + [f"node_{n}_gyro_var" for n in node_order]
        + ["sim_top1", "sim_topk_mean", "sim_temporal_align",
           "duration_seconds", "missing_node_ratio"]
    )


def extract_split(records, model, seq_config, normalization, node_order, feature_names, device):
    feats, scores = [], []
    skip_conv, skip_score = 0, 0
    for r in records:
        seq, _, meta = convert_record_to_sequence(
            r, config=seq_config, label_name_to_id=None, require_action_type=False)
        if seq is None:
            skip_conv += 1
            continue
        label = r.get("label", {})
        score = label.get("coachScore") if isinstance(label, dict) else None
        if score is None:
            skip_score += 1
            continue
        Xn = apply_normalization(np.expand_dims(seq, 0), normalization)
        t = torch.as_tensor(Xn, dtype=torch.float32, device=device)
        with torch.no_grad():
            logits, emb, _ = model(t, return_embedding=True, return_attention=True)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
            emb = emb.cpu().numpy()[0]
        raw = _extract_raw_seq(r, seq_config)
        f = _extract_lgb_features_inference(
            normalized_sequence=Xn[0], embedding=emb, probabilities=probs,
            action_name=str(r.get("actionType", "unknown")),
            duration_seconds=float(meta.get("duration_seconds", 0)),
            missing_node_ratio=float(meta.get("missing_node_ratio", 0)),
            raw_sequence=raw, node_order=node_order, reference_library=None,
            feature_names=feature_names,
        )
        feats.append(f[0])
        scores.append(float(score))
    if skip_conv or skip_score:
        print(f"    skipped: {skip_conv} conv, {skip_score} no-score")
    return np.array(feats, dtype=np.float32), np.array(scores, dtype=np.float32)


def main() -> int:
    import joblib
    import lightgbm as lgb
    from sklearn.metrics import accuracy_score, mean_absolute_error, mean_squared_error, r2_score
    from sklearn.preprocessing import StandardScaler

    p = argparse.ArgumentParser(description="多类别 LightGBM 质量回归训练")
    p.add_argument("--data-dir", default="data_multiclass")
    p.add_argument("--action-model", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    device = torch.device("cpu")
    out = Path(args.output_dir); out.mkdir(parents=True, exist_ok=True)

    model, ckpt, arch = load_encoder(args.action_model, device)
    seq_config = SequenceConfig.from_dict(ckpt["sequence_config"])
    normalization = ckpt["normalization"]
    node_order = seq_config.node_order
    print(f"[encoder] arch={arch}, input_dim={seq_config.input_dim}, "
          f"derived={seq_config.derived_channels}")

    # 探测维度
    d = Path(args.data_dir)
    probe = load_records(str(d / "train.jsonl"))[0]
    pseq, _, _ = convert_record_to_sequence(probe, config=seq_config, label_name_to_id=None, require_action_type=False)
    pt = torch.as_tensor(apply_normalization(np.expand_dims(pseq, 0), normalization), dtype=torch.float32)
    with torch.no_grad():
        plog, pemb, _ = model(pt, return_embedding=True, return_attention=True)
    feature_names = build_feature_names(pemb.shape[1], plog.shape[1], node_order)
    print(f"[features] emb={pemb.shape[1]}, action_prob={plog.shape[1]}, total={len(feature_names)}")

    print("[extract] train / val / test ...")
    Xtr, ytr = extract_split(load_records(str(d / "train.jsonl")), model, seq_config, normalization, node_order, feature_names, device)
    Xva, yva = extract_split(load_records(str(d / "val.jsonl")), model, seq_config, normalization, node_order, feature_names, device)
    Xte, yte = extract_split(load_records(str(d / "test.jsonl")), model, seq_config, normalization, node_order, feature_names, device)
    print(f"  train={len(Xtr)}, val={len(Xva)}, test={len(Xte)}")

    scaler = StandardScaler()
    Xtr_s = scaler.fit_transform(Xtr); Xva_s = scaler.transform(Xva); Xte_s = scaler.transform(Xte)

    params = dict(objective="regression", metric="rmse", num_leaves=31, learning_rate=0.05,
                  feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=5, verbose=-1, seed=args.seed)
    booster = lgb.train(params, lgb.Dataset(Xtr_s, label=ytr), num_boost_round=500,
                        valid_sets=[lgb.Dataset(Xva_s, label=yva)],
                        callbacks=[lgb.early_stopping(50, verbose=False)])

    def metrics(y, yp, name):
        yp = np.clip(yp, 0, 100)
        lvl = accuracy_score([score_to_quality_label(s) for s in y],
                             [score_to_quality_label(s) for s in yp])
        return {"set": name, "mae": round(mean_absolute_error(y, yp), 2),
                "rmse": round(np.sqrt(mean_squared_error(y, yp)), 2),
                "r2": round(r2_score(y, yp), 4), "level_accuracy": round(lvl, 4)}

    m_tr = metrics(ytr, booster.predict(Xtr_s, num_iteration=booster.best_iteration), "train")
    m_va = metrics(yva, booster.predict(Xva_s, num_iteration=booster.best_iteration), "val")
    m_te = metrics(yte, booster.predict(Xte_s, num_iteration=booster.best_iteration), "test")

    bundle = {"model_type": "lightgbm_regressor", "booster": booster, "scaler": scaler,
              "feature_names": feature_names, "feature_config": {"num_features": Xtr.shape[1]},
              "calibration_params": {}, "best_iteration": booster.best_iteration,
              "action_encoder_arch": arch}
    joblib.dump(bundle, out / "lgb_quality_model.pkl")
    with open(out / "training_report.json", "w", encoding="utf-8") as f:
        json.dump({"train": m_tr, "val": m_va, "test": m_te, "encoder_arch": arch}, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 52)
    print("质量回归训练完成")
    print("=" * 52)
    for m in (m_tr, m_va, m_te):
        print(f"  {m['set']:>5}: MAE={m['mae']:.2f} RMSE={m['rmse']:.2f} R²={m['r2']:.4f} 等级Acc={m['level_accuracy']:.4f}")
    print(f"  模型: {out / 'lgb_quality_model.pkl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
