"""Isolated CNN-LSTM + LightGBM worker used by the unified FastAPI service."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _root() -> Path:
    configured = os.getenv("DEEP_MODEL_ROOT", "").strip()
    if configured:
        return Path(configured).resolve()
    return (Path(__file__).resolve().parents[2] / "skating-deep-cnn-lstm-bayes").resolve()


DEEP_ROOT = _root()
sys.path.insert(0, str(DEEP_ROOT))

import torch  # noqa: E402
from src.predict import load_action_model, predict_record  # noqa: E402


ACTION_MODEL = Path(os.getenv(
    "DEEP_ACTION_MODEL_PATH",
    str(DEEP_ROOT / "experiments" / "weight_shift_v2" / "action_model.pt"),
))
LGB_MODEL = Path(os.getenv(
    "DEEP_LGB_QUALITY_MODEL_PATH",
    str(DEEP_ROOT / "experiments" / "lgb_quality_v3" / "lgb_quality_model.pkl"),
))
DEVICE = torch.device(os.getenv("DEEP_DEVICE", "cuda" if torch.cuda.is_available() else "cpu"))
MODEL, CHECKPOINT = load_action_model(ACTION_MODEL, device=DEVICE)


def _record(payload: dict) -> dict:
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


def infer(payload: dict) -> dict:
    return predict_record(
        record=_record(payload),
        action_model=MODEL,
        checkpoint=CHECKPOINT,
        device=DEVICE,
        lgb_quality_model_path=LGB_MODEL if LGB_MODEL.exists() else None,
        confidence_threshold=float(os.getenv("DEEP_CONFIDENCE_THRESHOLD", "0.65")),
        top_margin_threshold=float(os.getenv("DEEP_TOP_MARGIN_THRESHOLD", "0.15")),
        embedding_collapse_threshold=float(os.getenv("DEEP_EMBEDDING_COLLAPSE_THRESHOLD", "0.05")),
    )


for line in sys.stdin:
    try:
        request = json.loads(line)
        response = {"ok": True, "result": infer(request)}
    except Exception as exc:  # worker must always return one line per request
        response = {"ok": False, "error": str(exc)}
    print(json.dumps(response, ensure_ascii=False), flush=True)
