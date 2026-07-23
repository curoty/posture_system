"""IMU time-series augmentation utilities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class IMUAugmentor:
    """Apply lightweight augmentations to IMU segments shaped as (N, Channels)."""

    random_state: Optional[int] = None

    def __post_init__(self) -> None:
        self._rng = np.random.default_rng(self.random_state)

    def _validate_input(self, data: np.ndarray) -> np.ndarray:
        array = np.asarray(data, dtype=float)
        if array.ndim != 2:
            raise ValueError("IMUAugmentor expects input shaped as (N, Channels).")
        if array.shape[0] == 0 or array.shape[1] == 0:
            raise ValueError("Input data must be non-empty.")
        return array

    def jitter(self, data: np.ndarray, sigma: float = 0.02) -> np.ndarray:
        """Add zero-mean Gaussian noise scaled by each channel's standard deviation."""
        array = self._validate_input(data)
        channel_std = np.std(array, axis=0, keepdims=True)
        noise = self._rng.normal(loc=0.0, scale=np.maximum(channel_std * float(sigma), 1e-8), size=array.shape)
        return array + noise

    def time_shift(self, data: np.ndarray, shift_range: int = 3) -> np.ndarray:
        """Randomly shift a segment and pad exposed values with edge samples."""
        array = self._validate_input(data)
        max_shift = int(abs(shift_range))
        if max_shift == 0 or array.shape[0] == 1:
            return array.copy()

        shift = int(self._rng.integers(-max_shift, max_shift + 1))
        if shift == 0:
            return array.copy()

        shifted = np.empty_like(array)
        if shift > 0:
            shifted[:shift] = array[0]
            shifted[shift:] = array[:-shift]
        else:
            abs_shift = abs(shift)
            shifted[-abs_shift:] = array[-1]
            shifted[:-abs_shift] = array[abs_shift:]
        return shifted

    def scaling(self, data: np.ndarray, sigma: float = 0.05) -> np.ndarray:
        """Scale the whole segment by a random global factor."""
        array = self._validate_input(data)
        scale = float(self._rng.normal(loc=1.0, scale=float(sigma)))
        return array * scale

    def time_warp(self, data: np.ndarray, sampling_ratio: float = 0.95) -> np.ndarray:
        """Apply a mild temporal stretch/compression using linear interpolation."""
        array = self._validate_input(data)
        ratio = float(sampling_ratio)
        if ratio <= 0:
            raise ValueError("sampling_ratio must be positive.")
        if array.shape[0] < 2 or np.isclose(ratio, 1.0):
            return array.copy()

        num_rows = array.shape[0]
        warped_length = max(2, int(round(num_rows * ratio)))

        source_grid = np.linspace(0.0, 1.0, num_rows)
        warped_grid = np.linspace(0.0, 1.0, warped_length)
        warped = np.vstack(
            [np.interp(warped_grid, source_grid, array[:, channel_index]) for channel_index in range(array.shape[1])]
        ).T

        target_grid = np.linspace(0.0, 1.0, num_rows)
        restored = np.vstack(
            [np.interp(target_grid, warped_grid, warped[:, channel_index]) for channel_index in range(array.shape[1])]
        ).T
        return restored
