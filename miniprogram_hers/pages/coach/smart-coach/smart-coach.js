const { collectRealDeviceFrames } = require("../../../utils/device-sensor-adapter");
const { analyzeSensorSession } = require("../../../utils/sensor-model");

const ACTION_TYPE_OPTIONS = [
  { label: "重心转移", value: "weight_shift" },
  { label: "基础滑行", value: "basic_skating" },
  { label: "刹停动作", value: "braking" },
  { label: "侧蹬收腿", value: "side_push_recover" },
];

Page({
  data: {
    wifiHost: "",
    wifiPort: "8080",
    wifiConnected: false,
    wifiTesting: false,
    wifiStatusText: "未连接",

    actionTypeIndex: 0,
    actionTypeOptions: ACTION_TYPE_OPTIONS,

    analyzing: false,
    hasResult: false,
    collectedFrames: 0,

    qualityScore: 0,
    qualityLevel: "",
    qualityLevelClass: "",
    confidence: 0,
    actionName: "",
    advice: "",
    durationSeconds: 0,
    validNodes: 0,
    frameCount: 0,
    errorTip: "",
  },

  onLoad() {
    const app = getApp();
    const host = app && app.globalData && app.globalData.wifiHost;
    const port = app && app.globalData && app.globalData.wifiPort;
    if (host) this.setData({ wifiHost: host });
    if (port) this.setData({ wifiPort: port });
  },

  onWifiHostInput(e) { this.setData({ wifiHost: e.detail.value }); },
  onWifiPortInput(e) { this.setData({ wifiPort: e.detail.value }); },
  onChangeActionType(e) { this.setData({ actionTypeIndex: e.detail.value }); },

  async onTapWifiConnect() {
    if (this.data.wifiConnected) {
      this.setData({ wifiConnected: false, wifiStatusText: "未连接" });
      return;
    }
    const host = String(this.data.wifiHost || "").trim();
    if (!host) { wx.showToast({ title: "请输入设备地址", icon: "none" }); return; }

    this.setData({ wifiTesting: true, wifiStatusText: "连接中..." });
    try {
      const sdk = this.resolveDeviceSdk();
      if (sdk) {
        await sdk.connect();
      }
      this.setData({ wifiConnected: true, wifiStatusText: "已连接" });
      wx.showToast({ title: "WiFi连接成功", icon: "success" });
    } catch (e) {
      this.setData({ wifiConnected: false, wifiStatusText: "连接失败" });
      wx.showToast({ title: "连接失败", icon: "none" });
    } finally {
      this.setData({ wifiTesting: false });
    }
  },

  resolveDeviceSdk() {
    try {
      const app = getApp();
      if (app && app.globalData && app.globalData.deviceSdk) {
        return app.globalData.deviceSdk;
      }
    } catch (e) {}
    return null;
  },

  async onTapStartAnalysis() {
    if (this.data.analyzing) return;

    this.setData({
      analyzing: true,
      hasResult: false,
      errorTip: "",
      qualityScore: 0,
      qualityLevel: "",
    });

    const actionType = ACTION_TYPE_OPTIONS[this.data.actionTypeIndex].value;
    const sessionId = `realtime_${Date.now()}`;
    const userId = this.getCurrentUserId();

    try {
      wx.showLoading({ title: "正在采集数据...", mask: true });

      // Collect frames via WiFi
      const frames = await collectRealDeviceFrames({
        sessionId,
        userId,
        actionType,
        frameCount: 350,
        sampleIntervalMs: 20,
        timeoutMs: 30000,
        roles: ["waist", "left_knee", "right_knee", "left_foot", "right_foot"],
        note: "smart_coach_realtime",
      });

      if (!frames || frames.length < 30) {
        throw new Error(`帧数不足：${frames ? frames.length : 0}`);
      }

      wx.hideLoading();
      wx.showLoading({ title: "AI分析中...", mask: true });

      // Run inference via cloud function
      const result = await analyzeSensorSession({
        sessionId,
        actionType,
        userId,
        frames,
        note: "smart_coach_realtime",
      });

      wx.hideLoading();

      if (!result || result.success === false) {
        throw new Error(String(result && result.message ? result.message : "分析失败"));
      }

      // Parse result
      const analysis = result.analysis || {};
      const sensorSession = analysis.sensorSession || {};
      const coachFeedback = result.coach_feedback || {};
      const prediction = result.prediction || {};

      const score = result.quality_score || analysis.overallScore || 0;
      const level = result.quality_level || sensorSession.qualityLevel || "";
      const conf = prediction.confidence || sensorSession.actionConfidence || 0;
      const actionName = prediction.label_name || sensorSession.predictedAction || actionType;
      const adviceText = coachFeedback.summary || analysis.summary || "";

      const levelClassMap = { "优秀": "excellent", "良好": "good", "中等": "mid", "一般": "mid", "不合格": "fail" };
      const levelClass = levelClassMap[level] || "good";

      this.setData({
        hasResult: true,
        qualityScore: Math.round(score),
        qualityLevel: level,
        qualityLevelClass: levelClass,
        confidence: Math.round(conf * 100),
        actionName,
        advice: adviceText,
        frameCount: frames.length,
        durationSeconds: ((frames.length * 20) / 1000).toFixed(1),
        validNodes: 5,
        collectedFrames: frames.length,
        errorTip: "",
      });
    } catch (error) {
      wx.hideLoading();
      this.setData({ errorTip: `分析失败：${error.message || error}` });
      wx.showToast({ title: "分析失败", icon: "none" });
    } finally {
      this.setData({ analyzing: false });
    }
  },

  getCurrentUserId() {
    try {
      const userInfo = wx.getStorageSync("userInfo") || {};
      return String(userInfo.id || userInfo._id || "").trim();
    } catch (e) { return ""; }
  },
});
