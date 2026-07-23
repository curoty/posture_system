const SNAPSHOT_STORAGE_KEY = "SENSOR_BIG_SCREEN_SNAPSHOT";
const { FEATURE_GATES } = require("../../../../utils/feature-gates");
const SENSOR_COMPONENT_LOCK_MESSAGE = FEATURE_GATES.sensorComponentLockMessage || "传感器组件功能维护中，暂未开放";
const SENSOR_BIG_SCREEN_LOCK_MESSAGE = FEATURE_GATES.sensorBigScreenLockMessage || "大屏展示功能维护中，暂未开放";

const toSafeArray = (value) => (Array.isArray(value) ? value : []);

Page({
  data: {
    hasSnapshot: false,
    emptyTip: "暂无可展示数据，请先在调试页执行分析。",
    capturedAtText: "-",
    sessionId: "",
    actionTypeLabel: "",
    sourceTypeLabel: "",
    frameCount: 0,
    sampleIntervalMs: 0,
    analyzeFlowVisible: false,
    analyzeFlowDone: false,
    analyzeFlowProgress: 0,
    analyzeFlowElapsedSec: 0,
    analyzeFlowStatusText: "等待执行分析",
    analyzeFlowStages: [],
    analyzeFlowBars: [],
    analyzeFlowMetrics: [],
    analyzeFlowEvents: [],
    analyzeNumberStream: [],
    resultShowcaseVisible: false,
    resultShowcaseDone: false,
    resultShowcaseActionLabel: "",
    resultShowcaseSummary: "",
    resultShowcaseModelScore: 0,
    resultShowcaseCoachScore: 0,
    resultShowcaseConfidence: 0,
    resultShowcaseQualityTag: "",
    resultShowcaseCoachComment: "",
    resultShowcaseStrengths: [],
    resultShowcaseImprovements: [],
    resultShowcaseTips: [],
    resultShowcaseTags: "",
    errorTip: "",
  },

  onLoad() {
    this._refreshTimer = null;
    this._lastCapturedAt = 0;
    if (!this.ensureSensorComponentEnabled()) {
      return;
    }
    if (!this.ensureBigScreenEnabled()) {
      return;
    }
    this.pullSnapshot(true);
  },

  onShow() {
    if (!FEATURE_GATES.sensorComponentEnabled || FEATURE_GATES.sensorBigScreenEnabled === false) {
      return;
    }
    this.startRefreshLoop();
  },

  onHide() {
    this.clearRefreshLoop();
  },

  onUnload() {
    this.clearRefreshLoop();
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

  ensureBigScreenEnabled() {
    if (FEATURE_GATES.sensorBigScreenEnabled !== false) {
      return true;
    }
    wx.showModal({
      title: "功能维护中",
      content: SENSOR_BIG_SCREEN_LOCK_MESSAGE,
      showCancel: false,
      success: () => {
        wx.redirectTo({
          url: "/pages/coach/sensor/debug/debug",
          fail: () => {
            wx.reLaunch({ url: "/pages/coach/index/index" });
          },
        });
      },
    });
    return false;
  },

  clearRefreshLoop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  },

  startRefreshLoop() {
    this.clearRefreshLoop();
    this._refreshTimer = setInterval(() => {
      this.pullSnapshot(false);
    }, 320);
  },

  formatTime(timestamp) {
    const ts = Number(timestamp || 0);
    if (!Number.isFinite(ts) || ts <= 0) {
      return "-";
    }
    const date = new Date(ts);
    const pad = (num) => String(num).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },

  pullSnapshot(force) {
    let snapshot = null;
    try {
      snapshot = wx.getStorageSync(SNAPSHOT_STORAGE_KEY) || null;
    } catch (error) {
      snapshot = null;
    }
    const safe = snapshot && typeof snapshot === "object" ? snapshot : null;
    const hasAnyData = !!(
      safe
      && (
        safe.analyzeFlowVisible
        || safe.resultShowcaseVisible
        || String(safe.sessionId || "").trim()
        || String(safe.errorTip || "").trim()
      )
    );
    if (!hasAnyData) {
      this._lastCapturedAt = 0;
      this.setData({
        hasSnapshot: false,
      });
      return;
    }

    const capturedAt = Number(safe.capturedAt || 0);
    if (!force && capturedAt && capturedAt === this._lastCapturedAt) {
      return;
    }
    this._lastCapturedAt = capturedAt;
    this.setData({
      hasSnapshot: true,
      capturedAtText: this.formatTime(capturedAt),
      sessionId: String(safe.sessionId || "").trim(),
      actionTypeLabel: String(safe.actionTypeLabel || "").trim(),
      sourceTypeLabel: String(safe.sourceTypeLabel || "").trim(),
      frameCount: Number(safe.frameCount || 0),
      sampleIntervalMs: Number(safe.sampleIntervalMs || 0),
      analyzeFlowVisible: !!safe.analyzeFlowVisible,
      analyzeFlowDone: !!safe.analyzeFlowDone,
      analyzeFlowProgress: Number(safe.analyzeFlowProgress || 0),
      analyzeFlowElapsedSec: Number(safe.analyzeFlowElapsedSec || 0),
      analyzeFlowStatusText: String(safe.analyzeFlowStatusText || "等待执行分析").trim(),
      analyzeFlowStages: toSafeArray(safe.analyzeFlowStages),
      analyzeFlowBars: toSafeArray(safe.analyzeFlowBars),
      analyzeFlowMetrics: toSafeArray(safe.analyzeFlowMetrics),
      analyzeFlowEvents: toSafeArray(safe.analyzeFlowEvents),
      analyzeNumberStream: toSafeArray(safe.analyzeNumberStream),
      resultShowcaseVisible: !!safe.resultShowcaseVisible,
      resultShowcaseDone: !!safe.resultShowcaseDone,
      resultShowcaseActionLabel: String(safe.resultShowcaseActionLabel || "").trim(),
      resultShowcaseSummary: String(safe.resultShowcaseSummary || "").trim(),
      resultShowcaseModelScore: Number(safe.resultShowcaseModelScore || 0),
      resultShowcaseCoachScore: Number(safe.resultShowcaseCoachScore || 0),
      resultShowcaseConfidence: Number(safe.resultShowcaseConfidence || 0),
      resultShowcaseQualityTag: String(safe.resultShowcaseQualityTag || "").trim(),
      resultShowcaseCoachComment: String(safe.resultShowcaseCoachComment || "").trim(),
      resultShowcaseStrengths: toSafeArray(safe.resultShowcaseStrengths),
      resultShowcaseImprovements: toSafeArray(safe.resultShowcaseImprovements),
      resultShowcaseTips: toSafeArray(safe.resultShowcaseTips),
      resultShowcaseTags: String(safe.resultShowcaseTags || "").trim(),
      errorTip: String(safe.errorTip || "").trim(),
    });
  },

  onTapRefresh() {
    this.pullSnapshot(true);
    wx.showToast({
      title: "已刷新",
      icon: "none",
    });
  },

  onTapBack() {
    if (!FEATURE_GATES.sensorComponentEnabled || FEATURE_GATES.sensorBigScreenEnabled === false) {
      wx.reLaunch({
        url: "/pages/coach/index/index",
      });
      return;
    }
    if (getCurrentPages().length > 1) {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          wx.reLaunch({
            url: "/pages/coach/index/index",
          });
        },
      });
      return;
    }
    wx.reLaunch({
      url: "/pages/coach/sensor/debug/debug",
    });
  },
});
