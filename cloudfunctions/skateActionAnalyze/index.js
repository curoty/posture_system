const cloud = require("wx-server-sdk");
const mysql = require("mysql2/promise");
const http = require("http");
const https = require("https");
const { URL } = require("url");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
let mysqlPool = null;
const getMysqlPool = () => {
  if (mysqlPool) return mysqlPool;
  const url = String(process.env.MYSQL_URL || "").trim();
  const user = String(process.env.MYSQL_USER || "").trim();
  const password = String(process.env.MYSQL_PASSWORD || "");
  if (!url && (!user || !password)) {
    const error = new Error("MYSQL_USER or MYSQL_PASSWORD is not configured");
    error.code = "MYSQL_CONFIG_MISSING";
    throw error;
  }
  mysqlPool = url
    ? mysql.createPool(url)
    : mysql.createPool({
        host: String(process.env.MYSQL_HOST || "172.17.0.12").trim(),
        port: Number(process.env.MYSQL_PORT || 3306),
        user,
        password,
        database: String(
          process.env.MYSQL_DATABASE || "cloud1-1g0419td698cd252",
        ).trim(),
        charset: "utf8mb4",
        connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 5000),
        enableKeepAlive: true,
        waitForConnections: true,
        connectionLimit: 4,
        queueLimit: 0,
      });
  return mysqlPool;
};
const runSQL = async (statement, params = {}) => {
  const values = [];
  const sql = String(statement).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    values.push(Object.prototype.hasOwnProperty.call(params, key) ? params[key] : null);
    return "?";
  });
  const [result] = await getMysqlPool().execute(sql, values);
  return {
    data: {
      executeResultList: Array.isArray(result) ? result : [],
      total: Array.isArray(result) ? result.length : Number(result.affectedRows || 0),
    },
  };
};
const sqlModels = { $runSQL: runSQL };
const RECORD_COLLECTION = "skate_action_analysis_records";
const USER_COLLECTION = "users";
// 原始硬件采集样本：当前阶段只保存未经 Python 软件滤波的 IMU 数据。
// 后续软件滤波样本使用独立的 train_samples_filtering 集合。
const SENSOR_TRAINING_COLLECTION = "train_samples_nofiltering";
const SENSOR_FILTERING_COLLECTION = "train_samples_filtering";
const STATIC_SAMPLE_NOFILTERING_COLLECTION = "static_sample_nofiltering";

const sqlRows = (result) => {
  const data = result && result.data ? result.data : {};
  return Array.isArray(data.executeResultList) ? data.executeResultList : [];
};

const createSqlId = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
const SENSOR_POINT_ROLES = [
  "head",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_knee",
  "right_knee",
  "waist",
  "left_foot",
  "right_foot",
];
const ROLE_NUMERIC_ID_BY_NAME = {
  head: 0,
  left_elbow: 1,
  right_elbow: 2,
  left_wrist: 3,
  right_wrist: 4,
  left_knee: 5,
  right_knee: 6,
  waist: 9,
  left_foot: 7,
  right_foot: 8,
};
const SENSOR_MIN_FRAME_COUNT = 24;
const SENSOR_MAX_STORED_FRAME_COUNT = 600;
const SENSOR_MIN_ACTIVE_ROLES_DEFAULT = 1;
const METRIC_TEMPLATE = [
  { key: "balance", name: "\u91cd\u5fc3\u5e73\u8861" },
  { key: "stability", name: "\u52a8\u4f5c\u7a33\u5b9a" },
  { key: "posture", name: "\u59ff\u6001\u63a7\u5236" },
  { key: "legDrive", name: "\u8e6c\u4f38\u53d1\u529b" },
  { key: "rhythm", name: "\u8282\u594f\u8fde\u8d2f" },
];
const METRIC_KEY_ALIAS = {
  balance: "balance",
  center: "balance",
  gravity: "balance",
  stability: "stability",
  steady: "stability",
  posture: "posture",
  form: "posture",
  legdrive: "legDrive",
  drive: "legDrive",
  power: "legDrive",
  rhythm: "rhythm",
  tempo: "rhythm",
};
const METRIC_ADVICE = {
  balance:
    "\u7ec3\u4e60\u5355\u811a\u6ed1\u884c + \u91cd\u5fc3\u8f6c\u79fb\uff0c\u6bcf\u7ec4 30 \u79d2 x 4 \u7ec4",
  stability:
    "\u964d\u901f\u77ed\u7ec4\u8fde\u7eed\u6ed1\u884c\uff0c\u53ea\u8ffd\u6c42\u7a33\u5b9a\u4e0d\u8ffd\u6c42\u901f\u5ea6",
  posture:
    "\u68c0\u67e5\u8eaf\u5e72\u4e0e\u819d\u5173\u8282\u5c48\u4f38\u89d2\u5ea6\uff0c\u4fdd\u6301\u89c6\u7ebf\u524d\u65b9",
  legDrive:
    "\u52a0\u5165\u4fa7\u5411\u8e6c\u4f38 + \u56de\u6536\u4e13\u9879\uff0c\u5f3a\u5316\u4e0b\u80a2\u53d1\u529b",
  rhythm:
    "\u914d\u5408\u6bcf\u5206\u949f70-90\u4e0b\u8282\u62cd\u8bad\u7ec3\uff08\u8ddf\u62cd\u7ec3\u4e60\uff09\uff0c\u4f18\u5148\u4fdd\u6301\u8282\u594f\u5747\u5300",
};
const ACTION_TYPE_LABELS = {
  sensor_session: "\u4f20\u611f\u5668\u4f1a\u8bdd",
  basic_skating: "\u57fa\u7840\u6ed1\u884c",
  curve_skating: "\u8f6c\u5f2f\u6ed1\u884c",
  weight_shift: "\u91cd\u5fc3\u8f6c\u79fb",
  side_push_recover: "\u4fa7\u8e6c\u6536\u817f",
  braking: "\u5239\u505c\u52a8\u4f5c",
};

const clamp = (num, min, max) => Math.max(min, Math.min(max, num));

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
};

const toFiniteNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
};

const average = (list) => {
  const source = Array.isArray(list)
    ? list.filter((item) => Number.isFinite(item))
    : [];
  if (!source.length) {
    return 0;
  }
  return source.reduce((sum, item) => sum + item, 0) / source.length;
};

const stddev = (list) => {
  const source = Array.isArray(list)
    ? list.filter((item) => Number.isFinite(item))
    : [];
  if (!source.length) {
    return 0;
  }
  const mean = average(source);
  const variance =
    source.reduce((sum, item) => {
      const diff = item - mean;
      return sum + diff * diff;
    }, 0) / source.length;
  return Math.sqrt(Math.max(variance, 0));
};

const roundTo = (value, digits = 3) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  const factor = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round(num * factor) / factor;
};

const normalizeSensorVector = (value) => {
  const safe = value && typeof value === "object" ? value : {};
  const ax = toFiniteNumber(safe.ax ?? safe.accX ?? safe.acc_x ?? safe.x ?? 0);
  const ay = toFiniteNumber(safe.ay ?? safe.accY ?? safe.acc_y ?? safe.y ?? 0);
  const az = toFiniteNumber(safe.az ?? safe.accZ ?? safe.acc_z ?? safe.z ?? 0);
  const gx = toFiniteNumber(
    safe.gx ?? safe.gyroX ?? safe.gyro_x ?? safe.wx ?? 0,
  );
  const gy = toFiniteNumber(
    safe.gy ?? safe.gyroY ?? safe.gyro_y ?? safe.wy ?? 0,
  );
  const gz = toFiniteNumber(
    safe.gz ?? safe.gyroZ ?? safe.gyro_z ?? safe.wz ?? 0,
  );
  const values = [ax, ay, az, gx, gy, gz].map((item) =>
    Number.isFinite(item) ? item : 0,
  );
  return {
    ax: values[0],
    ay: values[1],
    az: values[2],
    gx: values[3],
    gy: values[4],
    gz: values[5],
  };
};

const isLikelyNodeIdNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return false;
  }
  const rounded = Math.round(num);
  return Math.abs(num - rounded) < 1e-6 && rounded >= 0 && rounded <= 8;
};

const sanitizeSensorVectorByRole = (point, role) => {
  const vector = normalizeSensorVector(point);
  const safeRole = normalizeRoleName(role);
  const roleNodeId = ROLE_NUMERIC_ID_BY_NAME[safeRole];
  if (!Number.isFinite(roleNodeId)) {
    return vector;
  }
  const values = [
    vector.ax,
    vector.ay,
    vector.az,
    vector.gx,
    vector.gy,
    vector.gz,
  ];
  const nonZero = values.filter((item) => Math.abs(toNumber(item, 0)) >= 1e-6);
  // Drop firmware role-id leak pattern: only one non-zero axis and it equals role numeric id.
  if (
    nonZero.length === 1 &&
    isLikelyNodeIdNumber(nonZero[0]) &&
    Math.round(nonZero[0]) === roleNodeId
  ) {
    return normalizeSensorVector({});
  }
  return vector;
};

const isMeaningfulSensorPoint = (point) => {
  const safe = point && typeof point === "object" ? point : null;
  if (!safe) {
    return false;
  }
  const vector = normalizeSensorVector(safe);
  return [vector.ax, vector.ay, vector.az, vector.gx, vector.gy, vector.gz]
    .some((value) => Number.isFinite(value) && Math.abs(value) > 1e-6);
};

const normalizeRoleName = (value) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "";
  }
  const normalized = raw.replace(/[\s-]+/g, "_");
  const alias = {
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
    waist: "waist",
    body: "waist",
    torso: "waist",
    hip: "waist",
    lumbar: "waist",
    core: "waist",
    腰部: "waist",
    leftfoot: "left_foot",
    rightfoot: "right_foot",
    leftankle: "left_foot",
    rightankle: "right_foot",
  };
  if (SENSOR_POINT_ROLES.includes(normalized)) {
    return normalized;
  }
  const packed = normalized.replace(/_/g, "");
  return alias[packed] || "";
};

const normalizeSensorSourceType = (value) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "mock";
  }
  if (
    raw === "real_device" ||
    raw === "real" ||
    raw === "device" ||
    raw === "hardware"
  ) {
    return "real_device";
  }
  return "mock";
};

const normalizeUserRole = (value) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (
    raw === "admin" ||
    raw === "administrator" ||
    raw === "\u7ba1\u7406\u5458" ||
    raw === "\u7ba1\u7406\u54e1"
  ) {
    return "admin";
  }
  if (raw === "coach" || raw === "\u6559\u7ec3" || raw === "\u6559\u7df4") {
    return "coach";
  }
  if (raw === "student" || raw === "\u5b66\u5458" || raw === "\u5b78\u54e1") {
    return "student";
  }
  return raw;
};

const normalizeCoachLevelValue = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric);
  }
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const alias = {
    assistant: 1,
    junior: 2,
    primary: 2,
    intermediate: 3,
    middle: 3,
    senior: 4,
    "\u52a9\u7406\u6559\u7ec3": 1,
    "\u521d\u7ea7\u6559\u7ec3\u5458": 2,
    "\u4e2d\u7ea7\u6559\u7ec3\u5458": 3,
    "\u9ad8\u7ea7\u6559\u7ec3\u5458": 4,
    "\u521d\u7d1a\u6559\u7df4\u54e1": 2,
    "\u4e2d\u7d1a\u6559\u7df4\u54e1": 3,
    "\u9ad8\u7d1a\u6559\u7df4\u54e1": 4,
  };
  return alias[raw] || 0;
};

const toPositiveInt = (value, fallback, min, max) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return clamp(Math.floor(num), min, max);
};

const toBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const isSinglePointDebugEnabled = (event = {}) => {
  const safe = event && typeof event === "object" ? event : {};
  const mode = String(safe.debugMode || safe.mode || "")
    .trim()
    .toLowerCase();
  if (
    mode === "single_point" ||
    mode === "singlepoint" ||
    mode === "single-point"
  ) {
    return true;
  }
  if (toBoolean(safe.allowSinglePointDebug)) {
    return true;
  }
  const debugOptions =
    safe.debugOptions && typeof safe.debugOptions === "object"
      ? safe.debugOptions
      : {};
  return toBoolean(debugOptions.allowSinglePointDebug);
};

const resolveSensorCallerProfile = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";
  if (!openid) {
    return { success: false, message: "operator_openid_required", openid: "" };
  }

  let operator = null;
  try {
    const result = await sqlModels.$runSQL(
      "SELECT `_id`, `_openid`, role, level, name, nick_name AS nickName, status " +
        "FROM `users` WHERE `_openid` = {{openid}} LIMIT 1",
      { openid },
    );
    operator = sqlRows(result)[0] || null;
  } catch (error) {
    console.error("mysql user lookup failed", error);
    return { success: false, message: "mysql_user_lookup_failed", openid };
  }
  const role = normalizeUserRole(operator && operator.role);
  const level = normalizeCoachLevelValue(operator && operator.level);

  return {
    success: true,
    openid,
    operator,
    role,
    level,
    isAdmin: role === "admin",
    isSeniorCoach: role === "coach",
  };
};

// Static raw samples are stored in the document database and only need a
// verified WeChat caller identity. Do not make that write path depend on the
// unrelated MySQL users table being reachable.
const resolveStaticCaptureCaller = () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";
  if (!openid) {
    return { success: false, message: "operator_openid_required", openid: "" };
  }
  return { success: true, openid };
};

const resolveSensorOperatorProfile = async () => {
  const profile = await resolveSensorCallerProfile();
  if (!profile.success) {
    return profile;
  }

  const { openid, operator, role, level, isAdmin, isSeniorCoach } = profile;
  if (!operator || !operator._id) {
    return { success: false, message: "operator_user_not_found", openid };
  }
  // DEBUG: temporarily allow all roles to save samples
  // if (!isAdmin && !isSeniorCoach) {
  //   return {
  //     success: false,
  //     message: "permission_denied",
  //     openid,
  //     operator,
  //     role,
  //     level,
  //   };
  // }

  return {
    success: true,
    openid,
    operator,
    role,
    level,
    isAdmin,
    isSeniorCoach,
  };
};

const resolveSensorActiveRoles = (event = {}) => {
  const safe = event && typeof event === "object" ? event : {};
  const source = Array.isArray(safe.activeRoles)
    ? safe.activeRoles
    : Array.isArray(safe.keepRoles)
      ? safe.keepRoles
      : Array.isArray(safe.selectedNodes)
        ? safe.selectedNodes
        : Array.isArray(safe.roles)
          ? safe.roles
          : [];
  const picked = [];
  source.forEach((item) => {
    const role = normalizeRoleName(item);
    if (role && !picked.includes(role)) {
      picked.push(role);
    }
  });
  return picked.length ? picked : SENSOR_POINT_ROLES.slice();
};

const filterSensorFramesByRoles = (frames, activeRoles) => {
  const allowed = Array.isArray(activeRoles) && activeRoles.length
    ? activeRoles
    : SENSOR_POINT_ROLES;
  return (Array.isArray(frames) ? frames : [])
    .map((frame) => {
      const safe = frame && typeof frame === "object" ? frame : {};
      const points =
        safe.points && typeof safe.points === "object" ? safe.points : {};
      const filteredPoints = {};
      allowed.forEach((role) => {
        if (points[role]) {
          filteredPoints[role] = points[role];
        }
      });
      return {
        ...safe,
        points: filteredPoints,
      };
    })
    .filter(
      (frame) => frame && frame.points && Object.keys(frame.points).length > 0,
    );
};

const normalizeSensorFrames = (event = {}) => {
  const directFrames = Array.isArray(event.frames)
    ? event.frames
    : Array.isArray(event.sensorFrames)
      ? event.sensorFrames
      : [];
  let sourceFrames = [];

  if (directFrames.length) {
    sourceFrames = directFrames.map((item, index) => {
      const safe = item && typeof item === "object" ? item : {};
      const timestamp = toFiniteNumber(
        safe.t ?? safe.ts ?? safe.timestamp ?? index * 50,
      );
      const points = {};
      const pointSource =
        safe.points && typeof safe.points === "object" ? safe.points : safe;
      if (pointSource && typeof pointSource === "object") {
        Object.keys(pointSource).forEach((rawRole) => {
          const mappedRole = normalizeRoleName(rawRole);
          if (!mappedRole || !pointSource[rawRole]) {
            return;
          }
          const vector = sanitizeSensorVectorByRole(
            pointSource[rawRole],
            mappedRole,
          );
          points[mappedRole] = vector;
        });
        SENSOR_POINT_ROLES.forEach((role) => {
          if (!points[role] && pointSource[role]) {
            const vector = sanitizeSensorVectorByRole(pointSource[role], role);
            points[role] = vector;
          }
        });
      }
      return {
        t: Number.isFinite(timestamp) ? Math.round(timestamp) : index * 50,
        points,
      };
    });
  } else if (Array.isArray(event.points)) {
    const grouped = {};
    event.points.forEach((item, index) => {
      const safe = item && typeof item === "object" ? item : {};
      const role = normalizeRoleName(
        safe.role || safe.name || safe.deviceRole || safe.id,
      );
      if (!role) {
        return;
      }
      const timestamp = toFiniteNumber(
        safe.t ?? safe.ts ?? safe.timestamp ?? index * 50,
      );
      const t = Number.isFinite(timestamp) ? Math.round(timestamp) : index * 50;
      if (!grouped[t]) {
        grouped[t] = { t, points: {} };
      }
      const vector = sanitizeSensorVectorByRole(safe, role);
      grouped[t].points[role] = vector;
    });
    sourceFrames = Object.keys(grouped).map((key) => grouped[key]);
  }

  return sourceFrames
    .filter(
      (frame) => frame && frame.points && Object.keys(frame.points).length > 0,
    )
    .sort((a, b) => toNumber(a.t, 0) - toNumber(b.t, 0));
};

const findMissingSensorRoles = (frames, expectedRoles = SENSOR_POINT_ROLES) => {
  const seen = {};
  expectedRoles.forEach((role) => {
    seen[role] = false;
  });
  (Array.isArray(frames) ? frames : []).forEach((frame) => {
    const points = frame && frame.points ? frame.points : {};
    expectedRoles.forEach((role) => {
      if (isMeaningfulSensorPoint(points[role])) {
        seen[role] = true;
      }
    });
  });
  return expectedRoles.filter((role) => !seen[role]);
};

const summarizeSensorFrameRoles = (frames, expectedRoles = SENSOR_POINT_ROLES) => {
  const list = Array.isArray(frames) ? frames : [];
  const roleCounts = {};
  expectedRoles.forEach((role) => {
    roleCounts[role] = 0;
  });
  list.forEach((frame) => {
    const points =
      frame && frame.points && typeof frame.points === "object"
        ? frame.points
        : {};
    expectedRoles.forEach((role) => {
      if (isMeaningfulSensorPoint(points[role])) {
        roleCounts[role] += 1;
      }
    });
  });
  const activeRoles = expectedRoles.filter((role) => roleCounts[role] > 0);
  return {
    frameCount: list.length,
    expectedRoles,
    activeRoles,
    roleCounts,
  };
};

const resolveSensorMinActiveRoles = (
  event = {},
  activeRoles = SENSOR_POINT_ROLES,
) => {
  const safe = event && typeof event === "object" ? event : {};
  const debugOptions =
    safe.debugOptions && typeof safe.debugOptions === "object"
      ? safe.debugOptions
      : {};
  const rawValue =
    safe.minActiveRoles ??
    safe.minValidNodesPerWindow ??
    safe.minValidNodes ??
    debugOptions.minActiveRoles;
  return toPositiveInt(
    rawValue,
    Math.max(SENSOR_MIN_ACTIVE_ROLES_DEFAULT, activeRoles.length || 1),
    1,
    activeRoles.length || SENSOR_POINT_ROLES.length,
  );
};

const computeSeriesByRole = (frames, role) =>
  (Array.isArray(frames) ? frames : [])
    .map((frame) => {
      const point = frame && frame.points ? frame.points[role] : null;
      if (!isMeaningfulSensorPoint(point)) {
        return null;
      }
      const ax = toNumber(point.ax, 0);
      const ay = toNumber(point.ay, 0);
      const az = toNumber(point.az, 0);
      const gx = toNumber(point.gx, 0);
      const gy = toNumber(point.gy, 0);
      const gz = toNumber(point.gz, 0);
      const accMag = Math.sqrt(ax * ax + ay * ay + az * az);
      const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const pitch =
        Math.atan2(ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
      return {
        t: toNumber(frame.t, 0),
        accMag,
        gyroMag,
        pitch,
      };
    })
    .filter(Boolean);

const computeCadenceStats = (frames) => {
  const kneeSignal = (Array.isArray(frames) ? frames : [])
    .map((frame) => {
      const left = frame && frame.points ? frame.points.left_knee : null;
      const right = frame && frame.points ? frame.points.right_knee : null;
      if (!left && !right) {
        return null;
      }
      const lMag = left
        ? Math.sqrt(
            toNumber(left.gx, 0) ** 2 +
              toNumber(left.gy, 0) ** 2 +
              toNumber(left.gz, 0) ** 2,
          )
        : NaN;
      const rMag = right
        ? Math.sqrt(
            toNumber(right.gx, 0) ** 2 +
              toNumber(right.gy, 0) ** 2 +
              toNumber(right.gz, 0) ** 2,
          )
        : NaN;
      const value =
        Number.isFinite(lMag) && Number.isFinite(rMag)
          ? (lMag + rMag) / 2
          : Number.isFinite(lMag)
            ? lMag
            : rMag;
      return {
        t: toNumber(frame.t, 0),
        v: toNumber(value, 0),
      };
    })
    .filter(Boolean);

  if (kneeSignal.length < 8) {
    return { cadence: 0, cadenceCv: 0, peakCount: 0 };
  }

  const values = kneeSignal.map((item) => item.v);
  const mean = average(values);
  const std = stddev(values);
  const threshold = mean + std * 0.35;
  const peakTimes = [];

  for (let i = 1; i < kneeSignal.length - 1; i += 1) {
    const prev = kneeSignal[i - 1];
    const current = kneeSignal[i];
    const next = kneeSignal[i + 1];
    if (
      current.v >= threshold &&
      current.v > prev.v &&
      current.v >= next.v &&
      (peakTimes.length === 0 ||
        current.t - peakTimes[peakTimes.length - 1] >= 260)
    ) {
      peakTimes.push(current.t);
    }
  }

  if (peakTimes.length < 2) {
    return { cadence: 0, cadenceCv: 0, peakCount: peakTimes.length };
  }

  const intervals = [];
  for (let i = 1; i < peakTimes.length; i += 1) {
    const gap = peakTimes[i] - peakTimes[i - 1];
    if (gap > 120 && gap < 2500) {
      intervals.push(gap);
    }
  }
  if (!intervals.length) {
    return { cadence: 0, cadenceCv: 0, peakCount: peakTimes.length };
  }

  const avgGap = average(intervals);
  const cadence = avgGap > 0 ? 60000 / avgGap : 0;
  const cadenceCv = avgGap > 0 ? stddev(intervals) / avgGap : 0;
  return {
    cadence: roundTo(cadence, 2),
    cadenceCv: roundTo(cadenceCv, 4),
    peakCount: peakTimes.length,
  };
};

const computeSensorFeatures = (frames) => {
  const roleSeries = {};
  SENSOR_POINT_ROLES.forEach((role) => {
    roleSeries[role] = computeSeriesByRole(frames, role);
  });
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const firstTs = frameCount ? toNumber(frames[0].t, 0) : 0;
  const lastTs = frameCount ? toNumber(frames[frameCount - 1].t, 0) : 0;
  const durationMs = Math.max(0, lastTs - firstTs);

  const coverage = {};
  SENSOR_POINT_ROLES.forEach((role) => {
    coverage[role] =
      frameCount > 0
        ? roundTo((roleSeries[role].length / frameCount) * 100, 2)
        : 0;
  });
  const coverageMin = Math.min(
    ...SENSOR_POINT_ROLES.map((role) => coverage[role] || 0),
  );

  const headSeries = roleSeries.head;
  const leftKneeSeries = roleSeries.left_knee;
  const rightKneeSeries = roleSeries.right_knee;
  const leftElbowSeries = roleSeries.left_elbow;
  const rightElbowSeries = roleSeries.right_elbow;

  const headAccStd = stddev(headSeries.map((item) => item.accMag));
  const headGyroMean = average(headSeries.map((item) => item.gyroMag));
  const headGyroStd = stddev(headSeries.map((item) => item.gyroMag));
  const headPitchMean = average(headSeries.map((item) => item.pitch));
  const headPitchStd = stddev(headSeries.map((item) => item.pitch));

  const leftKneeGyroMean = average(leftKneeSeries.map((item) => item.gyroMag));
  const rightKneeGyroMean = average(
    rightKneeSeries.map((item) => item.gyroMag),
  );
  const leftElbowGyroMean = average(
    leftElbowSeries.map((item) => item.gyroMag),
  );
  const rightElbowGyroMean = average(
    rightElbowSeries.map((item) => item.gyroMag),
  );
  const kneeGyroMean = average([leftKneeGyroMean, rightKneeGyroMean]);
  const kneeSymDiff = Math.abs(leftKneeGyroMean - rightKneeGyroMean);
  const elbowSymDiff = Math.abs(leftElbowGyroMean - rightElbowGyroMean);

  const cadenceStats = computeCadenceStats(frames);

  return {
    frameCount,
    durationMs,
    coverage,
    coverageMin,
    headAccStd,
    headGyroMean,
    headGyroStd,
    headPitchMean,
    headPitchStd,
    kneeGyroMean,
    kneeSymDiff,
    elbowSymDiff,
    cadence: cadenceStats.cadence,
    cadenceCv: cadenceStats.cadenceCv,
    cadencePeakCount: cadenceStats.peakCount,
  };
};

const buildSensorMetrics = (features) => {
  const balanceScore = clamp(
    Math.round(
      92 -
        features.headAccStd * 14 -
        features.headPitchStd * 0.9 -
        features.kneeSymDiff * 1.6,
    ),
    40,
    98,
  );
  const stabilityScore = clamp(
    Math.round(
      91 -
        features.headGyroStd * 10 -
        features.headGyroMean * 4 -
        (100 - features.coverageMin) * 0.25,
    ),
    35,
    98,
  );
  const postureScore = clamp(
    Math.round(
      88 -
        Math.abs(features.headPitchMean - 12) * 1.1 -
        features.headPitchStd * 0.8,
    ),
    35,
    98,
  );
  const legDriveScore = clamp(
    Math.round(62 + features.kneeGyroMean * 7 - features.kneeSymDiff * 4),
    30,
    98,
  );
  const cadencePenalty =
    features.cadence > 0 ? Math.abs(features.cadence - 78) * 0.25 : 14;
  let rhythmScore = clamp(
    Math.round(
      86 - cadencePenalty - features.cadenceCv * 35 - features.elbowSymDiff * 3,
    ),
    25,
    98,
  );
  if (features.cadence <= 0 || features.cadencePeakCount < 2) {
    rhythmScore = Math.min(rhythmScore, 58);
  }

  const metricMap = {
    balance: balanceScore,
    stability: stabilityScore,
    posture: postureScore,
    legDrive: legDriveScore,
    rhythm: rhythmScore,
  };
  return METRIC_TEMPLATE.map((item) => ({
    key: item.key,
    name: item.name,
    score: metricMap[item.key],
  }));
};

const buildSensorSessionQuality = (features) => {
  const durationScore =
    features.durationMs >= 8000
      ? 100
      : clamp(Math.round((features.durationMs / 8000) * 100), 0, 100);
  const frameScore =
    features.frameCount >= 120
      ? 100
      : clamp(Math.round((features.frameCount / 120) * 100), 0, 100);
  const coverageScore = clamp(Math.round(features.coverageMin), 0, 100);
  const score = clamp(
    Math.round(durationScore * 0.35 + frameScore * 0.35 + coverageScore * 0.3),
    0,
    100,
  );

  const issues = [];
  if (features.frameCount < SENSOR_MIN_FRAME_COUNT) {
    issues.push("frame_count_low");
  }
  if (features.durationMs < 6000) {
    issues.push("session_too_short");
  }
  if (features.coverageMin < 70) {
    issues.push("point_coverage_low");
  }

  return {
    score,
    issues,
    recommendation: issues.length
      ? "Collect at least 8s stable session and keep all nine nodes connected."
      : "Sensor session quality is good for baseline model training.",
  };
};

const isCollectionNotExistError = (error) => {
  const message = String((error && error.message) || "").toLowerCase();
  return (
    message.includes("database_collection_not_exist") ||
    message.includes("database collection not exist") ||
    message.includes("collection not exist")
  );
};

const addDocWithAutoCreateCollection = async (collectionName, data) => {
  try {
    return await db.collection(collectionName).add({ data });
  } catch (error) {
    if (!isCollectionNotExistError(error)) {
      throw error;
    }
    if (typeof db.createCollection !== "function") {
      throw error;
    }
    try {
      await db.createCollection(collectionName);
    } catch (createError) {
      const msg = String(
        (createError && createError.message) || "",
      ).toLowerCase();
      const existed =
        msg.includes("already") ||
        msg.includes("exist") ||
        msg.includes("database_collection_exist");
      if (!existed) {
        throw createError;
      }
    }
    return db.collection(collectionName).add({ data });
  }
};

const compactSensorFrames = (
  frames,
  maxFrames = SENSOR_MAX_STORED_FRAME_COUNT,
  options = {},
) => {
  const source = Array.isArray(frames) ? frames : [];
  if (!source.length) {
    return [];
  }
  const preserveTimestampPrecision = !!(
    options && options.preserveTimestampPrecision
  );
  const step = Math.max(1, Math.ceil(source.length / Math.max(1, maxFrames)));
  const result = [];
  for (let i = 0; i < source.length; i += step) {
    const frame = source[i];
    const compactPoints = {};
    SENSOR_POINT_ROLES.forEach((role) => {
      const point = frame && frame.points ? frame.points[role] : null;
      if (!point) {
        return;
      }
      compactPoints[role] = [
        roundTo(point.ax, 3),
        roundTo(point.ay, 3),
        roundTo(point.az, 3),
        roundTo(point.gx, 3),
        roundTo(point.gy, 3),
        roundTo(point.gz, 3),
      ];
    });
    if (Object.keys(compactPoints).length) {
      const rawTs = toNumber(frame && frame.t, i * 50);
      result.push({
        t: preserveTimestampPrecision ? roundTo(rawTs, 3) : Math.round(rawTs),
        p: compactPoints,
      });
    }
  }
  return result;
};

const getSensorRemoteConfig = () => {
  const enabledFlag = String(process.env.SENSOR_API_ENABLED || "")
    .trim()
    .toLowerCase();
  const url = String(process.env.SENSOR_API_URL || "").trim();
  const token = String(process.env.SENSOR_API_TOKEN || "").trim();
  const functionName = String(process.env.SENSOR_API_FUNCTION || "").trim();
  const enabled =
    ["true", "1", "yes", "on"].includes(enabledFlag) ||
    (!enabledFlag && (!!url || !!functionName));
  const timeoutMs = Math.max(
    3000,
    toNumber(process.env.SENSOR_API_TIMEOUT_MS, 15000),
  );
  return { enabled, url, token, functionName, timeoutMs };
};

const getSensorApiStrategy = () => {
  const mode = String(process.env.SENSOR_API_MODE || "")
    .trim()
    .toLowerCase();
  const strictFlag = String(process.env.SENSOR_API_STRICT || "")
    .trim()
    .toLowerCase();
  const strict =
    ["true", "1", "yes", "on"].includes(strictFlag) ||
    mode === "strict" ||
    mode === "api_only" ||
    mode === "remote_only";
  return {
    strict,
    mode: mode || (strict ? "strict" : "fallback"),
  };
};

const maskSecret = (value) => {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }
  if (raw.length <= 6) {
    return `${raw.slice(0, 1)}***${raw.slice(-1)}`;
  }
  return `${raw.slice(0, 3)}***${raw.slice(-2)}`;
};

const debugSensorRemoteConfigHandler = async () => {
  const config = getSensorRemoteConfig();
  const strategy = getSensorApiStrategy();
  return {
    success: true,
    config: {
      enabled: !!config.enabled,
      url: String(config.url || ""),
      timeoutMs: Number(config.timeoutMs || 0),
      functionName: String(config.functionName || ""),
      hasToken: !!String(config.token || "").trim(),
      tokenMasked: maskSecret(config.token),
      strategyMode: strategy.mode,
      strict: !!strategy.strict,
    },
    rawEnv: {
      SENSOR_API_ENABLED: String(process.env.SENSOR_API_ENABLED || ""),
      SENSOR_API_URL: String(process.env.SENSOR_API_URL || ""),
      SENSOR_API_TIMEOUT_MS: String(process.env.SENSOR_API_TIMEOUT_MS || ""),
      SENSOR_API_FUNCTION: String(process.env.SENSOR_API_FUNCTION || ""),
      SENSOR_API_MODE: String(process.env.SENSOR_API_MODE || ""),
      SENSOR_API_STRICT: String(process.env.SENSOR_API_STRICT || ""),
    },
  };
};

const normalizeFramesForRemoteApi = (frames) => {
  const source = Array.isArray(frames) ? frames : [];
  if (!source.length) {
    return [];
  }

  const finiteTs = source
    .map((frame) => toFiniteNumber(frame && frame.t))
    .filter((value) => Number.isFinite(value));
  if (!finiteTs.length) {
    return source;
  }

  const minTs = Math.min(...finiteTs);
  const maxTs = Math.max(...finiteTs);
  const span = Math.max(0, maxTs - minTs);
  const sortedTs = [...finiteTs].sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < sortedTs.length; i += 1) {
    const gap = sortedTs[i] - sortedTs[i - 1];
    if (gap > 0 && Number.isFinite(gap)) {
      diffs.push(gap);
    }
  }
  const avgGap = diffs.length ? average(diffs) : NaN;
  // Remote API expects frame.t in milliseconds.
  // Convert only when timestamp pattern is very likely seconds.
  const likelySeconds =
    maxTs < 1e6 &&
    (span <= 120 || (Number.isFinite(avgGap) && avgGap > 0 && avgGap < 2));
  if (!likelySeconds) {
    return source;
  }

  return source.map((frame, index) => {
    const safe = frame && typeof frame === "object" ? frame : {};
    return {
      ...safe,
      t: Math.round(toNumber(safe.t, index * 0.05) * 1000),
    };
  });
};

const buildPredictContinuousJsonUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch (error) {
    return "";
  }

  const rawPath = String(parsed.pathname || "/").replace(/\/+$/g, "");
  const lowerPath = rawPath.toLowerCase();
  if (lowerPath.endsWith("/predict-continuous-json")) {
    return parsed.toString();
  }

  if (lowerPath.endsWith("/infer")) {
    parsed.pathname = `${rawPath.slice(0, -"/infer".length)}/predict-continuous-json`;
  } else if (!rawPath || rawPath === "/") {
    parsed.pathname = "/predict-continuous-json";
  } else {
    parsed.pathname = `${rawPath}/predict-continuous-json`;
  }
  parsed.search = "";
  return parsed.toString();
};

const buildSensorPredictContinuousPayload = (payload) => {
  const safe = payload && typeof payload === "object" ? payload : {};
  const compactFrames = compactSensorFrames(
    Array.isArray(safe.frames) ? safe.frames : [],
    SENSOR_MAX_STORED_FRAME_COUNT,
    { preserveTimestampPrecision: true },
  );
  return {
    sessionId: String(safe.sessionId || "").trim(),
    frames: compactFrames,
    windowSeconds: 4,
    stepSeconds: 2,
  };
};

const buildSensorHealthUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname
      .replace(/\/(?:infer|predict-continuous-json)\/?$/i, "/health")
      .replace(/\/+$/g, "");
    if (!/\/health$/i.test(parsed.pathname)) {
      parsed.pathname = `${parsed.pathname}/health`.replace(/\/{2,}/g, "/");
    }
    parsed.search = "";
    return parsed.toString();
  } catch (e) {
    return "";
  }
};

const debugSensorApiPingHandler = async () => {
  const config = getSensorRemoteConfig();
  const url = buildSensorHealthUrl(config.url);
  if (!url) {
    return {
      success: false,
      message: "sensor_api_url_invalid",
      url: String(config.url || ""),
    };
  }

  const headers = {};
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  const startedAt = Date.now();
  try {
    const response = await requestJson({
      url,
      method: "GET",
      headers,
      timeoutMs: Math.min(
        Math.max(3000, toNumber(config.timeoutMs, 5000)),
        8000,
      ),
    });
    return {
      success: response.statusCode >= 200 && response.statusCode < 300,
      url,
      statusCode: response.statusCode,
      elapsedMs: Date.now() - startedAt,
      data: response.data,
    };
  } catch (error) {
    return {
      success: false,
      url,
      elapsedMs: Date.now() - startedAt,
      message:
        error && error.message
          ? String(error.message)
          : "sensor_api_ping_failed",
    };
  }
};

const normalizeConfidenceToPercent = (value) => {
  const num = toFiniteNumber(value);
  if (!Number.isFinite(num)) {
    return NaN;
  }
  return num <= 1 ? num * 100 : num;
};

const requestJson = ({
  url,
  method = "POST",
  headers = {},
  body,
  timeoutMs = 15000,
}) =>
  new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error("invalid_api_url"));
      return;
    }

    const normalizedMethod =
      String(method || "POST")
        .trim()
        .toUpperCase() || "POST";
    const shouldWriteBody =
      normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;
    const payload = shouldWriteBody
      ? typeof body === "string"
        ? body
        : JSON.stringify(body || {})
      : "";
    const requestHeaders = {
      ...headers,
    };
    if (shouldWriteBody) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method: normalizedMethod,
        headers: requestHeaders,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data = {};
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (e) {
              data = {
                success: false,
                error: "api_invalid_json",
                message: String(raw).slice(0, 500),
              };
            }
          }
          resolve({
            statusCode: Number(res.statusCode || 0),
            data,
          });
        });
      },
    );

    // Hard timeout: also covers connect/DNS stalls before socket-level timeout fires.
    const hardTimeoutMs = Math.max(1000, toNumber(timeoutMs, 15000));
    const hardTimer = setTimeout(() => {
      req.destroy(new Error("api_timeout"));
    }, hardTimeoutMs);

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("api_timeout"));
    });
    req.on("error", (err) => {
      clearTimeout(hardTimer);
      reject(err);
    });
    req.on("close", () => {
      clearTimeout(hardTimer);
    });
    if (shouldWriteBody) {
      req.write(payload);
    }
    req.end();
  });

const withTimeout = (promise, timeoutMs, errorCode) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        reject(new Error(errorCode || "api_timeout"));
      },
      Math.max(1000, toNumber(timeoutMs, 10000)),
    );
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

const normalizeMetricKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
  return METRIC_KEY_ALIAS[normalized] || "";
};

const normalizeApiMetrics = (value) => {
  const map = {};

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const key = normalizeMetricKey(item.key || item.name || item.id);
      if (!key) {
        return;
      }
      map[key] = clamp(Math.round(toNumber(item.score, 0)), 0, 100);
    });
  } else if (value && typeof value === "object") {
    Object.keys(value).forEach((name) => {
      const key = normalizeMetricKey(name);
      if (!key) {
        return;
      }
      map[key] = clamp(Math.round(toNumber(value[name], 0)), 0, 100);
    });
  }

  const result = METRIC_TEMPLATE.map((item) => ({
    key: item.key,
    name: item.name,
    score: typeof map[item.key] === "number" ? map[item.key] : null,
  }));

  return result.some((item) => typeof item.score === "number") ? result : [];
};

const hashText = (value) => {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 1000003;
  }
  return hash;
};

const buildNoise = (seed, offset = 0) => {
  const value = (seed + offset * 9973) % 1000;
  return (value / 1000) * 2 - 1;
};

const buildTips = (metrics) => {
  const tips = [];
  const byKey = {};
  metrics.forEach((item) => {
    byKey[item.key] = item.score;
  });

  if ((byKey.balance || 0) < 70) {
    tips.push(
      "\u91cd\u5fc3\u63a7\u5236\u504f\u5f31\uff0c\u7ec3\u4e60\u53cc\u81c2\u5e73\u4e3e\u6ed1\u884c\uff0c\u4fdd\u6301\u9acb\u90e8\u7a33\u5b9a\u3002",
    );
  }
  if ((byKey.stability || 0) < 70) {
    tips.push(
      "\u7a33\u5b9a\u6027\u4e0d\u8db3\uff0c\u5efa\u8bae\u964d\u4f4e\u901f\u5ea6\uff0c\u5148\u505a\u77ed\u8ddd\u79bb\u91cd\u590d\u6ed1\u884c\u3002",
    );
  }
  if ((byKey.posture || 0) < 70) {
    tips.push(
      "\u4e0a\u8eab\u59ff\u6001\u9700\u8981\u8c03\u6574\uff0c\u4fdd\u6301\u76ee\u89c6\u524d\u65b9\u3001\u8eaf\u5e72\u5fae\u524d\u503e\u3002",
    );
  }
  if ((byKey.legDrive || 0) < 70) {
    tips.push(
      "\u8e6c\u4f38\u53d1\u529b\u4e0d\u8db3\uff0c\u91cd\u70b9\u7ec3\u4e60\u4fa7\u5411\u8e6c\u4f38\u540e\u7684\u5b8c\u6574\u56de\u6536\u52a8\u4f5c\u3002",
    );
  }
  if ((byKey.rhythm || 0) < 70) {
    tips.push(
      "\u8282\u594f\u4e0d\u7a33\u5b9a\uff0c\u53ef\u8ddf\u62cd\u8282\u62cd\u5668\u8fdb\u884c\u52a8\u4f5c\u5206\u89e3\u7ec3\u4e60\u3002",
    );
  }

  if (!tips.length) {
    tips.push(
      "\u52a8\u4f5c\u6574\u4f53\u826f\u597d\uff0c\u5efa\u8bae\u7ee7\u7eed\u63d0\u5347\u901f\u5ea6\u63a7\u5236\u4e0e\u52a8\u4f5c\u6d41\u7545\u5ea6\u3002",
    );
    tips.push(
      "\u4e0b\u4e00\u9636\u6bb5\u53ef\u52a0\u5165\u8fde\u7eed\u53d8\u5411\u548c\u9ad8\u5f3a\u5ea6\u7ec4\u5408\u52a8\u4f5c\u8bad\u7ec3\u3002",
    );
  }

  return tips.slice(0, 4);
};

const buildSummary = (overallScore) => {
  if (overallScore >= 85) {
    return "\u52a8\u4f5c\u8868\u73b0\u4f18\u79c0\uff0c\u6280\u672f\u7a33\u5b9a\u6027\u8f83\u9ad8\uff0c\u53ef\u8fdb\u5165\u8fdb\u9636\u7ec4\u5408\u8bad\u7ec3\u3002";
  }
  if (overallScore >= 75) {
    return "\u52a8\u4f5c\u8868\u73b0\u826f\u597d\uff0c\u4e2a\u522b\u7ec6\u8282\u4ecd\u6709\u4f18\u5316\u7a7a\u95f4\u3002";
  }
  if (overallScore >= 60) {
    return "\u52a8\u4f5c\u57fa\u7840\u5df2\u5177\u5907\uff0c\u5efa\u8bae\u4f18\u5148\u4fee\u6b63\u4f4e\u5206\u9879\u518d\u63d0\u5347\u901f\u5ea6\u3002";
  }
  return "\u52a8\u4f5c\u63a7\u5236\u504f\u5f31\uff0c\u5efa\u8bae\u5148\u8fdb\u884c\u57fa\u7840\u7a33\u5b9a\u6027\u4e0e\u91cd\u5fc3\u8bad\u7ec3\u3002";
};

const scoreLevel = (score) => {
  if (score >= 90) {
    return "优秀";
  }
  if (score >= 75) {
    return "良好";
  }
  if (score >= 60) {
    return "及格";
  }
  return "不及格";
};

const normalizeQualityLevelText = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower === "excellent" || raw === "\u4f18\u79c0") return "\u4f18\u79c0";
  if (lower === "good" || raw === "\u826f\u597d") return "\u826f\u597d";
  if (lower === "mid" || raw === "\u4e2d\u7b49") return "\u4e2d\u7b49";
  if (lower === "fail" || raw === "\u4e0d\u53ca\u683c")
    return "\u4e0d\u53ca\u683c";
  return raw;
};

const scoreToModelLevel = (score) => {
  const safeScore = clamp(Math.round(toNumber(score, 0)), 0, 100);
  if (safeScore >= 90) return "\u4f18\u79c0";
  if (safeScore >= 75) return "\u826f\u597d";
  if (safeScore >= 60) return "\u4e2d\u7b49";
  return "\u4e0d\u53ca\u683c";
};

const normalizeStringList = (value, limit = 4) =>
  Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];

const buildVideoQualityInsight = (videoInfo = {}) => {
  const duration = toNumber(videoInfo.duration);
  const size = toNumber(videoInfo.size);
  const width = toNumber(videoInfo.width);
  const height = toNumber(videoInfo.height);

  const issues = [];
  if (duration > 0 && duration < 4) {
    issues.push("\u89c6\u9891\u65f6\u957f\u504f\u77ed");
  }
  if (duration > 35) {
    issues.push(
      "\u89c6\u9891\u8fc7\u957f\uff0c\u53ef\u80fd\u7a00\u91ca\u5173\u952e\u7247\u6bb5",
    );
  }
  if (size > 0 && size < 180 * 1024) {
    issues.push("\u89c6\u9891\u7801\u7387\u504f\u4f4e");
  }
  if (width > 0 && height > 0 && width < 540 && height < 540) {
    issues.push("\u5206\u8fa8\u7387\u8f83\u4f4e");
  }

  let qualityScore = 88;
  qualityScore -= issues.length * 8;
  qualityScore = clamp(qualityScore, 55, 96);

  return {
    score: qualityScore,
    issues,
    recommendation: issues.length
      ? "\u5efa\u8bae\u4fdd\u6301 8-20 \u79d2\u3001\u6b63\u4fa7\u65b9\u56fa\u5b9a\u89c6\u89d2\u3001\u5145\u8db3\u5149\u7ebf\u540e\u91cd\u62cd\u3002"
      : "\u89c6\u9891\u8d28\u91cf\u826f\u597d\uff0c\u9002\u5408\u7ee7\u7eed\u7ec6\u5316\u8bc4\u4f30\u3002",
  };
};

const buildPhaseScores = (metrics, seed = Date.now()) => {
  const map = {};
  metrics.forEach((item) => {
    map[item.key] = item.score;
  });

  const warmupScore = clamp(
    Math.round(
      map.posture * 0.45 +
        map.balance * 0.35 +
        map.rhythm * 0.2 +
        buildNoise(seed, 21) * 3,
    ),
    40,
    99,
  );
  const executionScore = clamp(
    Math.round(
      map.legDrive * 0.45 +
        map.stability * 0.35 +
        map.balance * 0.2 +
        buildNoise(seed, 22) * 3,
    ),
    40,
    99,
  );
  const recoveryScore = clamp(
    Math.round(
      map.stability * 0.4 +
        map.posture * 0.35 +
        map.rhythm * 0.25 +
        buildNoise(seed, 23) * 3,
    ),
    40,
    99,
  );

  return [
    {
      key: "warmup",
      name: "\u8d77\u52bf\u4e0e\u5165\u52a8",
      score: warmupScore,
      comment:
        warmupScore >= 75
          ? "\u5165\u52a8\u81ea\u7136\uff0c\u91cd\u5fc3\u8f6c\u79fb\u8fde\u8d2f\u3002"
          : "\u5165\u52a8\u504f\u7d27\uff0c\u5efa\u8bae\u5148\u964d\u901f\u5b8c\u6210\u8d77\u52bf\u7a33\u5b9a\u3002",
    },
    {
      key: "execution",
      name: "\u4e3b\u4f53\u52a8\u4f5c\u6267\u884c",
      score: executionScore,
      comment:
        executionScore >= 75
          ? "\u4e3b\u4f53\u6267\u884c\u8f83\u7a33\u5b9a\uff0c\u52a8\u4f5c\u6301\u7eed\u6027\u8f83\u597d\u3002"
          : "\u4e3b\u4f53\u6267\u884c\u671f\u5b58\u5728\u6296\u52a8\u6216\u65ad\u8282\uff0c\u9700\u52a0\u5f3a\u4e13\u9879\u7ec3\u4e60\u3002",
    },
    {
      key: "recovery",
      name: "\u6536\u52bf\u4e0e\u8fde\u8d2f",
      score: recoveryScore,
      comment:
        recoveryScore >= 75
          ? "\u6536\u52bf\u5e73\u987a\uff0c\u8282\u594f\u4fdd\u6301\u8f83\u597d\u3002"
          : "\u6536\u52bf\u6bb5\u8282\u594f\u7565\u4e71\uff0c\u5efa\u8bae\u7528\u6162\u901f\u56de\u6536\u7ec3\u4e60\u5f3a\u5316\u3002",
    },
  ];
};

const buildStrengthWeakness = (metrics) => {
  const sorted = [...metrics].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 2);
  const low = sorted.slice(-2).reverse();

  return {
    strengths: top.map((item) => ({
      key: item.key,
      name: item.name,
      score: item.score,
      note: `\u5728\u300c${item.name}\u300d\u7ef4\u5ea6\u8868\u73b0${scoreLevel(item.score)}\uff0c\u53ef\u4f5c\u4e3a\u6280\u672f\u7ec6\u5316\u57fa\u7840\u3002`,
    })),
    weaknesses: low.map((item) => ({
      key: item.key,
      name: item.name,
      score: item.score,
      note:
        METRIC_ADVICE[item.key] ||
        "\u5efa\u8bae\u8fdb\u884c\u9488\u5bf9\u6027\u5206\u89e3\u7ec3\u4e60\u3002",
    })),
  };
};

const buildRiskAlerts = (metrics) => {
  const map = {};
  metrics.forEach((item) => {
    map[item.key] = item.score;
  });
  const alerts = [];

  if ((map.balance || 0) < 62) {
    alerts.push(
      "\u91cd\u5fc3\u504f\u79fb\u98ce\u9669\u8f83\u9ad8\uff0c\u8fd0\u52a8\u4e2d\u5bb9\u6613\u51fa\u73b0\u8eaf\u5e72\u6447\u6643\u3002",
    );
  }
  if ((map.stability || 0) < 62) {
    alerts.push(
      "\u7a33\u5b9a\u6027\u4e0d\u8db3\uff0c\u5efa\u8bae\u6682\u4e0d\u63d0\u5347\u901f\u5ea6\u6216\u96be\u5ea6\u3002",
    );
  }
  if ((map.posture || 0) < 60) {
    alerts.push(
      "\u59ff\u6001\u63a7\u5236\u4e0d\u8db3\uff0c\u957f\u65f6\u95f4\u8bad\u7ec3\u53ef\u80fd\u589e\u52a0\u5173\u8282\u538b\u529b\u3002",
    );
  }

  return alerts.slice(0, 3);
};

const getActionTypeLabel = (actionType) => {
  const raw = String(actionType || "").trim();
  if (!raw) {
    return "\u7efc\u5408\u52a8\u4f5c";
  }
  return ACTION_TYPE_LABELS[raw] || raw;
};

const buildTrainingPlan = ({ actionType, metrics }) => {
  const map = {};
  metrics.forEach((item) => {
    map[item.key] = item.score;
  });
  const weakestKey =
    Object.keys(map).sort((a, b) => (map[a] || 0) - (map[b] || 0))[0] ||
    "balance";
  const weakestAdvice =
    METRIC_ADVICE[weakestKey] ||
    "\u5206\u89e3\u7ec3\u4e60\u5f31\u9879\u6280\u672f";
  const actionLabel = getActionTypeLabel(actionType);

  return [
    {
      day: "\u7b2c1\u5929",
      focus: `${actionLabel}\u57fa\u7840\u7a33\u5b9a`,
      duration: "20-25\u5206\u949f",
      tasks: [
        "\u70ed\u8eab 5 \u5206\u949f\uff1a\u8e1d\u5730\u6ed1\u884c + \u5f00\u5408\u80ef",
        "\u4e3b\u7ec3 12 \u5206\u949f\uff1a\u4f4e\u901f\u8fde\u7eed\u52a8\u4f5c\u5faa\u73af",
        "\u6536\u8eab 5 \u5206\u949f\uff1a\u4e0b\u80a2\u62c9\u4f38",
      ],
    },
    {
      day: "\u7b2c2\u5929",
      focus: "\u5f31\u9879\u6280\u672f\u8865\u5f3a",
      duration: "25-30\u5206\u949f",
      tasks: [
        weakestAdvice,
        "\u624b\u673a\u56fa\u5b9a\u4fa7\u62cd\uff0c\u6bcf 2 \u7ec4\u56de\u770b\u4e00\u6b21\u52a8\u4f5c",
        "\u6bcf\u7ec4\u95f4\u6b47 45 \u79d2\uff0c\u4fdd\u8bc1\u52a8\u4f5c\u8d28\u91cf",
      ],
    },
    {
      day: "\u7b2c3\u5929",
      focus: "\u8282\u594f\u4e0e\u8fde\u7eed\u6027",
      duration: "20\u5206\u949f",
      tasks: [
        "\u8ddf\u6bcf\u5206\u949f70-90\u4e0b\u8282\u62cd\u7ec3\u4e60\uff0c\u8fde\u7eed\u6ed1\u884c4\u7ec4",
        "\u91cd\u70b9\u89c2\u5bdf\u5165\u52a8-\u6267\u884c-\u6536\u52bf\u7684\u8fde\u63a5",
        "\u8bad\u7ec3\u540e\u518d\u62cd 1 \u6bb5 8-12 \u79d2\u89c6\u9891\u8fdb\u884c\u590d\u76d8",
      ],
    },
  ];
};

const normalizePhaseScores = (value) =>
  Array.isArray(value)
    ? value
        .map((item, index) => {
          const safe = item && typeof item === "object" ? item : {};
          const phaseKey = String(safe.key || safe.phase || "")
            .trim()
            .toLowerCase();
          const key = phaseKey || `phase_${index + 1}`;
          const name =
            String(safe.name || "").trim() ||
            SENSOR_PHASE_NAME_MAP[phaseKey] ||
            `\u9636\u6bb5${index + 1}`;
          return {
            key,
            name,
            score: clamp(Math.round(toNumber(safe.score, 0)), 0, 100),
            comment: String(safe.comment || "").trim(),
          };
        })
        .filter((item) => item.name)
        .slice(0, 3)
    : [];

const normalizeNamedDetails = (value) =>
  Array.isArray(value)
    ? value
        .map((item) => ({
          key: String(item && item.key ? item.key : ""),
          name: String(item && item.name ? item.name : ""),
          score: clamp(Math.round(toNumber(item && item.score, 0)), 0, 100),
          note: String(item && item.note ? item.note : "").trim(),
        }))
        .filter((item) => item.name)
        .slice(0, 3)
    : [];

const normalizeTrainingPlan = (value) =>
  Array.isArray(value)
    ? value
        .map((item) => ({
          day: String(item && item.day ? item.day : "").trim(),
          focus: String(item && item.focus ? item.focus : "").trim(),
          duration: String(item && item.duration ? item.duration : "").trim(),
          tasks: normalizeStringList(item && item.tasks, 5),
        }))
        .filter((item) => item.day || item.focus || item.tasks.length)
        .slice(0, 5)
    : [];

const SENSOR_PHASE_NAME_MAP = {
  warmup: "\u8d77\u52bf\u4e0e\u5165\u52a8",
  execution: "\u4e3b\u4f53\u52a8\u4f5c\u6267\u884c",
  recovery: "\u6536\u52bf\u4e0e\u8fde\u8d2f",
};

const readRemoteErrorText = (value, fallback) => {
  const safe = value && typeof value === "object" ? value : {};
  const detail = safe.detail;
  if (typeof detail === "string" && detail.trim()) {
    return detail.trim();
  }
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0];
    if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
    if (first && typeof first === "object") {
      const text = String(first.msg || first.message || "").trim();
      if (text) {
        return text;
      }
    }
  }
  const candidates = [safe.message, safe.error, safe.errMsg, safe.msg];
  for (let i = 0; i < candidates.length; i += 1) {
    const text = String(candidates[i] || "").trim();
    if (text) {
      return text;
    }
  }
  return String(fallback || "api_invalid_result").trim();
};

const isPlaceholderAnalysis = (analysis) => {
  if (!analysis || typeof analysis !== "object") {
    return false;
  }
  const tips = Array.isArray(analysis.tips) ? analysis.tips : [];
  const merged = [
    String(analysis.summary || ""),
    String(analysis.noteEcho || ""),
    tips.join("\n"),
  ]
    .join("\n")
    .toLowerCase();
  return false;
};

const normalizePredictContinuousApiAnalysis = (raw, options = {}) => {
  const safeRaw = raw && typeof raw === "object" ? raw : null;
  if (!safeRaw) {
    return null;
  }
  const payload =
    safeRaw.data && typeof safeRaw.data === "object" ? safeRaw.data : safeRaw;
  const summary =
    payload.summary && typeof payload.summary === "object"
      ? payload.summary
      : {};
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const mergedSegments = Array.isArray(payload.merged_segments)
    ? payload.merged_segments
    : [];
  const looksLikePredictContinuous =
    Array.isArray(payload.segments) ||
    Object.prototype.hasOwnProperty.call(payload, "sensor_mode") ||
    Object.prototype.hasOwnProperty.call(summary, "total_segments") ||
    Object.prototype.hasOwnProperty.call(summary, "average_quality_score");
  if (!looksLikePredictContinuous) {
    return null;
  }

  const qualityScores = segments
    .map((segment) =>
      toFiniteNumber(
        segment &&
          (segment.quality_score ??
            segment.qualityScore ??
            (segment.quality_prediction &&
              segment.quality_prediction.quality_score)),
      ),
    )
    .filter((value) => Number.isFinite(value));
  const actionConfidenceScores = segments
    .map((segment) =>
      normalizeConfidenceToPercent(
        segment && segment.prediction && segment.prediction.confidence,
      ),
    )
    .filter((value) => Number.isFinite(value));
  const qualityConfidenceScores = segments
    .map((segment) =>
      normalizeConfidenceToPercent(
        segment &&
          segment.quality_prediction &&
          segment.quality_prediction.confidence,
      ),
    )
    .filter((value) => Number.isFinite(value));
  const qualityLevelCandidates = [
    ...segments.map((segment) =>
      normalizeQualityLevelText(
        segment &&
          (segment.quality_level ??
            segment.qualityLevel ??
            (segment.quality_prediction && segment.quality_prediction.label)),
      ),
    ),
    ...mergedSegments.map((segment) =>
      normalizeQualityLevelText(
        segment &&
          (segment.dominant_quality_level ?? segment.dominantQualityLevel),
      ),
    ),
    normalizeQualityLevelText(
      summary.dominant_quality_level ?? summary.dominantQualityLevel,
    ),
  ].filter(Boolean);

  const summaryAvgQuality = toFiniteNumber(
    summary.average_quality_score ?? summary.averageQualityScore,
  );
  const averageQualityScore = Number.isFinite(summaryAvgQuality)
    ? summaryAvgQuality
    : average(qualityScores);
  const averageActionConfidence = average(actionConfidenceScores);
  const averageQualityConfidence = average(qualityConfidenceScores);

  let overallBaseScore = Number.isFinite(averageQualityScore)
    ? averageQualityScore
    : NaN;
  if (
    !Number.isFinite(overallBaseScore) &&
    Number.isFinite(averageActionConfidence)
  ) {
    overallBaseScore = averageActionConfidence;
  }
  if (!Number.isFinite(overallBaseScore)) {
    return null;
  }
  const overallScore = clamp(Math.round(overallBaseScore), 0, 100);
  const qualityLevelCounter = {};
  qualityLevelCandidates.forEach((level) => {
    qualityLevelCounter[level] = (qualityLevelCounter[level] || 0) + 1;
  });
  const dominantQualityLevel =
    Object.keys(qualityLevelCounter).sort(
      (a, b) => qualityLevelCounter[b] - qualityLevelCounter[a],
    )[0] ||
    (Number.isFinite(averageQualityScore)
      ? scoreToModelLevel(averageQualityScore)
      : scoreToModelLevel(overallScore));

  const totalSegments = Math.max(
    0,
    Math.round(
      toNumber(
        summary.total_segments ?? summary.totalSegments,
        segments.length,
      ),
    ),
  );
  const totalFrames = Math.max(
    0,
    Math.round(toNumber(summary.total_frames ?? summary.totalFrames, 0)),
  );
  const mergedCount = Math.max(
    0,
    Math.round(
      toNumber(
        summary.merged_segments ?? summary.mergedSegments,
        mergedSegments.length,
      ),
    ),
  );

  const stabilityScore = Number.isFinite(averageActionConfidence)
    ? clamp(Math.round(averageActionConfidence), 0, 100)
    : overallScore;
  const postureScore = Number.isFinite(averageQualityScore)
    ? clamp(Math.round(averageQualityScore), 0, 100)
    : overallScore;
  const qualityReliabilityScore = Number.isFinite(averageQualityConfidence)
    ? clamp(Math.round(averageQualityConfidence), 0, 100)
    : postureScore;
  const segmentSufficiency =
    totalSegments > 0
      ? clamp(Math.round((Math.min(totalSegments, 8) / 8) * 100), 35, 100)
      : 35;
  const continuityScore =
    totalSegments > 0
      ? clamp(
          Math.round(
            (1 - Math.max(0, mergedCount - 1) / Math.max(1, totalSegments)) *
              100,
          ),
          35,
          100,
        )
      : overallScore;

  const metricMap = {
    balance: clamp(
      Math.round(overallScore * 0.7 + segmentSufficiency * 0.3),
      0,
      100,
    ),
    stability: stabilityScore,
    posture: postureScore,
    legDrive: clamp(
      Math.round(postureScore * 0.65 + qualityReliabilityScore * 0.35),
      0,
      100,
    ),
    rhythm: continuityScore,
  };
  const metrics = METRIC_TEMPLATE.map((item) => ({
    key: item.key,
    name: item.name,
    score: metricMap[item.key],
  }));

  const phaseKeys = ["warmup", "execution", "recovery"];
  const phaseBuckets = [[], [], []];
  segments.forEach((segment, index) => {
    const bucketIndex = Math.min(
      2,
      Math.floor((index * 3) / Math.max(1, segments.length)),
    );
    const qualityScore = toFiniteNumber(
      segment &&
        (segment.quality_score ??
          segment.qualityScore ??
          (segment.quality_prediction &&
            segment.quality_prediction.quality_score)),
    );
    if (Number.isFinite(qualityScore)) {
      phaseBuckets[bucketIndex].push(qualityScore);
      return;
    }
    const confidenceScore = normalizeConfidenceToPercent(
      segment && segment.prediction && segment.prediction.confidence,
    );
    if (Number.isFinite(confidenceScore)) {
      phaseBuckets[bucketIndex].push(confidenceScore);
    }
  });
  const phaseBaseline = [
    metricMap.balance,
    metricMap.posture,
    metricMap.rhythm,
  ];
  const phaseScores = phaseKeys.map((phaseKey, index) => {
    const bucketValues = phaseBuckets[index].filter((value) =>
      Number.isFinite(value),
    );
    const score = bucketValues.length
      ? clamp(Math.round(average(bucketValues)), 0, 100)
      : clamp(Math.round(phaseBaseline[index]), 0, 100);
    return {
      key: phaseKey,
      name: SENSOR_PHASE_NAME_MAP[phaseKey] || `phase_${index + 1}`,
      score,
      comment: "",
    };
  });

  const details = buildStrengthWeakness(metrics);
  const tips = normalizeStringList(
    payload.tips || payload.suggestions || payload.advice,
    6,
  );
  const dominantAction = String(
    summary.dominant_action || summary.dominantAction || "",
  ).trim();
  const requestPayload =
    options.sensorPayload && typeof options.sensorPayload === "object"
      ? options.sensorPayload
      : {};
  const requestFrames = Array.isArray(requestPayload.frames)
    ? requestPayload.frames
    : [];
  const frameTs = requestFrames
    .map((frame) => toFiniteNumber(frame && frame.t))
    .filter((value) => Number.isFinite(value));
  let durationMs = 0;
  if (frameTs.length >= 2) {
    const minTs = Math.min(...frameTs);
    const maxTs = Math.max(...frameTs);
    durationMs = Math.max(0, maxTs - minTs);
    if (durationMs > 0 && durationMs < 1000 && maxTs < 1e6) {
      durationMs = Math.round(durationMs * 1000);
    } else {
      durationMs = Math.round(durationMs);
    }
  }
  if (!durationMs) {
    const windowSeconds = toNumber(
      summary.window_seconds ?? summary.windowSeconds,
      0,
    );
    durationMs = Math.max(0, Math.round(windowSeconds * 1000));
  }

  const modelVersion = String(
    payload.modelVersion ||
      payload.model ||
      payload.modelName ||
      payload.model_name ||
      safeRaw.provider ||
      "rf_sensor_api_2026_04_10",
  ).trim();

  return {
    overallScore,
    qualityLevel: dominantQualityLevel,
    summary:
      String(payload.summary || payload.message || "").trim() ||
      buildSummary(overallScore),
    metrics,
    tips: tips.length ? tips : buildTips(metrics),
    confidence: clamp(
      Math.round(averageActionConfidence || overallScore),
      0,
      100,
    ),
    phaseScores,
    strengths: details.strengths,
    weaknesses: details.weaknesses,
    riskAlerts: buildRiskAlerts(metrics),
    trainingPlan: buildTrainingPlan({
      actionType: String(requestPayload.actionType || "sensor_session"),
      metrics,
    }),
    videoQuality: {
      score: clamp(
        Math.round(
          Number.isFinite(averageQualityScore)
            ? averageQualityScore
            : overallScore,
        ),
        0,
        100,
      ),
      issues: [],
      recommendation: "",
    },
    noteEcho:
      String(payload.noteEcho || "").trim() || "Remote sensor model response",
    sensorSession: {
      sessionId: String(
        summary.session_id ||
          summary.sessionId ||
          requestPayload.sessionId ||
          "",
      ).trim(),
      frameCount: totalFrames || requestFrames.length,
      durationMs,
      totalSegments,
      dominantAction,
      dominantQualityLevel,
      averageQualityScore: Number.isFinite(averageQualityScore)
        ? roundTo(averageQualityScore, 2)
        : null,
    },
    modelVersion,
    generatedAt: new Date().toISOString(),
  };
};

const normalizeApiAnalysis = (raw, options = {}) => {
  const continuousPredictAnalysis = normalizePredictContinuousApiAnalysis(
    raw,
    options,
  );
  if (continuousPredictAnalysis) {
    return continuousPredictAnalysis;
  }

  const payload =
    raw && typeof raw === "object"
      ? raw.analysis || raw.result || raw.data || raw
      : null;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  let metrics = normalizeApiMetrics(
    payload.metrics || payload.subScores || payload.dimensionScores,
  );
  const numericMetrics = metrics.filter(
    (item) => typeof item.score === "number",
  );

  let overallScore = toNumber(
    payload.overallScore || payload.score || payload.totalScore,
    NaN,
  );
  if (Number.isNaN(overallScore) && numericMetrics.length) {
    overallScore =
      numericMetrics.reduce((sum, item) => sum + item.score, 0) /
      numericMetrics.length;
  }
  if (Number.isNaN(overallScore)) {
    return null;
  }
  overallScore = clamp(Math.round(overallScore), 0, 100);

  if (!metrics.length) {
    return null;
  }

  metrics = metrics.map((item) => ({
    ...item,
    score:
      typeof item.score === "number" ? item.score : clamp(overallScore, 0, 100),
  }));

  const summary = String(
    payload.summary || payload.comment || payload.description || "",
  ).trim();
  const tipsCandidate = payload.tips || payload.suggestions || payload.advice;
  const tips = normalizeStringList(tipsCandidate, 6);
  const confidence = clamp(
    Math.round(toNumber(payload.confidence, overallScore)),
    0,
    100,
  );
  const phaseScores = normalizePhaseScores(payload.phaseScores);
  const details = buildStrengthWeakness(metrics);
  const strengths = normalizeNamedDetails(payload.strengths);
  const weaknesses = normalizeNamedDetails(payload.weaknesses);
  const riskAlerts = normalizeStringList(payload.riskAlerts, 5);
  const trainingPlan = normalizeTrainingPlan(payload.trainingPlan);
  const rawVideoQuality =
    payload.videoQuality && typeof payload.videoQuality === "object"
      ? payload.videoQuality
      : {};
  const videoQuality = {
    score: clamp(Math.round(toNumber(rawVideoQuality.score, 0)), 0, 100),
    issues: normalizeStringList(rawVideoQuality.issues, 4),
    recommendation: String(rawVideoQuality.recommendation || "").trim(),
  };
  const noteEcho = String(payload.noteEcho || "").trim();
  const sensorSession =
    payload.sensorSession && typeof payload.sensorSession === "object"
      ? payload.sensorSession
      : {};
  const qualityLevel =
    normalizeQualityLevelText(
      payload.qualityLevel ||
        payload.quality_level ||
        payload.qualityTag ||
        payload.quality_tag ||
        (payload.qualityPrediction && payload.qualityPrediction.label) ||
        (payload.quality_prediction && payload.quality_prediction.label) ||
        sensorSession.dominantQualityLevel ||
        sensorSession.dominant_quality_level,
    ) || scoreToModelLevel(overallScore);
  const modelVersion = String(
    payload.modelVersion ||
      payload.model ||
      payload.modelName ||
      payload.model_name ||
      (raw && raw.provider) ||
      "",
  ).trim();

  return {
    overallScore,
    qualityLevel,
    summary: summary || buildSummary(overallScore),
    metrics,
    tips: tips.length ? tips : buildTips(metrics),
    confidence,
    phaseScores: phaseScores.length
      ? phaseScores
      : buildPhaseScores(metrics, hashText(JSON.stringify(metrics))),
    strengths: strengths.length ? strengths : details.strengths,
    weaknesses: weaknesses.length ? weaknesses : details.weaknesses,
    riskAlerts: riskAlerts.length ? riskAlerts : buildRiskAlerts(metrics),
    trainingPlan: trainingPlan.length
      ? trainingPlan
      : buildTrainingPlan({ actionType: "\u7efc\u5408\u52a8\u4f5c", metrics }),
    videoQuality: videoQuality.score
      ? videoQuality
      : buildVideoQualityInsight(
          payload.videoInfo && typeof payload.videoInfo === "object"
            ? payload.videoInfo
            : {},
        ),
    noteEcho:
      noteEcho ||
      "\u672a\u63d0\u4f9b\u8bad\u7ec3\u5907\u6ce8\uff0c\u7cfb\u7edf\u6309\u89c6\u9891\u7279\u5f81\u8bc4\u4f30\u3002",
    sensorSession,
    modelVersion,
    generatedAt: new Date().toISOString(),
  };
};

const buildAnalysis = ({ fileID, actionType, note, videoInfo }) => {
  const profile = getActionProfile(actionType);
  const qualityAdj = computeQualityAdjustment(videoInfo);
  const seed = hashText(`${fileID}|${actionType}|${note}`);

  const metrics = [
    { key: "balance", name: "\u91cd\u5fc3\u5e73\u8861", base: profile.balance },
    {
      key: "stability",
      name: "\u52a8\u4f5c\u7a33\u5b9a",
      base: profile.stability,
    },
    { key: "posture", name: "\u59ff\u6001\u63a7\u5236", base: profile.posture },
    {
      key: "legDrive",
      name: "\u8e6c\u4f38\u53d1\u529b",
      base: profile.legDrive,
    },
    { key: "rhythm", name: "\u8282\u594f\u8fde\u8d2f", base: profile.rhythm },
  ].map((item, index) => {
    const noise = buildNoise(seed, index) * 6;
    return {
      key: item.key,
      name: item.name,
      score: clamp(Math.round(item.base + qualityAdj + noise), 45, 98),
    };
  });

  const overallScore = Math.round(
    metrics.reduce((sum, item) => sum + item.score, 0) / metrics.length,
  );
  const confidence = clamp(
    Math.round(76 + qualityAdj * 1.5 + buildNoise(seed, 30) * 8),
    58,
    96,
  );
  const phaseScores = buildPhaseScores(metrics, seed);
  const { strengths, weaknesses } = buildStrengthWeakness(metrics);
  const riskAlerts = buildRiskAlerts(metrics);
  const trainingPlan = buildTrainingPlan({ actionType, metrics });
  const videoQuality = buildVideoQualityInsight(videoInfo);
  const noteEcho = note
    ? `\u5df2\u7ed3\u5408\u4f60\u7684\u5907\u6ce8\uff1a\u300c${String(note).slice(0, 30)}${String(note).length > 30 ? "..." : ""}\u300d`
    : "\u672a\u63d0\u4f9b\u8bad\u7ec3\u5907\u6ce8\uff0c\u7cfb\u7edf\u6309\u89c6\u9891\u7279\u5f81\u8bc4\u4f30\u3002";

  return {
    overallScore,
    summary: buildSummary(overallScore),
    metrics,
    tips: buildTips(metrics),
    confidence,
    phaseScores,
    strengths,
    weaknesses,
    riskAlerts,
    trainingPlan,
    videoQuality,
    noteEcho,
    generatedAt: new Date().toISOString(),
  };
};

const buildSensorAnalysis = ({ sessionId, actionType, note, frames }) => {
  const features = computeSensorFeatures(frames);
  const metrics = buildSensorMetrics(features);
  const overallScore = Math.round(
    metrics.reduce((sum, item) => sum + toNumber(item.score, 0), 0) /
      Math.max(1, metrics.length),
  );
  const phaseScores = buildPhaseScores(
    metrics,
    hashText(`${sessionId}|${actionType}|${note}|${features.frameCount}`),
  );
  const details = buildStrengthWeakness(metrics);
  const quality = buildSensorSessionQuality(features);
  const confidence = clamp(
    Math.round(
      55 +
        quality.score * 0.28 +
        Math.min(100, Math.max(0, features.frameCount / 2)) * 0.15 -
        Math.min(20, features.cadenceCv * 100) * 0.35,
    ),
    35,
    96,
  );

  return {
    overallScore,
    summary: buildSummary(overallScore),
    metrics,
    tips: buildTips(metrics),
    confidence,
    phaseScores,
    strengths: details.strengths,
    weaknesses: details.weaknesses,
    riskAlerts: buildRiskAlerts(metrics),
    trainingPlan: buildTrainingPlan({
      actionType: actionType || "sensor_session",
      metrics,
    }),
    videoQuality: {
      score: quality.score,
      issues: quality.issues,
      recommendation: quality.recommendation,
    },
    noteEcho: note
      ? `Sensor session note: ${String(note).slice(0, 64)}${String(note).length > 64 ? "..." : ""}`
      : "No session note provided.",
    sensorSession: {
      sessionId: String(sessionId || ""),
      frameCount: features.frameCount,
      durationMs: features.durationMs,
      cadence: features.cadence,
      cadenceCv: features.cadenceCv,
      coverage: features.coverage,
    },
    modelVersion: "sensor_rule_v0",
    generatedAt: new Date().toISOString(),
  };
};

const mergeAnalysis = (remoteAnalysis, fallbackAnalysis) => {
  if (!remoteAnalysis) {
    return fallbackAnalysis;
  }
  if (!fallbackAnalysis) {
    return remoteAnalysis;
  }

  const remoteMetricMap = {};
  (remoteAnalysis.metrics || []).forEach((item) => {
    if (!item || !item.key) {
      return;
    }
    remoteMetricMap[item.key] = item;
  });

  const metrics = (fallbackAnalysis.metrics || []).map((item) => {
    const remote = remoteMetricMap[item.key];
    if (!remote || typeof remote.score !== "number") {
      return item;
    }
    return {
      key: item.key,
      name: item.name,
      score: clamp(Math.round(remote.score), 0, 100),
    };
  });

  let overallScore = toNumber(remoteAnalysis.overallScore, NaN);
  if (Number.isNaN(overallScore)) {
    overallScore =
      metrics.reduce((sum, item) => sum + item.score, 0) / metrics.length;
  }
  if (Number.isNaN(overallScore)) {
    overallScore = toNumber(fallbackAnalysis.overallScore, 0);
  }
  overallScore = clamp(Math.round(overallScore), 0, 100);
  const qualityLevel =
    normalizeQualityLevelText(remoteAnalysis && remoteAnalysis.qualityLevel) ||
    normalizeQualityLevelText(
      fallbackAnalysis && fallbackAnalysis.qualityLevel,
    ) ||
    scoreToModelLevel(overallScore);

  return {
    overallScore,
    qualityLevel,
    summary:
      String(remoteAnalysis.summary || "").trim() || fallbackAnalysis.summary,
    metrics,
    tips:
      Array.isArray(remoteAnalysis.tips) && remoteAnalysis.tips.length
        ? remoteAnalysis.tips
        : fallbackAnalysis.tips,
    confidence: clamp(
      Math.round(
        toNumber(
          remoteAnalysis.confidence,
          fallbackAnalysis.confidence || overallScore,
        ),
      ),
      0,
      100,
    ),
    phaseScores:
      Array.isArray(remoteAnalysis.phaseScores) &&
      remoteAnalysis.phaseScores.length
        ? remoteAnalysis.phaseScores
        : fallbackAnalysis.phaseScores,
    strengths:
      Array.isArray(remoteAnalysis.strengths) && remoteAnalysis.strengths.length
        ? remoteAnalysis.strengths
        : fallbackAnalysis.strengths,
    weaknesses:
      Array.isArray(remoteAnalysis.weaknesses) &&
      remoteAnalysis.weaknesses.length
        ? remoteAnalysis.weaknesses
        : fallbackAnalysis.weaknesses,
    riskAlerts:
      Array.isArray(remoteAnalysis.riskAlerts) &&
      remoteAnalysis.riskAlerts.length
        ? remoteAnalysis.riskAlerts
        : fallbackAnalysis.riskAlerts,
    trainingPlan:
      Array.isArray(remoteAnalysis.trainingPlan) &&
      remoteAnalysis.trainingPlan.length
        ? remoteAnalysis.trainingPlan
        : fallbackAnalysis.trainingPlan,
    videoQuality:
      remoteAnalysis.videoQuality &&
      typeof remoteAnalysis.videoQuality === "object"
        ? remoteAnalysis.videoQuality
        : fallbackAnalysis.videoQuality,
    noteEcho:
      String(remoteAnalysis.noteEcho || "").trim() || fallbackAnalysis.noteEcho,
    generatedAt: remoteAnalysis.generatedAt || new Date().toISOString(),
  };
};

const mergeSensorAnalysis = (remoteAnalysis, fallbackAnalysis) => {
  const merged = mergeAnalysis(remoteAnalysis, fallbackAnalysis);
  const fallbackSensorSession =
    fallbackAnalysis && typeof fallbackAnalysis.sensorSession === "object"
      ? fallbackAnalysis.sensorSession
      : {};
  const remoteSensorSession =
    remoteAnalysis && typeof remoteAnalysis.sensorSession === "object"
      ? remoteAnalysis.sensorSession
      : {};

  const sensorSession = Object.keys(remoteSensorSession).length
    ? {
        ...fallbackSensorSession,
        ...remoteSensorSession,
      }
    : fallbackSensorSession;

  const modelVersion =
    String((remoteAnalysis && remoteAnalysis.modelVersion) || "").trim() ||
    String(
      (fallbackAnalysis && fallbackAnalysis.modelVersion) || "sensor_rule_v0",
    ).trim() ||
    "sensor_rule_v0";

  return {
    ...merged,
    sensorSession,
    modelVersion,
  };
};

const callRemoteFunctionInference = async (config, payload) => {
  if (!config.functionName) {
    return { analysis: null, error: "api_function_not_configured" };
  }

  // Mini-program cloud.callFunction can time out around 12s on the caller side.
  // Keep this hop bounded to avoid surfacing hard timeout to frontend.
  const functionTimeoutMs = Math.min(
    Math.max(3000, toNumber(config.timeoutMs, 9000)),
    10000,
  );
  const resp = await withTimeout(
    cloud.callFunction({
      name: config.functionName,
      data: {
        scene: "inline_skating_action_analysis",
        version: "v1",
        input: payload,
      },
    }),
    functionTimeoutMs,
    "api_function_timeout",
  );

  const raw =
    resp && typeof resp === "object" && resp.result ? resp.result : resp;
  if (raw && typeof raw === "object" && raw.success === false) {
    return {
      analysis: null,
      error: readRemoteErrorText(raw, "api_remote_failed"),
    };
  }
  const analysis = normalizeApiAnalysis(raw, { sensorPayload: payload });
  if (!analysis) {
    return { analysis: null, error: "api_invalid_result" };
  }
  if (isPlaceholderAnalysis(analysis)) {
    return { analysis: null, error: "api_placeholder_result" };
  }

  return { analysis, error: "" };
};

const callRemoteInference = async (config, payload) => {
  if (!config.enabled) {
    return { analysis: null, error: "api_disabled" };
  }
  if (!config.url && config.functionName) {
    return callRemoteFunctionInference(config, payload);
  }
  if (!config.url) {
    return { analysis: null, error: "api_url_or_function_not_configured" };
  }

  const headers = {};
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const response = await requestJson({
    url: config.url,
    method: "POST",
    headers,
    timeoutMs: config.timeoutMs,
    body: {
      scene: "inline_skating_action_analysis",
      version: "v1",
      input: payload,
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return {
      analysis: null,
      error: readRemoteErrorText(
        response.data,
        `api_http_${response.statusCode}`,
      ),
    };
  }
  if (
    response.data &&
    typeof response.data === "object" &&
    response.data.success === false
  ) {
    return {
      analysis: null,
      error: readRemoteErrorText(response.data, "api_remote_failed"),
    };
  }

  const analysis = normalizeApiAnalysis(response.data);
  if (!analysis) {
    return { analysis: null, error: "api_invalid_result" };
  }
  if (isPlaceholderAnalysis(analysis)) {
    return { analysis: null, error: "api_placeholder_result" };
  }
  return { analysis, error: "" };
};

const callRemoteSensorFunctionInference = async (config, payload) => {
  if (!config.functionName) {
    return { analysis: null, error: "sensor_api_function_not_configured" };
  }

  const functionTimeoutMs = Math.min(
    Math.max(3000, toNumber(config.timeoutMs, 9000)),
    10000,
  );
  const resp = await withTimeout(
    cloud.callFunction({
      name: config.functionName,
      data: {
        scene: "sensor_session_analysis_v1",
        version: "v1",
        input: payload,
      },
    }),
    functionTimeoutMs,
    "sensor_api_function_timeout",
  );

  const raw =
    resp && typeof resp === "object" && resp.result ? resp.result : resp;
  if (raw && typeof raw === "object" && raw.success === false) {
    return {
      analysis: null,
      error: readRemoteErrorText(raw, "sensor_api_remote_failed"),
    };
  }
  const analysis = normalizeApiAnalysis(raw, { sensorPayload: payload });
  if (!analysis) {
    return { analysis: null, error: "sensor_api_invalid_result" };
  }

  return { analysis, error: "" };
};

const callRemoteSensorInference = async (config, payload) => {
  if (!config.enabled) {
    return { analysis: null, error: "sensor_api_disabled" };
  }
  if (!config.url && config.functionName) {
    return callRemoteSensorFunctionInference(config, payload);
  }
  if (!config.url) {
    return {
      analysis: null,
      error: "sensor_api_url_or_function_not_configured",
    };
  }

  const headers = {};
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const inferPayload = {
    scene: "sensor_session_analysis_v1",
    version: "v1",
    input: payload,
  };
  const predictContinuousPayload = buildSensorPredictContinuousPayload(payload);
  const usePredictContinuous = /\/predict-continuous-json\/?$/i.test(
    String(config.url || ""),
  );
  const predictContinuousUrl = buildPredictContinuousJsonUrl(config.url);
  const requestCandidates = [];

  if (usePredictContinuous) {
    requestCandidates.push({
      url: config.url,
      body: predictContinuousPayload,
      endpointKind: "predict-continuous-json",
    });
  } else {
    requestCandidates.push({
      url: config.url,
      body: inferPayload,
      endpointKind: "infer",
    });
    if (predictContinuousUrl && predictContinuousUrl !== config.url) {
      requestCandidates.push({
        url: predictContinuousUrl,
        body: predictContinuousPayload,
        endpointKind: "predict-continuous-json",
      });
    }
  }

  let lastError = "sensor_api_remote_failed";
  for (let i = 0; i < requestCandidates.length; i += 1) {
    const candidate = requestCandidates[i];
    const response = await requestJson({
      url: candidate.url,
      method: "POST",
      headers,
      timeoutMs: config.timeoutMs,
      body: candidate.body,
    });

    const hasNextCandidate = i < requestCandidates.length - 1;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errorText = readRemoteErrorText(
        response.data,
        `sensor_api_http_${response.statusCode}`,
      );
      lastError = errorText;
      // Support both protocols: if /infer is incompatible/unavailable, try /predict-continuous-json automatically.
      const shouldTryNextProtocol =
        hasNextCandidate &&
        (response.statusCode === 404 ||
          response.statusCode === 405 ||
          response.statusCode === 422 ||
          (candidate.endpointKind === "infer" && response.statusCode === 400));
      if (shouldTryNextProtocol) {
        continue;
      }
      return {
        analysis: null,
        error: errorText,
      };
    }
    if (
      response.data &&
      typeof response.data === "object" &&
      response.data.success === false
    ) {
      const errorText = readRemoteErrorText(
        response.data,
        "sensor_api_remote_failed",
      );
      lastError = errorText;
      if (hasNextCandidate) {
        continue;
      }
      return { analysis: null, error: errorText };
    }

    const analysis = normalizeApiAnalysis(response.data, {
      sensorPayload: payload,
    });
    if (!analysis) {
      lastError = "sensor_api_invalid_result";
      if (hasNextCandidate) {
        continue;
      }
      return { analysis: null, error: "sensor_api_invalid_result" };
    }
    return { analysis, error: "" };
  }

  return { analysis: null, error: lastError };
};

const saveAnalysisRecord = async ({
  userId,
  openid,
  fileID,
  actionType,
  note,
  videoInfo,
  analysis,
  inferenceMode,
  apiError,
  sourceType,
  sourceSummary,
}) => {
  try {
    const recordId = createSqlId("analysis");
    const safeAnalysis = analysis && typeof analysis === "object" ? analysis : {};
    const overallScore = toFiniteNumber(safeAnalysis.overallScore);
    const confidence = toFiniteNumber(safeAnalysis.confidence);
    await sqlModels.$runSQL(
      "INSERT INTO `skate_action_analysis_records` " +
        "(`_id`, `_openid`, user_id, action_type, source_type, file_id, note, " +
        "inference_mode, api_error, overall_score, confidence, analysis, " +
        "source_summary, video_info, created_at, updated_at) VALUES " +
        "({{id}}, {{openid}}, {{userId}}, {{actionType}}, {{sourceType}}, {{fileId}}, " +
        "{{note}}, {{inferenceMode}}, {{apiError}}, {{overallScore}}, {{confidence}}, " +
        "{{analysis}}, {{sourceSummary}}, {{videoInfo}}, NOW(3), NOW(3))",
      {
        id: recordId,
        openid: String(openid || ""),
        userId: String(userId || ""),
        actionType: String(actionType || ""),
        sourceType: String(sourceType || "video"),
        fileId: String(fileID || ""),
        note: String(note || ""),
        inferenceMode: String(inferenceMode || "local_rule"),
        apiError: String(apiError || ""),
        overallScore: Number.isFinite(overallScore) ? overallScore : null,
        confidence: Number.isFinite(confidence) ? confidence : null,
        analysis: JSON.stringify(safeAnalysis),
        sourceSummary: JSON.stringify(
          sourceSummary && typeof sourceSummary === "object" ? sourceSummary : {},
        ),
        videoInfo: JSON.stringify(
          videoInfo && typeof videoInfo === "object" ? videoInfo : {},
        ),
      },
    );
    return recordId;
  } catch (e) {
    console.error("mysql analysis insert failed", e);
    return "";
  }
};

const parseJsonColumn = (value, fallback = {}) => {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
};

const storageHealthHandler = async () => {
  const status = { mysql: false, documentDb: false };
  const errors = {};
  try {
    await sqlModels.$runSQL("SELECT 1 AS ok");
    status.mysql = true;
  } catch (error) {
    errors.mysql = String((error && error.message) || error || "mysql_failed");
  }
  try {
    await db.collection(SENSOR_TRAINING_COLLECTION).limit(1).get();
    status.documentDb = true;
  } catch (error) {
    errors.documentDb = String((error && error.message) || error || "document_db_failed");
  }
  return {
    success: status.mysql && status.documentDb,
    status,
    errors,
    policy: {
      imuRawStorage: `document:${SENSOR_TRAINING_COLLECTION}`,
      analysisStorage: `mysql:${RECORD_COLLECTION}`,
      userStorage: `mysql:${USER_COLLECTION}`,
    },
  };
};

const getAnalysisRecordHandler = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = String((wxContext && wxContext.OPENID) || "").trim();
  const recordId = String(event.recordId || "").trim();
  if (!openid || !recordId) return { success: false, message: "invalid_request" };
  try {
    const result = await sqlModels.$runSQL(
      "SELECT * FROM `skate_action_analysis_records` " +
        "WHERE `_id` = {{id}} AND `_openid` = {{openid}} LIMIT 1",
      { id: recordId, openid },
    );
    const row = sqlRows(result)[0];
    if (!row) return { success: false, message: "record_not_found" };
    return {
      success: true,
      record: {
        ...row,
        analysis: parseJsonColumn(row.analysis),
        sourceSummary: parseJsonColumn(row.source_summary),
        videoInfo: parseJsonColumn(row.video_info),
      },
    };
  } catch (error) {
    console.error("mysql analysis read failed", error);
    return { success: false, message: "mysql_analysis_read_failed" };
  }
};

const getSensorSessionHandler = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = String((wxContext && wxContext.OPENID) || "").trim();
  const sampleId = String(event.sampleId || "").trim();
  if (!openid || !sampleId) return { success: false, message: "invalid_request" };
  try {
    const result = await db.collection(SENSOR_TRAINING_COLLECTION).doc(sampleId).get();
    const document = result && result.data ? result.data : null;
    if (!document) return { success: false, message: "sample_not_found" };
    const owner = String(document._openid || document.operatorOpenId || "").trim();
    if (owner && owner !== openid) return { success: false, message: "permission_denied" };
    return { success: true, document };
  } catch (error) {
    console.error("document sensor session read failed", error);
    return { success: false, message: "document_sensor_read_failed" };
  }
};

const buildSensorDenoiseUrl = (rawUrl) => {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const rawPath = String(parsed.pathname || "").replace(/\/+$/g, "");
    if (/\/denoise\/training-frames$/i.test(rawPath)) {
      return parsed.toString();
    }
    const basePath = rawPath.replace(
      /\/(?:infer|predict-continuous-json|predict)\/?$/i,
      "",
    );
    parsed.pathname = `${basePath}/denoise/training-frames`.replace(
      /\/{2,}/g,
      "/",
    );
    parsed.search = "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
};

const processSensorTrainingSampleHandler = async (event = {}) => {
  const profile = await resolveSensorOperatorProfile();
  if (!profile.success) {
    return { success: false, message: profile.message || "permission_denied" };
  }
  const sampleId = String(event.sampleId || "").trim();
  if (!sampleId) return { success: false, message: "sample_id_required" };
  const rawResult = await db.collection(SENSOR_TRAINING_COLLECTION).doc(sampleId).get();
  const raw = rawResult && rawResult.data ? rawResult.data : null;
  if (!raw) return { success: false, message: "sample_not_found" };
  if (
    !profile.isAdmin &&
    String(raw.operatorOpenId || raw._openid || "").trim() !== profile.openid
  ) {
    return { success: false, message: "permission_denied" };
  }
  const config = getSensorRemoteConfig();
  const url = buildSensorDenoiseUrl(config.url);
  if (!config.enabled || !url) {
    return { success: false, message: "sensor_denoise_api_unavailable" };
  }
  const roles = Array.isArray(raw.activeRoles) && raw.activeRoles.length
    ? raw.activeRoles
    : raw.expectedRoles;
  const variant =
    event.variant === "calibrated" ? "calibrated" : "calibrated_filtered";
  const removeSpikes =
    variant === "calibrated_filtered" && event.removeSpikes !== false;
  const accCutoffHz =
    variant === "calibrated_filtered" ? event.accCutoffHz ?? null : null;
  const gyroCutoffHz =
    variant === "calibrated_filtered" ? event.gyroCutoffHz ?? null : null;
  const headers = config.token
    ? { Authorization: `Bearer ${config.token}` }
    : {};
  const response = await requestJson({
    url,
    method: "POST",
    headers,
    timeoutMs: config.timeoutMs,
    body: {
      frames: Array.isArray(raw.frames) ? raw.frames : [],
      roles: Array.isArray(roles) ? roles : [],
      profiles: raw.calibrationProfiles || {},
      sample_rate_hz: toNumber(raw.sampleRateHz, 50),
      remove_spikes: removeSpikes,
      acc_cutoff_hz: accCutoffHz,
      gyro_cutoff_hz: gyroCutoffHz,
    },
  });
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !response.data ||
    response.data.success !== true
  ) {
    return {
      success: false,
      message: "sensor_denoise_failed",
      statusCode: response.statusCode,
      detail: response.data,
    };
  }
  const filteredFrames = Array.isArray(response.data.frames)
    ? response.data.frames
    : [];
  const report = response.data.quality_report || {};
  const document = {
    recordType: "filtered_training_sample",
    source_sample_id: sampleId,
    processing_variant: variant,
    processing_version: "denoise_v1",
    processing_config: {
      remove_spikes: removeSpikes,
      acc_cutoff_hz: accCutoffHz,
      gyro_cutoff_hz: gyroCutoffHz,
      temperature_compensation: false,
    },
    sessionId: raw.sessionId || "",
    actionType: raw.actionType || "",
    activeRoles: roles || [],
    frameCount: filteredFrames.length,
    frames: filteredFrames,
    quality_report: report,
    calibrationProfiles: raw.calibrationProfiles || {},
    operatorOpenId: profile.openid,
    updatedAt: db.serverDate(),
  };
  const existingResult = await db
    .collection(SENSOR_FILTERING_COLLECTION)
    .where({
      source_sample_id: sampleId,
      processing_variant: variant,
      processing_version: "denoise_v1",
    })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const existing =
    existingResult && Array.isArray(existingResult.data)
      ? existingResult.data[0]
      : null;
  let filteredSampleId = "";
  let updated = false;
  if (existing && existing._id) {
    await db
      .collection(SENSOR_FILTERING_COLLECTION)
      .doc(existing._id)
      .update({ data: document });
    filteredSampleId = String(existing._id);
    updated = true;
  } else {
    const saved = await addDocWithAutoCreateCollection(
      SENSOR_FILTERING_COLLECTION,
      { ...document, createdAt: db.serverDate() },
    );
    filteredSampleId = String((saved && saved._id) || "");
  }
  return {
    success: true,
    sampleId,
    filteredSampleId,
    updated,
    processing_variant: variant,
    frameCount: filteredFrames.length,
    quality_report: report,
  };
};

const analyzeSensorSessionHandler = async (event = {}) => {
  const operatorProfile = await resolveSensorCallerProfile();
  if (!operatorProfile.success) {
    return {
      success: false,
      message: operatorProfile.message || "operator_invalid",
    };
  }

  const activeRoles = resolveSensorActiveRoles(event);
  const frames = filterSensorFramesByRoles(normalizeSensorFrames(event), activeRoles);
  const frameRoleSummary = summarizeSensorFrameRoles(frames, activeRoles);
  if (!frames.length) {
    return {
      success: false,
      message: "sensor_frames_required",
      frameRoleSummary,
    };
  }
  if (frames.length < SENSOR_MIN_FRAME_COUNT) {
    return {
      success: false,
      message: "sensor_frames_too_few",
      minFrames: SENSOR_MIN_FRAME_COUNT,
      frameCount: frames.length,
      frameRoleSummary,
    };
  }
  const allowSinglePointDebug = isSinglePointDebugEnabled(event);
  const missingRoles = findMissingSensorRoles(frames, activeRoles);
  const minActiveRoles = resolveSensorMinActiveRoles(event, activeRoles);
  const activeRoleCount = frameRoleSummary.activeRoles.length;
  if (!allowSinglePointDebug && activeRoleCount < minActiveRoles) {
    return {
      success: false,
      message: "sensor_roles_incomplete",
      missingRoles,
      minActiveRoles,
      activeRoleCount,
      frameRoleSummary,
    };
  }

  const sessionId =
    String(event.sessionId || event.trainingId || "").trim() ||
    `sensor_${Date.now()}`;
  const actionType = String(event.actionType || "sensor_session").trim();
  const note = String(event.note || "").trim();
  const targetUserId = String(
    event.userId ||
      (operatorProfile.operator && operatorProfile.operator._id) ||
      "",
  ).trim();
  const fallbackAnalysis = buildSensorAnalysis({
    sessionId,
    actionType,
    note,
    frames,
  });
  const sensorRemoteConfig = getSensorRemoteConfig();
  const sensorApiStrategy = getSensorApiStrategy();
  let analysis = fallbackAnalysis;
  let inferenceMode = "sensor_rule_v0";
  let apiError = "";

  if (!sensorRemoteConfig.enabled && sensorApiStrategy.strict) {
    return {
      success: false,
      message: "sensor_api_required",
      apiError: "sensor_api_disabled",
      singlePointDebug: allowSinglePointDebug,
      missingRoles,
      frameRoleSummary,
    };
  }

  // 单点调试模式（allowSinglePointDebug）跳过远程 FastAPI 模型
  // 因为远程模型要求至少 6 个节点（min_valid_nodes_per_window=6），单节点不够
  // 直接走本地 buildSensorAnalysis() 规则分析，后续可在配置中选择启用远程
  if (sensorRemoteConfig.enabled && !allowSinglePointDebug) {
    const remoteFrames = normalizeFramesForRemoteApi(frames);
    try {
      const remoteResult = await callRemoteSensorInference(sensorRemoteConfig, {
        sessionId,
        actionType,
        note,
        userId: targetUserId,
        allowSinglePointDebug,
        debugMode: allowSinglePointDebug ? "single_point" : "",
        activeRoles,
        minActiveRoles,
        frames: remoteFrames,
      });
      if (remoteResult && remoteResult.analysis) {
        analysis = sensorApiStrategy.strict
          ? remoteResult.analysis
          : mergeSensorAnalysis(remoteResult.analysis, fallbackAnalysis);
        inferenceMode = "sensor_api_v1";
      } else {
        apiError =
          (remoteResult && remoteResult.error) || "sensor_api_empty_result";
        if (sensorApiStrategy.strict) {
          return {
            success: false,
            message: "sensor_api_unavailable",
            apiError,
            singlePointDebug: allowSinglePointDebug,
            missingRoles,
            frameRoleSummary,
          };
        }
        inferenceMode = "sensor_rule_fallback";
      }
    } catch (error) {
      apiError =
        error && error.message
          ? String(error.message)
          : "sensor_api_call_failed";
      if (sensorApiStrategy.strict) {
        return {
          success: false,
          message: "sensor_api_unavailable",
          apiError,
          singlePointDebug: allowSinglePointDebug,
          missingRoles,
          frameRoleSummary,
        };
      }
      inferenceMode = "sensor_rule_fallback";
    }
  }

  let rawSampleId = "";
  try {
    const rawSample = await addDocWithAutoCreateCollection(
      SENSOR_TRAINING_COLLECTION,
      {
        _openid: operatorProfile.openid,
        recordType: "inference_session",
        sessionId,
        userId: targetUserId,
        operatorUserId: String(
          (operatorProfile.operator && operatorProfile.operator._id) || "",
        ),
        operatorOpenId: operatorProfile.openid,
        actionType,
        sourceType: "real_device",
        sensorProfile: String(event.sensorProfile || "full_body_9_v1"),
        expectedRoles: activeRoles,
        activeRoles: frameRoleSummary.activeRoles,
        frameCount: frames.length,
        frames: compactSensorFrames(frames, SENSOR_MAX_STORED_FRAME_COUNT),
        modelOutput: {
          status: "completed",
          overallScore: analysis && analysis.overallScore,
          confidence: analysis && analysis.confidence,
          version: analysis && analysis.modelVersion,
        },
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    );
    rawSampleId = String((rawSample && rawSample._id) || "");
  } catch (storageError) {
    console.error("save inference sensor document failed", storageError);
  }

  const recordId = await saveAnalysisRecord({
    userId: targetUserId,
    openid: operatorProfile.openid,
    fileID: "",
    actionType,
    note,
    videoInfo: {},
    analysis,
    inferenceMode,
    apiError,
    sourceType: "sensor",
    sourceSummary: {
      ...(analysis.sensorSession || {}),
      rawSampleId,
    },
  });

  if (!rawSampleId || !recordId) {
    return {
      success: false,
      message: "result_storage_incomplete",
      analysis,
      recordId,
      rawSampleId,
      storageStatus: {
        mysql: !!recordId,
        documentDb: !!rawSampleId,
      },
    };
  }

  return {
    success: true,
    analysis,
    recordId,
    rawSampleId,
    inferenceMode,
    apiError,
    singlePointDebug: allowSinglePointDebug,
    activeRoles,
    missingRoles,
    minActiveRoles,
    activeRoleCount,
    frameRoleSummary,
    sensorApiMode: sensorApiStrategy.mode,
    storageStatus: { mysql: true, documentDb: true },
  };
};

const saveSensorTrainingSampleHandler = async (event = {}) => {
  const operatorProfile = await resolveSensorOperatorProfile();
  if (!operatorProfile.success) {
    return {
      success: false,
      message: operatorProfile.message || "permission_denied",
    };
  }

  const activeRoles = resolveSensorActiveRoles(event);
  const frames = filterSensorFramesByRoles(normalizeSensorFrames(event), activeRoles);
  const frameRoleSummary = summarizeSensorFrameRoles(frames, activeRoles);
  if (!frames.length) {
    return {
      success: false,
      message: "sensor_frames_required",
      frameRoleSummary,
    };
  }
  if (frames.length < SENSOR_MIN_FRAME_COUNT) {
    return {
      success: false,
      message: "sensor_frames_too_few",
      minFrames: SENSOR_MIN_FRAME_COUNT,
      frameCount: frames.length,
      frameRoleSummary,
    };
  }
  const allowSinglePointDebug = isSinglePointDebugEnabled(event);
  const missingRoles = findMissingSensorRoles(frames, activeRoles);
  const minActiveRoles = resolveSensorMinActiveRoles(event, activeRoles);
  const activeRoleCount = frameRoleSummary.activeRoles.length;
  if (!allowSinglePointDebug && activeRoleCount < minActiveRoles) {
    return {
      success: false,
      message: "sensor_roles_incomplete",
      missingRoles,
      minActiveRoles,
      activeRoleCount,
      frameRoleSummary,
    };
  }

  const sessionId =
    String(event.sessionId || event.trainingId || "").trim() ||
    `sensor_${Date.now()}`;
  const actionType = String(event.actionType || "sensor_session").trim();
  const sourceType = normalizeSensorSourceType(
    event.sourceType || event.dataSource || "",
  );
  const note = String(event.note || "").trim();
  const label =
    event.label && typeof event.label === "object" ? event.label : {};

  const rawCoachScore = toNumber(label.coachScore, null);
  const resolvedScore = rawCoachScore !== null ? rawCoachScore : (
    toNumber(event.overallScore,
      toNumber(event.qualityScore,
        toNumber(event.quality_score,
          toNumber(event.result?.overallScore,
            toNumber(event.result?.qualityScore,
              toNumber(event.result?.quality_score, 0))))))
  );
  const coachScore = clamp(Math.round(resolvedScore), 0, 100);
  const qualityTag = String(label.qualityTag || event.qualityTag || event.qualityLabel || event.quality_tag || event.result?.qualityTag || event.result?.qualityLabel || event.result?.quality_tag || scoreLevel(coachScore)).trim();
  const tags = normalizeStringList(label.tags, 12);
  // 原始采集阶段不做降采样、不做四舍五入、不做软件滤波。
  // normalizeSensorFrames 只负责字段/角色格式统一，数值保持原精度。
  const compactFrames = frames.slice(0, SENSOR_MAX_STORED_FRAME_COUNT);
  const operatorUserId = String(
    event.operatorUserId ||
      (operatorProfile.operator && operatorProfile.operator._id) ||
      "",
  ).trim();
  const sensorProfile =
    String(event.sensorProfile || "full_body_10_capture_v1").trim() ||
    "full_body_10_capture_v1";
  const requestedSampleIntervalMs = Math.max(
    0,
    toNumber(event.requestedSampleIntervalMs, 0),
  );
  const captureSchema =
    String(event.captureSchema || "imu_6axis_frame_v1").trim() ||
    "imu_6axis_frame_v1";
  const expectedRoles = Array.isArray(event.expectedRoles)
    ? event.expectedRoles
        .map((role) => normalizeRoleName(role))
        .filter((role, index, list) => role && list.indexOf(role) === index)
    : ["waist", "left_knee", "right_knee", "left_foot", "right_foot"];
  const rawNodesOnly = event.rawNodesOnly !== false;
  const missingFillPolicy =
    String(event.missingFillPolicy || "feature_engineering_zero_fill").trim() ||
    "feature_engineering_zero_fill";

  try {
    const sampleDoc = {
      sessionId,
      userId: String(event.userId || ""),
      _openid: operatorProfile.openid,
      openid: operatorProfile.openid,
      operatorUserId,
      operatorOpenId: operatorProfile.openid,
      operatorRole: operatorProfile.role || "",
      operatorLevel: operatorProfile.level || 0,
      actionType,
      sourceType,
      note,
      sensorProfile,
      captureSchema,
      requestedSampleIntervalMs,
      expectedRoles,
      activeRoles: frameRoleSummary.activeRoles,
      missingRoles,
      rawNodesOnly,
      missingFillPolicy,
      calibrationProfiles:
        event.calibrationProfiles &&
        typeof event.calibrationProfiles === "object"
          ? event.calibrationProfiles
          : {},
      label: {
        coachScore,
        qualityTag,
        coachComment: String(label.coachComment || "").trim(),
        tags,
        selectedSuggestions: Array.isArray(label.selectedSuggestions)
          ? label.selectedSuggestions
              .map((n) => Number(n))
              .filter((n) => n >= 1 && n <= 8)
          : [],
      },
      modelFeatures: {},
      modelOutput: {
        status: "not_trained",
        overallScore: null,
        metrics: [],
        confidence: null,
        version: "",
      },
      frameCount: frames.length,
      frames: compactFrames,
      sourceDetail: {
        deviceId: String(event.deviceId || "").trim(),
        deviceModel: String(event.deviceModel || "").trim(),
      },
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };
    const res = await addDocWithAutoCreateCollection(
      SENSOR_TRAINING_COLLECTION,
      sampleDoc,
    );
    const sampleId = String((res && res._id) || "");
    let processingResults = [];
    if (sampleId && event.processAfterSave !== false) {
      const variants = ["calibrated", "calibrated_filtered"];
      processingResults = await Promise.all(
        variants.map((variant) =>
          processSensorTrainingSampleHandler({
            sampleId,
            variant,
            removeSpikes: variant === "calibrated_filtered",
            accCutoffHz:
              variant === "calibrated_filtered"
                ? event.accCutoffHz ?? null
                : null,
            gyroCutoffHz:
              variant === "calibrated_filtered"
                ? event.gyroCutoffHz ?? null
                : null,
          }).catch((error) => ({
            success: false,
            processing_variant: variant,
            message:
              error && error.message
                ? String(error.message)
                : "automatic_processing_failed",
          })),
        ),
      );
      const allProcessed = processingResults.every(
        (item) => item && item.success === true,
      );
      await db
        .collection(SENSOR_TRAINING_COLLECTION)
        .doc(sampleId)
        .update({
          data: {
            processingStatus: allProcessed ? "completed" : "partial_failed",
            processingResults: processingResults.map((item) => ({
              success: !!(item && item.success),
              processing_variant: String(
                (item && item.processing_variant) || "",
              ),
              filteredSampleId: String(
                (item && item.filteredSampleId) || "",
              ),
              message: String((item && item.message) || ""),
            })),
            processedAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        })
        .catch(() => null);
    }

    return {
      success: true,
      sampleId,
      frameCount: frames.length,
      storedFrameCount: compactFrames.length,
      coachScore,
      qualityTag,
      modelVersion: "",
      sensorProfile,
      expectedRoles,
      missingRoles,
      rawNodesOnly,
      missingFillPolicy,
      sourceType,
      activeRoles,
      minActiveRoles,
      activeRoleCount,
      frameRoleSummary,
      processingResults,
    };
  } catch (e) {
    return {
      success: false,
      message:
        e && e.message ? e.message : "save_sensor_training_sample_failed",
      errorCode: e && e.errCode ? e.errCode : "",
      errorName: e && e.errMsg ? e.errMsg : "",
      frameRoleSummary,
    };
  }
};

const mapSensorTrainingSample = (item) => {
  const safe = item && typeof item === "object" ? item : {};
  const label = safe.label && typeof safe.label === "object" ? safe.label : {};
  const modelOutput =
    safe.modelOutput && typeof safe.modelOutput === "object"
      ? safe.modelOutput
      : {};
  const sourceDetail =
    safe.sourceDetail && typeof safe.sourceDetail === "object"
      ? safe.sourceDetail
      : {};
  return {
    id: String(safe._id || safe.id || "").trim(),
    sessionId: String(safe.sessionId || "").trim(),
    userId: String(safe.userId || "").trim(),
    actionType: String(safe.actionType || "").trim(),
    sourceType: normalizeSensorSourceType(safe.sourceType),
    note: String(safe.note || "").trim(),
    label: {
      coachScore: toNumber(label.coachScore, 0),
      qualityTag: String(label.qualityTag || "").trim(),
      coachComment: String(label.coachComment || "").trim(),
      tags: normalizeStringList(label.tags, 20),
    },
    modelOutput: {
      overallScore: toNumber(modelOutput.overallScore, 0),
      confidence: toNumber(modelOutput.confidence, 0),
      version: String(modelOutput.version || "").trim(),
    },
    frameCount: toNumber(safe.frameCount, 0),
    createdAt: safe.createdAt || null,
    updatedAt: safe.updatedAt || null,
    sourceDetail: {
      deviceId: String(sourceDetail.deviceId || "").trim(),
      deviceModel: String(sourceDetail.deviceModel || "").trim(),
    },
  };
};

const listSensorTrainingSamplesHandler = async (event = {}) => {
  const operatorProfile = await resolveSensorOperatorProfile();
  if (!operatorProfile.success) {
    return {
      success: false,
      message: operatorProfile.message || "permission_denied",
    };
  }

  const _ = db.command;
  const page = toPositiveInt(event.page, 1, 1, 100000);
  const pageSize = toPositiveInt(event.pageSize, 20, 1, 50);
  const skip = (page - 1) * pageSize;
  const sourceType = normalizeSensorSourceType(event.sourceType || "");
  const hasSourceFilter = String(event.sourceType || "").trim().length > 0;
  const actionType = String(event.actionType || "").trim();
  const userId = String(event.userId || "").trim();

  const where = {
    isDeleted: _.neq(true),
  };
  if (hasSourceFilter) {
    where.sourceType = sourceType;
  }
  if (actionType) {
    where.actionType = actionType;
  }
  if (userId) {
    where.userId = userId;
  }
  if (!operatorProfile.isAdmin) {
    where.operatorOpenId = operatorProfile.openid;
  }

  try {
    const query = db.collection(SENSOR_TRAINING_COLLECTION).where(where);
    const [countRes, listRes] = await Promise.all([
      query.count().catch(() => ({ total: 0 })),
      query
        .orderBy("createdAt", "desc")
        .skip(skip)
        .limit(pageSize)
        .get()
        .catch(() => ({ data: [] })),
    ]);
    const total = toNumber(countRes && countRes.total, 0);
    const rawList = listRes && Array.isArray(listRes.data) ? listRes.data : [];
    return {
      success: true,
      samples: rawList.map((item) => mapSensorTrainingSample(item)),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
      scope: operatorProfile.isAdmin ? "all" : "operator_only",
    };
  } catch (error) {
    return {
      success: false,
      message:
        error && error.message
          ? error.message
          : "list_sensor_training_samples_failed",
    };
  }
};

const deleteSensorTrainingSampleHandler = async (event = {}) => {
  const operatorProfile = await resolveSensorOperatorProfile();
  if (!operatorProfile.success) {
    return {
      success: false,
      message: operatorProfile.message || "permission_denied",
    };
  }

  const sampleId = String(event.sampleId || "").trim();
  if (!sampleId) {
    return {
      success: false,
      message: "sample_id_required",
    };
  }
  const hardDelete = !!event.hardDelete;

  try {
    const docRes = await db
      .collection(SENSOR_TRAINING_COLLECTION)
      .doc(sampleId)
      .get()
      .catch(() => null);
    const sample = docRes && docRes.data ? docRes.data : null;
    if (!sample || !sample._id) {
      return {
        success: false,
        message: "sample_not_found",
      };
    }

    if (!operatorProfile.isAdmin) {
      const sampleOperatorOpenId = String(sample.operatorOpenId || "").trim();
      if (
        !sampleOperatorOpenId ||
        sampleOperatorOpenId !== operatorProfile.openid
      ) {
        return {
          success: false,
          message: "permission_denied",
        };
      }
    }

    if (hardDelete && operatorProfile.isAdmin) {
      await db.collection(SENSOR_TRAINING_COLLECTION).doc(sampleId).remove();
      return {
        success: true,
        deletedId: sampleId,
        hardDelete: true,
      };
    }

    await db
      .collection(SENSOR_TRAINING_COLLECTION)
      .doc(sampleId)
      .update({
        data: {
          isDeleted: true,
          deletedAt: db.serverDate(),
          deletedBy: {
            operatorUserId: String(
              (operatorProfile.operator && operatorProfile.operator._id) || "",
            ).trim(),
            operatorOpenId: operatorProfile.openid,
            role: operatorProfile.role || "",
          },
          updatedAt: db.serverDate(),
        },
      });
    return {
      success: true,
      deletedId: sampleId,
      hardDelete: false,
    };
  } catch (error) {
    return {
      success: false,
      message:
        error && error.message
          ? error.message
          : "delete_sensor_training_sample_failed",
    };
  }
};

const normalizeStaticRawFrames = (frames) => {
  const source = Array.isArray(frames) ? frames.slice(0, 500) : [];
  return source
    .map((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const points = safe.points && typeof safe.points === "object" ? safe.points : {};
      const waist = points.waist && typeof points.waist === "object" ? points.waist : null;
      if (!waist) return null;
      const vector = normalizeSensorVector(waist);
      const calibration =
        safe.calibration && typeof safe.calibration === "object"
          ? {
              status: String(safe.calibration.status || "").trim(),
              sample_count: toNumber(safe.calibration.sample_count, 0),
              gyro_offset: Array.isArray(safe.calibration.gyro_offset)
                ? safe.calibration.gyro_offset.slice(0, 3).map((value) =>
                    toNumber(value, 0),
                  )
                : [0, 0, 0],
              gyro_std_max: toNumber(safe.calibration.gyro_std_max, 0),
              acc_norm_mean: toNumber(safe.calibration.acc_norm_mean, 0),
              acc_norm_std: toNumber(safe.calibration.acc_norm_std, 0),
              temperature_c: toNumber(safe.calibration.temperature_c, 0),
            }
          : null;
      return {
        t: toNumber(safe.unix_ts_ms, toNumber(safe.t, 0)),
        uptime_ms: toNumber(safe.uptime_ms, 0),
        unix_ts_ms: toNumber(safe.unix_ts_ms, 0),
        server_received_ms: toNumber(safe.server_received_ms, 0),
        seq: toNumber(safe.seq, 0),
        time_synced: !!safe.time_synced,
        temperature_c: toNumber(
          safe.temperature_c ?? waist.temperature_c,
          0,
        ),
        filter_status: String(safe.filter_status || "").trim(),
        calibration,
        points: { waist: vector },
      };
    })
    .filter(Boolean);
};

const findExistingStaticDocument = async (
  recordType,
  captureId,
  extra = {},
) => {
  try {
    const result = await db
      .collection(STATIC_SAMPLE_NOFILTERING_COLLECTION)
      .where({ recordType, captureId, ...extra })
      .limit(1)
      .get();
    return result && Array.isArray(result.data) ? result.data[0] || null : null;
  } catch (error) {
    return null;
  }
};

const saveStaticSampleChunkHandler = async (event = {}) => {
  const profile = resolveStaticCaptureCaller();
  if (!profile.success) {
    return { success: false, message: profile.message || "operator_invalid" };
  }
  const captureId = String(event.captureId || "").trim();
  const phase = String(event.phase || "").trim();
  const groupNumber = toPositiveInt(event.groupNumber, 1, 1, 4);
  const chunkIndex = toPositiveInt(event.chunkIndex, 0, 0, 10000);
  const durationSeconds = toPositiveInt(event.durationSeconds, 0, 1, 3600);
  const frames = normalizeStaticRawFrames(event.frames);
  if (!captureId) return { success: false, message: "capture_id_required" };
  // Keep the legacy temperature-stage values readable while accepting the
  // duration-based options shared by the waist and four-node capture pages.
  if (
    ![
      "test",
      "1min",
      "3min",
      "5min",
      "10min",
      "warming",
      "thermal_stable",
    ].includes(phase)
  ) {
    return { success: false, message: "static_phase_invalid" };
  }
  if (!frames.length) return { success: false, message: "static_frames_required" };

  const existing = await findExistingStaticDocument(
    "static_raw_chunk",
    captureId,
    { chunkIndex },
  );
  if (existing && existing._id) {
    return {
      success: true,
      duplicate: true,
      documentId: String(existing._id),
      captureId,
      chunkIndex,
      frameCount: toPositiveInt(existing.frameCount, frames.length, 0, 500),
    };
  }

  const temperatures = frames
    .map((frame) => Number(frame.temperature_c))
    .filter(Number.isFinite);
  const calibrationFrame = frames.find(
    (frame) => frame.calibration && typeof frame.calibration === "object",
  );
  const calibration = calibrationFrame ? calibrationFrame.calibration : null;
  const storedFrames = frames.map((frame) => {
    const stored = { ...frame };
    delete stored.calibration;
    delete stored.filter_status;
    return stored;
  });
  const document = {
    recordType: "static_raw_chunk",
    captureId,
    phase,
    groupNumber,
    chunkIndex,
    durationSeconds,
    sampleRateHz: 50,
    filterStatus: "hardware_dlpf_only",
    softwareFilteringApplied: false,
    hardwareFilter: { gyroDlpfHz: 20, accelDlpfHz: 21.2 },
    calibration,
    node: "waist",
    frameCount: frames.length,
    firstUptimeMs: toNumber(frames[0].uptime_ms, 0),
    lastUptimeMs: toNumber(frames[frames.length - 1].uptime_ms, 0),
    firstUnixTsMs: toNumber(frames[0].unix_ts_ms, 0),
    lastUnixTsMs: toNumber(frames[frames.length - 1].unix_ts_ms, 0),
    temperatureMinC: temperatures.length ? Math.min(...temperatures) : null,
    temperatureMaxC: temperatures.length ? Math.max(...temperatures) : null,
    frames: storedFrames,
    operatorOpenId: profile.openid,
    createdAt: db.serverDate(),
  };
  try {
    const result = await addDocWithAutoCreateCollection(
      STATIC_SAMPLE_NOFILTERING_COLLECTION,
      document,
    );
    return {
      success: true,
      documentId: String((result && result._id) || ""),
      captureId,
      chunkIndex,
      frameCount: frames.length,
    };
  } catch (error) {
    return {
      success: false,
      message: error && error.message ? error.message : "save_static_chunk_failed",
    };
  }
};

const finishStaticSampleCaptureHandler = async (event = {}) => {
  const profile = resolveStaticCaptureCaller();
  if (!profile.success) {
    return { success: false, message: profile.message || "operator_invalid" };
  }
  const captureId = String(event.captureId || "").trim();
  if (!captureId) return { success: false, message: "capture_id_required" };
  const summary = {
    recordType: "static_capture_manifest",
    captureId,
    phase: String(event.phase || "").trim(),
    groupNumber: toPositiveInt(event.groupNumber, 1, 1, 4),
    durationSeconds: toPositiveInt(event.durationSeconds, 1, 1, 3600),
    sampleRateHz: 50,
    totalFrames: toPositiveInt(event.totalFrames, 0, 0, 200000),
    totalChunks: toPositiveInt(event.totalChunks, 0, 0, 10000),
    status: String(event.status || "completed").trim(),
    softwareFilteringApplied: false,
    operatorOpenId: profile.openid,
    updatedAt: db.serverDate(),
  };
  const existing = await findExistingStaticDocument(
    "static_capture_manifest",
    captureId,
  );
  if (existing && existing._id) {
    await db
      .collection(STATIC_SAMPLE_NOFILTERING_COLLECTION)
      .doc(existing._id)
      .update({ data: summary });
    return {
      success: true,
      updated: true,
      documentId: String(existing._id),
    };
  }
  const result = await addDocWithAutoCreateCollection(
    STATIC_SAMPLE_NOFILTERING_COLLECTION,
    { ...summary, createdAt: db.serverDate() },
  );
  return { success: true, documentId: String((result && result._id) || "") };
};

exports.main = async (event) => {
  try {
    const type = String(event && event.type ? event.type : "").trim();
    if (type === "analyzeSensorSession" || type === "analyze_sensor_session") {
      return analyzeSensorSessionHandler(event || {});
    }
    if (
      type === "saveSensorTrainingSample" ||
      type === "save_sensor_training_sample"
    ) {
      return saveSensorTrainingSampleHandler(event || {});
    }
    if (
      type === "processSensorTrainingSample" ||
      type === "process_sensor_training_sample"
    ) {
      return processSensorTrainingSampleHandler(event || {});
    }
    if (type === "saveStaticSampleChunk" || type === "save_static_sample_chunk") {
      return saveStaticSampleChunkHandler(event || {});
    }
    if (
      type === "finishStaticSampleCapture" ||
      type === "finish_static_sample_capture"
    ) {
      return finishStaticSampleCaptureHandler(event || {});
    }
    if (
      type === "listSensorTrainingSamples" ||
      type === "list_sensor_training_samples"
    ) {
      return listSensorTrainingSamplesHandler(event || {});
    }
    if (
      type === "deleteSensorTrainingSample" ||
      type === "delete_sensor_training_sample"
    ) {
      return deleteSensorTrainingSampleHandler(event || {});
    }
    if (
      type === "debugSensorRemoteConfig" ||
      type === "debug_sensor_remote_config"
    ) {
      return debugSensorRemoteConfigHandler();
    }
    if (type === "debugSensorApiPing" || type === "debug_sensor_api_ping") {
      return debugSensorApiPingHandler();
    }
    if (type === "storageHealth" || type === "storage_health") {
      return storageHealthHandler();
    }
    if (type === "getAnalysisRecord" || type === "get_analysis_record") {
      return getAnalysisRecordHandler(event || {});
    }
    if (type === "getSensorSession" || type === "get_sensor_session") {
      return getSensorSessionHandler(event || {});
    }
    if (!event || type !== "analyze") {
      return {
        success: false,
        message: "unsupported_type",
      };
    }
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "analyze_failed",
      errMsg: e,
    };
  }
};
