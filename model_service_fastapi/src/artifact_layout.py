"""Helpers for writing standardized training and analysis artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


def write_json_artifact(output_path: str | Path, payload: Dict[str, Any]) -> Path:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_standard_artifact_bundle(
    output_dir: str | Path,
    *,
    dataset_summary: Dict[str, Any],
    training_summary: Dict[str, Any],
    evaluation_summary: Dict[str, Any] | None,
    prediction_policy: Dict[str, Any],
) -> Dict[str, str]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    bundle = {
        "dataset_summary.json": write_json_artifact(output_path / "dataset_summary.json", dataset_summary),
        "training_summary.json": write_json_artifact(output_path / "training_summary.json", training_summary),
        "prediction_policy.json": write_json_artifact(output_path / "prediction_policy.json", prediction_policy),
    }
    if evaluation_summary is not None:
        bundle["evaluation_summary.json"] = write_json_artifact(
            output_path / "evaluation_summary.json",
            evaluation_summary,
        )

    return {name: str(path) for name, path in bundle.items()}
