# 轮滑 IMU 五节点固件 V2.6.1

本包包含五个可以分别打开、编译和烧录的完整 Arduino 工程。四个子节点已经在源码中固定 ID、名称和工厂 STA MAC，不需要烧录前手工修改常量。

## 烧录映射

| 设备 | 固定 ID | 工厂 STA MAC | Arduino 工程 |
| --- | ---: | --- | --- |
| 腰部主节点 | HOST | `A0:F2:62:F0:55:08` | `gateway_waist_master_mqtt_v2_6_1` |
| 左脚踝 | 1 | `D4:05:92:49:C3:94` | `left_ankle_node_v2_6_1` |
| 右脚踝 | 2 | `D4:05:92:49:AD:A4` | `right_ankle_node_v2_6_1` |
| 左膝 | 3 | `D4:05:92:48:F5:94` | `left_knee_node_v2_6_1` |
| 右膝 | 4 | `D4:05:92:48:7D:58` | `right_knee_node_v2_6_1` |

每个子节点源码都有对应的固定 ID `static_assert`，并在启动时校验自身工厂 MAC。烧错物理设备会打印 `NODE_FIRMWARE_MAC_MISMATCH` 并停止发送。主节点也会校验自身 MAC，以及收到数据中的协议版本、节点 ID 和节点 ID 对应发送方 MAC。

## V2.6.1 优化内容

### 子节点无线恢复

- 新增独立 FreeRTOS 任务 `node_radio_manager`，只有该任务可以发送 ESP-NOW 或切换信道；50Hz IMU 采样任务只更新最新数据，避免两个执行上下文同时控制无线状态。
- 启动时立即生成合法的协议 V2 48 字节探测包，无需等待 ICM20602 初始化和约 2 秒陀螺仪校准即可扫描信道 1-13。
- 找到主节点后锁定实际信道；正常 IMU 数据以 20ms 周期发送。
- 连续 12 次失败或 1500ms 无成功回调后重新扫描。
- 发送回调超过 500ms 未返回时，不再直接复用发送槽。无线任务会注销回调、反初始化 ESP-NOW、等待驱动排空并重新初始化，避免迟到回调锁错信道或再次触发 `ESP_ERR_ESPNOW_NO_MEM`。

### 主节点动态信道

- 主节点连接手机热点后，ESP-NOW、Wi-Fi STA 和 MQTT 自动共享热点实际信道，不固定信道 11。
- 热点掉线后继续后台重连；重连到不同信道时，四个子节点会因失联自动重扫并锁定新信道。
- 主节点先初始化 ESP-NOW 并创建 50Hz IMU、50Hz 快照和 20Hz MQTT 任务，再进行最长 15 秒的初始热点等待；热点不可用不会再延迟腰部 IMU 采样启动。

### ESP-NOW 加密认证

- 主节点预注册四个加密 peer；子节点预注册加密主节点 peer。
- 使用 16 字节 PMK/LMK 对 ESP-NOW 链路加密认证，MAC/ID 校验仍保留。
- 部署前建议同时修改五份源码中的 `ESPNOW_PMK` 和 `ESPNOW_LMK`；五个节点的值必须完全一致且均为 16 字节。
- MQTT 继续使用原 Broker、1883 端口和原 JSON 结构，本版本未改为 MQTT TLS。

## 保持不变

- ICM20602 采样：50Hz，20ms 周期。
- MQTT 目标上传周期：50ms。
- `ImuPacket`：packed 协议 V2、固定 48 字节，字段和顺序不变。
- MQTT Broker、主题生成方式和 JSON 键集合不变，仅 `firmware_version` 更新为 `2.6.1`。
- I2C 候选引脚仍为 SDA/SCL 12/13 和 ESP32-S3 默认 8/9，地址仍扫描 0x69/0x68。

## 编译与烧录

1. Arduino IDE 选择开发板 `ESP32S3 Dev Module`。
2. 安装 Arduino-ESP32 3.3.10；本包也已在 3.3.7 上完成编译验证。
3. 安装 PubSubClient 2.8（只有主节点需要）。
4. 分别打开五个工程目录中与目录同名的 `.ino`。
5. 按烧录映射连接对应物理设备后点击“上传”。
6. 串口监视器设置为 115200 baud。

不要把同一个子节点工程烧入四块板；必须严格按表格一一对应。

## 建议上电顺序

1. 打开 2.4GHz 手机热点，SSID `esp32`，密码 `1234567898`。
2. 启动腰部主节点，确认 `CONNECTED=YES` 和 `ESP_NOW_CHANNEL=<热点实际信道>`。
3. 启动四个子节点，确认各自 ID、名称和 MAC 正确，并打印 `master discovered; locked channel=<热点信道>`。

## 现场验证

### 正常运行

- 四个子节点 `sample_hz`、`tx_hz`、`delivery_hz` 稳定在约 50。
- 主节点 `host_sample_hz` 约 50，网络正常时 `actual_publish_hz` 约 20。
- 主节点 `invalid_len=0 invalid_proto=0 invalid_id=0 invalid_mac=0`。
- MQTT JSON 除固件版本和实时值外应与 V2.5.3/V2.6.0 一致。

### 换信道恢复

1. 让系统在热点某一信道正常运行。
2. 关闭热点或主节点，确认子节点变为 `radio=SCANNING`。
3. 把热点换到另一个 1-13 信道并重新启动主节点。
4. 四个子节点无需重启，应自动锁定新信道并恢复约 50Hz 送达率。

### 回调超时恢复

- 正常运行时 `timeout` 和 `reset_count` 应保持不变。
- 若发生无线驱动超时，应看到 `ESP-NOW reset OK`，之后重新扫描并恢复；不应持续出现错误码 12391/`ESP_ERR_ESPNOW_NO_MEM`。

编译成功不能代替真实射频环境测试。批量部署前至少完成一次热点非 11 信道、热点换信道和主节点断电恢复测试。
