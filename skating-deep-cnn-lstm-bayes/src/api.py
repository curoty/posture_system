"""HTTP API for CNN-LSTM action model + LightGBM quality regressor.

Serves the v2 continuous-score pipeline with LightGBM as the primary
quality model and GaussianNB as an optional legacy fallback.
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import torch
from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from src.predict import load_action_model, predict_record, predict_jsonl_file, load_lgb_quality_model
from src.similarity_scoring import load_reference_library
from src.coach_feedback import generate_coach_feedback


PROJECT_ROOT = Path(__file__).resolve().parents[1]

# --- Model paths (configurable via env vars) ---
DEFAULT_ACTION_MODEL_PATH = PROJECT_ROOT / "experiments" / "weight_shift_v2" / "action_model.pt"

# v3 LightGBM quality model (primary, retrained 2026-06-08)
DEFAULT_LGB_QUALITY_PATH = PROJECT_ROOT / "experiments" / "lgb_quality_v3" / "lgb_quality_model.pkl"

# v1 GaussianNB quality model (legacy fallback)
DEFAULT_QUALITY_MODEL_PATH = PROJECT_ROOT / "experiments" / "bayes_quality_v1" / "bayes_quality_global.pkl"
DEFAULT_QUALITY_BY_ACTION_DIR = PROJECT_ROOT / "experiments" / "bayes_quality_v1" / "bayes_quality_by_action"

DEFAULT_REFERENCE_LIBRARY = PROJECT_ROOT / "experiments" / "reference_library"

ACTION_MODEL_PATH = Path(os.getenv("DEEP_ACTION_MODEL_PATH", str(DEFAULT_ACTION_MODEL_PATH))).resolve()
LGB_QUALITY_MODEL_PATH = Path(os.getenv("DEEP_LGB_QUALITY_MODEL_PATH", str(DEFAULT_LGB_QUALITY_PATH))).resolve()
QUALITY_MODEL_PATH = Path(os.getenv("DEEP_QUALITY_MODEL_PATH", str(DEFAULT_QUALITY_MODEL_PATH))).resolve()
QUALITY_BY_ACTION_DIR = Path(os.getenv("DEEP_QUALITY_BY_ACTION_DIR", str(DEFAULT_QUALITY_BY_ACTION_DIR))).resolve()
REFERENCE_LIBRARY_PATH = os.getenv("DEEP_REFERENCE_LIBRARY_PATH", str(DEFAULT_REFERENCE_LIBRARY))

SHOW_TOP_K = int(os.getenv("SHOW_TOP_K", "3"))
DEFAULT_WINDOW_SECONDS = float(os.getenv("DEEP_WINDOW_SECONDS", "4.0"))
DEFAULT_STEP_SECONDS = float(os.getenv("DEEP_STEP_SECONDS", "2.0"))

# Robustness gates
EMBEDDING_COLLAPSE_THRESHOLD = float(os.getenv("DEEP_EMBEDDING_COLLAPSE_THRESHOLD", "0.05"))
CONFIDENCE_THRESHOLD = float(os.getenv("DEEP_CONFIDENCE_THRESHOLD", "0.65"))
TOP_MARGIN_THRESHOLD = float(os.getenv("DEEP_TOP_MARGIN_THRESHOLD", "0.15"))

# Node completeness guard — minimum fraction of frames that must carry sufficient nodes
DEEP_MIN_NODE_COMPLETENESS_RATIO = float(os.getenv("DEEP_MIN_NODE_COMPLETENESS_RATIO", "0.7"))


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class FrameRequest(BaseModel):
    t: float
    p: Dict[str, List[float]]


class PredictJsonRequest(BaseModel):
    model_config = {"extra": "allow"}
    mac: Optional[str] = None
    session_id: Optional[str] = Field(default=None, alias="sessionId")
    action_type: Optional[str] = Field(default=None, alias="actionType")
    frames: List[FrameRequest]
    window_seconds: Optional[float] = Field(default=None, alias="windowSeconds")
    step_seconds: Optional[float] = Field(default=None, alias="stepSeconds")


class PredictByPathRequest(BaseModel):
    filePath: str


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class DeepInferenceService:
    def __init__(
        self,
        action_model_path: Path,
        lgb_quality_model_path: Optional[Path],
        quality_model_path: Optional[Path],
        quality_by_action_dir: Optional[Path],
        reference_library_path: Optional[str],
        top_k: int,
    ) -> None:
        if not action_model_path.exists():
            raise FileNotFoundError(f"Action model does not exist: {action_model_path}")

        self.action_model_path = action_model_path
        self.lgb_quality_model_path = lgb_quality_model_path if lgb_quality_model_path and lgb_quality_model_path.exists() else None
        self.quality_model_path = quality_model_path if quality_model_path and quality_model_path.exists() else None
        self.quality_by_action_dir = quality_by_action_dir if quality_by_action_dir and quality_by_action_dir.exists() else None
        self.top_k = top_k

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.action_model, self.checkpoint = load_action_model(action_model_path, device=self.device)

        # LightGBM quality model (v2)
        self.lgb_bundle = None
        self.lgb_available = False
        if self.lgb_quality_model_path is not None:
            self.lgb_bundle = load_lgb_quality_model(self.lgb_quality_model_path)
            self.lgb_available = self.lgb_bundle is not None
            if self.lgb_available:
                print(f"[startup] LightGBM quality model loaded: {self.lgb_quality_model_path}")
            else:
                print(f"[startup] WARNING: LightGBM model not found or invalid at {self.lgb_quality_model_path}, falling back to GaussianNB")
        else:
            print("[startup] No LightGBM model path configured, will use GaussianNB fallback")

        # Reference library
        self.reference_library = None
        if reference_library_path:
            try:
                self.reference_library = load_reference_library(reference_library_path)
            except Exception:
                pass

    def predict_json(self, request: PredictJsonRequest) -> Dict[str, Any]:
        records = _build_records(request)
        results: List[Dict[str, Any]] = []
        for sample_index, record in enumerate(records):
            result = predict_record(
                record=record,
                action_model=self.action_model,
                checkpoint=self.checkpoint,
                device=self.device,
                global_quality_model_path=self.quality_model_path,
                by_action_quality_dir=self.quality_by_action_dir,
                lgb_quality_model_path=self.lgb_quality_model_path,
                reference_library=self.reference_library,
                top_k=self.top_k,
                confidence_threshold=CONFIDENCE_THRESHOLD,
                top_margin_threshold=TOP_MARGIN_THRESHOLD,
                embedding_collapse_threshold=EMBEDDING_COLLAPSE_THRESHOLD,
            )
            result["sample_index"] = int(sample_index)
            results.append(_adapt_result_for_spring(result))

        return {
            "success": True,
            "filename": None,
            "data": {
                "samples": len(results),
                "window_size": None,
                "step_size": None,
                "sensor_mode": "9node-json",
                "quality_model": "LightGBM" if self.lgb_available else ("GaussianNB" if self.quality_model_path else "none"),
                "results": results,
                "summary": _build_summary(results),
            },
        }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

active_service: Optional[DeepInferenceService] = None
startup_error: Optional[str] = None

app = FastAPI(
    title="Skating Deep CNN-LSTM + LightGBM Quality API",
    version="2.0.0",
)


@app.on_event("startup")
def startup() -> None:
    global active_service, startup_error
    try:
        active_service = DeepInferenceService(
            action_model_path=ACTION_MODEL_PATH,
            lgb_quality_model_path=LGB_QUALITY_MODEL_PATH if LGB_QUALITY_MODEL_PATH.exists() else None,
            quality_model_path=QUALITY_MODEL_PATH,
            quality_by_action_dir=QUALITY_BY_ACTION_DIR,
            reference_library_path=REFERENCE_LIBRARY_PATH,
            top_k=SHOW_TOP_K,
        )
        startup_error = None
    except Exception as exc:
        active_service = None
        startup_error = str(exc)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "success": active_service is not None,
        "message": "Deep model service is running" if active_service is not None else startup_error,
        "action_model_path": str(ACTION_MODEL_PATH),
        "lgb_quality_model_path": str(LGB_QUALITY_MODEL_PATH) if LGB_QUALITY_MODEL_PATH.exists() else None,
        "quality_model_path": str(QUALITY_MODEL_PATH),
        "quality_model_type": "LightGBM" if (active_service and active_service.lgb_available) else "GaussianNB",
        "sensor_mode": "9node-json",
        "version": "2.0.0",
        "robustness_gates": {
            "confidence_threshold": CONFIDENCE_THRESHOLD,
            "top_margin_threshold": TOP_MARGIN_THRESHOLD,
            "embedding_collapse_threshold": EMBEDDING_COLLAPSE_THRESHOLD,
        },
    }


@app.post("/predict-json")
def predict_json(request: PredictJsonRequest) -> Dict[str, Any]:
    if active_service is None:
        raise HTTPException(status_code=500, detail=startup_error or "Deep model service is not initialized")
    if not request.frames:
        raise HTTPException(status_code=400, detail="frames must not be empty")
    _validate_frames(request.frames)
    try:
        return active_service.predict_json(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/predict-by-path")
def predict_by_path(request: PredictByPathRequest) -> Dict[str, Any]:
    """Run inference on a JSONL file at the given path."""
    if active_service is None:
        raise HTTPException(status_code=500, detail=startup_error or "Deep model service is not initialized")
    file_path = request.filePath
    if not file_path or not Path(file_path).exists():
        raise HTTPException(status_code=400, detail=f"File not found: {file_path}")
    try:
        result = predict_jsonl_file(
            jsonl_path=file_path,
            action_model_path=active_service.action_model_path,
            global_quality_model_path=active_service.quality_model_path,
            by_action_quality_dir=active_service.quality_by_action_dir,
            lgb_quality_model_path=active_service.lgb_quality_model_path,
            reference_library_path=REFERENCE_LIBRARY_PATH if active_service.reference_library else None,
            top_k=active_service.top_k,
            confidence_threshold=CONFIDENCE_THRESHOLD,
            top_margin_threshold=TOP_MARGIN_THRESHOLD,
            device_name=str(active_service.device),
        )
        return {
            "success": result["success"],
            "filename": Path(file_path).name,
            "data": {
                "samples": result.get("samples", 0),
                "window_size": None,
                "step_size": None,
                "sensor_mode": "9node-json",
                "quality_model": "LightGBM" if active_service.lgb_available else "GaussianNB",
                "results": [
                    _adapt_result_for_spring(r)
                    for r in result.get("results", [])
                ],
                "summary": {
                    "average_quality_score": result.get("average_quality_score"),
                    "best_quality_score": _best_score(result.get("results", [])),
                    "worst_quality_score": _worst_score(result.get("results", [])),
                    "prediction_distribution": {},
                },
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/feedback")
def coach_feedback(request: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Generate structured score card and coaching advice from a single prediction."""
    if not request:
        raise HTTPException(status_code=400, detail="prediction must not be empty")
    try:
        return generate_coach_feedback(request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/metrics")
def metrics() -> Dict[str, Any]:
    """Return model health metrics including embedding statistics."""
    if active_service is None:
        return {"status": "not_initialized"}

    return {
        "status": "healthy",
        "quality_model_type": "LightGBM" if active_service.lgb_available else "GaussianNB",
        "device": str(active_service.device),
        "robustness_gates": {
            "embedding_collapse_threshold": EMBEDDING_COLLAPSE_THRESHOLD,
            "confidence_threshold": CONFIDENCE_THRESHOLD,
            "top_margin_threshold": TOP_MARGIN_THRESHOLD,
        },
    }


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_frames(frames: List[FrameRequest]) -> None:
    for frame_index, frame in enumerate(frames):
        if not frame.p:
            raise ValueError(f"frame {frame_index} has empty node payload")
        for node_name, values in frame.p.items():
            if len(values) != 6:
                raise ValueError(f"frame {frame_index} node {node_name} must contain 6 IMU values")


def _frame_to_dict(frame: FrameRequest) -> Dict[str, Any]:
    return {
        "t": float(frame.t),
        "p": {node_name: [float(value) for value in values] for node_name, values in frame.p.items()},
    }


def _build_records(request: PredictJsonRequest) -> List[Dict[str, Any]]:
    frames = [_frame_to_dict(frame) for frame in request.frames]
    window_seconds = request.window_seconds
    step_seconds = request.step_seconds

    if window_seconds is None:
        return [_build_record(request, frames)]

    if window_seconds <= 0:
        raise ValueError("windowSeconds must be greater than 0")
    if step_seconds is None:
        step_seconds = DEFAULT_STEP_SECONDS
    if step_seconds <= 0:
        raise ValueError("stepSeconds must be greater than 0")
    if step_seconds > window_seconds:
        raise ValueError("stepSeconds must be less than or equal to windowSeconds")

    timestamps = [_timestamp_seconds(frame["t"]) for frame in frames]
    start = min(timestamps)
    end = max(timestamps)
    if end - start < window_seconds:
        return [_build_record(request, frames)]

    records: List[Dict[str, Any]] = []
    current_start = start
    while current_start + window_seconds <= end + 1e-9:
        current_end = current_start + window_seconds
        window_frames = [
            frame
            for frame, timestamp in zip(frames, timestamps)
            if current_start <= timestamp <= current_end
        ]
        if window_frames:
            records.append(_build_record(request, window_frames))
        current_start += step_seconds

    return records or [_build_record(request, frames)]


def _build_record(request: PredictJsonRequest, frames: List[Dict[str, Any]]) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "sessionId": request.session_id or "",
        "frameCount": len(frames),
        "frames": frames,
    }
    if request.action_type:
        record["actionType"] = request.action_type
    return record


def _timestamp_seconds(value: float) -> float:
    return float(value) / 1000.0 if abs(float(value)) > 100.0 else float(value)


# ---------------------------------------------------------------------------
# Response adaptation
# ---------------------------------------------------------------------------

def _adapt_result_for_spring(result: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt internal prediction format to the Spring backend's expected schema."""
    if not result.get("success", False):
        return {
            "sample_index": int(result.get("sample_index", 0)),
            "prediction": None,
            "quality_score": None,
            "quality_level": None,
            "quality_prediction": None,
            "quality_score_source": None,
            "similarity": None,
            "is_standard": None,
            "top_predictions": [],
            "error": result.get("reason", "invalid_sample"),
        }

    deviations = _build_deviations(result)
    coaching_advice = _build_coaching_advice(result, deviations)

    # Extract coach feedback for the structured summary
    coach_result = result.get("coach_feedback", {})

    return {
        "sample_index": int(result.get("sample_index", 0)),
        "prediction": result.get("prediction"),
        "quality_score": result.get("quality_score"),
        "quality_level": result.get("quality_level"),
        "quality_prediction": result.get("quality_prediction"),
        "quality_score_source": result.get("quality_score_source"),
        "reference_similarity_score": result.get("reference_similarity_score"),
        "reference_similarity_level": result.get("reference_similarity_level"),
        "reference_similarity_prediction": result.get("reference_similarity_prediction"),
        "reference_similarity_skip_reason": result.get("reference_similarity_skip_reason"),
        "quality_skip_reason": result.get("quality_skip_reason"),
        "action_success": result.get("action_success"),
        "action_success_policy": result.get("action_success_policy"),
        "metadata": result.get("metadata"),
        "similarity": result.get("reference_similarity_score"),
        "is_standard": None,
        "deviations": deviations,
        "coaching_advice": coaching_advice,
        "coach_feedback": coach_result,
        "top_predictions": result.get("top_predictions", []),
    }


def _build_deviations(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    deviations: List[Dict[str, Any]] = []
    prediction = result.get("prediction") or {}
    action_name = str(prediction.get("label_name", "unknown"))
    confidence = float(prediction.get("confidence", 0.0) or 0.0)
    quality_score = result.get("quality_score")
    similarity_score = result.get("reference_similarity_score")
    metadata = result.get("metadata") or {}
    action_success_policy = result.get("action_success_policy") or {}

    # Action confidence
    if confidence < 0.65:
        deviations.append({
            "part": "overall",
            "metric": "action_confidence",
            "severity": "high",
            "score": round(confidence, 4),
            "description": "动作识别置信度偏低，当前动作稳定性或动作特征不够清晰。",
        })

    # Embedding collapse
    if action_success_policy.get("embedding_collapsed"):
        deviations.append({
            "part": "model",
            "metric": "embedding_collapse",
            "severity": "high",
            "score": round(float(metadata.get("embedding_std", 0)), 6),
            "description": "模型 embedding 塌陷，传感器数据可能异常，建议检查设备。",
        })

    # Continuous quality score deviation
    if quality_score is not None:
        score = float(quality_score)
        if score < 40.0:
            severity, description = "high", "整体完成质量严重偏低，动作模式可能完全偏离标准。"
        elif score < 55.0:
            severity, description = "high", "整体完成质量偏低，存在明显的结构性错误。"
        elif score < 62.0:
            severity, description = "medium", "整体完成质量一般偏下，需从基础环节加强。"
        elif score < 70.0:
            severity, description = "medium", "整体完成质量一般，连贯性和稳定性有待提升。"
        elif score < 78.0:
            severity, description = "low", "整体完成质量中等偏上，仍有优化空间。"
        elif score < 85.0:
            severity, description = "low", "整体完成质量良好，可继续优化动作细节。"
        elif score < 92.0:
            severity, description = "info", "整体完成质量优秀，保持当前节奏。"
        else:
            severity, description = "info", "整体完成质量非常优秀，接近示范水准。"
        deviations.append({
            "part": "overall",
            "metric": "quality_score",
            "severity": severity,
            "score": score,
            "description": description,
        })

    # Reference similarity deviation
    if similarity_score is not None:
        score = float(similarity_score)
        if score < 40.0:
            severity, description = "high", "与标准动作差异很大，需要重新对照标准动作调整。"
        elif score < 60.0:
            severity, description = "medium", "与标准动作存在明显差异，建议修正发力节奏。"
        elif score < 75.0:
            severity, description = "low", "与标准动作较接近，仍可优化细节。"
        elif score < 90.0:
            severity, description = "info", "与标准动作高度接近。"
        else:
            severity, description = "info", "与标准动作几乎一致。"
        deviations.append({
            "part": "overall",
            "metric": "reference_similarity",
            "severity": severity,
            "score": score,
            "description": description,
        })
    elif result.get("reference_similarity_skip_reason") == "low_action_confidence":
        deviations.append({
            "part": "overall",
            "metric": "reference_similarity",
            "severity": "info",
            "score": None,
            "description": "因动作置信度不足，未执行参考相似度评估。",
        })

    # Missing node ratio
    missing_ratio = metadata.get("missing_node_ratio")
    if missing_ratio is not None and float(missing_ratio) > 0.2:
        deviations.append({
            "part": "sensors",
            "metric": "missing_node_ratio",
            "severity": "medium",
            "score": round(float(missing_ratio), 4),
            "description": "传感器节点缺失比例偏高，建议检查设备佩戴和连接状态。",
        })

    if not deviations:
        deviations.append({
            "part": "overall",
            "metric": "standard_match",
            "severity": "info",
            "description": f"{action_name} 动作整体表现稳定，可继续保持。",
        })
    return deviations


def _build_coaching_advice(result: Dict[str, Any], deviations: List[Dict[str, Any]]) -> str:
    prediction = result.get("prediction") or {}
    action_name = str(prediction.get("label_name", "当前动作"))
    quality_score = result.get("quality_score")
    quality_level = result.get("quality_level")
    similarity_score = result.get("reference_similarity_score")

    lead = f"本次识别动作为 {action_name}"
    if quality_score is not None and quality_level is not None:
        lead += f"，质量评分 {float(quality_score):.1f}，等级为{quality_level}"
    if similarity_score is not None:
        lead += f"，与标准动作相似度约为 {float(similarity_score):.1f} 分"
    lead += "。"

    actionable = [
        str(item.get("description"))
        for item in deviations
        if item.get("severity") in {"high", "medium", "low"} and item.get("description")
    ]
    if not actionable:
        return lead + "动作整体较稳定，建议继续保持当前节奏，并在后续训练中关注动作一致性。"

    top_items = actionable[:3]
    advice = "；".join(item.rstrip("。；; ") for item in top_items)
    return lead + "主要建议：" + advice + "。"


def _build_summary(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    quality_scores = [
        float(r["quality_score"])
        for r in results
        if r.get("quality_score") is not None
    ]
    label_names = [
        r["prediction"]["label_name"]
        for r in results
        if isinstance(r.get("prediction"), dict)
    ]
    distribution = {}
    counts = Counter(label_names)
    total = len(label_names)
    for label_name, count in counts.items():
        first_result = next(
            r for r in results
            if isinstance(r.get("prediction"), dict)
            and r["prediction"].get("label_name") == label_name
        )
        distribution[label_name] = {
            "label_id": int(first_result["prediction"]["label_id"]),
            "count": int(count),
            "percentage": 0.0 if total == 0 else float(count) / float(total) * 100.0,
        }

    return {
        "average_quality_score": None if not quality_scores else round(sum(quality_scores) / len(quality_scores), 2),
        "best_quality_score": None if not quality_scores else round(max(quality_scores), 2),
        "worst_quality_score": None if not quality_scores else round(min(quality_scores), 2),
        "prediction_distribution": distribution,
    }


def _best_score(results: List[Dict[str, Any]]) -> Optional[float]:
    scores = [float(r["quality_score"]) for r in results if r.get("quality_score") is not None]
    return round(max(scores), 2) if scores else None


def _worst_score(results: List[Dict[str, Any]]) -> Optional[float]:
    scores = [float(r["quality_score"]) for r in results if r.get("quality_score") is not None]
    return round(min(scores), 2) if scores else None
