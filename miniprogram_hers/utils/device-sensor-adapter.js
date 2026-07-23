const { SENSOR_ROLES, normalizeFrames } = require("./sensor-model");

const MIN_FRAME_COUNT = 24;
const DEFAULT_TIMEOUT_MS = 15000;

const ROLE_ALIAS = {
  "\u4e3b\u673a": "head",
  host: "head",
  main: "head",
  master: "head",
  helmet: "head",
  leftelbow: "left_elbow",
  rightelbow: "right_elbow",
  leftwrist: "left_wrist",
  rightwrist: "right_wrist",
  leftknee: "left_knee",
  rightknee: "right_knee",
  leftfoot: "left_foot",
  rightfoot: "right_foot",
  leftankle: "left_foot",
  rightankle: "right_foot",
};

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const firstDefined = (...values) => {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined && values[i] !== null) {
      return values[i];
    }
  }
  return undefined;
};

const getAppSafe = () => {
  try {
    return getApp();
  } catch (error) {
    return null;
  }
};

const resolveDeviceSdk = () => {
  const app = getAppSafe();
  if (!app || !app.globalData) {
    return null;
  }
  const sdk = app.globalData.deviceSdk;
  return sdk && typeof sdk === "object" ? sdk : null;
};

const normalizeRoleName = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  const normalized = raw.replace(/[\s-]+/g, "_");
  if (SENSOR_ROLES.includes(normalized)) {
    return normalized;
  }
  const compact = normalized.replace(/_/g, "");
  return ROLE_ALIAS[compact] || "";
};

const normalizeSensorVector = (item) => {
  const safe = item && typeof item === "object" ? item : {};
  return {
    ax: toFiniteNumber(firstDefined(safe.ax, safe.accX, safe.acc_x, safe.x)),
    ay: toFiniteNumber(firstDefined(safe.ay, safe.accY, safe.acc_y, safe.y)),
    az: toFiniteNumber(firstDefined(safe.az, safe.accZ, safe.acc_z, safe.z)),
    gx: toFiniteNumber(firstDefined(safe.gx, safe.gyroX, safe.gyro_x, safe.wx)),
    gy: toFiniteNumber(firstDefined(safe.gy, safe.gyroY, safe.gyro_y, safe.wy)),
    gz: toFiniteNumber(firstDefined(safe.gz, safe.gyroZ, safe.gyro_z, safe.wz)),
  };
};

const normalizePointRecords = (points) => {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) {
    return [];
  }

  const grouped = {};
  list.forEach((item, index) => {
    const safe = item && typeof item === "object" ? item : {};
    const role = normalizeRoleName(safe.role || safe.name || safe.deviceRole || safe.id);
    if (!role) {
      return;
    }
    const timestamp = Math.round(
      toFiniteNumber(firstDefined(safe.t, safe.ts, safe.timestamp), Date.now() + index * 50)
    );
    if (!grouped[timestamp]) {
      grouped[timestamp] = {
        t: timestamp,
        points: {},
      };
    }
    grouped[timestamp].points[role] = normalizeSensorVector(safe);
  });

  return Object.keys(grouped).map((key) => grouped[key]);
};

const normalizeSensorFramesPayload = (payload) => {
  if (Array.isArray(payload)) {
    if (payload.some((item) => item && typeof item === "object" && (item.points || item.head || item.left_elbow))) {
      return normalizeFrames(payload);
    }
    return normalizeFrames(normalizePointRecords(payload));
  }

  const safe = payload && typeof payload === "object" ? payload : {};
  if (Array.isArray(safe.frames)) {
    return normalizeFrames(safe.frames);
  }
  if (Array.isArray(safe.sensorFrames)) {
    return normalizeFrames(safe.sensorFrames);
  }
  if (Array.isArray(safe.points)) {
    return normalizeFrames(normalizePointRecords(safe.points));
  }
  return [];
};

const withTimeout = (promise, timeoutMs) => {
  const duration = Math.max(3000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("device_sdk_collect_timeout"));
    }, duration);
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
};

const normalizeErrorText = (error) =>
  String((error && (error.message || error.errMsg || error.msg)) || "")
    .trim()
    .toLowerCase();

const classifyCollectTimeoutError = (sdk, error) => {
  const lower = normalizeErrorText(error);
  if (!lower.includes("device_sdk_collect_timeout")) {
    return error;
  }
  const state = sdk && typeof sdk.getState === "function"
    ? (sdk.getState() || {})
    : {};
  const notifyCount = Number(state.notifyCount || 0);
  const parsedEntryCount = Number(state.parsedEntryCount || 0);
  const lastParsedRoles = Array.isArray(state.lastParsedRoles) ? state.lastParsedRoles : [];
  // If no useful parsed payload arrived before timeout, classify as empty frames for clearer diagnosis.
  if (notifyCount <= 0 || parsedEntryCount <= 0 || !lastParsedRoles.length) {
    return new Error("device_frames_empty");
  }
  return error;
};

const ensureSdkReady = async (sdk) => {
  if (!sdk) {
    throw new Error("device_sdk_not_configured");
  }
  if (typeof sdk.isConnected === "function" && sdk.isConnected()) {
    return;
  }
  if (typeof sdk.collectFrames !== "function") {
    throw new Error("device_sdk_collect_not_implemented");
  }
};

const collectRealDeviceFrames = async (options = {}) => {
  const safe = options && typeof options === "object" ? options : {};
  const frameCount = Math.max(1, Math.floor(toFiniteNumber(safe.frameCount, 60)));
  const timeoutMs = toFiniteNumber(safe.timeoutMs, DEFAULT_TIMEOUT_MS);

  const sdk = resolveDeviceSdk();
  await ensureSdkReady(sdk);
  if (typeof sdk.collectFrames !== "function") {
    throw new Error("device_sdk_collect_not_implemented");
  }

  const payload = {
    ...safe,
    frameCount,
    roles: Array.isArray(safe.roles) && safe.roles.length ? safe.roles : SENSOR_ROLES,
  };

  const runCollect = async (collectPayload, collectTimeoutMs) =>
    withTimeout(
      sdk.collectFrames(collectPayload),
      Math.max(3000, Number(collectTimeoutMs) || DEFAULT_TIMEOUT_MS) + 1200
    );

  let raw = null;
  try {
    raw = await runCollect(payload, timeoutMs);
  } catch (firstError) {
    const firstText = normalizeErrorText(firstError);
    const canRetry = firstText.includes("device_sdk_collect_timeout")
      || firstText.includes("device_frames_empty")
      || firstText.includes("device_frames_too_few");
    if (!canRetry) {
      throw firstError;
    }
    const retryTimeoutMs = Math.max(45000, timeoutMs + 15000);
    const retryPayload = {
      ...payload,
      timeoutMs: retryTimeoutMs,
      // Keep requested frame target on retry (for example 500 frames), only enforcing minimum.
      frameCount: Math.max(MIN_FRAME_COUNT, frameCount),
    };
    try {
      raw = await runCollect(retryPayload, retryTimeoutMs);
    } catch (retryError) {
      throw classifyCollectTimeoutError(sdk, retryError);
    }
  }

  const frames = normalizeSensorFramesPayload(raw);

  if (!frames.length) {
    throw new Error("device_frames_empty");
  }
  if (frames.length < MIN_FRAME_COUNT) {
    throw new Error("device_frames_too_few");
  }
  if (frames.length <= frameCount) {
    return frames;
  }
  return frames.slice(0, frameCount);
};

module.exports = {
  collectRealDeviceFrames,
  normalizeSensorFramesPayload,
  resolveDeviceSdk,
};
