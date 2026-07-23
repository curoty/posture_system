# 快速开始指南 - IMU 采集系统

## 🎯 5分钟快速上手

### 步骤 1: 小程序前端测试（现在就可以做！）

1. 打开微信小程序开发工具
2. 打开 `miniprogram_hers` 目录
3. 进入 **教练首页** (coach/index)
4. 查看是否能看到 **"IMU 采集"** 功能卡片
5. 点击进入采集窗口（会显示4个节点的状态）

**预期效果**：
- 显示 left_ankle, right_ankle, left_knee, right_knee 四个节点
- 可以调整采集时长（5-300秒）
- 可以点击 "开始采集" 按钮开始模拟采集

---

### 步骤 2: 部署云函数

1. 打开 Tencent Cloud 微信云开发控制台
2. 进入 **云函数** → **新建**
3. 创建函数名: `saveSensorSamples`
4. 复制 `cloudfunctions/saveSensorSamples/index.js` 的内容到函数体
5. 依赖项 → 上传 `package.json`
6. **部署** → 等待部署完成

**验证方法**：
```
调用测试 → 选择 saveSensorSamples
输入测试数据（见下方示例）
检查返回结果是否成功
```

**测试输入数据**：
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
          "ax": 0.1,
          "ay": 0.2,
          "az": 9.8,
          "gx": 0.01,
          "gy": 0.02,
          "gz": 0.03,
          "temperature_c": 28.5
        }
      }
    }
  ]
}
```

---

### 步骤 3: 创建数据库集合

1. 进入 **数据库** → **集合管理**
2. 点击 **新建集合**
3. 集合名: `static_samples_nofiltering`
4. 权限设置:
   - 创建: 仅创建者
   - 读: 仅创建者
   - 更新: 仅创建者
   - 删除: 仅创建者
5. **确认创建**

---

### 步骤 4: 端到端测试

#### 测试 A：模拟采集 (推荐先从这里开始)

1. 打开小程序开发工具
2. 进入教练首页
3. 点击 **"IMU 采集"** 功能卡片
4. 等待 ~1 秒显示节点连接状态
5. **设置采集时长**: 例如 10 秒 (测试用)
6. 点击 **"开始采集"** 按钮
7. 观看进度条从 0% 到 100%
8. 采集完成后查看是否显示成功提示

**预期效果**：
```
✓ 数据已成功保存到数据库
已保存 500 个样本
```

#### 测试 B：验证数据库

采集完成后，打开云开发控制台：

1. 进入 **数据库** → **static_samples_nofiltering**
2. 查看是否有新增文档
3. 验证文档结构：
   ```
   - device_id: "d40592_49c394"
   - source: "left_ankle_imu_test"
   - node_name: "left_ankle"
   - imu_data: {ax, ay, az, gx, gy, gz, temperature_c}
   - created_at: (最新时间)
   ```

---

## 🔌 连接真实硬件（高级）

### 硬件要求

- ✅ 4 x ESP32-S3 开发板
- ✅ 4 x ICM20602 IMU 传感器
- ✅ WiFi 网络（推荐 2.4GHz）
- ✅ MQTT Broker 服务

### 固件部署

1. 打开 Arduino IDE
2. 创建新项目: `left_ankle_imu_test`
3. 复制 `firmware_v2_6_1/left_ankle_imu_test/left_ankle_imu_test.ino` 的代码
4. 修改配置：
   ```cpp
   // WiFi 配置
   constexpr char WIFI_SSID[] = "你的 WiFi 名称";
   constexpr char WIFI_PASSWORD[] = "你的 WiFi 密码";
   
   // MQTT 配置
   constexpr char MQTT_HOST[] = "你的 MQTT Broker IP";
   constexpr uint16_t MQTT_PORT = 1883;
   ```
5. 选择 **开发板**: ESP32-S3
6. **上传**
7. 打开 **串口监视器** (115200 baud) 检查输出

**预期输出**：
```
=== LEFT ANKLE ICM20602 STANDALONE TEST ===
[BUILD] left_ankle-static-v4-batch25-20260716 device_id=d40592_49c394
[MODE] 50Hz, hardware DLPF only, no software filter
[I2C] trying project_12_13 SDA=12 SCL=13
[I2C] address=0x69 WHO_AM_I=0x12
[IMU] found SDA=12 SCL=13 address=0x69
[IMU] hardware DLPF enabled: gyro~20Hz accel~21.2Hz
[CAL] keep left ankle completely still for about 2 seconds
[CAL] gyro offsets gx=0.015632 gy=0.023451 gz=0.008234
[TIME] WiFi connected IP=192.168.1.100; NTP started
[MQTT] connected broker=82.156.18.205:1883
[STATUS] actual_hz=50.00 frames=...
```

---

## 🐛 故障排查

### 问题 1: 小程序中看不到 "IMU 采集" 功能

**原因**: 组件未正确集成

**解决方案**:
1. 检查 `pages/coach/index/index.json` 是否包含：
   ```json
   "imu-collection-window": "/components/imu-collection-window/imu-collection-window"
   ```
2. 检查 `index.wxml` 是否有组件标签
3. 重新编译小程序

### 问题 2: 采集后数据库没有新数据

**原因**: 云函数未部署或调用失败

**解决方案**:
1. 确认云函数已部署: `saveSensorSamples`
2. 检查小程序控制台是否有错误日志
3. 手动测试云函数 (见步骤 2)
4. 检查数据库权限是否允许写入

### 问题 3: 硬件无法连接 WiFi

**原因**: WiFi 配置错误

**解决方案**:
1. 检查 SSID 和密码是否正确
2. 确保 WiFi 是 2.4GHz 频段 (ESP32-S3 不支持 5GHz)
3. 检查 WiFi 是否需要指定 IP
4. 查看串口输出中的具体错误信息

### 问题 4: MQTT 连接失败

**原因**: Broker 地址或端口错误

**解决方案**:
1. 验证 MQTT Broker 地址和端口
2. 检查防火墙是否阻止连接
3. 确保 Broker 服务正在运行
4. 尝试用 MQTT 客户端工具测试连接

---

## 📊 性能指标

| 指标 | 值 |
|------|-----|
| 采样率 | 50 Hz |
| 采样周期 | 20 ms |
| 批次大小 | 25 帧 |
| 批次周期 | 0.5 s |
| 加速度精度 | ±2g (分辨率: 16384 LSB/g) |
| 陀螺仪精度 | ±250 dps (分辨率: 131 LSB/dps) |
| WiFi 信号 | -80 ~ -30 dBm |
| 时间精度 | ±100ms (NTP 同步) |

---

## 📚 相关文件

| 文件 | 用途 |
|------|------|
| `IMU_COLLECTION_SYSTEM_SUMMARY.md` | 完整系统总结 |
| `firmware_v2_6_1/*_imu_test/` | Arduino 固件代码 |
| `cloudfunctions/saveSensorSamples/` | 云函数代码 |
| `miniprogram_hers/components/imu-collection-window/` | 小程序组件 |
| `miniprogram_hers/pages/coach/index/` | 教练首页集成 |

---

## 💬 常见问题

**Q: 可以修改采样率吗？**
A: 可以。在固件中修改 `SAMPLE_RATE_DIVIDER` (1kHz / (N+1) = 采样率)

**Q: 如何添加第5个节点？**
A: 复制一个现有的测试固件目录，修改 DEVICE_ID 和节点名称

**Q: 数据如何导出？**
A: 从云数据库控制台导出 CSV 或 JSON 格式

**Q: 支持实时数据预览吗？**
A: 当前版本采用离线采集模式，完成后统一保存。可以后续扩展为实时流模式

---

**最后更新**: 2026-07-17
**版本**: 1.0.0
**状态**: ✅ 生产就绪
