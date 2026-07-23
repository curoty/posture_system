"""
MQTT client for receiving real-time sensor frame data from hardware sensors.

Supports two data sources:
1. JSON format on sensor/imu/frames and sensor/imu/heartbeat (preferred)
2. ESP32 custom text format on esp32/sensor/data1 and esp32/sensor/data2

The ESP32 firmware (mqt.ino) publishes:
  data1: "MAC:xx:xx|HOST:ax,ay,az,gx,gy,gz|1A:...|1B:...|2A:..."
  data2: "|2B:...|3A:...|3B:...|4A:...|4B:..."

These two messages are combined into a frame. The current capture layout uses
5 IMU nodes (waist, bilateral elbows and bilateral knees); the inference model
remains a separate 9-node contract.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

_LOGGER = logging.getLogger(__name__)

# ── MQTT configuration from environment ──────────────────────────────────
MQTT_BROKER: str = os.getenv("MQTT_BROKER", "82.156.18.205")
MQTT_PORT: int = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USERNAME: str = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD: str = os.getenv("MQTT_PASSWORD", "")
MQTT_TOPIC_FRAMES: str = os.getenv("MQTT_TOPIC_FRAMES", "sensor/imu/frames")
MQTT_TOPIC_HEARTBEAT: str = os.getenv("MQTT_TOPIC_HEARTBEAT", "sensor/imu/heartbeat")
MQTT_TOPIC_COMMAND_PREFIX: str = os.getenv(
    "MQTT_TOPIC_COMMAND_PREFIX", "sensor/imu/commands"
)
MQTT_CONNECT_TIMEOUT: int = int(os.getenv("MQTT_CONNECT_TIMEOUT", "10"))
MQTT_HEARTBEAT_TIMEOUT: int = int(os.getenv("MQTT_HEARTBEAT_TIMEOUT", "30"))  # seconds

# ESP32 custom format topics (mqt.ino firmware)
MQTT_TOPIC_ESP32_DATA1: str = os.getenv("MQTT_TOPIC_ESP32_DATA1", "esp32/sensor/data1")
MQTT_TOPIC_ESP32_DATA2: str = os.getenv("MQTT_TOPIC_ESP32_DATA2", "esp32/sensor/data2")

# Map ESP32 node IDs to sensor body-part roles.
# Default physical placement for the original 9-node layout plus waist.
# It can still be overridden with MQTT_ESP32_NODE_MAP without changing code.
# Adjust this mapping if the physical placement differs.
ESP32_NODE_ROLE_MAP: Dict[str, str] = {
    "HOST": "head",
    "1A": "left_elbow",
    "1B": "right_elbow",
    "2A": "left_wrist",
    "2B": "right_wrist",
    "3A": "left_knee",
    "3B": "right_knee",
    "4A": "left_foot",
    "4B": "right_foot",
    "WAIST": "waist",
    "9": "waist",
}
# Override from environment variable as JSON, e.g.:
#   MQTT_ESP32_NODE_MAP='{"1A":"left_elbow","1B":"right_elbow",...}'
_env_node_map = os.getenv("MQTT_ESP32_NODE_MAP", "").strip()
if _env_node_map:
    try:
        parsed = json.loads(_env_node_map)
        if isinstance(parsed, dict):
            ESP32_NODE_ROLE_MAP.update(parsed)
            _LOGGER.info("ESP32 node map updated from env: %s", ESP32_NODE_ROLE_MAP)
    except (json.JSONDecodeError, TypeError):
        _LOGGER.warning("Invalid MQTT_ESP32_NODE_MAP env var, using defaults")

# Regex to parse node data: "NODE_NAME:ax,ay,az,gx,gy,gz"
_NODE_RE = re.compile(r"\|?([A-Za-z0-9_]+):([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)")

# ── Frame buffer config ──────────────────────────────────────────────────
# Four independent 50 Hz nodes produce 200 raw frames/s. Keep one minute of
# headroom so foreground pauses and cloud chunk writes do not overwrite unread
# samples.
MAX_BUFFERED_FRAMES: int = int(os.getenv("MQTT_MAX_BUFFERED_FRAMES", "12000"))

# ── In-memory state ──────────────────────────────────────────────────────
latest_frames_payload: Optional[Dict[str, Any]] = None
latest_frames_received_at: float = 0.0
latest_heartbeat_at: float = 0.0
mqtt_connected: bool = False
mqtt_error: Optional[str] = None

# Rolling frame buffer — new frames are appended, oldest dropped at MAX_BUFFERED_FRAMES
_frame_buffer: List[dict] = []
_frame_buffer_lock = threading.Lock()
_last_server_received_ms: int = 0

# Buffer for combining ESP32 data1 + data2 messages
_esp32_data1_buffer: Optional[str] = None
_esp32_data1_time: float = 0.0

_lock = threading.Lock()
_client_instance: Any = None


def _parse_esp32_text(payload: str) -> Optional[dict]:
    """Parse ESP32 custom text format into a frame dict.

    Input: "MAC:xx:xx|HOST:ax,ay,az,gx,gy,gz|1A:ax,ay,az,gx,gy,gz|..."
    Returns: {"t": <ms_timestamp>, "points": {role: {ax,ay,az,gx,gy,gz}, ...}}
    """
    now_ms = int(time.time() * 1000)
    points = {}

    for match in _NODE_RE.finditer(payload):
        node_id = match.group(1)
        if node_id == "MAC":
            continue  # skip MAC field
        values = []
        for i in range(2, 8):
            try:
                values.append(float(match.group(i)))
            except (ValueError, TypeError):
                values.append(0.0)

        role = ESP32_NODE_ROLE_MAP.get(node_id)
        if role:
            points[role] = {
                "ax": round(values[0], 2),
                "ay": round(values[1], 2),
                "az": round(values[2], 2),
                "gx": round(values[3], 3),
                "gy": round(values[4], 3),
                "gz": round(values[5], 3),
            }

    if not points:
        return None

    return {"t": now_ms, "points": points}


def _push_frame(frame: dict) -> None:
    """Push a frame into the rolling buffer with server receive timestamp, dropping oldest if at capacity."""
    global _last_server_received_ms
    stored = dict(frame)
    with _frame_buffer_lock:
        # The client uses this value as a strict `>` cursor. Wall-clock
        # milliseconds can collide for adjacent MQTT batches, so make the
        # internal receive cursor strictly monotonic.
        now_ms = int(time.time() * 1000)
        _last_server_received_ms = max(now_ms, _last_server_received_ms + 1)
        stored["_server_received_ms"] = _last_server_received_ms
        _frame_buffer.append(stored)
        if len(_frame_buffer) > MAX_BUFFERED_FRAMES:
            _frame_buffer.pop(0)


def _push_frames(frames: List[dict]) -> int:
    """Push multiple frames into the rolling buffer with server receive timestamps."""
    global _last_server_received_ms
    valid_frames = [
        frame
        for frame in (frames or [])
        if isinstance(frame, dict) and isinstance(frame.get("points"), dict)
    ]
    if not valid_frames:
        return 0
    with _frame_buffer_lock:
        now_ms = int(time.time() * 1000)
        # All samples in one MQTT packet are consumed together, so they share
        # one receive cursor. Only adjacent packets need distinct cursors.
        _last_server_received_ms = max(now_ms, _last_server_received_ms + 1)
        batch_received_ms = _last_server_received_ms
        stored_frames = []
        for frame in valid_frames:
            stored = dict(frame)
            stored["_server_received_ms"] = batch_received_ms
            stored_frames.append(stored)
        _frame_buffer.extend(stored_frames)
        overflow = max(0, len(_frame_buffer) - MAX_BUFFERED_FRAMES)
        if overflow > 0:
            del _frame_buffer[:overflow]
        return len(valid_frames)


def _expand_compact_frames(
    frames: List[Any],
    device_id: str,
    source: str = "",
    calibration: Optional[Dict[str, Any]] = None,
    filter_status: str = "",
) -> List[dict]:
    """Expand compact single-node MQTT arrays into normal frame objects."""
    node_name = str(source or "").strip().lower()
    if node_name.endswith("_imu_test"):
        node_name = node_name[:-len("_imu_test")]
    valid_nodes = {
        "waist", "left_ankle", "right_ankle", "left_knee", "right_knee",
    }
    if node_name not in valid_nodes:
        node_name = "waist"
    expanded: List[dict] = []
    for item in frames or []:
        if isinstance(item, dict):
            expanded.append(item)
            continue
        if not isinstance(item, list) or len(item) < 11:
            continue
        uptime_ms, unix_ts_ms, time_synced, seq, temperature_c = item[:5]
        ax, ay, az, gx, gy, gz = item[5:11]
        timestamp = unix_ts_ms if time_synced else uptime_ms
        expanded_frame = {
            "device_id": device_id,
            "t": timestamp,
            "uptime_ms": uptime_ms,
            "unix_ts_ms": unix_ts_ms,
            "time_synced": bool(time_synced),
            "seq": seq,
            "temperature_c": temperature_c,
            "points": {
                node_name: {
                    "ax": ax, "ay": ay, "az": az,
                    "gx": gx, "gy": gy, "gz": gz,
                    "temperature_c": temperature_c,
                }
            },
        }
        if isinstance(calibration, dict):
            expanded_frame["calibration"] = dict(calibration)
        if filter_status:
            expanded_frame["filter_status"] = str(filter_status)
        expanded.append(expanded_frame)
    return expanded


def push_uploaded_frame(frame: dict, source: str = "http") -> bool:
    """Push one HTTP-uploaded frame and mark live data as recently received."""
    global latest_frames_payload, latest_frames_received_at

    if not isinstance(frame, dict) or not isinstance(frame.get("points"), dict) or not frame["points"]:
        return False

    _push_frame(frame)
    with _lock:
        latest_frames_payload = {
            "frames": [frame],
            "source": source,
            "total_available": len(_frame_buffer),
        }
        latest_frames_received_at = time.time()
    return True


def _handle_esp32_message(topic: str, payload_str: str) -> None:
    """Handle ESP32 custom format messages, buffering data1+data2."""
    global latest_frames_payload, latest_frames_received_at, _esp32_data1_buffer, _esp32_data1_time

    if topic == MQTT_TOPIC_ESP32_DATA1:
        # Store data1, wait for data2
        _esp32_data1_buffer = payload_str
        _esp32_data1_time = time.time()
        return

    if topic == MQTT_TOPIC_ESP32_DATA2:
        # Combine with buffered data1
        combined = payload_str
        if _esp32_data1_buffer is not None and (time.time() - _esp32_data1_time) < 1.0:
            combined = _esp32_data1_buffer + payload_str
            _esp32_data1_buffer = None

        frame = _parse_esp32_text(combined)
        if frame is not None:
            # Push into rolling buffer (keeps last MAX_BUFFERED_FRAMES)
            _push_frame(frame)
            # Keep backwards-compat latest_frames_payload
            payload = {"frames": [frame], "source": "mqtt", "total_available": 1}
            latest_frames_payload = payload
            latest_frames_received_at = time.time()
            role_count = len(frame.get("points", {}))
            _LOGGER.info("Received ESP32 frame: %d roles, ts=%d, buffer=%d",
                         role_count, frame["t"], len(_frame_buffer))


def _on_connect(client, userdata, flags, rc):
    global mqtt_connected, mqtt_error
    with _lock:
        if rc == 0:
            mqtt_connected = True
            mqtt_error = None
            _LOGGER.info("MQTT connected to %s:%d", MQTT_BROKER, MQTT_PORT)
            # Subscribe to standard JSON topics
            client.subscribe(MQTT_TOPIC_FRAMES, qos=0)
            client.subscribe(MQTT_TOPIC_HEARTBEAT, qos=0)
            # Subscribe to ESP32 custom format topics
            client.subscribe(MQTT_TOPIC_ESP32_DATA1, qos=0)
            client.subscribe(MQTT_TOPIC_ESP32_DATA2, qos=0)
        else:
            mqtt_connected = False
            mqtt_error = f"connection_failed_rc={rc}"
            _LOGGER.warning("MQTT connect failed with rc=%d", rc)


def _on_disconnect(client, userdata, rc):
    global mqtt_connected
    with _lock:
        mqtt_connected = False
    if rc != 0:
        _LOGGER.warning("MQTT disconnected unexpectedly rc=%d", rc)


def _on_message(client, userdata, msg):
    global latest_frames_payload, latest_frames_received_at, latest_heartbeat_at
    topic = msg.topic
    try:
        payload_str = msg.payload.decode("utf-8")

        # --- Handle ESP32 custom text format ---
        if topic in (MQTT_TOPIC_ESP32_DATA1, MQTT_TOPIC_ESP32_DATA2):
            with _lock:
                _handle_esp32_message(topic, payload_str)
            return

        # --- Handle standard JSON format ---
        data = json.loads(payload_str)
        with _lock:
            if topic == MQTT_TOPIC_HEARTBEAT:
                latest_heartbeat_at = time.time()
            elif topic == MQTT_TOPIC_FRAMES:
                latest_frames_payload = data
                latest_frames_received_at = time.time()
                pushed = 0
                if isinstance(data, dict):
                    raw_frames = data.get("frames", [])
                    if isinstance(raw_frames, list):
                        raw_frames = _expand_compact_frames(
                            raw_frames,
                            str(data.get("device_id", "")),
                            str(data.get("source", "")),
                            data.get("calibration"),
                            str(data.get("filter_status", "")),
                        )
                        pushed = _push_frames(raw_frames)
                _LOGGER.debug(
                    "Received %d frames from MQTT topic %s, pushed=%d, buffer=%d",
                    len(data.get("frames", [])) if isinstance(data, dict) else 0,
                    topic,
                    pushed,
                    len(_frame_buffer),
                )
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        _LOGGER.warning("Failed to decode MQTT message on %s: %s", topic, exc)


def start_mqtt_client() -> None:
    """Start the MQTT client in a daemon thread.

    Safe to call multiple times — only the first call starts the client.
    """
    global _client_instance

    if _client_instance is not None:
        return  # already started

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        _LOGGER.warning("paho-mqtt not installed; MQTT client disabled")
        return

    client = mqtt.Client(client_id="", clean_session=True)
    client.on_connect = _on_connect
    client.on_disconnect = _on_disconnect
    client.on_message = _on_message

    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.connect_async(MQTT_BROKER, MQTT_PORT, keepalive=MQTT_CONNECT_TIMEOUT)
    client.loop_start()

    _client_instance = client
    _LOGGER.info("MQTT client started, connecting to %s:%d ...", MQTT_BROKER, MQTT_PORT)


def stop_mqtt_client() -> None:
    """Stop the MQTT client gracefully."""
    global _client_instance
    if _client_instance is not None:
        try:
            _client_instance.loop_stop()
            _client_instance.disconnect()
        except Exception:
            pass
        _client_instance = None
        _LOGGER.info("MQTT client stopped")


def get_mqtt_status() -> dict:
    """Return a snapshot of the current MQTT connection and data state."""
    with _lock:
        now = time.time()
        seconds_since_heartbeat = now - latest_heartbeat_at if latest_heartbeat_at > 0 else None
        seconds_since_frames = now - latest_frames_received_at if latest_frames_received_at > 0 else None
        device_online = (
            latest_frames_received_at > 0
            and seconds_since_frames is not None
            and seconds_since_frames < MQTT_HEARTBEAT_TIMEOUT
        )
        return {
            "mqtt_connected": mqtt_connected,
            "device_online": device_online,
            "error": mqtt_error,
            "broker": f"{MQTT_BROKER}:{MQTT_PORT}",
            "topics": [MQTT_TOPIC_FRAMES, MQTT_TOPIC_HEARTBEAT, MQTT_TOPIC_ESP32_DATA1, MQTT_TOPIC_ESP32_DATA2],
            "last_heartbeat_seconds_ago": round(seconds_since_heartbeat, 1) if seconds_since_heartbeat is not None else None,
            "last_frames_seconds_ago": round(seconds_since_frames, 1) if seconds_since_frames is not None else None,
            "buffered_frames": len(_frame_buffer),
        }


def publish_gyro_command(
    roles: List[str], request_id: str, command: str
) -> Dict[str, Any]:
    """Publish one gyro-calibration lifecycle command per selected node."""
    topic_role = {
        "waist": "waist",
        "left_knee": "left_knee",
        "right_knee": "right_knee",
        "left_foot": "left_ankle",
        "right_foot": "right_ankle",
        "left_ankle": "left_ankle",
        "right_ankle": "right_ankle",
    }
    requested = list(dict.fromkeys(str(role).strip() for role in roles if role))
    unsupported = [role for role in requested if role not in topic_role]
    dispatched: List[str] = []
    failed: Dict[str, str] = {}
    client = _client_instance
    if client is None or not mqtt_connected:
        return {
            "success": False,
            "message": "mqtt_not_connected",
            "dispatched_roles": dispatched,
            "unsupported_roles": unsupported,
            "failed_roles": failed,
        }
    if command not in {"calibrate_gyro", "clear_gyro_calibration"}:
        raise ValueError(f"unsupported gyro command: {command}")
    payload = json.dumps(
        {"command": command, "request_id": str(request_id)},
        separators=(",", ":"),
    )
    for role in requested:
        if role not in topic_role:
            continue
        result = client.publish(
            f"{MQTT_TOPIC_COMMAND_PREFIX}/{topic_role[role]}",
            payload=payload,
            qos=1,
            retain=False,
        )
        if int(getattr(result, "rc", 1)) == 0:
            dispatched.append(role)
        else:
            failed[role] = f"publish_rc={getattr(result, 'rc', 'unknown')}"
    return {
        "success": bool(dispatched) and not failed,
        "request_id": str(request_id),
        "dispatched_roles": dispatched,
        "unsupported_roles": unsupported,
        "failed_roles": failed,
    }


def publish_gyro_calibration_command(
    roles: List[str], request_id: str
) -> Dict[str, Any]:
    return publish_gyro_command(roles, request_id, "calibrate_gyro")


def publish_clear_gyro_calibration_command(
    roles: List[str], request_id: str
) -> Dict[str, Any]:
    return publish_gyro_command(roles, request_id, "clear_gyro_calibration")


def get_latest_frames() -> Optional[List[dict]]:
    """Return the latest frames from the rolling buffer, or None if no data yet."""
    with _frame_buffer_lock:
        if len(_frame_buffer) == 0:
            return None
        return list(_frame_buffer)  # return a copy


def get_active_roles() -> Optional[List[str]]:
    """Return roles that have data in the last 30 seconds.

    Used by calibration to only target nodes that are actually live.
    """
    cutoff = time.time() - 30.0
    active = set()
    with _frame_buffer_lock:
        for frame in _frame_buffer:
            server_ms = frame.get("_server_received_ms", 0)
            if server_ms / 1000.0 < cutoff:
                continue
            points = frame.get("points")
            if isinstance(points, dict):
                for role, data in points.items():
                    if isinstance(data, dict) and any(
                        isinstance(data.get(k), (int, float)) and abs(float(data[k])) > 1e-9
                        for k in ("ax", "ay", "az", "gx", "gy", "gz")
                    ):
                        active.add(role)
    return list(active) if active else None
