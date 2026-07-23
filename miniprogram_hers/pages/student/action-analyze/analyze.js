const {
  collectRealDeviceFrames,
  probeRealDeviceConnection,
} = require("../../../utils/device-sensor-adapter");
const { callRemotePredict } = require("../../../utils/remote-predict");

const WIFI_CONNECT_TIMEOUT_MS = 35000;
const MAX_FRAME_COUNT = 180;
const COLLECT_TIMEOUT_MS = 45000;
const SENSOR_ROLES = [
  "head",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_knee",
  "right_knee",
  "left_foot",
  "right_foot",
];

Page({
  data: {
    connectionStatus: 'disconnected',
    deviceName: '',
    isCollecting: false,
    collectedFrames: 0,

    analyzing: false,
    saving: false,

    resultVisible: false,
    score: 0,
    scoreColor: "mid",
    quality: "-",
    qualityClass: "mid",
    confidence: 0,
    comment: "",

    errorMsg: "",
    voicePlaying: false,
    logs: [],
  },

  _lastFrames: null,
  _innerAudioCtx: null,

  addLog(text) {
    const time = new Date().toLocaleTimeString();
    const logs = this.data.logs.slice(-14);
    logs.push(`[${time}] ${text}`);
    this.setData({ logs });
  },

  async onUnload() {
    if (this._innerAudioCtx) {
      this._innerAudioCtx.destroy();
      this._innerAudioCtx = null;
    }
  },

  async onTapConnect() {
    if (this.data.connectionStatus === "connecting") return;

    this.setData({ connectionStatus: "connecting", errorMsg: "" });
    this.addLog("开始连接主板 WiFi...");

    try {
      await this.withTimeout(
        probeRealDeviceConnection(),
        WIFI_CONNECT_TIMEOUT_MS
      );
      this.setData({
        connectionStatus: "connected",
        deviceName: "主板 WiFi",
      });
      this.addLog("WiFi 连接成功");
      wx.showToast({ title: "连接成功", icon: "success" });
    } catch (error) {
      const message = this.extractError(error) || "请确认主板、电源和网络服务正常";
      this.setData({
        connectionStatus: "disconnected",
        errorMsg: `WiFi 设备连接失败：${message}`,
      });
      this.addLog(`WiFi 连接失败: ${message}`);
    }
  },

  async onTapToggleCollect() {
    if (this.data.connectionStatus !== 'connected') {
      wx.showToast({ title: '请先连接主板 WiFi', icon: 'none' });
      return;
    }

    if (this.data.isCollecting) {
      await this.stopCollecting();
    } else {
      await this.startCollecting();
    }
  },

  async startCollecting() {
    this.setData({
      isCollecting: true,
      collectedFrames: 0,
      resultVisible: false,
      errorMsg: ''
    });
    this._lastFrames = null;
    this.addLog('开始采集...');

    try {
      const frames = await collectRealDeviceFrames({
        sessionId: `auto_${Date.now()}`,
        userId: this.getCurrentUserId(),
        actionType: "skating_action",
        note: "",
        frameCount: MAX_FRAME_COUNT,
        sampleIntervalMs: 50,
        timeoutMs: COLLECT_TIMEOUT_MS,
        roles: SENSOR_ROLES,
        onProgress: (progress) => {
          if (!this.data.isCollecting) return;
          const count = Number(progress.collectedCount || progress.collected || 0);
          this.setData({ collectedFrames: count });
        },
      });

      this._lastFrames = frames;
      this.setData({ isCollecting: false });
      this.addLog(`采集完成: ${frames.length} 帧`);

      if (!Array.isArray(frames) || frames.length === 0) {
        this.setData({
          errorMsg: "未采集到有效数据，请确认传感器已佩戴后重试",
        });
        return;
      }

      this.setData({ analyzing: true });
      this.addLog('开始 AI 分析...');
      wx.showLoading({ title: "AI分析中...", mask: true });

      await this.runAnalyze();
    } catch (error) {
      const msg = this.extractError(error);
      this.setData({
        isCollecting: false,
        errorMsg: `采集失败：${msg || "请确认设备正常后重试"}`,
      });
      this.addLog(`采集失败: ${msg}`);
    }
  },

  async stopCollecting() {
    this.setData({ isCollecting: false });
    this.addLog('已停止采集');
  },

  async onTapRelease() {
    this.setData({
      connectionStatus: 'disconnected',
      deviceName: '',
      isCollecting: false,
      collectedFrames: 0,
    });
    this.addLog('已断开 WiFi 设备');
    wx.showToast({ title: '已断开', icon: 'success' });
  },

  async runAnalyze() {
    const rawFrames = this._lastFrames;
    if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
      this.setData({
        analyzing: false,
        errorMsg: "无可用数据",
      });
      wx.hideLoading();
      return;
    }

    const frames = rawFrames.slice(0, MAX_FRAME_COUNT);
    console.log(`\n\n========== 发送给 AI 的 ${frames.length} 帧内容 ==========`);
    console.log("frames[0]:", JSON.stringify(frames[0]));
    if (frames.length > 1) {
      console.log(`frames[${frames.length-1}]:`, JSON.stringify(frames[frames.length-1]));
    }

    try {
      const results = await callRemotePredict(frames, {
        sessionId: `auto_${Date.now()}`,
        actionType: "skating_action",
      });

      wx.hideLoading();

      if (!Array.isArray(results) || results.length === 0) {
        this.setData({
          analyzing: false,
          errorMsg: "AI 服务器未返回结果，请稍后重试",
        });
        return;
      }
      const firstResult = results[0];
      const safeResult =
        firstResult && typeof firstResult === "object" ? firstResult : {};
      const score = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            toNumber(
              safeResult.quality_score,
              safeResult.average_lgb_score,
              safeResult.score,
              safeResult.total_score,
              50,
            ),
          ),
        ),
      );
      const confidence = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            toNumber(
              safeResult.prediction &&
                safeResult.prediction.confidence
                ? safeResult.prediction.confidence * 100
                : safeResult.confidence,
              0,
            ),
          ),
        ),
      );
      const qualityText = String(
        safeResult.reference_similarity_level ||
          safeResult.quality_level ||
          safeResult.quality ||
          safeResult.quality_rank ||
          "-",
      ).trim();
      const comment = String(
        safeResult.label_name ||
          safeResult.commentary ||
          safeResult.comment ||
          "",
      ).trim();

      let scoreColor = "mid";
      if (score < 60) scoreColor = "low";
      else if (score >= 85) scoreColor = "high";
      let qualityClass = "mid";
      const lowerQuality = String(qualityText).toLowerCase();
      if (/poor|bad|差|不及格/.test(lowerQuality)) qualityClass = "low";
      else if (/good|excellent|优秀|好/.test(lowerQuality)) qualityClass = "high";

      this.setData({
        analyzing: false,
        resultVisible: true,
        score,
        scoreColor,
        quality: qualityText,
        qualityClass,
        confidence,
        comment: comment || "继续加油！",
      });

      if (comment) {
        this.speakComment(comment);
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({
        analyzing: false,
        errorMsg: `分析失败：${this.extractError(error)}`,
      });
    }
  },

  onToggleVoice() {
    const ctx = this._innerAudioCtx;
    if (!ctx) {
      this.speakComment(this.data.comment);
      return;
    }
    try {
      if (this.data.voicePlaying) {
        ctx.pause();
        this.setData({ voicePlaying: false });
      } else {
        ctx.play();
        this.setData({ voicePlaying: true });
      }
    } catch (e) {
      this.speakComment(this.data.comment);
    }
  },

  speakComment(text) {
    if (!text) {
      return;
    }
    const plugin = requirePlugin("WechatSI");
    if (!plugin || typeof plugin.textToSpeech !== "function") {
      return;
    }

    try {
      const innerCtx = this._innerAudioCtx;
      if (innerCtx) {
        innerCtx.stop();
        innerCtx.destroy();
        this._innerAudioCtx = null;
      }
    } catch (e) {}

    plugin.textToSpeech({
      lang: "zh_CN",
      tts: true,
      content: String(text).slice(0, 250),
      success: (res) => {
        try {
          const filePath = res.filename;
          const ctx = wx.createInnerAudioContext();
          ctx.src = filePath;
          ctx.onPlay(() => {
            this.setData({ voicePlaying: true });
          });
          ctx.onStop(() => {
            this.setData({ voicePlaying: false });
          });
          ctx.onEnded(() => {
            this.setData({ voicePlaying: false });
          });
          ctx.onError(() => {
            this.setData({ voicePlaying: false });
          });
          this._innerAudioCtx = ctx;
          ctx.play();
        } catch (e) {
          this.setData({ voicePlaying: false });
        }
      },
      fail: () => {
        this.setData({ voicePlaying: false });
      },
    });
  },

  onTapReset() {
    this.setData({
      resultVisible: false,
      score: 0,
      scoreColor: "mid",
      quality: "-",
      qualityClass: "mid",
      confidence: 0,
      comment: "",
      errorMsg: "",
    });
    this._lastFrames = null;
  },

  async onTapSave() {
    const userId = this.getCurrentUserId();
    if (!userId) {
      wx.showModal({
        title: "提示",
        content: "请先登录",
        showCancel: false,
      });
      return;
    }

    const frames = this._lastFrames;
    if (!Array.isArray(frames) || frames.length === 0) {
      wx.showToast({ title: "无数据可保存", icon: "none" });
      return;
    }

    this.setData({ saving: true });

    try {
      let frameFileId = "";
      try {
        const frameUploadRes = await wx.cloud.uploadFile({
          cloudPath: `action_frames/${Date.now()}_${userId || "anonymous"}.json`,
          fileContent: JSON.stringify(frames),
        });
        frameFileId =
          frameUploadRes && frameUploadRes.fileID
            ? String(frameUploadRes.fileID).trim()
            : "";
      } catch (e) {}

      const saveRes = await wx.cloud.callFunction({
        name: "saveTrainingRecord",
        data: {
          collectionName: "student_action_predictions",
          userId,
          frames,
          record: {
            userId,
            frameCount: frames.length,
            score: this.data.score,
            scoreColor: this.data.scoreColor,
            quality: this.data.quality,
            qualityClass: this.data.qualityClass,
            confidence: this.data.confidence,
            comment: this.data.comment,
            payload: null,
            frameFileId,
            source: "student_action_analyze",
          },
        },
      });
      const saveResult = saveRes && saveRes.result ? saveRes.result : {};
      if (!saveResult.ok) {
        throw new Error(saveResult.message || saveResult.code || "save_failed");
      }

      wx.showToast({ title: "保存成功" });
    } catch (error) {
      wx.showToast({
        title: `保存失败：${this.extractError(error)}`,
        icon: "none",
      });
    }

    this.setData({ saving: false });
  },

  withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timeout"));
      }, Math.max(5000, Number(timeoutMs) || 30000));
      Promise.resolve(promise)
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  },

  extractError(error) {
    const safe = error && typeof error === "object" ? error : {};
    return String(safe.errMsg || safe.message || safe.msg || error || "").trim();
  },

  getCurrentUserId() {
    try {
      const userInfo = wx.getStorageSync("userInfo");
      return userInfo && typeof userInfo === "object" && userInfo.userId
        ? String(userInfo.userId).trim()
        : "";
    } catch (e) {
      return "";
    }
  },
});

function toNumber(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const num = Number(values[i]);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return 0;
}

