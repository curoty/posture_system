#!/usr/bin/env python3
"""Plot ablation confusion matrices as a 2x2 grid for paper illustration.

Reads ablation_results.json, extracts confusion matrices from all 4 model
variants, and renders them side-by-side in a single high-resolution figure.

Output: experiments/ablation_confusion_matrices.png (DPI=300)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
import numpy as np

# ---------------------------------------------------------------------------
# Attempt Chinese font support
# ---------------------------------------------------------------------------
_HAS_CN = False
for _font in ("SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC"):
    try:
        matplotlib.font_manager.findfont(_font, fallback_to_default=False)
        matplotlib.rcParams["font.sans-serif"] = [_font, "DejaVu Sans"]
        _HAS_CN = True
        break
    except Exception:
        continue

ACTION_NAMES = [
    "weight_shift", "side_push_recover", "jump",
    "turn", "stop", "arm_swing", "combination",
]

if _HAS_CN:
    ACTION_LABELS = ["重心转移", "侧向推冰", "跳跃", "转弯", "刹车", "摆臂", "组合"]
    XLABEL = "预测类别"
    YLABEL = "真实类别"
else:
    ACTION_LABELS = ["W-Shift", "S-Push", "Jump", "Turn", "Stop", "Arm", "Combo"]
    XLABEL = "Predicted"
    YLABEL = "True"

matplotlib.rcParams.update({
    "font.size": 10,
    "axes.titlesize": 11,
    "figure.dpi": 150,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "axes.unicode_minus": False,
})


def plot_one_cm(ax, cm: np.ndarray, title: str) -> None:
    """Plot a single confusion matrix on a given Axes."""
    cm_norm = cm.astype(float) / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    n = len(cm)

    im = ax.imshow(cm_norm, cmap="Blues", vmin=0, vmax=1)

    ax.set_xticks(range(n))
    ax.set_yticks(range(n))
    ax.set_xticklabels(ACTION_LABELS, fontsize=7, rotation=30, ha="right")
    ax.set_yticklabels(ACTION_LABELS, fontsize=7)
    ax.set_xlabel(XLABEL, fontsize=8)
    ax.set_ylabel(YLABEL, fontsize=8)

    for i in range(n):
        for j in range(n):
            val = cm_norm[i, j]
            text = f"{val:.2f}" if val > 0 else "0"
            color = "white" if val > 0.5 else "black"
            ax.text(j, i, text, ha="center", va="center", fontsize=6.5, color=color)

    ax.set_title(title, fontsize=11, fontweight="bold", pad=8)
    return im


def main() -> int:
    json_path = (
        Path(__file__).resolve().parent.parent / "experiments" / "ablation_results.json"
    )
    if not json_path.exists():
        print(f"Error: {json_path} not found. Run run_ablation.py first.")
        return 1

    data = json.loads(json_path.read_text(encoding="utf-8"))
    models = data["models"]

    # Reorder
    order = ["CNN-only", "CNN+LSTM", "CNN+Attention", "CNN+LSTM+Attention"]
    models.sort(key=lambda m: order.index(m["name"]) if m["name"] in order else 99)

    # Build 2x2 grid
    fig, axes = plt.subplots(2, 2, figsize=(14, 12))

    for ax, m in zip(axes.flat, models):
        cm = np.array(m["evaluation"]["full_sequence"]["confusion_matrix"])
        acc = m["evaluation"]["full_sequence"]["accuracy"]
        title = f"{m['name']}\n(Acc={acc:.4f})"
        im = plot_one_cm(ax, cm, title)

    # One shared colorbar
    cbar = fig.colorbar(im, ax=axes, shrink=0.85, pad=0.02, location="right")
    cbar.set_label("Proportion", fontsize=9)

    fig.suptitle("Ablation Study — Confusion Matrices", fontsize=14, fontweight="bold", y=1.01)
    fig.subplots_adjust(left=0.06, right=0.92, top=0.93, bottom=0.06, wspace=0.25, hspace=0.30)

    output_path = json_path.parent / "ablation_confusion_matrices.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    print(f"Saved: {output_path.resolve()}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
