// app.js
const { pickRandomAvatar, resolveAvatarSeed } = require("./utils/avatar");
let _createWearableDeviceSdk = null;
const getCreateWearableDeviceSdk = () => {
  if (typeof _createWearableDeviceSdk === "function") {
    return _createWearableDeviceSdk;
  }
  try {
    const loaded = require("./utils/wearable-device-sdk");
    _createWearableDeviceSdk = loaded && typeof loaded.createWearableDeviceSdk === "function"
      ? loaded.createWearableDeviceSdk
      : null;
  } catch (e) {
    _createWearableDeviceSdk = null;
  }
  return _createWearableDeviceSdk;
};
const SCHEDULE_BOOKING_SUBSCRIBE_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY_SUBSCRIBE_PROMPT_AT = "scheduleBookingSubscribePromptAt";
const STORAGE_KEY_SUBSCRIBE_ACCEPTED_AT = "scheduleBookingSubscribeAcceptedAt";
const STORAGE_KEY_SUBSCRIBE_TEMPLATE_ID = "scheduleBookingSubscribeTemplateId";
const STORAGE_KEY_MEDIA_SANITIZE_VERSION = "mediaSanitizeVersion";
const STORAGE_KEY_WEARABLE_BLE_CONFIG = "wearableBleConfig";
const MEDIA_SANITIZE_VERSION = "2026-03-13-v2";
const DEFAULT_BLE_NOTIFY_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const DEFAULT_BLE_NOTIFY_CHARACTERISTIC_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

App({
  scheduleBookingSubscribeRequesting: false,
  storageMediaSanitizedOnce: false,
  isDevtoolsRuntime: false,

  isRunningInDevtools() {
    try {
      const info = wx.getSystemInfoSync();
      const platform = String(info && info.platform ? info.platform : "").toLowerCase();
      const model = String(info && info.model ? info.model : "").toLowerCase();
      const system = String(info && info.system ? info.system : "").toLowerCase();
      const brand = String(info && info.brand ? info.brand : "").toLowerCase();
      const environment = String(
        info && (info.environment || (info.host && info.host.env))
          ? (info.environment || (info.host && info.host.env))
          : ""
      ).toLowerCase();
      const mobilePlatforms = ["ios", "android", "iphone", "ipad"];
      const looksLikeMobile = mobilePlatforms.includes(platform)
        || system.includes("ios")
        || system.includes("android");
      if (!looksLikeMobile) {
        return true;
      }
      return (
        platform === "devtools"
        || model.includes("devtools")
        || system.includes("devtools")
        || brand === "devtools"
        || environment.includes("devtools")
      );
    } catch (e) {
      return false;
    }
  },

  isInvalidLocalMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return false;
    }
    const lower = raw.toLowerCase();
    return (
      lower.includes("/__tmp__/")
      || lower.startsWith("http://127.0.0.1")
      || lower.startsWith("wxfile://")
      || lower.startsWith("file://")
      || lower.startsWith("blob:")
    );
  },

  sanitizeCachedUserInfo() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    if (!userInfo || typeof userInfo !== "object") {
      return;
    }
    const next = { ...userInfo };
    let changed = false;
    if (this.isInvalidLocalMediaUrl(next.avatarUrl)) {
      next.avatarUrl = "";
      changed = true;
    }
    if (!String(next.avatarUrl || "").trim()) {
      next.avatarUrl = pickRandomAvatar(resolveAvatarSeed(next));
      changed = true;
    }
    if (changed) {
      wx.setStorageSync("userInfo", next);
    }
  },

  sanitizeStorageValueWithFlag(value, stateInput, depthInput) {
    const state = stateInput && typeof stateInput === "object"
      ? stateInput
      : { nodes: 0, maxNodes: 5000, maxDepth: 24 };
    const depth = Number.isFinite(depthInput) ? Number(depthInput) : 0;
    if (state.nodes >= state.maxNodes || depth > state.maxDepth) {
      return { value, changed: false };
    }
    state.nodes += 1;

    if (typeof value === "string") {
      if (this.isInvalidLocalMediaUrl(value)) {
        return { value: "", changed: true };
      }
      return { value, changed: false };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const result = this.sanitizeStorageValueWithFlag(item, state, depth + 1);
        if (result.changed) {
          changed = true;
        }
        return result.value;
      });
      return changed ? { value: next, changed: true } : { value, changed: false };
    }
    if (value && typeof value === "object") {
      let changed = false;
      const next = {};
      Object.keys(value).forEach((key) => {
        const result = this.sanitizeStorageValueWithFlag(value[key], state, depth + 1);
        if (result.changed) {
          changed = true;
        }
        next[key] = result.value;
      });
      return changed ? { value: next, changed: true } : { value, changed: false };
    }
    return { value, changed: false };
  },

  sanitizeAllStorageMediaUrls(force) {
    const needForce = !!force;
    if (this.storageMediaSanitizedOnce && !needForce) {
      return;
    }
    if (!needForce) {
      try {
        const sanitizedVersion = String(wx.getStorageSync(STORAGE_KEY_MEDIA_SANITIZE_VERSION) || "").trim();
        if (sanitizedVersion === MEDIA_SANITIZE_VERSION) {
          this.storageMediaSanitizedOnce = true;
          return;
        }
      } catch (e) {}
    }
    let info = null;
    try {
      info = wx.getStorageInfoSync();
    } catch (e) {
      return;
    }
    const keys = info && Array.isArray(info.keys) ? info.keys : [];
    const startAt = Date.now();
    const TIME_BUDGET_MS = 24;
    const KEY_LIMIT = 80;
    const targetKeys = keys.slice(0, KEY_LIMIT);
    targetKeys.forEach((key) => {
      if (Date.now() - startAt > TIME_BUDGET_MS) {
        return;
      }
      try {
        const oldValue = wx.getStorageSync(key);
        const result = this.sanitizeStorageValueWithFlag(oldValue);
        if (result.changed) {
          wx.setStorageSync(key, result.value);
        }
      } catch (e) {}
    });
    this.storageMediaSanitizedOnce = true;
    try {
      wx.setStorageSync(STORAGE_KEY_MEDIA_SANITIZE_VERSION, MEDIA_SANITIZE_VERSION);
    } catch (e) {}
  },

  resolveRuntimeRole() {
    const roleList = [
      wx.getStorageSync("userRole"),
      wx.getStorageSync("accountRole"),
      (wx.getStorageSync("userInfo") || {}).role,
    ];
    const normalized = roleList
      .map((item) => String(item || "").trim().toLowerCase())
      .find(Boolean);
    return normalized || "";
  },

  resolveCurrentUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  getScheduleBookingSubscribeTemplateId() {
    const fromGlobal = String(
      this.globalData
      && this.globalData.subscribeTemplates
      && this.globalData.subscribeTemplates.scheduleBooking
        ? this.globalData.subscribeTemplates.scheduleBooking
        : ""
    ).trim();
    if (fromGlobal) {
      return fromGlobal;
    }
    const fromStorage = String(wx.getStorageSync(STORAGE_KEY_SUBSCRIBE_TEMPLATE_ID) || "").trim();
    if (!fromStorage) {
      return "";
    }
    if (this.globalData && this.globalData.subscribeTemplates) {
      this.globalData.subscribeTemplates.scheduleBooking = fromStorage;
    }
    return fromStorage;
  },

  loadSubscribeTemplateConfig(forceRefresh) {
    const force = !!forceRefresh;
    if (!force) {
      const cached = this.getScheduleBookingSubscribeTemplateId();
      if (cached) {
        return Promise.resolve({
          success: true,
          templates: {
            scheduleBooking: cached,
          },
        });
      }
    }

    return this.callQuickstart("getSubscribeTemplateConfig")
      .then((result) => {
        const templates = result && result.templates && typeof result.templates === "object"
          ? result.templates
          : {};
        const scheduleBooking = String(templates.scheduleBooking || "").trim();
        if (!this.globalData.subscribeTemplates) {
          this.globalData.subscribeTemplates = {};
        }
        this.globalData.subscribeTemplates.scheduleBooking = scheduleBooking;
        if (scheduleBooking) {
          wx.setStorageSync(STORAGE_KEY_SUBSCRIBE_TEMPLATE_ID, scheduleBooking);
        }
        return {
          success: !!(result && result.success),
          templates: {
            scheduleBooking,
          },
        };
      })
      .catch(() => ({
        success: false,
        templates: {
          scheduleBooking: "",
        },
      }));
  },

  shouldPromptScheduleBookingSubscribe(force) {
    if (force) {
      return true;
    }
    const acceptedAt = Number(wx.getStorageSync(STORAGE_KEY_SUBSCRIBE_ACCEPTED_AT) || 0);
    if (acceptedAt > 0) {
      return false;
    }
    const promptAt = Number(wx.getStorageSync(STORAGE_KEY_SUBSCRIBE_PROMPT_AT) || 0);
    if (!promptAt) {
      return true;
    }
    return Date.now() - promptAt >= SCHEDULE_BOOKING_SUBSCRIBE_PROMPT_COOLDOWN_MS;
  },

  requestScheduleBookingSubscribe(options) {
    const safeOptions = options && typeof options === "object" ? options : {};
    const force = !!safeOptions.force;
    const silent = !!safeOptions.silent;
    if (!this.canSyncCoachFeatures()) {
      return Promise.resolve({ success: false, reason: "not_coach" });
    }
    if (typeof wx.requestSubscribeMessage !== "function") {
      return Promise.resolve({ success: false, reason: "unsupported" });
    }
    if (!this.shouldPromptScheduleBookingSubscribe(force)) {
      return Promise.resolve({ success: false, reason: "cooldown" });
    }
    if (this.scheduleBookingSubscribeRequesting) {
      return Promise.resolve({ success: false, reason: "requesting" });
    }

    this.scheduleBookingSubscribeRequesting = true;

    return this.loadSubscribeTemplateConfig(force)
      .then((cfg) => {
        const templateId = String(
          cfg && cfg.templates && cfg.templates.scheduleBooking
            ? cfg.templates.scheduleBooking
            : ""
        ).trim();
        if (!templateId) {
          return { success: false, reason: "template_missing" };
        }
        wx.setStorageSync(STORAGE_KEY_SUBSCRIBE_PROMPT_AT, Date.now());
        return new Promise((resolve) => {
          wx.requestSubscribeMessage({
            tmplIds: [templateId],
            success: (res) => {
              const status = String((res && res[templateId]) || "").trim().toLowerCase();
              if (status === "accept") {
                wx.setStorageSync(STORAGE_KEY_SUBSCRIBE_ACCEPTED_AT, Date.now());
                if (!silent) {
                  wx.showToast({ title: "已开启微信提醒", icon: "success" });
                }
                resolve({ success: true, status });
                return;
              }
              resolve({ success: false, reason: status || "rejected" });
            },
            fail: (err) => {
              const text = String((err && err.errMsg) || "").toLowerCase();
              if (!silent && !text.includes("cancel")) {
                wx.showToast({ title: "订阅授权未开启", icon: "none" });
              }
              resolve({ success: false, reason: "request_failed" });
            },
          });
        });
      })
      .finally(() => {
        this.scheduleBookingSubscribeRequesting = false;
      });
  },

  canSyncCoachFeatures() {
    const role = this.resolveRuntimeRole();
    return role === "coach" || role === "admin";
  },

  callQuickstart(type, payload) {
    if (!wx.cloud) {
      return Promise.reject(new Error("cloud_unsupported"));
    }
    const data = payload && typeof payload === "object" ? { ...payload } : {};
    const userId = this.resolveCurrentUserId();
    if (userId && !data.userId) {
      data.userId = userId;
    }
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type,
        ...data,
      },
    }).then((res) => (res && res.result ? res.result : {}));
  },

  getWearableBleConfigFromStorage() {
    const value = wx.getStorageSync(STORAGE_KEY_WEARABLE_BLE_CONFIG);
    if (!value) {
      return {};
    }
    if (typeof value === "object") {
      return value;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (e) {
        return {};
      }
    }
    return {};
  },

  initDeviceSdk() {
    if (!this.globalData) {
      this.globalData = {};
    }
    const createWearableDeviceSdk = getCreateWearableDeviceSdk();
    if (typeof createWearableDeviceSdk !== "function") {
      this.globalData.deviceSdk = null;
      return;
    }
    const fromStorage = this.getWearableBleConfigFromStorage();
    const mergedConfig = {
      transport: "ble",
      parserMode: "json_line",
      expectedRoles: [
        "head",
        "left_elbow",
        "right_elbow",
        "left_wrist",
        "right_wrist",
        "left_knee",
        "right_knee",
        "left_foot",
        "right_foot",
      ],
      collectTimeoutMs: 15000,
      sampleIntervalMs: 50,
      discoveryTimeoutMs: 8000,
      preferSingleHostStream: false,
      notifyServiceUUID: DEFAULT_BLE_NOTIFY_SERVICE_UUID,
      notifyCharacteristicUUID: DEFAULT_BLE_NOTIFY_CHARACTERISTIC_UUID,
      writeServiceUUID: DEFAULT_BLE_NOTIFY_SERVICE_UUID,
      writeCharacteristicUUID: DEFAULT_BLE_NOTIFY_CHARACTERISTIC_UUID,
      requestMtu: true,
      preferredMtu: 247,
      preferredDeviceId: "a0:f2:62:f0:52:e1",
      preferredDeviceIdPrefix: "a0:f2:62:f0:52",
      strictPreferredDevice: true,
      fallbackCandidateCount: 8,
      wifiHost: "",
      wifiPort: 8080,
      wifiPath: "/sensor",
      ...fromStorage,
    };
    if (!String(mergedConfig.notifyServiceUUID || "").trim()) {
      mergedConfig.notifyServiceUUID = DEFAULT_BLE_NOTIFY_SERVICE_UUID;
    }
    mergedConfig.preferSingleHostStream = false;
    mergedConfig.preferredDeviceId = "a0:f2:62:f0:52:e1";
    mergedConfig.preferredDeviceIdPrefix = "a0:f2:62:f0:52";
    mergedConfig.strictPreferredDevice = true;
    if (!String(mergedConfig.notifyCharacteristicUUID || "").trim()) {
      mergedConfig.notifyCharacteristicUUID = DEFAULT_BLE_NOTIFY_CHARACTERISTIC_UUID;
    }
    if (!String(mergedConfig.writeServiceUUID || "").trim()) {
      mergedConfig.writeServiceUUID = DEFAULT_BLE_NOTIFY_SERVICE_UUID;
    }
    if (!String(mergedConfig.writeCharacteristicUUID || "").trim()) {
      mergedConfig.writeCharacteristicUUID = DEFAULT_BLE_NOTIFY_CHARACTERISTIC_UUID;
    }
    if (!String(mergedConfig.wifiPath || "").trim()) {
      mergedConfig.wifiPath = "/sensor";
    }
    this.globalData.wearableBleConfig = mergedConfig;
    this.globalData.deviceSdk = createWearableDeviceSdk(mergedConfig);
  },

  setDeviceTransport(transport, wifiConfig = {}) {
    const createWearableDeviceSdk = getCreateWearableDeviceSdk();
    if (typeof createWearableDeviceSdk !== "function") {
      return;
    }
    const base = this.globalData && this.globalData.wearableBleConfig && typeof this.globalData.wearableBleConfig === "object"
      ? this.globalData.wearableBleConfig
      : {};
    const merged = {
      ...base,
      transport: String(transport || "ble").trim().toLowerCase(),
      wifiHost: String(wifiConfig.host || base.wifiHost || "").trim(),
      wifiPort: Number(wifiConfig.port || base.wifiPort || 8080),
      wifiPath: String(wifiConfig.path || base.wifiPath || "/sensor").trim(),
    };
    wx.setStorageSync(STORAGE_KEY_WEARABLE_BLE_CONFIG, merged);
    this.globalData.wearableBleConfig = merged;
    this.globalData.deviceSdk = createWearableDeviceSdk(merged);
  },

  setWearableBleConfig(config) {
    const createWearableDeviceSdk = getCreateWearableDeviceSdk();
    const safe = config && typeof config === "object" ? config : {};
    const base = this.globalData && this.globalData.wearableBleConfig && typeof this.globalData.wearableBleConfig === "object"
      ? this.globalData.wearableBleConfig
      : {};
    const merged = {
      ...base,
      ...safe,
    };
    const hasConfigChanged = Object.keys(merged).some((key) => String(base[key]) !== String(merged[key]))
      || Object.keys(base).some((key) => !(key in merged));
    wx.setStorageSync(STORAGE_KEY_WEARABLE_BLE_CONFIG, merged);
    if (!this.globalData) {
      this.globalData = {};
    }
    this.globalData.wearableBleConfig = merged;
    if (!hasConfigChanged && this.globalData.deviceSdk) {
      return merged;
    }
    this.globalData.deviceSdk = typeof createWearableDeviceSdk === "function"
      ? createWearableDeviceSdk(merged)
      : null;
    return merged;
  },

  onLaunch() {
    const isDevtools = this.isRunningInDevtools();
    this.isDevtoolsRuntime = isDevtools;

    // 始终保持 globalData 先初始化
    this.globalData = {
      env: "cloud1-1g0419td698cd252",
      subscribeTemplates: {
        scheduleBooking: String(wx.getStorageSync(STORAGE_KEY_SUBSCRIBE_TEMPLATE_ID) || "").trim(),
      },
      wearableBleConfig: isDevtools ? this.getWearableBleConfigFromStorage() : {},
      deviceSdk: null,
    };

    if (isDevtools) {
      this.storageMediaSanitizedOnce = true;
      try {
        wx.setStorageSync(STORAGE_KEY_MEDIA_SANITIZE_VERSION, MEDIA_SANITIZE_VERSION);
      } catch (e) {}
    } else {
      this.sanitizeCachedUserInfo();
      this.storageMediaSanitizedOnce = true;
    }

    // 无论是否 devtools 都初始化云开发
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上基础库以使用云能力");
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true,
    });

    this.initDeviceSdk();
  },

  onShow() {
    if (this.isRunningInDevtools()) return;
    this.sanitizeCachedUserInfo();
  },
});
