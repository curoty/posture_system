"""订阅所有 MQTT topic，查看云服务器上所有数据流"""
import paho.mqtt.client as mqtt
import time

BROKER = "82.156.18.205"
PORT = 1883
TOPIC = "#"  # 通配符，订阅所有 topic

def on_connect(client, userdata, flags, rc):
    print(f"[OK] Connected, subscribing to ALL topics...")
    client.subscribe(TOPIC)

def on_message(client, userdata, msg):
    raw = msg.payload.decode("utf-8", errors="replace")
    if len(raw) > 300:
        raw = raw[:300] + "..."
    print(f"\nTopic: {msg.topic}  Size: {len(msg.payload)}b")
    print(f"  {raw}")

print(f"Listening to ALL MQTT topics on {BROKER}:{PORT}")
print("Waiting... (Ctrl+C to stop)\n")

client = mqtt.Client(client_id="mqtt-sniffer", clean_session=True)
client.on_connect = on_connect
client.on_message = on_message

import socket
socket.setdefaulttimeout(10)
client.connect(BROKER, PORT, keepalive=30)
client.loop_forever()
