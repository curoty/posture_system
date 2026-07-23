"""Offline evaluation utilities for action classifiers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix


def _to_python_types(value: Any) -> Any:
    """Recursively convert numpy scalars/arrays into JSON-safe Python types."""
    if isinstance(value, dict):
        return {str(key): _to_python_types(sub_value) for key, sub_value in value.items()}
    if isinstance(value, list):
        return [_to_python_types(item) for item in value]
    if isinstance(value, tuple):
        return [_to_python_types(item) for item in value]
    if isinstance(value, np.ndarray):
        return [_to_python_types(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return value.item()
    return value


def evaluate_model(
    model: Any,
    X_test: np.ndarray,
    y_test: np.ndarray,
    label_names: Optional[Sequence[str]],
    save_path: str | Path,
) -> Dict[str, Any]:
    """Evaluate a classifier on a held-out test set and persist JSON results."""
    y_pred = model.predict(X_test)

    labels = sorted(int(label_id) for label_id in np.unique(y_test))
    ordered_label_names: List[str]
    if label_names:
        ordered_label_names = [str(label_name) for label_name in label_names]
    else:
        ordered_label_names = [str(label_id) for label_id in labels]

    report = classification_report(
        y_test,
        y_pred,
        labels=labels,
        target_names=ordered_label_names,
        output_dict=True,
        zero_division=0,
    )
    matrix = confusion_matrix(y_test, y_pred, labels=labels)
    accuracy = accuracy_score(y_test, y_pred)

    result = {
        "accuracy": float(accuracy),
        "classification_report": _to_python_types(report),
        "confusion_matrix": _to_python_types(matrix),
        "labels": ordered_label_names,
    }

    output_path = Path(save_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print("[evaluate_classifier] Action classifier evaluation completed.")
    print(f"[evaluate_classifier] Accuracy: {result['accuracy']:.4f}")
    print("[evaluate_classifier] Labels:", ", ".join(ordered_label_names))
    print("[evaluate_classifier] Classification report:")
    print(json.dumps(result["classification_report"], ensure_ascii=False, indent=2))
    print("[evaluate_classifier] Confusion matrix:")
    print(json.dumps(result["confusion_matrix"], ensure_ascii=False, indent=2))
    print(f"[evaluate_classifier] Saved evaluation JSON to: {output_path}")

    return result
