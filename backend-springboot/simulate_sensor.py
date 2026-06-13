"""
模拟传感器硬件，向 MQTT Broker 发布滑冰姿态 IMU 数据
使用方式:
    python simulate_sensor.py              # 默认: 1帧/20ms, topic=posture/device/SIM-001/raw
    python simulate_sensor.py --fps 10     # 每秒 10 帧
    python simulate_sensor.py --mac AA:BB:CC:DD:EE:FF --fps 50  # 自定义 MAC 和帧率
    python simulate_sensor.py --duration 30  # 运行 30 秒后自动停止
    Ctrl+C 停止
"""
import paho.mqtt.client as mqtt
import time
import math
import random
import argparse
import sys

BROKER = "82.156.18.205"
PORT = 1883

# 9 个传感器节点及其 6 通道 IMU 数据 (accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z)
# 模拟简单的周期性动作波形
SENSOR_NODES = ["HOST", "1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B"]

# 每个节点的基础值 + 振幅 (让数据看起来像真实的运动，而非纯噪声)
NODE_PARAMS = {
    "HOST": {"bx": 0.0, "by": 0.0, "bz": 9.8, "gx": 0.0, "gy": 0.0, "gz": 0.0, "amp_a": 0.2, "amp_g": 0.05},
    "1A":  {"bx": 0.5, "by": -0.3, "bz": 9.5, "gx": 0.1, "gy": -0.2, "gz": 0.05, "amp_a": 0.4, "amp_g": 0.2},
    "1B":  {"bx": 0.6, "by": -0.4, "bz": 9.3, "gx": 0.15, "gy": -0.3, "gz": 0.08, "amp_a": 0.5, "amp_g": 0.3},
    "2A":  {"bx": -0.5, "by": -0.3, "bz": 9.5, "gx": -0.1, "gy": -0.2, "gz": -0.05, "amp_a": 0.4, "amp_g": 0.2},
    "2B":  {"bx": -0.6, "by": -0.4, "bz": 9.3, "gx": -0.15, "gy": -0.3, "gz": -0.08, "amp_a": 0.5, "amp_g": 0.3},
    "3A":  {"bx": 0.3, "by": 0.2, "bz": 9.6, "gx": 0.05, "gy": 0.1, "gz": 0.02, "amp_a": 0.3, "amp_g": 0.15},
    "3B":  {"bx": 0.2, "by": 0.1, "bz": 9.7, "gx": 0.02, "gy": 0.05, "gz": 0.01, "amp_a": 0.25, "amp_g": 0.12},
    "4A":  {"bx": -0.3, "by": 0.2, "bz": 9.6, "gx": -0.05, "gy": 0.1, "gz": -0.02, "amp_a": 0.3, "amp_g": 0.15},
    "4B":  {"bx": -0.2, "by": 0.1, "bz": 9.7, "gx": -0.02, "gy": 0.05, "gz": -0.01, "amp_a": 0.25, "amp_g": 0.12},
}


def generate_imu(node_id, phase, noise=0.02):
    """为指定节点生成 6 通道 IMU 数据 (加速计x3 + 陀螺仪x3)"""
    p = NODE_PARAMS[node_id]
    a_amp = p["amp_a"]
    g_amp = p["amp_g"]

    ax = p["bx"] + a_amp * math.sin(phase * 2) + random.gauss(0, noise)
    ay = p["by"] + a_amp * math.cos(phase * 2.5) + random.gauss(0, noise)
    az = p["bz"] + a_amp * math.sin(phase * 1.5) * 0.5 + random.gauss(0, noise)
    gx = p["gx"] + g_amp * math.sin(phase * 3) + random.gauss(0, noise * 0.5)
    gy = p["gy"] + g_amp * math.cos(phase * 2.8) + random.gauss(0, noise * 0.5)
    gz = p["gz"] + g_amp * math.sin(phase * 3.5) + random.gauss(0, noise * 0.5)

    return f"{ax:.4f},{ay:.4f},{az:.4f},{gx:.4f},{gy:.4f},{gz:.4f}"


def build_frame(mac, phase, nodes=None):
    """构造一帧完整的传感器数据"""
    if nodes is None:
        nodes = SENSOR_NODES
    parts = [f"MAC:{mac}"]
    for node in nodes:
        parts.append(f"{node}:{generate_imu(node, phase)}")
    return "|".join(parts)


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        print(f"[OK] Connected to {BROKER}:{PORT}")
    else:
        print(f"[FAIL] Connection refused, rc={reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    pass  # 忽略断连日志


def main():
    parser = argparse.ArgumentParser(description="模拟姿态传感器 MQTT 数据发布")
    parser.add_argument("--mac", default="SIM-001", help="设备 MAC 标识 (默认: SIM-001)")
    parser.add_argument("--fps", type=int, default=50, help="每秒帧数 (默认: 50)")
    parser.add_argument("--duration", type=float, default=0, help="运行时长/秒 (默认: 0=无限)")
    parser.add_argument("--topic", default="posture/device/SIM-001/raw", help="MQTT topic")
    parser.add_argument("--head-only", action="store_true", help="仅发送 head 节点数据（用于测试节点完整性校验）")
    args = parser.parse_args()

    interval = 1.0 / args.fps
    topic = f"posture/device/{args.mac}/raw"
    nodes = ["HOST"] if args.head_only else SENSOR_NODES

    print(f"Simulated Sensor Publisher")
    print(f"Broker: {BROKER}:{PORT}")
    print(f"Topic:  {topic}")
    print(f"MAC:    {args.mac}")
    print(f"FPS:    {args.fps}  (interval={interval*1000:.0f}ms)")
    print(f"Sensors: {len(nodes)} nodes x 6 channels = {len(nodes)*6} values/frame")
    print(f"Est. data rate: ~{len(nodes)*6*4*args.fps/1024:.0f} KB/s")
    if args.duration > 0:
        print(f"Duration: {args.duration}s")
    print(f"{'='*60}")
    print("Press Ctrl+C to stop\n")

    client = mqtt.Client(
        client_id=f"sim-{args.mac}",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    import socket
    socket.setdefaulttimeout(10)
    client.connect(BROKER, PORT, keepalive=30)
    client.loop_start()

    start_time = time.time()
    frame_count = 0

    try:
        while True:
            phase = frame_count * 0.02 * math.pi  # 每帧约 0.02 弧度相位增量
            payload = build_frame(args.mac, phase, nodes)
            client.publish(topic, payload, qos=1)
            frame_count += 1

            # 每秒打印一次统计
            elapsed = time.time() - start_time
            if frame_count % args.fps == 0:
                print(f"[{elapsed:6.1f}s] Published {frame_count} frames "
                      f"({frame_count/elapsed:.0f} fps)" if elapsed > 0 else f"[{elapsed:6.1f}s] {frame_count} frames")

            if args.duration > 0 and elapsed >= args.duration:
                print(f"\nDuration reached ({args.duration}s), stopping.")
                break

            # 控制发送速率
            sleep_time = interval - (time.time() - start_time - frame_count * interval)
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        print("\n\nStopped by user.")
    finally:
        client.loop_stop()
        elapsed = time.time() - start_time
        print(f"Done. {frame_count} frames in {elapsed:.1f}s "
              f"(avg {frame_count/elapsed:.0f} fps)" if elapsed > 0 else "")
        client.disconnect()


if __name__ == "__main__":
    main()
