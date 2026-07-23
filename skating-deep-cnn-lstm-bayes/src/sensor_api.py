"""
Unified FastAPI service: sensor bridge + deep model inference.

Routes:
  /health                    — Health check with MQTT and model status
  /frames                    — Real-time sensor frame polling
  /calibration/gyro          — Start gyro calibration
  /calibration/gyro/clear    — Clear gyro calibration
  /denoise/training-frames   — Filter raw training frames
  /infer                     — Cloud-function compatible inference (CNN-LSTM + LightGBM)

Model loading is graceful: if the ML model is unavailable, the service still
starts — only /infer will return a 503 error.
"""

from __future__ import annotations

import logging
import os
import time
from bisect import bisect_left
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from src.mqtt_client import (
    get_active_roles,
    get_latest_frames,
    get_mqtt_status,
    publish_clear_gyro_calibration_command,
    publish_gyro_calibration_command,
    start_mqtt_client,
    stop_mqtt_client,
)
from src.training_denoise import filter_training_frames
from src.predict import load_action_model, load_lgb_quality_model, predict_record

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SENSOR_SCENE_NAME = "sensor_session_analysis_v1"

REMOTE_ROLE_TO_BASELINE_NODE = {
    "\u4e3b\u673a": "head",
    "host": "head",
    "main": "head",
    "master": "head",
    "head": "head",
    "left_elbow": "l_elbow",
    "right_elbow": "r_elbow",
    "left_wrist": "l_wrist",
    "right_wrist": "r_wrist",
    "left_knee": "l_knee",
    "right_knee": "r_knee",
    "waist": "waist",
    "body": "waist",
    "torso": "waist",
    "hip": "waist",
    "lumbar": "waist",
    "core": "waist",
    "left_foot": "l_skate",
    "right_foot": "r_skate",
    "l_elbow": "l_elbow",
    "r_elbow": "r_elbow",
    "l_wrist": "l_wrist",
    "r_wrist": "r_wrist",
    "l_knee": "l_knee",
    "r_knee": "r_knee",
    "l_skate": "l_skate",
    "r_skate": "r_skate",
}

REMOTE_ROLE_CANONICAL_ORDER = [
    "head",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_knee",
    "right_knee",
    "left_foot",
    "right_foot",
]

SENSOR_ROLES = [
    "head", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_knee", "right_knee", "waist", "left_foot", "right_foot",
]

# ---------------------------------------------------------------------------
# Deep model configuration (env vars, graceful fallback)
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).resolve().parents[1]

DEEP_ACTION_MODEL_PATH = Path(os.getenv(
    "DEEP_ACTION_MODEL_PATH",
    str(PROJECT_ROOT / "experiments" / "weight_shift_v2" / "action_model.pt"),
)).resolve()
DEEP_LGB_QUALITY_MODEL_PATH = Path(os.getenv(
    "DEEP_LGB_QUALITY_MODEL_PATH",
    str(PROJECT_ROOT / "experiments" / "lgb_quality_v3" / "lgb_quality_model.pkl"),
)).resolve()

CONFIDENCE_THRESHOLD = float(os.getenv("DEEP_CONFIDENCE_THRESHOLD", "0.65"))
TOP_MARGIN_THRESHOLD = float(os.getenv("DEEP_TOP_MARGIN_THRESHOLD", "0.15"))
EMBEDDING_COLLAPSE_THRESHOLD = float(os.getenv("DEEP_EMBEDDING_COLLAPSE_THRESHOLD", "0.05"))
DEEP_MIN_NODE_COMPLETENESS_RATIO = float(os.getenv("DEEP_MIN_NODE_COMPLETENESS_RATIO", "0.7"))

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SensorRemoteInferRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    scene: Optional[str] = Field(
        default=None,
        description="Remote call scene marker. Expected: sensor_session_analysis_v1.",
    )
    version: Optional[str] = Field(default=None)
    input: Dict[str, Any] = Field(default_factory=dict)


class FramesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    frameCount: int = Field(default=60, ge=1, le=600, description="Number of frames to return.")
    sampleIntervalMs: int = Field(default=50, ge=20, le=1000, description="Interval between frames in ms.")
    sessionId: str = Field(default="", description="Optional session identifier.")
    userId: str = Field(default="", description="Optional user identifier.")
    actionType: str = Field(default="", description="Optional action type hint.")
    note: str = Field(default="", description="Optional note.")
    roles: List[str] = Field(
        default_factory=lambda: SENSOR_ROLES.copy(),
        description="Capture roles to include. AI inference still requires the separate 9-node contract.",
    )
    since_received_ms: Optional[int] = Field(
        default=None,
        ge=0,
        alias="sinceReceivedMs",
        description="Only return frames received after this server timestamp (Unix ms).",
    )
    assemble_nodes: bool = Field(
        default=False,
        alias="assembleNodes",
        description="Assemble independent single-node samples into synchronized composite frames.",
    )
    assembly_tolerance_ms: int = Field(
        default=25,
        ge=5,
        le=100,
        alias="assemblyToleranceMs",
        description="Maximum timestamp distance when assembling node samples.",
    )
    capture_start_received_ms: Optional[int] = Field(
        default=None,
        ge=0,
        alias="captureStartReceivedMs",
        description="Fixed server-receive boundary that excludes pre-capture raw frames.",
    )
    since_sample_ms: Optional[int] = Field(
        default=None,
        ge=0,
        alias="sinceSampleMs",
        description="For assembled mode, only return composite frames after this sample timestamp.",
    )


class GyroCalibrationRequest(BaseModel):
    roles: List[str] = Field(min_length=1, max_length=10)
    request_id: Optional[str] = None


class TrainingDenoiseRequest(BaseModel):
    frames: List[Dict[str, Any]] = Field(min_length=1)
    roles: List[str] = Field(default_factory=list, max_length=10)
    profiles: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    sample_rate_hz: float = Field(default=50.0, gt=0.0, le=200.0)
    remove_spikes: bool = True
    acc_cutoff_hz: Optional[float] = Field(default=None, gt=0.0)
    gyro_cutoff_hz: Optional[float] = Field(default=None, gt=0.0)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def _clamp_score(value: float, low: int = 0, high: int = 100) -> int:
    return int(max(low, min(high, round(float(value)))))


def _normalize_remote_role(raw_role: Any) -> Optional[str]:
    normalized = str(raw_role or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return None
    return REMOTE_ROLE_TO_BASELINE_NODE.get(normalized)


def _check_nine_node_completeness(frames: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Require all nine model nodes in at least the configured frame ratio."""
    required_names = set(REMOTE_ROLE_CANONICAL_ORDER)
    required = {_normalize_remote_role(name) for name in required_names}
    total = len(frames)
    complete = 0
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        payload = frame.get("points") or frame.get("p") or {}
        if not isinstance(payload, dict):
            continue
        present = set()
        for name, value in payload.items():
            if isinstance(value, dict):
                values = [value.get(key, 0.0) for key in ("ax", "ay", "az", "gx", "gy", "gz")]
            elif isinstance(value, (list, tuple)):
                values = list(value[:6])
            else:
                values = []
            has_signal = any(
                isinstance(part, (int, float)) and np.isfinite(float(part)) and abs(float(part)) > 1e-6
                for part in values
            )
            if has_signal:
                present.add(_normalize_remote_role(name))
        if required.issubset({name for name in present if name}):
            complete += 1
    ratio = float(complete) / float(total) if total else 0.0
    threshold = float(os.getenv("DEEP_MIN_NODE_COMPLETENESS_RATIO", "0.7"))
    return {
        "ok": total > 0 and ratio >= threshold,
        "ratio": ratio,
        "threshold": threshold,
        "complete_frames": complete,
        "total_frames": total,
        "required_nodes": sorted(required_names),
    }


def _deep_result_to_analysis(result: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate deep model result into the cloud-function analysis contract."""
    prediction = result.get("prediction") if isinstance(result.get("prediction"), dict) else {}
    policy = result.get("action_success_policy") if isinstance(result.get("action_success_policy"), dict) else {}
    feedback = result.get("coach_feedback") if isinstance(result.get("coach_feedback"), dict) else {}
    frames = payload.get("frames") if isinstance(payload.get("frames"), list) else []
    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    quality_score = result.get("quality_score")
    confidence = float(prediction.get("confidence") or 0.0)
    return {
        "overallScore": None if quality_score is None else _clamp_score(float(quality_score)),
        "summary": str(feedback.get("summary") or feedback.get("overall") or ""),
        "confidence": _clamp_score(confidence * 100.0),
        "tips": feedback.get("suggestions") or feedback.get("tips") or [],
        "sensorSession": {
            "frameCount": len(frames),
            "durationMs": int(float(metadata.get("duration_seconds") or 0.0) * 1000.0),
            "predictedActionId": prediction.get("label_id"),
            "predictedAction": prediction.get("label_name"),
            "actionConfidence": round(confidence, 4),
            "actionSuccess": bool(result.get("action_success")),
            "topMargin": policy.get("top_margin"),
            "embeddingCollapsed": policy.get("embedding_collapsed"),
            "qualityScore": quality_score,
            "qualityLevel": result.get("quality_level"),
            "qualityScoreSource": result.get("quality_score_source"),
            "topPredictions": result.get("top_predictions") or [],
            "nodeCompleteness": _check_nine_node_completeness(frames),
        },
        "modelVersion": "cnn_lstm_attention_lgb_v3",
        "rawModelResult": result,
    }


def _payload_to_record(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a cloud-function /infer payload into a predict_record-compatible record.

    Mirrors deep_worker.py's ``_record()`` logic.
    """
    raw_frames = payload.get("frames") or []
    frames = []
    for index, item in enumerate(raw_frames):
        if not isinstance(item, dict):
            continue
        raw_t = float(item.get("t", item.get("ts", index * 50)))
        timestamp = raw_t / 1000.0 if abs(raw_t) > 100.0 else raw_t
        points = item.get("points") or item.get("p") or {}
        normalized = {}
        if isinstance(points, dict):
            for name, value in points.items():
                if isinstance(value, dict):
                    normalized[name] = [
                        float(value.get(key, 0.0))
                        for key in ("ax", "ay", "az", "gx", "gy", "gz")
                    ]
                elif isinstance(value, (list, tuple)) and len(value) >= 6:
                    normalized[name] = [float(part) for part in value[:6]]
        frames.append({"t": timestamp, "p": normalized})
    return {
        "_id": str(payload.get("sessionId") or payload.get("session_id") or "live"),
        "sessionId": str(payload.get("sessionId") or payload.get("session_id") or ""),
        "actionType": str(payload.get("actionType") or ""),
        "frameCount": len(frames),
        "frames": frames,
    }


def _frame_sample_timestamp_ms(frame: Dict[str, Any]) -> Optional[int]:
    unix_ms = int(frame.get("unix_ts_ms", 0) or 0)
    if bool(frame.get("time_synced")) and unix_ms >= 1_700_000_000_000:
        return unix_ms
    timestamp = int(frame.get("t", 0) or 0)
    return timestamp if timestamp >= 1_700_000_000_000 else None


def _assemble_synchronized_frames(
    raw_frames: List[Dict[str, Any]],
    roles: List[str],
    tolerance_ms: int,
    sample_interval_ms: int,
) -> List[Dict[str, Any]]:
    """Build complete, synchronized frames from independent node streams."""
    requested_roles = [str(role) for role in roles if str(role)]
    series: Dict[str, List[Tuple[int, Dict[str, Any]]]] = {
        role: [] for role in requested_roles
    }
    for frame in raw_frames:
        points = frame.get("points")
        if not isinstance(points, dict):
            continue
        timestamp = _frame_sample_timestamp_ms(frame)
        if timestamp is None:
            continue
        for role in requested_roles:
            if isinstance(points.get(role), dict):
                series[role].append((timestamp, frame))

    if not requested_roles or any(not series[role] for role in requested_roles):
        return []
    for role in requested_roles:
        series[role].sort(key=lambda item: item[0])

    interval = max(1, int(sample_interval_ms))
    timestamps = {
        role: [item[0] for item in series[role]] for role in requested_roles
    }
    anchor_role = requested_roles[0]
    next_positions = {role: 0 for role in requested_roles}
    composites: List[Dict[str, Any]] = []
    for anchor_index, (anchor_ms, anchor_frame) in enumerate(series[anchor_role]):
        selected: Dict[str, Dict[str, Any]] = {anchor_role: anchor_frame}
        selected_indices: Dict[str, int] = {anchor_role: anchor_index}
        complete = True
        for role in requested_roles:
            if role == anchor_role:
                continue
            role_timestamps = timestamps[role]
            start_pos = next_positions[role]
            pos = bisect_left(role_timestamps, anchor_ms, lo=start_pos)
            candidates = []
            if pos < len(role_timestamps):
                candidates.append(pos)
            if pos - 1 >= start_pos:
                candidates.append(pos - 1)
            if not candidates:
                complete = False
                break
            nearest = min(
                candidates, key=lambda index: abs(role_timestamps[index] - anchor_ms)
            )
            if abs(role_timestamps[nearest] - anchor_ms) > tolerance_ms:
                complete = False
                break
            selected[role] = series[role][nearest][1]
            selected_indices[role] = nearest

        if complete:
            for role, index in selected_indices.items():
                next_positions[role] = index + 1
            points = {
                role: dict(selected[role]["points"][role])
                for role in requested_roles
            }
            received_ms = max(
                int(selected[role].get("_server_received_ms", 0) or 0)
                for role in requested_roles
            )
            composites.append({
                "t": anchor_ms,
                "unix_ts_ms": anchor_ms,
                "time_synced": True,
                "sample_rate_hz": round(1000 / interval, 3),
                "points": points,
                "node_seq": {
                    role: int(selected[role].get("seq", 0) or 0)
                    for role in requested_roles
                },
                "node_device_ids": {
                    role: str(selected[role].get("device_id", ""))
                    for role in requested_roles
                },
                "node_temperature_c": {
                    role: selected[role].get("temperature_c")
                    for role in requested_roles
                },
                "node_calibration": {
                    role: dict(selected[role].get("calibration", {}))
                    for role in requested_roles
                },
                "node_filter_status": {
                    role: str(selected[role].get("filter_status", ""))
                    for role in requested_roles
                },
                "_server_received_ms": received_ms,
            })
    return composites


# ---------------------------------------------------------------------------
# Global state (shared across routes)
# ---------------------------------------------------------------------------

# Inference model — None if loading failed or disabled
inference_service: Optional[Dict[str, Any]] = None
inference_error: Optional[str] = None

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_: FastAPI):
    global inference_service, inference_error

    # Start MQTT client in background (does not block on failure)
    start_mqtt_client()

    # Try to load the deep model — graceful on failure
    inference_service = None
    inference_error = None
    if os.getenv("DEEP_INFERENCE_ENABLED", "true").strip().lower() in {"0", "false", "off", "no"}:
        _LOGGER.info("Deep inference disabled via DEEP_INFERENCE_ENABLED")
    else:
        try:
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            action_model, checkpoint = load_action_model(DEEP_ACTION_MODEL_PATH, device=device)
            lgb_bundle = load_lgb_quality_model(DEEP_LGB_QUALITY_MODEL_PATH) if DEEP_LGB_QUALITY_MODEL_PATH.exists() else None
            inference_service = {
                "action_model": action_model,
                "checkpoint": checkpoint,
                "device": device,
                "lgb_quality_model_path": DEEP_LGB_QUALITY_MODEL_PATH if DEEP_LGB_QUALITY_MODEL_PATH.exists() else None,
                "lgb_available": lgb_bundle is not None,
            }
            _LOGGER.info("Deep model loaded: %s (lgb=%s)", DEEP_ACTION_MODEL_PATH, inference_service["lgb_available"])
        except Exception as exc:
            inference_service = None
            inference_error = str(exc)
            _LOGGER.warning("Deep model NOT loaded — /infer will be unavailable: %s", exc)

    yield
    # Cleanup on shutdown
    stop_mqtt_client()


app = FastAPI(
    title="Skating Sensor Bridge + Deep Inference API",
    version="2.0.0",
    description=(
        "Unified service: sensor bridge (MQTT, frames, gyro calibration, denoise) "
        "and deep inference (CNN-LSTM + LightGBM) in a single process."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)


@app.middleware("http")
async def log_requests(request, call_next):
    start_time = time.time()
    logger.info("Request: %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
        process_time = time.time() - start_time
        logger.info(
            "Response: %d %s %s completed in %.3fs",
            response.status_code, request.method, request.url.path, process_time,
        )
        return response
    except Exception as exc:
        process_time = time.time() - start_time
        logger.error(
            "Error: %s %s failed in %.3fs - %s",
            request.method, request.url.path, process_time, exc,
        )
        raise


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    mqtt_status = get_mqtt_status()
    model_ready = inference_service is not None
    return {
        "success": model_ready,
        "message": "service is running" if model_ready else (inference_error or "Deep model not loaded"),
        "primary_model": "cnn_lstm_lightgbm",
        "deep_model_ready": model_ready,
        "deep_model_error": inference_error,
        "action_model_path": str(DEEP_ACTION_MODEL_PATH),
        "quality_model_path": str(DEEP_LGB_QUALITY_MODEL_PATH) if DEEP_LGB_QUALITY_MODEL_PATH.exists() else None,
        "sensor_mode": "9node",
        "device_connected": mqtt_status["device_online"],
        "mqtt": mqtt_status,
    }


@app.post("/frames")
async def collect_frames(request: FramesRequest):
    """Return real sensor frames from the live buffer."""
    import asyncio

    request_started = time.monotonic()
    count = max(1, min(600, request.frameCount))

    real_frames = get_latest_frames()
    if real_frames is None:
        real_frames = []

    since_ms = request.since_received_ms

    def filter_unread(frames: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        receive_boundary = (
            request.capture_start_received_ms
            if request.assemble_nodes and request.capture_start_received_ms is not None
            else since_ms
        )
        if receive_boundary is None:
            return list(frames)
        return [
            frame for frame in frames
            if int(frame.get("_server_received_ms", 0)) > receive_boundary
        ]

    def build_candidates(frames: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not request.assemble_nodes:
            return frames
        assembled = _assemble_synchronized_frames(
            frames,
            request.roles,
            request.assembly_tolerance_ms,
            request.sampleIntervalMs,
        )
        if request.since_sample_ms is not None:
            assembled = [
                frame for frame in assembled
                if int(frame.get("t", 0) or 0) > request.since_sample_ms
            ]
        return assembled

    filtered = filter_unread(real_frames)
    candidates = build_candidates(filtered)

    if len(candidates) == 0:
        mqtt_status = get_mqtt_status()
        device_online = mqtt_status.get("device_online", False)

        if device_online:
            poll_interval = 0.05
            max_wait = 10.0
            waited = 0.0
            while waited < max_wait:
                real_frames = get_latest_frames()
                if real_frames is None:
                    real_frames = []
                filtered = filter_unread(real_frames)
                candidates = build_candidates(filtered)
                if len(candidates) > 0:
                    break
                await asyncio.sleep(poll_interval)
                waited += poll_interval

            if len(candidates) == 0:
                real_frames = get_latest_frames() or []
                filtered = filter_unread(real_frames)
                candidates = build_candidates(filtered)
                if len(candidates) == 0:
                    _LOGGER.warning(
                        "Device online but no new frames after sinceReceivedMs=%s",
                        since_ms,
                    )
                    raise HTTPException(
                        status_code=503,
                        detail="device_online_but_no_frames",
                    )

    selected = candidates[:count] if since_ms is not None else candidates[-count:]

    public_frames = []
    for f in selected:
        frame = dict(f)
        received_ms = frame.pop("_server_received_ms", None)
        frame["server_received_ms"] = received_ms
        public_frames.append(frame)

    latest_received_ms = (
        public_frames[-1].get("server_received_ms")
        if public_frames
        else None
    )
    response_now_ms = int(time.time() * 1000)
    wait_ms = int((time.monotonic() - request_started) * 1000)
    latest_frame_age_ms = (
        max(0, response_now_ms - int(latest_received_ms))
        if latest_received_ms is not None
        else None
    )
    logger.info(
        "Frames: returned=%d requested_max=%d wait_ms=%d "
        "latest_frame_age_ms=%s buffered=%d",
        len(public_frames),
        count,
        wait_ms,
        latest_frame_age_ms,
        len(real_frames) if real_frames else 0,
    )

    return {
        "frames": public_frames,
        "source": "live_buffer",
        "total_available": len(real_frames) if real_frames else 0,
        "returned_count": len(public_frames),
        "server_now_ms": response_now_ms,
        "latest_server_received_ms": latest_received_ms,
        "since_received_ms": since_ms,
        "assembled": request.assemble_nodes,
        "assembled_roles": request.roles if request.assemble_nodes else [],
        "latest_sample_ms": (
            int(public_frames[-1].get("t", 0) or 0)
            if request.assemble_nodes and public_frames
            else None
        ),
        "wait_ms": wait_ms,
        "latest_frame_age_ms": latest_frame_age_ms,
    }


@app.post("/calibration/gyro")
async def start_gyro_calibration(request: GyroCalibrationRequest):
    """Dispatch gyro calibration only to nodes with live data in the MQTT buffer."""
    request_id = str(request.request_id or f"cal_{int(time.time() * 1000)}")
    mqtt = get_mqtt_status()
    if not mqtt["mqtt_connected"]:
        raise HTTPException(status_code=503, detail="mqtt_not_connected")

    live_roles = get_active_roles() or []
    target = [r for r in request.roles if r in live_roles]
    skipped = [r for r in request.roles if r not in live_roles]

    logger.info("calibration requested=%s live=%s target=%s skipped=%s",
                 request.roles, live_roles, target, skipped)

    if not target:
        raise HTTPException(status_code=503, detail={
            "message": "no_live_nodes",
            "requested": request.roles,
            "live": live_roles,
        })

    result = publish_gyro_calibration_command(target, request_id)
    logger.info("calibration result dispatched=%s unsupported=%s failed=%s",
                 result.get("dispatched_roles"), result.get("unsupported_roles"), result.get("failed_roles"))
    return {
        "success": True,
        "server_now_ms": int(time.time() * 1000),
        "requested": request.roles,
        "live": live_roles,
        "dispatched_roles": result.get("dispatched_roles", []),
        "skipped_roles": skipped,
        "failed_roles": result.get("failed_roles", {}),
    }


@app.post("/calibration/gyro/clear")
async def clear_gyro_calibration(request: GyroCalibrationRequest):
    """Clear volatile offsets when a new training-capture page session starts."""
    request_id = str(request.request_id or f"clear_{int(time.time() * 1000)}")
    result = publish_clear_gyro_calibration_command(request.roles, request_id)
    if not result.get("dispatched_roles"):
        raise HTTPException(status_code=503, detail=result)
    return result


@app.post("/denoise/training-frames")
async def denoise_training_frames(request: TrainingDenoiseRequest):
    """Filter raw training frames without modifying the raw collection."""
    try:
        frames, report = filter_training_frames(
            frames=request.frames,
            roles=request.roles or None,
            profiles=request.profiles or None,
            sample_rate_hz=request.sample_rate_hz,
            remove_spikes=request.remove_spikes,
            acc_cutoff_hz=request.acc_cutoff_hz,
            gyro_cutoff_hz=request.gyro_cutoff_hz,
        )
        return {
            "success": True,
            "frames": frames,
            "quality_report": report,
            "raw_unchanged": True,
            "temperature_compensation": "disabled",
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/infer")
async def infer_for_cloud_function(request: SensorRemoteInferRequest):
    """Cloud-function compatible sensor inference endpoint.

    Accepts ``{scene, version, input}`` payload and returns
    a normalized ``analysis`` object backed by CNN-LSTM + LightGBM.

    If the model is not loaded, returns a clear 503 instead of crashing.
    """
    scene = str(request.scene or "").strip()
    if scene and scene != SENSOR_SCENE_NAME:
        raise HTTPException(status_code=400, detail=f"unsupported scene: {scene}")

    if inference_service is None:
        _LOGGER.warning("/infer called but deep model is not available: %s", inference_error)
        raise HTTPException(
            status_code=503,
            detail=inference_error or "deep_model_not_available",
        )

    try:
        payload = request.input or {}
        completeness = _check_nine_node_completeness(payload.get("frames") or [])
        if not completeness["ok"]:
            raise ValueError(
                "node_incomplete: complete frame ratio "
                f"{completeness['ratio']:.3f} is below {completeness['threshold']:.3f}"
            )

        # Convert payload to the predict_record format (same logic as deep_worker)
        record = _payload_to_record(payload)
        result = predict_record(
            record=record,
            action_model=inference_service["action_model"],
            checkpoint=inference_service["checkpoint"],
            device=inference_service["device"],
            lgb_quality_model_path=inference_service["lgb_quality_model_path"],
            confidence_threshold=CONFIDENCE_THRESHOLD,
            top_margin_threshold=TOP_MARGIN_THRESHOLD,
            embedding_collapse_threshold=EMBEDDING_COLLAPSE_THRESHOLD,
        )
        analysis = _deep_result_to_analysis(result, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _LOGGER.exception("/infer failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "success": True,
        "analysis": analysis,
    }
