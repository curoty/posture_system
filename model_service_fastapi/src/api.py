"""HTTP API for the skating RF baseline with optional quality classification."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from bisect import bisect_left
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

_LOGGER = logging.getLogger(__name__)

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from src.config import PROJECT_ROOT
from src.data_loader import ActionSegment, EXPECTED_9NODE_ORDER, REQUIRED_SENSOR_COLUMNS, load_sensor_csv
from src.feature_engineering import DEFAULT_FEATURE_CHANNELS, segment_to_feature_vector
from src.jsonl_data_loader import get_jsonl_node_mapping
from src.labels import CANONICAL_LABELS, normalize_label_name
from src.predict_quality import classify_quality_level
from src.quality_labels import estimate_quality_score_from_probabilities, get_quality_label_zh, get_quality_representative_score
from src.response_adapter import build_legacy_predict_response, build_top_predictions
from src.mqtt_client import (
    get_latest_frames,
    get_mqtt_status,
    publish_clear_gyro_calibration_command,
    publish_gyro_calibration_command,
    start_mqtt_client,
    stop_mqtt_client,
)
from src.deep_bridge import DeepModelBridge
from src.training_denoise import filter_training_frames


DEFAULT_MODEL_DIR = PROJECT_ROOT / "models" / "action"
DEFAULT_QUALITY_MODEL_DIR = PROJECT_ROOT / "models" / "quality"

MODEL_DIR = Path(os.getenv("RF_MODEL_DIR", str(DEFAULT_MODEL_DIR))).resolve()
ACTION_MODEL_PATH = MODEL_DIR / "rf_action.pkl"
STANDARD_MODEL_PATH = MODEL_DIR / "rf_standard.pkl"
FEATURE_CONFIG_PATH = MODEL_DIR / "feature_config.json"
LABEL_METADATA_PATH = MODEL_DIR / "label_metadata.json"

QUALITY_MODEL_DIR = Path(os.getenv("RF_QUALITY_MODEL_DIR", str(DEFAULT_QUALITY_MODEL_DIR))).resolve()
QUALITY_MODEL_PATH = Path(
    os.getenv("RF_QUALITY_MODEL_PATH", str(QUALITY_MODEL_DIR / "rf_quality_classifier.pkl"))
).resolve()
QUALITY_FEATURE_CONFIG_PATH = Path(
    os.getenv("RF_QUALITY_FEATURE_CONFIG", str(QUALITY_MODEL_DIR / "feature_config.json"))
).resolve()

SHOW_TOP_K = int(os.getenv("SHOW_TOP_K", "3"))
REQUIRED_ARTIFACT_PATHS = (ACTION_MODEL_PATH, FEATURE_CONFIG_PATH, LABEL_METADATA_PATH)
MIN_DURATION_SECONDS = 2.0
MAX_DURATION_SECONDS = 10.0
DEFAULT_CONTINUOUS_WINDOW_SECONDS = 4.0
DEFAULT_CONTINUOUS_STEP_SECONDS = 2.0
MAX_CONTINUOUS_WINDOW_SECONDS = 6.0

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


class PredictByPathRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    file_path: str = Field(
        alias="filePath",
        description="Absolute or relative path to a local 9-node CSV file.",
        examples=["data/demo_9node.csv"],
    )


class SensorRemoteInferRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    scene: Optional[str] = Field(
        default=None,
        description="Remote call scene marker. Expected: sensor_session_analysis_v1.",
    )
    version: Optional[str] = Field(default=None)
    input: Dict[str, Any] = Field(default_factory=dict)


class ContinuousFrameRequest(BaseModel):
    t: Union[int, float] = Field(description="Frame timestamp in milliseconds.")
    p: Dict[str, List[float]] = Field(
        description=(
            "Per-node IMU payload. "
            "Supported node names include head, left_elbow, right_elbow, left_wrist, right_wrist, "
            "left_knee, right_knee, left_foot, right_foot."
        )
    )


class PredictContinuousJsonRequest(BaseModel):
    session_id: Optional[str] = Field(
        default=None,
        alias="sessionId",
        description="Optional session id from the frontend collector.",
    )
    frames: List[ContinuousFrameRequest] = Field(
        description="Continuous 9-node IMU frames in raw JSON format."
    )
    active_nodes: List[str] = Field(
        default_factory=list,
        alias="activeNodes",
        description="Optional selected active nodes from the frontend.",
    )
    window_seconds: float = Field(
        default=DEFAULT_CONTINUOUS_WINDOW_SECONDS,
        alias="windowSeconds",
        ge=MIN_DURATION_SECONDS,
        le=MAX_CONTINUOUS_WINDOW_SECONDS,
        description="Sliding window duration in seconds. Recommended 4.0.",
    )
    step_seconds: float = Field(
        default=DEFAULT_CONTINUOUS_STEP_SECONDS,
        alias="stepSeconds",
        gt=0.0,
        le=MAX_CONTINUOUS_WINDOW_SECONDS,
        description="Sliding step size in seconds. Recommended 2.0.",
    )


class ActionPredictionResponse(BaseModel):
    label_id: int = Field(description="Predicted action label id.")
    label_name: str = Field(description="Predicted action label name.")
    confidence: float = Field(description="Confidence of the top action prediction in [0, 1].")


class TopPredictionResponse(BaseModel):
    rank: int = Field(description="Rank within the action top-k list, starting from 1.")
    label_id: int = Field(description="Candidate action label id.")
    label_name: str = Field(description="Candidate action label name.")
    probability: float = Field(description="Candidate action probability in [0, 1].")


class QualityPredictionResponse(BaseModel):
    class_id: int = Field(description="Quality class id. 0=Fail, 1=Mid, 2=Good, 3=Excellent.")
    code: str = Field(description="Quality class code. One of Fail, Mid, Good, Excellent.")
    label: str = Field(description="Chinese quality label. One of 不及格, 中等, 良好, 优秀.")
    quality_score: float = Field(
        description=(
            "Continuous interpretable quality score in [0, 100]. "
            "It is computed as the probability-weighted expectation over representative class scores: "
            "Fail=29.5, Mid=67.0, Good=82.0, Excellent=95.0."
        )
    )
    confidence: float = Field(description="Confidence of the predicted quality class in [0, 1].")


class SampleResultResponse(BaseModel):
    sample_index: int = Field(description="Index of the inferred sample inside the request.")
    prediction: ActionPredictionResponse
    quality_score: Optional[float] = Field(
        default=None,
        description=(
            "Top-level continuous quality score in [0, 100]. "
            "This equals quality_prediction.quality_score when the quality model is enabled."
        ),
    )
    quality_level: Optional[str] = Field(
        default=None,
        description="Chinese quality label such as 优秀, 良好, 中等, 不及格.",
    )
    quality_prediction: Optional[QualityPredictionResponse] = None
    similarity: Optional[float] = Field(default=None, description="Reserved legacy field, currently unused.")
    is_standard: Optional[bool] = Field(default=None, description="Optional standard-action classifier result.")
    top_predictions: list[TopPredictionResponse] = Field(
        description="Top-k ranked action predictions derived from action-model probabilities."
    )


class PredictionDistributionItemResponse(BaseModel):
    label_id: int = Field(description="Action label id.")
    count: int = Field(description="Number of samples assigned to this action label.")
    percentage: float = Field(description="Percentage within the current response batch.")


class PredictSummaryResponse(BaseModel):
    average_quality_score: Optional[float] = Field(
        default=None,
        description="Average quality_score across returned samples.",
    )
    best_quality_score: Optional[float] = Field(
        default=None,
        description="Maximum quality_score across returned samples.",
    )
    worst_quality_score: Optional[float] = Field(
        default=None,
        description="Minimum quality_score across returned samples.",
    )
    prediction_distribution: Dict[str, PredictionDistributionItemResponse] = Field(
        description="Action-label distribution summary keyed by label name."
    )


class PredictDataResponse(BaseModel):
    samples: int = Field(description="Number of returned samples.")
    window_size: Optional[int] = Field(default=None, description="Reserved legacy field, currently unused.")
    step_size: Optional[int] = Field(default=None, description="Reserved legacy field, currently unused.")
    sensor_mode: str = Field(description="Input sensor mode. Current API expects 9node.")
    results: list[SampleResultResponse]
    summary: PredictSummaryResponse


class PredictResponse(BaseModel):
    success: bool = Field(description="Whether the inference request succeeded.")
    filename: str = Field(description="Original filename or CSV basename.")
    data: PredictDataResponse


class ContinuousSegmentResponse(BaseModel):
    segment_index: int = Field(description="0-based segment index after windowing.")
    start_ms: int = Field(description="Window start timestamp in milliseconds.")
    end_ms: int = Field(description="Window end timestamp in milliseconds.")
    duration_seconds: float = Field(description="Window duration in seconds.")
    prediction: ActionPredictionResponse
    quality_score: Optional[float] = Field(default=None, description="Continuous quality score in [0, 100].")
    quality_level: Optional[str] = Field(default=None, description="Chinese quality label for the segment.")
    quality_prediction: Optional[QualityPredictionResponse] = None
    top_predictions: List[TopPredictionResponse]
    num_rows: int = Field(description="Flattened sensor rows used in this segment window.")


class MergedContinuousSegmentResponse(BaseModel):
    merged_index: int = Field(description="0-based merged-segment index after adjacent-window merge.")
    start_ms: int = Field(description="Merged segment start timestamp in milliseconds.")
    end_ms: int = Field(description="Merged segment end timestamp in milliseconds.")
    duration_seconds: float = Field(description="Merged segment duration in seconds.")
    action: str = Field(description="Merged action label name.")
    window_count: int = Field(description="Number of adjacent windows merged into this segment.")
    average_confidence: float = Field(description="Average action confidence across merged windows.")
    average_quality_score: Optional[float] = Field(default=None, description="Average quality score across merged windows.")
    dominant_quality_level: Optional[str] = Field(default=None, description="Most frequent quality level across merged windows.")


class ContinuousSummaryResponse(BaseModel):
    session_id: Optional[str] = Field(default=None, description="Frontend-provided session id.")
    total_frames: int = Field(description="Number of raw frames received.")
    total_segments: int = Field(description="Number of valid sliding-window segments returned.")
    window_seconds: float = Field(description="Window duration used for segmentation.")
    step_seconds: float = Field(description="Step size used for segmentation.")
    dominant_action: Optional[str] = Field(default=None, description="Most frequent predicted action across segments.")
    average_quality_score: Optional[float] = Field(default=None, description="Average quality score across segments.")
    merged_segments: int = Field(description="Number of adjacent same-action merged segments.")


class PredictContinuousJsonResponse(BaseModel):
    success: bool
    sensor_mode: str = Field(description="Input sensor mode. Current continuous API expects raw 9-node JSON.")
    summary: ContinuousSummaryResponse
    segments: List[ContinuousSegmentResponse]
    merged_segments: List[MergedContinuousSegmentResponse]


class RFService:
    """Load RF artifacts once and serve predictions."""

    def __init__(
        self,
        action_model_path: Path,
        feature_config_path: Path,
        label_metadata_path: Path,
        standard_model_path: Optional[Path] = None,
        quality_model_path: Optional[Path] = None,
        quality_feature_config_path: Optional[Path] = None,
        show_top_k: int = 3,
    ) -> None:
        self.action_model_path = action_model_path
        self.feature_config_path = feature_config_path
        self.label_metadata_path = label_metadata_path
        self.standard_model_path = standard_model_path
        self.quality_model_path = quality_model_path
        self.quality_feature_config_path = quality_feature_config_path
        self.show_top_k = show_top_k

        self.feature_config = self._load_feature_config(feature_config_path)
        self.label_metadata = self._load_label_metadata(label_metadata_path)

        self.action_model = joblib.load(action_model_path)

        self.standard_model = None
        if standard_model_path is not None and standard_model_path.exists():
            self.standard_model = joblib.load(standard_model_path)

        self.quality_model = None
        self.quality_feature_config = None
        self.json_node_mapping = get_jsonl_node_mapping()
        if quality_model_path is not None and quality_feature_config_path is not None:
            if quality_model_path.exists() and quality_feature_config_path.exists():
                self.quality_model = joblib.load(quality_model_path)
                self.quality_feature_config = self._load_feature_config(quality_feature_config_path)

    def _load_json_file(self, json_path: Path) -> Dict[str, Any]:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"JSON payload at {json_path} must be an object.")
        return payload

    def _load_feature_config(self, config_path: Path) -> Dict[str, Any]:
        payload = self._load_json_file(config_path)
        node_order = payload.get("node_order")
        channels = payload.get("channels", list(DEFAULT_FEATURE_CHANNELS))
        if not isinstance(node_order, list) or not node_order:
            raise ValueError("feature_config.json must contain a non-empty 'node_order' list.")
        if not isinstance(channels, list) or not channels:
            raise ValueError("feature_config.json must contain a non-empty 'channels' list.")

        return {
            "node_order": [str(node) for node in node_order],
            "channels": [str(channel) for channel in channels],
            "start_window_seconds": float(payload.get("start_window_seconds", 1.0)),
            "end_window_seconds": float(payload.get("end_window_seconds", 1.0)),
            "min_samples_per_node": int(payload.get("min_samples_per_node", 2)),
            "enable_missing_flags": bool(payload.get("enable_missing_flags", True)),
            "missing_fill_value": float(payload.get("missing_fill_value", 0.0)),
            "min_valid_nodes_per_window": int(payload.get("min_valid_nodes_per_window", 6)),
            "top_k": int(payload.get("top_k", self.show_top_k)),
            "quality_prediction_policy": payload.get("quality_prediction_policy", "argmax"),
        }

    def _load_label_metadata(self, metadata_path: Path) -> Dict[str, Any]:
        payload = self._load_json_file(metadata_path)
        action_labels = payload.get("action_labels")
        if not isinstance(action_labels, dict) or not action_labels:
            raise ValueError("label_metadata.json must contain an 'action_labels' object.")

        label_schema = str(payload.get("label_schema", "canonical"))
        if label_schema == "canonical":
            canonical_action_labels = {
                int(label_id): normalize_label_name(str(label_name))
                for label_id, label_name in action_labels.items()
            }
            if canonical_action_labels != CANONICAL_LABELS:
                raise ValueError("label_metadata.json action_labels do not match project canonical labels.")
            resolved_action_labels = canonical_action_labels
        elif label_schema == "dynamic_jsonl":
            resolved_action_labels = {
                int(label_id): str(label_name).strip()
                for label_id, label_name in action_labels.items()
            }
            if any(not label_name for label_name in resolved_action_labels.values()):
                raise ValueError("label_metadata.json contains empty action labels for dynamic_jsonl schema.")
        else:
            raise ValueError(f"Unsupported label schema in label_metadata.json: {label_schema}")

        return {
            "label_schema": label_schema,
            "action_labels": resolved_action_labels,
            "standard_positive_label": int(payload.get("standard_positive_label", 1)),
        }

    def _build_single_segment(self, sensor_csv_path: Path) -> ActionSegment:
        try:
            sensor_df = load_sensor_csv(sensor_csv_path)
        except ValueError as exc:
            if "missing required 9-node entries" in str(exc):
                raise ValueError("传感器节点不完整") from exc
            raise

        node_order = self.feature_config["node_order"]
        filtered_sensor_df = sensor_df.loc[sensor_df["node"].isin(node_order)].copy()
        if filtered_sensor_df.empty:
            raise ValueError("No sensor rows remain after applying node_order from feature_config.json.")

        start_ts = float(filtered_sensor_df["ts"].min())
        end_ts = float(filtered_sensor_df["ts"].max())
        if end_ts <= start_ts:
            raise ValueError("Prediction sensor CSV does not contain a valid time range.")

        return ActionSegment(
            segment_id=0,
            start_ts=start_ts,
            end_ts=end_ts,
            action_label_id=-1,
            action_label_name="unknown",
            standard_label_id=None,
            standard_label_name=None,
            sensor_frame=filtered_sensor_df.sort_values(["ts", "node"]).reset_index(drop=True),
            node_order=node_order,
            metadata={
                "segment_id": 0,
                "start_ts": start_ts,
                "end_ts": end_ts,
                "num_rows": int(len(filtered_sensor_df)),
                "nodes_present": sorted(filtered_sensor_df["node"].unique().tolist()),
            },
        )

    def _raw_frames_to_sensor_frame(
        self,
        frames: List[ContinuousFrameRequest],
        active_nodes: Optional[List[str]] = None,
    ) -> pd.DataFrame:
        rows: List[Dict[str, Any]] = []
        allowed_nodes = set(active_nodes or [])
        for frame in frames:
            timestamp_ms = float(frame.t)
            for raw_node_name, raw_values in frame.p.items():
                mapped_node_name = self.json_node_mapping.get(str(raw_node_name).strip())
                if mapped_node_name is None:
                    continue
                if allowed_nodes and mapped_node_name not in allowed_nodes:
                    continue
                if len(raw_values) != 6:
                    continue
                rows.append(
                    {
                        "ts": timestamp_ms / 1000.0,
                        "node": mapped_node_name,
                        "ax": float(raw_values[0]),
                        "ay": float(raw_values[1]),
                        "az": float(raw_values[2]),
                        "gx": float(raw_values[3]),
                        "gy": float(raw_values[4]),
                        "gz": float(raw_values[5]),
                    }
                )

        sensor_frame = pd.DataFrame(rows, columns=list(REQUIRED_SENSOR_COLUMNS))
        if sensor_frame.empty:
            raise ValueError("No valid 9-node frame payload could be parsed from JSON request.")
        return sensor_frame.sort_values(["ts", "node"]).reset_index(drop=True)

    def _build_segment_from_sensor_frame(
        self,
        sensor_frame: pd.DataFrame,
        segment_id: int,
        start_ts: float,
        end_ts: float,
    ) -> ActionSegment:
        segment_frame = sensor_frame.loc[(sensor_frame["ts"] >= start_ts) & (sensor_frame["ts"] <= end_ts)].copy()
        segment_frame = segment_frame.loc[segment_frame["node"].isin(self.feature_config["node_order"])].reset_index(drop=True)
        if segment_frame.empty:
            raise ValueError("Segment window produced no valid sensor rows.")

        return ActionSegment(
            segment_id=int(segment_id),
            start_ts=float(start_ts),
            end_ts=float(end_ts),
            action_label_id=-1,
            action_label_name="unknown",
            standard_label_id=None,
            standard_label_name=None,
            sensor_frame=segment_frame,
            node_order=list(self.feature_config["node_order"]),
            metadata={
                "segment_id": int(segment_id),
                "start_ts": float(start_ts),
                "end_ts": float(end_ts),
                "num_rows": int(len(segment_frame)),
                "nodes_present": sorted(segment_frame["node"].drop_duplicates().tolist()),
            },
        )

    def _predict_probabilities(self, model: Any, feature_vector: np.ndarray) -> Tuple[int, float, np.ndarray]:
        if hasattr(model, "predict_proba"):
            probabilities = model.predict_proba(feature_vector)
            if probabilities.ndim == 2:
                probabilities = probabilities[0]
            class_index = int(np.argmax(probabilities))
            label_id = int(model.classes_[class_index])
            return label_id, float(probabilities[class_index]), probabilities

        label_id = int(model.predict(feature_vector)[0])
        return label_id, 1.0, np.asarray([], dtype=float)

    def _build_feature_vector(self, segment: ActionSegment, feature_config: Dict[str, Any]) -> np.ndarray:
        feature_result = segment_to_feature_vector(
            segment=segment,
            channels=feature_config["channels"],
            start_window_seconds=feature_config["start_window_seconds"],
            end_window_seconds=feature_config["end_window_seconds"],
            min_samples_per_node=feature_config["min_samples_per_node"],
            enable_missing_flags=feature_config["enable_missing_flags"],
            missing_fill_value=feature_config["missing_fill_value"],
            min_valid_nodes_per_window=feature_config["min_valid_nodes_per_window"],
        )
        if feature_result is None:
            raise ValueError("Unable to build a feature vector from the provided sensor CSV.")

        feature_vector, _ = feature_result
        return feature_vector.reshape(1, -1)

    def _predict_quality(self, segment: ActionSegment, action_feature_vector: np.ndarray) -> Optional[Dict[str, Any]]:
        if self.quality_model is None or self.quality_feature_config is None:
            return None

        quality_feature_vector = action_feature_vector
        if self.quality_feature_config != self.feature_config:
            quality_feature_vector = self._build_feature_vector(segment, self.quality_feature_config)

        expected_feature_dim = getattr(self.quality_model, "n_features_in_", quality_feature_vector.shape[1])
        if int(expected_feature_dim) != int(quality_feature_vector.shape[1]):
            raise ValueError(
                f"Quality feature dimension mismatch: expected {expected_feature_dim}, got {quality_feature_vector.shape[1]}."
            )

        class_id, confidence, probabilities = self._predict_probabilities(self.quality_model, quality_feature_vector)
        level_code = classify_quality_level(class_id)
        level_label = get_quality_label_zh(class_id)
        if probabilities.size > 0 and hasattr(self.quality_model, "classes_"):
            quality_score = estimate_quality_score_from_probabilities(
                class_ids=np.asarray(self.quality_model.classes_, dtype=int).tolist(),
                probabilities=np.asarray(probabilities, dtype=float).tolist(),
            )
        else:
            quality_score = round(get_quality_representative_score(class_id), 2)
        return {
            "class_id": int(class_id),
            "code": level_code,
            "label": level_label,
            "quality_score": float(quality_score),
            "confidence": float(confidence),
        }

    def infer_csv(self, sensor_csv_path: Path, sample_index: int = 1) -> Dict[str, Any]:
        segment = self._build_single_segment(sensor_csv_path)
        feature_vector = self._build_feature_vector(segment, self.feature_config)

        expected_feature_dim = getattr(self.action_model, "n_features_in_", feature_vector.shape[1])
        if int(expected_feature_dim) != int(feature_vector.shape[1]):
            raise ValueError(
                f"Feature dimension mismatch: expected {expected_feature_dim}, got {feature_vector.shape[1]}."
            )

        action_label_id, action_confidence, probabilities = self._predict_probabilities(self.action_model, feature_vector)
        action_label_name = self.label_metadata["action_labels"][action_label_id]

        is_standard: Optional[bool] = None
        if self.standard_model is not None:
            standard_label_id, _, _ = self._predict_probabilities(self.standard_model, feature_vector)
            is_standard = bool(standard_label_id == self.label_metadata["standard_positive_label"])

        top_predictions = build_top_predictions(
            classes=self.action_model.classes_,
            probabilities=probabilities,
            action_labels=self.label_metadata["action_labels"],
            top_k=self.feature_config["top_k"],
        )
        quality_prediction = self._predict_quality(segment, feature_vector)

        return build_legacy_predict_response(
            filename=sensor_csv_path.name,
            action_label_id=action_label_id,
            action_label_name=action_label_name,
            action_confidence=action_confidence,
            top_predictions=top_predictions,
            is_standard=is_standard,
            quality_prediction=quality_prediction,
            sample_index=sample_index,
            sensor_mode="9node",
        )

    def infer_continuous_json(
        self,
        frames: List[ContinuousFrameRequest],
        session_id: Optional[str] = None,
        active_nodes: Optional[List[str]] = None,
        window_seconds: float = DEFAULT_CONTINUOUS_WINDOW_SECONDS,
        step_seconds: float = DEFAULT_CONTINUOUS_STEP_SECONDS,
    ) -> Dict[str, Any]:
        sensor_frame = self._raw_frames_to_sensor_frame(frames, active_nodes=active_nodes)
        start_ts = float(sensor_frame["ts"].min())
        end_ts = float(sensor_frame["ts"].max())
        total_duration = end_ts - start_ts
        if total_duration < MIN_DURATION_SECONDS:
            raise ValueError("Continuous JSON data is too short for segmentation.")

        window_seconds = float(window_seconds)
        step_seconds = float(step_seconds)
        if step_seconds > window_seconds:
            raise ValueError("stepSeconds must be less than or equal to windowSeconds.")

        segment_results: List[Dict[str, Any]] = []
        current_start = start_ts
        segment_index = 0
        while current_start + window_seconds <= end_ts + 1e-9:
            current_end = current_start + window_seconds
            try:
                segment = self._build_segment_from_sensor_frame(
                    sensor_frame=sensor_frame,
                    segment_id=segment_index,
                    start_ts=current_start,
                    end_ts=current_end,
                )
                feature_vector = self._build_feature_vector(segment, self.feature_config)
            except ValueError:
                current_start += step_seconds
                segment_index += 1
                continue

            action_label_id, action_confidence, probabilities = self._predict_probabilities(self.action_model, feature_vector)
            action_label_name = self.label_metadata["action_labels"][action_label_id]
            top_predictions = build_top_predictions(
                classes=self.action_model.classes_,
                probabilities=probabilities,
                action_labels=self.label_metadata["action_labels"],
                top_k=self.feature_config["top_k"],
            )
            quality_prediction = self._predict_quality(segment, feature_vector)
            segment_results.append(
                {
                    "segment_index": int(segment_index),
                    "start_ms": int(round(current_start * 1000.0)),
                    "end_ms": int(round(current_end * 1000.0)),
                    "duration_seconds": round(window_seconds, 3),
                    "prediction": {
                        "label_id": int(action_label_id),
                        "label_name": action_label_name,
                        "confidence": float(action_confidence),
                    },
                    "quality_score": None if quality_prediction is None else quality_prediction.get("quality_score"),
                    "quality_level": None if quality_prediction is None else quality_prediction.get("label"),
                    "quality_prediction": quality_prediction,
                    "top_predictions": top_predictions,
                    "num_rows": int(len(segment.sensor_frame)),
                }
            )
            current_start += step_seconds
            segment_index += 1

        if not segment_results:
            raise ValueError("No valid segments could be produced from the continuous JSON data.")

        action_counts: Dict[str, int] = {}
        quality_scores: List[float] = []
        for result in segment_results:
            action_name = str(result["prediction"]["label_name"])
            action_counts[action_name] = action_counts.get(action_name, 0) + 1
            quality_score = result.get("quality_score")
            if quality_score is not None:
                quality_scores.append(float(quality_score))

        dominant_action = max(action_counts.items(), key=lambda item: item[1])[0] if action_counts else None
        average_quality_score = round(float(np.mean(quality_scores)), 2) if quality_scores else None
        merged_segments = self._merge_adjacent_segments(segment_results)

        return {
            "success": True,
            "sensor_mode": "9node_continuous_json",
            "summary": {
                "session_id": session_id,
                "total_frames": int(len(frames)),
                "total_segments": int(len(segment_results)),
                "window_seconds": float(window_seconds),
                "step_seconds": float(step_seconds),
                "dominant_action": dominant_action,
                "average_quality_score": average_quality_score,
                "merged_segments": int(len(merged_segments)),
            },
            "segments": segment_results,
            "merged_segments": merged_segments,
        }

    def _merge_adjacent_segments(self, segment_results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not segment_results:
            return []

        merged: List[Dict[str, Any]] = []
        current_group: List[Dict[str, Any]] = [segment_results[0]]

        def flush_group(group: List[Dict[str, Any]], merged_index: int) -> Dict[str, Any]:
            first_item = group[0]
            last_item = group[-1]
            confidences = [float(item["prediction"]["confidence"]) for item in group]
            quality_scores = [float(item["quality_score"]) for item in group if item.get("quality_score") is not None]
            quality_levels: Dict[str, int] = {}
            for item in group:
                quality_level = item.get("quality_level")
                if quality_level is None:
                    continue
                quality_levels[str(quality_level)] = quality_levels.get(str(quality_level), 0) + 1
            dominant_quality_level = None
            if quality_levels:
                dominant_quality_level = max(quality_levels.items(), key=lambda item: item[1])[0]

            return {
                "merged_index": int(merged_index),
                "start_ms": int(first_item["start_ms"]),
                "end_ms": int(last_item["end_ms"]),
                "duration_seconds": round((int(last_item["end_ms"]) - int(first_item["start_ms"])) / 1000.0, 3),
                "action": str(first_item["prediction"]["label_name"]),
                "window_count": int(len(group)),
                "average_confidence": round(float(np.mean(confidences)), 4),
                "average_quality_score": None if not quality_scores else round(float(np.mean(quality_scores)), 2),
                "dominant_quality_level": dominant_quality_level,
            }

        for item in segment_results[1:]:
            previous_item = current_group[-1]
            same_action = item["prediction"]["label_name"] == previous_item["prediction"]["label_name"]
            touching = int(item["start_ms"]) <= int(previous_item["end_ms"])
            if same_action and touching:
                current_group.append(item)
                continue

            merged.append(flush_group(current_group, len(merged)))
            current_group = [item]

        merged.append(flush_group(current_group, len(merged)))
        return merged


def _validate_sensor_csv_for_api(sensor_csv_path: Path) -> None:
    try:
        sensor_df = pd.read_csv(sensor_csv_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法读取 CSV 文件: {exc}") from exc

    missing_columns = [column for column in REQUIRED_SENSOR_COLUMNS if column not in sensor_df.columns]
    if missing_columns:
        raise HTTPException(
            status_code=400,
            detail=f"CSV 缺少必要列: {missing_columns}。请提供完整的 9 节点传感器通道。",
        )

    if len(sensor_df.columns) < len(REQUIRED_SENSOR_COLUMNS):
        raise HTTPException(
            status_code=400,
            detail="CSV 特征通道数量不足，无法满足 9 节点传感器输入要求。",
        )

    node_series = sensor_df["node"].dropna().astype(str).str.strip()
    observed_nodes = sorted(node_series[node_series != ""].unique().tolist())
    if len(observed_nodes) < len(EXPECTED_9NODE_ORDER):
        raise HTTPException(status_code=400, detail="传感器节点不完整")

    ts_series = pd.to_numeric(sensor_df["ts"], errors="coerce").dropna()
    if ts_series.empty:
        raise HTTPException(status_code=400, detail="CSV 中缺少有效时间戳，无法判断数据时长。")

    duration_seconds = float(ts_series.max() - ts_series.min())
    if duration_seconds < MIN_DURATION_SECONDS or duration_seconds > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"上传数据时长为 {duration_seconds:.2f} 秒，不在允许范围内。"
                f"请上传 {MIN_DURATION_SECONDS:.0f} 到 {MAX_DURATION_SECONDS:.0f} 秒之间的单段动作数据。"
            ),
        )


def _clamp_score(value: float, low: int = 0, high: int = 100) -> int:
    return int(max(low, min(high, round(float(value)))))


def _normalize_remote_role(raw_role: Any) -> Optional[str]:
    normalized = str(raw_role or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return None
    return REMOTE_ROLE_TO_BASELINE_NODE.get(normalized)


def _normalize_active_nodes(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []

    selected: List[str] = []
    for item in value:
        mapped = _normalize_remote_role(item)
        if mapped and mapped not in selected:
            selected.append(mapped)

    ordered: List[str] = []
    for remote_name in REMOTE_ROLE_CANONICAL_ORDER:
        baseline_name = _normalize_remote_role(remote_name)
        if baseline_name and baseline_name in selected and baseline_name not in ordered:
            ordered.append(baseline_name)
    return ordered


def _to_float(value: Any, fallback: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if np.isfinite(numeric):
        return float(numeric)
    return float(fallback)


def _normalize_remote_point(point_payload: Any) -> Optional[Tuple[float, float, float, float, float, float]]:
    if isinstance(point_payload, (list, tuple)) and len(point_payload) >= 6:
        return (
            _to_float(point_payload[0]),
            _to_float(point_payload[1]),
            _to_float(point_payload[2]),
            _to_float(point_payload[3]),
            _to_float(point_payload[4]),
            _to_float(point_payload[5]),
        )
    if not isinstance(point_payload, dict):
        return None
    return (
        _to_float(point_payload.get("ax", point_payload.get("accX", point_payload.get("x", 0.0)))),
        _to_float(point_payload.get("ay", point_payload.get("accY", point_payload.get("y", 0.0)))),
        _to_float(point_payload.get("az", point_payload.get("accZ", point_payload.get("z", 0.0)))),
        _to_float(point_payload.get("gx", point_payload.get("gyroX", point_payload.get("wx", 0.0)))),
        _to_float(point_payload.get("gy", point_payload.get("gyroY", point_payload.get("wy", 0.0)))),
        _to_float(point_payload.get("gz", point_payload.get("gyroZ", point_payload.get("wz", 0.0)))),
    )


def _extract_remote_points(frame: Dict[str, Any]) -> Dict[str, Any]:
    points = frame.get("points")
    if isinstance(points, dict):
        return points
    payload = frame.get("p")
    if isinstance(payload, dict):
        return payload

    fallback_points: Dict[str, Any] = {}
    for key, value in frame.items():
        if _normalize_remote_role(key):
            fallback_points[key] = value
    return fallback_points


def _remote_frames_to_sensor_frame(
    frames: List[Dict[str, Any]],
    active_nodes: Optional[List[str]] = None,
) -> pd.DataFrame:
    rows: List[Dict[str, Any]] = []
    allowed_nodes = set(active_nodes or [])
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        raw_ts = frame.get("t", frame.get("ts", frame.get("timestamp", index * 0.05)))
        ts = _to_float(raw_ts, index * 0.05)
        points = _extract_remote_points(frame)
        for raw_role, raw_point in points.items():
            mapped_node = _normalize_remote_role(raw_role)
            if mapped_node is None:
                continue
            if allowed_nodes and mapped_node not in allowed_nodes:
                continue
            vector = _normalize_remote_point(raw_point)
            if vector is None:
                continue
            ax, ay, az, gx, gy, gz = vector
            rows.append(
                {
                    "ts": ts,
                    "node": mapped_node,
                    "ax": ax,
                    "ay": ay,
                    "az": az,
                    "gx": gx,
                    "gy": gy,
                    "gz": gz,
                }
            )

    sensor_frame = pd.DataFrame(rows, columns=list(REQUIRED_SENSOR_COLUMNS))
    if sensor_frame.empty:
        return sensor_frame

    ts_max = float(sensor_frame["ts"].max())
    ts_min = float(sensor_frame["ts"].min())
    ts_span = max(0.0, ts_max - ts_min)
    if ts_max > 1e6 or ts_span > 120:
        sensor_frame["ts"] = sensor_frame["ts"] / 1000.0

    return sensor_frame.sort_values(["ts", "node"]).reset_index(drop=True)


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


def _build_sensor_analysis_from_remote_payload(active_service: RFService, payload_input: Dict[str, Any]) -> Dict[str, Any]:
    frames = payload_input.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("input.frames is required")
    completeness = _check_nine_node_completeness(frames)
    if not completeness["ok"]:
        raise ValueError(
            "node_incomplete: complete frame ratio "
            f"{completeness['ratio']:.3f} is below {completeness['threshold']:.3f}"
        )
    active_nodes = _normalize_active_nodes(
        payload_input.get("activeNodes")
        or payload_input.get("active_nodes")
        or payload_input.get("keepRoles")
        or payload_input.get("selectedNodes")
        or payload_input.get("roles")
    )

    sensor_frame = _remote_frames_to_sensor_frame(frames, active_nodes=active_nodes)
    if sensor_frame.empty:
        raise ValueError("no valid sensor frame rows found")

    start_ts = float(sensor_frame["ts"].min())
    end_ts = float(sensor_frame["ts"].max())
    segment = active_service._build_segment_from_sensor_frame(
        sensor_frame=sensor_frame,
        segment_id=0,
        start_ts=start_ts,
        end_ts=end_ts,
    )
    feature_vector = active_service._build_feature_vector(segment, active_service.feature_config)
    expected_feature_dim = getattr(active_service.action_model, "n_features_in_", feature_vector.shape[1])
    if int(expected_feature_dim) != int(feature_vector.shape[1]):
        raise ValueError(
            f"feature dimension mismatch: expected {expected_feature_dim}, got {feature_vector.shape[1]}"
        )

    action_label_id, action_confidence, probabilities = active_service._predict_probabilities(
        active_service.action_model,
        feature_vector,
    )
    action_label_name = active_service.label_metadata["action_labels"][action_label_id]
    top_predictions = build_top_predictions(
        classes=active_service.action_model.classes_,
        probabilities=probabilities,
        action_labels=active_service.label_metadata["action_labels"],
        top_k=active_service.feature_config["top_k"],
    )
    quality_prediction = active_service._predict_quality(segment, feature_vector)

    quality_score = (
        float(quality_prediction["quality_score"])
        if quality_prediction is not None and quality_prediction.get("quality_score") is not None
        else None
    )
    overall_score = _clamp_score(quality_score) if quality_score is not None else None
    duration_ms = int(max(0.0, (end_ts - start_ts) * 1000.0))
    note = str(payload_input.get("note") or "").strip()
    summary = (
        f"Detected action {action_label_name}."
        if not note
        else f"Detected action {action_label_name}. Note: {note}"
    )
    quality_level = quality_prediction.get("label") if quality_prediction else ""

    return {
        "overallScore": overall_score,
        "summary": summary,
        "confidence": _clamp_score(float(action_confidence) * 100.0),
        "sensorSession": {
            "frameCount": int(len(frames)),
            "durationMs": duration_ms,
            "predictedActionId": int(action_label_id),
            "predictedAction": action_label_name,
            "actionConfidence": round(float(action_confidence), 4),
            "qualityScore": round(float(quality_score), 2) if quality_score is not None else None,
            "qualityLevel": quality_level,
            "topPredictions": top_predictions,
            "nodesPresent": sorted(sensor_frame["node"].drop_duplicates().tolist()),
            "nodeCompleteness": completeness,
        },
        "modelVersion": "rf_sensor_api_2026_04_10",
    }


service: Optional[RFService] = None
deep_service = DeepModelBridge()
startup_error_message: Optional[str] = None


def _deep_result_to_analysis(result: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
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


def _build_missing_artifacts_message() -> str:
    missing_files = [str(path) for path in REQUIRED_ARTIFACT_PATHS if not path.exists()]
    return (
        "Missing required RF artifacts: "
        f"{missing_files}. "
        f"Default lookup directory: {DEFAULT_MODEL_DIR}. "
        "You can override it with the RF_MODEL_DIR environment variable."
    )


def _require_service() -> RFService:
    if service is not None:
        return service

    if startup_error_message:
        raise HTTPException(status_code=500, detail=startup_error_message)

    raise HTTPException(status_code=500, detail="RF model service is not initialized.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global service, startup_error_message

    service = None
    startup_error_message = None

    # Start MQTT client in background (connects to 82.156.18.205:1883)
    start_mqtt_client()
    deep_service.start()
    if not deep_service.ready:
        startup_error_message = deep_service.error or "CNN-LSTM + LightGBM model is not ready."
    yield
    deep_service.stop()
    stop_mqtt_client()


app = FastAPI(
    title="Skating CNN-LSTM + LightGBM API",
    version="1.0.0",
    description=(
        "9-node skating action recognition and quality classification API.\n\n"
        "Quality output keeps the 4-class label and also returns a continuous `quality_score`.\n"
        "The score is not a direct regression target. It is computed from class probabilities as:\n"
        "`sum(probability_i * representative_score_i)`.\n\n"
        "Representative scores:\n"
        "- Fail: 29.5\n"
        "- Mid: 67.0\n"
        "- Good: 82.0\n"
        "- Excellent: 95.0"
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
    handlers=[
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


@app.middleware("http")
async def log_requests(request, call_next):
    start_time = time.time()
    logger.info(f"Request: {request.method} {request.url.path}")
    try:
        response = await call_next(request)
        process_time = time.time() - start_time
        logger.info(f"Response: {response.status_code} {request.method} {request.url.path} completed in {process_time:.3f}s")
        return response
    except Exception as exc:
        process_time = time.time() - start_time
        logger.error(f"Error: {request.method} {request.url.path} failed in {process_time:.3f}s - {exc}")
        raise


@app.get("/health")
async def health():
    mqtt_status = get_mqtt_status()
    inference_ready = deep_service.ready
    return {
        "success": inference_ready,
        "message": "service is running" if inference_ready else startup_error_message,
        "primary_model": "cnn_lstm_lightgbm",
        "deep_model_ready": deep_service.ready,
        "deep_model_error": deep_service.error,
        "model_dir": str(MODEL_DIR),
        "action_model_path": str(ACTION_MODEL_PATH),
        "standard_model_path": str(STANDARD_MODEL_PATH) if STANDARD_MODEL_PATH.exists() else None,
        "quality_model_path": str(QUALITY_MODEL_PATH) if QUALITY_MODEL_PATH.exists() else None,
        "quality_model_enabled": bool(QUALITY_MODEL_PATH.exists() and QUALITY_FEATURE_CONFIG_PATH.exists()),
        "sensor_mode": "9node",
        "device_connected": mqtt_status["device_online"],
        "mqtt": mqtt_status,
    }


SENSOR_ROLES = [
    "head", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_knee", "right_knee", "waist", "left_foot", "right_foot",
]


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
        description="Only return frames that were received by the server after this timestamp (Unix ms).",
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
    # Keep the timestamp phase stable across requests. The first requested
    # role is the deterministic 50 Hz clock anchor; other roles are matched
    # one-to-one without reusing samples.
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


@app.post("/frames")
async def collect_frames(request: FramesRequest):
    """Return real sensor frames from the live buffer. Never fall back to mock frames."""
    import asyncio

    request_started = time.monotonic()
    server_now_ms = int(time.time() * 1000)
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

    # If no data yet, fall through to polling
    if len(candidates) == 0:
        mqtt_status = get_mqtt_status()
        device_online = mqtt_status.get("device_online", False)

        if device_online:
            # 50 Hz acquisition needs a polling interval close to the sensor
            # cadence. A 250 ms interval adds up to one extra interval per
            # sequential /frames request and can stretch 30 s to ~47 s.
            poll_interval = 0.05
            max_wait = 10.0
            waited = 0.0
            while waited < max_wait:
                real_frames = get_latest_frames()
                if real_frames is None:
                    real_frames = []
                filtered = filter_unread(real_frames)
                candidates = build_candidates(filtered)
                # frameCount is a response limit, not a minimum batch size.
                # Return as soon as MQTT contributes any new frames so the
                # collector updates at the device's packet cadence.
                if len(candidates) > 0:
                    break
                await asyncio.sleep(poll_interval)
                waited += poll_interval

            # One last attempt after polling
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

    # Without a cursor this is a status/snapshot request, so return the latest
    # data. With a cursor, consume oldest-unread first to avoid skipping backlog.
    selected = candidates[:count] if since_ms is not None else candidates[-count:]

    # Strip internal field and expose as public field
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
    """Dispatch a user-triggered stationary gyro calibration to selected nodes."""
    request_id = str(request.request_id or f"cal_{int(time.time() * 1000)}")
    result = publish_gyro_calibration_command(request.roles, request_id)
    if not result.get("dispatched_roles"):
        raise HTTPException(status_code=503, detail=result)
    return result


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


@app.post(
    "/predict",
    response_model=PredictResponse,
    summary="Predict from uploaded CSV",
    description=(
        "Upload one 9-node sensor CSV and return action prediction, four-class quality level, "
        "and the continuous `quality_score` computed from quality-model probabilities."
    ),
)
async def predict(file: UploadFile = File(..., description="9-node sensor CSV file.")):
    active_service = _require_service()

    filename = file.filename or ""
    if not filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")

    temp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_path = Path(temp_file.name)
            content = await file.read()
            if not content:
                raise HTTPException(status_code=400, detail="Uploaded file is empty")
            temp_file.write(content)

        _validate_sensor_csv_for_api(temp_path)
        result = active_service.infer_csv(temp_path)
        result["filename"] = filename
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await file.close()
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


@app.post(
    "/predict-by-path",
    response_model=PredictResponse,
    summary="Predict from local CSV path",
    description=(
        "Read one local 9-node sensor CSV from disk and return action prediction, four-class quality level, "
        "and the continuous `quality_score` computed from quality-model probabilities."
    ),
)
async def predict_by_path(request: PredictByPathRequest):
    active_service = _require_service()

    csv_path = Path(request.file_path)
    if not csv_path.exists():
        raise HTTPException(status_code=400, detail=f"CSV path does not exist: {csv_path}")
    if csv_path.suffix.lower() != ".csv":
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    if not csv_path.is_file():
        raise HTTPException(status_code=400, detail=f"CSV path is not a file: {csv_path}")

    try:
        _validate_sensor_csv_for_api(csv_path)
        result = active_service.infer_csv(csv_path)
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post(
    "/predict-continuous-json",
    response_model=PredictContinuousJsonResponse,
    summary="Predict from continuous raw JSON frames",
    description=(
        "Accept continuous raw 9-node IMU frames in JSON, perform sliding-window segmentation on the backend, "
        "and return per-segment action type, four-class quality level, and continuous quality_score."
    ),
)
async def predict_continuous_json(request: PredictContinuousJsonRequest):
    active_service = _require_service()

    try:
        return active_service.infer_continuous_json(
            frames=request.frames,
            session_id=request.session_id,
            active_nodes=_normalize_active_nodes(request.active_nodes),
            window_seconds=request.window_seconds,
            step_seconds=request.step_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post(
    "/infer",
    summary="Cloud-function compatible sensor inference endpoint",
    description=(
        "Accepts `{scene, version, input}` payload from the WeChat cloud function and "
        "returns a normalized `analysis` object."
    ),
)
async def infer_for_cloud_function(request: SensorRemoteInferRequest):
    scene = str(request.scene or "").strip()
    if scene and scene != SENSOR_SCENE_NAME:
        raise HTTPException(status_code=400, detail=f"unsupported scene: {scene}")

    try:
        payload = request.input or {}
        completeness = _check_nine_node_completeness(payload.get("frames") or [])
        if not completeness["ok"]:
            raise ValueError(
                "node_incomplete: complete frame ratio "
                f"{completeness['ratio']:.3f} is below {completeness['threshold']:.3f}"
            )
        if not deep_service.ready:
            raise RuntimeError(deep_service.error or "CNN-LSTM + LightGBM model is not ready")
        analysis = _deep_result_to_analysis(deep_service.predict(payload), payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "success": True,
        "analysis": analysis,
    }
