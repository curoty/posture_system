"""Adapter for the shared training-frame denoiser (simplified import)."""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from src.denoise import process_training_frames


def filter_training_frames(
    frames: Sequence[Mapping[str, Any]],
    roles: Optional[Sequence[str]] = None,
    profiles: Optional[Mapping[str, Mapping[str, Any]]] = None,
    sample_rate_hz: float = 50.0,
    remove_spikes: bool = True,
    acc_cutoff_hz: Optional[float] = None,
    gyro_cutoff_hz: Optional[float] = None,
):
    return process_training_frames(
        frames=frames,
        roles=roles,
        profiles=profiles,
        sample_rate_hz=sample_rate_hz,
        remove_spikes=remove_spikes,
        acc_cutoff_hz=acc_cutoff_hz,
        gyro_cutoff_hz=gyro_cutoff_hz,
    )
