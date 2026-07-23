# -*- coding: utf-8 -*-
"""多类别动作分类训练器(支持新旧两种架构对比)。

- --arch baseline   : 原 CNN-LSTM-Attention(拍平54维)
- --arch structured : 结构感知编码器(逐节点卷积 + 跨节点注意力 + 可选旋转不变量)

针对类别失衡(weight_shift ≫ side_push_recover):
  - 类别加权 CrossEntropyLoss(按训练集频率倒数加权)
  - 以 macro-F1 选最优 epoch + early stopping(而非 accuracy,失衡下 accuracy 会误导)

用法:
    python -m src.train_multiclass \
        --data-dir data_multiclass --arch structured --derived \
        --output-dir experiments/multiclass_structured --seed 42
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from torch.utils.data import DataLoader

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from src.jsonl_sequence_dataset import (
    SequenceConfig,
    SequenceTensorDataset,
    apply_normalization,
    convert_record_to_sequence,
    fit_normalization,
    iter_jsonl_records,
    normalize_action_type,
    write_json,
)
from src.model import (
    ActionModelConfig,
    CNNLSTMAttentionClassifier,
    StructuredActionClassifier,
    StructuredModelConfig,
)

DEFAULT_SEED = 42


def set_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_split(jsonl_path: str, config: SequenceConfig,
               label_map: Optional[Dict[str, int]]):
    """Returns (X, y, label_map). Builds label_map from data if not given."""
    records = list(iter_jsonl_records(jsonl_path))
    if label_map is None:
        actions = sorted({
            a for a in (normalize_action_type(r.get("actionType")) for r in records)
            if a is not None
        })
        label_map = {a: i for i, a in enumerate(actions)}

    seqs, labels = [], []
    skipped = 0
    for r in records:
        action = normalize_action_type(r.get("actionType"))
        if action not in label_map:
            skipped += 1
            continue
        seq, _lid, _meta = convert_record_to_sequence(
            r, config=config, label_name_to_id=None, require_action_type=False)
        if seq is None:
            skipped += 1
            continue
        seqs.append(seq)
        labels.append(label_map[action])
    X = np.stack(seqs).astype(np.float32)
    y = np.asarray(labels, dtype=np.int64)
    print(f"  {Path(jsonl_path).name}: {len(y)} (skipped {skipped}) "
          f"dist={dict(Counter(y.tolist()))}")
    return X, y, label_map


def class_weights(y: np.ndarray, num_classes: int, device: torch.device) -> torch.Tensor:
    counts = Counter(y.tolist())
    total = len(y)
    w = [total / (num_classes * max(1, counts.get(c, 0))) for c in range(num_classes)]
    return torch.tensor(w, dtype=torch.float32, device=device)


def build_model(arch: str, input_dim: int, num_nodes: int, ch_per_node: int, num_classes: int):
    if arch == "baseline":
        return CNNLSTMAttentionClassifier(
            ActionModelConfig(input_dim=input_dim, num_classes=num_classes))
    if arch == "structured":
        return StructuredActionClassifier(
            StructuredModelConfig(num_nodes=num_nodes, channels_per_node=ch_per_node,
                                  num_classes=num_classes))
    raise ValueError(f"unknown arch: {arch}")


def evaluate(model, loader, device, id_to_name, criterion=None) -> Dict[str, Any]:
    model.eval()
    preds, labels, loss_sum, n = [], [], 0.0, 0
    with torch.no_grad():
        for bx, by in loader:
            bx, by = bx.to(device), by.to(device)
            logits = model(bx)
            if criterion is not None:
                loss_sum += float(criterion(logits, by).cpu()) * bx.size(0)
                n += bx.size(0)
            preds.extend(torch.argmax(logits, dim=1).cpu().tolist())
            labels.extend(by.cpu().tolist())
    ids = sorted(id_to_name)
    return {
        "accuracy": round(float(accuracy_score(labels, preds)), 4),
        "macro_f1": round(float(f1_score(labels, preds, average="macro", zero_division=0)), 4),
        "loss": round(loss_sum / max(1, n), 6) if criterion is not None else None,
        "per_class": classification_report(
            labels, preds, labels=ids,
            target_names=[id_to_name[i] for i in ids],
            output_dict=True, zero_division=0),
        "confusion_matrix": confusion_matrix(labels, preds, labels=ids).tolist(),
    }


def run(data_dir: str, arch: str, output_dir: str, use_derived: Sequence[str],
        batch_size: int, max_epochs: int, lr: float, patience: int,
        seed: int, device_name: Optional[str],
        denoise: bool = False, lowpass_hz: Optional[float] = None) -> Dict[str, Any]:
    set_seed(seed)
    out = Path(output_dir); out.mkdir(parents=True, exist_ok=True)
    device = torch.device(device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

    seq_config = SequenceConfig(
        sequence_length=180,
        derived_channels=tuple(use_derived),
        denoise_spikes=denoise,
        denoise_lowpass_hz=lowpass_hz,
    )
    ch_per_node = len(seq_config.channels)  # 6 / 8 / 10 / 12，取决于派生通道

    print(f"[data] arch={arch}, derived={list(use_derived) or 'none'}, "
          f"channels_per_node={ch_per_node}, input_dim={seq_config.input_dim}, "
          f"denoise={denoise}, lowpass={lowpass_hz}")
    d = Path(data_dir)
    X_tr, y_tr, label_map = load_split(str(d / "train.jsonl"), seq_config, None)
    X_va, y_va, _ = load_split(str(d / "val.jsonl"), seq_config, label_map)
    X_te, y_te, _ = load_split(str(d / "test.jsonl"), seq_config, label_map)
    id_to_name = {i: a for a, i in label_map.items()}
    num_classes = len(label_map)
    print(f"[data] label_map={label_map}")

    norm = fit_normalization(X_tr)
    X_tr, X_va, X_te = (apply_normalization(x, norm) for x in (X_tr, X_va, X_te))

    tr_loader = DataLoader(SequenceTensorDataset(X_tr, y_tr), batch_size=batch_size, shuffle=True)
    va_loader = DataLoader(SequenceTensorDataset(X_va, y_va), batch_size=batch_size, shuffle=False)
    te_loader = DataLoader(SequenceTensorDataset(X_te, y_te), batch_size=batch_size, shuffle=False)

    model = build_model(arch, seq_config.input_dim, seq_config.node_order.__len__(),
                        ch_per_node, num_classes).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[model] arch={arch}, params={n_params:,}")

    criterion = nn.CrossEntropyLoss(weight=class_weights(y_tr, num_classes, device))
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", patience=4, factor=0.5)

    # 选择标准:优先 val macro-F1,F1 相同(小验证集易饱和)时取 val loss 更低者。
    best_score, best_f1, best_state, no_improve, history = (-1.0, float("inf")), -1.0, None, 0, []
    for epoch in range(1, max_epochs + 1):
        model.train()
        losses = []
        for bx, by in tr_loader:
            bx, by = bx.to(device), by.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(bx), by)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        val = evaluate(model, va_loader, device, id_to_name, criterion)
        scheduler.step(val["macro_f1"])
        history.append({"epoch": epoch, "train_loss": round(float(np.mean(losses)), 4),
                        "val_acc": val["accuracy"], "val_macro_f1": val["macro_f1"],
                        "val_loss": val["loss"]})
        print(f"  epoch {epoch:3d} | loss={np.mean(losses):.4f} "
              f"val_acc={val['accuracy']:.4f} val_macroF1={val['macro_f1']:.4f} "
              f"val_loss={val['loss']:.4f}")
        score = (val["macro_f1"], -val["loss"])  # 词典序:先比F1,再比(更低的)loss
        if score > best_score:
            best_score, best_f1 = score, val["macro_f1"]
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1
            if no_improve >= patience:
                print(f"  early stopping at epoch {epoch}")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    test_metrics = evaluate(model, te_loader, device, id_to_name)

    config_obj = model.config if hasattr(model, "config") else None
    checkpoint = {
        "arch": arch,
        "model_config": config_obj.to_dict() if config_obj else {},
        "model_state_dict": best_state,
        "sequence_config": seq_config.to_dict(),
        "normalization": norm,
        "label_metadata": {"label_map": label_map, "num_classes": num_classes},
    }
    torch.save(checkpoint, out / "action_model.pt")
    write_json(out / "evaluation_summary.json", {
        "arch": arch, "num_params": n_params, "best_val_macro_f1": best_f1,
        "test": test_metrics, "label_map": label_map,
    })
    write_json(out / "training_history.json", history)

    print(f"\n[{arch}] params={n_params:,}  best_val_macroF1={best_f1:.4f}")
    print(f"  TEST  acc={test_metrics['accuracy']:.4f}  macroF1={test_metrics['macro_f1']:.4f}")
    print(f"  confusion={test_metrics['confusion_matrix']}  ({list(id_to_name.values())})")
    for name in id_to_name.values():
        pc = test_metrics["per_class"].get(name, {})
        print(f"    {name}: P={pc.get('precision',0):.3f} R={pc.get('recall',0):.3f} "
              f"F1={pc.get('f1-score',0):.3f} n={int(pc.get('support',0))}")
    return {"arch": arch, "num_params": n_params, "test": test_metrics, "best_val_macro_f1": best_f1}


def main() -> int:
    p = argparse.ArgumentParser(description="多类别动作分类训练(新旧架构对比)")
    p.add_argument("--data-dir", default="data_multiclass")
    p.add_argument("--arch", choices=["baseline", "structured"], required=True)
    p.add_argument("--output-dir", required=True)
    # 显式列出派生通道，而非布尔开关 —— 消融实验需要独立控制每个因子:
    #   acc_mag/gyro_mag: 单传感器模长(旋转不变)
    #   attitude:         加速度计+陀螺仪互补融合出的绝对倾角(见 src/attitude.py)
    p.add_argument("--derived", nargs="*", default=[],
                   choices=["acc_mag", "gyro_mag", "attitude"],
                   help="追加的派生通道。例: --derived acc_mag gyro_mag attitude")
    # 去噪(src/denoise.py)。作为独立因子暴露，便于做 A/B 消融。
    p.add_argument("--denoise", action="store_true",
                   help="剔除野值尖刺。实测本项目野值率0.7%%、acc峰值228g(物理不可能)")
    p.add_argument("--lowpass-hz", type=float, default=None,
                   help="低通截止频率(Hz)。默认不做 —— 实测高频抖动仅占信号2%%，"
                        "低通收益小且可能抹掉真实快速运动")
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--max-epochs", type=int, default=80)
    p.add_argument("--learning-rate", type=float, default=1e-3)
    p.add_argument("--patience", type=int, default=12)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--device", default=None)
    args = p.parse_args()
    res = run(args.data_dir, args.arch, args.output_dir, args.derived,
              args.batch_size, args.max_epochs, args.learning_rate,
              args.patience, args.seed, args.device,
              denoise=args.denoise, lowpass_hz=args.lowpass_hz)
    print(json.dumps({"arch": res["arch"], "num_params": res["num_params"],
                      "test_macro_f1": res["test"]["macro_f1"],
                      "test_acc": res["test"]["accuracy"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
