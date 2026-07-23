"""Label definitions and mapping helpers for the RF baseline project."""

from __future__ import annotations

from typing import Dict


CANONICAL_LABELS: Dict[int, str] = {
    0: "Standing still",
    1: "Smooth gliding",
    2: "One-foot gliding",
    3: "T-stop",
    4: "Fall",
    5: "Acceleration",
}

LEGACY_LABEL_ALIASES: Dict[str, str] = {
    "Static": "Standing still",
    "Smooth": "Smooth gliding",
    "Single_Leg": "One-foot gliding",
    "T_Brake": "T-stop",
    "Sprint": "Acceleration",
    "Fall": "Fall",
}

_CANONICAL_NAME_TO_ID: Dict[str, int] = {
    label_name.casefold(): label_id for label_id, label_name in CANONICAL_LABELS.items()
}

_ALIAS_TO_CANONICAL: Dict[str, str] = {
    alias.casefold(): canonical_name for alias, canonical_name in LEGACY_LABEL_ALIASES.items()
}


def normalize_label_name(name: str) -> str:
    """Normalize a canonical or legacy label name into the canonical label name."""
    if not isinstance(name, str):
        raise TypeError("Label name must be a string.")

    normalized_input = name.strip()
    if not normalized_input:
        raise ValueError("Label name cannot be empty.")

    canonical_name = _ALIAS_TO_CANONICAL.get(normalized_input.casefold(), normalized_input)
    if canonical_name.casefold() not in _CANONICAL_NAME_TO_ID:
        raise ValueError(f"Unknown label name: {name}")

    return CANONICAL_LABELS[_CANONICAL_NAME_TO_ID[canonical_name.casefold()]]


def get_label_id(name: str) -> int:
    """Return the numeric label id for a canonical or legacy label name."""
    canonical_name = normalize_label_name(name)
    return _CANONICAL_NAME_TO_ID[canonical_name.casefold()]


def get_label_name(label_id: int) -> str:
    """Return the canonical label name for a numeric label id."""
    if label_id not in CANONICAL_LABELS:
        raise ValueError(f"Unknown label id: {label_id}")
    return CANONICAL_LABELS[label_id]
