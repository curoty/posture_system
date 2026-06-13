"""
MQTT 连通性测试脚本
连接云服务器 broker，订阅 posture/device/+/raw，打印并解析接收到的数据
"""
import paho.mqtt.client as mqtt
import socket
import time
import sys

BROKER = "82.156.18.205"
PORT = 1883
TOPIC = "posture/device/+/raw"
CLIENT_ID = "mqtt-test-script"

SENSOR_MAP = {
    "head": "head", "HOST": "head",
    "1A": "left_elbow",   "1B": "left_wrist",
    "2A": "right_elbow",  "2B": "right_wrist",
    "3A": "left_knee",    "3B": "left_foot",
    "4A": "right_knee",   "4B": "right_foot",
}

STATS = {"count": 0, "bytes": 0, "errors": 0, "start": time.time()}


def parse_frame(raw_text):
    frames = []
    lines = raw_text.strip().split("\n")
    if len(lines) == 1:
        lines = raw_text.strip().split("(?=MAC:)")

    for line in lines:
        line = line.strip().rstrip("|")
        if not line:
            continue
        mac = None
        sensors = {}
        for segment in line.split("|"):
            if ":" not in segment:
                continue
            key, _, value = segment.partition(":")
            key, value = key.strip(), value.strip()
            if key.upper() == "MAC":
                mac = value
                continue
            mapped = SENSOR_MAP.get(key)
            if not mapped:
                continue
            try:
                imu = [float(x.strip()) for x in value.split(",")]
            except ValueError:
                continue
            if len(imu) != 6:
                continue
            sensors[mapped] = imu
        if mac and sensors:
            frames.append({"mac": mac, "sensors": sensors})
    return frames


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        print(f"[OK] Connected to {BROKER}:{PORT}")
        client.subscribe(TOPIC)
        print(f"[OK] Subscribed: {TOPIC}")
        print("Waiting for data... (Ctrl+C to stop)\n")
    else:
        reason_map = {
            1: "incorrect protocol version",
            2: "invalid client id",
            3: "server unavailable",
            4: "bad username/password",
            5: "not authorized",
        }
        msg = reason_map.get(reason_code, f"unknown reason")
        print(f"[FAIL] Connection refused: {msg} (rc={reason_code})")


def on_connect_fail(client, userdata):
    print("[FAIL] Connect failed - broker unreachable or network issue")


def on_disconnect(client, userdata, reason_code, properties=None):
    print(f"[INFO] Disconnected (rc={reason_code})")


def on_message(client, userdata, msg):
    STATS["count"] += 1
    STATS["bytes"] += len(msg.payload)
    elapsed = time.time() - STATS["start"]
    raw = msg.payload.decode("utf-8", errors="replace")

    print(f"\n{'='*60}")
    print(f"[#{STATS['count']}] Topic: {msg.topic}  ({elapsed:.1f}s)")
    print(f"QoS: {msg.qos}  |  Size: {len(msg.payload)} bytes")
    print(f"{'='*60}")

    if len(raw) > 500:
        print(f"RAW: {raw[:500]}...")
    else:
        print(f"RAW: {raw}")

    frames = parse_frame(raw)
    if frames:
        print(f"\nParsed {len(frames)} frame(s):")
        for i, f in enumerate(frames):
            names = " ".join(f["sensors"].keys())
            print(f"  Frame {i+1}: MAC={f['mac']}, sensors=[{names}]")
            for name, values in f["sensors"].items():
                print(f"    {name:>14}: {values}")
    else:
        STATS["errors"] += 1
        print("  [WARN] Could not parse any frames")


def main():
    print(f"MQTT Test - Broker: {BROKER}:{PORT}")
    print(f"Topic: {TOPIC}")
    print(f"{'='*60}")

    client = mqtt.Client(
        client_id=CLIENT_ID,
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        clean_session=True,
    )
    client.on_connect = on_connect
    client.on_connect_fail = on_connect_fail
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    # 设置连接超时 (socket 层)
    socket.setdefaulttimeout(10)

    print("Connecting...")
    try:
        client.connect(BROKER, PORT, keepalive=30)
    except (socket.timeout, OSError) as e:
        print(f"[FAIL] Connection timeout/unreachable: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"[FAIL] {e}")
        sys.exit(1)

    client.loop_start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        client.loop_stop()
        elapsed = time.time() - STATS["start"]
        print(f"Done. {STATS['count']} msgs, {STATS['bytes']} bytes, "
              f"{STATS['errors']} errors in {elapsed:.1f}s")
        client.disconnect()


if __name__ == "__main__":
    main()
