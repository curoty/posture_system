# V2.6.1 五节点构建验证

验证日期：2026-07-12

## 工具链

- Arduino CLI：1.5.0
- FQBN：`esp32:esp32:esp32s3`
- 实际编译 Arduino-ESP32：3.3.7
- PubSubClient：2.8
- 构建输出：纯 ASCII 系统临时目录

## 五节点实际编译结果

| 固件 | 固定 ID | Flash | 全局变量 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 腰部主节点 | HOST | 912,760 bytes（69%） | 52,108 bytes（15%） | PASS |
| 左脚踝 | 1 | 894,964 bytes（68%） | 45,652 bytes（13%） | PASS |
| 右脚踝 | 2 | 894,960 bytes（68%） | 45,652 bytes（13%） | PASS |
| 左膝 | 3 | 894,964 bytes（68%） | 45,652 bytes（13%） | PASS |
| 右膝 | 4 | 894,964 bytes（68%） | 45,652 bytes（13%） | PASS |

## 自动静态检查

- PASS：交付目录恰好包含五个完整 `.ino` 工程。
- PASS：四个子节点分别固定 ID 1、2、3、4，并从统一身份表派生名称和工厂 MAC。
- PASS：五个工程均为固件版本 2.6.1，均保留协议 V2 和 `static_assert(sizeof(ImuPacket) == 48)`。
- PASS：四个子节点均启用加密 ESP-NOW、独立无线管理任务、驱动超时重置和独立启动探测包。
- PASS：子节点不包含 `WiFi.begin`、热点密码、MQTT 或 HTTP 客户端。
- PASS：主节点注册四个加密 peer，仍执行节点 ID 与发送方 MAC 对应校验。
- PASS：主节点不存在固定 ESP-NOW 信道或 `esp_wifi_set_channel()`，始终跟随热点 STA 信道。
- PASS：主节点先创建采样/快照/MQTT 任务，再执行有界初始热点等待。
- PASS：V2.6.1 的 `buildMqttPayload()` 与 V2.6.0 逐字节一致，MQTT JSON 生成结构未改变。

## 硬件验证边界

当前记录证明源码与依赖可以完整编译，并验证了关键静态约束。ESP-NOW 加密互通、不同热点信道、物理掉线及回调超时恢复仍需在五块实际 ESP32-S3 上按 README 步骤验收。
