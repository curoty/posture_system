/**
 * 小程序前端配置
 * 注意：预测 API 地址通过云函数环境变量 PREDICT_URL 配置，
 *       见 cloudfunctions/predictAnalysis/config.json
 */
module.exports = {
  cloudEnv: "cloud1-1g0419td698cd252",

  sensor: {
    // 当前硬件采集方案：腰部 + 双膝 + 双脚。
    sensorProfile: "waist_legs_5_capture_v1",
    expectedRoles: [
      "left_knee",
      "right_knee",
      "waist",
      "left_foot",
      "right_foot",
    ],
    defaultActiveRoles: [
      "left_knee",
      "right_knee",
      "waist",
      "left_foot",
      "right_foot",
    ],
    // AI inference stays on the real 9-node contract; never substitute waist for head.
    legacy9WaistAsHeadDebug: false,
  },

  wifi: {
    enabled: true,
    // Local FastAPI host while the computer and test phone/devtools use the
    // same mobile hotspot. Update this IP if the hotspot assigns a new one.
    apiBaseUrl: "http://10.141.103.23:18080",
    healthUrl: "http://10.141.103.23:18080/health",
    collectUrl: "http://10.141.103.23:18080/frames",
    timeoutMs: 30000,
  },

  ble: {
    notifyServiceUUID: "0000ffe0-0000-1000-8000-00805f9b34fb",
    notifyCharacteristicUUID: "0000ffe1-0000-1000-8000-00805f9b34fb",
    preferredDeviceIdPrefix: "a0:f2:62:f0:52:e1",
    requestMtu: false,
    connectTimeoutMs: 30000,
    discoveryTimeoutMs: 8000,
  },
};
