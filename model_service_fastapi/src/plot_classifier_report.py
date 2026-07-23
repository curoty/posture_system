"""Plot classifier confusion matrix from eval_result.json and print F1 summary."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

import matplotlib.pyplot as plt
import numpy as np


def _load_eval_result(eval_path: str | Path) -> Dict[str, Any]:
    payload = json.loads(Path(eval_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Evaluation result JSON must be an object.")
    return payload


def _build_percentage_matrix(confusion: np.ndarray) -> np.ndarray:
    row_sums = confusion.sum(axis=1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        percentages = np.divide(confusion, row_sums, where=row_sums != 0) * 100.0
    percentages[row_sums.squeeze(axis=1) == 0] = 0.0
    return percentages


def plot_confusion_matrix(eval_path: str | Path, output_path: str | Path) -> Dict[str, float]:
    payload = _load_eval_result(eval_path)
    labels = [str(label) for label in payload.get("labels", [])]
    confusion = np.asarray(payload.get("confusion_matrix", []), dtype=float)
    report = payload.get("classification_report", {})

    if confusion.ndim != 2 or confusion.shape[0] == 0 or confusion.shape[0] != confusion.shape[1]:
        raise ValueError("confusion_matrix must be a non-empty square matrix.")
    if len(labels) != confusion.shape[0]:
        raise ValueError("labels length must match confusion_matrix dimensions.")

    percentages = _build_percentage_matrix(confusion)

    fig_width = max(6.0, len(labels) * 1.6)
    fig_height = max(5.0, len(labels) * 1.3)
    fig, ax = plt.subplots(figsize=(fig_width, fig_height))
    image = ax.imshow(percentages, cmap="Blues", vmin=0.0, vmax=100.0)
    colorbar = fig.colorbar(image, ax=ax)
    colorbar.set_label("Percentage (%)")

    ax.set_title("Action Classification Confusion Matrix")
    ax.set_xlabel("Predicted Label")
    ax.set_ylabel("True Label")
    ax.set_xticks(np.arange(len(labels)))
    ax.set_yticks(np.arange(len(labels)))
    ax.set_xticklabels(labels, rotation=30, ha="right")
    ax.set_yticklabels(labels)

    for row_index in range(percentages.shape[0]):
        for col_index in range(percentages.shape[1]):
            value = percentages[row_index, col_index]
            color = "white" if value >= 50.0 else "black"
            ax.text(col_index, row_index, f"{value:.1f}%", ha="center", va="center", color=color)

    fig.tight_layout()
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=200, bbox_inches="tight")
    plt.close(fig)

    f1_scores: Dict[str, float] = {}
    for label in labels:
        label_metrics = report.get(label, {})
        f1_scores[label] = float(label_metrics.get("f1-score", 0.0))

    print("[plot_classifier_report] Saved confusion matrix to:", output)
    print("[plot_classifier_report] Per-class F1 summary:")
    for label, score in f1_scores.items():
        print(f"  - {label}: F1={score:.4f}")

    macro_avg = report.get("macro avg", {})
    weighted_avg = report.get("weighted avg", {})
    if macro_avg:
        print(f"[plot_classifier_report] Macro F1: {float(macro_avg.get('f1-score', 0.0)):.4f}")
    if weighted_avg:
        print(f"[plot_classifier_report] Weighted F1: {float(weighted_avg.get('f1-score', 0.0)):.4f}")

    return f1_scores


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Plot confusion matrix from action classifier eval_result.json.")
    parser.add_argument("--eval", required=True, help="Path to eval_result.json.")
    parser.add_argument("--output", required=True, help="Path to output PNG file.")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        plot_confusion_matrix(args.eval, args.output)
    except Exception as exc:
        print(f"[plot_classifier_report] Error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
