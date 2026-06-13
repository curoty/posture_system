#!/usr/bin/env python3
"""Export ablation results to CSV and LaTeX table formats.

Reads ablation_results.json and outputs:
  - ablation_table.csv          — full numeric results
  - ablation_table_latex.txt    — LaTeX tabular ready for paper insertion
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path


RESULT_KEYS = [
    ("accuracy",               "Accuracy"),
    ("macro_f1",               "Macro F1"),
    ("weighted_f1",            "Weighted F1"),
    ("sw_accuracy",            "Sliding-Window Acc"),
    ("sw_macro_f1",            "Sliding-Window Macro F1"),
    ("parameters",             "Parameters"),
    ("train_time_seconds",     "Train Time (s)"),
    ("full_latency_ms",        "Full-Seq Latency (ms)"),
    ("sw_latency_ms",          "Sliding-Win Latency (ms)"),
]


def load_results(json_path: str) -> list[dict]:
    data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    models = data["models"]

    rows = []
    for m in models:
        ev = m["evaluation"]
        rows.append({
            "name": m["name"],
            "accuracy":          ev["full_sequence"]["accuracy"],
            "macro_f1":          ev["full_sequence"]["macro_f1"],
            "weighted_f1":       ev["full_sequence"]["weighted_f1"],
            "sw_accuracy":       ev["sliding_window"]["accuracy"],
            "sw_macro_f1":       ev["sliding_window"]["macro_f1"],
            "parameters":        m["parameters"],
            "train_time_seconds": m["training"]["train_time_seconds"],
            "full_latency_ms":   m["latency"]["full_sequence"]["mean_ms"],
            "sw_latency_ms":     m["latency"]["sliding_window"]["mean_ms"],
        })

    # Reorder: CNN-only, CNN+LSTM, CNN+Attention, CNN+LSTM+Attention
    order = ["CNN-only", "CNN+LSTM", "CNN+Attention", "CNN+LSTM+Attention"]
    rows.sort(key=lambda r: order.index(r["name"]) if r["name"] in order else 99)
    return rows


def export_csv(rows: list[dict], output_path: Path) -> None:
    fields = ["name"] + [k for k, _ in RESULT_KEYS]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in fields})
    print(f"CSV saved: {output_path.resolve()}")


def export_latex(rows: list[dict], output_path: Path) -> None:
    # LaTeX table: rows = models, columns = key metrics
    header_names = [
        "Accuracy", "Macro F1", "Sliding-Win Acc",
        "Params", "Train (s)", "Full Lat (ms)", "SW Lat (ms)",
    ]
    latex_keys = [
        "accuracy", "macro_f1", "sw_accuracy",
        "parameters", "train_time_seconds", "full_latency_ms", "sw_latency_ms",
    ]

    lines = []
    lines.append(r"\begin{table}[htbp]")
    lines.append(r"  \centering")
    lines.append(r"  \caption{Ablation study results on synthetic skating IMU data.}")
    lines.append(r"  \label{tab:ablation}")

    col_spec = "l" + "c" * len(header_names)
    lines.append(r"  \begin{tabular}{" + col_spec + "}")
    lines.append(r"    \toprule")
    lines.append(r"    Model & " + " & ".join(header_names) + r" \\")
    lines.append(r"    \midrule")

    for row in rows:
        name = row["name"]
        values = []
        for key in latex_keys:
            val = row[key]
            if key == "parameters":
                values.append(f"{val:,}")
            elif key in ("train_time_seconds",):
                values.append(f"{val:.0f}")
            elif key in ("full_latency_ms", "sw_latency_ms"):
                values.append(f"{val:.2f}")
            else:
                values.append(f"{val:.4f}")
        lines.append(r"    " + f"{name} & " + " & ".join(values) + r" \\")

    lines.append(r"    \bottomrule")
    lines.append(r"  \end{tabular}")
    lines.append(r"\end{table}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"LaTeX saved: {output_path.resolve()}")


def main() -> int:
    json_path = Path(__file__).resolve().parent.parent / "experiments" / "ablation_results.json"
    if not json_path.exists():
        print(f"Error: {json_path} not found. Run run_ablation.py first.")
        return 1

    rows = load_results(str(json_path))
    out_dir = json_path.parent

    export_csv(rows, out_dir / "ablation_table.csv")
    export_latex(rows, out_dir / "ablation_table_latex.txt")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
