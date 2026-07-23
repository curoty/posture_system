"""Adapter for the shared training-frame denoiser.

The algorithm remains in skating-deep-cnn-lstm-bayes/src/denoise.py; this
module only loads it under a unique module name so it does not collide with
model_service_fastapi's own ``src`` package.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


def _load_shared_module():
    algorithm_path = (
        Path(__file__).resolve().parents[2]
        / "skating-deep-cnn-lstm-bayes"
        / "src"
        / "denoise.py"
    )
    if not algorithm_path.exists():
        raise RuntimeError(f"shared denoiser not found: {algorithm_path}")
    spec = importlib.util.spec_from_file_location(
        "posture_shared_denoise",
        algorithm_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load shared denoiser: {algorithm_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def filter_training_frames(
    frames: Sequence[Mapping[str, Any]],
    roles: Optional[Sequence[str]] = None,
    profiles: Optional[Mapping[str, Mapping[str, Any]]] = None,
    sample_rate_hz: float = 50.0,
    remove_spikes: bool = True,
    acc_cutoff_hz: Optional[float] = None,
    gyro_cutoff_hz: Optional[float] = None,
):
    module = _load_shared_module()
    selected_profiles = _select_profiles(profiles or {}, roles or [])
    return module.process_training_frames(
        frames=frames,
        roles=roles,
        profiles=selected_profiles,
        sample_rate_hz=sample_rate_hz,
        remove_spikes=remove_spikes,
        acc_cutoff_hz=acc_cutoff_hz,
        gyro_cutoff_hz=gyro_cutoff_hz,
    )


def _load_bench_profiles() -> dict[str, dict[str, Any]]:
    configured = str(os.environ.get("IMU_CALIBRATION_PROFILE_PATH", "")).strip()
    root = Path(__file__).resolve().parents[2]
    profile_paths = (
        [Path(configured)]
        if configured
        else [
            root / "calibration_profiles_v3_raw.json",
            root / "calibration_profiles_v3_raw_per_node.json",
        ]
    )
    merged: dict[str, dict[str, Any]] = {}
    for profile_path in profile_paths:
        try:
            value = json.loads(profile_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        nodes = value.get("nodes", {}) if isinstance(value, dict) else {}
        if isinstance(nodes, dict):
            merged.update({str(role): dict(profile) for role, profile in nodes.items() if isinstance(profile, Mapping)})
    return merged


def _active_profile_is_valid(profile: Mapping[str, Any]) -> bool:
    metadata = profile.get("metadata", {})
    if not isinstance(metadata, Mapping):
        metadata = {}
    status = str(metadata.get("calibration_status", "")).strip().lower()
    if status in {"ready", "valid", "accepted", "success"}:
        return True
    mode = str(profile.get("calibration_mode", "")).strip().lower()
    return mode in {"residual_python", "explicit_residual"}


def _select_profiles(
    active_profiles: Mapping[str, Mapping[str, Any]],
    roles: Sequence[str],
) -> dict[str, dict[str, Any]]:
    """Active valid profile wins; otherwise use the per-node V3 bench profile."""
    bench_profiles = _load_bench_profiles()
    selected: dict[str, dict[str, Any]] = {}
    requested_roles = list(roles) or list(bench_profiles.keys())
    for role in requested_roles:
        active = active_profiles.get(role)
        if isinstance(active, Mapping) and _active_profile_is_valid(active):
            selected[role] = dict(active)
            selected[role].setdefault("metadata", {})["calibration_source"] = "active"
            continue
        bench = bench_profiles.get(role)
        if isinstance(bench, Mapping):
            selected[role] = dict(bench)
            selected[role].setdefault("metadata", {})["calibration_source"] = "bench_v3_raw"
    return selected
