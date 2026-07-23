# Posture System 当前数据采集说明

## 当前工作范围

当前优先打通 **waist 腰部节点的原始 IMU 数据采集**，用于静止温漂和噪声实验。Spring Boot 后端不再作为当前采集链路；软件滤波也暂未放入 ESP32，ESP32 只启用 ICM20602 内置 DLPF。

```text
ICM20602 → ESP32-S3 → Wi‑Fi → MQTT → FastAPI → 小程序 → 云函数 → CloudBase 文档数据库
```

当前使用的固件：

`roller_skating_imu_radio_recovery_v2_6_1_2026-07-12/firmware_v2_6_1/waist_imu_test/waist_imu_test.ino`

## 固件配置

- 主板：ESP32-S3 SuperMini
- IMU：ICM20602，I2C 地址通常为 `0x69`
- I2C：优先 SDA=12、SCL=13，备用 SDA=8、SCL=9
- 采样率：50 Hz
- 陀螺仪 DLPF：约20 Hz
- 加速度计 DLPF：约21.2 Hz
- 软件滤波：关闭
- MQTT Broker：`82.156.18.205:1883`
- MQTT主题：`sensor/imu/frames`

串口监视器使用115200波特率。正常输出应包含：

```text
[IMU] hardware DLPF enabled
[WIFI] connected IP=...
[MQTT] connected broker=...
[WAIST_RAW] ...
[STATUS] actual_hz≈50 mqtt=CONNECTED read_errors=0 mqtt_dropped_batches=0
```

## 当前采集页面

微信小程序页面：

```text
传感器模型 MVP 调试 → 腰部静止温漂采集
```

页面支持：

- 30秒测试
- 升温阶段10分钟
- 恒温阶段5分钟
- 每种阶段第1至第4组

采样连续保持50 Hz；MQTT和数据库采用分块传输，不使用“采6秒、停4秒”的间歇采样。

## 数据库集合

当前无软件滤波原始数据写入：

```text
static_sample_nofiltering
```

云函数会写入两类文档：

- `static_raw_chunk`：最多500帧的连续数据块
- `static_capture_manifest`：一次采集的汇总信息

每帧包含时间戳、序号、温度和 waist 六轴数据。`softwareFilteringApplied` 应为 `false`。

后续软件滤波数据计划写入：

```text
static_sample_filtering
```

该集合暂不用于当前实验。

## 部署与验证顺序

1. Arduino IDE 编译并烧录 `waist_imu_test.ino`。
2. 串口确认 Wi‑Fi、MQTT 和50 Hz状态正常。
3. 在云服务器启动：

   ```bash
   cd model_service_fastapi
   uvicorn src.api:app --host 0.0.0.0 --port 18080
   ```

4. 访问 `http://82.156.18.205:18080/health`，确认 MQTT 已连接且有缓存帧。
5. 微信开发者工具部署 `cloudfunctions/skateActionAnalyze`，选择“云端安装依赖”。
6. 重新编译小程序。
7. 先运行30秒测试，确认数据库出现约1500帧。
8. 测试成功后再采集正式数据。

## 正式静止实验

### 升温阶段

每组10分钟，共4组。每组开始前断电并等待设备冷却到接近室温；设备固定不动，开机后立即开始采集。每组约30,000帧。

### 恒温阶段

设备预热至温度变化趋于稳定后，保持同样位置和姿态采集5分钟，共4组。每组约15,000帧。

采集期间保持小程序前台运行，不要移动传感器、锁屏或关闭手机热点。

## 完整5节点网关

完整网关固件位于：

`roller_skating_imu_radio_recovery_v2_6_1_2026-07-12/firmware_v2_6_1/gateway_waist_master_mqtt_v2_6_1/`

它使用带设备 MAC 的主题 `roller_skating/devices/<mac>/frames`，与当前独立测试主题不同。完整5节点部署前，需要让 FastAPI 同时订阅两种主题；在此之前不要用完整网关替换独立测试固件。

## 常见故障

- `WiFi unavailable`：热点未开启、仅5 GHz、密码/名称不一致或设备数已满。
- `MQTT publish pending`：通常是 Wi‑Fi 尚未恢复；检查后续是否出现 `[MQTT] connected`。
- `actual_hz` 明显低于50：检查串口波特率、I2C连线和主板供电。
- 数据库没有集合：先部署云函数，再完成一次30秒测试；首次成功写入后集合才会出现。

