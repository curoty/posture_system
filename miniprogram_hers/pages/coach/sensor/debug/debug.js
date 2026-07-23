const plugin = requirePlugin("WechatSI");
const { SENSOR_ROLES, analyzeSensorSession, saveSensorTrainingSample } = require("../../../../utils/sensor-model");

const SENSOR_ROLES_LIST = [
  "head",
  "left_elbow", "right_elbow",
  "left_wrist", "right_wrist",
  "left_knee", "right_knee",
  "waist",
  "left_foot", "right_foot",
];
const { collectRealDeviceFrames } = require("../../../../utils/device-sensor-adapter");
const { FEATURE_GATES } = require("../../../../utils/feature-gates");

const USER_COLLECTION = "users";
const ACTION_TYPE_OPTIONS = [
  { label: "传感器会话", value: "sensor_session" },
  { label: "基础滑行", value: "basic_skating" },
  { label: "转弯滑行", value: "curve_skating" },
  { label: "重心转移", value: "weight_shift" },
  { label: "侧蹬收腿", value: "side_push_recover" },
  { label: "刹停动作", value: "braking" },
];
const SOURCE_TYPE_OPTIONS = [
  { label: "模拟数据", value: "mock" },
  { label: "真实设备", value: "real_device" },
];
const TRANSPORT_OPTIONS = [
  { label: "蓝牙(BLE)", value: "ble" },
  { label: "WiFi", value: "wifi" },
];
const SESSION_ID_OPTIONS = [
  { label: "1-标准动作", value: "1" },
  { label: "2-非标准动作", value: "2" },
];
const QUALITY_TAG_OPTIONS = [
  { label: "不及格（0-59）", value: "不及格" },
  { label: "及格（60-74）", value: "及格" },
  { label: "良好（75-89）", value: "良好" },
  { label: "优秀（90-100）", value: "优秀" },
];
const DEFAULT_QUALITY_TAG_INDEX = 1;
const DEFAULT_QUALITY_TAG = String(
  (QUALITY_TAG_OPTIONS[DEFAULT_QUALITY_TAG_INDEX] && QUALITY_TAG_OPTIONS[DEFAULT_QUALITY_TAG_INDEX].value)
  || (QUALITY_TAG_OPTIONS[0] && QUALITY_TAG_OPTIONS[0].value)
  || ""
).trim();
const FRAME_PRESET_OPTIONS = [30, 60, 90, 120, 180];
const SAMPLE_INTERVAL_PRESET_OPTIONS = [40, 50, 60, 70, 80];
const SOURCE_TYPE_MOCK = "mock";
const SOURCE_TYPE_REAL_DEVICE = "real_device";
const BLE_CONNECT_TEST_TIMEOUT_MS = 35000;
const MIN_SAMPLE_INTERVAL_MS = 20;
const MAX_SAMPLE_INTERVAL_MS = 200;
const ANALYZE_FLOW_STAGE_DEFS = [
  { key: "prepare", label: "设备准备" },
  { key: "collect", label: "帧采集" },
  { key: "parse", label: "节点解析" },
  { key: "score", label: "动作评分" },
  { key: "report", label: "建议生成" },
];
const ANALYZE_FLOW_METRIC_DEFS = [
  { key: "coverage", label: "节点覆盖", base: 26 },
  { key: "stability", label: "稳定性", base: 22 },
  { key: "rhythm", label: "节奏连贯", base: 18 },
  { key: "confidence", label: "识别置信", base: 24 },
];
const ANALYZE_FLOW_BAR_COUNT = 18;
const ANALYZE_NUMBER_STREAM_MAX = 14;
const SHOWCASE_LIST_MAX = 3;
const SHOWCASE_SCORE_TICK_MS = 42;
const BIG_SCREEN_SNAPSHOT_STORAGE_KEY = "SENSOR_BIG_SCREEN_SNAPSHOT";
const SENSOR_COMPONENT_LOCK_MESSAGE = FEATURE_GATES.sensorComponentLockMessage || "传感器组件功能维护中，暂未开放";
const SENSOR_BIG_SCREEN_ENABLED = FEATURE_GATES.sensorBigScreenEnabled !== false;
const SENSOR_BIG_SCREEN_LOCK_MESSAGE = FEATURE_GATES.sensorBigScreenLockMessage || "大屏展示功能维护中，暂未开放";
const REQUIRED_SENSOR_INFERENCE_MODE = "sensor_api_v1";

const clamp = (value, min, max) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return min;
  }
  return Math.max(min, Math.min(max, num));
};

const clampPercent = (value) => clamp(value, 0, 100);
const safeRound = (value, digits = 3) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "0";
  }
  return num.toFixed(digits);
};

const buildAnalyzeFlowStages = (progress, done) => {
  const safeProgress = clampPercent(progress);
  const stageCount = ANALYZE_FLOW_STAGE_DEFS.length;
  const segment = 100 / Math.max(1, stageCount);
  const activeIndex = Math.min(stageCount - 1, Math.floor(safeProgress / segment));
  return ANALYZE_FLOW_STAGE_DEFS.map((item, index) => {
    let status = "idle";
    if (done || index < activeIndex) {
      status = "done";
    } else if (index === activeIndex) {
      status = "active";
    }
    return {
      ...item,
      status,
    };
  });
};

const buildAnalyzeFlowBars = (seed) =>
  Array.from({ length: ANALYZE_FLOW_BAR_COUNT }, (_, index) => {
    const wave = Math.sin((seed * 0.52) + index * 0.65);
    const pulse = Math.cos((seed * 0.2) + index * 0.47);
    const height = Math.round(clamp(18 + wave * 11 + pulse * 8, 8, 44));
    return {
      id: index,
      height,
    };
  });

const buildAnalyzeFlowMetrics = (progress, seed) => {
  const safeProgress = clampPercent(progress);
  return ANALYZE_FLOW_METRIC_DEFS.map((item, index) => {
    const offset = Math.sin((seed * 0.38) + index * 0.91) * 5;
    const score = Math.round(clamp(item.base + safeProgress * 0.68 + offset, 6, 99));
    return {
      key: item.key,
      label: item.label,
      score,
    };
  });
};

const resolveAnalyzeFlowStatusText = ({ progress, sourceType, done, failed }) => {
  if (failed) {
    return "分析中断，请检查设备后重试";
  }
  if (done) {
    return "分析完成，结果已生成";
  }
  const safeProgress = clampPercent(progress);
  const isRealDevice = String(sourceType || "").trim() === SOURCE_TYPE_REAL_DEVICE;
  if (safeProgress < 20) return "正在初始化分析通道...";
  if (safeProgress < 45) return isRealDevice ? "正在采集传感器数据..." : "正在生成模拟帧数据...";
  if (safeProgress < 65) return "正在解析多节点轨迹...";
  if (safeProgress < 85) return "模型正在计算动作评分...";
  return "正在生成阶段建议...";
};

const normalizeModelLevelText = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower === "excellent" || raw === "优秀") return "优秀";
  if (lower === "good" || raw === "良好") return "良好";
  if (lower === "mid" || raw === "中等") return "中等";
  if (lower === "fail" || raw === "不及格") return "不及格";
  return raw;
};

const scoreToModelLevel = (score) => {
  const safeScore = clamp(Math.round(Number(score || 0)), 0, 100);
  if (safeScore >= 90) return "优秀";
  if (safeScore >= 75) return "良好";
  if (safeScore >= 60) return "中等";
  return "不及格";
};

const resolveModelLevelFromAnalysis = (analysis, fallbackScore) => {
  const safe = analysis && typeof analysis === "object" ? analysis : {};
  const sensorSession = safe.sensorSession && typeof safe.sensorSession === "object" ? safe.sensorSession : {};
  const candidates = [
    safe.qualityLevel,
    safe.quality_level,
    safe.qualityTag,
    safe.quality_tag,
    safe.qualityPrediction && safe.qualityPrediction.label,
    safe.quality_prediction && safe.quality_prediction.label,
    sensorSession.dominantQualityLevel,
    sensorSession.dominant_quality_level,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const normalized = normalizeModelLevelText(candidates[i]);
    if (normalized) {
      return normalized;
    }
  }
  return scoreToModelLevel(fallbackScore);
};

const round3 = (value) => Math.round(value * 1000) / 1000;
const randomIn = (min, max) => min + Math.random() * (max - min);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const normalizeRole = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "admin" || raw === "administrator" || raw === "管理员") {
    return "admin";
  }
  if (raw === "coach" || raw === "教练") {
    return "coach";
  }
  return raw;
};

const normalizeCoachLevel = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric);
  }
  const raw = String(value || "").trim().toLowerCase();
  const map = {
    assistant: 1,
    junior: 2,
    primary: 2,
    intermediate: 3,
    middle: 3,
    senior: 4,
    助理教练: 1,
    初级教练员: 2,
    中级教练员: 3,
    高级教练员: 4,
  };
  return map[raw] || 0;
};

const splitTags = (value) => String(value || "")
  .split(/[,，、]/)
  .map((item) => item.trim())
  .filter(Boolean);

const extractErrorMessage = (error) => {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error.trim();
  }
  const candidates = [
    error.message,
    error.errMsg,
    error.msg,
    error.reason,
    error.errorMessage,
    error.details && error.details.message,
    error.result && error.result.message,
    error.result && error.result.errMsg,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const text = String(candidates[i] || "").trim();
    if (text) {
      return text;
    }
  }
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
};

const isCollectionMissingError = (message) => {
  const lower = String(message || "").toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes("skate_sensor_training_samples")
    || (lower.includes("collection") && (lower.includes("not exist") || lower.includes("does not exist")))
    || lower.includes("集合不存在")
  );
};

const withTimeout = (promise, timeoutMs, errorCode) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorCode || "timeout"));
    }, Math.max(3000, Number(timeoutMs) || BLE_CONNECT_TEST_TIMEOUT_MS));
    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

const mapAnalyzeFailReason = (message) => {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return "未知错误";
  if (lower.includes("device_sdk_not_configured")) return "未配置设备 SDK";
  if (lower.includes("device_sdk_collect_not_implemented")) return "设备采集方法未实现";
  if (lower.includes("device_ble_no_role_binding_found")) return "未扫描到可用设备，请确认设备开机并靠近手机";
  if (lower.includes("device_ble_services_empty")) return "未发现蓝牙服务";
  if (lower.includes("device_ble_notify_service_not_found")) return "未找到通知服务 UUID";
  if (lower.includes("device_ble_notify_char_not_found")) return "未找到通知特征 UUID";
  if (lower.includes("device_ble_notify_channel_unavailable")) return "找到服务但无法打开通知通道";
  if (lower.includes("device_ble_preferred_not_found")) return "未扫描到目标传感器ID，请确认设备已开机并在附近";
  if (lower.includes("device_ble_create_connection_failed") && lower.includes("wx_api_timeout")) {
    return "建立蓝牙连接超时（设备忙或系统蓝牙栈未及时响应）";
  }
  if (lower.includes("device_ble_connect_timeout")) return "连接总超时，请重试";
  if (lower.includes("ble_connect_ui_timeout")) return "连接等待超时，请重试";
  if (lower.includes("device_ble_create_connection_failed") && lower.includes("status:62")) {
    return "建立蓝牙连接失败（状态62，传感器ID可能已变化或设备忙）";
  }
  if (lower.includes("device_ble_create_connection_failed") && lower.includes("status:147")) {
    return "建立蓝牙连接失败（状态147，设备被占用或拒绝连接）";
  }
  if (lower.includes("device_ble_create_connection_failed")) return "建立蓝牙连接失败（已重试）";
  if (lower.includes("device_ble_write_char_not_found")) return "未找到可写特征，无法发送启动命令";
  if (lower.includes("device_ble_start_command_failed")) return "启动命令发送失败";
  if (lower.includes("status:62")) return "蓝牙连接失败（状态62，传感器ID可能已变化或设备忙）";
  if (lower.includes("status:147")) return "设备连接被拒绝或被占用，请重启设备后重试";
  if (lower.includes("device_ble_connect_failed")) return "蓝牙连接失败";
  if (lower.includes("device_frames_empty")) return "设备没有返回帧数据";
  if (lower.includes("device_frames_too_few")) return "设备帧数太少，请延长采集";
  if (lower.includes("device_sdk_collect_timeout")) return "设备采集超时";
  if (lower.includes("device_frames_too_few_after_retry")) return "设备帧数仍然不足（已重试）";
  if (lower.includes("operator_user_not_found")) return "当前微信账号未在系统中建档，请先重新登录";
  if (lower.includes("permission_denied")) return "权限不足";
  if (lower.includes("sensor_frames_required")) return "未采集到可保存的帧数据";
  if (lower.includes("sensor_frames_too_few")) return "帧数不足，至少需要 24 帧";
  if (lower.includes("sensor_roles_incomplete")) return "节点数据不完整（未开启单点调试）";
  if (lower.includes("sensor_api_required")) return "云端已配置必须走远程模型，但当前未启用";
  if (lower.includes("sensor_api_unavailable")) return "远程模型暂不可用";
  if (lower.includes("save_sensor_training_sample_failed")) return "保存样本失败";
  if (lower.includes("sensor_api_http_")) return "远程接口 HTTP 错误";
  if (lower.includes("sensor_api_remote_failed")) return "远程接口调用失败";
  if (lower.includes("sensor_api_invalid_result")) return "远程接口返回格式不正确";
  if (lower.includes("sensor_api_disabled")) return "远程传感分析未开启";
  if (lower.includes("sensor_component_disabled")) return SENSOR_COMPONENT_LOCK_MESSAGE;
  if (lower.includes("sensor_api_url_or_function_not_configured")) return "远程地址未配置";
  if (lower.includes("analysis_not_from_remote_model")) return "未命中训练模型，请检查云端模型通道";
  if (lower.includes("openbluetoothadapter:fail")) return "蓝牙未开启或无权限";
  if (lower.includes("createbleconnection:fail")) return "蓝牙连接失败";
  if (lower.includes("wx_api_timeout")) return "蓝牙接口调用超时，请重试并确认设备状态";
  if (lower.includes("callfunction:fail")) return "云函数调用失败";
  if (lower.includes("request:fail")) return "网络请求失败";
  if (lower.includes("analyze_failed")) return "分析失败";
  return raw;
};

Page({
  data: {
    sessionId: "",
    actionTypeIndex: 0,
    actionTypeOptions: ACTION_TYPE_OPTIONS,
    sourceTypeIndex: 0,
    sourceTypeOptions: SOURCE_TYPE_OPTIONS,
    transportIndex: 0,
    transportOptions: TRANSPORT_OPTIONS,
    sessionIdIndex: 0,
    sessionIdOptions: SESSION_ID_OPTIONS,
    qualityTagIndex: DEFAULT_QUALITY_TAG_INDEX,
    qualityTagOptions: QUALITY_TAG_OPTIONS,
    suggestionOptions: [
      { label: "1", value: 1 },
      { label: "2", value: 2 },
      { label: "3", value: 3 },
      { label: "4", value: 4 },
      { label: "5", value: 5 },
      { label: "6", value: 6 },
      { label: "7", value: 7 },
      { label: "8", value: 8 },
    ],
    framePresetOptions: FRAME_PRESET_OPTIONS,
    sampleIntervalPresetOptions: SAMPLE_INTERVAL_PRESET_OPTIONS,
    note: "模拟数据",
    userId: "",
    operatorUserId: "",
    frameCount: 180,
    sampleIntervalMs: 50,
    coachScore: 78,
    qualityTag: DEFAULT_QUALITY_TAG,
    coachComment: "基础动作较稳定，建议继续练习并强化节奏。",
    tagsText: "平衡,稳定",
    selectedSuggestions: [],
    suggestion1: false,
    suggestion2: false,
    suggestion3: false,
    suggestion4: false,
    suggestion5: false,
    suggestion6: false,
    suggestion7: false,
    suggestion8: false,
    analyzing: false,
    saving: false,
    collecting: false,
    hasCollectedData: false,
    bleDebugExpanded: false,
    lastAnalyzeResult: "",
    lastSaveResult: "",
    latestAnalyzeScore: 0,
    latestAnalyzeLevel: "-",
    latestAnalyzeInferenceMode: "",
    latestAnalyzeModelVersion: "",
    errorTip: "",
    lastFrameSize: 0,
    accessDenied: false,
    canSaveTrainingSample: false,
    calibrating: false,
    calibrationRunning: false,
    calibrationStatusText: "未执行主动校准",
    calibrationText: "",
    calibrationOk: false,
    roleOptions: SENSOR_ROLES_LIST.map((name) => ({ name, selected: true })),
    selectedRoles: SENSOR_ROLES_LIST.slice(),
    studentOptions: [],
    studentIndex: 0,
    studentLoading: false,
    studentLoadError: "",
    labelSectionCollapsed: false,
    analyzeResultExpanded: false,
    saveResultExpanded: false,
    lastAnalyzeAtText: "-",
    lastSaveAtText: "-",
    showCollectionHint: false,
    bleTesting: false,
    bleConnected: false,
    bleStatusText: "未检测",
    bleConnectedDeviceId: "",
    bleConnectedRolesText: "",
    bleCandidateIdsText: "",
    bleParsedRolesText: "",
    bleDebugSummary: "",
    bleLastChunkPreview: "",
    wifiTesting: false,
    wifiConnected: false,
    wifiStatusText: "未检测",
    wifiHost: "",
    wifiPort: 8080,
    wifiPath: "/sensor",
    rawDataLines: [],
    rawDataTotal: 0,
    _voiceCtx: null,
    voicePlaying: false,
    bigScreenEnabled: SENSOR_BIG_SCREEN_ENABLED,
    bigScreenMode: false,
    analyzeFlowVisible: false,
    analyzeFlowDone: false,
    analyzeFlowProgress: 0,
    analyzeFlowElapsedSec: 0,
    analyzeFlowStatusText: "等待执行分析",
    analyzeFlowStages: buildAnalyzeFlowStages(0, false),
    analyzeFlowBars: buildAnalyzeFlowBars(0),
    analyzeFlowMetrics: buildAnalyzeFlowMetrics(0, 0),
    analyzeFlowEvents: [],
    analyzeNumberStream: [],
    resultShowcaseVisible: false,
    resultShowcaseDone: false,
    resultShowcaseActionLabel: "",
    resultShowcaseSummary: "",
    resultShowcaseModelScore: 0,
    resultShowcaseTargetScore: 0,
    resultShowcaseCoachScore: 0,
    resultShowcaseConfidence: 0,
    resultShowcaseQualityTag: "",
    resultShowcaseCoachComment: "",
    resultShowcaseStrengths: [],
    resultShowcaseImprovements: [],
    resultShowcaseTips: [],
    resultShowcaseTags: "",
    resultShowcaseInferenceMode: "",
    resultShowcaseModelVersion: "",
    resultShowcaseApiError: "",
  },

  onLoad() {
    this._analyzeFlowTimer = null;
    this._resultShowcaseTimer = null;
    this._analyzeFlowStartedAt = 0;
    this._analyzeFlowSourceType = SOURCE_TYPE_MOCK;
    this._analyzeFlowTick = 0;
    this._analyzeFlowLastCollectRenderAt = 0;
    this._analyzeFlowLastCollectBucket = -1;
    this._analyzeFlowLastStreamAt = 0;
    this._analyzeFlowLastStreamFrameCount = 0;
    this._analyzeFlowLastPhase = "";
    this._lastAnalyzeKey = "";
    this._lastFrames = null;
    this._lastFrameSourceType = "";
    this._calibrationProfiles = {};
    if (!this.ensureSensorComponentEnabled()) {
      return;
    }
    const operatorUserId = this.getCurrentUserId();
    this.setData({
      sessionId: `sensor_${Date.now()}`,
      operatorUserId,
      userId: operatorUserId || "",
    });
    this.syncQualityTagSelection();
    this.persistBigScreenSnapshot();
    this.bootstrap();
    setTimeout(() => {
      this.clearCalibrationForNewSession();
    }, 800);
  },

  onHide() {
    this.clearAnalyzeFlowTimer();
    this.clearResultShowcaseTimer();
  },

  onUnload() {
    this.clearAnalyzeFlowTimer();
    this.clearResultShowcaseTimer();
  },

  initRawDataListener() {
    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.setRawDataCallback !== "function") {
      return;
    }
    sdk.setRawDataCallback((data) => {
      const newLine = {
        id: Date.now() + Math.random(),
        time: new Date(data.timestamp).toLocaleTimeString(),
        text: String(data.raw || data.normalized || "").slice(0, 800),
      };
      this.setData((prev) => {
        const newLines = [...(prev.rawDataLines || []), newLine].slice(-100);
        return {
          rawDataLines: newLines,
          rawDataTotal: (prev.rawDataTotal || 0) + 1,
        };
      });
    });
  },

  async bootstrap() {
    this.initRawDataListener();
    const accessGranted = await this.ensureAccess();
    if (!accessGranted) {
      this.setData({ accessDenied: true });
      wx.showModal({
        title: "无法访问",
        content: "请先登录后再使用传感器调试。",
        showCancel: false,
        success: () => {
          wx.reLaunch({ url: "/pages/coach/index/index" });
        },
      });
      return;
    }
    this.setData({
      studentOptions: [],
      studentIndex: 0,
      studentLoading: false,
      studentLoadError: "",
      userId: this.resolveTargetUserId(),
    });
  },

  resolveQualityTagIndexByValue(value) {
    const options = Array.isArray(this.data.qualityTagOptions) ? this.data.qualityTagOptions : [];
    const target = String(value || "").trim();
    if (!target || !options.length) {
      return -1;
    }
    return options.findIndex((item) => String((item && item.value) || "").trim() === target);
  },

  getSelectedQualityTag() {
    const options = Array.isArray(this.data.qualityTagOptions) ? this.data.qualityTagOptions : [];
    const index = Number(this.data.qualityTagIndex);
    const byIndex = options[index] ? String(options[index].value || "").trim() : "";
    const byValue = String(this.data.qualityTag || "").trim();
    return byValue || byIndex || DEFAULT_QUALITY_TAG;
  },

  syncQualityTagSelection() {
    const options = Array.isArray(this.data.qualityTagOptions) ? this.data.qualityTagOptions : [];
    if (!options.length) {
      return;
    }
    const fromValue = this.resolveQualityTagIndexByValue(this.data.qualityTag);
    if (fromValue >= 0) {
      if (fromValue !== Number(this.data.qualityTagIndex)) {
        this.setData({ qualityTagIndex: fromValue });
      }
      return;
    }
    const currentIndex = Number(this.data.qualityTagIndex);
    const safeIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < options.length
      ? currentIndex
      : DEFAULT_QUALITY_TAG_INDEX;
    const selected = String((options[safeIndex] && options[safeIndex].value) || DEFAULT_QUALITY_TAG).trim();
    this.setData({
      qualityTagIndex: safeIndex,
      qualityTag: selected,
    });
  },

  ensureSensorComponentEnabled() {
    if (FEATURE_GATES.sensorComponentEnabled) {
      return true;
    }
    wx.showModal({
      title: "功能维护中",
      content: SENSOR_COMPONENT_LOCK_MESSAGE,
      showCancel: false,
      success: () => {
        wx.reLaunch({ url: "/pages/coach/index/index" });
      },
    });
    return false;
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  },

  getLocalUserInfo() {
    return wx.getStorageSync("userInfo") || {};
  },

  getCurrentUserId() {
    const userInfo = this.getLocalUserInfo();
    return String(userInfo.id || userInfo._id || "").trim();
  },

  resolveDeviceSdk() {
    try {
      const app = getApp();
      const sdk = app && app.globalData ? app.globalData.deviceSdk : null;
      return sdk && typeof sdk === "object" ? sdk : null;
    } catch (error) {
      return null;
    }
  },

  enforceMultiRoleBleConfig() {
    try {
      const app = getApp();
      if (!app || typeof app.setWearableBleConfig !== "function") {
        return;
      }
      const patch = {
        preferSingleHostStream: false,
        connectTimeoutMs: 30000,
        discoveryTimeoutMs: 6000,
        preferredDeviceId: "a0:f2:62:f0:52:e1",
        preferredDeviceIdPrefix: "a0:f2:62:f0:52",
        strictPreferredDevice: true,
        fallbackCandidateCount: 8,
        roleSampleMaxAgeMs: 10000,
        requestMtu: true,
        preferredMtu: 512,
      };
      const current = app && app.globalData && app.globalData.wearableBleConfig
        ? app.globalData.wearableBleConfig
        : {};
      const keys = Object.keys(patch);
      const changed = keys.some((key) => String(current[key]) !== String(patch[key]));
      if (!changed) {
        return;
      }
      app.setWearableBleConfig(patch);
    } catch (error) {}
  },

  buildBleStateFromSdk(sdk) {
    const safeSdk = sdk && typeof sdk === "object" ? sdk : null;
    const sdkState = safeSdk && typeof safeSdk.getState === "function"
      ? (safeSdk.getState() || {})
      : {};
    const connected = safeSdk && typeof safeSdk.isConnected === "function"
      ? !!safeSdk.isConnected()
      : !!sdkState.connected;
    const connectedDevices = Array.isArray(sdkState.connectedDevices) ? sdkState.connectedDevices : [];
    const firstConnected = connectedDevices[0] || null;
    const boundDevices = Array.isArray(sdkState.boundDevices) ? sdkState.boundDevices : [];
    const discoveredDeviceIds = Array.isArray(sdkState.discoveredDeviceIds) ? sdkState.discoveredDeviceIds : [];
    const firstBinding = boundDevices[0] || null;
    const boundCandidateIds = boundDevices
      .map((item) => String(item && item.deviceId ? item.deviceId : "").trim())
      .filter(Boolean);
    const scannedCandidateIds = discoveredDeviceIds
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const candidateIds = boundCandidateIds.length ? boundCandidateIds : scannedCandidateIds;
    const candidateIdsText = candidateIds.join(", ");
    const connectedDeviceId = firstConnected && firstConnected.deviceId
      ? String(firstConnected.deviceId).trim()
      : "";
    const connectedDeviceName = firstConnected && (firstConnected.name || firstConnected.localName)
      ? String(firstConnected.name || firstConnected.localName).trim()
      : "";
    const deviceId = connectedDeviceId
      || (firstBinding && firstBinding.deviceId ? String(firstBinding.deviceId).trim() : "");
    const deviceIdText = connectedDeviceName
      ? `${deviceId} (${connectedDeviceName})`
      : deviceId;
    const connectedRoles = Array.isArray(sdkState.connectedRoles) ? sdkState.connectedRoles : [];
    const rolesText = connectedDevices.length
      ? connectedDevices.map((item) => String(item && item.role ? item.role : "").trim()).filter(Boolean).join(", ")
      : (connectedRoles.length ? connectedRoles.join(", ") : "");
    const notifyCount = Number(sdkState.notifyCount || 0);
    const parsedEntryCount = Number(sdkState.parsedEntryCount || 0);
    const lastNotifyAt = Number(sdkState.lastNotifyAt || 0);
    const lastChunkPreview = String(sdkState.lastChunkPreview || "").trim();
    const lastParsedRoles = Array.isArray(sdkState.lastParsedRoles) ? sdkState.lastParsedRoles : [];
    const parsedRoles = Array.isArray(sdkState.parsedRoles) ? sdkState.parsedRoles : [];
    return {
      connected,
      deviceId,
      deviceIdText,
      rolesText,
      candidateIds,
      candidateIdsText,
      discoveredDeviceIds: scannedCandidateIds,
      connectedDevices,
      notifyCount: Number.isFinite(notifyCount) ? notifyCount : 0,
      parsedEntryCount: Number.isFinite(parsedEntryCount) ? parsedEntryCount : 0,
      lastParsedRoles: lastParsedRoles.filter(Boolean),
      parsedRoles,
      lastNotifyAt: Number.isFinite(lastNotifyAt) ? lastNotifyAt : 0,
      lastChunkPreview,
    };
  },

  formatBleDebugSummary() {
    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.getState !== "function") {
      return "";
    }
    const state = this.buildBleStateFromSdk(sdk);
    const lastNotifyText = state.lastNotifyAt
      ? new Date(state.lastNotifyAt).toLocaleTimeString()
      : "-";
    const chunk = state.lastChunkPreview
      ? state.lastChunkPreview.replace(/\s+/g, " ").slice(0, 120)
      : "-";
    const candidates = state.candidateIdsText
      ? state.candidateIdsText.slice(0, 120)
      : "-";
    const scannedCount = Array.isArray(state.discoveredDeviceIds) ? state.discoveredDeviceIds.length : 0;
    const lastRoles = state.lastParsedRoles && state.lastParsedRoles.length
      ? state.lastParsedRoles.join(",")
      : "-";
    return `BLE调试: connected=${state.connected ? 1 : 0}, notify=${state.notifyCount}, parsed=${state.parsedEntryCount}, scanned=${scannedCount}, candidates=${candidates}, lastRoles=${lastRoles}, lastNotify=${lastNotifyText}, chunk=${chunk}`;
  },

  syncBleDebugInfo() {
    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.getState !== "function") {
      this.setData({
        bleParsedRolesText: "",
        bleCandidateIdsText: "",
        bleDebugSummary: "",
        bleLastChunkPreview: "",
      });
      return;
    }
    const state = this.buildBleStateFromSdk(sdk);
    const parsedRoles = Array.isArray(state.parsedRoles) ? state.parsedRoles : [];
    const parsedRolesText = parsedRoles.length
      ? parsedRoles.map((item) => `${item.role}:${item.count}`).join(", ")
      : "";
    const chunkPreview = String(state.lastChunkPreview || "").replace(/\s+/g, " ").slice(0, 300);
    this.setData({
      bleParsedRolesText: parsedRolesText,
      bleCandidateIdsText: String(state.candidateIdsText || ""),
      bleDebugSummary: this.formatBleDebugSummary(),
      bleLastChunkPreview: chunkPreview,
    });
  },

  buildBleClientDebugInfo() {
    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.getState !== "function") {
      return {
        sdkReady: false,
      };
    }
    const state = this.buildBleStateFromSdk(sdk);
    const parsedRoles = Array.isArray(state.parsedRoles) ? state.parsedRoles : [];
    return {
      sdkReady: true,
      connected: !!state.connected,
      deviceId: String(state.deviceId || ""),
      deviceIdText: String(state.deviceIdText || state.deviceId || ""),
      connectedRoles: String(state.rolesText || ""),
      candidateIds: Array.isArray(state.candidateIds) ? state.candidateIds : [],
      candidateIdsText: String(state.candidateIdsText || ""),
      connectedDevices: Array.isArray(state.connectedDevices) ? state.connectedDevices : [],
      notifyCount: Number(state.notifyCount || 0),
      parsedEntryCount: Number(state.parsedEntryCount || 0),
      lastParsedRoles: Array.isArray(state.lastParsedRoles) ? state.lastParsedRoles : [],
      parsedRoles,
      lastChunkPreview: String(state.lastChunkPreview || "").replace(/\s+/g, " ").slice(0, 300),
      capturedAt: Date.now(),
    };
  },

  resolveCollectRolesForRealDevice() {
    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.getState !== "function") {
      return SENSOR_ROLES.slice();
    }
    const state = this.buildBleStateFromSdk(sdk);
    const parsedRoles = Array.isArray(state.parsedRoles) ? state.parsedRoles : [];
    const activeRoleSet = new Set(
      parsedRoles
        .filter((item) => Number(item && item.count) >= 5)
        .map((item) => String(item && item.role ? item.role : "").trim())
        .filter((role) => SENSOR_ROLES.includes(role))
    );
    if (!activeRoleSet.size) {
      return SENSOR_ROLES.slice();
    }
    const ordered = SENSOR_ROLES.filter((role) => activeRoleSet.has(role));
    // Keep conservative fallback until enough stable roles are observed.
    return ordered.length >= 3 ? ordered : SENSOR_ROLES.slice();
  },

  async onTapBleConnectTest() {
    if (this.data.bleTesting || this.data.accessDenied) {
      return;
    }
    if (this.getCurrentSourceTypeValue() !== SOURCE_TYPE_REAL_DEVICE) {
      wx.showToast({
        title: "请先切换到真实设备",
        icon: "none",
      });
      return;
    }

    this.enforceMultiRoleBleConfig();

    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.connect !== "function") {
      this.setData({
        bleConnected: false,
        bleStatusText: "未配置设备 SDK",
        bleConnectedDeviceId: "",
        bleConnectedRolesText: "",
        bleCandidateIdsText: "",
      });
      wx.showToast({
        title: "设备 SDK 未配置",
        icon: "none",
      });
      return;
    }

    this.setData({
      bleTesting: true,
      bleStatusText: "正在连接蓝牙设备...",
      bleConnected: false,
      bleConnectedDeviceId: "",
      bleConnectedRolesText: "",
      bleCandidateIdsText: "",
    });

    try {
      await withTimeout(
        Promise.resolve(sdk.connect()),
        BLE_CONNECT_TEST_TIMEOUT_MS,
        "ble_connect_ui_timeout"
      );
      const state = this.buildBleStateFromSdk(sdk);
      this.setData({
        bleConnected: !!state.connected,
        bleStatusText: state.connected ? "蓝牙已连接，可执行分析" : "蓝牙状态未知，请再试一次",
        bleConnectedDeviceId: state.deviceIdText || state.deviceId,
        bleConnectedRolesText: state.rolesText,
        bleCandidateIdsText: state.candidateIdsText,
      });
      this.syncBleDebugInfo();
      wx.showToast({
        title: state.connected ? "连接成功" : "连接完成",
        icon: state.connected ? "success" : "none",
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      const reason = mapAnalyzeFailReason(message);
      const failedState = this.buildBleStateFromSdk(sdk);
      this.setData({
        bleConnected: false,
        bleStatusText: `连接失败：${reason}${message ? ` (${message})` : ""}`,
        bleConnectedDeviceId: "",
        bleConnectedRolesText: "",
        bleCandidateIdsText: failedState.candidateIdsText || "",
      });
      this.syncBleDebugInfo();
      wx.showToast({
        title: "连接失败",
        icon: "none",
      });
    } finally {
      this.setData({ bleTesting: false });
    }
  },

  onChangeTransport(e) {
    const index = Number(e && e.detail && e.detail.value);
    if (Number.isNaN(index)) {
      return;
    }
    const transport = TRANSPORT_OPTIONS[index]?.value || "ble";
    this.setData({ transportIndex: index });
    if (transport === "wifi") {
      const app = getApp();
      if (app && typeof app.setDeviceTransport === "function") {
        app.setDeviceTransport("wifi", {
          host: this.data.wifiHost,
          port: this.data.wifiPort,
          path: this.data.wifiPath,
        });
      }
    } else {
      const app = getApp();
      if (app && typeof app.setDeviceTransport === "function") {
        app.setDeviceTransport("ble");
      }
    }
  },

  onWifiHostInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ wifiHost: String(value || "") });
  },

  onWifiPortInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ wifiPort: Math.max(1, Math.min(65535, Number(value) || 8080)) });
  },

  onWifiPathInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ wifiPath: String(value || "/sensor") });
  },

  async onTapWifiConnectTest() {
    if (this.data.wifiTesting || this.data.accessDenied) {
      return;
    }
    const host = String(this.data.wifiHost || "").trim();
    if (!host) {
      wx.showToast({ title: "请输入设备主机地址", icon: "none" });
      return;
    }

    this.setData({ wifiTesting: true, wifiStatusText: "连接中..." });

    try {
      const app = getApp();
      if (app && typeof app.setDeviceTransport === "function") {
        app.setDeviceTransport("wifi", {
          host: this.data.wifiHost,
          port: this.data.wifiPort,
          path: this.data.wifiPath,
        });
      }

      const sdk = this.resolveDeviceSdk();
      if (!sdk) {
        throw new Error("device_sdk_not_available");
      }

      await sdk.connect();
      this.setData({
        wifiConnected: true,
        wifiStatusText: "已连接",
      });
      wx.showToast({ title: "WiFi连接成功", icon: "success" });
    } catch (error) {
      const msg = extractErrorMessage(error) || "连接失败";
      this.setData({
        wifiConnected: false,
        wifiStatusText: "连接失败",
      });
      wx.showToast({ title: msg, icon: "none" });
    } finally {
      this.setData({ wifiTesting: false });
    }
  },

  buildFallbackUserId() {
    const operatorId = String(this.data.operatorUserId || this.getCurrentUserId() || "").trim();
    if (operatorId) {
      return operatorId;
    }
    return "";
  },

  resolveTargetUserId(preferredUserId) {
    const candidate = String(preferredUserId || this.data.userId || "").trim();
    if (candidate) {
      return candidate;
    }
    return this.buildFallbackUserId();
  },

  getCurrentRole() {
    const userInfo = this.getLocalUserInfo();
    const candidates = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      userInfo.role,
    ];
    if (candidates.some((item) => normalizeRole(item) === "admin")) {
      return "admin";
    }
    if (candidates.some((item) => normalizeRole(item) === "coach")) {
      return "coach";
    }
    return "";
  },

  hasSensorDebugAccessByUser(user) {
    const safeUser = user && typeof user === "object" ? user : {};
    const role = normalizeRole(safeUser.role);
    if (role === "admin") {
      return true;
    }
    if (role !== "coach") {
      return false;
    }
    return true;
  },

  canCurrentUserSaveTrainingSample(user) {
    if (this.hasSensorDebugAccessByUser(user)) {
      return true;
    }
    return this.getCurrentRole() === "admin";
  },

  async ensureAccess() {
    const localUser = this.getLocalUserInfo();
    const localUserId = String(localUser.id || localUser._id || this.getCurrentUserId() || "").trim();
    const setSampleSaveAccess = (user) => {
      const canSaveTrainingSample = this.canCurrentUserSaveTrainingSample(user);
      this.setData({ canSaveTrainingSample });
    };

    if (!localUserId) {
      setSampleSaveAccess(localUser);
      return true;
    }

    if (!this.initCloud()) {
      setSampleSaveAccess(localUser);
      return true;
    }

    try {
      const db = wx.cloud.database();
      const res = await db.collection(USER_COLLECTION).doc(localUserId).get();
      const latestUser = res && res.data ? res.data : null;
      if (latestUser) {
        wx.setStorageSync("userInfo", {
          ...localUser,
          ...latestUser,
        });
        setSampleSaveAccess(latestUser);
        return true;
      }
      setSampleSaveAccess(localUser);
      return true;
    } catch (error) {
      console.error("ensure sensor debug access failed:", error);
      setSampleSaveAccess(localUser);
      return true;
    }
  },

  getWeightShiftSuggestion(score) {
    const s = Number(score) || 0;
    const fixedTip = "先稳重心，再蹬腿发力。注意肩部姿态：摆臂发力时不要伴随转肩动作，避免破坏身体姿态。摆臂过程中请固定肩部姿态，全程不转肩，维持上半身稳定";
    if (s >= 90) return { toast: "优秀！节奏连贯", tip: fixedTip };
    if (s >= 75) return { toast: "动作良好", tip: fixedTip };
    if (s >= 60) return { toast: "继续加油", tip: fixedTip };
    return { toast: "先练稳定性", tip: fixedTip };
  },

  startAutoVoice() {
    const score = Number(this.data.latestAnalyzeScore) || 0;
    const level = String(this.data.latestAnalyzeLevel || "").trim();
    const tip = String(this.data.weightShiftTip || "").trim();
    const text = `分数${score}分，等级${level}。${tip}`;
    if (this.data._voiceCtx) {
      this.data._voiceCtx.destroy();
    }
    const ctx = wx.createInnerAudioContext();
    ctx.onEnded(() => {
      this.setData({ voicePlaying: false });
    });
    ctx.onStop(() => {
      this.setData({ voicePlaying: false });
    });
    ctx.onError(() => {
      this.setData({ voicePlaying: false });
    });
    this.setData({ _voiceCtx: ctx, voicePlaying: false });
    plugin.textToSpeech({
      lang: "zh_CN",
      tts: true,
      content: text,
      success: (res) => {
        ctx.src = res.filename;
        ctx.play();
        this.setData({ voicePlaying: true });
      },
      fail: (err) => {
        this.setData({ voicePlaying: false });
      }
    });
  },

  onTapPlayVoice() {
    const ctx = this.data._voiceCtx;
    if (!ctx) {
      this.startAutoVoice();
      return;
    }
    if (this.data.voicePlaying) {
      ctx.pause();
      this.setData({ voicePlaying: false });
    } else {
      ctx.play();
      this.setData({ voicePlaying: true });
    }
  },

  maskPhone(phone) {
    const raw = String(phone || "").replace(/\s+/g, "");
    if (!/^1\d{10}$/.test(raw)) {
      return raw || "未绑定手机号";
    }
    return `${raw.slice(0, 3)}****${raw.slice(7)}`;
  },

  normalizeStudentOption(item) {
    const safe = item && typeof item === "object" ? item : {};
    const id = String(safe._id || safe.id || "").trim();
    const name = String(safe.name || safe.nickName || "未命名学员").trim();
    const phone = this.maskPhone(safe.phone || safe.mobile || "");
    return {
      id,
      label: `${name}（${phone}）`,
    };
  },

  async queryStudents() {
    const db = wx.cloud.database();
    const _ = db.command;
    const role = this.getCurrentRole();
    const coachId = this.getCurrentUserId();

    if (role !== "admin" && !coachId) {
      return [];
    }

    let filter = { role: "student" };
    if (role !== "admin" && coachId) {
      filter = _.or([
        { role: "student", coachId },
        { role: "student", coachIds: _.in([coachId]) },
      ]);
    }

    return db.collection(USER_COLLECTION)
      .where(filter)
      .limit(200)
      .get()
      .then((res) => (res && Array.isArray(res.data) ? res.data : []));
  },

  loadStudentOptions() {
    if (!this.initCloud()) {
      this.setData({
        studentOptions: [],
        studentIndex: 0,
        studentLoadError: "当前环境不支持云开发。",
      });
      return;
    }

    this.setData({
      studentLoading: true,
      studentLoadError: "",
    });

    this.queryStudents()
      .then((list) => {
        const options = (Array.isArray(list) ? list : [])
          .map((item) => this.normalizeStudentOption(item))
          .filter((item) => item.id);
        if (!options.length) {
          this.setData({
            studentOptions: [],
            studentIndex: 0,
            userId: "",
            studentLoadError: "暂无可选学员，请先在“我的学生”中分配学员。",
          });
          return;
        }
        this.setData({
          studentOptions: options,
          studentIndex: 0,
          userId: options[0].id,
        });
      })
      .catch((error) => {
        console.error("load student options failed:", error);
        this.setData({
          studentOptions: [],
          studentIndex: 0,
          userId: "",
          studentLoadError: "加载学员失败，请稍后重试。",
        });
      })
      .finally(() => {
        this.setData({ studentLoading: false });
      });
  },

  onChangeActionType(e) {
    const index = Number(e.detail && e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.actionTypeOptions.length) {
      return;
    }
    this.clearResultShowcaseTimer();
    this.setData({
      actionTypeIndex: index,
      lastAnalyzeResult: "",
      lastFrameSize: 0,
      lastAnalyzeAtText: "-",
      analyzeResultExpanded: false,
      resultShowcaseVisible: false,
    });
    this._lastAnalyzeKey = "";
    this._lastFrames = null;
    this._lastFrameSourceType = "";
  },

  onTapSourceTypePreset(e) {
    const index = Number(e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : NaN);
    if (!Number.isInteger(index)) {
      return;
    }
    this.onChangeSourceType({ detail: { value: index } });
  },

  onChangeSourceType(e) {
    const index = Number(e.detail && e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.sourceTypeOptions.length) {
      return;
    }
    const options = this.data.sourceTypeOptions || [];
    const currentIndex = Number(this.data.sourceTypeIndex);
    const previous = options[currentIndex] ? String(options[currentIndex].value || "").trim() : SOURCE_TYPE_MOCK;
    const next = options[index] ? String(options[index].value || "").trim() : SOURCE_TYPE_MOCK;

    this.setData({ sourceTypeIndex: index });
    if (previous !== next) {
      this.clearResultShowcaseTimer();
      this._lastAnalyzeKey = "";
      this._lastFrames = null;
      this._lastFrameSourceType = "";
      this.setData({
        lastAnalyzeResult: "",
        lastSaveResult: "",
        lastFrameSize: 0,
        lastAnalyzeAtText: "-",
        lastSaveAtText: "-",
        analyzeResultExpanded: false,
        saveResultExpanded: false,
        resultShowcaseVisible: false,
      });
    }
  },

  onTapSessionId(e) {
    const index = Number(e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.sessionIdOptions.length) {
      return;
    }
    this.setData({ sessionIdIndex: index });
  },

  onTapQualityTag(e) {
    const index = Number(e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : -1);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.qualityTagOptions.length) {
      return;
    }
    const options = this.data.qualityTagOptions || [];
    const selected = options[index] ? String(options[index].value).trim() : "";
    this.setData({ qualityTagIndex: index, qualityTag: selected || DEFAULT_QUALITY_TAG });
  },

  onChangeStudent(e) {
    const index = Number(e.detail && e.detail.value);
    const options = Array.isArray(this.data.studentOptions) ? this.data.studentOptions : [];
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      return;
    }
    this.clearResultShowcaseTimer();
    this.setData({
      studentIndex: index,
      userId: options[index].id,
      lastAnalyzeResult: "",
      lastFrameSize: 0,
      lastAnalyzeAtText: "-",
      analyzeResultExpanded: false,
      resultShowcaseVisible: false,
    });
    this._lastAnalyzeKey = "";
    this._lastFrames = null;
    this._lastFrameSourceType = "";
  },

  onChangeField(e) {
    const field = String(e.currentTarget.dataset.field || "").trim();
    if (!field) {
      return;
    }
    const nextValue = e.detail && typeof e.detail.value !== "undefined" ? e.detail.value : "";
    const patch = {
      [field]: nextValue,
    };
    if (field === "frameCount" || field === "sampleIntervalMs") {
      this.clearResultShowcaseTimer();
      patch.lastAnalyzeResult = "";
      patch.lastFrameSize = 0;
      patch.lastAnalyzeAtText = "-";
      patch.analyzeResultExpanded = false;
      patch.resultShowcaseVisible = false;
      this._lastFrames = null;
      this._lastFrameSourceType = "";
      this._lastAnalyzeKey = "";
    }
    this.setData(patch);
  },

  formatNowTime() {
    const date = new Date();
    const pad = (num) => String(num).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },

  onTapFramePreset(e) {
    const value = Number(e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.value : NaN);
    if (!Number.isInteger(value) || value < 20 || value > 180) {
      return;
    }
    this.clearResultShowcaseTimer();
    this._lastAnalyzeKey = "";
    this._lastFrames = null;
    this._lastFrameSourceType = "";
    this.setData({
      frameCount: value,
      lastAnalyzeResult: "",
      lastFrameSize: 0,
      lastAnalyzeAtText: "-",
      analyzeResultExpanded: false,
      resultShowcaseVisible: false,
    });
  },

  onTapSampleIntervalPreset(e) {
    const value = Number(e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.value : NaN);
    if (!Number.isInteger(value) || value < MIN_SAMPLE_INTERVAL_MS || value > MAX_SAMPLE_INTERVAL_MS) {
      return;
    }
    this.clearResultShowcaseTimer();
    this._lastAnalyzeKey = "";
    this._lastFrames = null;
    this._lastFrameSourceType = "";
    this.setData({
      sampleIntervalMs: value,
      lastAnalyzeResult: "",
      lastFrameSize: 0,
      lastAnalyzeAtText: "-",
      analyzeResultExpanded: false,
      resultShowcaseVisible: false,
    });
  },

  clearAnalyzeFlowTimer() {
    if (this._analyzeFlowTimer) {
      clearInterval(this._analyzeFlowTimer);
      this._analyzeFlowTimer = null;
    }
  },

  clearResultShowcaseTimer() {
    if (this._resultShowcaseTimer) {
      clearInterval(this._resultShowcaseTimer);
      this._resultShowcaseTimer = null;
    }
  },

  buildBigScreenSnapshot() {
    return {
      capturedAt: Date.now(),
      sessionId: String(this.data.sessionId || "").trim(),
      actionTypeLabel: this.getCurrentActionTypeLabel(),
      sourceTypeLabel: (() => {
        const options = Array.isArray(this.data.sourceTypeOptions) ? this.data.sourceTypeOptions : [];
        const index = Number(this.data.sourceTypeIndex);
        if (!Number.isInteger(index) || index < 0 || index >= options.length) {
          return "模拟数据";
        }
        return String(options[index].label || "").trim() || "模拟数据";
      })(),
      frameCount: Number(this.data.frameCount || 0),
      sampleIntervalMs: Number(this.data.sampleIntervalMs || 0),
      analyzeFlowVisible: !!this.data.analyzeFlowVisible,
      analyzeFlowDone: !!this.data.analyzeFlowDone,
      analyzeFlowProgress: Number(this.data.analyzeFlowProgress || 0),
      analyzeFlowElapsedSec: Number(this.data.analyzeFlowElapsedSec || 0),
      analyzeFlowStatusText: String(this.data.analyzeFlowStatusText || "").trim(),
      analyzeFlowStages: Array.isArray(this.data.analyzeFlowStages) ? this.data.analyzeFlowStages : [],
      analyzeFlowBars: Array.isArray(this.data.analyzeFlowBars) ? this.data.analyzeFlowBars : [],
      analyzeFlowMetrics: Array.isArray(this.data.analyzeFlowMetrics) ? this.data.analyzeFlowMetrics : [],
      analyzeFlowEvents: Array.isArray(this.data.analyzeFlowEvents) ? this.data.analyzeFlowEvents : [],
      analyzeNumberStream: Array.isArray(this.data.analyzeNumberStream) ? this.data.analyzeNumberStream : [],
      resultShowcaseVisible: !!this.data.resultShowcaseVisible,
      resultShowcaseDone: !!this.data.resultShowcaseDone,
      resultShowcaseActionLabel: String(this.data.resultShowcaseActionLabel || "").trim(),
      resultShowcaseSummary: String(this.data.resultShowcaseSummary || "").trim(),
      resultShowcaseModelScore: Number(this.data.resultShowcaseModelScore || 0),
      resultShowcaseCoachScore: Number(this.data.resultShowcaseCoachScore || 0),
      resultShowcaseConfidence: Number(this.data.resultShowcaseConfidence || 0),
      resultShowcaseQualityTag: String(this.data.resultShowcaseQualityTag || "").trim(),
      resultShowcaseCoachComment: String(this.data.resultShowcaseCoachComment || "").trim(),
      resultShowcaseStrengths: Array.isArray(this.data.resultShowcaseStrengths) ? this.data.resultShowcaseStrengths : [],
      resultShowcaseImprovements: Array.isArray(this.data.resultShowcaseImprovements) ? this.data.resultShowcaseImprovements : [],
      resultShowcaseTips: Array.isArray(this.data.resultShowcaseTips) ? this.data.resultShowcaseTips : [],
      resultShowcaseTags: String(this.data.resultShowcaseTags || "").trim(),
      resultShowcaseInferenceMode: String(this.data.resultShowcaseInferenceMode || "").trim(),
      resultShowcaseModelVersion: String(this.data.resultShowcaseModelVersion || "").trim(),
      resultShowcaseApiError: String(this.data.resultShowcaseApiError || "").trim(),
      errorTip: String(this.data.errorTip || "").trim(),
    };
  },

  persistBigScreenSnapshot() {
    try {
      wx.setStorageSync(BIG_SCREEN_SNAPSHOT_STORAGE_KEY, this.buildBigScreenSnapshot());
    } catch (error) {}
  },

  onToggleBigScreenMode() {
    if (!SENSOR_BIG_SCREEN_ENABLED) {
      wx.showToast({
        title: SENSOR_BIG_SCREEN_LOCK_MESSAGE,
        icon: "none",
      });
      return;
    }
    this.persistBigScreenSnapshot();
    wx.navigateTo({
      url: "/pages/coach/sensor/display/display",
    });
  },

  startAnalyzeFlow(sourceType) {
    const normalizedSourceType = String(sourceType || this.getCurrentSourceTypeValue() || SOURCE_TYPE_MOCK).trim() || SOURCE_TYPE_MOCK;
    this.clearAnalyzeFlowTimer();
    this._analyzeFlowStartedAt = Date.now();
    this._analyzeFlowSourceType = normalizedSourceType;
    this._analyzeFlowTick = 0;
    this._analyzeFlowLastCollectRenderAt = 0;
    this._analyzeFlowLastCollectBucket = -1;
    this._analyzeFlowLastStreamAt = 0;
    this._analyzeFlowLastStreamFrameCount = 0;
    this._analyzeFlowLastPhase = "";
    this.setData({
      analyzeFlowVisible: true,
      analyzeFlowDone: false,
      analyzeFlowProgress: 2,
      analyzeFlowElapsedSec: 0,
      analyzeFlowStatusText: resolveAnalyzeFlowStatusText({
        progress: 2,
        sourceType: normalizedSourceType,
        done: false,
        failed: false,
      }),
      analyzeFlowStages: buildAnalyzeFlowStages(2, false),
      analyzeFlowBars: buildAnalyzeFlowBars(0),
      analyzeFlowMetrics: buildAnalyzeFlowMetrics(2, 0),
      analyzeFlowEvents: [
        {
          id: `flow_start_${Date.now()}`,
          time: this.formatNowTime(),
          level: "info",
          text: "流程启动，等待采样",
        },
      ],
      analyzeNumberStream: [
        {
          id: `flow_stream_start_${Date.now()}`,
          time: this.formatNowTime(),
          tone: "info",
          text: "stream:init 等待设备数据...",
        },
      ],
    });
    this.persistBigScreenSnapshot();
    this._analyzeFlowTimer = setInterval(() => {
      this._analyzeFlowTick += 1;
      const elapsedMs = Math.max(0, Date.now() - this._analyzeFlowStartedAt);
      const maxProgress = normalizedSourceType === SOURCE_TYPE_REAL_DEVICE ? 92 : 95;
      const flowPhase = String(this._analyzeFlowLastPhase || "");
      const lockCollectStatus = flowPhase === "prepare" || flowPhase === "collecting" || flowPhase === "timeout";
      const baseProgress = lockCollectStatus
        ? Number(this.data.analyzeFlowProgress || 0)
        : Math.min(maxProgress, 2 + Math.floor(elapsedMs / 260));
      const progress = Math.max(Number(this.data.analyzeFlowProgress || 0), baseProgress);
      const statusText = lockCollectStatus
        ? String(this.data.analyzeFlowStatusText || "")
        : resolveAnalyzeFlowStatusText({
          progress,
          sourceType: normalizedSourceType,
          done: false,
          failed: false,
        });
      this.setData({
        analyzeFlowProgress: progress,
        analyzeFlowElapsedSec: Math.max(
          1,
          Math.floor((nowMs - Number(this._analyzeFlowStartedAt || nowMs)) / 1000)
        ),
        analyzeFlowStatusText: statusText,
        analyzeFlowStages: buildAnalyzeFlowStages(progress, false),
        analyzeFlowBars: buildAnalyzeFlowBars(this._analyzeFlowTick),
        analyzeFlowMetrics: buildAnalyzeFlowMetrics(progress, this._analyzeFlowTick),
      });
      this.persistBigScreenSnapshot();
    }, 220);
  },

  finishAnalyzeFlow(success) {
    const done = !!success;
    const failed = !done;
    const elapsedMs = Math.max(0, Date.now() - Number(this._analyzeFlowStartedAt || Date.now()));
    this.clearAnalyzeFlowTimer();
    const progress = done ? 100 : Math.max(6, clampPercent(this.data.analyzeFlowProgress || 0));
    this._analyzeFlowTick += 1;
    this.setData({
      analyzeFlowVisible: true,
      analyzeFlowDone: done,
      analyzeFlowProgress: progress,
      analyzeFlowElapsedSec: Math.max(1, Math.floor(elapsedMs / 1000)),
      analyzeFlowStatusText: resolveAnalyzeFlowStatusText({
        progress,
        sourceType: this._analyzeFlowSourceType,
        done,
        failed,
      }),
      analyzeFlowStages: buildAnalyzeFlowStages(progress, done),
      analyzeFlowBars: buildAnalyzeFlowBars(this._analyzeFlowTick),
      analyzeFlowMetrics: buildAnalyzeFlowMetrics(progress, this._analyzeFlowTick),
    });
    this.persistBigScreenSnapshot();
  },

  appendAnalyzeFlowEvent(text, level = "info") {
    const safeText = String(text || "").trim();
    if (!safeText) {
      return;
    }
    const events = Array.isArray(this.data.analyzeFlowEvents) ? this.data.analyzeFlowEvents.slice() : [];
    events.unshift({
      id: `flow_evt_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      time: this.formatNowTime(),
      level: String(level || "info").trim() || "info",
      text: safeText,
    });
    this.setData({
      analyzeFlowEvents: events.slice(0, 8),
    });
    this.persistBigScreenSnapshot();
  },

  pushAnalyzeNumberStream(text, tone = "info") {
    const safeText = String(text || "").trim();
    if (!safeText) {
      return;
    }
    const list = Array.isArray(this.data.analyzeNumberStream) ? this.data.analyzeNumberStream.slice() : [];
    list.unshift({
      id: `flow_stream_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      time: this.formatNowTime(),
      tone: String(tone || "info").trim() || "info",
      text: safeText,
    });
    this.setData({
      analyzeNumberStream: list.slice(0, ANALYZE_NUMBER_STREAM_MAX),
    });
    this.persistBigScreenSnapshot();
  },

  appendNumberStreamFromProgress(progressInfo, collected, target, phase) {
    const safe = progressInfo && typeof progressInfo === "object" ? progressInfo : {};
    const nowMs = Date.now();
    if (phase === "collecting") {
      if (this._analyzeFlowLastStreamAt && nowMs - this._analyzeFlowLastStreamAt < 160) {
        return;
      }
      const currentCount = Math.max(0, Number(collected || 0));
      if (currentCount <= Number(this._analyzeFlowLastStreamFrameCount || 0)) {
        return;
      }
      this._analyzeFlowLastStreamAt = nowMs;
      this._analyzeFlowLastStreamFrameCount = currentCount;
      const notifyCount = Math.max(0, Number(safe.notifyCount || 0));
      const parsedEntryCount = Math.max(0, Number(safe.parsedEntryCount || 0));
      const activeRoleCount = Math.max(0, Number(safe.activeRoleCount || 0));
      const sampleRole = String(safe.sampleRole || "").trim();
      const samplePoint = safe.samplePoint && typeof safe.samplePoint === "object" ? safe.samplePoint : null;
      if (sampleRole && samplePoint) {
        this.pushAnalyzeNumberStream(
          `${sampleRole} ax:${safeRound(samplePoint.ax)} ay:${safeRound(samplePoint.ay)} az:${safeRound(samplePoint.az)} gx:${safeRound(samplePoint.gx)} gy:${safeRound(samplePoint.gy)} gz:${safeRound(samplePoint.gz)} | ${currentCount}/${target}`,
          "data"
        );
        return;
      }
      const chunkPreview = String(safe.lastChunkPreview || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (chunkPreview) {
        this.pushAnalyzeNumberStream(
          `raw:${chunkPreview} | frame ${currentCount}/${target}`,
          "data"
        );
        return;
      }
      this.pushAnalyzeNumberStream(
        `frame ${currentCount}/${target} | notify:${notifyCount} parsed:${parsedEntryCount} activeRoles:${activeRoleCount}`,
        "data"
      );
      return;
    }
    if (phase === "prepare") {
      this.pushAnalyzeNumberStream("stream:init 连接完成，等待首帧数据...", "info");
      return;
    }
    if (phase === "done") {
      this.pushAnalyzeNumberStream(`stream:done 采样完成 ${collected}/${target}`, "success");
      return;
    }
    if (phase === "timeout") {
      this.pushAnalyzeNumberStream(`stream:timeout 采样超时 ${collected}/${target}`, "error");
    }
  },

  buildShowcaseSummary(result) {
    const safeResult = result && typeof result === "object" ? result : {};
    const analysis = safeResult.analysis && typeof safeResult.analysis === "object" ? safeResult.analysis : {};
    const modelScore = clamp(Math.round(Number(analysis.overallScore || 0)), 0, 100);
    const qualityTag = resolveModelLevelFromAnalysis(analysis, modelScore);
    const inferenceMode = String(safeResult.inferenceMode || "").trim();
    const apiError = String(safeResult.apiError || "").trim();
    const modelVersion = String(
      analysis.modelVersion
      || safeResult.modelVersion
      || (analysis.sensorSession && analysis.sensorSession.modelVersion)
      || ""
    ).trim();
    const summaryText = `评分 ${modelScore} 分，等级 ${qualityTag}`;
    return {
      actionLabel: this.getCurrentActionTypeLabel(),
      summaryText,
      modelScore,
      coachScore: modelScore,
      confidence: modelScore,
      qualityTag,
      coachComment: "",
      strengths: [],
      improvements: [],
      tips: [],
      tags: "",
      inferenceMode,
      modelVersion,
      apiError,
    };
  },

  playShowcase(summary) {
    const safe = summary && typeof summary === "object" ? summary : {};
    const targetScore = clamp(Math.round(Number(safe.modelScore || 0)), 0, 100);
    this.clearResultShowcaseTimer();
    this.setData({
      resultShowcaseVisible: true,
      resultShowcaseDone: false,
      resultShowcaseActionLabel: String(safe.actionLabel || this.getCurrentActionTypeLabel()).trim(),
      resultShowcaseSummary: String(safe.summaryText || "动作分析完成").trim(),
      resultShowcaseModelScore: 0,
      resultShowcaseTargetScore: targetScore,
      resultShowcaseCoachScore: clamp(Math.round(Number(safe.coachScore || this.data.coachScore || 0)), 0, 100),
      resultShowcaseConfidence: clamp(Math.round(Number(safe.confidence || 0)), 0, 100),
      resultShowcaseQualityTag: String(safe.qualityTag || this.data.qualityTag || "").trim(),
      resultShowcaseCoachComment: String(safe.coachComment || this.data.coachComment || "").trim(),
      resultShowcaseStrengths: Array.isArray(safe.strengths) ? safe.strengths : [],
      resultShowcaseImprovements: Array.isArray(safe.improvements) ? safe.improvements : [],
      resultShowcaseTips: Array.isArray(safe.tips) ? safe.tips : [],
      resultShowcaseTags: String(safe.tags || "").trim(),
      resultShowcaseInferenceMode: String(safe.inferenceMode || "").trim(),
      resultShowcaseModelVersion: String(safe.modelVersion || "").trim(),
      resultShowcaseApiError: String(safe.apiError || "").trim(),
    });
    this.persistBigScreenSnapshot();
    this._resultShowcaseTimer = setInterval(() => {
      const current = clamp(Math.round(Number(this.data.resultShowcaseModelScore || 0)), 0, 100);
      if (current >= targetScore) {
        this.clearResultShowcaseTimer();
        this.setData({
          resultShowcaseModelScore: targetScore,
          resultShowcaseDone: true,
        });
        this.persistBigScreenSnapshot();
        return;
      }
      const next = Math.min(targetScore, current + Math.max(1, Math.ceil((targetScore - current) / 4)));
      this.setData({
        resultShowcaseModelScore: next,
      });
      this.persistBigScreenSnapshot();
    }, SHOWCASE_SCORE_TICK_MS);
  },

  updateAnalyzeFlowFromCollectProgress(progressInfo) {
    const nowMs = Date.now();
    const safe = progressInfo && typeof progressInfo === "object" ? progressInfo : {};
    const phase = String(safe.phase || "collecting").trim() || "collecting";
    const lastRenderAt = Number(this._analyzeFlowLastCollectRenderAt || 0);
    if (phase === "collecting" && lastRenderAt && nowMs - lastRenderAt < 120) {
      return;
    }
    this._analyzeFlowLastCollectRenderAt = nowMs;
    const collected = Math.max(0, Number(safe.collectedCount || safe.collected || 0));
    const target = Math.max(1, Number(safe.frameCount || safe.targetCount || this.data.frameCount || 1));
    const ratio = clamp(collected / target, 0, 1);
    let nextProgress = Math.max(
      Number(this.data.analyzeFlowProgress || 0),
      Math.round(18 + ratio * 42)
    );
    let statusText = `采集中 ${collected}/${target} 帧`;
    if (phase === "prepare") {
      nextProgress = Math.max(nextProgress, 10);
      statusText = "设备就绪，等待首帧...";
    } else if (phase === "done") {
      nextProgress = Math.max(nextProgress, 64);
      statusText = `采样完成 ${collected}/${target} 帧`;
    } else if (phase === "timeout") {
      nextProgress = Math.max(nextProgress, Math.round(24 + ratio * 32));
      statusText = `采样超时 ${collected}/${target} 帧`;
    }
    const phaseChanged = phase !== this._analyzeFlowLastPhase;
    if (phaseChanged) {
      if (phase === "prepare") {
        this.appendAnalyzeFlowEvent("设备已就绪，准备开始采样", "info");
      } else if (phase === "collecting") {
        this.appendAnalyzeFlowEvent("实时采样中：帧流已开始进入", "info");
      } else if (phase === "done") {
        this.appendAnalyzeFlowEvent(`采样结束：${collected} 帧入队`, "success");
      } else if (phase === "timeout") {
        this.appendAnalyzeFlowEvent(`采样超时：仅收集 ${collected}/${target} 帧`, "error");
      }
      this._analyzeFlowLastPhase = phase;
    }
    const collectBucket = Math.floor(ratio * 4);
    if (phase === "collecting" && collectBucket > this._analyzeFlowLastCollectBucket && collectBucket > 0) {
      this._analyzeFlowLastCollectBucket = collectBucket;
      this.appendAnalyzeFlowEvent(
        `采样进度 ${collectBucket * 25}%（${collected}/${target} 帧）`,
        "info"
      );
    }
    this.appendNumberStreamFromProgress(safe, collected, target, phase);
    this._analyzeFlowTick += 1;
    this.setData({
      analyzeFlowProgress: nextProgress,
      analyzeFlowElapsedSec: Math.max(
        1,
        Math.floor((nowMs - Number(this._analyzeFlowStartedAt || nowMs)) / 1000)
      ),
      analyzeFlowStatusText: statusText,
      analyzeFlowStages: buildAnalyzeFlowStages(nextProgress, false),
      analyzeFlowBars: buildAnalyzeFlowBars(this._analyzeFlowTick),
      analyzeFlowMetrics: buildAnalyzeFlowMetrics(nextProgress, this._analyzeFlowTick),
    });
    this.persistBigScreenSnapshot();
  },

  async buildMockFramesWithProgress({ frameCount, sampleIntervalMs }) {
    const targetCount = Math.max(20, Math.floor(Number(frameCount) || 20));
    const intervalMs = Math.max(MIN_SAMPLE_INTERVAL_MS, Math.floor(Number(sampleIntervalMs) || 50));
    const start = Date.now();
    const frames = [];
    const chunkSize = Math.max(4, Math.ceil(targetCount / 28));
    while (frames.length < targetCount) {
      const currentSize = frames.length;
      const loopCount = Math.min(chunkSize, targetCount - currentSize);
      for (let i = 0; i < loopCount; i += 1) {
        const index = currentSize + i;
        const phase = index / Math.max(1, targetCount - 1);
        const swing = Math.sin(phase * Math.PI * 2);
        const frame = {
          t: start + index * intervalMs,
          points: {},
        };
        SENSOR_ROLES.forEach((role, idx) => {
          const roleOffset = idx * 0.05;
          frame.points[role] = {
            ax: round3(0.15 + swing * 0.25 + roleOffset + randomIn(-0.03, 0.03)),
            ay: round3(0.25 + Math.cos(phase * Math.PI * 2 + idx * 0.3) * 0.2 + randomIn(-0.03, 0.03)),
            az: round3(0.95 + randomIn(-0.08, 0.08)),
            gx: round3(0.1 + swing * 0.35 + randomIn(-0.04, 0.04)),
            gy: round3(0.05 + Math.cos(phase * Math.PI * 2) * 0.3 + randomIn(-0.04, 0.04)),
            gz: round3(0.08 + swing * 0.28 + randomIn(-0.04, 0.04)),
          };
        });
        frames.push(frame);
      }
      this.updateAnalyzeFlowFromCollectProgress({
        phase: "collecting",
        collectedCount: frames.length,
        frameCount: targetCount,
        sampleRole: "head",
        samplePoint: frames.length && frames[frames.length - 1] && frames[frames.length - 1].points
          ? frames[frames.length - 1].points.head
          : null,
        notifyCount: frames.length,
        parsedEntryCount: frames.length * SENSOR_ROLES.length,
        activeRoleCount: SENSOR_ROLES.length,
      });
      await delay(42);
    }
    this.updateAnalyzeFlowFromCollectProgress({
      phase: "done",
      collectedCount: frames.length,
      frameCount: targetCount,
    });
    return frames;
  },

  toggleLabelSection() {
    this.setData({
      labelSectionCollapsed: !this.data.labelSectionCollapsed,
    });
  },

  onTapSuggestionNum(e) {
    const num = Number(e.currentTarget.dataset.num);
    if (!num || num < 1 || num > 8) return;
    const key = "suggestion" + num;
    const current = !!this.data[key];
    const upd = {};
    upd[key] = !current;
    this.setData(upd);
  },

  onTapFillLabelTemplate() {
    this.setData({
      coachScore: 82,
      qualityTag: "良好",
      qualityTagIndex: 2,
      tagsText: "平衡,稳定",
      coachComment: "基础动作较稳定，建议继续练习并强化节奏。",
      labelSectionCollapsed: false,
    });
  },

  toggleAnalyzeResult() {
    if (!this.data.lastAnalyzeResult) {
      return;
    }
    this.setData({
      analyzeResultExpanded: !this.data.analyzeResultExpanded,
    });
  },

  toggleSaveResult() {
    if (!this.data.lastSaveResult) {
      return;
    }
    this.setData({
      saveResultExpanded: !this.data.saveResultExpanded,
    });
  },

  onToggleBleDebug() {
    this.setData({
      bleDebugExpanded: !this.data.bleDebugExpanded,
    });
    if (!this.data.bleDebugExpanded) {
      this.syncBleDebugInfo();
    }
  },

  getCurrentActionTypeValue() {
    const options = Array.isArray(this.data.actionTypeOptions) ? this.data.actionTypeOptions : [];
    const index = Number(this.data.actionTypeIndex);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      return "sensor_session";
    }
    return String(options[index].value || "sensor_session").trim() || "sensor_session";
  },

  getCurrentActionTypeLabel() {
    const options = Array.isArray(this.data.actionTypeOptions) ? this.data.actionTypeOptions : [];
    const index = Number(this.data.actionTypeIndex);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      return "传感器会话";
    }
    return String(options[index].label || "传感器会话").trim() || "传感器会话";
  },

  getCurrentSourceTypeValue() {
    const options = Array.isArray(this.data.sourceTypeOptions) ? this.data.sourceTypeOptions : [];
    const index = Number(this.data.sourceTypeIndex);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      return "mock";
    }
    return String(options[index].value || "mock").trim() || "mock";
  },

  shouldAllowSinglePointDebug(sourceType) {
    return String(sourceType || "").trim() === SOURCE_TYPE_REAL_DEVICE;
  },

  getNormalizedFrameCount() {
    const value = Number(this.data.frameCount);
    if (!Number.isFinite(value)) {
      return NaN;
    }
    return Math.floor(value);
  },

  getNormalizedSampleIntervalMs() {
    const value = Number(this.data.sampleIntervalMs);
    if (!Number.isFinite(value)) {
      return NaN;
    }
    return Math.floor(value);
  },

  validateCommonInput() {
    const sessionId = String(this.data.sessionId || "").trim();
    if (!sessionId) {
      return { ok: false, message: "会话编号不能为空" };
    }
    if (sessionId.length > 64) {
      return { ok: false, message: "会话编号不能超过 64 个字符" };
    }
    const frameCount = this.getNormalizedFrameCount();
    if (!Number.isInteger(frameCount) || frameCount < 20 || frameCount > 180) {
      return { ok: false, message: "帧数需在 20 到 180 之间" };
    }
    const sampleIntervalMs = this.getNormalizedSampleIntervalMs();
    if (
      !Number.isInteger(sampleIntervalMs)
      || sampleIntervalMs < MIN_SAMPLE_INTERVAL_MS
      || sampleIntervalMs > MAX_SAMPLE_INTERVAL_MS
    ) {
      return { ok: false, message: `采样间隔需在 ${MIN_SAMPLE_INTERVAL_MS} 到 ${MAX_SAMPLE_INTERVAL_MS}ms 之间` };
    }

    const note = String(this.data.note || "").trim();
    if (note.length > 120) {
      return { ok: false, message: "备注不能超过 120 个字符" };
    }

    return { ok: true };
  },

  validateSaveInput() {
    const commonCheck = this.validateCommonInput();
    if (!commonCheck.ok) {
      return commonCheck;
    }

    const coachScore = Number(this.data.coachScore);
    if (!Number.isFinite(coachScore) || coachScore < 0 || coachScore > 100) {
      return { ok: false, message: "教练评分需在 0 到 100 之间" };
    }

    const qualityTag = this.getSelectedQualityTag();
    if (!qualityTag) {
      return { ok: false, message: "质量标签不能为空" };
    }
    if (qualityTag.length > 24) {
      return { ok: false, message: "质量标签不能超过 24 个字符" };
    }

    const coachComment = String(this.data.coachComment || "").trim();
    if (!coachComment) {
      return { ok: false, message: "教练评语不能为空" };
    }
    if (coachComment.length > 200) {
      return { ok: false, message: "教练评语不能超过 200 个字符" };
    }

    const tags = splitTags(this.data.tagsText);
    if (tags.length > 10) {
      return { ok: false, message: "标签最多 10 个" };
    }
    if (tags.some((item) => item.length > 20)) {
      return { ok: false, message: "单个标签不能超过 20 个字符" };
    }

    return { ok: true };
  },

  getCachedFramesForSource(sourceType) {
    const normalizedSource = String(sourceType || "").trim() || SOURCE_TYPE_MOCK;
    if (!Array.isArray(this._lastFrames) || !this._lastFrames.length) {
      return null;
    }
    if (String(this._lastFrameSourceType || "") !== normalizedSource) {
      return null;
    }
    return this._lastFrames;
  },

  async buildFramesBySource({ sourceType, sessionId, userId, actionType }) {
    const normalizedSource = String(sourceType || "").trim() || SOURCE_TYPE_MOCK;
    const targetFrameCount = clamp(this.getNormalizedFrameCount(), 20, 180);
    const sampleIntervalMs = clamp(
      this.getNormalizedSampleIntervalMs(),
      MIN_SAMPLE_INTERVAL_MS,
      MAX_SAMPLE_INTERVAL_MS
    );
    if (normalizedSource !== SOURCE_TYPE_REAL_DEVICE) {
      return this.buildMockFramesWithProgress({
        frameCount: targetFrameCount,
        sampleIntervalMs,
      });
    }
    this.enforceMultiRoleBleConfig();
    const estimatedCollectMs = targetFrameCount * sampleIntervalMs;
    const timeoutMs = Math.max(45000, estimatedCollectMs + 20000);
    return collectRealDeviceFrames({
      sessionId,
      userId,
      actionType,
      note: String(this.data.note || "").trim(),
      frameCount: targetFrameCount,
      sampleIntervalMs,
      timeoutMs,
      roles: SENSOR_ROLES,
      onProgress: (progress) => {
        this.updateAnalyzeFlowFromCollectProgress(progress);
      },
    });
  },

  buildMockFrames() {
    const frameCount = clamp(this.getNormalizedFrameCount(), 20, 180);
    const sampleIntervalMs = clamp(
      this.getNormalizedSampleIntervalMs(),
      MIN_SAMPLE_INTERVAL_MS,
      MAX_SAMPLE_INTERVAL_MS
    );
    const start = Date.now();
    const frames = [];

    for (let i = 0; i < frameCount; i += 1) {
      const phase = i / Math.max(1, frameCount - 1);
      const swing = Math.sin(phase * Math.PI * 2);
      const frame = {
        t: start + i * sampleIntervalMs,
        points: {},
      };
      SENSOR_ROLES.forEach((role, idx) => {
        const roleOffset = idx * 0.05;
        frame.points[role] = {
          ax: round3(0.15 + swing * 0.25 + roleOffset + randomIn(-0.03, 0.03)),
          ay: round3(0.25 + Math.cos(phase * Math.PI * 2 + idx * 0.3) * 0.2 + randomIn(-0.03, 0.03)),
          az: round3(0.95 + randomIn(-0.08, 0.08)),
          gx: round3(0.1 + swing * 0.35 + randomIn(-0.04, 0.04)),
          gy: round3(0.05 + Math.cos(phase * Math.PI * 2) * 0.3 + randomIn(-0.04, 0.04)),
          gz: round3(0.08 + swing * 0.28 + randomIn(-0.04, 0.04)),
        };
      });
      frames.push(frame);
    }
    return frames;
  },

  validateFramesLocally(frames) {
    const list = Array.isArray(frames) ? frames : [];
    const totalFrames = list.length;
    const minFrames = 24;
    const coverage = {};
    const roleHasData = {};

    SENSOR_ROLES.forEach((role) => {
      coverage[role] = 0;
      roleHasData[role] = false;
    });

    let validFrameCount = 0;
    let missingRoleCount = 0;

    list.forEach((frame) => {
      const safe = frame && typeof frame === "object" ? frame : {};
      const points = safe.points && typeof safe.points === "object" ? safe.points : {};
      let frameHasAnyData = false;

      SENSOR_ROLES.forEach((role) => {
        const point = points[role];
        if (point && typeof point === "object") {
          const ax = Number(point.ax || 0);
          const ay = Number(point.ay || 0);
          const az = Number(point.az || 0);
          const gx = Number(point.gx || 0);
          const gy = Number(point.gy || 0);
          const gz = Number(point.gz || 0);
          const hasValidData = (
            Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az) &&
            Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz)
          );
          if (hasValidData) {
            frameHasAnyData = true;
            roleHasData[role] = true;
            coverage[role] += 1;
          }
        }
      });

      if (frameHasAnyData) {
        validFrameCount += 1;
      }
    });

    const roleNames = Object.keys(roleHasData);
    missingRoleCount = roleNames.filter((role) => !roleHasData[role]).length;

    const coveragePercent = {};
    roleNames.forEach((role) => {
      coveragePercent[role] = totalFrames > 0 ? Math.round((coverage[role] / totalFrames) * 100) : 0;
    });

    const headCoverage = coveragePercent.head || 0;
    const nonHeadPositive = roleNames.some((role) => role !== "head" && (coveragePercent[role] || 0) > 0);
    const localHint = (headCoverage > 0 && !nonHeadPositive)
      ? "当前设备流仅识别到 head。通常是主机未输出从机聚合数据或协议格式仍未命中。"
      : "";

    const isComplete = totalFrames >= minFrames && missingRoleCount === 0;
    const qualityLevel = (() => {
      if (totalFrames < minFrames) return "帧数不足";
      if (missingRoleCount > 4) return "数据缺失严重";
      if (missingRoleCount > 0) return "部分数据缺失";
      if (headCoverage < 50) return "头部数据不足";
      return "数据完整";
    })();

    return {
      success: true,
      isComplete,
      qualityLevel,
      totalFrames,
      validFrames: validFrameCount,
      minFramesRequired: minFrames,
      missingRoleCount,
      coverage: coveragePercent,
      localHint,
      detail: {
        totalFrames,
        validFrameCount,
        minFrames,
        headCoverage: headCoverage,
        nonHeadPositive,
        missingRoles: roleNames.filter((role) => !roleHasData[role]),
      },
    };
  },

  buildFrameSignature(frames) {
    const list = Array.isArray(frames) ? frames : [];
    if (!list.length) {
      return "0_0_0";
    }
    const firstTs = Number(list[0].t || 0);
    const lastTs = Number(list[list.length - 1].t || 0);
    return `${list.length}_${firstTs}_${lastTs}`;
  },

  buildAnalyzeKey({ sessionId, userId, actionType, frames }) {
    return [
      String(sessionId || "").trim(),
      String(userId || "").trim(),
      String(actionType || "").trim(),
      this.buildFrameSignature(frames),
    ].join("|");
  },

  hasLatestAnalyzeFor({ sessionId, userId, actionType, frames }) {
    const key = this.buildAnalyzeKey({ sessionId, userId, actionType, frames });
    return !!(this.data.lastAnalyzeResult && this._lastAnalyzeKey && this._lastAnalyzeKey === key);
  },

  async runAnalyzeWithFrames({ frames, userId, actionType, sessionId, sourceType, silent = false }) {
    if (!silent) {
      this.setData({
        analyzing: true,
        errorTip: "",
        showCollectionHint: false,
        lastAnalyzeResult: "",
        lastFrameSize: Array.isArray(frames) ? frames.length : 0,
      });
    }
    try {
      const result = await analyzeSensorSession({
        sessionId,
        actionType,
        note: String(this.data.note || "").trim(),
        userId,
        allowSinglePointDebug: this.shouldAllowSinglePointDebug(sourceType),
        debugMode: this.shouldAllowSinglePointDebug(sourceType) ? "single_point" : "",
        frames,
      });
      if (!result || result.success === false) {
        throw new Error(String((result && result.message) || "analyze_failed"));
      }
      const inferenceMode = String(result && result.inferenceMode ? result.inferenceMode : "").trim();
      const modelVersion = String(
        result
        && result.analysis
        && result.analysis.modelVersion
          ? result.analysis.modelVersion
          : ""
      ).trim();
      const apiError = String(result && result.apiError ? result.apiError : "").trim();
      const usingRequiredModel = (
        inferenceMode === REQUIRED_SENSOR_INFERENCE_MODE
        && !apiError
        && !/sensor_rule_v0/i.test(modelVersion)
      );
      if (!usingRequiredModel) {
        throw new Error(
          `analysis_not_from_remote_model | mode=${inferenceMode || "-"}`
          + `${modelVersion ? ` | model=${modelVersion}` : ""}`
          + `${apiError ? ` | apiError=${apiError}` : ""}`
        );
      }
      const coverage = result
        && result.analysis
        && result.analysis.sensorSession
        && result.analysis.sensorSession.coverage
        && typeof result.analysis.sensorSession.coverage === "object"
        ? result.analysis.sensorSession.coverage
        : {};
      const roleNames = Object.keys(coverage);
      const headCoverage = Number(coverage.head || 0);
      const nonHeadPositive = roleNames.some((role) => role !== "head" && Number(coverage[role] || 0) > 0);
      const localHint = (headCoverage > 0 && !nonHeadPositive)
        ? "当前设备流仅识别到 head。通常是主机未输出从机聚合数据或协议格式仍未命中。"
        : "";
      const analysis = result && result.analysis ? result.analysis : {};
      const modelScore = clamp(Math.round(Number(analysis.overallScore || 0)), 0, 100);
      const modelLevel = resolveModelLevelFromAnalysis(analysis, modelScore);
      this._lastFrames = frames;
      this._lastFrameSourceType = String(sourceType || this.getCurrentSourceTypeValue()).trim() || SOURCE_TYPE_MOCK;
      this._lastAnalyzeKey = this.buildAnalyzeKey({
        sessionId,
        userId,
        actionType,
        frames,
      });
      const actionSuggestion = { toast: "分析完成", tip: "先稳重心，再蹬腿发力。注意肩部姿态：摆臂发力时不要伴随转肩动作，避免破坏身体姿态。摆臂过程中请固定肩部姿态，全程不转肩，维持上半身稳定" };
      wx.showToast({
        title: actionSuggestion.toast,
        icon: "none",
        duration: 2000,
      });

      const metrics = Array.isArray(analysis.metrics) ? analysis.metrics : [];
      const phaseScores = Array.isArray(analysis.phaseScores) ? analysis.phaseScores : [];
      const strengths = Array.isArray(analysis.strengths) ? analysis.strengths : [];
      const weaknesses = Array.isArray(analysis.weaknesses) ? analysis.weaknesses : [];
      const trainingPlan = Array.isArray(analysis.trainingPlan) ? analysis.trainingPlan : [];
      const tips = Array.isArray(analysis.tips) ? analysis.tips : [];
      const riskAlerts = Array.isArray(analysis.riskAlerts) ? analysis.riskAlerts : [];
      const sensorSession = analysis.sensorSession && typeof analysis.sensorSession === "object" ? analysis.sensorSession : {};

      this.setData({
        errorTip: "",
        lastAnalyzeResult: JSON.stringify({
          success: true,
          score: modelScore,
          level: modelLevel,
          inferenceMode,
          modelVersion,
          _localHint: localHint,
          _actionSuggestion: actionSuggestion,
        }, null, 2),
        latestAnalyzeScore: modelScore,
        latestAnalyzeLevel: modelLevel,
        latestAnalyzeInferenceMode: inferenceMode,
        latestAnalyzeModelVersion: modelVersion,
        lastFrameSize: frames.length,
        analyzeResultExpanded: true,
        lastAnalyzeAtText: this.formatNowTime(),
        weightShiftTip: actionSuggestion.tip || "",

        analysisMetrics: metrics.map((m) => ({
          key: m.key || "",
          name: m.name || "",
          score: clamp(Math.round(Number(m.score || 0)), 0, 100),
        })),
        analysisPhaseScores: phaseScores.map((p) => ({
          key: p.key || "",
          name: p.name || "",
          score: clamp(Math.round(Number(p.score || 0)), 0, 100),
          comment: p.comment || "",
        })),
        analysisStrengths: strengths.map((s) => ({
          key: s.key || "",
          name: s.name || "",
          score: clamp(Math.round(Number(s.score || 0)), 0, 100),
          note: s.note || "",
        })),
        analysisWeaknesses: weaknesses.map((w) => ({
          key: w.key || "",
          name: w.name || "",
          score: clamp(Math.round(Number(w.score || 0)), 0, 100),
          note: w.note || "",
        })),
        analysisTrainingPlan: trainingPlan.map((plan) => ({
          day: plan.day || "",
          focus: plan.focus || "",
          duration: plan.duration || "",
          tasks: Array.isArray(plan.tasks) ? plan.tasks.map(t => String(t || "")) : [],
        })),
        analysisTips: tips.map(t => String(t || "")),
        analysisRiskAlerts: riskAlerts.map(a => String(a || "")),
        analysisSummary: String(analysis.summary || ""),
        analysisConfidence: clamp(Math.round(Number(analysis.confidence || 0)), 0, 100),

        sensorSessionInfo: {
          predictedAction: String(sensorSession.predictedAction || ""),
          actionConfidence: clamp(Math.round(Number(sensorSession.actionConfidence || 0) * 100), 0, 100),
          qualityScore: clamp(Math.round(Number(sensorSession.qualityScore || 0)), 0, 100),
          qualityLevel: String(sensorSession.qualityLevel || ""),
          coverage: sensorSession.coverage || {},
          frameCount: Number(sensorSession.frameCount || 0),
          durationMs: Number(sensorSession.durationMs || 0),
        },
      });
      this.syncBleDebugInfo();
      return result;
    } catch (error) {
      const message = extractErrorMessage(error) || "analyze_failed";
      this.setData({
        errorTip: `分析失败：${message}`,
        showCollectionHint: false,
      });
      this.syncBleDebugInfo();
      throw error;
    } finally {
      if (!silent) {
        this.setData({ analyzing: false });
      }
    }
  },

  async onTapAnalyze() {
    if (this.data.analyzing || this.data.accessDenied) {
      return;
    }

    const commonCheck = this.validateCommonInput();
    if (!commonCheck.ok) {
      wx.showToast({ title: commonCheck.message, icon: "none" });
      return;
    }

    const sessionId = String(this.data.sessionId || "").trim();
    const userId = this.resolveTargetUserId();
    if (userId !== this.data.userId) {
      this.setData({ userId });
    }
    const actionType = this.getCurrentActionTypeValue();
    const sourceType = this.getCurrentSourceTypeValue();
    this.clearResultShowcaseTimer();
    this.setData({
      analyzing: true,
      errorTip: "",
      showCollectionHint: false,
      lastAnalyzeResult: "",
      latestAnalyzeScore: 0,
      latestAnalyzeLevel: "-",
      latestAnalyzeInferenceMode: "",
      latestAnalyzeModelVersion: "",
      lastFrameSize: 0,
      analyzeResultExpanded: false,
      resultShowcaseVisible: false,
      resultShowcaseDone: false,
      resultShowcaseModelScore: 0,
      resultShowcaseTargetScore: 0,
      resultShowcaseInferenceMode: "",
      resultShowcaseModelVersion: "",
      resultShowcaseApiError: "",
    });
    this.startAnalyzeFlow(sourceType);
    this.appendAnalyzeFlowEvent(
      sourceType === SOURCE_TYPE_REAL_DEVICE
        ? "开始连接设备并采集真实帧数据"
        : "开始生成模拟帧并预热分析",
      "info"
    );
    let analyzeSuccess = false;

    try {
      const frames = await this.buildFramesBySource({
        sourceType,
        sessionId,
        userId,
        actionType,
      });
      this.appendAnalyzeFlowEvent(`采样完成：已获取 ${frames.length} 帧`, "success");

      this.appendAnalyzeFlowEvent("本地验证中：正在检查数据完整性...", "info");
      const localValidation = this.validateFramesLocally(frames);
      const validationText = localValidation.isComplete
        ? `数据完整 | ${localValidation.qualityLevel} | ${localValidation.totalFrames}帧 | 头部覆盖${localValidation.coverage.head || 0}%`
        : `数据异常 | ${localValidation.qualityLevel} | ${localValidation.missingRoleCount}个部位缺失`;
      this.appendAnalyzeFlowEvent(validationText, localValidation.isComplete ? "success" : "error");

      if (!localValidation.isComplete && localValidation.localHint) {
        this.appendAnalyzeFlowEvent(`提示：${localValidation.localHint}`, "info");
      }

      const preAnalyzeProgress = Math.max(66, Number(this.data.analyzeFlowProgress || 0));
      this._analyzeFlowTick += 1;
      this.setData({
        analyzeFlowProgress: preAnalyzeProgress,
        analyzeFlowStatusText: localValidation.isComplete ? "数据验证通过，正在生成报告..." : "数据验证异常，请重新采集...",
        analyzeFlowStages: buildAnalyzeFlowStages(preAnalyzeProgress, false),
        analyzeFlowBars: buildAnalyzeFlowBars(this._analyzeFlowTick),
        analyzeFlowMetrics: buildAnalyzeFlowMetrics(preAnalyzeProgress, this._analyzeFlowTick),
      });

      const analyzeResult = await this.runAnalyzeWithFrames({
        frames,
        userId,
        actionType,
        sessionId,
        sourceType,
        silent: true,
      });
      this._lastFrames = frames;
      this._lastFrameSourceType = sourceType;
      this.setData({ hasCollectedData: true, lastFrameSize: frames.length });
      if (this.data.bigScreenEnabled) {
        this.playShowcase(this.buildShowcaseSummary(analyzeResult));
      }
      const inferenceMode = String(analyzeResult && analyzeResult.inferenceMode ? analyzeResult.inferenceMode : "").trim();
      const modelVersion = String(
        analyzeResult
        && analyzeResult.analysis
        && analyzeResult.analysis.modelVersion
          ? analyzeResult.analysis.modelVersion
          : ""
      ).trim();
      const apiError = String(analyzeResult && analyzeResult.apiError ? analyzeResult.apiError : "").trim();
      if (inferenceMode) {
        this.appendAnalyzeFlowEvent(
          `模型通道：${inferenceMode}${modelVersion ? ` | ${modelVersion}` : ""}`,
          inferenceMode === "sensor_api_v1" ? "success" : "info"
        );
      }
      if (apiError) {
        this.appendAnalyzeFlowEvent(`远程错误：${apiError}`, "error");
      }
      this.pushAnalyzeNumberStream("report:done 已生成学员可视化报告", "success");
      this.appendAnalyzeFlowEvent("分析完成：结果与建议已就绪", "success");
      analyzeSuccess = true;
      wx.showToast({
        title: "分析完成",
        icon: "success",
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      let reason = mapAnalyzeFailReason(message);
      if (sourceType === SOURCE_TYPE_REAL_DEVICE && reason === "未知错误") {
        reason = "未连接传感器或蓝牙权限未开启";
      }
      this.appendAnalyzeFlowEvent(`分析失败：${reason}`, "error");
      this.pushAnalyzeNumberStream(`report:error ${reason}`, "error");
      const bleSummary = sourceType === SOURCE_TYPE_REAL_DEVICE
        ? this.formatBleDebugSummary()
        : "";
      this.setData({
        errorTip: `分析失败：${reason}${message ? ` (${message})` : ""}${bleSummary ? `\n${bleSummary}` : ""}`,
        showCollectionHint: isCollectionMissingError(message),
      });
      wx.showToast({
        title: "分析失败",
        icon: "none",
      });
    } finally {
      this.finishAnalyzeFlow(analyzeSuccess);
      this.setData({ analyzing: false });
    }
  },

  async onTapSaveSample() {
    if (this.data.saving || this.data.accessDenied) {
      return;
    }

    if (!this.data.canSaveTrainingSample) {
      wx.showToast({ title: "权限不足", icon: "none" });
      return;
    }

    const saveCheck = this.validateSaveInput();
    if (!saveCheck.ok) {
      wx.showToast({ title: saveCheck.message, icon: "none" });
      return;
    }

    const sessionId = String(this.data.sessionId || "").trim();
    const userId = this.resolveTargetUserId();
    if (userId !== this.data.userId) {
      this.setData({ userId });
    }
    const actionType = this.getCurrentActionTypeValue();
    const sourceType = this.getCurrentSourceTypeValue();
    const tags = splitTags(this.data.tagsText);

    this.setData({
      saving: true,
      errorTip: "",
      showCollectionHint: false,
      lastSaveResult: "",
      lastFrameSize: 0,
    });

    try {
      const cachedFrames = this.getCachedFramesForSource(sourceType);
      const frames = cachedFrames || (
        sourceType === SOURCE_TYPE_MOCK
          ? this.buildMockFrames()
          : await this.buildFramesBySource({
            sourceType,
            sessionId,
            userId,
            actionType,
          })
      );
      this._lastFrames = frames;
      this._lastFrameSourceType = sourceType;
      this.setData({
        lastFrameSize: frames.length,
      });

      const shouldPreAnalyzeBeforeSave = (
        sourceType === SOURCE_TYPE_REAL_DEVICE
        && !this.hasLatestAnalyzeFor({ sessionId, userId, actionType, frames })
      );
      let preAnalyzeWarning = "";
      if (shouldPreAnalyzeBeforeSave) {
        wx.showLoading({
          title: "正在分析...",
          mask: true,
        });
        try {
          await this.runAnalyzeWithFrames({
            frames,
            userId,
            actionType,
            sessionId,
            sourceType,
            silent: true,
          });
        } catch (analyzeError) {
          preAnalyzeWarning = extractErrorMessage(analyzeError) || "analyze_failed_before_save";
        } finally {
          wx.hideLoading();
        }
      }
      if (preAnalyzeWarning) {
        console.warn(`分析警告：${preAnalyzeWarning}`);
      }

      const result = await saveSensorTrainingSample({
        sessionId,
        actionType,
        sourceType,
        note: String(this.data.note || "").trim(),
        userId,
        operatorUserId: String(this.data.operatorUserId || this.getCurrentUserId() || "").trim(),
        allowSinglePointDebug: this.shouldAllowSinglePointDebug(sourceType),
        debugMode: this.shouldAllowSinglePointDebug(sourceType) ? "single_point" : "",
        label: {
          coachScore: clamp(this.data.coachScore, 0, 100),
          qualityTag: this.getSelectedQualityTag(),
          coachComment: String(this.data.coachComment || "").trim(),
          tags,
          selectedSuggestions: [1,2,3,4,5,6,7,8].filter(n => this.data["suggestion" + n]),
        },
        frames,
        calibrationProfiles: this._calibrationProfiles,
      });
      if (!result || result.success === false) {
        const detailParts = [];
        const missingRoles = result && Array.isArray(result.missingRoles) ? result.missingRoles : [];
        if (missingRoles.length) {
          detailParts.push(`missingRoles=${missingRoles.join(",")}`);
        }
        const frameRoleSummary = result && result.frameRoleSummary && typeof result.frameRoleSummary === "object"
          ? result.frameRoleSummary
          : null;
        const activeRoles = frameRoleSummary && Array.isArray(frameRoleSummary.activeRoles)
          ? frameRoleSummary.activeRoles.filter(Boolean)
          : [];
        if (activeRoles.length) {
          detailParts.push(`activeRoles=${activeRoles.join(",")}`);
        }
        if (result && result.apiError) {
          detailParts.push(`apiError=${result.apiError}`);
        }
        if (result && result.errorCode) {
          detailParts.push(`errorCode=${result.errorCode}`);
        }
        if (result && result.errorName) {
          detailParts.push(`errorName=${result.errorName}`);
        }
        const baseMessage = String((result && result.message) || "save_sample_failed");
        throw new Error(detailParts.length ? `${baseMessage} | ${detailParts.join("; ")}` : baseMessage);
      }
      const saveSummary = {
        success: true,
        sampleId: String(result.sampleId || "").trim(),
        score: Number(this.data.latestAnalyzeScore || 0),
        level: String(this.data.latestAnalyzeLevel || "-"),
        inferenceMode: String(result.inferenceMode || this.data.latestAnalyzeInferenceMode || "").trim(),
        modelVersion: String(result.modelVersion || this.data.latestAnalyzeModelVersion || "").trim(),
      };
      this.setData({
        lastSaveResult: JSON.stringify(saveSummary, null, 2),
        saveResultExpanded: true,
        lastSaveAtText: this.formatNowTime(),
      });
      wx.showToast({
        title: "保存成功",
        icon: "success",
      });
    } catch (error) {
      const message = extractErrorMessage(error) || "save_sample_failed";
      let reason = mapAnalyzeFailReason(message);
      if (reason === "未知错误") {
        reason = "保存样本失败";
      }
      const bleSummary = sourceType === SOURCE_TYPE_REAL_DEVICE
        ? this.formatBleDebugSummary()
        : "";
      const lower = String(message || "").toLowerCase();
      if (lower.includes("permission_denied") || lower.includes("operator_user_not_found")) {
        this.setData({ canSaveTrainingSample: false });
      }
      this.setData({
        errorTip: `保存失败：${reason}${message ? ` (${message})` : ""}${bleSummary ? `\n${bleSummary}` : ""}`,
        showCollectionHint: isCollectionMissingError(message),
      });
      wx.showToast({
        title: "保存失败",
        icon: "none",
      });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async onTapCollectData() {
    if (this.data.collecting || this.data.accessDenied) {
      return;
    }

    const sessionIdOptions = this.data.sessionIdOptions || [];
    const sessionIdIndex = Number(this.data.sessionIdIndex) || 0;
    const sessionId = sessionIdOptions[sessionIdIndex] ? String(sessionIdOptions[sessionIdIndex].value).trim() : "1";
    const userId = this.resolveTargetUserId();
    if (userId !== this.data.userId) {
      this.setData({ userId });
    }
    const actionType = this.getCurrentActionTypeValue();
    const sourceType = this.getCurrentSourceTypeValue();

    this.setData({
      collecting: true,
      errorTip: "",
      showCollectionHint: false,
      hasCollectedData: false,
    });

    try {
      const frames = await this.buildFramesBySource({
        sourceType,
        sessionId,
        userId,
        actionType,
      });
      this._lastFrames = frames;
      this._lastFrameSourceType = sourceType;
      this.setData({
        lastFrameSize: frames.length,
        hasCollectedData: true,
      });

      wx.showToast({
        title: "采集成功，请点分析动作",
        icon: "none",
        duration: 3000,
      });
      this.setData({
        latestAnalyzeScore: "",
        latestAnalyzeLevel: "",
        weightShiftTip: "",
        lastAnalyzeAtText: "",
        voicePlaying: false,
      });
    } catch (error) {
      const message = extractErrorMessage(error) || "collect_failed";
      let reason = mapAnalyzeFailReason(message);
      if (reason === "未知错误") {
        reason = "采集数据失败";
      }
      const bleSummary = sourceType === SOURCE_TYPE_REAL_DEVICE
        ? this.formatBleDebugSummary()
        : "";
      this.setData({
        errorTip: `采集失败：${reason}${message ? ` (${message})` : ""}${bleSummary ? `\n${bleSummary}` : ""}`,
        showCollectionHint: isCollectionMissingError(message),
      });
      wx.showToast({
        title: "采集失败",
        icon: "none",
      });
    } finally {
      this.setData({ collecting: false });
    }
  },

  async onTapSaveCollectedData() {
    if (this.data.saving || this.data.accessDenied || !this.data.hasCollectedData) {
      return;
    }

    if (!this.data.canSaveTrainingSample) {
      wx.showToast({ title: "权限不足", icon: "none" });
      return;
    }

    const saveCheck = this.validateSaveInput();
    if (!saveCheck.ok) {
      wx.showToast({ title: saveCheck.message, icon: "none" });
      return;
    }

    const sessionIdOptions = this.data.sessionIdOptions || [];
    const sessionIdIndex = Number(this.data.sessionIdIndex) || 0;
    const sessionId = sessionIdOptions[sessionIdIndex] ? String(sessionIdOptions[sessionIdIndex].value).trim() : "1";
    const userId = this.resolveTargetUserId();
    const actionType = this.getCurrentActionTypeValue();
    const sourceType = this._lastFrameSourceType || this.getCurrentSourceTypeValue();
    const frames = this._lastFrames || [];
    const tags = splitTags(this.data.tagsText);

    if (!frames.length) {
      wx.showToast({ title: "没有采集到数据", icon: "none" });
      return;
    }

    this.setData({
      saving: true,
      errorTip: "",
      showCollectionHint: false,
      lastSaveResult: "",
    });

    wx.showLoading({
      title: "保存中...",
      mask: true,
    });

    try {
      const result = await saveSensorTrainingSample({
        sessionId,
        actionType,
        sourceType,
        note: String(this.data.note || "").trim(),
        userId,
        operatorUserId: String(this.data.operatorUserId || this.getCurrentUserId() || "").trim(),
        allowSinglePointDebug: this.shouldAllowSinglePointDebug(sourceType),
        debugMode: this.shouldAllowSinglePointDebug(sourceType) ? "single_point" : "",
        label: {
          coachScore: clamp(this.data.coachScore, 0, 100),
          qualityTag: this.getSelectedQualityTag(),
          coachComment: String(this.data.coachComment || "").trim(),
          tags,
          selectedSuggestions: [1,2,3,4,5,6,7,8].filter(n => this.data["suggestion" + n]),
        },
        frames,
        calibrationProfiles: this._calibrationProfiles,
      });

      if (!result || result.success === false) {
        const detailParts = [];
        const missingRoles = result && Array.isArray(result.missingRoles) ? result.missingRoles : [];
        if (missingRoles.length) {
          detailParts.push(`missingRoles=${missingRoles.join(",")}`);
        }
        if (result && result.apiError) {
          detailParts.push(`apiError=${result.apiError}`);
        }
        const baseMessage = String((result && result.message) || "save_sample_failed");
        throw new Error(detailParts.length ? `${baseMessage} | ${detailParts.join("; ")}` : baseMessage);
      }

      const saveSummary = {
        success: true,
        sampleId: String(result.sampleId || "").trim(),
        frameCount: frames.length,
        coachScore: result.coachScore !== undefined ? Number(result.coachScore) : clamp(this.data.coachScore, 0, 100),
        qualityTag: String(result.qualityTag || this.data.qualityTag || "").trim(),
      };
      this.setData({
        lastSaveResult: JSON.stringify(saveSummary, null, 2),
        saveResultExpanded: true,
        lastSaveAtText: this.formatNowTime(),
        hasCollectedData: false,
      });
      wx.showToast({
        title: "保存成功",
        icon: "success",
      });
    } catch (error) {
      const message = extractErrorMessage(error) || "save_sample_failed";
      let reason = mapAnalyzeFailReason(message);
      if (reason === "未知错误") {
        reason = "保存样本失败";
      }
      const bleSummary = sourceType === SOURCE_TYPE_REAL_DEVICE
        ? this.formatBleDebugSummary()
        : "";
      const lower = String(message || "").toLowerCase();
      if (lower.includes("permission_denied") || lower.includes("operator_user_not_found")) {
        this.setData({ canSaveTrainingSample: false });
      }
      this.setData({
        errorTip: `保存失败：${reason}${message ? ` (${message})` : ""}${bleSummary ? `\n${bleSummary}` : ""}`,
        showCollectionHint: isCollectionMissingError(message),
      });
      wx.showToast({
        title: "保存失败",
        icon: "none",
      });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  onTapToggleRole(e) {
    const role = e.currentTarget.dataset.role;
    if (!role) return;
    const roleOptions = this.data.roleOptions.map((item) => {
      if (item.name === role) return { name: item.name, selected: !item.selected };
      return item;
    });
    const selectedRoles = roleOptions.filter((item) => item.selected).map((item) => item.name);
    if (!selectedRoles.length) {
      wx.showToast({ title: "至少选择1个节点", icon: "none" });
      return;
    }
    this.setData({ roleOptions, selectedRoles });
  },

  async clearCalibrationForNewSession() {
    const appCfg = require("../../../../config");
    const apiBase = (appCfg.wifi && appCfg.wifi.apiBaseUrl) || "http://10.141.103.23:18080";
    const roles = ["waist", "left_knee", "right_knee", "left_foot", "right_foot"];
    try {
      await new Promise((resolve, reject) => {
        wx.request({
          url: `${apiBase}/calibration/gyro/clear`,
          method: "POST",
          header: { "Content-Type": "application/json" },
          data: { roles, request_id: `clear_${Date.now()}` },
          timeout: 10000,
          success: () => resolve(undefined),
          fail: (e) => reject(e),
        });
      });
      this._calibrationProfiles = {};
      this.setData({ calibrationStatusText: "新采集会话已建立，旧的临时offset已清除" });
    } catch (error) {
      this.setData({ calibrationStatusText: "新会话清除命令未确认，请检测WiFi设备后再执行主动校准" });
    }
  },

  getSelectedSensorRoles() {
    return this.data.selectedRoles;
  },

  async onTapCalibrateSelectedNodes() {
    if (this.data.calibrationRunning || this.data.collecting) return;
    const roles = this.getSelectedSensorRoles();
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "主动零偏校准",
        content: `即将校准已选的${roles.length}个节点。请固定设备并保持静止，点击确定后3秒开始。`,
        success: (result) => resolve(Boolean(result.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({
      calibrationRunning: true,
      calibrationStatusText: "准备校准，请保持静止：3秒",
      hasCollectedData: false,
    });

    try {
      for (let seconds = 3; seconds > 0; seconds -= 1) {
        this.setData({ calibrationStatusText: `准备校准，请保持静止：${seconds}秒` });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const appCfg = require("../../../../config");
      const apiBase = (appCfg.wifi && appCfg.wifi.apiBaseUrl) || "http://10.141.103.23:18080";
      const response = await new Promise((resolve, reject) => {
        wx.request({
          url: `${apiBase}/calibration/gyro`,
          method: "POST",
          header: { "Content-Type": "application/json" },
          data: { roles, request_id: `cal_${Date.now()}` },
          timeout: 10000,
          success: (r) => resolve(r.data || {}),
          fail: (e) => reject(e),
        });
      });

      const dispatched = Array.isArray(response.dispatched_roles) ? response.dispatched_roles : [];
      const unsupported = Array.isArray(response.unsupported_roles) ? response.unsupported_roles : [];
      if (!dispatched.length) {
        throw new Error("未向任何节点发送校准命令");
      }

      this.setData({ calibrationStatusText: `校准中：${dispatched.join(", ")}` });

      const roleAlias = { left_foot: "left_ankle", right_foot: "right_ankle" };
      const statuses = {};
      const calibrationProfiles = {};

      // 固件校准需要约4秒（3秒静止检测 + 计算），先等5秒再轮询
      await new Promise((resolve) => setTimeout(resolve, 5000));

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const framesResponse = await new Promise((resolve, reject) => {
          wx.request({
            url: `${apiBase}/frames`,
            method: "POST",
            header: { "Content-Type": "application/json" },
            data: {
              frameCount: 600,
              sampleIntervalMs: 20,
              roles: dispatched,
            },
            timeout: 10000,
            success: (r) => resolve(r.data || {}),
            fail: (e) => reject(e),
          });
        });
        const frames = (framesResponse && Array.isArray(framesResponse.frames)) ? framesResponse.frames : [];
        frames.forEach((frame) => {
          const points = (frame && frame.points && typeof frame.points === "object") ? frame.points : {};
          const calibration = (frame && frame.calibration && typeof frame.calibration === "object") ? frame.calibration : null;
          if (!calibration) return;
          dispatched.forEach((role) => {
            const pointRole = roleAlias[role] || role;
            if (points[pointRole]) {
              statuses[role] = String(calibration.status || "unknown");
              const deviceOffset = Array.isArray(calibration.gyro_offset)
                ? calibration.gyro_offset.slice(0, 3).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0))
                : [0, 0, 0];
              calibrationProfiles[role] = {
                node_id: role,
                sample_rate_hz: 50,
                calibration_mode: "firmware_calibrated",
                acc_bias: [0, 0, 0],
                gyro_bias: [0, 0, 0],
                temperature_compensation_enabled: false,
                reference_temperature_c: Number(calibration.temperature_c || 0),
                metadata: {
                  calibration_status: String(calibration.status || "unknown"),
                  device_applied_gyro_offset: deviceOffset,
                  gyro_std_max: Number(calibration.gyro_std_max || 0),
                  acc_norm_mean: Number(calibration.acc_norm_mean || 0),
                  acc_norm_std: Number(calibration.acc_norm_std || 0),
                  sample_count: Number(calibration.sample_count || 0),
                },
              };
            }
          });
        });
        if (dispatched.every((role) => statuses[role] === "ready")) {
          break;
        }
      }

      const ready = dispatched.filter((role) => statuses[role] === "ready");
      const failed = dispatched.filter((role) => statuses[role] !== "ready");
      ready.forEach((role) => {
        if (calibrationProfiles[role]) {
          this._calibrationProfiles[role] = calibrationProfiles[role];
        }
      });

      this.setData({
        calibrationStatusText:
          `校准成功：${ready.join(", ") || "无"}` +
          (failed.length ? `；失败/未确认：${failed.join(", ")}` : "") +
          (unsupported.length ? `；不支持：${unsupported.join(", ")}` : ""),
      });
      wx.showToast({
        title: failed.length ? "部分节点校准失败" : "主动校准成功",
        icon: failed.length ? "none" : "success",
      });
    } catch (error) {
      const message = (error && error.message) || "calibration_failed";
      this.setData({ calibrationStatusText: `主动校准失败：${message}` });
      wx.showToast({ title: "主动校准失败", icon: "none" });
    } finally {
      this.setData({ calibrationRunning: false });
    }
  },

  // ── 校准已选节点（兼容旧按钮绑定） ──
  async onTapCalibrate() {
    return this.onTapCalibrateSelectedNodes();
  },
});
