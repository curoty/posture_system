#!/usr/bin/env python3
"""Synthetic IMU data generator V2 - biomechanical templates for skating.

Improvements over V1:
  1. Biomechanically realistic per-action templates (anti-phase limbs, jump phases, etc.)
  2. Ornstein-Uhlenbeck temporally-correlated noise (replaces i.i.d. Gaussian)
  3. Class confusion: boundary-frame mixing for similar action pairs
  4. Quality modulation via amplitude scaling + time warp + dropout + OU noise

Output: sim_data_v2.npz - same schema as V1.
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

# Node index constants
HEAD = 0
L_ELBOW, R_ELBOW = 1, 2
L_WRIST, R_WRIST = 3, 4
L_KNEE, R_KNEE = 5, 6
L_FOOT, R_FOOT = 7, 8

CHANNEL_NAMES = ("ax", "ay", "az", "gx", "gy", "gz")
N_CHANNELS = len(CHANNEL_NAMES)  # 6

AX, AY, AZ = 0, 1, 2
GX, GY, GZ = 3, 4, 5
ACCEL_IDX = [0, 1, 2]
GYRO_IDX = [3, 4, 5]

ACCEL_RANGE = 8.0    # g
GYRO_RANGE = 1000.0  # deg/s

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
N_ACTIONS = len(ACTION_TYPES)

QUALITY_NAMES = {0: "Fail", 1: "Mid", 2: "Good", 3: "Excellent"}
N_QUALITIES = len(QUALITY_NAMES)

# Quality modulation parameters (V2 - OU-based)
QUALITY_PARAMS_V2 = {
    3: {"amp_scale": 1.0,  "ou_theta": 0.15, "ou_sigma": 0.008,
        "time_warp_strength": 0.0, "frame_dropout_prob": 0.0},
    2: {"amp_scale": 0.90, "ou_theta": 0.15, "ou_sigma": 0.015,
        "time_warp_strength": 0.0, "frame_dropout_prob": 0.0},
    1: {"amp_scale": 0.75, "ou_theta": 0.15, "ou_sigma": 0.025,
        "time_warp_strength": 0.08, "frame_dropout_prob": 0.0},
    0: {"amp_scale": 0.50, "ou_theta": 0.15, "ou_sigma": 0.04,
        "time_warp_strength": 0.15, "frame_dropout_prob": 0.08},
}

# Class confusion pairs: (source_action, neighbor_class_to_mix)
CONFUSION_PAIRS = {
    "arm_swing": "combination",
    "combination": "turn",
    "turn": "combination",
}
CONFUSION_PROB = 0.20
CONFUSION_BOUNDARY_FRAMES = 15
CONFUSION_MIX_WEIGHT = 0.15


# ============================================================================
# Ornstein-Uhlenbeck Process
# ============================================================================

def generate_ou_noise(
    shape: Tuple[int, ...],
    theta: float,
    sigma: float,
    dt: float = 0.02,
    rng: np.random.RandomState = None,
) -> np.ndarray:
    """Generate Ornstein-Uhlenbeck (mean-reverting) noise.

    SDE: dx = theta*(mu - x)*dt + sigma*dW
    Discretized: x[t+1] = x[t] + theta*(0 - x[t])*dt + sigma*sqrt(dt)*eps
    """
    if rng is None:
        rng = np.random.RandomState()
    n_frames = shape[0]
    flat_shape = (n_frames, int(np.prod(shape[1:])))
    noise = np.zeros(flat_shape, dtype=np.float64)
    sqrt_dt = np.sqrt(dt)
    for t in range(1, n_frames):
        dW = rng.normal(0, 1, flat_shape[1])
        noise[t] = noise[t - 1] + theta * (0.0 - noise[t - 1]) * dt + sigma * sqrt_dt * dW
    return noise.reshape(shape)


# ============================================================================
# Utility Functions
# ============================================================================

def _cosine_taper(n_frames: int, fade_in: int = 5, fade_out: int = 5) -> np.ndarray:
    """Cosine-tapered envelope for smooth signal start/end."""
    env = np.ones(n_frames, dtype=np.float64)
    if fade_in > 0:
        env[:fade_in] = 0.5 * (1.0 - np.cos(np.pi * np.arange(fade_in) / fade_in))
    if fade_out > 0:
        env[-fade_out:] = 0.5 * (1.0 + np.cos(np.pi * np.arange(fade_out) / fade_out))
    return env


def _blend_boundary(
    seq: np.ndarray,       # (n_frames, n_nodes, n_channels)
    neighbor_seq: np.ndarray,  # same shape
    boundary: str,          # "start" or "end"
    n_boundary: int,
    weight: float,
) -> np.ndarray:
    """Mix neighbor signal into seq at start or end boundary frames."""
    result = seq.copy()
    n_total = len(seq)
    if boundary == "start":
        idx = slice(0, min(n_boundary, n_total))
    else:
        idx = slice(max(0, n_total - n_boundary), n_total)
    result[idx] = (1.0 - weight) * result[idx] + weight * neighbor_seq[idx]
    return result


def _time_warp_3d(
    signal: np.ndarray, strength: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Apply smooth non-linear time warping shared across all channels."""
    if strength <= 0.0:
        return signal
    n_frames, n_nodes, n_channels = signal.shape
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


def _apply_frame_dropout(
    signal: np.ndarray, dropout_prob: float, rng: np.random.RandomState,
) -> np.ndarray:
    """Set random frames to zero."""
    if dropout_prob <= 0.0:
        return signal
    n_frames = signal.shape[0]
    for frame_i in range(n_frames):
        if rng.uniform() < dropout_prob:
            signal[frame_i, :, :] = 0.0
    return signal


# ============================================================================
# Action Template Generators
# All return (n_frames, n_nodes, n_channels) clean signals
# ============================================================================

def _gen_weight_shift(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Weight shift: smooth lateral weight transfer between legs.

    - l_foot/l_knee and r_foot/r_knee ax anti-phase, +/-0.3g
    - ~100-frame cycle period
    - gz slow drift <50 deg/s
    - az static ~1g, smooth
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    fi = np.arange(n_frames, dtype=np.float64)  # frame indices

    cycle_period = rng.uniform(90, 110)
    phase_shift = rng.uniform(0, 2 * np.pi)

    lateral = 0.30 * np.sin(2.0 * np.pi * fi / cycle_period + phase_shift)
    lateral += 0.06 * np.sin(4.0 * np.pi * fi / cycle_period + phase_shift + 0.5)
    forward = 0.10 * np.sin(2.0 * np.pi * fi / (cycle_period * 1.3) + phase_shift + 0.8)
    yaw_drift = 30.0 * np.sin(2.0 * np.pi * fi / (cycle_period * 2.5) + phase_shift + 0.3)

    env = _cosine_taper(n_frames, fade_in=8, fade_out=8)

    for ni in range(N_NODES):
        if ni in (L_FOOT, L_KNEE):
            ax_sign = -1.0
            node_amp = rng.uniform(0.9, 1.2)
        elif ni in (R_FOOT, R_KNEE):
            ax_sign = 1.0
            node_amp = rng.uniform(0.9, 1.2)
        elif ni == HEAD:
            ax_sign = 0.0
            node_amp = rng.uniform(0.02, 0.06)
        else:
            ax_sign = 0.0
            node_amp = rng.uniform(0.08, 0.18)

        na = node_amp
        sig[:, ni, AX] = (forward * na * 0.3 + lateral * ax_sign * na) * env
        sig[:, ni, AY] = lateral * ax_sign * na * 0.5 * env
        sig[:, ni, AZ] = (1.0 + 0.05 * np.sin(2.0 * np.pi * fi / cycle_period + phase_shift) * na) * env
        sig[:, ni, GX] = lateral * ax_sign * na * 60.0 * env
        sig[:, ni, GY] = forward * na * 15.0 * env
        sig[:, ni, GZ] = yaw_drift * na * env

    return sig


def _gen_side_push_recover(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Side push recover: asymmetric lateral push-off + glide + recovery.

    - Push phase (~20f): push-foot gy peak +/-300 deg/s
    - Glide phase (~40f): ankle gy decay to <30 deg/s
    - 1.5-2 alternating L/R cycles
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    push_dur = int(20 * rng.uniform(0.9, 1.1))
    glide_dur = int(40 * rng.uniform(0.9, 1.1))
    first_push = rng.choice(["left", "right"])

    gy_L = np.zeros(n_frames, dtype=np.float64)
    gy_R = np.zeros(n_frames, dtype=np.float64)

    phase_start = rng.randint(5, 15)
    current_side = first_push

    while phase_start < n_frames - push_dur:
        push_end = min(phase_start + push_dur, n_frames)
        glide_end = min(push_end + glide_dur, n_frames)
        peak = 300.0 * rng.uniform(0.85, 1.15)

        # Push pulse: skewed Gaussian
        push_t = np.arange(push_end - phase_start, dtype=np.float64)
        push_wave = peak * np.exp(-0.5 * ((push_t - push_dur * 0.3) / (push_dur * 0.18)) ** 2)

        # Glide decay
        glide_t = np.arange(glide_end - push_end, dtype=np.float64)
        glide_wave = peak * 0.12 * np.exp(-glide_t / (glide_dur / 3.0)) * rng.uniform(0.8, 1.2)

        if current_side == "left":
            gy_L[phase_start:push_end] += push_wave
            gy_L[push_end:glide_end] += glide_wave
            gy_R[phase_start:push_end] += push_wave * (-0.10)
        else:
            gy_R[phase_start:push_end] += push_wave
            gy_R[push_end:glide_end] += glide_wave
            gy_L[phase_start:push_end] += push_wave * (-0.10)

        phase_start = min(glide_end + rng.randint(5, 20), n_frames)
        current_side = "right" if current_side == "left" else "left"

    env = _cosine_taper(n_frames, fade_in=5, fade_out=8)

    for ni in range(N_NODES):
        if ni == L_FOOT:
            gy, na = gy_L, rng.uniform(0.9, 1.2)
        elif ni == R_FOOT:
            gy, na = gy_R, rng.uniform(0.9, 1.2)
        elif ni == L_KNEE:
            gy, na = gy_L * 0.7, rng.uniform(0.7, 1.0)
        elif ni == R_KNEE:
            gy, na = gy_R * 0.7, rng.uniform(0.7, 1.0)
        elif ni == HEAD:
            gy, na = (gy_L + gy_R) * 0.05, rng.uniform(0.03, 0.08)
        elif ni in (L_ELBOW, L_WRIST):
            gy, na = gy_R * rng.uniform(0.3, 0.7), rng.uniform(0.4, 0.7)
        elif ni in (R_ELBOW, R_WRIST):
            gy, na = gy_L * rng.uniform(0.3, 0.7), rng.uniform(0.4, 0.7)

        sig[:, ni, GY] = gy * na * env
        sig[:, ni, AX] = np.abs(gy) * 0.003 * ACCEL_RANGE * na * env
        sig[:, ni, AY] = gy * 0.008 * ACCEL_RANGE * na * env
        sig[:, ni, AZ] = (1.0 + 0.05 * np.abs(gy) / GYRO_RANGE * ACCEL_RANGE) * env
        sig[:, ni, GX] = gy * 0.15 * na * env
        sig[:, ni, GZ] = np.full(n_frames, rng.uniform(-10, 10)) * na * env

    return sig


def _gen_jump(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Jump: vertical launch -> flight -> landing with impact propagation.

    - Launch (0-30f): feet az +3g
    - Flight (30-80f): all az~0g, gyro<20 deg/s
    - Landing (80-128f): feet az -8 to -12g, knee -5g, elbow -2g
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    launch_end = rng.randint(28, 33)
    flight_end = rng.randint(75, 85)

    # Build vertical acceleration profile
    az_prof = np.ones(n_frames, dtype=np.float64)  # baseline 1g gravity

    # Launch: ramp up to +3g then decay
    launch_peak = int(launch_end * 0.6)
    for i in range(launch_end):
        if i <= launch_peak:
            az_prof[i] = 1.0 + 3.0 * (i / launch_peak)
        else:
            decay = launch_end - launch_peak
            if decay > 0:
                az_prof[i] = 1.0 + 3.0 * (1.0 - (i - launch_peak) / decay)

    # Flight: ~0g (freefall)
    az_prof[launch_end:flight_end] = 0.0

    # Landing impact
    impact_frame = flight_end + rng.randint(1, 4)
    impact_peak = rng.uniform(-12.0, -8.0)
    impact_w = rng.uniform(3, 5)
    for i in range(n_frames):
        rel = i - impact_frame
        if rel >= 0:
            az_prof[i] = impact_peak * np.exp(-rel / impact_w) * np.cos(rel * 0.5)

    # Late recovery
    az_prof[impact_frame + 20:] = np.clip(az_prof[impact_frame + 20:], 0.3, None)
    az_prof[-20:] += 0.7 * np.linspace(0, 1, 20)  # recover to ~1g

    # Impact attenuation per body segment
    attenuation = {
        L_FOOT: 1.0, R_FOOT: 1.0,
        L_KNEE: 0.45, R_KNEE: 0.45,
        L_ELBOW: 0.20, R_ELBOW: 0.20,
        L_WRIST: 0.25, R_WRIST: 0.25,
        HEAD: 0.10,
    }

    env = _cosine_taper(n_frames, fade_in=3, fade_out=8)

    for ni in range(N_NODES):
        atten = attenuation.get(ni, 0.3)
        # az: use attenuated impact + gravity
        sig[:, ni, AZ] = az_prof * atten + 1.0 * (1.0 - atten) * env
        # Flight: remove gravity
        sig[launch_end:flight_end, ni, AZ] = 0.0
        # ax: forward lean during launch
        sig[:, ni, AX] = np.clip(az_prof - 1.0, 0, 3) * 0.08 * atten * env
        # ay: stabilization
        sig[:, ni, AY] = rng.normal(0, 0.01, n_frames) * env
        # gx
        sig[:, ni, GX] = rng.normal(0, 3, n_frames) * env
        # gy: pitch during launch
        sig[:, ni, GY] = np.clip(az_prof - 1.0, 0, 3) * 5.0 * atten * env
        # gz
        sig[:, ni, GZ] = rng.normal(0, 2, n_frames) * env

    # Enforce low gyro during flight
    for ni in range(N_NODES):
        for ch in GYRO_IDX:
            sig[launch_end:flight_end, ni, ch] *= 0.2

    return sig


def _gen_turn(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Turn: smooth body rotation / direction change.

    - Head and knees gz: smooth arc 0->+/-200 deg/s->0 over ~80f
    - Outer foot ax ~0.4g vs inner ~0.1g (centripetal)
    - No impact, smooth and differentiable
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    turn_sign = rng.choice([-1.0, 1.0])
    turn_center = rng.randint(55, 75)
    turn_width = rng.uniform(25, 40)
    turn_amp = rng.uniform(170, 220)

    gz_prof = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        t_rel = (i - turn_center) / turn_width
        gz_prof[i] = turn_amp * np.exp(-0.5 * t_rel ** 2) * turn_sign

    # Centripetal ay proportional to omega^2
    ay_cent = (gz_prof / GYRO_RANGE) ** 2 * ACCEL_RANGE * 2.5 * turn_sign

    # Forward deceleration
    ax_decel = -np.abs(gz_prof / GYRO_RANGE) * ACCEL_RANGE * 0.6

    # Roll (lean)
    gx_prof = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        t_rel = (i - turn_center) / (turn_width * 1.3)
        gx_prof[i] = 80.0 * np.exp(-0.5 * t_rel ** 2) * (-turn_sign)

    env = _cosine_taper(n_frames, fade_in=6, fade_out=10)

    for ni in range(N_NODES):
        if ni == HEAD:
            gz_scale = rng.uniform(0.85, 1.15)
            ax_scale = rng.uniform(0.3, 0.5)
        elif ni in (L_FOOT, R_FOOT):
            gz_scale = rng.uniform(0.9, 1.1)
            is_outer = (turn_sign < 0 and ni == R_FOOT) or (turn_sign > 0 and ni == L_FOOT)
            ax_scale = rng.uniform(1.0, 1.5) if is_outer else rng.uniform(0.2, 0.4)
        elif ni in (L_KNEE, R_KNEE):
            gz_scale = rng.uniform(0.85, 1.1)
            ax_scale = rng.uniform(0.6, 0.9)
        else:
            gz_scale = rng.uniform(0.4, 0.7)
            ax_scale = rng.uniform(0.2, 0.4)

        sig[:, ni, GZ] = gz_prof * gz_scale * env
        sig[:, ni, AY] = ay_cent * gz_scale * env
        sig[:, ni, AX] = ax_decel * ax_scale * env
        sig[:, ni, AZ] = 1.0 * env
        sig[:, ni, GX] = gx_prof * gz_scale * env
        sig[:, ni, GY] = rng.normal(0, 2, n_frames) * env

    return sig


def _gen_stop(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Stop: rapid deceleration from glide to static.

    - Frames 0-40: glide (gyro 50-100 deg/s)
    - Frames 40-60: all gyro linear decay to <10 deg/s
    - Frames 60-128: static (az~1g, others <0.05g/<5 deg/s)
    - Brake impulse 40-50f: feet ax ~-1.5g
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    glide_end = rng.randint(38, 43)
    brake_peak_f = rng.randint(glide_end, glide_end + 8)
    static_start = rng.randint(58, 65)
    glide_gyro = rng.uniform(50, 100)

    # --- Glide phase ---
    for ni in range(N_NODES):
        nv = rng.uniform(0.7, 1.3)
        sig[:glide_end, ni, GX] = rng.normal(0, glide_gyro * 0.15, glide_end) * nv
        sig[:glide_end, ni, GY] = rng.normal(0, glide_gyro * 0.10, glide_end) * nv
        sig[:glide_end, ni, GZ] = rng.normal(0, glide_gyro * 0.40, glide_end) * nv
        sig[:glide_end, ni, AX] = rng.normal(0.05, 0.03, glide_end) * nv
        sig[:glide_end, ni, AY] = rng.normal(0, 0.02, glide_end) * nv
        sig[:glide_end, ni, AZ] = 1.0 + rng.normal(0, 0.02, glide_end) * nv

    # --- Brake axle deceleration ---
    brake_ax = np.zeros(n_frames, dtype=np.float64)
    brake_gy = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        t_rel = i - brake_peak_f
        brake_ax[i] = -1.5 * np.exp(-0.5 * (t_rel / 3.0) ** 2)
        brake_gy[i] = 80.0 * np.exp(-0.5 * (t_rel / 5.0) ** 2)

    # --- Linear gyro decay from glide to static ---
    decay = np.ones(n_frames, dtype=np.float64)
    dec_range = max(static_start - glide_end, 1)
    for i in range(glide_end, static_start):
        decay[i] = 1.0 - (i - glide_end) / dec_range

    for ni in range(N_NODES):
        if ni in (L_FOOT, R_FOOT):
            br_scale = rng.uniform(0.8, 1.3)
            gy_scale = rng.uniform(0.8, 1.2)
        elif ni in (L_KNEE, R_KNEE):
            br_scale = rng.uniform(0.6, 1.0)
            gy_scale = rng.uniform(0.7, 1.0)
        elif ni == HEAD:
            br_scale = rng.uniform(0.2, 0.4)
            gy_scale = rng.uniform(0.3, 0.6)
        else:
            br_scale = rng.uniform(0.3, 0.5)
            gy_scale = rng.uniform(0.4, 0.7)

        sig[:, ni, AX] += brake_ax * br_scale
        sig[:, ni, GY] += brake_gy * gy_scale
        sig[:, ni, GX] *= decay
        sig[:, ni, GY] *= decay
        sig[:, ni, GZ] *= decay
        sig[:, ni, AZ] = 1.0 + brake_ax * 0.15 * br_scale

    # --- Static phase: near-zero (OU noise added by quality modulation) ---
    for ni in range(N_NODES):
        n_static = n_frames - static_start
        sig[static_start:, ni, AX] = 0.0
        sig[static_start:, ni, AY] = 0.0
        sig[static_start:, ni, AZ] = 1.0  # gravity only
        sig[static_start:, ni, GX] = 0.0
        sig[static_start:, ni, GY] = 0.0
        sig[static_start:, ni, GZ] = 0.0

    return sig


def _gen_arm_swing(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Arm swing: rhythmic alternating arm movement during glide.

    - L/R elbow gy anti-phase sine ~1.5Hz (19f period), +/-150 deg/s
    - L/R wrist follows elbow with ~5f phase lag, +/-100 deg/s
    - Lower body stable glide, gyro <40 deg/s, uncorrelated with arms
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    freq = rng.uniform(2.4, 2.9)  # Hz (~19 frame period at 50Hz)
    period_frames = 50.0 / freq   # frames per period
    elbow_amp = rng.uniform(130, 170)
    wrist_amp = rng.uniform(80, 120)
    phase_offset = rng.uniform(0, 2 * np.pi)

    # Elbow gy: anti-phase sine (use frame index, not time, for correct frequency)
    frame_idx = np.arange(n_frames, dtype=np.float64)
    left_elb_gy = elbow_amp * np.sin(2.0 * np.pi * frame_idx / period_frames + phase_offset)
    right_elb_gy = elbow_amp * np.sin(2.0 * np.pi * frame_idx / period_frames + phase_offset + np.pi)

    # Wrist: same frequency, lagged by 5 frames
    wrist_lag = 5
    left_wr_gy = np.zeros(n_frames, dtype=np.float64)
    right_wr_gy = np.zeros(n_frames, dtype=np.float64)
    ratio = wrist_amp / elbow_amp if elbow_amp > 0 else 0
    for i in range(n_frames):
        src = max(0, i - wrist_lag)
        left_wr_gy[i] = ratio * left_elb_gy[src]
        right_wr_gy[i] = ratio * right_elb_gy[src]

    env = _cosine_taper(n_frames, fade_in=5, fade_out=5)

    for ni in range(N_NODES):
        if ni == L_ELBOW:
            gy_sig, na = left_elb_gy, rng.uniform(0.9, 1.1)
        elif ni == R_ELBOW:
            gy_sig, na = right_elb_gy, rng.uniform(0.9, 1.1)
        elif ni == L_WRIST:
            gy_sig, na = left_wr_gy, rng.uniform(0.9, 1.1)
        elif ni == R_WRIST:
            gy_sig, na = right_wr_gy, rng.uniform(0.9, 1.1)
        elif ni in (L_FOOT, R_FOOT, L_KNEE, R_KNEE):
            gy_sig = rng.normal(0, 15, n_frames)  # stable glide <40 deg/s
            na = rng.uniform(0.5, 0.9)
        else:  # HEAD
            gy_sig = rng.normal(0, 5, n_frames)
            na = rng.uniform(0.3, 0.6)

        sig[:, ni, GY] = gy_sig * na * env
        sig[:, ni, AX] = gy_sig * 0.003 * ACCEL_RANGE * env
        sig[:, ni, AY] = gy_sig * 0.002 * ACCEL_RANGE * env
        sig[:, ni, AZ] = 1.0 * env + rng.normal(0, 0.01, n_frames) * env
        sig[:, ni, GX] = rng.normal(0, 8, n_frames) * env
        sig[:, ni, GZ] = gy_sig * 0.15 * env

    return sig


def _gen_combination(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """Combination: multi-phase compound action.

    Phase 1 (0-42f): arm_swing (upper body alternating)
    Phase 2 (43-85f): turn (whole-body yaw, gz +/-150 deg/s)
    Phase 3 (86-128f): side_push_recover (single-side push, ankle +/-200 deg/s)
    5-frame linear crossfade between phases.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    p1_end = rng.randint(40, 45)
    p2_end = rng.randint(83, 88)
    fade = 5

    # Generate full sub-signals
    p1 = _gen_arm_swing(t, rng)
    p2 = _gen_turn(t, rng)
    p3 = _gen_side_push_recover(t, rng)

    # Scale down for combination context
    p2[:, :, GZ] *= 0.75
    p3[:, :, GY] *= 0.67

    # Compose with crossfades
    for i in range(n_frames):
        if i < p1_end - fade:
            w1, w2, w3 = 1.0, 0.0, 0.0
        elif i < p1_end:
            w = (i - (p1_end - fade)) / fade
            w1, w2, w3 = 1.0 - w, w, 0.0
        elif i < p2_end - fade:
            w1, w2, w3 = 0.0, 1.0, 0.0
        elif i < p2_end:
            w = (i - (p2_end - fade)) / fade
            w1, w2, w3 = 0.0, 1.0 - w, w
        else:
            w1, w2, w3 = 0.0, 0.0, 1.0

        sig[i] = w1 * p1[i] + w2 * p2[i] + w3 * p3[i]

    return sig


# Generator registry
ACTION_GENERATORS_V2 = {
    "weight_shift": _gen_weight_shift,
    "side_push_recover": _gen_side_push_recover,
    "jump": _gen_jump,
    "turn": _gen_turn,
    "stop": _gen_stop,
    "arm_swing": _gen_arm_swing,
    "combination": _gen_combination,
}


# ============================================================================
# Quality Modulation
# ============================================================================

def apply_quality_modulation(
    clean_signal: np.ndarray,  # (n_frames, n_nodes, n_channels)
    quality: int,
    rng: np.random.RandomState,
) -> np.ndarray:
    """Apply quality-level degradation to clean template."""
    qp = QUALITY_PARAMS_V2[quality]
    n_frames, n_nodes, n_channels = clean_signal.shape
    sig = clean_signal.copy().astype(np.float64)

    # 1. Amplitude scaling
    if qp["amp_scale"] < 1.0:
        sig *= qp["amp_scale"]

    # 2. Time warping
    if qp["time_warp_strength"] > 0.0:
        sig = _time_warp_3d(sig, qp["time_warp_strength"], rng)

    # 3. Frame dropout
    if qp["frame_dropout_prob"] > 0.0:
        sig = _apply_frame_dropout(sig, qp["frame_dropout_prob"], rng)

    # 4. OU noise
    ou = generate_ou_noise(
        (n_frames, n_nodes, n_channels),
        theta=qp["ou_theta"], sigma=qp["ou_sigma"], dt=0.02, rng=rng,
    )
    for ch in ACCEL_IDX:
        sig[:, :, ch] += ou[:, :, ch] * ACCEL_RANGE
    for ch in GYRO_IDX:
        sig[:, :, ch] += ou[:, :, ch] * GYRO_RANGE

    return sig


# ============================================================================
# Main Generation
# ============================================================================

def generate_single_sequence_v2(
    action_idx: int,
    quality: int,
    rng: np.random.RandomState,
    neighbor_action_idx: Optional[int] = None,
) -> np.ndarray:
    """Generate one synthetic IMU sequence with V2 pipeline.

    Returns float32 array of shape (180, 54).
    """
    action_name = ACTION_TYPES[action_idx]
    t_seconds = np.linspace(0.0, SEQ_LENGTH / 50.0, SEQ_LENGTH, dtype=np.float64)

    # Generate clean biomechanical template (n_frames, n_nodes, n_channels)
    generator = ACTION_GENERATORS_V2[action_name]
    clean = generator(t_seconds, rng)

    # Apply quality modulation
    sig = apply_quality_modulation(clean, quality, rng)

    # Class confusion: mix neighbor signal at boundaries
    if neighbor_action_idx is not None and rng.uniform() < CONFUSION_PROB:
        neighbor_name = ACTION_TYPES[neighbor_action_idx]
        neighbor_gen = ACTION_GENERATORS_V2[neighbor_name]
        neighbor_clean = neighbor_gen(t_seconds, rng)
        neighbor_sig = apply_quality_modulation(neighbor_clean, quality, rng)

        boundary = rng.choice(["start", "end"])
        sig = _blend_boundary(
            sig, neighbor_sig,
            boundary=boundary,
            n_boundary=CONFUSION_BOUNDARY_FRAMES,
            weight=CONFUSION_MIX_WEIGHT,
        )

    # Flatten to (180, 54)
    return sig.reshape(SEQ_LENGTH, FEATURE_DIM).astype(np.float32)


def generate_dataset_v2(
    samples_per: int = 500,
    seed: int = DEFAULT_SEED,
    verbose: bool = True,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generate the full V2 synthetic dataset.

    Returns:
        sequences: (N_total, 180, 54) float32
        action_labels: (N_total,) uint8
        quality_labels: (N_total,) uint8
    """
    n_total = N_ACTIONS * N_QUALITIES * samples_per
    sequences = np.empty((n_total, SEQ_LENGTH, FEATURE_DIM), dtype=np.float32)
    action_labels = np.empty(n_total, dtype=np.uint8)
    quality_labels = np.empty(n_total, dtype=np.uint8)

    master_rng = np.random.RandomState(seed)
    action_name_to_idx = {name: i for i, name in enumerate(ACTION_TYPES)}

    idx = 0
    for action_idx in range(N_ACTIONS):
        for quality in range(N_QUALITIES):
            combo_seed = master_rng.randint(0, 2**31 - 1)
            combo_rng = np.random.RandomState(combo_seed)

            action_name = ACTION_TYPES[action_idx]
            quality_name = QUALITY_NAMES[quality]

            # Determine neighbor for class confusion
            neighbor_idx = None
            if action_name in CONFUSION_PAIRS:
                neighbor_idx = action_name_to_idx[CONFUSION_PAIRS[action_name]]

            if verbose:
                neighbor_str = f" neighbor={CONFUSION_PAIRS.get(action_name, '-')}"
                print(
                    f"  Generating {action_name:20s} | {quality_name:9s} "
                    f"({samples_per} samples){neighbor_str}...",
                    end=" ", flush=True,
                )

            for sample_i in range(samples_per):
                seq = generate_single_sequence_v2(
                    action_idx=action_idx,
                    quality=quality,
                    rng=combo_rng,
                    neighbor_action_idx=neighbor_idx,
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


# ============================================================================
# Validation Statistics
# ============================================================================

def _flat_ch(node_name: str, ch_name: str) -> int:
    return NODE_NAMES.index(node_name) * N_CHANNELS + CHANNEL_NAMES.index(ch_name)


def print_validation_stats(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
) -> None:
    """Print validation statistics for biomechanical realism checks."""
    print("\n" + "=" * 60)
    print("VALIDATION STATISTICS")
    print("=" * 60)

    # 1. Jump: left_foot az peak > 6g (check Excellent + Good)
    jump_mask = (action_labels == ACTION_TYPES.index("jump")) & (quality_labels >= 2)
    jump_seqs = sequences[jump_mask]
    lf_az = jump_seqs[:, :, _flat_ch("l_foot", "az")]
    peaks = np.max(np.abs(lf_az), axis=1)
    print(f"\n[Jump] left_foot az peak magnitude:")
    print(f"  Mean: {np.mean(peaks):.2f}g  Min: {np.min(peaks):.2f}g  Max: {np.max(peaks):.2f}g")
    print(f"  >6g:  {np.mean(peaks > 6.0) * 100:.1f}%")

    # 2. Stop: RMS of last 60 frames (Excellent quality only, accel non-az)
    stop_mask = (action_labels == ACTION_TYPES.index("stop")) & (quality_labels == 3)
    stop_seqs = sequences[stop_mask]
    acc_non_az = [i for i in range(FEATURE_DIM) if i % N_CHANNELS in (AX, AY)]
    stop_tail = stop_seqs[:, -60:, :][:, :, acc_non_az]
    rms_acc = np.sqrt(np.mean(stop_tail ** 2, axis=(1, 2)))
    print(f"\n[Stop] RMS of last 60 frames (Excellent, non-az accel):")
    print(f"  Mean: {np.mean(rms_acc):.4f}g  Max: {np.max(rms_acc):.4f}g")
    print(f"  <0.1g: {np.mean(rms_acc < 0.1) * 100:.1f}%")
    # Gyro channels separately (deg/s)
    gyro_cols = [i for i in range(FEATURE_DIM) if i % N_CHANNELS in GYRO_IDX]
    stop_tail_gyro = stop_seqs[:, -60:, :][:, :, gyro_cols]
    rms_gyro = np.sqrt(np.mean(stop_tail_gyro ** 2, axis=(1, 2)))
    print(f"  Gyro RMS: Mean={np.mean(rms_gyro):.2f} deg/s  Max={np.max(rms_gyro):.2f} deg/s")

    # 3. arm_swing: autocorrelation of left_elbow gy at lag=19
    as_mask = action_labels == ACTION_TYPES.index("arm_swing")
    as_seqs = sequences[as_mask]
    le_gy = as_seqs[:, :, _flat_ch("l_elbow", "gy")]

    def ac_at_lag(sig, lag):
        s = sig - np.mean(sig)
        d = np.sum(s ** 2)
        return np.sum(s[lag:] * s[:-lag]) / d if d > 1e-10 else 0.0

    ac19 = [ac_at_lag(le_gy[i], 19) for i in range(len(le_gy))]
    ac17 = [ac_at_lag(le_gy[i], 17) for i in range(min(100, len(le_gy)))]
    ac21 = [ac_at_lag(le_gy[i], 21) for i in range(min(100, len(le_gy)))]
    print(f"\n[Arm Swing] left_elbow gy autocorrelation:")
    print(f"  Lag=17: {np.mean(ac17):.4f}  Lag=19: {np.mean(ac19):.4f}  Lag=21: {np.mean(ac21):.4f}")
    print(f"  Peak at lag=19: {np.mean(ac19) > np.mean(ac17) and np.mean(ac19) > np.mean(ac21)}")

    # 4. Combination intra-class variance vs others
    print(f"\n[Combination] Intra-class variance:")
    for act_name in ACTION_TYPES:
        act_mask = action_labels == ACTION_TYPES.index(act_name)
        act_data = sequences[act_mask]
        sv = np.mean(np.var(act_data, axis=(1, 2)))
        print(f"  {act_name:20s}: mean sample var = {sv:.4f}")

    combo_var = np.mean(np.var(sequences[action_labels == ACTION_TYPES.index("combination")], axis=(1, 2)))
    single_mask = np.isin(action_labels, [ACTION_TYPES.index(n) for n in ACTION_TYPES if n != "combination"])
    avg_single = np.mean(np.var(sequences[single_mask], axis=(1, 2)))
    print(f"  Combination > avg single: {combo_var > avg_single}")

    # 5. Key channel stats per action
    print(f"\n[Per-Action Key Channel Statistics]:")
    checks = [
        ("jump", "l_foot", "az"),
        ("stop", "l_foot", "ax"),
        ("arm_swing", "l_elbow", "gy"),
        ("turn", "head", "gz"),
        ("combination", "l_foot", "gy"),
    ]
    for act_name, node, ch in checks:
        act_idx = ACTION_TYPES.index(act_name)
        ch_data = sequences[action_labels == act_idx][:, :, _flat_ch(node, ch)].ravel()
        print(f"  {act_name:20s} {node:12s} {ch}: "
              f"mean={np.mean(ch_data):8.4f} std={np.std(ch_data):8.4f} "
              f"min={np.min(ch_data):8.4f} max={np.max(ch_data):8.4f}")


def print_summary_v2(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
) -> None:
    """Print dataset summary."""
    print("\n" + "=" * 60)
    print("DATASET SUMMARY (V2)")
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

    print("Signal statistics (global):")
    for ci, ch_name in enumerate(CHANNEL_NAMES):
        ch_data = sequences[:, :, ci::N_CHANNELS]
        print(f"  {ch_name}: "
              f"mean={np.mean(ch_data):8.4f} std={np.std(ch_data):8.4f} "
              f"min={np.min(ch_data):8.4f} max={np.max(ch_data):8.4f}")

    print()
    print("Per-action channel means (ax, ay, az, gx, gy, gz):")
    for i, name in enumerate(ACTION_TYPES):
        mask = action_labels == i
        action_data = sequences[mask]
        flat = action_data.reshape(-1, 54)
        ch_means = np.mean(flat, axis=0)
        means_str = ", ".join(
            f"{np.mean(ch_means[ci::6]):8.4f}" for ci in range(N_CHANNELS)
        )
        print(f"  {name:20s}: [{means_str}]")


# ============================================================================
# Save
# ============================================================================

def save_dataset_v2(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
    output_path: Path,
) -> None:
    """Save dataset as compressed .npz file."""
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


# ============================================================================
# CLI
# ============================================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate V2 synthetic skating IMU data (biomechanical templates).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python tools/generate_dataset_v2.py
  python tools/generate_dataset_v2.py --output sim_data_v2.npz --seed 123
  python tools/generate_dataset_v2.py --samples-per 100
        """,
    )
    parser.add_argument("--output", default="sim_data_v2.npz", help="Output .npz path.")
    parser.add_argument("--samples-per", type=int, default=500, help="Samples per (action, quality).")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Random seed.")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    output_path = Path(args.output)
    n_total = N_ACTIONS * N_QUALITIES * args.samples_per

    print("=" * 60)
    print("Synthetic Skating IMU Data Generator V2")
    print("(Biomechanical Templates + OU Noise)")
    print("=" * 60)
    print(f"Actions:    {N_ACTIONS} ({', '.join(ACTION_TYPES)})")
    print(f"Qualities:  {N_QUALITIES} ({', '.join(QUALITY_NAMES.values())})")
    print(f"Samples per (action, quality): {args.samples_per}")
    print(f"Total sequences: {n_total}")
    print(f"Sequence shape: ({SEQ_LENGTH}, {FEATURE_DIM})")
    print(f"OU noise: theta=0.15, sigma varies by quality")
    print(f"Class confusion: prob={CONFUSION_PROB}, boundary={CONFUSION_BOUNDARY_FRAMES}f")
    print(f"Random seed: {args.seed}")
    print(f"Output:      {output_path.resolve()}")
    print()

    sequences, action_labels, quality_labels = generate_dataset_v2(
        samples_per=args.samples_per,
        seed=args.seed,
        verbose=not args.quiet,
    )

    save_dataset_v2(sequences, action_labels, quality_labels, output_path)
    print_summary_v2(sequences, action_labels, quality_labels)
    print_validation_stats(sequences, action_labels, quality_labels)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
