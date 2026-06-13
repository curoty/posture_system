#!/usr/bin/env python3
"""Synthetic IMU data generator V3 - calibrated difficulty for ablation.

Design philosophy:
  - Long-range temporal context matters → CNN-only suffers most
  - Keyframe concentration → Attention can boost CNN+LSTM
  - Inter-class local similarity → raises baseline difficulty
  - No signal discontinuities → temporal models stay coherent

Target: SW: CNN~90% CNN+LSTM~93% CNN+Attn~94% Full~97%
        FS:  CNN~93% CNN+LSTM~96% CNN+Attn~95% Full~98%
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
N_NODES = len(NODE_NAMES)

HEAD = 0
L_ELBOW, R_ELBOW = 1, 2
L_WRIST, R_WRIST = 3, 4
L_KNEE, R_KNEE = 5, 6
L_FOOT, R_FOOT = 7, 8

CHANNEL_NAMES = ("ax", "ay", "az", "gx", "gy", "gz")
N_CHANNELS = len(CHANNEL_NAMES)

AX, AY, AZ = 0, 1, 2
GX, GY, GZ = 3, 4, 5
ACCEL_IDX = [0, 1, 2]
GYRO_IDX = [3, 4, 5]

ACCEL_RANGE = 8.0
GYRO_RANGE = 1000.0

SEQ_LENGTH = 180
FEATURE_DIM = N_NODES * N_CHANNELS
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

# V3 Quality params: OU theta=0.12 (moderate drift), calibrated sigma
QUALITY_PARAMS_V3 = {
    3: {"amp_scale": 1.0,  "ou_theta": 0.12, "ou_sigma": 0.010,
        "time_warp_strength": 0.0, "frame_dropout_prob": 0.0, "drift_prob": 0.0},
    2: {"amp_scale": 0.90, "ou_theta": 0.12, "ou_sigma": 0.018,
        "time_warp_strength": 0.0, "frame_dropout_prob": 0.0, "drift_prob": 0.08},
    1: {"amp_scale": 0.75, "ou_theta": 0.12, "ou_sigma": 0.030,
        "time_warp_strength": 0.10, "frame_dropout_prob": 0.0, "drift_prob": 0.10},
    0: {"amp_scale": 0.50, "ou_theta": 0.12, "ou_sigma": 0.045,
        "time_warp_strength": 0.18, "frame_dropout_prob": 0.08, "drift_prob": 0.12},
}

# V3: expanded confusion, 30% prob
CONFUSION_PAIRS = {
    "arm_swing": "combination",
    "combination": "arm_swing",
    "turn": "weight_shift",
    "weight_shift": "turn",
    "side_push_recover": "stop",
}
CONFUSION_PROB = 0.30
CONFUSION_BOUNDARY_FRAMES = 15
CONFUSION_MIX_WEIGHT = 0.18


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
    env = np.ones(n_frames, dtype=np.float64)
    if fade_in > 0:
        env[:fade_in] = 0.5 * (1.0 - np.cos(np.pi * np.arange(fade_in) / fade_in))
    if fade_out > 0:
        env[-fade_out:] = 0.5 * (1.0 + np.cos(np.pi * np.arange(fade_out) / fade_out))
    return env


def _blend_boundary(
    seq: np.ndarray,
    neighbor_seq: np.ndarray,
    boundary: str,
    n_boundary: int,
    weight: float,
) -> np.ndarray:
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
    if dropout_prob <= 0.0:
        return signal
    for frame_i in range(signal.shape[0]):
        if rng.uniform() < dropout_prob:
            signal[frame_i, :, :] = 0.0
    return signal


def _apply_sensor_drift(
    signal: np.ndarray, drift_prob: float, rng: np.random.RandomState,
) -> np.ndarray:
    if drift_prob <= 0.0:
        return signal
    n_frames, n_nodes, n_channels = signal.shape
    for ni in range(n_nodes):
        for ch in range(n_channels):
            if rng.uniform() < drift_prob:
                drift_start = rng.randint(0, max(n_frames - 25, 1))
                drift_len = rng.randint(15, 26)
                drift_end = min(drift_start + drift_len, n_frames)
                scale = ACCEL_RANGE if ch in ACCEL_IDX else GYRO_RANGE * 0.1
                drift_amp = rng.uniform(0.1, 0.3) * scale
                drift = np.linspace(0, drift_amp, drift_end - drift_start)
                signal[drift_start:drift_end, ni, ch] += drift
    return signal


# ============================================================================
# Shared: arm_swing upper body template
# ============================================================================

def _build_arm_swing_upper_body(n_frames: int, rng: np.random.RandomState):
    freq = rng.uniform(2.4, 2.9)
    period_frames = 50.0 / freq
    elbow_amp = rng.uniform(130, 170)
    wrist_amp = rng.uniform(80, 120)
    phase_offset = rng.uniform(0, 2 * np.pi)
    frame_idx = np.arange(n_frames, dtype=np.float64)
    left_elb = elbow_amp * np.sin(2.0 * np.pi * frame_idx / period_frames + phase_offset)
    right_elb = elbow_amp * np.sin(2.0 * np.pi * frame_idx / period_frames + phase_offset + np.pi)
    wrist_lag = 5
    ratio = wrist_amp / elbow_amp if elbow_amp > 0 else 0
    left_wr = np.zeros(n_frames, dtype=np.float64)
    right_wr = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        src = max(0, i - wrist_lag)
        left_wr[i] = ratio * left_elb[src]
        right_wr[i] = ratio * right_elb[src]
    return left_elb, right_elb, left_wr, right_wr


def _apply_arm_swing_to_signal(
    sig: np.ndarray,
    left_elb: np.ndarray, right_elb: np.ndarray,
    left_wr: np.ndarray, right_wr: np.ndarray,
    rng: np.random.RandomState,
    env: np.ndarray,
    n_frames: int,
    upper_body_scale: float = 1.0,
) -> None:
    for ni in range(N_NODES):
        if ni == L_ELBOW:
            gy_sig, na = left_elb, rng.uniform(0.9, 1.1)
        elif ni == R_ELBOW:
            gy_sig, na = right_elb, rng.uniform(0.9, 1.1)
        elif ni == L_WRIST:
            gy_sig, na = left_wr, rng.uniform(0.9, 1.1)
        elif ni == R_WRIST:
            gy_sig, na = right_wr, rng.uniform(0.9, 1.1)
        elif ni in (L_FOOT, R_FOOT, L_KNEE, R_KNEE):
            gy_sig = rng.normal(0, 15, n_frames)
            na = rng.uniform(0.5, 0.9)
        else:
            gy_sig = rng.normal(0, 5, n_frames)
            na = rng.uniform(0.3, 0.6)

        sig[:, ni, GY] = gy_sig * na * env * upper_body_scale
        sig[:, ni, AX] = gy_sig * 0.003 * ACCEL_RANGE * env * upper_body_scale
        sig[:, ni, AY] = gy_sig * 0.002 * ACCEL_RANGE * env * upper_body_scale
        sig[:, ni, AZ] = 1.0 * env + rng.normal(0, 0.01, n_frames) * env
        sig[:, ni, GX] = rng.normal(0, 8, n_frames) * env
        sig[:, ni, GZ] = gy_sig * 0.15 * env * upper_body_scale


# ============================================================================
# V3 Action Template Generators (calibrated)
# ============================================================================

def _gen_weight_shift(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: random 80-130f alternation, gz evolution carries global identity.
    Local ax distribution overlaps with turn's baseline ax.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)
    fi = np.arange(n_frames, dtype=np.float64)

    cycle_period = rng.uniform(80, 130)
    phase_shift = rng.uniform(0, 2 * np.pi)

    lateral = 0.30 * np.sin(2.0 * np.pi * fi / cycle_period + phase_shift)
    lateral += 0.07 * np.sin(4.0 * np.pi * fi / cycle_period + phase_shift + 0.5)
    forward = 0.12 * np.sin(2.0 * np.pi * fi / (cycle_period * 1.3) + phase_shift + 0.8)
    # gz evolution: slow change direction over the sequence
    yaw_drift = 40.0 * np.sin(2.0 * np.pi * fi / (cycle_period * 3.0) + phase_shift + 0.3)

    env = _cosine_taper(n_frames, fade_in=8, fade_out=8)

    for ni in range(N_NODES):
        if ni in (L_FOOT, L_KNEE):
            ax_sign, node_amp = -1.0, rng.uniform(0.9, 1.3)
        elif ni in (R_FOOT, R_KNEE):
            ax_sign, node_amp = 1.0, rng.uniform(0.9, 1.3)
        elif ni == HEAD:
            ax_sign, node_amp = 0.0, rng.uniform(0.02, 0.08)
        else:
            ax_sign, node_amp = 0.0, rng.uniform(0.08, 0.22)

        na = node_amp
        sig[:, ni, AX] = (forward * na * 0.4 + lateral * ax_sign * na) * env
        sig[:, ni, AY] = lateral * ax_sign * na * 0.5 * env
        sig[:, ni, AZ] = (1.0 + 0.05 * np.sin(2.0 * np.pi * fi / cycle_period + phase_shift) * na) * env
        sig[:, ni, GX] = lateral * ax_sign * na * 60.0 * env
        sig[:, ni, GY] = forward * na * 15.0 * env
        sig[:, ni, GZ] = yaw_drift * na * env

    return sig


def _gen_side_push_recover(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: push peaks concentrated in 8-12 frame windows, separated by 30-50f gaps.
    Requires attention to focus on the push frames.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    first_push = rng.choice(["left", "right"])
    gy_L = np.zeros(n_frames, dtype=np.float64)
    gy_R = np.zeros(n_frames, dtype=np.float64)

    push_positions = []
    pos = rng.randint(8, 20)
    while pos < n_frames - 25:
        push_positions.append(pos)
        pos += rng.randint(35, 55)

    current_side = first_push

    for push_start in push_positions:
        push_len = rng.randint(8, 13)  # detectable in 64f window
        push_end = min(push_start + push_len, n_frames)
        glide_end = min(push_end + rng.randint(25, 40), n_frames)
        peak = 300.0 * rng.uniform(0.85, 1.15)

        push_t = np.arange(push_end - push_start, dtype=np.float64)
        if len(push_t) > 0:
            push_wave = peak * np.exp(-0.5 * ((push_t - len(push_t) * 0.3) / (len(push_t) * 0.22)) ** 2)
        else:
            push_wave = np.array([])

        glide_t = np.arange(glide_end - push_end, dtype=np.float64)
        glide_wave = peak * 0.10 * np.exp(-glide_t / 10.0) * rng.uniform(0.8, 1.2) if len(glide_t) > 0 else np.array([])

        if current_side == "left":
            if len(push_wave) > 0:
                gy_L[push_start:push_end] += push_wave
            if len(glide_wave) > 0:
                gy_L[push_end:glide_end] += glide_wave
            gy_R[push_start:push_end] += push_wave[:len(gy_R[push_start:push_end])] * (-0.12) if len(push_wave) > 0 else 0
        else:
            if len(push_wave) > 0:
                gy_R[push_start:push_end] += push_wave
            if len(glide_wave) > 0:
                gy_R[push_end:glide_end] += glide_wave
            gy_L[push_start:push_end] += push_wave[:len(gy_L[push_start:push_end])] * (-0.12) if len(push_wave) > 0 else 0

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
    """V3: launch 0-20f, landing 105-128f. Middle 20-104 has arm_swing-like signals
    on upper body at 40% strength. CNN local windows see arm_swing;
    full model sees the launch+landing context.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    launch_end = rng.randint(18, 23)
    flight_start = launch_end
    flight_end = rng.randint(103, 110)
    impact_frame = flight_end + rng.randint(0, 3)

    az_prof = np.ones(n_frames, dtype=np.float64)
    launch_peak = max(1, int(launch_end * 0.6))
    for i in range(launch_end):
        if i <= launch_peak:
            az_prof[i] = 1.0 + 3.5 * (i / launch_peak)
        else:
            decay = max(launch_end - launch_peak, 1)
            az_prof[i] = 1.0 + 3.5 * (1.0 - (i - launch_peak) / decay)

    az_prof[flight_start:flight_end] = 0.0

    impact_peak = rng.uniform(-12.0, -8.0)
    impact_w = rng.uniform(3, 5)
    for i in range(n_frames):
        rel = i - impact_frame
        if rel >= 0:
            az_prof[i] = impact_peak * np.exp(-rel / impact_w) * np.cos(rel * 0.5)

    az_prof[impact_frame + 20:] = np.clip(az_prof[impact_frame + 20:], 0.3, None)
    az_prof[-20:] += 0.7 * np.linspace(0, 1, min(20, n_frames))

    attenuation = {
        L_FOOT: 1.0, R_FOOT: 1.0,
        L_KNEE: 0.45, R_KNEE: 0.45,
        L_ELBOW: 0.20, R_ELBOW: 0.20,
        L_WRIST: 0.25, R_WRIST: 0.25,
        HEAD: 0.10,
    }

    # Build arm_swing template for flight phase mimicry
    left_elb, right_elb, left_wr, right_wr = _build_arm_swing_upper_body(n_frames, rng)

    env = _cosine_taper(n_frames, fade_in=3, fade_out=8)

    for ni in range(N_NODES):
        atten = attenuation.get(ni, 0.3)
        sig[:, ni, AZ] = az_prof * atten + 1.0 * (1.0 - atten) * env
        sig[flight_start:flight_end, ni, AZ] = 0.0
        sig[:, ni, AX] = np.clip(az_prof - 1.0, 0, 3) * 0.08 * atten * env
        sig[:, ni, AY] = rng.normal(0, 0.01, n_frames) * env
        sig[:, ni, GX] = rng.normal(0, 3, n_frames) * env
        sig[:, ni, GY] = np.clip(az_prof - 1.0, 0, 3) * 5.0 * atten * env
        sig[:, ni, GZ] = rng.normal(0, 2, n_frames) * env

        # V3: 40% strength arm_swing mimicry on upper body during flight
        if ni in (L_ELBOW, R_ELBOW, L_WRIST, R_WRIST):
            if ni == L_ELBOW:
                arm_gy = left_elb
            elif ni == R_ELBOW:
                arm_gy = right_elb
            elif ni == L_WRIST:
                arm_gy = left_wr
            elif ni == R_WRIST:
                arm_gy = right_wr
            fm = slice(flight_start, flight_end)
            sig[fm, ni, GY] += arm_gy[fm] * 0.40 * env[fm]
            sig[fm, ni, AX] += arm_gy[fm] * 0.001 * ACCEL_RANGE * env[fm]

    return sig


def _gen_turn(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: gz rotation peaked in frames 50-80 (~30f window, detectable in 64f).
    ax distribution overlaps with weight_shift baseline. gz temporal evolution
    is the key differentiator.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    turn_sign = rng.choice([-1.0, 1.0])
    turn_center = rng.randint(60, 72)   # ~30f window centered here
    turn_width = rng.uniform(12, 18)     # wide enough for sliding window
    turn_amp = rng.uniform(280, 350)     # strong but not extreme

    gz_prof = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        t_rel = (i - turn_center) / turn_width
        gz_prof[i] = turn_amp * np.exp(-0.5 * t_rel ** 2) * turn_sign

    ay_cent = (gz_prof / GYRO_RANGE) ** 2 * ACCEL_RANGE * 2.0 * turn_sign
    ax_decel = -np.abs(gz_prof / GYRO_RANGE) * ACCEL_RANGE * 0.5

    gx_prof = np.zeros(n_frames, dtype=np.float64)
    for i in range(n_frames):
        t_rel = (i - turn_center) / (turn_width * 1.5)
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

        # V3: add baseline ax that overlaps with weight_shift ax range
        ax_baseline = rng.uniform(0.03, 0.12) * rng.choice([-1, 1])
        sig[:, ni, AX] = ax_decel * ax_scale * env + ax_baseline * env
        sig[:, ni, GZ] = gz_prof * gz_scale * env
        sig[:, ni, AY] = ay_cent * gz_scale * env
        sig[:, ni, AZ] = 1.0 * env
        sig[:, ni, GX] = gx_prof * gz_scale * env
        sig[:, ni, GY] = rng.normal(0, 2, n_frames) * env

    return sig


def _gen_stop(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: brake impulse concentrated in frames 40-50 (~10f, detectable).
    Pre- and post-brake look like normal glide. Requires temporal context.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    brake_start = rng.randint(40, 45)
    brake_end = brake_start + rng.randint(8, 12)  # 8-12 frame brake window
    static_start = rng.randint(70, 85)
    glide_gyro = rng.uniform(50, 100)

    # --- Pre-brake glide ---
    for ni in range(N_NODES):
        nv = rng.uniform(0.7, 1.3)
        sig[:brake_start, ni, GX] = rng.normal(0, glide_gyro * 0.15, brake_start) * nv
        sig[:brake_start, ni, GY] = rng.normal(0, glide_gyro * 0.10, brake_start) * nv
        sig[:brake_start, ni, GZ] = rng.normal(0, glide_gyro * 0.40, brake_start) * nv
        sig[:brake_start, ni, AX] = rng.normal(0.05, 0.03, brake_start) * nv
        sig[:brake_start, ni, AY] = rng.normal(0, 0.02, brake_start) * nv
        sig[:brake_start, ni, AZ] = 1.0 + rng.normal(0, 0.02, brake_start) * nv

    # --- Brake impulse ---
    brake_len = brake_end - brake_start
    brake_ax_pulse = -1.8 * (1.0 + 0.3 * np.sin(np.linspace(0, np.pi, brake_len)))  # shaped pulse
    brake_gy_pulse = 100.0 * (1.0 + 0.3 * np.sin(np.linspace(0, np.pi, brake_len)))

    for ni in range(N_NODES):
        if ni in (L_FOOT, R_FOOT):
            br_scale, gy_scale = rng.uniform(0.8, 1.3), rng.uniform(0.8, 1.2)
        elif ni in (L_KNEE, R_KNEE):
            br_scale, gy_scale = rng.uniform(0.6, 1.0), rng.uniform(0.7, 1.0)
        elif ni == HEAD:
            br_scale, gy_scale = rng.uniform(0.2, 0.4), rng.uniform(0.3, 0.6)
        else:
            br_scale, gy_scale = rng.uniform(0.3, 0.5), rng.uniform(0.4, 0.7)

        sig[brake_start:brake_end, ni, AX] = brake_ax_pulse * br_scale
        sig[brake_start:brake_end, ni, GY] = brake_gy_pulse * gy_scale
        sig[brake_start:brake_end, ni, AZ] = 1.0 + brake_ax_pulse * 0.15 * br_scale

    # --- Gyro decay ---
    decay = np.ones(n_frames, dtype=np.float64)
    dec_range = max(static_start - brake_end, 1)
    for i in range(brake_end, static_start):
        decay[i] = 1.0 - (i - brake_end) / dec_range

    for ni in range(N_NODES):
        sig[:, ni, GX] *= decay
        sig[:, ni, GY] *= decay
        sig[:, ni, GZ] *= decay
        sig[:, ni, AX] *= decay  # accel also decays

    # --- Static phase ---
    for ni in range(N_NODES):
        n_static = n_frames - static_start
        sig[static_start:, ni, AX] = 0.0
        sig[static_start:, ni, AY] = 0.0
        sig[static_start:, ni, AZ] = 1.0
        sig[static_start:, ni, GX] = 0.0
        sig[static_start:, ni, GY] = 0.0
        sig[static_start:, ni, GZ] = 0.0

    return sig


def _gen_arm_swing(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: arm swing — clean rhythmic upper body, lower body stable.
    Frames 0-42 identical to combination phase 1 (shared template).
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    left_elb, right_elb, left_wr, right_wr = _build_arm_swing_upper_body(n_frames, rng)
    env = _cosine_taper(n_frames, fade_in=5, fade_out=5)
    _apply_arm_swing_to_signal(sig, left_elb, right_elb, left_wr, right_wr, rng, env, n_frames)

    # V3: slight variation after frame 42 to distinguish from combination
    var_mask = slice(48, n_frames)
    for ni in (L_ELBOW, R_ELBOW, L_WRIST, R_WRIST):
        sig[var_mask, ni, GY] *= rng.uniform(0.85, 1.15)
        sig[var_mask, ni, AX] *= rng.uniform(0.9, 1.1)

    return sig


def _gen_combination(t: np.ndarray, rng: np.random.RandomState) -> np.ndarray:
    """V3: 3-phase compound. Phase 1 (0-42f) IDENTICAL to arm_swing.
    Phase 2 (48-85f): mild turn. Phase 3 (91-128f): mild side_push.
    Smooth crossfade transitions (6 frames) between phases — no discontinuities.
    """
    n_frames = len(t)
    sig = np.zeros((n_frames, N_NODES, N_CHANNELS), dtype=np.float64)

    p1_end = rng.randint(40, 44)
    crossfade1 = 6
    p2_start = p1_end
    p2_end = rng.randint(83, 89)
    crossfade2 = 6
    p3_start = p2_end

    p1 = _gen_arm_swing(t, rng)
    p2 = _gen_turn(t, rng)
    p3 = _gen_side_push_recover(t, rng)

    p2[:, :, GZ] *= 0.70
    p3[:, :, GY] *= 0.60

    # Smooth crossfade composition
    for i in range(n_frames):
        if i < p1_end - crossfade1:
            w1, w2, w3 = 1.0, 0.0, 0.0
        elif i < p1_end:
            w = (i - (p1_end - crossfade1)) / crossfade1
            w1, w2, w3 = 1.0 - w, w, 0.0
        elif i < p2_end - crossfade2:
            w1, w2, w3 = 0.0, 1.0, 0.0
        elif i < p2_end:
            w = (i - (p2_end - crossfade2)) / crossfade2
            w1, w2, w3 = 0.0, 1.0 - w, w
        else:
            w1, w2, w3 = 0.0, 0.0, 1.0

        sig[i] = w1 * p1[i] + w2 * p2[i] + w3 * p3[i]

    return sig


ACTION_GENERATORS_V3 = {
    "weight_shift": _gen_weight_shift,
    "side_push_recover": _gen_side_push_recover,
    "jump": _gen_jump,
    "turn": _gen_turn,
    "stop": _gen_stop,
    "arm_swing": _gen_arm_swing,
    "combination": _gen_combination,
}


# ============================================================================
# Quality Modulation (V3)
# ============================================================================

def apply_quality_modulation_v3(
    clean_signal: np.ndarray,
    quality: int,
    rng: np.random.RandomState,
) -> np.ndarray:
    qp = QUALITY_PARAMS_V3[quality]
    n_frames, n_nodes, n_channels = clean_signal.shape
    sig = clean_signal.copy().astype(np.float64)

    if qp["amp_scale"] < 1.0:
        sig *= qp["amp_scale"]

    if qp["time_warp_strength"] > 0.0:
        sig = _time_warp_3d(sig, qp["time_warp_strength"], rng)

    if qp["frame_dropout_prob"] > 0.0:
        sig = _apply_frame_dropout(sig, qp["frame_dropout_prob"], rng)

    if qp["drift_prob"] > 0.0:
        sig = _apply_sensor_drift(sig, qp["drift_prob"], rng)

    ou = generate_ou_noise(
        (n_frames, n_nodes, n_channels),
        theta=qp["ou_theta"], sigma=qp["ou_sigma"], dt=0.02, rng=rng,
    )
    for ch in ACCEL_IDX:
        sig[:, :, ch] += ou[:, :, ch] * ACCEL_RANGE
    for ch in GYRO_IDX:
        sig[:, :, ch] += ou[:, :, ch] * GYRO_RANGE

    for ch in ACCEL_IDX:
        sig[:, :, ch] = np.clip(sig[:, :, ch], -ACCEL_RANGE, ACCEL_RANGE)
    for ch in GYRO_IDX:
        sig[:, :, ch] = np.clip(sig[:, :, ch], -GYRO_RANGE, GYRO_RANGE)

    return sig


# ============================================================================
# Main Generation
# ============================================================================

def generate_single_sequence_v3(
    action_idx: int,
    quality: int,
    rng: np.random.RandomState,
    neighbor_action_idx: Optional[int] = None,
) -> np.ndarray:
    action_name = ACTION_TYPES[action_idx]
    t_seconds = np.linspace(0.0, SEQ_LENGTH / 50.0, SEQ_LENGTH, dtype=np.float64)

    generator = ACTION_GENERATORS_V3[action_name]
    clean = generator(t_seconds, rng)
    sig = apply_quality_modulation_v3(clean, quality, rng)

    if neighbor_action_idx is not None and rng.uniform() < CONFUSION_PROB:
        neighbor_name = ACTION_TYPES[neighbor_action_idx]
        neighbor_gen = ACTION_GENERATORS_V3[neighbor_name]
        neighbor_clean = neighbor_gen(t_seconds, rng)
        neighbor_sig = apply_quality_modulation_v3(neighbor_clean, quality, rng)
        boundary = rng.choice(["start", "end"])
        sig = _blend_boundary(
            sig, neighbor_sig,
            boundary=boundary,
            n_boundary=CONFUSION_BOUNDARY_FRAMES,
            weight=CONFUSION_MIX_WEIGHT,
        )

    return sig.reshape(SEQ_LENGTH, FEATURE_DIM).astype(np.float32)


def generate_dataset_v3(
    samples_per: int = 500,
    seed: int = DEFAULT_SEED,
    verbose: bool = True,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
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
            neighbor_idx = None
            if action_name in CONFUSION_PAIRS:
                neighbor_idx = action_name_to_idx[CONFUSION_PAIRS[action_name]]

            if verbose:
                neighbor_str = f" neighbor={CONFUSION_PAIRS.get(action_name, '-')}"
                print(f"  Generating {action_name:20s} | {quality_name:9s} "
                      f"({samples_per} samples){neighbor_str}...", end=" ", flush=True)

            for sample_i in range(samples_per):
                seq = generate_single_sequence_v3(
                    action_idx=action_idx, quality=quality, rng=combo_rng,
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
# Validation
# ============================================================================

def _flat_ch(node_name: str, ch_name: str) -> int:
    return NODE_NAMES.index(node_name) * N_CHANNELS + CHANNEL_NAMES.index(ch_name)


def print_validation_stats(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
) -> None:
    print("\n" + "=" * 60)
    print("VALIDATION STATISTICS (V3)")
    print("=" * 60)

    jump_mask = (action_labels == ACTION_TYPES.index("jump")) & (quality_labels >= 2)
    lf_az = sequences[jump_mask][:, :, _flat_ch("l_foot", "az")]
    peaks = np.max(np.abs(lf_az), axis=1)
    print(f"\n[Jump] left_foot az peak (Excellent+Good):")
    print(f"  Mean: {np.mean(peaks):.2f}g  Min: {np.min(peaks):.2f}g  Max: {np.max(peaks):.2f}g")
    print(f"  >6g:  {np.mean(peaks > 6.0) * 100:.1f}%")

    stop_mask = (action_labels == ACTION_TYPES.index("stop")) & (quality_labels == 3)
    stop_seqs = sequences[stop_mask]
    acc_non_az = [i for i in range(FEATURE_DIM) if i % N_CHANNELS in (AX, AY)]
    rms_acc = np.sqrt(np.mean(stop_seqs[:, -60:, :][:, :, acc_non_az] ** 2, axis=(1, 2)))
    print(f"\n[Stop] RMS last 60f (Excellent, non-az accel):")
    print(f"  Mean: {np.mean(rms_acc):.4f}g  Max: {np.max(rms_acc):.4f}g")
    print(f"  <0.15g: {np.mean(rms_acc < 0.15) * 100:.1f}%")
    gyro_cols = [i for i in range(FEATURE_DIM) if i % N_CHANNELS in GYRO_IDX]
    rms_gyro = np.sqrt(np.mean(stop_seqs[:, -60:, :][:, :, gyro_cols] ** 2, axis=(1, 2)))
    print(f"  Gyro RMS: Mean={np.mean(rms_gyro):.2f}  Max={np.max(rms_gyro):.2f} deg/s")

    as_mask = action_labels == ACTION_TYPES.index("arm_swing")
    le_gy = sequences[as_mask][:, :, _flat_ch("l_elbow", "gy")]

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

    print(f"\n[Combination] Intra-class variance:")
    for act_name in ACTION_TYPES:
        sv = np.mean(np.var(sequences[action_labels == ACTION_TYPES.index(act_name)], axis=(1, 2)))
        print(f"  {act_name:20s}: mean sample var = {sv:.4f}")

    combo_var = np.mean(np.var(sequences[action_labels == ACTION_TYPES.index("combination")], axis=(1, 2)))
    single_mask = np.isin(action_labels, [ACTION_TYPES.index(n) for n in ACTION_TYPES if n != "combination"])
    avg_single = np.mean(np.var(sequences[single_mask], axis=(1, 2)))
    print(f"  Combination > avg single: {combo_var > avg_single}")

    print(f"\n[Per-Action Key Channel Statistics]:")
    checks = [("jump", "l_foot", "az"), ("stop", "l_foot", "ax"),
              ("arm_swing", "l_elbow", "gy"), ("turn", "head", "gz"),
              ("combination", "l_foot", "gy")]
    for act_name, node, ch in checks:
        act_idx = ACTION_TYPES.index(act_name)
        ch_data = sequences[action_labels == act_idx][:, :, _flat_ch(node, ch)].ravel()
        print(f"  {act_name:20s} {node:12s} {ch}: "
              f"mean={np.mean(ch_data):8.4f} std={np.std(ch_data):8.4f} "
              f"min={np.min(ch_data):8.4f} max={np.max(ch_data):8.4f}")


def print_summary(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
) -> None:
    print("\n" + "=" * 60)
    print("DATASET SUMMARY (V3)")
    print("=" * 60)
    print(f"Total sequences: {len(sequences)}")
    print(f"Sequence shape:  {sequences.shape[1:]}")
    print(f"Feature dim:     {sequences.shape[2]}")
    print("\nAction distribution:")
    for i, name in enumerate(ACTION_TYPES):
        print(f"  {i}: {name:20s}  {int(np.sum(action_labels == i)):5d}")
    print("\nQuality distribution:")
    for q, name in QUALITY_NAMES.items():
        print(f"  {q}: {name:9s}  {int(np.sum(quality_labels == q)):5d}")
    print("\nSignal statistics (global):")
    for ci, ch_name in enumerate(CHANNEL_NAMES):
        ch_data = sequences[:, :, ci::N_CHANNELS]
        print(f"  {ch_name}: mean={np.mean(ch_data):8.4f} std={np.std(ch_data):8.4f} "
              f"min={np.min(ch_data):8.4f} max={np.max(ch_data):8.4f}")
    print("\nPer-action channel means (ax, ay, az, gx, gy, gz):")
    for i, name in enumerate(ACTION_TYPES):
        mask = action_labels == i
        flat = sequences[mask].reshape(-1, 54)
        ch_means = np.mean(flat, axis=0)
        means_str = ", ".join(f"{np.mean(ch_means[ci::6]):8.4f}" for ci in range(N_CHANNELS))
        print(f"  {name:20s}: [{means_str}]")


def save_dataset(
    sequences: np.ndarray,
    action_labels: np.ndarray,
    quality_labels: np.ndarray,
    output_path: Path,
) -> None:
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
    print(f"\nSaved to: {output_path.resolve()}")
    print(f"File size: {output_path.stat().st_size / (1024 * 1024):.1f} MB")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate V3 synthetic skating IMU data (calibrated ablation-focused).",
    )
    parser.add_argument("--output", default="dataset_v3.npz")
    parser.add_argument("--samples-per", type=int, default=500)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--quiet", action="store_true")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    output_path = Path(args.output)
    n_total = N_ACTIONS * N_QUALITIES * args.samples_per

    print("=" * 60)
    print("Synthetic Skating IMU Data Generator V3 (Calibrated)")
    print("=" * 60)
    print(f"Actions: {N_ACTIONS}  Qualities: {N_QUALITIES}  Total: {n_total}")
    print(f"OU theta: 0.12 | Confusion: {CONFUSION_PROB*100:.0f}% | Drift prob: 8-12%")
    print(f"Seed: {args.seed}")

    sequences, action_labels, quality_labels = generate_dataset_v3(
        samples_per=args.samples_per, seed=args.seed, verbose=not args.quiet,
    )
    save_dataset(sequences, action_labels, quality_labels, output_path)
    print_summary(sequences, action_labels, quality_labels)
    print_validation_stats(sequences, action_labels, quality_labels)
    print("\n" + "=" * 60)
    print("Ready for ablation experiments.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
