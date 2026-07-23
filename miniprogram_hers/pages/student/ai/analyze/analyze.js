const ACTION_TYPE_OPTIONS = [
  "\u57fa\u7840\u6ed1\u884c",
  "\u86c7\u5f62\u7ed5\u6869",
  "\u5355\u811a\u6ed1\u884c",
  "\u5239\u8f66\u63a7\u5236",
  "\u4ea4\u53c9\u6b65",
];
const { FEATURE_GATES } = require("../../../../utils/feature-gates");
const { SENSOR_ROLES, analyzeSensorSession } = require("../../../../utils/sensor-model");

const SOURCE_TYPE_OPTIONS = [
  { label: "视频分析", value: "video" },
  { label: "传感器分析", value: "sensor" },
];

const TRANSPORT_OPTIONS = [
  { label: "模拟数据", value: "mock" },
  { label: "WiFi", value: "wifi" },
];

const round3 = (value) => Math.round(value * 1000) / 1000;
const randomIn = (min, max) => min + Math.random() * (max - min);

const buildMockSensorFrames = (frameCount = 30, sampleIntervalMs = 50) => {
  const targetCount = Math.max(24, Math.floor(Number(frameCount) || 30));
  const intervalMs = Math.max(20, Math.floor(Number(sampleIntervalMs) || 50));
  const start = Date.now();
  const frames = [];

  for (let i = 0; i < targetCount; i += 1) {
    const phase = i / Math.max(1, targetCount - 1);
    const swing = Math.sin(phase * Math.PI * 2);
    const frame = {
      t: start + i * intervalMs,
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
};

const I18N = {
  actionType: "\u52a8\u4f5c\u7c7b\u578b",
  actionVideo: "\u52a8\u4f5c\u89c6\u9891",
  chooseVideo: "\u9009\u62e9\u89c6\u9891",
  duration: "\u65f6\u957f",
  size: "\u5927\u5c0f",
  trainingNote: "\u8bad\u7ec3\u5907\u6ce8\uff08\u53ef\u9009\uff09",
  notePlaceholder: "\u4f8b\u5982\uff1a\u86c7\u5f62\u7ed5\u6869\u5de6\u8f6c\u65f6\u91cd\u5fc3\u4e0d\u592a\u7a33",
  analyzing: "\u5206\u6790\u4e2d...",
  runAnalysis: "\u5f00\u59cb AI \u5206\u6790",
  analysisResult: "\u5206\u6790\u7ed3\u679c",
  phaseScores: "\u9636\u6bb5\u5206\u6790",
  strengths: "\u52a8\u4f5c\u4f18\u52bf",
  weaknesses: "\u5f85\u63d0\u5347\u9879",
  riskAlerts: "\u98ce\u9669\u63d0\u793a",
  trainingPlan: "\u4e09\u65e5\u8bad\u7ec3\u8ba1\u5212",
  videoQuality: "\u89c6\u9891\u8d28\u91cf",
  scoreText: "\u8bc4\u5206",
  suggestions: "\u6539\u8fdb\u5efa\u8bae",
};

const formatDuration = (duration) => {
  const sec = Math.max(0, Number(duration) || 0);
  return `${sec.toFixed(1)}\u79d2`;
};

const formatSize = (size) => {
  const value = Math.max(0, Number(size) || 0);
  if (!value) {
    return "0KB";
  }
  const mb = value / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(2)}MB`;
  }
  return `${(value / 1024).toFixed(1)}KB`;
};

const normalizeStringList = (value, limit = 6) =>
  Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit)
    : [];

const polishText = (value) =>
  String(value || "")
    .replace(/可继续细化分析/g, "可继续巩固与优化")
    .replace(/可继续细化难度/g, "可逐步提高难度")
    .replace(/可继续细化/g, "可继续巩固");

const simplifyWeaknessNote = (key, noteText) => {
  const keyText = String(key || "").trim();
  if (keyText === "legDrive") {
    return "蹬地发力还不够干脆，蹬出后回收稍慢。建议练“侧向轻蹬+快速收腿”，每组20-30秒，做4-6组。";
  }
  if (keyText === "rhythm") {
    return "滑行节奏有时快有时慢。建议跟每分钟80-90节拍练习，每拍做一次蹬滑，先求稳定再提速。";
  }
  return polishText(noteText);
};

const normalizeDetailItems = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        key: String(item && item.key ? item.key : ""),
        name: String(item && item.name ? item.name : ""),
        score: Math.max(0, Math.min(100, Number(item && item.score) || 0)),
        note: simplifyWeaknessNote(item && item.key ? item.key : "", item && item.note ? item.note : ""),
      }))
      .filter((item) => item.name)
      .slice(0, 4)
    : [];

const normalizePhaseScores = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        key: String(item && item.key ? item.key : ""),
        name: String(item && item.name ? item.name : ""),
        score: Math.max(0, Math.min(100, Number(item && item.score) || 0)),
        comment: String(item && item.comment ? item.comment : ""),
      }))
      .filter((item) => item.name)
      .slice(0, 4)
    : [];

const normalizeTrainingPlan = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        day: String(item && item.day ? item.day : ""),
        focus: String(item && item.focus ? item.focus : ""),
        duration: String(item && item.duration ? item.duration : ""),
        tasks: normalizeStringList(item && item.tasks, 5),
      }))
      .filter((item) => item.day || item.focus || item.tasks.length)
      .slice(0, 5)
    : [];

const pickTopAndLowMetrics = (metrics) => {
  const sorted = [...metrics].sort((a, b) => b.score - a.score);
  const strengthAdviceMap = {
    balance: "\u91cd\u5fc3\u63a7\u5236\u8f83\u7a33\uff0c\u5efa\u8bae\u9010\u6b65\u589e\u52a0\u6ed1\u884c\u8ddd\u79bb\u3002",
    stability: "\u52a8\u4f5c\u7a33\u5b9a\u6027\u4e0d\u9519\uff0c\u53ef\u52a0\u5165\u8f7b\u5fae\u53d8\u901f\u7ec3\u4e60\u3002",
    posture: "\u59ff\u6001\u4fdd\u6301\u8f83\u597d\uff0c\u7ee7\u7eed\u5173\u6ce8\u4e0a\u8eab\u653e\u677e\u4e0e\u4f38\u5c55\u3002",
    legDrive: "\u817f\u90e8\u9a71\u52a8\u6709\u6548\uff0c\u53ef\u589e\u52a0\u77ed\u7ec4\u7206\u53d1\u7ec3\u4e60\u3002",
    rhythm: "\u8282\u594f\u611f\u826f\u597d\uff0c\u53ef\u914d\u5408\u8282\u62cd\u505a\u8fde\u7eed\u52a8\u4f5c\u8bad\u7ec3\u3002",
  };
  const strengths = sorted.slice(0, 2).map((item) => ({
    key: item.key,
    name: item.name,
    score: item.score,
    note: strengthAdviceMap[item.key] || `\u300c${item.name}\u300d\u8868\u73b0\u8f83\u597d\uff0c\u5efa\u8bae\u4fdd\u6301\u5f53\u524d\u8bad\u7ec3\u8282\u594f\u3002`,
  }));
  const weaknesses = sorted.slice(-2).reverse().map((item) => ({
    key: item.key,
    name: item.name,
    score: item.score,
    note: simplifyWeaknessNote(item.key, `\u300c${item.name}\u5efa\u8bae\u52a0\u5927\u5206\u89e3\u7ec3\u4e60\u6bd4\u4f8b\u3002`),
  }));
  return { strengths, weaknesses };
};

const buildSummaryByMetrics = (score, weakestName, strongestName) => {
  const safeScore = Number(score) || 0;
  const weakText = weakestName ? `，当前短板在${weakestName}` : "";
  const strongText = strongestName ? `，优势项为${strongestName}` : "";
  if (safeScore >= 85) {
    return `整体动作表现优秀${strongText}，可逐步提升动作难度。`;
  }
  if (safeScore >= 75) {
    return `整体动作表现良好${weakText}${strongText}，建议继续做针对性细化训练。`;
  }
  if (safeScore >= 60) {
    return `当前已具备基础动作能力${weakText}，建议先补齐薄弱环节再提速。`;
  }
  return `当前动作控制仍需加强${weakText}，建议先进行稳定性与重心控制训练。`;
};

const buildTipsByMetrics = (metrics) => {
  const adviceMap = {
    balance: "重心控制偏弱，建议做单脚滑行与重心转移练习。",
    stability: "动作稳定性不足，建议降速后做短距离重复滑行。",
    posture: "姿态控制待提升，注意上身微前倾并保持视线前方。",
    legDrive: "蹬伸发力不足，建议加强侧向蹬伸与回收动作。",
    rhythm: "节奏连贯性不足，建议配合节拍器做连续动作练习。",
  };
  const sorted = [...(Array.isArray(metrics) ? metrics : [])].sort((a, b) => (a.score || 0) - (b.score || 0));
  const lowItems = sorted.filter((item) => Number(item.score) < 75).slice(0, 2);
  const tips = lowItems
    .map((item) => adviceMap[item.key] || `${item.name || "当前维度"}仍有提升空间，建议分解训练。`)
    .filter(Boolean);
  return tips.length ? tips : ["动作整体完成度较好，建议维持当前训练频率并逐步增加强度。"];
};

const normalizeNoteEcho = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    return { text: "", muted: false };
  }
  const lower = text.toLowerCase();
  const isNoNote = text.includes("未提供训练备注")
    || text.includes("未提供备注")
    || text.includes("未填写训练备注")
    || lower.includes("no note")
    || lower.includes("note: none");
  if (!isNoNote) {
    return { text, muted: false };
  }
  return {
    text: "未填写训练备注，系统已按视频自动评估。",
    muted: true,
  };
};

const normalizeAnalysisResult = (raw, inferenceMode) => {
  const metrics = Array.isArray(raw && raw.metrics) ? raw.metrics : [];
  const tips = Array.isArray(raw && raw.tips) ? raw.tips : [];
  const overallScore = Number(raw && raw.overallScore) || 0;

  let riskLevelClass = "middle";
  let riskLevelText = "寤鸿缁х画宸╁浐";
  if (overallScore >= 80) {
    riskLevelClass = "good";
    riskLevelText = "鍔ㄤ綔琛ㄧ幇鑹ソ";
  } else if (overallScore < 60) {
    riskLevelClass = "high";
    riskLevelText = "褰撳墠闇€閲嶇偣鎻愬崌";
  }

  const baseMetrics = metrics.map((item) => ({
    key: String(item.key || ""),
    name: String(item.name || ""),
    score: Math.max(0, Math.min(100, Number(item.score) || 0)),
  }));
  const detailGroups = pickTopAndLowMetrics(baseMetrics);
  const ascMetrics = [...baseMetrics].sort((a, b) => a.score - b.score);
  const weakestMetric = ascMetrics[0] || null;
  const strongestMetric = ascMetrics[ascMetrics.length - 1] || null;
  const strengths = normalizeDetailItems(raw && raw.strengths);
  const weaknesses = normalizeDetailItems(raw && raw.weaknesses);
  const phaseScores = normalizePhaseScores(raw && raw.phaseScores);
  const riskAlerts = normalizeStringList(raw && raw.riskAlerts, 5);
  const trainingPlan = normalizeTrainingPlan(raw && raw.trainingPlan);
  const rawVideoQuality = raw && raw.videoQuality && typeof raw.videoQuality === "object"
    ? raw.videoQuality
    : {};
  const videoQualityScore = Math.max(0, Math.min(100, Number(rawVideoQuality.score) || 0));

  // 澶勭悊summary瀛楁锛岀Щ闄ゅ崰浣嶆枃瀛?  let processedSummary = polishText((raw && raw.summary) || "");
  const lowerSummary = processedSummary.toLowerCase();
  const shouldUseGeneratedSummary = !processedSummary.trim()
    || lowerSummary.includes("keypointmodelservice")
    || lowerSummary.includes("placeholder")
    || processedSummary.includes("鍗犱綅")
    || processedSummary.includes("鍔ㄤ綔鍒嗘瀽瀹屾垚")
    || processedSummary.includes("下面是结果分析");
  if (shouldUseGeneratedSummary) {
    processedSummary = buildSummaryByMetrics(
      overallScore,
      weakestMetric && weakestMetric.name ? weakestMetric.name : "",
      strongestMetric && strongestMetric.name ? strongestMetric.name : ""
    );
  }

  // 澶勭悊tips鏁扮粍锛屽幓鎺夌浜屾潯寤鸿
  let processedTips = tips.length ? tips : ["\u6570\u636e\u4e0d\u8db3\uff0c\u8bf7\u91cd\u65b0\u62cd\u6444\u66f4\u6e05\u6670\u4e14\u66f4\u5b8c\u6574\u7684\u52a8\u4f5c\u89c6\u9891\u3002"];
  if (processedTips.length > 1) {
    processedTips = processedTips.filter((_, index) => index !== 1);
  }

  // 杩囨护鎺夊寘鍚崰浣嶄俊鎭殑tips
  processedTips = processedTips.filter(tip => 
    !tip.includes("鍗犱綅") &&
    !tip.includes("缁х画淇濇寔瑙嗛鎷嶆憚瑙掑害绋冲畾") &&
    !tip.includes("鎻愰珮鍏抽敭鐐硅瘑鍒巼")
  );
  if (!processedTips.length) {
    processedTips = buildTipsByMetrics(baseMetrics);
  }
  const normalizedNoteEcho = normalizeNoteEcho(raw && raw.noteEcho);

  return {
    overallScore,
    summary: processedSummary,
    noteEcho: normalizedNoteEcho.text,
    noteEchoMuted: normalizedNoteEcho.muted,

    metrics: baseMetrics,
    phaseScores,
    strengths: strengths.length ? strengths : detailGroups.strengths,
    weaknesses: weaknesses.length ? weaknesses : detailGroups.weaknesses,
    riskAlerts,
    trainingPlan,
    videoQuality: {
      score: videoQualityScore,
      issues: normalizeStringList(rawVideoQuality.issues, 4).map((item) => polishText(item)),
      recommendation: polishText(rawVideoQuality.recommendation || ""),
    },
    tips: processedTips,
    riskLevelClass,
    riskLevelText
  };
};

const mapAnalyzeErrorText = (msg) => {
  const text = String(msg || "").toLowerCase();
  if (!text) return "鍒嗘瀽澶辫触锛岃绋嶅悗閲嶈瘯";
  if (text.includes("video_required")) return "璇峰厛閫夋嫨瑙嗛";
  if (text.includes("upload")) return "瑙嗛涓婁紶澶辫触";
  if (text.includes("unsupported_type")) return "云函数参数错误";
  if (text.includes("file_id_required")) return "瑙嗛鏂囦欢ID缂哄け";
  if (text.includes("function not found") || text.includes("functionname") || text.includes("function name")) {
    return "浜戝嚱鏁版湭閮ㄧ讲锛岃鍏堥儴缃?skateActionAnalyze";
  }
  if (text.includes("timeout")) return "云函数超时，请稍后重试";
  if (text.includes("network")) return "缃戠粶寮傚父锛岃妫€鏌ョ綉缁滃悗閲嶈瘯";
  if (text.includes("permission")) return "鏉冮檺涓嶈冻锛岃妫€鏌ヤ簯鐜鏉冮檺";
  return "鍒嗘瀽澶辫触锛岃绋嶅悗閲嶈瘯";
};

Page({
  _analysisLoadingShown: false,
  _pendingAutoAnalyze: false,
  _autoAnalyzeTriggered: false,
  _isReadyForAutoAnalyze: false,

  data: {
    featureLocked: !FEATURE_GATES.studentAiActionAnalyzeEnabled,
    featureLockMessage: FEATURE_GATES.studentAiActionAnalyzeLockMessage || "AI动作分析功能维护中，暂未开放",
    actionTypeOptions: ACTION_TYPE_OPTIONS,
    sourceTypeOptions: SOURCE_TYPE_OPTIONS,
    i18n: I18N,
    actionTypeIndex: 0,
    sourceTypeIndex: 0,
    note: "",
    videoPath: "",
    remoteVideoUrl: "",
    videoCloudFileId: "",
    videoInfo: {
      duration: 0,
      size: 0,
      width: 0,
      height: 0,
      durationText: "",
      sizeText: "",
    },
    analyzing: false,
    analysisResult: null,
    sensorFrameCount: 30,
    sensorSampleIntervalMs: 50,
    transportOptions: TRANSPORT_OPTIONS,
    transportIndex: 0,
    wifiHost: "",
    wifiPort: 8080,
    wifiConnected: false,
    wifiConnecting: false,
  },

  showAnalyzeLoading() {
    if (this._analysisLoadingShown) {
      return;
    }
    wx.showLoading({ title: "鍒嗘瀽涓?..", mask: true });
    this._analysisLoadingShown = true;
  },

  hideAnalyzeLoading() {
    if (!this._analysisLoadingShown) {
      return;
    }
    wx.hideLoading();
    this._analysisLoadingShown = false;
  },

  showAnalyzeToast({ title, icon = "none" }) {
    this.hideAnalyzeLoading();
    wx.showToast({ title, icon });
  },

  onLoad(options) {
    const sourceOptions = options || {};
    const sourceFrom = this.decodeQueryValue(sourceOptions.from).toLowerCase();
    const shouldAutoStart = sourceFrom === "community_manage_video_list"
      && this.parseBooleanQuery(sourceOptions.autoStart);
    const fileID = this.decodeQueryValue(sourceOptions.fileID);
    const videoUrl = this.decodeQueryValue(sourceOptions.videoUrl);
    const normalizedFileID = fileID.startsWith("cloud://") ? fileID : "";
    const normalizedVideoPath = this.isLocalVideoPath(videoUrl) ? videoUrl : "";
    const normalizedRemoteVideoUrl = normalizedVideoPath ? "" : (this.isRemoteVideoUrl(videoUrl) ? videoUrl : "");
    if (!normalizedFileID && !normalizedVideoPath && !normalizedRemoteVideoUrl) {
      this._pendingAutoAnalyze = false;
      return;
    }
    this.setData({
      videoCloudFileId: normalizedFileID,
      videoPath: normalizedVideoPath,
      remoteVideoUrl: normalizedRemoteVideoUrl,
      analysisResult: null,
    }, () => {
      this._pendingAutoAnalyze = shouldAutoStart;
      if (this._pendingAutoAnalyze && this._isReadyForAutoAnalyze) {
        this.triggerAutoAnalyze();
      }
    });
  },

  onReady() {
    this._isReadyForAutoAnalyze = true;
    if (this._pendingAutoAnalyze) {
      this.triggerAutoAnalyze();
    }
  },

  decodeQueryValue(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  },

  parseBooleanQuery(value) {
    const raw = String(value || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
  },

  triggerAutoAnalyze() {
    if (this.data.featureLocked) {
      this._pendingAutoAnalyze = false;
      return;
    }
    if (this._autoAnalyzeTriggered) {
      return;
    }
    this._autoAnalyzeTriggered = true;
    setTimeout(() => {
      this.analyzeAction();
    }, 80);
  },

  isLocalVideoPath(path) {
    const raw = String(path || "").trim().toLowerCase();
    if (!raw) {
      return false;
    }
    return raw.startsWith("wxfile://")
      || raw.startsWith("file://")
      || raw.startsWith("/")
      || /^[a-z]:\\/.test(raw);
  },

  isRemoteVideoUrl(path) {
    return /^https?:\/\//i.test(String(path || "").trim());
  },

  onActionTypeChange(e) {
    const index = Number(e && e.detail && e.detail.value);
    if (Number.isNaN(index)) {
      return;
    }
    this.setData({ actionTypeIndex: index });
  },

  onSourceTypeChange(e) {
    const index = Number(e && e.detail && e.detail.value);
    if (Number.isNaN(index)) {
      return;
    }
    this.setData({ 
      sourceTypeIndex: index,
      analysisResult: null,
    });
  },

  onSensorFrameCountInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ sensorFrameCount: Math.max(24, Math.min(180, Number(value) || 30)) });
  },

  onSensorIntervalInput(e) {
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ sensorSampleIntervalMs: Math.max(20, Math.min(200, Number(value) || 50)) });
  },

  onNoteInput(e) {
    if (this.data.featureLocked) {
      return;
    }
    const value = e && e.detail ? e.detail.value : "";
    this.setData({ note: String(value || "") });
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

  chooseVideo() {
    if (this.data.featureLocked) {
      wx.showToast({ title: this.data.featureLockMessage, icon: "none" });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ["video"],
      sourceType: ["camera", "album"],
      maxDuration: 45,
      success: (res) => {
        const file = res && Array.isArray(res.tempFiles) ? res.tempFiles[0] : null;
        if (!file || !file.tempFilePath) {
          wx.showToast({ title: "\u672a\u9009\u62e9\u89c6\u9891", icon: "none" });
          return;
        }
        const videoInfo = {
          duration: Number(file.duration) || 0,
          size: Number(file.size) || 0,
          width: Number(file.width) || 0,
          height: Number(file.height) || 0,
          durationText: formatDuration(file.duration),
          sizeText: formatSize(file.size),
        };
        this.setData({
          videoPath: file.tempFilePath,
          remoteVideoUrl: "",
          videoCloudFileId: "",
          videoInfo,
          analysisResult: null,
        });
      },
      fail: () => {
        wx.showToast({ title: "\u9009\u62e9\u89c6\u9891\u5931\u8d25", icon: "none" });
      },
    });
  },

  downloadRemoteVideo(url) {
    const safeUrl = String(url || "").trim();
    if (!safeUrl) {
      return Promise.reject(new Error("video_required"));
    }
    if (typeof wx.downloadFile !== "function") {
      return Promise.reject(new Error("download_not_supported"));
    }
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url: safeUrl,
        success: (res) => {
          const statusCode = Number(res && res.statusCode);
          const tempFilePath = String(res && res.tempFilePath ? res.tempFilePath : "").trim();
          if (statusCode >= 200 && statusCode < 300 && tempFilePath) {
            resolve(tempFilePath);
            return;
          }
          reject(new Error(`download_url_status_${statusCode || 0}`));
        },
        fail: (error) => reject(error),
      });
    });
  },

  uploadVideoIfNeeded() {
    const { videoPath, videoCloudFileId, remoteVideoUrl } = this.data;
    if (videoCloudFileId) {
      return Promise.resolve(videoCloudFileId);
    }

    const uploadLocalFile = (localPath) => {
      const safeLocalPath = String(localPath || "").trim();
      if (!safeLocalPath) {
        return Promise.reject(new Error("video_required"));
      }
      const extMatch = safeLocalPath.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch ? extMatch[1] : "mp4";
      const cloudPath = `ai/skating/videos/${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
      return wx.cloud
        .uploadFile({
          cloudPath,
          filePath: safeLocalPath,
        })
        .then((res) => {
          const fileID = res && res.fileID ? res.fileID : "";
          if (!fileID) {
            throw new Error("upload_failed");
          }
          this.setData({ videoCloudFileId: fileID });
          return fileID;
        });
    };

    if (videoPath) {
      return uploadLocalFile(videoPath);
    }
    if (!remoteVideoUrl) {
      return Promise.reject(new Error("video_required"));
    }
    return this.downloadRemoteVideo(remoteVideoUrl)
      .then((localPath) => {
        this.setData({
          videoPath: localPath,
        });
        return uploadLocalFile(localPath);
      });
  },

  analyzeAction() {
    if (this.data.analyzing) {
      return;
    }
    if (this.data.featureLocked) {
      wx.showToast({ title: this.data.featureLockMessage, icon: "none" });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: "\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1", icon: "none" });
      return;
    }

    const sourceType = this.data.sourceTypeOptions[this.data.sourceTypeIndex]?.value || "video";

    if (sourceType === "video") {
      if (!this.data.videoPath && !this.data.videoCloudFileId && !this.data.remoteVideoUrl) {
        wx.showToast({ title: "\u8bf7\u5148\u9009\u62e9\u89c6\u9891", icon: "none" });
        return;
      }
      this.analyzeByVideo();
    } else {
      this.analyzeBySensor();
    }
  },

  analyzeByVideo() {
    this.setData({ analyzing: true });
    this.showAnalyzeLoading();

    const actionType = this.data.actionTypeOptions[this.data.actionTypeIndex] || ACTION_TYPE_OPTIONS[0];

    this.uploadVideoIfNeeded()
      .then((fileID) =>
        wx.cloud.callFunction({
          name: "skateActionAnalyze",
          data: {
            type: "analyze",
            fileID,
            actionType,
            note: this.data.note,
            videoInfo: this.data.videoInfo,
          },
        })
      )
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || result.errMsg || "analyze_failed");
        }
        const inferenceMode = String(result.inferenceMode || "local_rule");
        this.setData({
          analysisResult: normalizeAnalysisResult(result.analysis || {}, inferenceMode),
        });
        if (inferenceMode === "api_keypoint") {
          this.showAnalyzeToast({ title: "\u6a21\u578b\u5206\u6790\u5b8c\u6210", icon: "success" });
          return;
        }
        this.showAnalyzeToast({ title: "\u5df2\u56de\u9000\u5230\u672c\u5730\u5206\u6790" });
      })
      .catch((error) => {
        const msg = String((error && error.message) || "");
        console.error("AI视频分析失败详情:", error);
        this.showAnalyzeToast({ title: mapAnalyzeErrorText(msg) });
      })
      .finally(() => {
        this.hideAnalyzeLoading();
        this.setData({ analyzing: false });
      });
  },

  onTransportChange(e) {
    const index = Number(e && e.detail && e.detail.value);
    if (Number.isNaN(index)) {
      return;
    }
    this.setData({ transportIndex: index });
    const transport = TRANSPORT_OPTIONS[index]?.value || "mock";
    if (transport === "wifi") {
      const app = getApp();
      if (app && typeof app.setDeviceTransport === "function") {
        app.setDeviceTransport("wifi", {
          host: this.data.wifiHost,
          port: this.data.wifiPort,
          path: "/sensor",
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

  connectWifiDevice() {
    if (this.data.wifiConnecting) {
      return;
    }
    const host = String(this.data.wifiHost || "").trim();
    if (!host) {
      wx.showToast({ title: "请输入设备地址", icon: "none" });
      return;
    }

    this.setData({ wifiConnecting: true });

    const app = getApp();
    if (app && typeof app.setDeviceTransport === "function") {
      app.setDeviceTransport("wifi", {
        host: this.data.wifiHost,
        port: this.data.wifiPort,
        path: "/sensor",
      });
    }

    const sdk = this.resolveDeviceSdk();
    if (!sdk || typeof sdk.connect !== "function") {
      this.setData({ wifiConnected: false, wifiConnecting: false });
      wx.showToast({ title: "设备SDK未配置", icon: "none" });
      return;
    }

    sdk.connect().then(() => {
      this.setData({ wifiConnected: true, wifiConnecting: false });
      wx.showToast({ title: "WiFi连接成功", icon: "success" });
    }).catch((error) => {
      const msg = String((error && error.message) || "连接失败");
      this.setData({ wifiConnected: false, wifiConnecting: false });
      wx.showToast({ title: msg, icon: "none" });
    });
  },

  analyzeBySensor() {
    this.setData({ analyzing: true });
    this.showAnalyzeLoading();

    const actionType = this.data.actionTypeOptions[this.data.actionTypeIndex] || ACTION_TYPE_OPTIONS[0];
    const transport = TRANSPORT_OPTIONS[this.data.transportIndex]?.value || "mock";

    let frames = [];
    if (transport === "mock") {
      frames = buildMockSensorFrames(this.data.sensorFrameCount, this.data.sensorSampleIntervalMs);
    }

    const sessionId = `sensor_${Date.now()}`;

    const doAnalyze = (collectedFrames) => analyzeSensorSession({
      sessionId,
      actionType,
      note: this.data.note,
      userId: this.getCurrentUserId(),
      allowSinglePointDebug: false,
      frames: collectedFrames,
      transport,
    });

    if (transport === "wifi") {
      const sdk = this.resolveDeviceSdk();
      if (!sdk || typeof sdk.collectFrames !== "function") {
        this.hideAnalyzeLoading();
        this.setData({ analyzing: false });
        wx.showToast({ title: "设备SDK未配置", icon: "none" });
        return;
      }
      sdk.collectFrames({
        frameCount: this.data.sensorFrameCount,
        timeoutMs: 15000,
        sampleIntervalMs: this.data.sensorSampleIntervalMs,
      }).then((collectedFrames) => {
        if (!collectedFrames || !collectedFrames.length) {
          throw new Error("未采集到传感器数据");
        }
        return doAnalyze(collectedFrames);
      }).then((result) => {
        if (!result || !result.success) {
          throw new Error(String((result && result.message) || "analyze_failed"));
        }
        const inferenceMode = String(result.inferenceMode || "local_rule");
        this.setData({
          analysisResult: normalizeAnalysisResult(result.analysis || {}, inferenceMode),
        });
        if (inferenceMode === "sensor_api_v1") {
          this.showAnalyzeToast({ title: "传感器模型分析完成", icon: "success" });
          return;
        }
        this.showAnalyzeToast({ title: "已回退到本地分析" });
      }).catch((error) => {
        const msg = String((error && error.message) || "");
        console.error("AI传感器分析失败详情:", error);
        this.showAnalyzeToast({ title: mapAnalyzeErrorText(msg) });
      }).finally(() => {
        this.hideAnalyzeLoading();
        this.setData({ analyzing: false });
      });
      return;
    }

    doAnalyze(frames)
      .then((result) => {
        if (!result || !result.success) {
          throw new Error(String((result && result.message) || "analyze_failed"));
        }
        const inferenceMode = String(result.inferenceMode || "local_rule");
        this.setData({
          analysisResult: normalizeAnalysisResult(result.analysis || {}, inferenceMode),
        });
        if (inferenceMode === "sensor_api_v1") {
          this.showAnalyzeToast({ title: "\u4f20\u611f\u5668\u6a21\u578b\u5206\u6790\u5b8c\u6210", icon: "success" });
          return;
        }
        this.showAnalyzeToast({ title: "\u5df2\u56de\u9000\u5230\u672c\u5730\u5206\u6790" });
      })
      .catch((error) => {
        const msg = String((error && error.message) || "");
        console.error("AI传感器分析失败详情:", error);
        this.showAnalyzeToast({ title: mapAnalyzeErrorText(msg) });
      })
      .finally(() => {
        this.hideAnalyzeLoading();
        this.setData({ analyzing: false });
      });
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

  getCurrentUserId() {
    try {
      const userInfo = wx.getStorageSync("userInfo") || {};
      return String(userInfo.id || userInfo._id || "").trim();
    } catch (e) {
      return "";
    }
  },

  onUnload() {
    this._pendingAutoAnalyze = false;
    this._autoAnalyzeTriggered = false;
    this._isReadyForAutoAnalyze = false;
    this.hideAnalyzeLoading();
  },
});
