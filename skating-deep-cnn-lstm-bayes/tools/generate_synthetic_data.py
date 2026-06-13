#!/usr/bin/env python3
"""Synthetic IMU data generator for roller skating action recognition.

Generates 14,000 sequences across 7 action types x 4 quality levels x 500 samples.
Each sequence: 180 frames x 54 features (9 nodes x 6 IMU channels).

Action types:
  weight_shift       - Lateral weight transfer between legs
  side_push_recover  - Asymmetric lateral push-off and recovery
  jump               - Vertical launch, flight, and landing
  turn               - Body rotation / direction change
  stop               - Rapid deceleration / braking
  arm_swing          - Rhythmic arm swinging exercise
  combination        - Mixed / complex multi-phase movement

Quality levels (0-3): Fail, Mid, Good, Excellent
  Higher quality = cleaner signal, less noise, fewer sensor dropouts.

Output: sim_data.npz containing:
  sequences      (14000, 180, 54) float32
  action_labels  (14000,)         uint8  [0..6]
  quality_labels (14000,)         uint8  [0..3]
  action_names   (7,)             <U32 strings
  quality_names  (4,)             <U32 strings
  node_names     (9,)             <U32 strings
  channel_names  (6,)             <U32 strings

Usage:
  python tools/generate_synthetic_data.py
  python tools/generate_synthetic_data.py --output sim_data.npz --seed 42
  python tools/generate_synthetic_data.py --samples-per 500 --no-time-warp --no-dropout
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# ============================================================================
# Constants
# ============================================================================

NODE_NAMES = (
    "head",
    "l_elbow", "r_elbow",
    "l_wrist", "r_wrist",
    "l_knee", "r_knee",
    "l_foot", "r_foot",
)
N_NODES = len(NODE_NAMES)  # 9

CHANNEL_NAMES = ("ax", "ay", "az", "gx", "gy", "gz")
N_CHANNELS = len(CHANNEL_NAMES)  # 6

# Channel indices
ACCEL_IDX = [0, 1, 2]  # ax, ay, az  - linear acceleration
GYRO_IDX  = [3, 4, 5]  # gx, gy, gz  - angular velocity

# Realistic consumer-grade MEMS IMU value ranges
ACCEL_RANGE = 2.0    # g  (typical ±2g accelerometer)
GYRO_RANGE  = 500.0  # deg/s (typical ±500 dps gyroscope)

SEQ_LENGTH = 180
FEATURE_DIM = N_NODES * N_CHANNELS  # 54
DEFAULT_SEED = 42

ACTION_TYPES = (
    "weight_shift",
    "side_push_recover",
    "jump",
    "turn",
    "stop",
    "arm_swing",
    "combination",
)
N_ACTIONS = len(ACTION_TYPES)  # 7

QUALITY_NAMES = {0: "Fail", 1: "Mid", 2: "Good", 3: "Excellent"}
N_QUALITIES = len(QUALITY_NAMES)  # 4

# ============================================================================
# Quality degradation parameters
# ============================================================================

def _quality_params(quality: int) -> Dict[str, float]:
    """Return degradation parameters for a given quality level.

    Higher quality → lower noise, less warping, fewer dropouts.
    """
    levels = {
        0: {  # Fail
            "noise_std":            0.30,
            "amp_variation":        0.25,
            "phase_jitter":         0.20,
            "time_warp_strength":   0.15,
            "node_dropout_prob":    0.08,
            "frame_dropout_prob":   0.02,
            "baseline_drift":       0.15,
            "harmonic_distortion":  0.20,
            "spike_prob":           0.12,
        },
        1: {  # Mid
            "noise_std":            0.12,
            "amp_variation":        0.10,
            "phase_jitter":         0.08,
            "time_warp_strength":   0.06,
            "node_dropout_prob":    0.03,
            "frame_dropout_prob":   0.01,
            "baseline_drift":       0.06,
            "harmonic_distortion":  0.08,
            "spike_prob":           0.04,
        },
        2: {  # Good
            "noise_std":            0.04,
            "amp_variation":        0.04,
            "phase_jitter":         0.03,
            "time_warp_strength":   0.02,
            "node_dropout_prob":    0.01,
            "frame_dropout_prob":   0.00,
            "baseline_drift":       0.02,
            "harmonic_distortion":  0.03,
            "spike_prob":           0.01,
        },
        3: {  # Excellent
            "noise_std":            0.010,
            "amp_variation":        0.010,
            "phase_jitter":         0.008,
            "time_warp_strength":   0.005,
            "node_dropout_prob":    0.000,
            "frame_dropout_prob":   0.000,
            "baseline_drift":       0.008,
            "harmonic_distortion":  0.010,
            "spike_prob":           0.000,
        },
    }
    if quality not in levels:
        raise ValueError(f"Quality must be 0-3, got {quality}")
    return levels[quality]


# ============================================================================
# Waveform generators
# ============================================================================

def _harmonic_signal(
    t: np.ndarray,
    freqs: List[float],
    amps: List[float],
    phases: List[float],
    rng: np.random.RandomState,
    jitter: float = 0.0,
) -> np.ndarray:
    """Sum of sinusoidal components with optional phase/frequency jitter."""
    signal = np.zeros_like(t, dtype=np.float64)
    for f, a, p in zip(freqs, amps, phases):
        fj = f * (1.0 + rng.uniform(-jitter, jitter))
        pj = p + rng.uniform(-jitter * np.pi, jitter * np.pi)
        signal += a * np.sin(2.0 * np.pi * fj * t + pj)
    return signal


def _triangle_wave(t: np.ndarray, freq: float, amp: float, phase: float) -> np.ndarray:
    """Triangle wave: (2/pi) * arcsin(sin(...))."""
    return amp * (2.0 / np.pi) * np.arcsin(np.sin(2.0 * np.pi * freq * t + phase))


def _gaussian_pulse(t: np.ndarray, center: float, width: float, amp: float) -> np.ndarray:
    """Gaussian impulse centered at `center` with given width and amplitude."""
    return amp * np.exp(-0.5 * ((t - center) / max(width, 1e-6)) ** 2)


def _adsr_envelope(
    t: np.ndarray,
    attack: float,
    decay: float,
    sustain_level: float,
    release: float,
) -> np.ndarray:
    """ADSR envelope over normalized time t ∈ [0, 1]."""
    env = np.zeros_like(t, dtype=np.float64)
    total = attack + decay + release
    sustain_start = attack
    sustain_end = 1.0 - release
    if total > 1.0:
        # Scale down proportionally
        scale = 1.0 / total
        attack *= scale
        decay *= scale
        release *= scale
        sustain_start = attack
        sustain_end = 1.0 - release

    # Attack: 0 → 1
    mask_a = (t >= 0) & (t < sustain_start)
    if np.any(mask_a):
        env[mask_a] = t[mask_a] / max(sustain_start, 1e-6)
    # Decay: 1 → sustain_level
    mask_d = (t >= sustain_start) & (t < sustain_start + decay)
    if np.any(mask_d):
        progress = (t[mask_d] - sustain_start) / max(decay, 1e-6)
        env[mask_d] = 1.0 - (1.0 - sustain_level) * progress
    # Sustain
    mask_s = (t >= sustain_start + decay) & (t < sustain_end)
    env[mask_s] = sustain_level
    # Release: sustain_level → 0
    mask_r = t >= sustain_end
    if np.any(mask_r) and release > 0:
        progress = (t[mask_r] - sustain_end) / max(release, 1e-6)
        env[mask_r] = sustain_level * (1.0 - np.clip(progress, 0.0, 1.0))
    return env


def _smooth_random_walk(
    n: int, n_control: int, amplitude: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Smooth random walk via cubic interpolation of control points."""
    control = rng.uniform(-amplitude, amplitude, n_control)
    control = np.cumsum(control)
    control -= np.mean(control)
    x_old = np.linspace(0, 1, n_control)
    x_new = np.linspace(0, 1, n)
    return np.interp(x_new, x_old, control).astype(np.float64)


def _time_warp(
    signal: np.ndarray, strength: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Apply smooth non-linear time warping to a 1D signal.

    Generates a smooth monotonic warping function w(t) and returns
    signal(w(t)), effectively stretching and compressing the signal
    along the time axis while preserving overall length.

    Args:
        signal: 1D array of length seq_length.
        strength: 0 = no warping, higher = more distortion.
        rng: RandomState for reproducibility.

    Returns:
        Warped signal of same length.
    """
    n = len(signal)
    if strength <= 0.0 or n < 4:
        return signal

    t_original = np.linspace(0.0, 1.0, n, dtype=np.float64)

    # Sparse control points define the warping field
    n_control = max(3, int(n * 0.06))
    control_t = np.linspace(0.0, 1.0, n_control, dtype=np.float64)
    # Random steps → cumulative sum → smooth warping curve
    warps = rng.uniform(-strength, strength, n_control).astype(np.float64)
    warps = np.cumsum(warps)
    warps -= np.mean(warps)

    # Interpolate warping field to full resolution
    warp_full = np.interp(t_original, control_t, warps).astype(np.float64)

    # Clamp warping so time does not run backwards
    warp_full = np.clip(warp_full, -0.35, 0.35)

    # Apply warping: t_warped = w(t) maps output-time → source-time
    t_source = t_original + warp_full
    t_source = np.clip(t_source, 0.0, 1.0)

    # Enforce monotonicity (mild sort keeps ordering valid)
    t_source = np.sort(t_source)

    # Resample: evaluate signal at warped source times
    return np.interp(t_source, t_original, signal).astype(signal.dtype)


# ============================================================================
# Per-action motion pattern definitions
# ============================================================================

def _generate_weight_shift(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Weight shift: smooth lateral weight transfer, ~0.5-1 Hz.

    IMU signature:
      - Strong ay (lateral accel) on feet and knees, anti-phase left vs right
      - Moderate gx (roll) on lower body
      - Head relatively stable
      - Smooth, continuous motion
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    # Primary lateral oscillation frequency (0.6 - 1.0 Hz)
    base_freq = rng.uniform(0.6, 1.0)
    # Harmonics for realism
    freqs = [base_freq, base_freq * 2.0, base_freq * 0.5]
    amps  = [0.7, 0.15, 0.2]
    phases = [0.0, rng.uniform(0, np.pi), rng.uniform(0, np.pi)]

    jitter = qp["phase_jitter"]

    # Generate the base lateral acceleration waveform
    lateral_wave = _harmonic_signal(t, freqs, amps, phases, rng, jitter)

    # Also add a mild forward component
    fwd_freqs = [base_freq * 0.7, base_freq * 1.3]
    fwd_amps  = [0.3, 0.1]
    fwd_phases = [rng.uniform(0, np.pi) for _ in fwd_freqs]
    fwd_wave = _harmonic_signal(t, fwd_freqs, fwd_amps, fwd_phases, rng, jitter * 0.5)

    # Envelope: smooth start and end
    env = _adsr_envelope(t / t[-1] if t[-1] > 0 else t, 0.1, 0.05, 0.9, 0.15)

    # Node-specific activity
    # feet and knees: strong lateral anti-phase
    for idx, node_name in enumerate(NODE_NAMES):
        node_scale = 1.0
        lateral_sign = 1.0

        if node_name in ("l_foot", "l_knee"):
            lateral_sign = -1.0
            node_scale = rng.uniform(0.8, 1.2)
        elif node_name in ("r_foot", "r_knee"):
            lateral_sign = 1.0
            node_scale = rng.uniform(0.8, 1.2)
        elif node_name == "head":
            node_scale = rng.uniform(0.05, 0.15)  # head is very stable
        elif node_name in ("l_elbow", "r_elbow", "l_wrist", "r_wrist"):
            node_scale = rng.uniform(0.1, 0.3)  # arms mildly involved

        # ax (forward): mild
        signal[:, idx, 0] = fwd_wave * node_scale * 0.4 * ACCEL_RANGE * env
        # ay (lateral): main motion
        signal[:, idx, 1] = lateral_wave * lateral_sign * node_scale * ACCEL_RANGE * env
        # az (vertical): minimal
        signal[:, idx, 2] = _harmonic_signal(
            t, [base_freq * 0.3], [0.05], [0.0], rng, jitter,
        ) * node_scale * ACCEL_RANGE * env

        # gx (roll): moderate - correlated with lateral
        signal[:, idx, 3] = lateral_wave * lateral_sign * node_scale * 0.2 * GYRO_RANGE * env
        # gy (pitch): minimal
        signal[:, idx, 4] = fwd_wave * node_scale * 0.05 * GYRO_RANGE * env
        # gz (yaw): minimal for weight shift
        signal[:, idx, 5] = _harmonic_signal(
            t, [base_freq * 0.4], [0.03], [rng.uniform(0, np.pi)], rng, jitter,
        ) * node_scale * GYRO_RANGE * env

    return signal


def _generate_side_push_recover(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Side push recover: asymmetric lateral push-off + recovery.

    IMU signature:
      - Strong asymmetric ay on one foot (push foot)
      - Opposite arm swings during push
      - Phasic: push impulse → glide → recover
      - Sharp acceleration changes
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    # Pick which side pushes (left or right)
    push_side = rng.choice(["left", "right"])
    push_sign = -1.0 if push_side == "left" else 1.0

    jitter = qp["phase_jitter"]
    env = _adsr_envelope(t / t[-1] if t[-1] > 0 else t, 0.05, 0.03, 0.85, 0.08)

    # Push phase: sharp lateral impulse (0-30% of sequence)
    push_center = 0.18
    push_width = 0.06 + rng.uniform(-0.02, 0.02)
    push_pulse = _gaussian_pulse(t / t[-1] if t[-1] > 0 else t, push_center, push_width, 1.0)

    # Glide phase: gentle lateral signal (30-65%)
    glide_freq = rng.uniform(0.4, 0.7)
    glide_wave = _harmonic_signal(
        t, [glide_freq], [0.3], [rng.uniform(0, np.pi)], rng, jitter,
    )

    # Recover phase: reverse-direction signal (65-100%)
    recover_center = 0.80
    recover_width = 0.08 + rng.uniform(-0.02, 0.02)
    recover_pulse = _gaussian_pulse(
        t / t[-1] if t[-1] > 0 else t, recover_center, recover_width, -0.6,
    )

    composite = push_pulse + glide_wave + recover_pulse
    composite = composite / (np.max(np.abs(composite)) + 1e-8)

    # Forward component during push
    fwd_pulse = _gaussian_pulse(
        t / t[-1] if t[-1] > 0 else t, push_center, push_width * 1.5, 0.4,
    )

    for idx, node_name in enumerate(NODE_NAMES):
        node_scale = 1.0
        lateral_sign = push_sign

        if node_name == "head":
            node_scale = rng.uniform(0.05, 0.15)
            lateral_sign = 0.5 * push_sign
        elif node_name in ("l_elbow", "l_wrist"):
            node_scale = rng.uniform(0.3, 0.7)
            # Arm opposite to push direction swings more
            if push_side == "left":
                node_scale *= 1.5  # right arm swings for left push
            lateral_sign = -push_sign
        elif node_name in ("r_elbow", "r_wrist"):
            node_scale = rng.uniform(0.3, 0.7)
            if push_side == "right":
                node_scale *= 1.5  # left arm swings for right push
            lateral_sign = -push_sign
        elif node_name in ("l_foot", "l_knee"):
            node_scale = rng.uniform(0.6, 1.0)
            if push_side == "left":
                node_scale = rng.uniform(1.0, 1.5)  # push foot is more active
            lateral_sign = -1.0
        elif node_name in ("r_foot", "r_knee"):
            node_scale = rng.uniform(0.6, 1.0)
            if push_side == "right":
                node_scale = rng.uniform(1.0, 1.5)
            lateral_sign = 1.0

        signal[:, idx, 0] = fwd_pulse * node_scale * 0.6 * ACCEL_RANGE * env
        signal[:, idx, 1] = composite * lateral_sign * node_scale * ACCEL_RANGE * env
        signal[:, idx, 2] = _harmonic_signal(
            t, [rng.uniform(0.5, 0.8)], [0.08], [0.0], rng, jitter,
        ) * node_scale * ACCEL_RANGE * env
        signal[:, idx, 3] = composite * lateral_sign * node_scale * 0.25 * GYRO_RANGE * env
        signal[:, idx, 4] = fwd_pulse * node_scale * 0.1 * GYRO_RANGE * env
        signal[:, idx, 5] = _harmonic_signal(
            t, [rng.uniform(0.3, 0.6)], [0.02], [rng.uniform(0, np.pi)], rng, jitter,
        ) * node_scale * GYRO_RANGE * env

    return signal


def _generate_jump(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Jump: vertical launch → flight → landing.

    IMU signature:
      - Strong az (vertical accel) spike at launch
      - Near-zero az during flight (freefall)
      - Sharp az spike at landing (impact)
      - All body nodes participate
      - Gyro relatively low (stable in air)
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    jitter = qp["phase_jitter"]

    # Normalized time
    tn = t / t[-1] if t[-1] > 0 else t

    # One or two jumps per sequence
    n_jumps = rng.choice([1, 2])

    # Build the vertical acceleration profile
    az_profile = np.zeros(n_frames, dtype=np.float64)

    for ji in range(n_jumps):
        # Spread jumps across the sequence
        if n_jumps == 1:
            launch_center = 0.35
        elif ji == 0:
            launch_center = 0.22
        else:
            launch_center = 0.68

        launch_center += rng.uniform(-0.05, 0.05)
        flight_duration = rng.uniform(0.08, 0.18)  # flight phase in normalized time
        land_center = launch_center + flight_duration

        # Launch: strong upward acceleration
        az_profile += _gaussian_pulse(tn, launch_center, 0.03, 1.8) * ACCEL_RANGE
        # During flight: near zero (freefall, ~0g)
        # This is handled by the baseline being near 0
        # Landing: sharp impact (even stronger)
        az_profile += _gaussian_pulse(tn, land_center, 0.015, -3.0) * ACCEL_RANGE
        # Small bounce after landing
        az_profile += _gaussian_pulse(tn, land_center + 0.02, 0.02, 0.5) * ACCEL_RANGE

        # Forward component during launch (slight forward lean)
        fwd = _gaussian_pulse(tn, launch_center, 0.04, 0.4)
        # Lateral stabilisation (small)
        lat = _harmonic_signal(
            t, [rng.uniform(0.3, 0.5)], [0.08], [0.0], rng, jitter,
        )

    for idx, node_name in enumerate(NODE_NAMES):
        # All nodes experience the vertical motion
        node_scale = rng.uniform(0.7, 1.3)
        if node_name == "head":
            node_scale = rng.uniform(0.6, 0.9)
        elif node_name in ("l_foot", "r_foot"):
            node_scale = rng.uniform(1.0, 1.5)  # feet experience strongest impact

        signal[:, idx, 0] = fwd * node_scale * ACCEL_RANGE if n_jumps > 0 else np.zeros(n_frames)
        signal[:, idx, 1] = lat * node_scale * ACCEL_RANGE
        signal[:, idx, 2] = az_profile * node_scale if n_jumps > 0 else np.zeros(n_frames)

        # Gyro: some pitch change during jump
        signal[:, idx, 3] = lat * node_scale * 0.15 * GYRO_RANGE
        signal[:, idx, 4] = fwd * node_scale * 0.2 * GYRO_RANGE if n_jumps > 0 else np.zeros(n_frames)
        signal[:, idx, 5] = _harmonic_signal(
            t, [rng.uniform(0.2, 0.4)], [0.02], [rng.uniform(0, np.pi)], rng, jitter,
        ) * node_scale * GYRO_RANGE

    return signal


def _generate_turn(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Turn: body rotation / direction change.

    IMU signature:
      - Very strong gz (yaw angular velocity) - the defining feature
      - Centripetal ay (lateral acceleration toward turn center)
      - Head leads, body follows
      - May include pre-turn lean and post-turn stabilization
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    jitter = qp["phase_jitter"]

    tn = t / t[-1] if t[-1] > 0 else t

    # Turn direction
    turn_sign = rng.choice([-1.0, 1.0])  # negative = left turn, positive = right

    # Turn shape: smooth entry, sustained rotation, smooth exit
    # Use a skewed Gaussian for the yaw rate profile
    turn_center = rng.uniform(0.35, 0.55)
    turn_width = rng.uniform(0.06, 0.14)
    turn_amplitude = rng.uniform(0.6, 1.0)

    # Yaw rate (gz) - the primary turn signal
    gz_profile = _gaussian_pulse(tn, turn_center, turn_width, turn_amplitude) * GYRO_RANGE * turn_sign

    # Also add a secondary turn sometimes (S-turn)
    if rng.uniform() < 0.25:
        second_center = turn_center + rng.uniform(0.2, 0.35)
        second_width = turn_width * rng.uniform(0.7, 1.3)
        gz_profile += _gaussian_pulse(tn, second_center, second_width, turn_amplitude * 0.6) * GYRO_RANGE * (-turn_sign)

    # Centripetal acceleration (ay) - proportional to yaw rate squared
    ay_profile = (gz_profile / GYRO_RANGE) ** 2 * ACCEL_RANGE * turn_sign
    # Forward deceleration during turn
    ax_profile = -np.abs(gz_profile / GYRO_RANGE) * ACCEL_RANGE * 0.5

    # Roll (gx) - lean into the turn
    gx_profile = _gaussian_pulse(tn, turn_center, turn_width * 1.2, 0.4) * GYRO_RANGE * (-turn_sign)

    env = _adsr_envelope(tn, 0.08, 0.05, 0.9, 0.12)

    for idx, node_name in enumerate(NODE_NAMES):
        node_scale = 1.0

        if node_name == "head":
            node_scale = rng.uniform(0.8, 1.2)  # head leads the turn
        elif node_name in ("l_foot", "r_foot"):
            node_scale = rng.uniform(0.9, 1.3)  # feet provide the steering
        elif node_name in ("l_knee", "r_knee"):
            node_scale = rng.uniform(0.7, 1.1)
        elif node_name in ("l_elbow", "r_elbow", "l_wrist", "r_wrist"):
            node_scale = rng.uniform(0.3, 0.6)  # arms less involved

        signal[:, idx, 0] = ax_profile * node_scale * env
        signal[:, idx, 1] = ay_profile * node_scale * env
        signal[:, idx, 2] = _harmonic_signal(
            t, [rng.uniform(0.3, 0.6)], [0.06], [0.0], rng, jitter,
        ) * node_scale * ACCEL_RANGE * env
        signal[:, idx, 3] = gx_profile * node_scale * env
        signal[:, idx, 4] = _harmonic_signal(
            t, [rng.uniform(0.2, 0.5)], [0.03], [rng.uniform(0, np.pi)], rng, jitter,
        ) * node_scale * GYRO_RANGE * env
        signal[:, idx, 5] = gz_profile * node_scale * env

    return signal


def _generate_stop(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Stop: rapid deceleration / braking.

    IMU signature:
      - Strong negative ax (forward deceleration)
      - Body lean backward (pitch up, positive gy)
      - Feet experience the strongest deceleration
      - Sharp onset, gradual release
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    jitter = qp["phase_jitter"]

    tn = t / t[-1] if t[-1] > 0 else t

    # Braking point: sharp deceleration
    brake_center = rng.uniform(0.30, 0.50)
    brake_width = rng.uniform(0.03, 0.06)
    brake_amplitude = rng.uniform(0.7, 1.0)

    # Forward deceleration (negative ax) - the defining feature
    ax_brake = -_gaussian_pulse(tn, brake_center, brake_width, brake_amplitude) * ACCEL_RANGE

    # Pre-brake: slight forward motion (positive ax)
    ax_pre = _gaussian_pulse(tn, brake_center - brake_width * 3, brake_width * 2, 0.2) * ACCEL_RANGE

    # Post-brake: slight rebound
    ax_post = _gaussian_pulse(tn, brake_center + brake_width * 2, brake_width * 3, 0.15) * ACCEL_RANGE

    ax_profile = ax_pre + ax_brake + ax_post

    # Pitch up during braking (body leans back)
    gy_profile = _gaussian_pulse(tn, brake_center, brake_width * 1.5, 0.5) * GYRO_RANGE

    # Vertical: slight upward during brake
    az_profile = _gaussian_pulse(tn, brake_center, brake_width, 0.3) * ACCEL_RANGE

    # Slight lateral stabilization
    lat_wave = _harmonic_signal(
        t, [rng.uniform(0.2, 0.4)], [0.06], [0.0], rng, jitter,
    )

    env = _adsr_envelope(tn, 0.05, 0.02, 0.9, 0.08)

    for idx, node_name in enumerate(NODE_NAMES):
        node_scale = 1.0
        if node_name in ("l_foot", "r_foot"):
            node_scale = rng.uniform(1.0, 1.6)  # braking feet
        elif node_name in ("l_knee", "r_knee"):
            node_scale = rng.uniform(0.8, 1.2)
        elif node_name == "head":
            node_scale = rng.uniform(0.4, 0.8)  # head moves less
        elif node_name in ("l_elbow", "r_elbow", "l_wrist", "r_wrist"):
            node_scale = rng.uniform(0.3, 0.5)

        signal[:, idx, 0] = ax_profile * node_scale * env
        signal[:, idx, 1] = lat_wave * node_scale * ACCEL_RANGE * env
        signal[:, idx, 2] = az_profile * node_scale * env
        signal[:, idx, 3] = lat_wave * node_scale * 0.1 * GYRO_RANGE * env
        signal[:, idx, 4] = gy_profile * node_scale * env
        signal[:, idx, 5] = _harmonic_signal(
            t, [rng.uniform(0.2, 0.3)], [0.03], [rng.uniform(0, np.pi)], rng, jitter,
        ) * node_scale * GYRO_RANGE * env

    return signal


def _generate_arm_swing(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Arm swing: rhythmic arm exercise, body relatively stable.

    IMU signature:
      - High-frequency oscillations on elbow/wrist nodes (2-4 Hz)
      - Body/head/feet nearly stationary
      - Large amplitude on arm nodes
      - Both accelerometer and gyroscope active on arms
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    jitter = qp["phase_jitter"]

    tn = t / t[-1] if t[-1] > 0 else t

    # High frequency arm oscillation
    base_freq = rng.uniform(2.0, 3.5)
    freqs = [base_freq, base_freq * 2.0, base_freq * 0.5]
    amps  = [0.6, 0.15, 0.1]

    phases_main = [0.0, rng.uniform(0, np.pi), rng.uniform(0, np.pi)]
    arm_wave = _harmonic_signal(t, freqs, amps, phases_main, rng, jitter)

    # Arms often move in anti-phase or coupled
    phases_anti = [np.pi / 2.0, rng.uniform(0, np.pi), rng.uniform(0, np.pi)]
    arm_wave_anti = _harmonic_signal(t, freqs, amps, phases_anti, rng, jitter)

    # Low-frequency body stabilization
    body_wave = _harmonic_signal(
        t, [base_freq * 0.3], [0.12], [0.0], rng, jitter * 0.3,
    )

    env = _adsr_envelope(tn, 0.05, 0.02, 0.95, 0.05)

    for idx, node_name in enumerate(NODE_NAMES):
        if node_name in ("l_elbow", "l_wrist"):
            wave = arm_wave
            node_scale = rng.uniform(0.8, 1.3)
        elif node_name in ("r_elbow", "r_wrist"):
            wave = arm_wave_anti
            node_scale = rng.uniform(0.8, 1.3)
        elif node_name == "head":
            wave = body_wave
            node_scale = rng.uniform(0.02, 0.06)
        elif node_name in ("l_knee", "r_knee", "l_foot", "r_foot"):
            wave = body_wave
            node_scale = rng.uniform(0.03, 0.10)

        arm_intensity = 1.0 if "elbow" in node_name or "wrist" in node_name else 0.15

        signal[:, idx, 0] = wave * node_scale * ACCEL_RANGE * arm_intensity * env
        signal[:, idx, 1] = wave * node_scale * ACCEL_RANGE * arm_intensity * 0.7 * env
        signal[:, idx, 2] = wave * node_scale * ACCEL_RANGE * arm_intensity * 0.4 * env
        signal[:, idx, 3] = wave * node_scale * GYRO_RANGE * arm_intensity * 0.5 * env
        signal[:, idx, 4] = wave * node_scale * GYRO_RANGE * arm_intensity * 0.4 * env
        signal[:, idx, 5] = wave * node_scale * GYRO_RANGE * arm_intensity * 0.3 * env

    return signal


def _generate_combination(
    t: np.ndarray, rng: np.random.RandomState, qp: Dict[str, float],
) -> np.ndarray:
    """Combination: multi-phase complex movement mixing multiple action types.

    IMU signature:
      - Multiple distinct phases with different patterns
      - Various body parts activate at different times
      - Less predictable, more varied
      - Tests model's ability to handle complex sequences
    """
    n_frames = len(t)
    signal = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    jitter = qp["phase_jitter"]

    tn = t / t[-1] if t[-1] > 0 else t

    # Pick 2-3 action patterns to combine
    available_patterns = ["weight_shift", "arm_swing", "turn", "jump"]
    n_phases = rng.choice([2, 3])
    chosen = list(rng.choice(available_patterns, size=n_phases, replace=False))

    # Divide the timeline into phases
    phase_boundaries = np.linspace(0, 1, n_phases + 1)
    phase_boundaries += rng.uniform(-0.05, 0.05, n_phases + 1)
    phase_boundaries = np.clip(phase_boundaries, 0, 1)
    phase_boundaries[0] = 0.0
    phase_boundaries[-1] = 1.0

    # Crossfade between phases
    crossfade_width = 0.06

    for phase_idx, pattern_name in enumerate(chosen):
        phase_start = phase_boundaries[phase_idx]
        phase_end = phase_boundaries[phase_idx + 1]

        # Phase envelope for smooth transition
        phase_env = np.ones(n_frames, dtype=np.float64)
        # Fade in
        if phase_idx > 0:
            fade_in_start = phase_start
            fade_in_end = phase_start + crossfade_width
            for i in range(n_frames):
                if fade_in_start <= tn[i] < fade_in_end:
                    phase_env[i] = (tn[i] - fade_in_start) / crossfade_width
                elif tn[i] < fade_in_start:
                    phase_env[i] = 0.0
        # Fade out
        if phase_idx < n_phases - 1:
            fade_out_start = phase_end - crossfade_width
            fade_out_end = phase_end
            for i in range(n_frames):
                if fade_out_start <= tn[i] < fade_out_end:
                    phase_env[i] = 1.0 - (tn[i] - fade_out_start) / crossfade_width
                elif tn[i] >= fade_out_end:
                    phase_env[i] = 0.0

        # Generate pattern for this phase (scaled to phase duration)
        phase_t = (tn - phase_start) / max(phase_end - phase_start, 1e-6)
        phase_t = np.clip(phase_t, 0, 1) * (t[-1] - t[0]) + t[0]

        # Generate a smaller pattern and add it
        if pattern_name == "weight_shift":
            mini_signal = _generate_weight_shift(t, rng, qp) * 0.6
        elif pattern_name == "arm_swing":
            mini_signal = _generate_arm_swing(t, rng, qp) * 0.5
        elif pattern_name == "turn":
            mini_signal = _generate_turn(t, rng, qp) * 0.5
        elif pattern_name == "jump":
            mini_signal = _generate_jump(t, rng, qp) * 0.4

        for ci in range(N_CHANNELS):
            signal[:, :, ci] += mini_signal[:, :, ci] * phase_env[:, np.newaxis]

    # Add continuous low-level background motion
    bg_wave = _harmonic_signal(
        t, [rng.uniform(0.3, 0.6)], [0.04], [0.0], rng, jitter,
    )
    for idx in range(N_NODES):
        node_scale = rng.uniform(0.5, 1.0)
        signal[:, idx, 0] += bg_wave * node_scale * ACCEL_RANGE * 0.2
        signal[:, idx, 1] += bg_wave * node_scale * ACCEL_RANGE * 0.15

    return signal


# Map action names to generator functions
ACTION_GENERATORS = {
    "weight_shift": _generate_weight_shift,
    "side_push_recover": _generate_side_push_recover,
    "jump": _generate_jump,
    "turn": _generate_turn,
    "stop": _generate_stop,
    "arm_swing": _generate_arm_swing,
    "combination": _generate_combination,
}


# ============================================================================
# Degradation / perturbation functions
# ============================================================================

def _add_sensor_noise(
    signal: np.ndarray, noise_std: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Add Gaussian sensor noise, scaled appropriately per channel type.

    Args:
        signal: (n_frames, n_nodes, n_channels) array.
        noise_std: base noise level.
        rng: RandomState.

    Returns:
        Noisy signal of same shape.
    """
    noise = np.zeros_like(signal, dtype=np.float64)
    # Accelerometer noise (in g units)
    noise[:, :, ACCEL_IDX] = rng.normal(0, noise_std * ACCEL_RANGE, (signal.shape[0], signal.shape[1], 3))
    # Gyroscope noise (in deg/s units)
    noise[:, :, GYRO_IDX] = rng.normal(0, noise_std * GYRO_RANGE, (signal.shape[0], signal.shape[1], 3))
    return signal + noise


def _add_baseline_drift(
    signal: np.ndarray, drift_amplitude: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Add slow baseline drift (simulating IMU bias drift).

    Each channel gets an independent smooth random walk.
    """
    n_frames = signal.shape[0]
    for node_i in range(signal.shape[1]):
        for ch_i in range(signal.shape[2]):
            scale = ACCEL_RANGE if ch_i in ACCEL_IDX else GYRO_RANGE
            drift = _smooth_random_walk(
                n_frames,
                n_control=max(3, n_frames // 20),
                amplitude=drift_amplitude * scale,
                rng=rng,
            )
            signal[:, node_i, ch_i] += drift
    return signal


def _add_spikes(
    signal: np.ndarray, spike_prob: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Add random spike artifacts (simulating IMU glitches)."""
    n_frames = signal.shape[0]
    for node_i in range(signal.shape[1]):
        for ch_i in range(signal.shape[2]):
            scale = ACCEL_RANGE if ch_i in ACCEL_IDX else GYRO_RANGE
            spike_mask = rng.uniform(size=n_frames) < spike_prob
            n_spikes = int(np.sum(spike_mask))
            if n_spikes > 0:
                signal[spike_mask, node_i, ch_i] += rng.uniform(
                    -2 * scale, 2 * scale, n_spikes,
                )
    return signal


def _apply_node_dropout(
    signal: np.ndarray, dropout_prob: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Randomly drop entire nodes (set to zero) for the whole sequence.

    Simulates complete sensor failure for a node.
    """
    for node_i in range(signal.shape[1]):
        if rng.uniform() < dropout_prob:
            signal[:, node_i, :] = 0.0
    return signal


def _apply_frame_dropout(
    signal: np.ndarray, dropout_prob: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Randomly drop individual frames (set to zero).

    Simulates intermittent sensor communication loss.
    """
    n_frames = signal.shape[0]
    for frame_i in range(n_frames):
        if rng.uniform() < dropout_prob:
            signal[frame_i, :, :] = 0.0
    return signal


def _apply_time_warp_3d(
    signal: np.ndarray, strength: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Apply a single shared time warping across all node-channel pairs.

    All channels share the same warping curve because they come from the
    same time base — this is physically correct and much faster.
    """
    if strength <= 0.0:
        return signal
    n_frames, n_nodes, n_channels = signal.shape

    # Build one warping curve shared by all channels
    t_original = np.linspace(0.0, 1.0, n_frames, dtype=np.float64)
    n_control = max(3, int(n_frames * 0.06))
    control_t = np.linspace(0.0, 1.0, n_control, dtype=np.float64)
    warps = rng.uniform(-strength, strength, n_control).astype(np.float64)
    warps = np.cumsum(warps)
    warps -= np.mean(warps)
    warp_full = np.interp(t_original, control_t, warps).astype(np.float64)
    warp_full = np.clip(warp_full, -0.35, 0.35)
    t_source = np.clip(t_original + warp_full, 0.0, 1.0)
    t_source = np.sort(t_source)

    flat_in = signal.reshape(n_frames, -1)
    flat_out = np.empty_like(flat_in, dtype=np.float64)
    for ci in range(flat_in.shape[1]):
        flat_out[:, ci] = np.interp(t_source, t_original, flat_in[:, ci])
    return flat_out.reshape(n_frames, n_nodes, n_channels)


def _add_harmonic_distortion(
    signal: np.ndarray, distortion: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Add subtle non-linear distortion to simulate sensor non-linearity."""
    if distortion <= 0.0:
        return signal
    # Soft clipping / tanh distortion
    for ch_i in range(signal.shape[2]):
        scale = ACCEL_RANGE if ch_i in ACCEL_IDX else GYRO_RANGE
        normalized = signal[:, :, ch_i] / (scale + 1e-6)
        distorted = normalized + distortion * np.tanh(normalized * 3.0) * rng.uniform(0.5, 1.5)
        signal[:, :, ch_i] = distorted * scale
    return signal


# ============================================================================
# Main generation
# ============================================================================

def generate_single_sequence(
    action_idx: int,
    quality: int,
    rng: np.random.RandomState,
    apply_time_warp: bool = True,
    apply_dropout: bool = True,
) -> np.ndarray:
    """Generate one synthetic IMU sequence.

    Args:
        action_idx: 0-6 index into ACTION_TYPES.
        quality: 0-3 quality level.
        rng: numpy RandomState for reproducibility.
        apply_time_warp: whether to apply time warping.
        apply_dropout: whether to simulate node/frame dropout.

    Returns:
        float32 array of shape (180, 54), 54 = 9 nodes * 6 channels.
    """
    action_name = ACTION_TYPES[action_idx]
    qp = _quality_params(quality)

    # Time axis: normalized 0 to SEQ_LENGTH/50 seconds
    t = np.linspace(0.0, SEQ_LENGTH / 50.0, SEQ_LENGTH, dtype=np.float64)

    # Generate clean action-specific signal (n_frames, n_nodes, n_channels)
    generator = ACTION_GENERATORS[action_name]
    signal = generator(t, rng, qp)

    # Apply amplitude variation per sample
    for node_i in range(N_NODES):
        amp_factor = 1.0 + rng.uniform(-qp["amp_variation"], qp["amp_variation"])
        signal[:, node_i, :] *= amp_factor

    # Add harmonic distortion
    signal = _add_harmonic_distortion(signal, qp["harmonic_distortion"], rng)

    # Add baseline drift
    signal = _add_baseline_drift(signal, qp["baseline_drift"], rng)

    # Add sensor noise
    signal = _add_sensor_noise(signal, qp["noise_std"], rng)

    # Add spike artifacts
    signal = _add_spikes(signal, qp["spike_prob"], rng)

    # Time warping
    if apply_time_warp:
        signal = _apply_time_warp_3d(signal, qp["time_warp_strength"], rng)

    # Node/frame dropout
    if apply_dropout:
        signal = _apply_node_dropout(signal, qp["node_dropout_prob"], rng)
        signal = _apply_frame_dropout(signal, qp["frame_dropout_prob"], rng)

    # Flatten to (180, 54)
    flat = signal.reshape(SEQ_LENGTH, FEATURE_DIM).astype(np.float32)
    return flat


def generate_dataset(
    samples_per: int = 500,
    seed: int = DEFAULT_SEED,
    apply_time_warp: bool = True,
    apply_dropout: bool = True,
    verbose: bool = True,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generate the full synthetic dataset.

    Returns:
        sequences: (N_total, 180, 54) float32
        action_labels: (N_total,) uint8
        quality_labels: (N_total,) uint8
    """
    n_total = N_ACTIONS * N_QUALITIES * samples_per
    sequences = np.empty((n_total, SEQ_LENGTH, FEATURE_DIM), dtype=np.float32)
    action_labels = np.empty(n_total, dtype=np.uint8)
    quality_labels = np.empty(n_total, dtype=np.uint8)

    # Use a master seed to create independent RNGs per (action, quality) combination
    # This ensures reproducibility regardless of generation order
    master_rng = np.random.RandomState(seed)

    idx = 0
    for action_idx in range(N_ACTIONS):
        for quality in range(N_QUALITIES):
            # Each (action, quality) combo gets its own seed derived from master
            combo_seed = master_rng.randint(0, 2**31 - 1)
            combo_rng = np.random.RandomState(combo_seed)

            action_name = ACTION_TYPES[action_idx]
            quality_name = QUALITY_NAMES[quality]

            if verbose:
                print(
                    f"  Generating {action_name:20s} | {quality_name:9s} "
                    f"({samples_per} samples)...",
                    end=" ", flush=True,
                )

            for sample_i in range(samples_per):
                seq = generate_single_sequence(
                    action_idx=action_idx,
                    quality=quality,
                    rng=combo_rng,
                    apply_time_warp=apply_time_warp,
                    apply_dropout=apply_dropout,
                )
                sequences[idx] = seq
                action_labels[idx] = action_idx
                quality_labels[idx] = quality
                idx += 1

            if verbose:
                print("done")

    if verbose:
        print(f"\nTotal sequences generated: {idx}")

    return sequences, action_labels, quality_labels


def save_dataset(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
    output_path: Path,
) -> None:
    """Save dataset as compressed .npz file with metadata."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    np.savez_compressed(
        output_path,
        sequences=sequences,
        action_labels=action_labels,
        quality_labels=quality_labels,
        action_names=np.array(ACTION_TYPES, dtype=f"<U32"),
        quality_names=np.array([QUALITY_NAMES[i] for i in range(N_QUALITIES)], dtype=f"<U32"),
        node_names=np.array(NODE_NAMES, dtype=f"<U32"),
        channel_names=np.array(CHANNEL_NAMES, dtype=f"<U32"),
    )

    file_size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"\nSaved to: {output_path.resolve()}")
    print(f"File size: {file_size_mb:.1f} MB")
    print(f"sequences:      {sequences.shape} {sequences.dtype}")
    print(f"action_labels:  {action_labels.shape} {action_labels.dtype}")
    print(f"quality_labels: {quality_labels.shape} {quality_labels.dtype}")


def print_summary(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
) -> None:
    """Print a summary of the generated dataset."""
    print("\n" + "=" * 60)
    print("DATASET SUMMARY")
    print("=" * 60)
    print(f"Total sequences: {len(sequences)}")
    print(f"Sequence shape:  {sequences.shape[1:]} (frames x features)")
    print(f"Feature dim:     {sequences.shape[2]} ({N_NODES} nodes x {N_CHANNELS} channels)")
    print()

    print("Action distribution:")
    for i, name in enumerate(ACTION_TYPES):
        n_action = int(np.sum(action_labels == i))
        print(f"  {i}: {name:20s}  {n_action:5d} samples")
    print()

    print("Quality distribution:")
    for q, name in QUALITY_NAMES.items():
        n_q = int(np.sum(quality_labels == q))
        print(f"  {q}: {name:9s}  {n_q:5d} samples")
    print()

    print("Per-action per-quality counts:")
    header = "  " + "".join(f"{QUALITY_NAMES[q]:>10s}" for q in range(N_QUALITIES))
    print(header)
    for i, name in enumerate(ACTION_TYPES):
        counts = "".join(
            f"{int(np.sum((action_labels == i) & (quality_labels == q))):10d}"
            for q in range(N_QUALITIES)
        )
        print(f"  {name:20s}{counts}")
    print()

    print("Signal statistics (global):")
    for ci, ch_name in enumerate(CHANNEL_NAMES):
        ch_data = sequences[:, :, ci::N_CHANNELS]  # all nodes for this channel
        print(
            f"  {ch_name}: "
            f"mean={np.mean(ch_data):8.4f}, "
            f"std={np.std(ch_data):8.4f}, "
            f"min={np.min(ch_data):8.4f}, "
            f"max={np.max(ch_data):8.4f}"
        )

    print()
    print("Per-action channel means (ax, ay, az, gx, gy, gz):")
    for i, name in enumerate(ACTION_TYPES):
        mask = action_labels == i
        action_data = sequences[mask]  # (N, 180, 54)
        # Flatten to (N*180, 54) and take mean across samples and time
        flat = action_data.reshape(-1, 54)
        ch_means = np.mean(flat, axis=0)
        # Average across nodes for each channel
        means_str = ", ".join(
            f"{np.mean(ch_means[ci::6]):8.4f}" for ci in range(N_CHANNELS)
        )
        print(f"  {name:20s}: [{means_str}]")


# ============================================================================
# CLI
# ============================================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate synthetic roller-skating IMU data for action recognition.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python tools/generate_synthetic_data.py
  python tools/generate_synthetic_data.py --output my_data.npz --seed 123
  python tools/generate_synthetic_data.py --samples-per 100  # 2800 total (quick test)
  python tools/generate_synthetic_data.py --no-time-warp --no-dropout
        """,
    )
    parser.add_argument(
        "--output", default="sim_data.npz",
        help="Output .npz file path (default: sim_data.npz).",
    )
    parser.add_argument(
        "--samples-per", type=int, default=500,
        help="Samples per (action, quality) combination (default: 500, total 14000).",
    )
    parser.add_argument(
        "--seed", type=int, default=DEFAULT_SEED,
        help=f"Random seed for reproducibility (default: {DEFAULT_SEED}).",
    )
    parser.add_argument(
        "--no-time-warp", action="store_true",
        help="Disable time warping perturbation.",
    )
    parser.add_argument(
        "--no-dropout", action="store_true",
        help="Disable node/frame dropout simulation.",
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Suppress per-class progress output.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    output_path = Path(args.output)
    n_total = N_ACTIONS * N_QUALITIES * args.samples_per

    print("=" * 60)
    print("Synthetic Roller Skating IMU Data Generator")
    print("=" * 60)
    print(f"Actions:    {N_ACTIONS} ({', '.join(ACTION_TYPES)})")
    print(f"Qualities:  {N_QUALITIES} ({', '.join(QUALITY_NAMES.values())})")
    print(f"Samples per (action, quality): {args.samples_per}")
    print(f"Total sequences: {n_total}")
    print(f"Sequence shape: ({SEQ_LENGTH}, {FEATURE_DIM})")
    print(f"Time warp:   {not args.no_time_warp}")
    print(f"Node/frame dropout: {not args.no_dropout}")
    print(f"Random seed: {args.seed}")
    print(f"Output:      {output_path.resolve()}")
    print()

    sequences, action_labels, quality_labels = generate_dataset(
        samples_per=args.samples_per,
        seed=args.seed,
        apply_time_warp=not args.no_time_warp,
        apply_dropout=not args.no_dropout,
        verbose=not args.quiet,
    )

    save_dataset(sequences, action_labels, quality_labels, output_path)
    print_summary(sequences, action_labels, quality_labels)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
