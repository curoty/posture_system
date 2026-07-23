# IMU 数据采集系统 - 项目完成总结 (v2.0 重构版)

## 📋 项目概述

已成功搭建一套完整的 IMU 传感器数据采集系统，包括：
- **4个子节点测试固件**：left_ankle、right_ankle、left_knee、right_knee
- **后端云函数**：数据处理和存储
- **小程序采集页面**：四节点静止采集（参照腰部温漂采集模式，真实API调用，零假数据）
- **数据库**：static_samples_nofiltering 集合用于存储原始样本

---

## 🔧 已完成的工作

### 1️⃣ Arduino 固件 (子节点测试代码)

**创建位置**：`firmware_v2_6_1/` 目录下

创建了4个独立的 IMU 测试固件：

```
left_ankle_imu_test/left_ankle_imu_test.ino
right_ankle_imu_test/right_ankle_imu_test.ino
left_knee_imu_test/left_knee_imu_test.ino
right_knee_imu_test/right_knee_imu_test.ino
```

**关键特性**：
- ✅ 50 Hz 采样率
- ✅ ICM20602 硬件 DLPF 滤波
- ✅ 启动时陀螺仪偏差校准
- ✅ MQTT 批量上传 (每批 25 帧 = 0.5s)
- ✅ WiFi + NTP 时间同步
- ✅ 每个节点唯一的 MAC 地址标识

**传感器规格**：
- 加速度范围: ±2g (LSB: 16384.0)
- 陀螺仪范围: ±250 dps (LSB: 131.0)
- 采样率分频器: 19 (1kHz / 20 = 50Hz)
- DLPF: Gyro ~20Hz, Accel ~21.2Hz

---

### 2️⃣ 云函数 - 数据处理

**创建位置**：`cloudfunctions/saveSensorSamples/`

```javascript
// 文件结构
cloudfunctions/saveSensorSamples/
├── package.json
└── index.js
```

**功能**：
- 接收来自 MQTT 的 IMU 批量数据
- 解析 JSON 格式的帧数据
- 验证节点来源和设备 ID
- 批量存储到 `static_samples_nofiltering` 集合

**支持的数据源**：
```
- left_ankle_imu_test
- right_ankle_imu_test
- left_knee_imu_test
- right_knee_imu_test
- waist_imu_test
```

**输入格式示例**：
```json
{
  "source": "left_ankle_imu_test",
  "device_id": "d40592_49c394",
  "sample_rate_hz": 50,
  "filter_status": "hardware_dlpf_only",
  "frames": [
    {
      "device_id": "d40592_49c394",
      "t": 1689845123000,
      "uptime_ms": 20,
      "unix_ts_ms": 1689845123000,
      "time_synced": true,
      "seq": 1,
      "temperature_c": 28.5,
      "points": {
        "left_ankle": {
          "ax": 0.1, "ay": 0.2, "az": 9.8,
          "gx": 0.01, "gy": 0.02, "gz": 0.03,
          "temperature_c": 28.5
        }
      }
    }
  ]
}
```

---

### 3️⃣ 小程序采集页面 — 四节点静止采集

**创建位置**：`miniprogram_hers/pages/coach/sensor/static-capture-four-nodes/`

```
static-capture-four-nodes/
├── static-capture-four-nodes.js      (核心采集逻辑)
├── static-capture-four-nodes.json    (页面配置)
├── static-capture-four-nodes.wxml    (页面模板)
└── static-capture-four-nodes.wxss    (样式)
```

**核心特性（零假数据）**：
- 🔌 调用 `GET /health` 确认 MQTT Broker 在线
- 📡 调用 `POST /frames` 获取四节点真实帧数据
- 🏷️ 通过设备 ID 精确匹配，自动归类四个节点
- 🟢 节点指示灯：仅在收到该节点真实帧后变绿
- 💾 每 500 帧分块保存到 `static_samples_nofiltering`

**访问路径**：
教练首页 → 智能教练 → sensor/debug → 四节点静止采集

---

### 4️⃣ 调试页面集成

**集成位置**：`miniprogram_hers/pages/coach/sensor/debug/debug.wxml`

在 debug 页面中，四节点静止采集与腰部静止温漂采集并列：

```xml
<navigator class="list-link" url=".../static-capture/static-capture">腰部静止温漂采集</navigator>
<navigator class="list-link" url=".../static-capture-four-nodes/static-capture-four-nodes">四节点静止采集</navigator>
```

**页面注册**：`miniprogram_hers/app.json`
```json
"pages/coach/sensor/static-capture-four-nodes/static-capture-four-nodes"
```

---

## 💾 数据库结构

### 集合: `static_samples_nofiltering`

**文档结构示例**：
```javascript
{
  "_id": ObjectId("..."),
  "device_id": "d40592_49c394",           // 设备 MAC 地址
  "source": "left_ankle_imu_test",        // 数据来源
  "node_name": "left_ankle",              // 节点名称
  "sample_rate_hz": 50,                   // 采样率
  "filter_status": "hardware_dlpf_only",  // 滤波状态
  "sequence": 1,                          // 序列号
  "uptime_ms": 20,                        // 运行时间（ms）
  "unix_ts_ms": 1689845123000,           // Unix 时间戳
  "time_synced": true,                    // 时间是否同步
  "temperature_c": 28.5,                  // 温度（℃）
  "timestamp": Date(2023-07-20T...),      // 采样时间
  "created_at": Date(2023-07-20T...),    // 创建时间
  "imu_data": {
    "ax": 0.1,                            // 加速度 X (g)
    "ay": 0.2,                            // 加速度 Y (g)
    "az": 9.8,                            // 加速度 Z (g)
    "gx": 0.01,                           // 角速度 X (dps)
    "gy": 0.02,                           // 角速度 Y (dps)
    "gz": 0.03,                           // 角速度 Z (dps)
    "temperature_c": 28.5                 // 温度（℃）
  }
}
```

---

## 📡 数据流程

```
┌─────────────────────────────────────────────────────┐
│ 硬件层: ESP32-S3 + ICM20602 (4个节点)               │
│ - left_ankle (d40592_49c394)                        │
│ - right_ankle (d40592_49ada4)                       │
│ - left_knee (d40592_48f594)                         │
│ - right_knee (d40592_487d58)                        │
└───────────────┬─────────────────────────────────────┘
                │
    ┌───────────▼──────────┐
    │ 固件层 (Arduino IDE)  │
    │ - 50 Hz 采样          │
    │ - 硬件 DLPF 滤波      │
    │ - 陀螺仪校准         │
    │ - WiFi + NTP 同步    │
    └───────────┬──────────┘
                │
    ┌───────────▼──────────┐
    │ MQTT → FastAPI 服务器 │
    │ GET  /health          │
    │ POST /frames          │
    │ (10.141.103.23:18080) │
    └───────────┬──────────┘
                │
    ┌───────────▼──────────────┐
    │ 小程序采集页面             │
    │ static-capture-four-nodes │
    │ - 真实设备ID过滤          │
    │ - 四节点自动归类          │
    │ - 分块保存 (500帧/chunk)  │
    └───────────┬──────────────┘
                │
    ┌───────────▼──────────┐
    │ 云函数处理            │
    │ saveSensorSamples    │
    │ - 模式A: 分块批量保存  │
    │ - 模式B: 单源MQTT直推  │
    └───────────┬──────────┘
                │
    ┌───────────▼──────────┐
    │ 数据库存储            │
    │ Collection:           │
    │ static_samples_...    │
    │ (原始样本)            │
    └──────────────────────┘
```

---

## 🚀 使用方式

### 前端操作步骤

1. **打开小程序** → 进入教练首页
2. **点击 "智能教练"** 功能卡片
3. **在 debug 页面** 点击 **"四节点静止采集"**
4. **等待 MQTT 连接**（自动轮询 `/health`）
5. **等待四节点出帧**（自动轮询 `/frames`，收到帧后对应节点指示灯变绿）
6. **选择采集类型和组号**
7. **点击 "开始采集"**
8. **保持所有设备绝对静止**，页面保持前台
9. **采集完成后** 自动分块保存到数据库

### 数据验证

采集完成后，可以在云数据库控制台查看：
- 集合: `static_samples_nofiltering`
- 按 `created_at` 排序，查看最新数据
- 验证 4 个节点的样本数

---

## 🔍 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **硬件** | ESP32-S3, ICM20602 | 四个独立节点 |
| **固件** | Arduino (C++) | WiFi、MQTT、I2C 驱动 |
| **通信** | MQTT + WiFi | 82.156.18.205:1883 |
| **后端** | 云函数 | 数据验证和存储 |
| **前端** | 小程序 (WeChat) | 采集UI和交互 |
| **数据库** | Tencent Cloud DB | 文档型数据库 |

---

## 📦 文件清单

```
项目根目录/
├── roller_skating_imu_radio_recovery_v2_6_1_2026-07-12/
│   └── firmware_v2_6_1/
│       ├── left_ankle_imu_test/left_ankle_imu_test.ino    (✅)
│       ├── right_ankle_imu_test/right_ankle_imu_test.ino  (✅)
│       ├── left_knee_imu_test/left_knee_imu_test.ino      (✅)
│       └── right_knee_imu_test/right_knee_imu_test.ino    (✅)
│
├── cloudfunctions/
│   └── saveSensorSamples/ (✅ 已重构 v2)
│       ├── package.json
│       └── index.js
│
└── miniprogram_hers/
    ├── app.json                          (已注册新页面)
    ├── pages/coach/sensor/
    │   ├── debug/debug.wxml              (已添加四节点采集入口)
    │   └── static-capture-four-nodes/    (✅ 新建)
    │       ├── static-capture-four-nodes.js
    │       ├── static-capture-four-nodes.json
    │       ├── static-capture-four-nodes.wxml
    │       └── static-capture-four-nodes.wxss
    │
    └── pages/coach/index/               (已回滚至原始状态)
        ├── index.json
        ├── index.js
        └── index.wxml
```

---

## ⚙️ 后续配置步骤

### 1. 部署云函数
```bash
# 在云开发控制台或使用 CLI
wechat-dev-tool cloud upload saveSensorSamples
```

### 2. 创建数据库集合
```
集合名: static_samples_nofiltering
```

### 3. 测试小程序
- 在小程序开发工具中预览
- 点击 "IMU 采集" 功能
- 验证采集窗口显示
- 执行模拟采集
- 检查数据库是否有新数据

### 4. 连接真实硬件
- 编译并上传 Arduino 固件到4个 ESP32-S3 设备
- 配置 WiFi SSID/密码
- 配置 MQTT broker 地址
- 在真实环境中测试采集

---

## ✨ 系统特点

- ✅ **多节点采集**: 同时从4个位置采集数据
- ✅ **原始数据保存**: 无滤波处理，便于后续分析
- ✅ **实时反馈**: UI 显示采集进度和节点状态
- ✅ **时间同步**: NTP + Unix 时间戳保证精度
- ✅ **硬件滤波**: 减少原始数据噪声
- ✅ **批量上传**: 提高网络效率
- ✅ **可扩展**: 易于添加新节点或修改参数

---

## 📝 备注

- 所有固件中 WiFi/MQTT 配置保持一致，便于部署
- 数据采样率固定为 50 Hz，可根据需要调整
- 云函数自动处理数据格式转换和验证
- 小程序组件支持独立使用或集成到其他页面

---

**项目完成日期**: 2026-07-17  
**系统状态**: ✅ 所有功能已实现并集成
