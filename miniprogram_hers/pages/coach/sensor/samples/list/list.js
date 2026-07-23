const { listSensorTrainingSamples, deleteSensorTrainingSample } = require("../../../../../utils/sensor-model");

const { FEATURE_GATES } = require("../../../../../utils/feature-gates");

const SOURCE_OPTIONS = [
  { label: "鍏ㄩ儴鏉ユ簮", value: "" },
  { label: "妯℃嫙鏁版嵁", value: "mock" },
  { label: "鐪熷疄璁惧", value: "real_device" },
];

const ACTION_LABEL_MAP = {
  sensor_session: "传感器会话",
  basic_skating: "鍩虹婊戣",
  curve_skating: "杞集婊戣",
  weight_shift: "重心转移",
  side_push_recover: "侧蹬收腿",
  braking: "鍒瑰仠鍔ㄤ綔",
};

const SOURCE_LABEL_MAP = {
  mock: "妯℃嫙鏁版嵁",
  real_device: "鐪熷疄璁惧",
};
const SENSOR_COMPONENT_LOCK_MESSAGE = FEATURE_GATES.sensorComponentLockMessage || "传感器组件功能维护中，暂未开放";

const pad2 = (num) => String(num).padStart(2, "0");

const formatTime = (value) => {
  if (!value) {
    return "-";
  }
  let dateObj = null;
  if (value instanceof Date) {
    dateObj = value;
  } else if (value && typeof value.toDate === "function") {
    dateObj = value.toDate();
  } else if (value && typeof value.seconds === "number") {
    dateObj = new Date(value.seconds * 1000);
  } else if (value && value.$date) {
    dateObj = new Date(value.$date);
  } else {
    dateObj = new Date(value);
  }
  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return "-";
  }
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())} ${pad2(dateObj.getHours())}:${pad2(dateObj.getMinutes())}`;
};

Page({
  data: {
    sourceOptions: SOURCE_OPTIONS,
    sourceIndex: 0,
    samples: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    loadingMore: false,
    deletingId: "",
    errorTip: "",
    accessDenied: false,
  },

  onLoad() {
    if (!this.ensureSensorComponentEnabled()) {
      return;
    }
    this.loadSamples(true);
  },

  onPullDownRefresh() {
    this.loadSamples(true, true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) {
      this.loadSamples(false);
    }
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

  getCurrentSourceType() {
    const options = Array.isArray(this.data.sourceOptions) ? this.data.sourceOptions : [];
    const index = Number(this.data.sourceIndex);
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      return "";
    }
    return String(options[index].value || "").trim();
  },

  formatSample(item) {
    const safe = item && typeof item === "object" ? item : {};
    const id = String(safe.id || safe._id || "").trim();
    const actionType = String(safe.actionType || "").trim();
    const sourceType = String(safe.sourceType || "").trim();
    const label = safe.label && typeof safe.label === "object" ? safe.label : {};
    const modelOutput = safe.modelOutput && typeof safe.modelOutput === "object" ? safe.modelOutput : {};
    const score = Number(label.coachScore || modelOutput.overallScore || 0);
    const tags = Array.isArray(label.tags) ? label.tags.filter(Boolean) : [];
    return {
      id,
      sessionId: String(safe.sessionId || "").trim() || "-",
      userId: String(safe.userId || "").trim() || "-",
      actionType,
      actionLabel: ACTION_LABEL_MAP[actionType] || actionType || "-",
      sourceType,
      sourceLabel: SOURCE_LABEL_MAP[sourceType] || sourceType || "未标记",
      coachScore: Number.isFinite(score) ? score : 0,
      qualityTag: String(label.qualityTag || "").trim() || "-",
      coachComment: String(label.coachComment || "").trim(),
      note: String(safe.note || "").trim(),
      frameCount: Number(safe.frameCount || 0),
      tagsText: tags.join("、"),
      createdAtText: formatTime(safe.createdAt),
      modelVersion: String((modelOutput && modelOutput.version) || "").trim() || "-",
      expanded: false,
    };
  },

  loadSamples(reset, fromPullDown) {
    if (!FEATURE_GATES.sensorComponentEnabled) {
      this.setData({
        samples: [],
        hasMore: false,
        loading: false,
        loadingMore: false,
        errorTip: SENSOR_COMPONENT_LOCK_MESSAGE,
      });
      if (fromPullDown) {
        wx.stopPullDownRefresh();
      }
      return Promise.resolve();
    }
    const isReset = !!reset;
    const nextPage = isReset ? 1 : (Number(this.data.page || 1) + 1);
    if (isReset && this.data.loading) {
      return;
    }
    if (!isReset && (this.data.loadingMore || !this.data.hasMore)) {
      return;
    }

    this.setData(isReset
      ? { loading: true, errorTip: "" }
      : { loadingMore: true, errorTip: "" });

    return listSensorTrainingSamples({
      page: nextPage,
      pageSize: this.data.pageSize,
      sourceType: this.getCurrentSourceType(),
    })
      .then((result) => {
        if (!result || result.success === false) {
          throw new Error(String((result && result.message) || "list_sensor_training_samples_failed"));
        }

        const list = Array.isArray(result.samples) ? result.samples.map((item) => this.formatSample(item)) : [];
        const merged = isReset ? list : this.data.samples.concat(list);
        const pagination = result.pagination && typeof result.pagination === "object" ? result.pagination : {};
        this.setData({
          samples: merged,
          page: nextPage,
          hasMore: !!pagination.hasMore,
          accessDenied: false,
          errorTip: "",
        });
      })
      .catch((error) => {
        const msg = String((error && error.message) || "");
        if (msg.includes("permission_denied") || msg.includes("operator_user_not_found")) {
          this.setData({
            accessDenied: true,
            samples: [],
            hasMore: false,
            errorTip: "当前账号没有权限查看样本列表。",
          });
          return;
        }
        this.setData({
          errorTip: "加载样本失败，请稍后重试。",
        });
      })
      .finally(() => {
        this.setData({
          loading: false,
          loadingMore: false,
        });
        if (fromPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  },

  onChangeSource(e) {
    const index = Number(e.detail && e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.sourceOptions.length) {
      return;
    }
    this.setData({
      sourceIndex: index,
      samples: [],
      page: 1,
      hasMore: false,
    });
    this.loadSamples(true);
  },

  onTapRefresh() {
    this.loadSamples(true);
  },

  onToggleExpand(e) {
    const sampleId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    if (!sampleId) {
      return;
    }
    const nextList = (this.data.samples || []).map((item) => {
      if (String(item.id || "") !== sampleId) {
        return item;
      }
      return {
        ...item,
        expanded: !item.expanded,
      };
    });
    this.setData({ samples: nextList });
  },

  onDeleteSample(e) {
    const sampleId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || "").trim();
    if (!sampleId || this.data.deletingId) {
      return;
    }
    wx.showModal({
      title: "鍒犻櫎鏍锋湰",
      content: "删除后该样本将不再出现在列表中，是否继续？",
      confirmText: "鍒犻櫎",
      confirmColor: "#dc2626",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ deletingId: sampleId });
        deleteSensorTrainingSample({
          sampleId,
          hardDelete: false,
        })
          .then((result) => {
            if (!result || result.success === false) {
              throw new Error(String((result && result.message) || "delete_sensor_training_sample_failed"));
            }
            const nextList = (this.data.samples || []).filter((item) => String(item.id || "") !== sampleId);
            this.setData({ samples: nextList });
            wx.showToast({
              title: "鍒犻櫎鎴愬姛",
              icon: "success",
            });
          })
          .catch((error) => {
            const msg = String((error && error.message) || "");
            if (msg.includes("permission_denied")) {
              wx.showToast({ title: "无删除权限", icon: "none" });
              return;
            }
            if (msg.includes("sample_not_found")) {
              wx.showToast({ title: "样本不存在", icon: "none" });
              return;
            }
            wx.showToast({ title: "鍒犻櫎澶辫触锛岃閲嶈瘯", icon: "none" });
          })
          .finally(() => {
            this.setData({ deletingId: "" });
          });
      },
    });
  },
});
