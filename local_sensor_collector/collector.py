#!/usr/bin/env python
"""
collector.py — 本地传感器数据采集器（主入口）
=================================================
纯 Python，可在 PyCharm 中直接运行。
不需要微信小程序、不需要云函数、不需要云数据库。

数据源:
  - MQTT (ESP32 传感器节点发布到 82.156.18.205:1883)
  - 模拟数据（无硬件时用于验证）

处理管线:
  原始帧 → 时间戳标准化 → 去重 → 多节点对齐 → 试验台零偏校正 → 本地 JSONL 储存

用法:
  python collector.py                   # 交互模式
  python collector.py --oneshot 300     # 一键采集 300 帧后保存退出
  python collector.py --mock 350        # 用模拟数据采集 350 帧（7秒×50fps）

虚拟环境:
  D:\\py_project\\new_competition\\.venv\\Scripts\\python.exe collector.py
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

# 确保能找到本项目模块
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from local_sensor_collector.processor import (
    process_raw_frames,
    filter_physical_outliers,
    get_bench_profiles,
)
from local_sensor_collector.storage import get_storage

# ─── 日志配置 ────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
_LOGGER = logging.getLogger("collector")

# ─── MQTT ────────────────────────────────────────────────────────────────
MQTT_BROKER = os.getenv("MQTT_BROKER", "82.156.18.205")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC_FRAMES = os.getenv("MQTT_TOPIC_FRAMES", "sensor/imu/frames")
MQTT_TOPIC_ESP32_DATA1 = os.getenv("MQTT_TOPIC_ESP32_DATA1", "esp32/sensor/data1")
MQTT_TOPIC_ESP32_DATA2 = os.getenv("MQTT_TOPIC_ESP32_DATA2", "esp32/sensor/data2")

# ─── 5 节点配置 ──────────────────────────────────────────────────────────
LOWER_BODY_5_ROLES = ["waist", "left_knee", "right_knee", "left_foot", "right_foot"]

# ─── 模拟节点 MAC 到角色的映射 ───────────────────────────────────────────
ESP32_NODE_ROLE_MAP = {
    "HOST": "waist",
    "WAIST": "waist",
    "9": "waist",
    "1A": "left_knee",
    "1B": "right_knee",
    "2A": "left_foot",
    "2B": "right_foot",
    "3A": "left_knee",
    "3B": "right_knee",
    "4A": "left_foot",
    "4B": "right_foot",
}

# ─── 全局采集状态 ───────────────────────────────────────────────────────
_collecting = False
_collected_raw_frames: List[Dict[str, Any]] = []
_collect_target = 0
_collect_start_ms: int = 0
_mqtt_client = None
_mqtt_intentional_disconnect = False  # 抑制主动断开的日志


# ═══════════════════════════════════════════════════════════════════════════
# 模拟数据（无硬件时用）
# ═══════════════════════════════════════════════════════════════════════════

def generate_mock_frames(count: int = 350) -> List[Dict[str, Any]]:
    """生成 5 节点模拟 IMU 数据（50Hz，正弦波模式）。"""
    import math as _math
    frames = []
    now_ms = int(time.time() * 1000)
    for i in range(count):
        t = now_ms + i * 20
        points = {}
        for ri, role in enumerate(LOWER_BODY_5_ROLES):
            phase = i * 0.3 + ri * 1.2
            points[role] = {
                "ax": round(_math.sin(phase) * 0.5 + 0.2, 3),
                "ay": round(_math.cos(phase * 0.7) * 0.3 + 0.1, 3),
                "az": round(_math.sin(phase * 0.5) * 0.4 + 0.98, 3),
                "gx": round(_math.sin(phase * 0.9) * 15 + 2, 3),
                "gy": round(_math.cos(phase * 0.6) * 12 - 1, 3),
                "gz": round(_math.sin(phase * 0.8) * 10 + 0.5, 3),
            }
        frames.append({"t": t, "unix_ts_ms": t, "time_synced": True,
                        "points": points})
    return frames


# ═══════════════════════════════════════════════════════════════════════════
# MQTT 采集
# ═══════════════════════════════════════════════════════════════════════════

def _start_mqtt() -> Any:
    """启动 MQTT 客户端并订阅传感器主题。"""
    global _mqtt_client
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        _LOGGER.error("请先安装 paho-mqtt: pip install paho-mqtt")
        return None

    def on_connect(client, userdata, flags, rc):
        if rc == 0:
            _LOGGER.info("MQTT 已连接 %s:%d", MQTT_BROKER, MQTT_PORT)
            client.subscribe(MQTT_TOPIC_FRAMES, qos=0)
            client.subscribe(MQTT_TOPIC_ESP32_DATA1, qos=0)
            client.subscribe(MQTT_TOPIC_ESP32_DATA2, qos=0)
        else:
            _LOGGER.error("MQTT 连接失败, rc=%d", rc)

    def on_message(client, userdata, msg):
        global _collected_raw_frames, _collecting
        try:
            if not _collecting:
                return

            topic = msg.topic
            payload_str = msg.payload.decode("utf-8", errors="replace")

            parsed = _parse_mqtt_message(topic, payload_str)
            if parsed:
                _collected_raw_frames.extend(parsed)
                total_raw = len(_collected_raw_frames)

                # 每 125 帧（5节点×25帧/包）刷新一次进度
                if total_raw % 125 < 25 or total_raw >= _collect_target:
                    _print_progress()
        except Exception:
            _LOGGER.debug("MQTT on_message 异常", exc_info=True)

    def on_disconnect(client, userdata, rc):
        global _mqtt_intentional_disconnect
        if _mqtt_intentional_disconnect:
            return
        _LOGGER.warning("MQTT 连接断开, rc=%d (自动重连已启用)", rc)

    client = mqtt.Client(
        client_id=f"local_collector_{int(time.time())}",
        protocol=mqtt.MQTTv311,
    )
    # 启用自动重连，最小1秒，最大30秒间隔
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect
    client.connect_async(MQTT_BROKER, MQTT_PORT, keepalive=30)
    client.loop_start()
    _mqtt_client = client
    _LOGGER.info("MQTT 客户端已启动，正在连接 %s:%d ...", MQTT_BROKER, MQTT_PORT)
    return client


def _stop_mqtt() -> None:
    """停止 MQTT 客户端。"""
    global _mqtt_client, _mqtt_intentional_disconnect
    if _mqtt_client:
        _mqtt_intentional_disconnect = True
        _mqtt_client.loop_stop()
        _mqtt_client.disconnect()
        _mqtt_client = None
        _LOGGER.info("MQTT 已断开")


def _parse_mqtt_message(topic: str, payload: str) -> List[Dict[str, Any]]:
    """解析 MQTT 消息为帧列表。

    支持两种格式:
      1. sensor/imu/frames: JSON 格式（紧凑数组，需展开）
      2. esp32/sensor/data1/data2: 管道分隔自定义格式（旧固件）
    """
    import re as _re

    frames = []

    if topic == MQTT_TOPIC_FRAMES:
        try:
            data = json.loads(payload)
            if not isinstance(data, dict):
                return []

            source = str(data.get("source", "") or "").strip().lower()
            device_id = str(data.get("device_id", "") or "").strip()

            # 提取节点名: "waist_imu_test" → "waist", "left_ankle_imu_test" → "left_ankle"
            node_name = source
            if node_name.endswith("_imu_test"):
                node_name = node_name[:-9]  # 去掉 "_imu_test"

            # 映射到标准角色
            ROLE_ALIAS = {
                "waist": "waist", "left_ankle": "left_foot", "right_ankle": "right_foot",
                "left_knee": "left_knee", "right_knee": "right_knee",
            }
            role = ROLE_ALIAS.get(node_name)
            if role is None:
                _LOGGER.warning("未知节点来源 %s, 丢弃", node_name)
                return []

            raw_frames = data.get("frames", [])
            if not isinstance(raw_frames, list):
                return []

            now_ms = int(time.time() * 1000)
            for item in raw_frames:
                if isinstance(item, dict):
                    # 已经是展开格式
                    if isinstance(item.get("points"), dict):
                        frames.append(item)
                    continue
                # 紧凑数组: [uptime_ms, unix_ts_ms, time_synced, seq, temp_c, ax,ay,az,gx,gy,gz]
                if not isinstance(item, list) or len(item) < 11:
                    continue
                uptime_ms = int(item[0])
                unix_ts_ms = int(item[1])
                time_synced = bool(item[2])
                # seq = item[3]
                # temperature_c = item[4]
                ax, ay, az, gx, gy, gz = item[5:11]

                timestamp = unix_ts_ms if time_synced and unix_ts_ms >= 1_700_000_000_000 else (
                    uptime_ms if uptime_ms > 0 else now_ms
                )

                frames.append({
                    "device_id": device_id,
                    "t": timestamp,
                    "unix_ts_ms": unix_ts_ms,
                    "time_synced": time_synced,
                    "sample_rate_hz": 50,
                    "points": {
                        role: {
                            "ax": float(ax), "ay": float(ay), "az": float(az),
                            "gx": float(gx), "gy": float(gy), "gz": float(gz),
                        }
                    },
                })
        except Exception:
            _LOGGER.debug("MQTT JSON 解析失败", exc_info=True)

    elif topic in (MQTT_TOPIC_ESP32_DATA1, MQTT_TOPIC_ESP32_DATA2):
        # 管道分隔自定义格式 (旧固件): "|HOST:ax,ay,az,gx,gy,gz|1A:..."
        node_re = _re.compile(
            r"\|?([A-Za-z0-9_]+):([-\d.]+),([-\d.]+),([-\d.]+),"
            r"([-\d.]+),([-\d.]+),([-\d.]+)"
        )
        points = {}
        for match in node_re.finditer(payload):
            node_id = match.group(1)
            if node_id == "MAC":
                continue
            try:
                values = [float(match.group(i)) for i in range(2, 8)]
            except (ValueError, TypeError):
                continue
            role = ESP32_NODE_ROLE_MAP.get(node_id)
            if role:
                points[role] = {
                    "ax": round(values[0], 3),
                    "ay": round(values[1], 3),
                    "az": round(values[2], 3),
                    "gx": round(values[3], 3),
                    "gy": round(values[4], 3),
                    "gz": round(values[5], 3),
                }
        if points:
            frames.append({
                "t": int(time.time() * 1000),
                "unix_ts_ms": int(time.time() * 1000),
                "time_synced": True,
                "points": points,
            })

    return frames


def _estimate_composite_frames() -> int:
    """从已收集的原始帧估算对齐后的复合帧数 = 最少角色的帧数。"""
    role_counts: Dict[str, int] = {}
    for f in _collected_raw_frames:
        for role in (f.get("points") or {}):
            role_counts[role] = role_counts.get(role, 0) + 1
    if not role_counts:
        return 0
    return min(role_counts.values())


def _print_progress() -> None:
    composite = _estimate_composite_frames()
    target = _collect_target
    pct = min(100, int(composite / max(1, target) * 100))
    elapsed = time.time() - (_collect_start_ms / 1000 if _collect_start_ms else time.time())
    elapsed = max(0.1, elapsed)
    fps = composite / elapsed
    bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
    raw = len(_collected_raw_frames)
    sys.stderr.write(f"\r  复合帧: |{bar}| {composite}/{target}  ({pct}%)  {fps:.0f} 复合fps  原始帧: {raw}")
    sys.stderr.flush()


# ═══════════════════════════════════════════════════════════════════════════
# 采集会话
# ═══════════════════════════════════════════════════════════════════════════

def collect_session(
    frame_count: int = 350,
    use_mock: bool = False,
    roles: Optional[List[str]] = None,
    note: str = "",
    action_type: str = "sensor_session",
) -> Dict[str, Any]:
    """执行一次采集会话。

    参数:
        frame_count: 目标帧数
        use_mock: 使用模拟数据而非真实 MQTT
        roles: 期望的角色列表
        note: 备注
        action_type: 动作类型

    返回:
        {"processed_frames": [...], "stats": {...}}
    """
    global _collecting, _collected_raw_frames, _collect_target, _collect_start_ms

    roles = roles or LOWER_BODY_5_ROLES

    if use_mock:
        print("\n  使用模拟数据...")
        raw_frames = generate_mock_frames(frame_count)
        processed = process_raw_frames(
            raw_frames, roles=roles,
            apply_bias=True, do_dedup=True, do_align=True,
        )
        raw_count = len(raw_frames)
        proc_count = len(processed)
        print(f"  模拟数据: {raw_count} 原始帧 → {proc_count} 处理后帧")
        return {
            "processed_frames": processed,
            "roles": roles,
            "stats": {"raw_count": raw_count, "processed_count": proc_count},
        }

    # ── 真实 MQTT 采集 ──
    # 多收 50 帧缓冲（1秒），防止对齐时节点间时间偏差导致帧丢失
    collect_target = frame_count + 50
    print(f"\n  目标: {frame_count} 复合帧 (采集 {collect_target} 帧缓冲)")
    print(f"  期望节点: {', '.join(roles)}")

    client = _start_mqtt()
    if client is None:
        print("  ❌ MQTT 启动失败")
        return {"processed_frames": [], "roles": roles,
                "stats": {"error": "mqtt_start_failed"}}

    # 等待 MQTT 连接
    time.sleep(2)

    # 清空缓冲
    _collected_raw_frames = []
    _collect_target = collect_target
    _collect_start_ms = int(time.time() * 1000)
    _collecting = True

    print("  采集中... (按 Ctrl+C 提前停止)")
    try:
        # 多收 buffer 帧，确保对齐后足 350
        while _collecting:
            composite = _estimate_composite_frames()
            if composite >= collect_target:
                break
            _print_progress()
            time.sleep(0.2)
    except KeyboardInterrupt:
        print("\n  采集被用户中断")
    finally:
        _collecting = False
        _print_progress()
        print()
        _stop_mqtt()

    raw_frames = list(_collected_raw_frames)
    composite_before = _estimate_composite_frames()
    print(f"\n  原始帧: {len(raw_frames)} | 每节点最少: {composite_before} 帧")

    # 处理管线
    processed = process_raw_frames(
        raw_frames, roles=roles,
        apply_bias=True, do_dedup=True, do_align=True,
    )

    # 物理野值过滤
    filtered = filter_physical_outliers(processed)

    # 修剪到精确的 frame_count 帧（只在有富余时切）
    actual_save = len(filtered)
    if actual_save > frame_count:
        filtered = filtered[:frame_count]
        actual_save = frame_count

    print(f"  去重对齐后: {len(processed)} 帧")
    print(f"  野值过滤后: {len(filtered)} 帧")
    print(f"  最终保存: {actual_save}/{frame_count} 帧")

    return {
        "processed_frames": filtered,
        "roles": roles,
        "stats": {
            "raw_count": len(raw_frames),
            "after_dedup_align": len(processed),
            "after_filter": len(filtered),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
# 交互式菜单
# ═══════════════════════════════════════════════════════════════════════════

def show_bench_info() -> None:
    """显示试验台偏置信息。"""
    profiles = get_bench_profiles()
    print("\n  ── 试验台零偏（V3 raw bench） ──")
    for role, cfg in profiles.items():
        gb = cfg.get("gyro_bias", [0, 0, 0])
        print(f"    {role:15s}  gyro_bias=[{gb[0]:+8.4f}, {gb[1]:+8.4f}, {gb[2]:+8.4f}]")
    print()


def show_samples(storage) -> None:
    """显示已保存的样本列表。"""
    result = storage.list_samples()
    items = result.get("items", [])
    total = result.get("total", 0)
    if not items:
        print("\n  暂无本地样本。\n")
        return
    print(f"\n  ── 本地样本 (共 {total} 条) ──")
    for item in items:
        ok_mark = "✅" if item.get("is_completed") else "⏳"
        print(f"    {ok_mark} [{item['sample_id']}] {item['action_type']:12s}  "
              f"{item['frame_count']:4d} 帧  "
              f"评分 {item['coach_score']:3d}  {item['quality_tag'] or '-':4s}  "
              f"{item.get('created_at', '')[:19]}")
    print()


def interactive_loop() -> None:
    """交互式主菜单。"""
    storage = get_storage()

    print("=" * 60)
    print("  本地传感器数据采集器 v1.0")
    print("  ⚡ 纯 Python · 不依赖云函数/云数据库/微信小程序")
    print("=" * 60)

    while True:
        print("\n  ── 菜单 ──")
        print("    [1] 开始采集（MQTT 真实设备）")
        print("    [2] 开始采集（模拟数据，无硬件可用）")
        print("    [3] 查看试验台偏置")
        print("    [4] 查看本地样本")
        print("    [5] 导出所有样本")
        print("    [q] 退出")
        print()

        choice = input("  请选择: ").strip().lower()

        if choice in ("q", "quit", "exit"):
            print("\n  再见！\n")
            break

        if choice == "1":
            do_collect(storage, use_mock=False)

        elif choice == "2":
            do_collect(storage, use_mock=True)

        elif choice == "3":
            show_bench_info()

        elif choice == "4":
            show_samples(storage)

        elif choice == "5":
            do_export(storage)

        else:
            print("  无效选择，请重新输入。")


def do_collect(storage, use_mock: bool = False) -> None:
    """执行一次采集并保存。"""
    print()

    # 询问帧数
    default_frames = 350
    try:
        inp = input(f"  采集帧数 [默认 {default_frames}]: ").strip()
        frame_count = int(inp) if inp else default_frames
    except ValueError:
        frame_count = default_frames

    # 询问动作类型
    action_types = ["static_standing", "deep_squat", "sensor_session", "basic_skating",
                    "curve_skating", "weight_shift", "side_push_recover", "braking"]
    print(f"  动作类型: {', '.join(f'[{i}] {t}' for i, t in enumerate(action_types))}")
    try:
        inp = input(f"  选择 [默认 0]: ").strip()
        at_idx = int(inp) if inp else 0
        action_type = action_types[at_idx] if 0 <= at_idx < len(action_types) else action_types[0]
    except (ValueError, IndexError):
        action_type = action_types[0]

    # 询问是否完成
    is_ok = input("  是否完成 (y/n) [默认 y]: ").strip().lower()
    is_completed = is_ok in ("", "y", "yes", "是", "1")

    # 询问备注
    note = input("  备注 [可选]: ").strip()

    source = "模拟" if use_mock else "MQTT 真实设备"
    print(f"\n  🚀 开始采集 ({source})...")

    result = collect_session(
        frame_count=frame_count,
        use_mock=use_mock,
        roles=LOWER_BODY_5_ROLES,
        note=note,
        action_type=action_type,
    )

    if not result["processed_frames"]:
        print("\n  ❌ 采集失败，未获取到有效帧\n")
        return

    proc = result["processed_frames"]
    stats = result["stats"]

    print(f"\n  ✅ 采集完成: {len(proc)} 帧")
    print(f"     去重对齐: {stats.get('after_dedup_align', '?')} 帧")
    print(f"     野值过滤: {stats.get('after_filter', '?')} 帧")

    # 询问评分
    print()
    try:
        inp = input("  教练评分 (0-100) [默认 78]: ").strip()
        score = max(0, min(100, int(inp))) if inp else 78
    except ValueError:
        score = 78

    quality_tags = ["不及格", "及格", "良好", "优秀"]
    print(f"  质量标签: {', '.join(f'[{i}] {t}' for i, t in enumerate(quality_tags))}")
    try:
        inp = input(f"  选择 [默认 2]: ").strip()
        qt_idx = int(inp) if inp else 2
        quality_tag = quality_tags[qt_idx] if 0 <= qt_idx < len(quality_tags) else quality_tags[2]
    except (ValueError, IndexError):
        quality_tag = quality_tags[2]

    comment = input("  教练评价 [可选]: ").strip()
    tags_str = input("  标签 (逗号分隔) [可选]: ").strip()
    tags = [t.strip() for t in tags_str.split(",") if t.strip()]

    # 保存
    sample = {
        "action_type": action_type,
        "source_type": "mock" if use_mock else "mqtt",
        "is_completed": is_completed,
        "note": note,
        "roles": LOWER_BODY_5_ROLES,
        "frame_count": len(proc),
        "processed_frames": proc,
        "bench_bias_applied": True,
        "label": {
            "coach_score": score,
            "quality_tag": quality_tag,
            "coach_comment": comment,
            "tags": tags,
        },
    }

    sample_id = storage.save_sample(sample)
    print(f"\n  ✅ 已保存到本地: {sample_id}")
    print(f"     储存目录: {storage.storage_dir}\n")


def do_export(storage) -> None:
    """导出所有样本。"""
    all_samples = storage.export_all()
    if not all_samples:
        print("\n  暂无样本可导出。\n")
        return

    export_path = storage.storage_dir / f"export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(all_samples, f, ensure_ascii=False, indent=2)
    print(f"\n  ✅ 已导出 {len(all_samples)} 条样本到: {export_path}\n")


# ═══════════════════════════════════════════════════════════════════════════
# 命令行入口
# ═══════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(
        description="本地传感器数据采集器 — 纯 Python，不依赖云服务",
    )
    parser.add_argument("--oneshot", type=int, metavar="N",
                        help="一键采集 N 帧真实数据后保存退出")
    parser.add_argument("--mock", type=int, metavar="N",
                        help="用模拟数据采集 N 帧后保存退出")
    parser.add_argument("--action", type=str, default="sensor_session",
                        help="动作类型（默认 sensor_session）")
    parser.add_argument("--note", type=str, default="",
                        help="备注")
    parser.add_argument("--list", action="store_true",
                        help="列出已保存的样本")
    parser.add_argument("--bench", action="store_true",
                        help="查看试验台偏置信息")
    parser.add_argument("--export", action="store_true",
                        help="导出所有样本")

    args = parser.parse_args()

    if args.bench:
        show_bench_info()
        return

    storage = get_storage()

    if args.list:
        show_samples(storage)
        return

    if args.export:
        do_export(storage)
        return

    if args.oneshot:
        print(f"一键采集 {args.oneshot} 帧（MQTT 真实设备）...")
        result = collect_session(
            frame_count=args.oneshot,
            use_mock=False,
            roles=LOWER_BODY_5_ROLES,
            note=args.note,
            action_type=args.action,
        )
        proc = result["processed_frames"]
        if proc:
            sample = {
                "action_type": args.action,
                "source_type": "mqtt",
                "is_completed": False,
                "note": args.note,
                "roles": LOWER_BODY_5_ROLES,
                "frame_count": len(proc),
                "processed_frames": proc,
                "bench_bias_applied": True,
                "label": {"coach_score": 0, "quality_tag": ""},
            }
            sample_id = storage.save_sample(sample)
            print(f"已保存: {sample_id}")
        else:
            print("未采集到有效帧")
        return

    if args.mock:
        print(f"模拟采集 {args.mock} 帧...")
        result = collect_session(
            frame_count=args.mock,
            use_mock=True,
            roles=LOWER_BODY_5_ROLES,
            note=args.note,
            action_type=args.action,
        )
        proc = result["processed_frames"]
        if proc:
            sample = {
                "action_type": args.action,
                "source_type": "mock",
                "is_completed": False,
                "note": args.note,
                "roles": LOWER_BODY_5_ROLES,
                "frame_count": len(proc),
                "processed_frames": proc,
                "bench_bias_applied": True,
                "label": {"coach_score": 0, "quality_tag": ""},
            }
            sample_id = storage.save_sample(sample)
            print(f"已保存: {sample_id}")
        return

    # 默认：交互模式
    try:
        interactive_loop()
    except KeyboardInterrupt:
        print("\n\n  再见！\n")


if __name__ == "__main__":
    main()
