const { FEATURE_GATES } = require("./feature-gates");

const resolveDeviceSdk = () => {
  try {
    const app = getApp();
    if (!app || !app.globalData) {
      return null;
    }
    const sdk = app.globalData.deviceSdk;
    return sdk && typeof sdk === "object" ? sdk : null;
  } catch (e) {
    return null;
  }
};

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

const compactFrames = (frames, maxFrames = 120) => {
  const source = Array.isArray(frames) ? frames : [];
  if (!source.length) {
    return [];
  }
  const step = Math.max(1, Math.ceil(source.length / maxFrames));
  const result = [];
  for (let i = 0; i < source.length; i += step) {
    const frame = source[i];
    const safe = frame && typeof frame === "object" ? frame : {};
    const t = Math.round(safe.t || 0);
    const points = {};
    const rawPoints = safe.points && typeof safe.points === "object" ? safe.points : {};
    Object.keys(rawPoints).forEach((role) => {
      const p = rawPoints[role];
      if (p && typeof p === "object") {
        points[role] = {
          ax: round2(p.ax),
          ay: round2(p.ay),
          az: round2(p.az),
          gx: round2(p.gx),
          gy: round2(p.gy),
          gz: round2(p.gz),
        };
      }
    });
    if (Object.keys(points).length) {
      result.push({ t, points });
    }
  }
  return result;
};

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const ROLE_SOURCE_ALIAS = {
  head: ["head", "host", "main", "master", "helmet", "\u4e3b\u673a"],
  left_wrist: ["leftwrist", "left_wrist", "lwrist", "left_hand", "lefthand"],
  right_wrist: ["rightwrist", "right_wrist", "rwrist", "right_hand", "righthand"],
  left_foot: ["leftfoot", "left_foot", "lfoot", "left_ankle", "leftankle"],
  right_foot: ["rightfoot", "right_foot", "rfoot", "right_ankle", "rightankle"],
};

const toNumber = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : (typeof fallback === "number" ? fallback : 0);
};

const normalizeVector = (point) => {
  const safe = point && typeof point === "object" ? point : {};
  return {
    ax: toNumber(safe.ax, 0),
    ay: toNumber(safe.ay, 0),
    az: toNumber(safe.az, 0),
    gx: toNumber(safe.gx, 0),
    gy: toNumber(safe.gy, 0),
    gz: toNumber(safe.gz, 0),
  };
};

const normalizeFrames = (frames) => {
  const list = Array.isArray(frames) ? frames : [];
  return list
    .map((item, index) => {
      const safe = item && typeof item === "object" ? item : {};
      const t = Math.round(toNumber(safe.t || safe.ts || safe.timestamp, index * 50));
      const source = safe.points && typeof safe.points === "object" ? safe.points : {};
      const points = {};
      SENSOR_ROLES.forEach((role) => {
        const direct = source[role];
        if (direct) {
          points[role] = normalizeVector(direct);
          return;
        }
        const aliasList = ROLE_SOURCE_ALIAS[role] || [];
        for (let i = 0; i < aliasList.length; i += 1) {
          const alias = aliasList[i];
          if (source[alias]) {
            points[role] = normalizeVector(source[alias]);
            break;
          }
        }
      });
      return { t, points };
    })
    .filter((item) => item && item.points && Object.keys(item.points).length > 0);
};

const ensureCloudReady = () => {
  if (!wx.cloud) {
    throw new Error("cloud_not_available");
  }
  wx.cloud.init({
    env: getApp().globalData.env,
    traceUser: true,
  });
};

const callSkateActionAnalyze = (data) =>
  wx.cloud.callFunction({
    name: "skateActionAnalyze",
    data,
    config: {
      timeout: 15000,
    },
  }).then((res) => (res && res.result ? res.result : {}));

const ensureSensorComponentEnabled = () => {
  if (FEATURE_GATES.sensorComponentEnabled) {
    return;
  }
  throw new Error("sensor_component_disabled");
};

const analyzeSensorSession = async (payload) => {
  ensureSensorComponentEnabled();
  ensureCloudReady();
  const safe = payload && typeof payload === "object" ? payload : {};
  const transport = String(safe.transport || "mock").trim().toLowerCase();

  let frames = [];
  if (transport === "wifi") {
    const sdk = resolveDeviceSdk();
    if (sdk && typeof sdk.collectFrames === "function") {
      const collected = await sdk.collectFrames({
        frameCount: Number(safe.frameCount || 60),
        timeoutMs: 15000,
      });
      frames = normalizeFrames(collected);
    }
  } else {
    const rawFrames = normalizeFrames(safe.frames);
    frames = compactFrames(rawFrames, 180);
  }

  return callSkateActionAnalyze({
    type: "analyzeSensorSession",
    sessionId: String(safe.sessionId || "").trim(),
    actionType: String(safe.actionType || "sensor_session").trim(),
    note: String(safe.note || "").trim(),
    userId: String(safe.userId || "").trim(),
    allowSinglePointDebug: !!safe.allowSinglePointDebug,
    debugMode: String(safe.debugMode || "").trim(),
    frames,
    transport,
  });
};

const saveSensorTrainingSample = (payload) => {
  ensureSensorComponentEnabled();
  ensureCloudReady();
  const safe = payload && typeof payload === "object" ? payload : {};
  const label = safe.label && typeof safe.label === "object" ? safe.label : {};
  const rawFrames = normalizeFrames(safe.frames);
  const frames = compactFrames(rawFrames, 180);
  return callSkateActionAnalyze({
    type: "saveSensorTrainingSample",
    sessionId: String(safe.sessionId || "").trim(),
    actionType: String(safe.actionType || "sensor_session").trim(),
    sourceType: String(safe.sourceType || "").trim(),
    note: String(safe.note || "").trim(),
    userId: String(safe.userId || "").trim(),
    operatorUserId: String(safe.operatorUserId || "").trim(),
    allowSinglePointDebug: !!safe.allowSinglePointDebug,
    debugMode: String(safe.debugMode || "").trim(),
    label: {
      coachScore: toNumber(label.coachScore, 0),
      qualityTag: String(label.qualityTag || "").trim(),
      coachComment: String(label.coachComment || "").trim(),
      tags: Array.isArray(label.tags) ? label.tags.map((item) => String(item || "").trim()).filter(Boolean) : [],
      selectedSuggestions: Array.isArray(label.selectedSuggestions) ? label.selectedSuggestions.map(n => Number(n)).filter(n => n >= 1 && n <= 8) : [],
    },
    frames,
    calibrationProfiles: safe.calibrationProfiles || {},
  });
};

const listSensorTrainingSamples = (payload) => {
  ensureSensorComponentEnabled();
  ensureCloudReady();
  const safe = payload && typeof payload === "object" ? payload : {};
  return callSkateActionAnalyze({
    type: "listSensorTrainingSamples",
    page: Number(safe.page || 1),
    pageSize: Number(safe.pageSize || 20),
    sourceType: String(safe.sourceType || "").trim(),
    actionType: String(safe.actionType || "").trim(),
    userId: String(safe.userId || "").trim(),
  });
};

const deleteSensorTrainingSample = (payload) => {
  ensureSensorComponentEnabled();
  ensureCloudReady();
  const safe = payload && typeof payload === "object" ? payload : {};
  return callSkateActionAnalyze({
    type: "deleteSensorTrainingSample",
    sampleId: String(safe.sampleId || "").trim(),
    hardDelete: !!safe.hardDelete,
  });
};

module.exports = {
  SENSOR_ROLES,
  normalizeFrames,
  compactFrames,
  analyzeSensorSession,
  saveSensorTrainingSample,
  listSensorTrainingSamples,
  deleteSensorTrainingSample,
};
