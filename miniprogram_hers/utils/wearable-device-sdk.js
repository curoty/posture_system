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
const DEFAULT_COLLECT_TIMEOUT_MS = 15000;
const DEFAULT_SAMPLE_INTERVAL_MS = 50;
const DEFAULT_ROLE_SAMPLE_MAX_AGE_MS = 1200;
const DEFAULT_CONNECT_TIMEOUT_MS = 35000;
const DEFAULT_WX_API_TIMEOUT_MS = 12000;
const BLE_API_TIMEOUT_OPEN_ADAPTER_MS = 10000;
const BLE_API_TIMEOUT_DISCOVERY_MS = 10000;
const BLE_API_TIMEOUT_STOP_DISCOVERY_MS = 6000;
const BLE_API_TIMEOUT_QUERY_MS = 10000;
const BLE_API_TIMEOUT_NOTIFY_MS = 10000;
const BLE_API_TIMEOUT_WRITE_MS = 8000;
const BLE_API_TIMEOUT_CREATE_CONNECTION_MS = 14000;
const BLE_API_TIMEOUT_CLOSE_CONNECTION_MS = 8000;
const BLE_API_TIMEOUT_CLOSE_ADAPTER_MS = 10000;
const BLE_API_TIMEOUT_SET_MTU_MS = 6000;
const BLE_CONNECT_NATIVE_TIMEOUT_MS = 12000;
const BLE_CONNECT_STEP_MIN_TIMEOUT_MS = 3500;
const MAX_NOTIFY_TEXT_BUFFER_CHARS = 65536;
const MAX_NOTIFY_MERGED_TEXT_CHARS = 131072;
const WIFI_API_TIMEOUT_CONNECT_MS = 15000;
const WIFI_API_TIMEOUT_READ_MS = 30000;
const WIFI_API_TIMEOUT_WRITE_MS = 10000;
const MAX_NOTIFY_RECORD_CHARS = 32768;
const MAX_NOTIFY_CHUNK_CHARS = 32768*2;
const MAX_NOTIFY_PARSE_RECORDS = 24;

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

const ROLE_TOKEN_ALIAS = {
  "\u4e3b\u673a": "head",
  m: "head",
  main: "head",
  master: "head",
  host: "head",
  head: "head",
  "0": "head",
  "1a": "left_elbow",
  "1b": "left_wrist",
  "2a": "right_elbow",
  "2b": "right_wrist",
  "3a": "left_knee",
  "3b": "left_foot",
  "4a": "right_knee",
  "4b": "right_foot",
  "1": "left_elbow",
  "2": "right_elbow",
  "3": "left_wrist",
  "4": "right_wrist",
  "5": "left_knee",
  "6": "right_knee",
  "7": "left_foot",
  "8": "right_foot",
  s0: "head",
  s1: "left_elbow",
  s2: "right_elbow",
  s3: "left_wrist",
  s4: "right_wrist",
  s5: "left_knee",
  s6: "right_knee",
  s7: "left_foot",
  s8: "right_foot",
  n0: "head",
  n1: "left_elbow",
  n2: "right_elbow",
  n3: "left_wrist",
  n4: "right_wrist",
  n5: "left_knee",
  n6: "right_knee",
  n7: "left_foot",
  n8: "right_foot",
  node0: "head",
  node1: "left_elbow",
  node2: "right_elbow",
  node3: "left_wrist",
  node4: "right_wrist",
  node5: "left_knee",
  node6: "right_knee",
  node7: "left_foot",
  node8: "right_foot",
  slave0: "head",
  slave1: "left_elbow",
  slave2: "right_elbow",
  slave3: "left_wrist",
  slave4: "right_wrist",
  slave5: "left_knee",
  slave6: "right_knee",
  slave7: "left_foot",
  slave8: "right_foot",
  imu0: "head",
  imu1: "left_elbow",
  imu2: "right_elbow",
  imu3: "left_wrist",
  imu4: "right_wrist",
  imu5: "left_knee",
  imu6: "right_knee",
  imu7: "left_foot",
  imu8: "right_foot",
  l: "left_elbow",
  left: "left_elbow",
  r: "right_elbow",
  right: "right_elbow",
  lw: "left_wrist",
  leftwrist: "left_wrist",
  rw: "right_wrist",
  rightwrist: "right_wrist",
  lk: "left_knee",
  leftknee: "left_knee",
  rk: "right_knee",
  rightknee: "right_knee",
  lf: "left_foot",
  leftfoot: "left_foot",
  leftankle: "left_foot",
  rf: "right_foot",
  rightfoot: "right_foot",
  rightankle: "right_foot",
};

const ROLE_NUMERIC_ID_BY_NAME = {
  head: 0,
  left_elbow: 1,
  right_elbow: 2,
  left_wrist: 3,
  right_wrist: 4,
  left_knee: 5,
  right_knee: 6,
  left_foot: 7,
  right_foot: 8,
};

const toNumber = (value, fallback = 0) => {
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const normalizeRole = (value) => {
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

const normalizeUuid = (value) =>
  String(value || "")
    .replace(/-/g, "")
    .trim()
    .toLowerCase();

const uuidEquals = (left, right) => {
  if (!left || !right) {
    return false;
  }
  return normalizeUuid(left) === normalizeUuid(right);
};

const normalizeDeviceId = (value) =>
  String(value || "")
    .replace(/[^a-fA-F0-9]/g, "")
    .trim()
    .toUpperCase();

const deviceIdEquals = (left, right) => {
  const l = normalizeDeviceId(left);
  const r = normalizeDeviceId(right);
  if (!l || !r) {
    return false;
  }
  return l === r;
};

const deviceIdStartsWith = (deviceId, prefix) => {
  const safeId = normalizeDeviceId(deviceId);
  const safePrefix = normalizeDeviceId(prefix);
  if (!safeId || !safePrefix) {
    return false;
  }
  return safeId.startsWith(safePrefix);
};

const deviceMatchesPreferredTarget = (device, preferredDeviceId, preferredDeviceIdPrefix) => {
  const safe = device && typeof device === "object" ? device : {};
  const deviceId = String(safe.deviceId || "").trim();
  if (!deviceId) {
    return false;
  }
  if (preferredDeviceId && deviceIdEquals(deviceId, preferredDeviceId)) {
    return true;
  }
  if (preferredDeviceIdPrefix && deviceIdStartsWith(deviceId, preferredDeviceIdPrefix)) {
    return true;
  }
  return false;
};

const mergeDevicesByDeviceId = (primary, extra) => {
  const output = [];
  const seen = new Set();
  const pushItem = (item) => {
    const safe = item && typeof item === "object" ? item : {};
    const id = String(safe.deviceId || "").trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    output.push(item);
  };
  (Array.isArray(primary) ? primary : []).forEach((item) => pushItem(item));
  (Array.isArray(extra) ? extra : []).forEach((item) => pushItem(item));
  return output;
};

const hasAdvertisedService = (device, serviceUuid) => {
  const target = normalizeUuid(serviceUuid);
  if (!target) {
    return false;
  }
  const safe = device && typeof device === "object" ? device : {};
  const list = Array.isArray(safe.advertisServiceUUIDs) ? safe.advertisServiceUUIDs : [];
  return list.some((item) => uuidEquals(item, target));
};

const getDeviceNameLower = (device) =>
  String(device && (device.name || device.localName) ? (device.name || device.localName) : "")
    .trim()
    .toLowerCase();

const isLikelySensorDeviceName = (name) => /(sensor_master|sensor|host|helmet|imu|slave|master|skate)/i.test(String(name || ""));
const isLikelyHostGatewayDeviceName = (name) =>
  /(sensor_master|master|host|main|gateway|helmet|head)/i.test(String(name || ""));
const isPreferredSmartHelmetName = (name) =>
  /(smart[_\s-]*helmet)/i.test(String(name || ""));
const isLikelySlaveNodeDeviceName = (name) =>
  /(slave|node[1-9]|imu[1-9]|\bs[1-9]\b|\bn[1-9]\b)/i.test(String(name || ""));

const scoreDiscoveredDevice = (
  device,
  notifyServiceUUID,
  preferSingleHostStream = false,
  preferredDeviceId = "",
  preferredDeviceIdPrefix = ""
) => {
  const safe = device && typeof device === "object" ? device : {};
  const name = getDeviceNameLower(safe);
  const hasService = hasAdvertisedService(safe, notifyServiceUUID);
  const rssi = toNumber(safe.RSSI, -127);
  const deviceId = String(safe.deviceId || "").trim();
  let score = 0;
  if (hasService) {
    score += 100;
  }
  if (isLikelySensorDeviceName(name)) {
    score += 60;
  }
  if (name.includes("sensor_master")) {
    score += 40;
  }
  if (isPreferredSmartHelmetName(name)) {
    // Keep SmartHelmet as first-choice gateway when multiple nearby BLE devices are present.
    score += 180;
  }
  if (preferSingleHostStream) {
    if (isLikelyHostGatewayDeviceName(name)) {
      score += 140;
    }
    if (isLikelySlaveNodeDeviceName(name)) {
      score -= 120;
    }
  }
  if (preferredDeviceId && deviceIdEquals(deviceId, preferredDeviceId)) {
    score += 2000;
  } else if (preferredDeviceIdPrefix && deviceIdStartsWith(deviceId, preferredDeviceIdPrefix)) {
    score += 900;
  }
  score += Math.max(0, Math.min(20, (rssi + 127) / 6));
  return score;
};

const rankDiscoveredDevices = (
  devices,
  notifyServiceUUID,
  preferSingleHostStream = false,
  preferredDeviceId = "",
  preferredDeviceIdPrefix = ""
) => {
  const list = Array.isArray(devices) ? devices : [];
  if (!list.length) {
    return [];
  }
  const preferredMatches = list.filter((item) =>
    deviceMatchesPreferredTarget(item, preferredDeviceId, preferredDeviceIdPrefix)
  );
  const withName = list.filter((item) => isLikelySensorDeviceName(getDeviceNameLower(item)));
  const baseList = withName.length ? mergeDevicesByDeviceId(withName, preferredMatches) : list;
  const withService = baseList.filter((item) => hasAdvertisedService(item, notifyServiceUUID));
  const candidateList = withService.length
    ? mergeDevicesByDeviceId(withService, preferredMatches)
    : baseList;
  const preferredList = preferSingleHostStream
    ? (() => {
        const hosts = candidateList.filter((item) => isLikelyHostGatewayDeviceName(getDeviceNameLower(item)));
        if (!hosts.length) {
          return candidateList;
        }
        return mergeDevicesByDeviceId(hosts, preferredMatches);
      })()
    : candidateList;

  return preferredList
    .slice()
    .sort((a, b) =>
      scoreDiscoveredDevice(
        b,
        notifyServiceUUID,
        preferSingleHostStream,
        preferredDeviceId,
        preferredDeviceIdPrefix
      )
      - scoreDiscoveredDevice(
        a,
        notifyServiceUUID,
        preferSingleHostStream,
        preferredDeviceId,
        preferredDeviceIdPrefix
      )
    );
};

const pickBestDiscoveredDevice = (
  devices,
  notifyServiceUUID,
  preferSingleHostStream = false,
  preferredDeviceId = "",
  preferredDeviceIdPrefix = ""
) => {
  const ranked = rankDiscoveredDevices(
    devices,
    notifyServiceUUID,
    preferSingleHostStream,
    preferredDeviceId,
    preferredDeviceIdPrefix
  );
  return ranked.length ? ranked[0] : null;
};

// const decodeArrayBufferToText = (buffer) => {
//   if (!buffer) {
//     return "";
//   }
//   try {
//     if (typeof TextDecoder === "function") {
//       return new TextDecoder("utf-8").decode(new Uint8Array(buffer));
//     }
//   } catch (e) {}
//   try {
//     const view = new Uint8Array(buffer);
//     let out = "";
//     //for (let i = 0; i < view.length; i += 1) {
//      for (let i = 0; i < view.length; i ++) {
//       out += String.fromCharCode(view[i]);
//     }
//     return decodeURIComponent(escape(out));
//   } catch (e) {
//     return "";
//   }
//};


const decodeArrayBufferToText = (buffer) => {
  if (!buffer) {
    return "";
  }
  
  const uint8Array = buffer instanceof ArrayBuffer 
    ? new Uint8Array(buffer) 
    : buffer;
  
  if (typeof TextDecoder !== "undefined") {
    try {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const result = decoder.decode(uint8Array);
      return result;
    } catch (e) {}
  }
  
  try {
    return manualUtf8Decode(uint8Array);
  } catch (e) {}
  
  try {
    let result = '';
    for (let i = 0; i < uint8Array.length; i++) {
      result += String.fromCharCode(uint8Array[i]);
    }
    return result;
  } catch (e) {
    return "";
  }
};

const manualUtf8Decode = (uint8Array) => {
  let result = '';
  let i = 0;
  const length = uint8Array.length;
  
  while (i < length) {
    const byte = uint8Array[i];
    
    if (byte < 0x80) {
      // 单字节 ASCII
      result += String.fromCharCode(byte);
      i++;
    } else if (byte < 0xE0) {
      // 双字节
      if (i + 1 >= length) break;
      const byte2 = uint8Array[i + 1];
      result += String.fromCharCode(((byte & 0x1F) << 6) | (byte2 & 0x3F));
      i += 2;
    } else if (byte < 0xF0) {
      // 三字节
      if (i + 2 >= length) break;
      const byte2 = uint8Array[i + 1];
      const byte3 = uint8Array[i + 2];
      result += String.fromCharCode(
        ((byte & 0x0F) << 12) | ((byte2 & 0x3F) << 6) | (byte3 & 0x3F)
      );
      i += 3;
    } else {
      // 四字节（表情符号等）
      if (i + 3 >= length) break;
      const byte2 = uint8Array[i + 1];
      const byte3 = uint8Array[i + 2];
      const byte4 = uint8Array[i + 3];
      const codePoint = ((byte & 0x07) << 18) | ((byte2 & 0x3F) << 12) |
                        ((byte3 & 0x3F) << 6) | (byte4 & 0x3F);
      // 转换为代理对
      const highSurrogate = Math.floor((codePoint - 0x10000) / 0x400) + 0xD800;
      const lowSurrogate = ((codePoint - 0x10000) % 0x400) + 0xDC00;
      result += String.fromCharCode(highSurrogate, lowSurrogate);
      i += 4;
    }
  }
  
  return result;
};



const bufferToHexPreview = (buffer, maxBytes = 64) => {
  if (!buffer) {
    return "";
  }
  try {
    const view = new Uint8Array(buffer);
    const size = Math.max(0, Math.min(view.length, Math.floor(toNumber(maxBytes, 64))));
    if (!size) {
      return "";
    }
    const parts = [];
    for (let i = 0; i < size; i += 1) {
      parts.push(view[i].toString(16).padStart(2, "0"));
    }
    return parts.join(" ");
  } catch (e) {
    return "";
  }
};

const encodeTextToArrayBuffer = (text) => {
  const source = String(text || "");
  if (!source) {
    return new Uint8Array(0).buffer;
  }
  try {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(source).buffer;
    }
  } catch (e) {}

  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes).buffer;
};

const parseHexToArrayBuffer = (text) => {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const payload = source.toLowerCase().startsWith("hex:")
    ? source.slice(4)
    : source;
  const nonHex = payload
    .replace(/0x/gi, "")
    .replace(/[0-9a-fA-F\s,;:|_-]/g, "");
  if (nonHex) {
    return null;
  }
  const compact = payload
    .replace(/0x/gi, "")
    .replace(/[^0-9a-fA-F]/g, "");
  if (!compact || compact.length % 2 !== 0) {
    return null;
  }
  const bytes = [];
  for (let i = 0; i < compact.length; i += 2) {
    bytes.push(parseInt(compact.slice(i, i + 2), 16));
  }
  return new Uint8Array(bytes).buffer;
};

const resolveCommandArrayBuffer = (command) => {
  const raw = String(command || "").trim();
  if (!raw) {
    return null;
  }
  if (raw.toLowerCase().startsWith("ascii:")) {
    return encodeTextToArrayBuffer(raw.slice(6));
  }
  const hexBuffer = parseHexToArrayBuffer(raw);
  if (hexBuffer) {
    return hexBuffer;
  }
  return encodeTextToArrayBuffer(raw);
};

const normalizeVector = (raw) => {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    ax: toNumber(firstDefined(safe.ax, safe.accX, safe.acc_x, safe.x), 0),
    ay: toNumber(firstDefined(safe.ay, safe.accY, safe.acc_y, safe.y), 0),
    az: toNumber(firstDefined(safe.az, safe.accZ, safe.acc_z, safe.z), 0),
    gx: toNumber(firstDefined(safe.gx, safe.gyroX, safe.gyro_x, safe.wx), 0),
    gy: toNumber(firstDefined(safe.gy, safe.gyroY, safe.gyro_y, safe.wy), 0),
    gz: toNumber(firstDefined(safe.gz, safe.gyroZ, safe.gyro_z, safe.wz), 0),
  };
};

const isZeroVector = (point) => {
  const safe = point && typeof point === "object" ? point : {};
  const fields = [
    toNumber(safe.ax, 0),
    toNumber(safe.ay, 0),
    toNumber(safe.az, 0),
    toNumber(safe.gx, 0),
    toNumber(safe.gy, 0),
    toNumber(safe.gz, 0),
  ];
  return fields.every((value) => Math.abs(value) < 1e-6);
};

const isLikelyNodeIdNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return false;
  }
  const rounded = Math.round(num);
  return Math.abs(num - rounded) < 1e-6 && rounded >= 0 && rounded <= 8;
};

const sanitizeVectorByRole = (point, role) => {
  const safePoint = normalizeVector(point);
  const safeRole = normalizeRole(role);
  const roleNodeId = ROLE_NUMERIC_ID_BY_NAME[safeRole];
  if (!Number.isFinite(roleNodeId)) {
    return safePoint;
  }
  return safePoint;
};

const normalizeNumericValuesForRoleToken = (numericValues, roleToken, fallbackRole) => {
  let values = (Array.isArray(numericValues) ? numericValues : [])
    .map((item) => toNumber(item, NaN))
    .filter((item) => Number.isFinite(item));
  if (!values.length) {
    return values;
  }
  const tokenText = String(roleToken || "").trim();
  const tokenRole = tokenText ? resolveRoleToken(tokenText, "") : "";
  const fallbackMappedRole = normalizeRole(fallbackRole);
  const role = tokenRole || fallbackMappedRole;
  const roleNodeId = ROLE_NUMERIC_ID_BY_NAME[role];

  if (
    values.length >= 7
    && isLikelyNodeIdNumber(values[0])
    && (!tokenText || !Number.isFinite(roleNodeId) || Math.round(values[0]) === roleNodeId)
  ) {
    values = values.slice(1);
  }

  return values;
};

const vectorFromNumberList = (list) => {
  const source = Array.isArray(list) ? list : [];
  const values = source
    .map((item) => toNumber(item, NaN))
    .filter((item) => Number.isFinite(item));
  if (values.length < 6) {
    return null;
  }
  return normalizeVector({
    ax: values[0],
    ay: values[1],
    az: values[2],
    gx: values[3],
    gy: values[4],
    gz: values[5],
  });
};

const parseJsonLines = (text) => {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return [];
  }
  const result = [];
  lines.forEach((line) => {
    try {
      const parsed = JSON.parse(line);
      result.push(parsed);
    } catch (e) {}
  });
  if (result.length) {
    return result;
  }
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [parsed];
  } catch (e) {
    return [];
  }
};

const resolveRoleToken = (token, fallbackRole) => {
  const direct = normalizeRole(token);
  if (direct) {
    return direct;
  }
  const compact = String(token || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (compact && ROLE_TOKEN_ALIAS[compact]) {
    return ROLE_TOKEN_ALIAS[compact];
  }
  return normalizeRole(fallbackRole);
};

const mapKvKeyToVectorField = (rawKey) => {
  const key = String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!key) {
    return "";
  }
  const map = {
    ax: "ax",
    ay: "ay",
    az: "az",
    accx: "ax",
    accy: "ay",
    accz: "az",
    x: "ax",
    y: "ay",
    z: "az",
    gx: "gx",
    gy: "gy",
    gz: "gz",
    gyrox: "gx",
    gyroy: "gy",
    gyroz: "gz",
    wx: "gx",
    wy: "gy",
    wz: "gz",
    r: "gx",
    roll: "gx",
    p: "gy",
    pitch: "gy",
    yaw: "gz",
  };
  return map[key] || "";
};

const parseKvVectorText = (text) => {
  const source = String(text || "");
  if (!source.trim()) {
    return null;
  }
  const regex = /([a-zA-Z][a-zA-Z0-9_]*)\s*[:=]\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  const vector = {};
  let matched = false;
  let m = regex.exec(source);
  while (m) {
    const field = mapKvKeyToVectorField(m[1]);
    if (field) {
      vector[field] = toNumber(m[2], 0);
      matched = true;
    }
    m = regex.exec(source);
  }
  if (!matched) {
    return null;
  }
  return normalizeVector(vector);
};

const parseKeyValueSegments = (text, fallbackRole) => {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }
  const segments = source
    .split(/[|\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!segments.length) {
    return [];
  }

  const now = Date.now();
  const entries = [];
  segments.forEach((segment, index) => {
    let roleToken = "";
    let body = segment;
    const colonIndex = segment.indexOf(":");
    if (colonIndex > 0 && colonIndex <= 12) {
      roleToken = segment.slice(0, colonIndex).trim();
      body = segment.slice(colonIndex + 1).trim();
    }
    const explicitRole = roleToken ? resolveRoleToken(roleToken, "") : "";
    const role = explicitRole || (!roleToken ? normalizeRole(fallbackRole) : "");
    if (!role) {
      return;
    }
    const point = parseKvVectorText(body);
    if (!point) {
      return;
    }
    entries.push({
      role,
      t: now + index,
      point,
    });
  });

  if (entries.length) {
    return entries;
  }

  const fallback = parseKvVectorText(source);
  const role = normalizeRole(fallbackRole);
  if (fallback && role) {
    return [
      {
        role,
        t: now,
        point: fallback,
      },
    ];
  }

  return [];
};

const extractNumericValues = (text) => {
  const source = String(text || "");
  const matched = source.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  return matched
    .map((item) => toNumber(item, NaN))
    .filter((item) => Number.isFinite(item));
};

const resolvePairRolesByToken = (token) => {
  const compact = String(token || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!compact) {
    return null;
  }
  const pairMap = {
    "1": ["left_elbow", "left_wrist"],
    "2": ["right_elbow", "right_wrist"],
    "3": ["left_knee", "left_foot"],
    "4": ["right_knee", "right_foot"],
    s1: ["left_elbow", "left_wrist"],
    s2: ["right_elbow", "right_wrist"],
    s3: ["left_knee", "left_foot"],
    s4: ["right_knee", "right_foot"],
    n1: ["left_elbow", "left_wrist"],
    n2: ["right_elbow", "right_wrist"],
    n3: ["left_knee", "left_foot"],
    n4: ["right_knee", "right_foot"],
    node1: ["left_elbow", "left_wrist"],
    node2: ["right_elbow", "right_wrist"],
    node3: ["left_knee", "left_foot"],
    node4: ["right_knee", "right_foot"],
    slave1: ["left_elbow", "left_wrist"],
    slave2: ["right_elbow", "right_wrist"],
    slave3: ["left_knee", "left_foot"],
    slave4: ["right_knee", "right_foot"],
    imu1: ["left_elbow", "left_wrist"],
    imu2: ["right_elbow", "right_wrist"],
    imu3: ["left_knee", "left_foot"],
    imu4: ["right_knee", "right_foot"],
  };
  return pairMap[compact] || null;
};

const buildEntriesFromRoleToken = ({
  roleToken,
  numericValues,
  fallbackRole,
  timestamp,
}) => {
  const values = normalizeNumericValuesForRoleToken(numericValues, roleToken, fallbackRole);
  const toPointByValues = (sourceValues) => {
    const list = Array.isArray(sourceValues) ? sourceValues : [];
    if (list.length >= 6) {
      return vectorFromNumberList(list.slice(0, 6));
    }
    if (list.length >= 3) {
      return normalizeVector({
        ax: list[0],
        ay: list[1],
        az: list[2],
        gx: list[0],
        gy: list[1],
        gz: list[2],
      });
    }
    if (list.length >= 2) {
      return normalizeVector({
        ax: list[0],
        ay: list[1],
        az: 0,
        gx: 0,
        gy: 0,
        gz: 0,
      });
    }
    return null;
  };
  if (values.length < 2) {
    return [];
  }

  const tokenText = String(roleToken || "").trim();
  const isSingleNodeToken = /^[0-8][ab]$/i.test(tokenText);
  if (isSingleNodeToken && values.length < 6) {
    // 1A/1B/2A/2B should always be full 6-axis payload.
    // Incomplete chunks are ignored to avoid incorrectly duplicating acc as gyro.
    return [];
  }

  const pairRoles = resolvePairRolesByToken(tokenText);
  if (pairRoles && values.length >= 12) {
    const firstPointRaw = vectorFromNumberList(values.slice(0, 6));
    const secondPointRaw = vectorFromNumberList(values.slice(6, 12));
    const firstPoint = firstPointRaw ? sanitizeVectorByRole(firstPointRaw, pairRoles[0]) : null;
    const secondPoint = secondPointRaw ? sanitizeVectorByRole(secondPointRaw, pairRoles[1]) : null;
    // Only split into two roles when the second vector is meaningful.
    // This avoids previous false expansion where second half is all zeros.
    if (firstPoint && secondPoint && !isZeroVector(secondPoint)) {
      return [
        { role: pairRoles[0], t: timestamp, point: firstPoint },
        { role: pairRoles[1], t: timestamp, point: secondPoint },
      ];
    }
  }

  const explicitRole = tokenText ? resolveRoleToken(tokenText, "") : "";
  const role = explicitRole || (!tokenText ? normalizeRole(fallbackRole) : "");
  if (!role) {
    return [];
  }
  const point = toPointByValues(values);
  if (!point) {
    return [];
  }
  return [{ role, t: timestamp, point: sanitizeVectorByRole(point, role) }];
};

// Parse a role-tagged text stream, such as:
// HOST:ax,ay,az|gx,gy,gz||1:...12 nums...||2:...12 nums...
// or HOST:...||1A:...||1B:...||2A:...||2B:...
// It is resilient to BLE chunk split and separator variation.
const parseRoleTaggedPipeSegments = (text) => {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }

  const markerRegex = /(host|\u4e3b\u673a|[0-8][ab]|[0-8]|slave[0-8]|node[0-8]|imu[0-8]|s[0-8]|n[0-8])\s*[\u003a\uff1a]/ig;
  const markers = [];
  let match = markerRegex.exec(source);
  while (match) {
    markers.push({
      token: String(match[1] || "").trim(),
      index: match.index,
      bodyStart: match.index + match[0].length,
    });
    match = markerRegex.exec(source);
  }
  if (!markers.length) {
    return [];
  }

  const now = Date.now();
  const entries = [];
  markers.forEach((item, index) => {
    const roleToken = item.token;
    const next = markers[index + 1];
    const bodyEnd = next ? next.index : source.length;
    const body = source
      .slice(item.bodyStart, bodyEnd)
      .trim()
      .replace(/\|/g, ",");
    const numericValues = extractNumericValues(body);
    const mapped = buildEntriesFromRoleToken({
      roleToken,
      numericValues,
      fallbackRole: "",
      timestamp: now + index,
    });
    if (mapped.length) {
      entries.push(...mapped);
    }
  });

  return entries;
};

const parseCsvSegments = (text, fallbackRole) => {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }

  const segments = source
    .split(/[|\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!segments.length) {
    return [];
  }

  const now = Date.now();
  const entries = [];

  segments.forEach((segment, index) => {
    const tokens = segment
      .split(/[,\t; ]+/)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!tokens.length) {
      return;
    }

    let roleToken = "";
    let vectorTokens = tokens;
    const firstToken = tokens[0];
    const firstLooksNumber = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(firstToken);

    if (!firstLooksNumber) {
      roleToken = firstToken;
      vectorTokens = tokens.slice(1);
    } else if (/^\d+$/.test(firstToken) && tokens.length >= 7) {
      // Numeric role id such as "0~8,ax,ay,az,gx,gy,gz"
      roleToken = firstToken;
      vectorTokens = tokens.slice(1);
    }

    let numericValues = vectorTokens
      .map((item) => toNumber(item, NaN))
      .filter((item) => Number.isFinite(item));
    if (numericValues.length < 6) {
      numericValues = extractNumericValues(segment);
    }
    const mapped = buildEntriesFromRoleToken({
      roleToken,
      numericValues,
      fallbackRole,
      timestamp: now + index,
    });
    if (mapped.length) {
      entries.push(...mapped);
    }
  });

  if (entries.length) {
    return entries;
  }

  const fallbackRoleName = normalizeRole(fallbackRole);
  const fallbackValues = extractNumericValues(source);
  if (fallbackRoleName && fallbackValues.length >= 6) {
    return [
      {
        role: fallbackRoleName,
        t: now,
        point: normalizeVector({
          ax: fallbackValues[0],
          ay: fallbackValues[1],
          az: fallbackValues[2],
          gx: fallbackValues[3],
          gy: fallbackValues[4],
          gz: fallbackValues[5],
        }),
      },
    ];
  }

  return [];
};

const parseOrderedRoleNumericStream = (text, roleOrderInput) => {
  const source = String(text || "").trim();
  if (!source) {
    return [];
  }

  const roleOrder = (Array.isArray(roleOrderInput) ? roleOrderInput : SENSOR_ROLES)
    .map((item) => normalizeRole(item))
    .filter(Boolean);
  if (!roleOrder.length) {
    return [];
  }

  if (/(host|\u4e3b\u673a|[0-8][ab]|[0-8]|node\d|slave\d|imu\d|s\d|n\d)\s*[\u003a\uff1a]/i.test(source)) {
    return [];
  }

  const now = Date.now();
  const allValues = extractNumericValues(source);
  if (allValues.length < 12) {
    return [];
  }

  const toPointByWidth = (chunk, width) => {
    if (!Array.isArray(chunk) || chunk.length < width) {
      return null;
    }
    if (width >= 6) {
      return vectorFromNumberList(chunk);
    }
    if (width === 3) {
      return normalizeVector({
        ax: chunk[0],
        ay: chunk[1],
        az: chunk[2],
        gx: chunk[0],
        gy: chunk[1],
        gz: chunk[2],
      });
    }
    if (width === 2) {
      return normalizeVector({
        ax: chunk[0],
        ay: chunk[1],
        az: 0,
        gx: 0,
        gy: 0,
        gz: 0,
      });
    }
    return null;
  };

  const tryBuildByGroupWidth = (groupWidth) => {
    const maxOffset = Math.min(groupWidth - 1, Math.max(0, allValues.length - groupWidth * 2));
    let bestEntries = [];

    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const payload = allValues.slice(offset);
      const groupCount = Math.floor(payload.length / groupWidth);
      if (groupCount < 2) {
        continue;
      }
      const acceptedCount = Math.min(groupCount, roleOrder.length);
      const candidate = [];
      for (let i = 0; i < acceptedCount; i += 1) {
        const role = roleOrder[i];
        const chunk = payload.slice(i * groupWidth, i * groupWidth + groupWidth);
        const point = toPointByWidth(chunk, groupWidth);
        if (!role || !point) {
          candidate.length = 0;
          break;
        }
        candidate.push({
          role,
          t: now + i,
          point,
        });
      }
      if (candidate.length > bestEntries.length) {
        bestEntries = candidate;
      }
    }
    return bestEntries;
  };

  const widthOrder = [6, 3, 2];
  let best = [];
  widthOrder.forEach((width) => {
    const entries = tryBuildByGroupWidth(width);
    if (entries.length > best.length) {
      best = entries;
    }
  });
  return best.length >= 2 ? best : [];
};

const resolveRoleFromName = (name, roleNameMap, roleNamePatterns) => {
  const rawName = String(name || "").trim();
  const key = rawName.toLowerCase();
  if (key && roleNameMap[key]) {
    return normalizeRole(roleNameMap[key]);
  }
  const compactKey = key.replace(/[^a-z0-9]+/g, "");
  if (compactKey && ROLE_TOKEN_ALIAS[compactKey]) {
    return normalizeRole(ROLE_TOKEN_ALIAS[compactKey]);
  }
  const tokenMatch = rawName.match(/(?:^|[^0-9a-zA-Z])(host|[0-8][abAB])(?:[^0-9a-zA-Z]|$)/);
  if (tokenMatch && tokenMatch[1]) {
    const tokenRole = resolveRoleToken(tokenMatch[1], "");
    if (tokenRole) {
      return tokenRole;
    }
  }
  for (let i = 0; i < roleNamePatterns.length; i += 1) {
    const item = roleNamePatterns[i];
    if (!item || !item.role || !item.regex) {
      continue;
    }
    if (item.regex.test(rawName)) {
      return normalizeRole(item.role);
    }
  }
  return "";
};

const buildRoleNamePatterns = (input) => {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const role = normalizeRole(item.role);
      const pattern = String(item.pattern || "").trim();
      if (!role || !pattern) {
        return null;
      }
      try {
        return { role, regex: new RegExp(pattern, "i") };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
};

const safeCall = (fn, options, timeoutMs = DEFAULT_WX_API_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    if (typeof fn !== "function") {
      reject(new Error("wx_api_not_available"));
      return;
    }
    const safeOptions = options && typeof options === "object" ? options : {};
    const duration = Math.max(2000, Math.floor(toNumber(timeoutMs, DEFAULT_WX_API_TIMEOUT_MS)));
    let settled = false;
    let timer = null;

    const done = (handler) => (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      handler(payload);
    };

    const resolveSafe = done((value) => resolve(value));
    const rejectSafe = done((error) => reject(error || new Error("wx_api_failed")));
    timer = setTimeout(() => {
      rejectSafe(new Error("wx_api_timeout"));
    }, duration);

    try {
      fn({
        ...safeOptions,
        success: (res) => resolveSafe(res),
        fail: (err) => rejectSafe(err),
      });
    } catch (error) {
      rejectSafe(error);
    }
  });

const extractErrorText = (error) => {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error.trim();
  }
  const text = String(error.errMsg || error.message || error.msg || "").trim();
  if (text) {
    return text;
  }
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
};

// const normalizeNotifyText = (text, maxChars = MAX_NOTIFY_RECORD_CHARS) => {
//   const source = String(text || "").replace(/\u0000/g, "");
//   const limit = Math.max(64, Math.floor(toNumber(maxChars, MAX_NOTIFY_RECORD_CHARS)));
//   if (!source) {
//     return "";
//   }
//   return source.length <= limit ? source : source.slice(-limit);
// };


// 确保 normalizeNotifyText 不会截断数据
const normalizeNotifyText = (text, maxLength) => {
  if (!text) return "";
  // 如果 maxLength 太小，会增加截断
  // 建议：如果超过 maxLength，不要截断，而是返回原文本
  if (maxLength && text.length > maxLength) {
    console.warn(`[WARN] 文本被截断: ${text.length} > ${maxLength}`);
    return text; // 不截断，或者返回 text.slice(0, maxLength)
  }
  return text;
};


const looksLikeStructuredNotifyText = (text) => {
  const source = String(text || "");
  return !!source && /[0-9]/.test(source);
};

const insertNewlineBeforeRoleMarkers = (text) => {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }
  const cleaned = source.replace(/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}\s+/i, "");
  return cleaned.replace(/\s*\|\s*/g, "\n");
};

const createWearableDeviceSdk = (options = {}) => {
  const parserModeRaw = String(options.parserMode || "json_line").trim().toLowerCase();
  const parserMode = ["json_line", "auto", "kv_text", "csv_text"].includes(parserModeRaw)
    ? parserModeRaw
    : "auto";
  const config = {
    transport: String(options.transport || "ble").trim().toLowerCase(),
    parserMode,
    // Prefer explicit multi-node collection; single-host mode must be enabled explicitly.
    preferSingleHostStream:
      options.preferSingleHostStream === true
      || String(options.preferSingleHostStream || "").trim().toLowerCase() === "true"
      || String(options.preferSingleHostStream || "").trim() === "1",
    // In single-host mode, try several top-ranked gateway candidates to avoid binding a wrong/non-connectable id.
    hostCandidateCount: Math.max(1, Math.min(5, Math.floor(toNumber(options.hostCandidateCount, 3)))),
    // In fallback mode, try several top-ranked candidates as head to improve connection success.
    fallbackCandidateCount: Math.max(1, Math.min(5, Math.floor(toNumber(options.fallbackCandidateCount, 3)))),
    collectTimeoutMs: Math.max(3000, toNumber(options.collectTimeoutMs, DEFAULT_COLLECT_TIMEOUT_MS)),
    sampleIntervalMs: Math.max(20, toNumber(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS)),
    roleSampleMaxAgeMs: Math.max(200, toNumber(options.roleSampleMaxAgeMs, DEFAULT_ROLE_SAMPLE_MAX_AGE_MS)),
    discoveryTimeoutMs: Math.max(3000, toNumber(options.discoveryTimeoutMs, 8000)),
    connectTimeoutMs: Math.max(15000, toNumber(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)),
    expectedRoles: (Array.isArray(options.expectedRoles) ? options.expectedRoles : SENSOR_ROLES)
      .map((item) => normalizeRole(item))
      .filter(Boolean),
    notifyServiceUUID: String(options.notifyServiceUUID || "").trim(),
    notifyCharacteristicUUID: String(options.notifyCharacteristicUUID || "").trim(),
    writeServiceUUID: String(options.writeServiceUUID || "").trim(),
    writeCharacteristicUUID: String(options.writeCharacteristicUUID || "").trim(),
    requestMtu: options.requestMtu !== false,
    preferredMtu: Math.max(23, Math.min(247, Math.floor(toNumber(options.preferredMtu, 247)))),
    preferredDeviceId: String(options.preferredDeviceId || "").trim(),
    preferredDeviceIdPrefix: String(options.preferredDeviceIdPrefix || "").trim(),
    strictPreferredDevice:
      options.strictPreferredDevice === true
      || String(options.strictPreferredDevice || "").trim().toLowerCase() === "true"
      || String(options.strictPreferredDevice || "").trim() === "1",
    startCommand: String(options.startCommand || "").trim(),
    stopCommand: String(options.stopCommand || "").trim(),
    roleByDeviceId: options.roleByDeviceId && typeof options.roleByDeviceId === "object"
      ? options.roleByDeviceId
      : {},
    roleByDeviceName: options.roleByDeviceName && typeof options.roleByDeviceName === "object"
      ? options.roleByDeviceName
      : {},
    roleNamePatterns: buildRoleNamePatterns(options.roleNamePatterns),
  };

  const state = {
    initialized: false,
    adapterReady: false,
    discovering: false,
    connected: false,
    connectFailureCount: 0,
    connectPromise: null,
    roleDeviceMap: new Map(),
    deviceRoleMap: new Map(),
    latestSampleByRole: new Map(),
    discoveredDevices: new Map(),
    writeChannelByDevice: new Map(),
    notifyTextBufferByDevice: new Map(),
    notifyCount: 0,
    parsedEntryCount: 0,
    parsedRoleCount: new Map(),
    lastParsedRoles: [],
    lastNotifyAt: 0,
    lastChunkPreview: "",
    _lastConnectedDeviceId: "",
    _lastConnectedServiceId: "",
    _lastConnectedCharId: "",
  };

  const stickyRoleBindings = new Map();
  Object.keys(config.roleByDeviceId).forEach((deviceId) => {
    const role = normalizeRole(config.roleByDeviceId[deviceId]);
    const safeDeviceId = String(deviceId || "").trim();
    if (!safeDeviceId) {
      return;
    }
    if (!role) {
      return;
    }
    stickyRoleBindings.set(safeDeviceId, role);
    state.deviceRoleMap.set(safeDeviceId, role);
  });

  const resetDynamicRoleBindings = () => {
    state.deviceRoleMap.clear();
    stickyRoleBindings.forEach((role, deviceId) => {
      if (deviceId && role) {
        state.deviceRoleMap.set(deviceId, role);
      }
    });
  };

  const resetRuntimeStreamState = () => {
    state.latestSampleByRole.clear();
    state.notifyTextBufferByDevice.clear();
    state.notifyCount = 0;
    state.parsedEntryCount = 0;
    state.parsedRoleCount.clear();
    state.lastParsedRoles = [];
    state.lastNotifyAt = 0;
    state.lastChunkPreview = "";
  };

  const setRawDataCallback = (callback) => {
    state.rawDataCallback = typeof callback === "function" ? callback : null;
  };

  const roleNameMap = {};
  Object.keys(config.roleByDeviceName).forEach((name) => {
    const role = normalizeRole(config.roleByDeviceName[name]);
    if (role) {
      roleNameMap[String(name).trim().toLowerCase()] = role;
    }
  });

  const parseNotifyTextPayload = (text, fallbackRole) => {
    const sourceText = String(text || "");
    const parseJsonRecords = () => {
      const records = parseJsonLines(sourceText);
      if (!records.length) {
        return [];
      }

      const collectRoleEntries = (record, timestamp) => {
        const safeRecord = record && typeof record === "object" ? record : {};
        const containerCandidates = [];
        const points = safeRecord.points && typeof safeRecord.points === "object" ? safeRecord.points : null;
        const packed = safeRecord.p && typeof safeRecord.p === "object" ? safeRecord.p : null;
        if (points) {
          containerCandidates.push(points);
        }
        if (packed) {
          containerCandidates.push(packed);
        }
        containerCandidates.push(safeRecord);

        const map = {};
        containerCandidates.forEach((container) => {
          const safeContainer = container && typeof container === "object" ? container : {};
          Object.keys(safeContainer).forEach((key) => {
            const role = resolveRoleToken(key, "");
            if (!role || map[role]) {
              return;
            }
            const value = safeContainer[key];
            const pairEntries = Array.isArray(value)
              ? buildEntriesFromRoleToken({
                  roleToken: key,
                  numericValues: value,
                  fallbackRole: "",
                  timestamp,
                })
              : [];
            let point = null;
            if (Array.isArray(value)) {
              point = vectorFromNumberList(value);
            } else if (value && typeof value === "object") {
              point = normalizeVector(value);
            }
            if (!point) {
              return;
            }
            map[role] = {
              role,
              t: timestamp,
              point,
            };
          });
        });

        return Object.keys(map).map((role) => map[role]);
      };

        const entries = [];
        records.forEach((item, index) => {
          const safe = item && typeof item === "object" ? item : {};
          const timestamp = Math.round(toNumber(firstDefined(safe.t, safe.ts, safe.timestamp), Date.now() + index));
        const multiEntries = collectRoleEntries(safe, timestamp);
        if (multiEntries.length) {
          entries.push(...multiEntries);
          return;
        }
        const explicitRole = normalizeRole(safe.role || safe.name || safe.deviceRole || safe.id);
        const hasVectorHints =
          safe.ax !== undefined || safe.ay !== undefined || safe.az !== undefined
          || safe.gx !== undefined || safe.gy !== undefined || safe.gz !== undefined
          || safe.accX !== undefined || safe.accY !== undefined || safe.accZ !== undefined
          || safe.gyroX !== undefined || safe.gyroY !== undefined || safe.gyroZ !== undefined
          || safe.x !== undefined || safe.y !== undefined || safe.z !== undefined
          || safe.wx !== undefined || safe.wy !== undefined || safe.wz !== undefined;
        const role = explicitRole || (hasVectorHints ? normalizeRole(fallbackRole) : "");
        if (!role || !hasVectorHints) {
          return;
        }
        entries.push({
          role,
          t: timestamp,
          point: normalizeVector(safe),
        });
      });
      return entries;
    };

    if (config.parserMode === "kv_text") {
      const taggedEntries = parseRoleTaggedPipeSegments(sourceText);
      if (taggedEntries.length) {
        return taggedEntries;
      }
      const orderedEntries = parseOrderedRoleNumericStream(sourceText, config.expectedRoles);
      if (orderedEntries.length) {
        return orderedEntries;
      }
      const kvEntries = parseKeyValueSegments(sourceText, fallbackRole);
      if (kvEntries.length) {
        return kvEntries;
      }
      return parseCsvSegments(sourceText, fallbackRole);
    }

    if (config.parserMode === "csv_text") {
      const taggedEntries = parseRoleTaggedPipeSegments(sourceText);
      if (taggedEntries.length) {
        return taggedEntries;
      }
      const orderedEntries = parseOrderedRoleNumericStream(sourceText, config.expectedRoles);
      if (orderedEntries.length) {
        return orderedEntries;
      }
      return parseCsvSegments(sourceText, fallbackRole);
    }

    const jsonEntries = parseJsonRecords();
    if (jsonEntries.length) {
      return jsonEntries;
    }

    if (config.parserMode === "json_line" || config.parserMode === "auto") {
      const taggedEntries = parseRoleTaggedPipeSegments(sourceText);
      if (taggedEntries.length) {
        return taggedEntries;
      }
      const orderedEntries = parseOrderedRoleNumericStream(sourceText, config.expectedRoles);
      if (orderedEntries.length) {
        return orderedEntries;
      }
      const kvEntries = parseKeyValueSegments(sourceText, fallbackRole);
      if (kvEntries.length) {
        return kvEntries;
      }
      return parseCsvSegments(sourceText, fallbackRole);
    }

    return [];
  };

  const parseNotifyPayload = (buffer, fallbackRole) => {
    const text = decodeArrayBufferToText(buffer);
    return parseNotifyTextPayload(text, fallbackRole);
  };



  const onCharacteristicValueChange = (event) => {
    const deviceId = String(event && event.deviceId ? event.deviceId : "").trim();
    if (!deviceId) {
      return;
    }
    const notifyData = event && event.value;
    const byteLength = notifyData && typeof notifyData.byteLength === "number" ? notifyData.byteLength : 0;
    const chunkTextRaw = decodeArrayBufferToText(notifyData);
    const chunkText = normalizeNotifyText(chunkTextRaw, MAX_NOTIFY_CHUNK_CHARS);
    state.notifyCount += 1;
    console.log("[BLE RAW] pkt#" + state.notifyCount, "byteLen:", byteLength, deviceId, "raw:", chunkTextRaw);
    if (state.rawDataCallback) {
      try {
        state.rawDataCallback({
          deviceId,
          raw: chunkTextRaw,
          normalized: chunkText,
          timestamp: Date.now(),
        });
      } catch (e) {}
    }
    state.lastNotifyAt = Date.now();
    state.lastChunkPreview = String(chunkText || bufferToHexPreview(notifyData, 80)).slice(-240);

    const previous = normalizeNotifyText(
      state.notifyTextBufferByDevice.get(deviceId) || "",
      MAX_NOTIFY_TEXT_BUFFER_CHARS
    );
    const merged = normalizeNotifyText(
      `${previous}${chunkText || ""}`,
      MAX_NOTIFY_MERGED_TEXT_CHARS
    );
    console.log("[BLE MERGE] pkt#" + state.notifyCount, "previousLen:", previous.length, "newLen:", chunkText.length, "mergedLen:", merged.length, "has4A:", merged.indexOf("4A") >= 0, "has4B:", merged.indexOf("4B") >= 0);
    const markerSplitRegex = /(\u4e3b\u673a|host|[0-8][ab]|[0-8]|slave[0-8]|node[0-8]|imu[0-8]|s[0-8]|n[0-8])\s*[\u003a\uff1a]/ig;
    const cleaned = String(merged)
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .replace(/[0-9a-f]{2}(?::[0-9a-f]{2}){5}\s*/gi, "")
      .replace(markerSplitRegex, (full, token, offset) => `${offset > 0 ? " | " : ""}${token}:`)
      .trim();
    if (!cleaned) {
      return;
    }

    // Stable marker parser for payload like:
    // HOST:...|1A:...|1B:...|2A:...|...
    // Parse first and short-circuit to avoid downstream fragile branches.
    {
      const markerRegex = /(host|\u4e3b\u673a|[0-8][ab]|[0-8]|slave[0-8]|node[0-8]|imu[0-8]|s[0-8]|n[0-8])\s*[:：]/ig;
      const markers = [];
      let match = markerRegex.exec(cleaned);
      while (match) {
        markers.push({
          token: String(match[1] || "").trim(),
          index: match.index,
          bodyStart: match.index + match[0].length,
        });
        match = markerRegex.exec(cleaned);
      }

      if (markers.length) {
        const now = Date.now();
        const entries = [];
        let pendingTail = "";
        console.log("[BLE MARKERS] pkt#" + state.notifyCount, "markers:", markers.map(m => m.token).join(","));

        markers.forEach((item, index) => {
          const next = markers[index + 1];
          const bodyRaw = cleaned.slice(item.bodyStart, next ? next.index : cleaned.length);
          const body = String(bodyRaw || "").replace(/^\s*\|+/, "").replace(/\|+\s*$/, "").trim();
          if (!body) {
            if (!next) {
              pendingTail = normalizeNotifyText(cleaned.slice(item.index), MAX_NOTIFY_TEXT_BUFFER_CHARS);
            }
            return;
          }
          const numbers = (body.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [])
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x));
          if (numbers.length < 6) {
            if (!next) {
              pendingTail = normalizeNotifyText(cleaned.slice(item.index), MAX_NOTIFY_TEXT_BUFFER_CHARS);
            }
            return;
          }
          const mapped = buildEntriesFromRoleToken({
            roleToken: item.token,
            numericValues: numbers,
            fallbackRole: "",
            timestamp: now + index,
          });
          if (mapped.length) {
            entries.push(...mapped);
          }
        });

        state.notifyTextBufferByDevice.set(deviceId, pendingTail);
        console.log("[BLE RESULT] pkt#" + state.notifyCount, "entries:", entries.length, "pendingTail:", pendingTail ? pendingTail.length : 0);
        if (entries.length) {
          const validEntries = entries.filter((item) => item && item.role && item.point);
          validEntries.forEach((item) => {
            state.latestSampleByRole.set(item.role, {
              t: item.t,
              point: item.point,
            });
            state.parsedRoleCount.set(item.role, toNumber(state.parsedRoleCount.get(item.role), 0) + 1);
          });
          state.parsedEntryCount += validEntries.length;
          state.lastParsedRoles = Array.from(new Set(validEntries.map((item) => item && item.role).filter(Boolean)));
          return;
        }
      }
    }

    const pipeSegments = cleaned.split(/\s*\|\s*/).filter(Boolean);
    if (!pipeSegments.length) {
      return;
    }
    const now = Date.now();
    const entries = [];
    const segmentCount = pipeSegments.length;
    pipeSegments.forEach((seg, index) => {
      const isLast = index === segmentCount - 1;
      const colonAscii = seg.indexOf(":");
      const colonFull = seg.indexOf("：");
      let colonIdx = -1;
      if (colonAscii >= 0 && colonFull >= 0) {
        colonIdx = Math.min(colonAscii, colonFull);
      } else if (colonAscii >= 0) {
        colonIdx = colonAscii;
      } else {
        colonIdx = colonFull;
      }
      if (colonIdx <= 0) {
        if (isLast && segmentCount > 1) {
          state.notifyTextBufferByDevice.set(
            deviceId,
            normalizeNotifyText(seg, MAX_NOTIFY_TEXT_BUFFER_CHARS)
          );
        }
        return;
      }
      const token = seg.slice(0, colonIdx).trim();
      const body = seg.slice(colonIdx + 1).trim();
      if (!token || !body) {
        return;
      }
      const numbers = (body.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [])
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
      if (numbers.length < 6) {
        if (isLast && segmentCount > 1) {
          state.notifyTextBufferByDevice.set(
            deviceId,
            normalizeNotifyText(seg, MAX_NOTIFY_TEXT_BUFFER_CHARS)
          );
        }
        return;
      }
      const mapped = buildEntriesFromRoleToken({
        roleToken: token,
        numericValues: numbers,
        fallbackRole: "",
        timestamp: now + index,
      });
      if (mapped.length) {
        entries.push(...mapped);
      }
    });
    if (!entries.length) {
      return;
    }
    const validEntries = entries.filter((item) => item && item.role && item.point);
    validEntries.forEach((item) => {
      state.latestSampleByRole.set(item.role, {
        t: item.t,
        point: item.point,
      });
      state.parsedRoleCount.set(item.role, toNumber(state.parsedRoleCount.get(item.role), 0) + 1);
    });
    state.parsedEntryCount += validEntries.length;
    state.lastParsedRoles = Array.from(new Set(validEntries.map((item) => item && item.role).filter(Boolean)));
  };





function processCompleteData(deviceId, data) {
    console.log("\n========== 解析数据 ==========");
    
    // 按 | 分割
    const parts = data.split('|');
    const result = {};
    
    for (const part of parts) {
        if (!part.trim()) continue;
        
        // 解析 MAC
        const macMatch = part.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
        if (macMatch) {
            result.mac = macMatch[1];
        }
        
        // 解析节点数据
        const colonIndex = part.indexOf(':');
        if (colonIndex > 0) {
            let nodeName = part.substring(0, colonIndex).trim();
            const nodeValues = part.substring(colonIndex + 1);
            
            // 标准化节点名称
            nodeName = nodeName.toUpperCase();
            
            if (['HOST', '1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'].includes(nodeName)) {
                result[nodeName] = parseNodeValues(nodeValues);
                console.log(`✅ ${nodeName}: ${nodeValues}`);
            }
        }
    }
    
    // 统计
    const expectedNodes = ['HOST', '1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'];
    let receivedCount = 0;
    for (const node of expectedNodes) {
        if (result[node]) receivedCount++;
    }
    console.log(`📊 统计: 收到 ${receivedCount}/9 个节点`);
    console.log("==========================================\n");
    
    // 回调处理
    if (state.onDataComplete) {
        state.onDataComplete(result);
    }
}

// 处理不完整数据
function processIncompleteData(deviceId, data) {
    console.log(`[INCOMPLETE] 处理不完整数据 (${data.length} chars)`);
    
    const parts = data.split('|');
    const result = {};
    
    for (const part of parts) {
        const colonIndex = part.indexOf(':');
        if (colonIndex > 0) {
            const nodeName = part.substring(0, colonIndex).trim().toUpperCase();
            const nodeValues = part.substring(colonIndex + 1);
            
            if (['HOST', '1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'].includes(nodeName)) {
                result[nodeName] = parseNodeValues(nodeValues);
                console.log(`[INCOMPLETE] 解析到 ${nodeName}`);
            }
        }
    }
    
    if (state.onPartialData) {
        state.onPartialData(result);
    }
}

// 解析节点数值
function parseNodeValues(valueStr) {
    const cleaned = valueStr
        .replace(/(\d+\.\d{2})(\d+\.\d{2})/g, '$1, $2')
        .replace(/(\d+\.\d{2})(\d)/g, '$1, 0.0$2')
        .trim();
    
    const parts = cleaned.split(',').map(s => parseFloat(s.trim()));
    const values = [];
    
    for (let i = 0; i < 6; i++) {
        values.push(isNaN(parts[i]) ? 0 : parts[i]);
    }
    
    return { v1: values[0], v2: values[1], v3: values[2], v4: values[3], v5: values[4], v6: values[5] };
}

// 清空缓冲区
function clearNotifyBuffer(deviceId) {
    if (deviceId) {
        notifyBufferByDevice.delete(deviceId);
        if (bufferTimers && bufferTimers.has(deviceId)) {
            clearTimeout(bufferTimers.get(deviceId));
            bufferTimers.delete(deviceId);
        }
    } else {
        notifyBufferByDevice.clear();
        if (bufferTimers) {
            bufferTimers.forEach((timer, id) => clearTimeout(timer));
            bufferTimers.clear();
        }
    }
    console.log("[BUFFER] 缓冲区已清空");
}
  
  const onBluetoothDeviceFound = (event) => {
    const list = event && Array.isArray(event.devices) ? event.devices : [];
    list.forEach((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const deviceId = String(safe.deviceId || "").trim();
      if (!deviceId) {
        return;
      }
      state.discoveredDevices.set(deviceId, safe);
      if (state.deviceRoleMap.has(deviceId)) {
        return;
      }
      const role = resolveRoleFromName(
        safe.name || safe.localName || "",
        roleNameMap,
        config.roleNamePatterns
      );
      if (config.preferSingleHostStream && role && role !== "head") {
        return;
      }
      if (role) {
        state.deviceRoleMap.set(deviceId, role);
      }
    });
  };

  const ensureInitialized = () => {
    if (state.initialized) {
      return;
    }
    if (typeof wx.onBLECharacteristicValueChange === "function") {
      wx.onBLECharacteristicValueChange(onCharacteristicValueChange);
    }
    if (typeof wx.onBluetoothDeviceFound === "function") {
      wx.onBluetoothDeviceFound(onBluetoothDeviceFound);
    }
    state.initialized = true;
  };

  const openAdapter = async () => {
    if (state.adapterReady) {
      return;
    }
    await safeCall(wx.openBluetoothAdapter, {}, BLE_API_TIMEOUT_OPEN_ADAPTER_MS);
    state.adapterReady = true;
  };

  const startDiscovery = async () => {
    if (state.discovering) {
      return;
    }
    await safeCall(wx.startBluetoothDevicesDiscovery, {
      allowDuplicatesKey: true,
      powerLevel: "high",
    }, BLE_API_TIMEOUT_DISCOVERY_MS);
    state.discovering = true;
  };

  const stopDiscovery = async () => {
    if (!state.discovering) {
      return;
    }
    await safeCall(wx.stopBluetoothDevicesDiscovery, {}, BLE_API_TIMEOUT_STOP_DISCOVERY_MS).catch(() => null);
    state.discovering = false;
  };

  const closeAdapter = async () => {
    if (typeof wx.closeBluetoothAdapter !== "function") {
      state.adapterReady = false;
      state.discovering = false;
      return;
    }
    await safeCall(wx.closeBluetoothAdapter, {}, BLE_API_TIMEOUT_CLOSE_ADAPTER_MS).catch(() => null);
    state.adapterReady = false;
    state.discovering = false;
  };

  const reopenAdapter = async () => {
    await stopDiscovery().catch(() => null);
    await closeAdapter();
    await delay(280);
    await openAdapter();
  };

  const probeConnectionByServices = async (deviceId) => {
    const safeDeviceId = String(deviceId || "").trim();
    if (!safeDeviceId) {
      return false;
    }
    const res = await safeCall(
      wx.getBLEDeviceServices,
      { deviceId: safeDeviceId },
      BLE_API_TIMEOUT_QUERY_MS
    ).catch(() => null);
    const services = res && Array.isArray(res.services) ? res.services : [];
    return services.length > 0;
  };

  const releaseExistingConnections = async () => {
    const idSet = new Set();
    Array.from(state.deviceRoleMap.keys()).forEach((id) => {
      const safeId = String(id || "").trim();
      if (safeId) {
        idSet.add(safeId);
      }
    });
    Array.from(state.discoveredDevices.keys()).forEach((id) => {
      const safeId = String(id || "").trim();
      if (safeId) {
        idSet.add(safeId);
      }
    });

    const connectedRes = await safeCall(
      wx.getConnectedBluetoothDevices,
      {},
      BLE_API_TIMEOUT_QUERY_MS
    ).catch(() => null);
    const connectedList = connectedRes && Array.isArray(connectedRes.devices)
      ? connectedRes.devices
      : [];
    connectedList.forEach((item) => {
      const safeId = String(item && item.deviceId ? item.deviceId : "").trim();
      if (safeId) {
        idSet.add(safeId);
      }
    });

    const ids = Array.from(idSet);
    for (let i = 0; i < ids.length; i += 1) {
      const deviceId = ids[i];
      await safeCall(
        wx.closeBLEConnection,
        { deviceId },
        BLE_API_TIMEOUT_CLOSE_CONNECTION_MS
      ).catch(() => null);
    }

    if (state._wifiSocket) {
      try {
        state._wifiSocket.close();
      } catch (e) {}
      state._wifiSocket = null;
    }
  };

  const isLikelyBleTimeoutError = (error) => {
    const text = extractErrorText(error).toLowerCase();
    if (!text) {
      return false;
    }
    return (
      text.includes("timeout")
      || text.includes("timed out")
      || text.includes("status:10008")
      || text.includes("connect fail")
    );
  };

  const ensureConnectWithinDeadline = (deadline) => {
    const safeDeadline = Number(deadline);
    if (!Number.isFinite(safeDeadline) || safeDeadline <= 0) {
      return;
    }
    if (Date.now() > safeDeadline) {
      throw new Error("device_ble_connect_timeout");
    }
  };

  const resolveConnectStepTimeout = (deadline, fallbackMs = BLE_API_TIMEOUT_CREATE_CONNECTION_MS) => {
    const safeDeadline = Number(deadline);
    if (!Number.isFinite(safeDeadline) || safeDeadline <= 0) {
      return Math.max(BLE_CONNECT_STEP_MIN_TIMEOUT_MS, toNumber(fallbackMs, BLE_API_TIMEOUT_CREATE_CONNECTION_MS));
    }
    const remainMs = safeDeadline - Date.now();
    if (!Number.isFinite(remainMs) || remainMs <= 0) {
      return BLE_CONNECT_STEP_MIN_TIMEOUT_MS;
    }
    return Math.max(
      BLE_CONNECT_STEP_MIN_TIMEOUT_MS,
      Math.min(toNumber(fallbackMs, BLE_API_TIMEOUT_CREATE_CONNECTION_MS), Math.floor(remainMs))
    );
  };

  const hydrateDiscoveredDevices = async () => {
    const res = await safeCall(wx.getBluetoothDevices, {}, BLE_API_TIMEOUT_QUERY_MS).catch(() => null);
    const list = res && Array.isArray(res.devices) ? res.devices : [];
    list.forEach((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const deviceId = String(safe.deviceId || "").trim();
      if (!deviceId) {
        return;
      }
      state.discoveredDevices.set(deviceId, safe);
      if (state.deviceRoleMap.has(deviceId)) {
        return;
      }
      const role = resolveRoleFromName(
        safe.name || safe.localName || "",
        roleNameMap,
        config.roleNamePatterns
      );
      if (config.preferSingleHostStream && role && role !== "head") {
        return;
      }
      if (role) {
        state.deviceRoleMap.set(deviceId, role);
      }
    });
  };

  const resolveNotifyChannel = async (deviceId) => {
    if (typeof wx.setBLEMTU === "function") {
      try {
        const mtuResult = await safeCall(wx.setBLEMTU, { deviceId, mtu: 512 }, 3000);
        const actualMtu = mtuResult && typeof mtuResult === "object" ? mtuResult.mtu : mtuResult;
        console.log("[BLE setBLEMTU] forced: 512 actual:", actualMtu, deviceId);
        if (typeof wx.onBLEMTUChange === "function") {
          wx.onBLEMTUChange((mtuEvent) => {
            console.log("[BLE MTU] changed:", mtuEvent && mtuEvent.mtu ? mtuEvent.mtu : "unknown", "deviceId:", deviceId);
          });
        }
      } catch (mtuErr) {
        console.log("[BLE setBLEMTU] forced fail:", extractErrorText(mtuErr));
      }
      await delay(150);
    }
    const serviceRes = await safeCall(wx.getBLEDeviceServices, { deviceId }, BLE_API_TIMEOUT_QUERY_MS);
    const services = serviceRes && Array.isArray(serviceRes.services) ? serviceRes.services : [];
    if (!services.length) {
      throw new Error("device_ble_services_empty");
    }

    const orderedServices = [];
    const seenService = new Set();
    const pushService = (item) => {
      const uuid = String(item && item.uuid ? item.uuid : "").trim();
      if (!uuid) {
        return;
      }
      const key = normalizeUuid(uuid);
      if (seenService.has(key)) {
        return;
      }
      seenService.add(key);
      orderedServices.push(item);
    };

    if (config.notifyServiceUUID) {
      const preferred = services.find((item) => uuidEquals(item && item.uuid, config.notifyServiceUUID));
      if (preferred) {
        pushService(preferred);
      }
    }
    services.forEach((item) => pushService(item));

    const failures = [];
    for (let i = 0; i < orderedServices.length; i += 1) {
      const service = orderedServices[i];
      const serviceId = String(service && service.uuid ? service.uuid : "").trim();
      if (!serviceId) {
        continue;
      }
      const charRes = await safeCall(wx.getBLEDeviceCharacteristics, {
        deviceId,
        serviceId,
      }, BLE_API_TIMEOUT_QUERY_MS).catch((e) => {
        failures.push(`${serviceId}:chars:${extractErrorText(e)}`);
        return null;
      });
      const characteristics = charRes && Array.isArray(charRes.characteristics) ? charRes.characteristics : [];
      if (!characteristics.length) {
        continue;
      }

      let characteristic = null;
      if (config.notifyCharacteristicUUID) {
        const exact = characteristics.find((item) => uuidEquals(item && item.uuid, config.notifyCharacteristicUUID)) || null;
        if (exact && exact.uuid) {
          const props = exact && exact.properties ? exact.properties : {};
          if (props.notify || props.indicate) {
            characteristic = exact;
          }
        }
      }
      if (!characteristic) {
        characteristic = characteristics.find((item) => {
          const props = item && item.properties ? item.properties : {};
          return props.notify || props.indicate;
        }) || null;
      }
      if (!characteristic || !characteristic.uuid) {
        continue;
      }

      try {
        await safeCall(wx.notifyBLECharacteristicValueChange, {
          deviceId,
          serviceId,
          characteristicId: characteristic.uuid,
          state: true,
        }, BLE_API_TIMEOUT_NOTIFY_MS);
        return {
          notifyServiceId: serviceId,
          notifyCharacteristicId: characteristic.uuid,
        };
      } catch (error) {
        failures.push(`${serviceId}/${characteristic.uuid}:notify:${extractErrorText(error)}`);
      }
    }

    throw new Error(
      failures.length
        ? `device_ble_notify_channel_unavailable:${failures.join(" | ")}`
        : "device_ble_notify_char_not_found"
    );
  };

  const resolveWriteChannels = async (deviceId, notifyChannel) => {
    const serviceRes = await safeCall(wx.getBLEDeviceServices, { deviceId }, BLE_API_TIMEOUT_QUERY_MS);
    const services = serviceRes && Array.isArray(serviceRes.services) ? serviceRes.services : [];
    const candidates = [];
    const seen = new Set();

    const pushCandidate = (serviceId, characteristicId) => {
      const safeServiceId = String(serviceId || "").trim();
      const safeCharacteristicId = String(characteristicId || "").trim();
      if (!safeServiceId || !safeCharacteristicId) {
        return;
      }
      const key = `${safeServiceId}::${safeCharacteristicId}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({
        serviceId: safeServiceId,
        characteristicId: safeCharacteristicId,
      });
    };

    const collectFromService = async (serviceId, preferredCharacteristicUuid, appendNotifyFallback) => {
      const safeServiceId = String(serviceId || "").trim();
      if (!safeServiceId) {
        return;
      }
      const charRes = await safeCall(wx.getBLEDeviceCharacteristics, {
        deviceId,
        serviceId: safeServiceId,
      }, BLE_API_TIMEOUT_QUERY_MS).catch(() => null);
      const characteristics = charRes && Array.isArray(charRes.characteristics) ? charRes.characteristics : [];
      if (!characteristics.length) {
        return;
      }

      if (preferredCharacteristicUuid) {
        const exact = characteristics.find((item) => uuidEquals(item && item.uuid, preferredCharacteristicUuid));
        if (exact && exact.uuid) {
          pushCandidate(safeServiceId, exact.uuid);
        }
      }

      characteristics.forEach((item) => {
        const props = item && item.properties ? item.properties : {};
        if (props.write || props.writeNoResponse) {
          pushCandidate(safeServiceId, item.uuid);
        }
      });

      if (appendNotifyFallback) {
        const notifyChar = characteristics.find((item) => {
          const props = item && item.properties ? item.properties : {};
          return props.notify || props.indicate;
        });
        if (notifyChar && notifyChar.uuid) {
          pushCandidate(safeServiceId, notifyChar.uuid);
        }
      }
    };

    const configuredWriteService = services.find((item) => uuidEquals(item && item.uuid, config.writeServiceUUID));
    if (configuredWriteService && configuredWriteService.uuid) {
      await collectFromService(
        configuredWriteService.uuid,
        config.writeCharacteristicUUID,
        true
      );
    }

    if (notifyChannel && notifyChannel.notifyServiceId) {
      await collectFromService(
        notifyChannel.notifyServiceId,
        notifyChannel.notifyCharacteristicId || config.notifyCharacteristicUUID,
        true
      );
    }

    for (let i = 0; i < services.length; i += 1) {
      const item = services[i];
      if (!item || !item.uuid) {
        continue;
      }
      await collectFromService(item.uuid, "", false);
    }

    return candidates;
  };

  const sendControlCommand = async ({ deviceId, command, notifyChannel }) => {
    const payload = resolveCommandArrayBuffer(command);
    if (!payload) {
      return false;
    }
    const safeDeviceId = String(deviceId || "").trim();
    if (!safeDeviceId) {
      return false;
    }

    let channels = state.writeChannelByDevice.get(safeDeviceId);
    if (!Array.isArray(channels) || !channels.length) {
      channels = await resolveWriteChannels(safeDeviceId, notifyChannel);
      state.writeChannelByDevice.set(safeDeviceId, channels);
    }
    if (!channels.length) {
      throw new Error("device_ble_write_char_not_found");
    }

    const failedReasons = [];
    for (let i = 0; i < channels.length; i += 1) {
      const channel = channels[i];
      try {
        await safeCall(wx.writeBLECharacteristicValue, {
          deviceId: safeDeviceId,
          serviceId: channel.serviceId,
          characteristicId: channel.characteristicId,
          value: payload,
        }, BLE_API_TIMEOUT_WRITE_MS);
        return true;
      } catch (error) {
        failedReasons.push(
          `${channel.serviceId}/${channel.characteristicId}:${extractErrorText(error)}`
        );
      }
    }

    throw new Error(
      `device_ble_start_command_failed:${failedReasons.join(" | ")}`
    );
  };

  const connectDevice = async (deviceId, role, connectDeadline = 0) => {
    ensureConnectWithinDeadline(connectDeadline);
    const safeDeviceId = String(deviceId || "").trim();
    if (!safeDeviceId) {
      return null;
    }
    if (state.roleDeviceMap.has(role)) {
      return state.roleDeviceMap.get(role);
    }

    const createConnection = () => {
      const stepTimeoutMs = resolveConnectStepTimeout(connectDeadline, BLE_API_TIMEOUT_CREATE_CONNECTION_MS);
      const nativeTimeoutMs = Math.max(
        3000,
        Math.min(BLE_CONNECT_NATIVE_TIMEOUT_MS, Math.max(3000, stepTimeoutMs - 400))
      );
      return safeCall(
        wx.createBLEConnection,
        { deviceId: safeDeviceId, timeout: nativeTimeoutMs },
        stepTimeoutMs
      );
    };
    try {
      ensureConnectWithinDeadline(connectDeadline);
      await createConnection();
    } catch (error) {
      const message = extractErrorText(error).toLowerCase();
      const alreadyConnected =
        message.includes("already") && message.includes("connect");
      if (!alreadyConnected) {
        ensureConnectWithinDeadline(connectDeadline);
        await safeCall(
          wx.closeBLEConnection,
          { deviceId: safeDeviceId },
          BLE_API_TIMEOUT_CLOSE_CONNECTION_MS
        ).catch(() => null);
        await delay(180);
        try {
          ensureConnectWithinDeadline(connectDeadline);
          await createConnection();
        } catch (retryError) {
          const likelyTimeout = isLikelyBleTimeoutError(retryError);
          if (likelyTimeout) {
            ensureConnectWithinDeadline(connectDeadline);
            await safeCall(
              wx.closeBLEConnection,
              { deviceId: safeDeviceId },
              BLE_API_TIMEOUT_CLOSE_CONNECTION_MS
            ).catch(() => null);
            await delay(420);
            try {
              ensureConnectWithinDeadline(connectDeadline);
              await createConnection();
            } catch (retry2Error) {
              ensureConnectWithinDeadline(connectDeadline);
              const connectedAfterRetry2 = await probeConnectionByServices(safeDeviceId);
              if (!connectedAfterRetry2) {
                ensureConnectWithinDeadline(connectDeadline);
                await reopenAdapter().catch(() => null);
                await delay(360);
                try {
                  ensureConnectWithinDeadline(connectDeadline);
                  await createConnection();
                } catch (retry3Error) {
                  ensureConnectWithinDeadline(connectDeadline);
                  const connectedAfterRetry3 = await probeConnectionByServices(safeDeviceId);
                  if (!connectedAfterRetry3) {
                    throw new Error(
                      `device_ble_create_connection_failed:${extractErrorText(error)} | retry:${extractErrorText(retryError)} | retry2:${extractErrorText(retry2Error)} | retry3:${extractErrorText(retry3Error)}`
                    );
                  }
                }
              }
            }
          } else {
            ensureConnectWithinDeadline(connectDeadline);
            const connectedAfterRetry = await probeConnectionByServices(safeDeviceId);
            if (!connectedAfterRetry) {
              throw new Error(
                `device_ble_create_connection_failed:${extractErrorText(error)} | retry:${extractErrorText(retryError)}`
              );
            }
          }
        }
      }
    }
    if (config.requestMtu && typeof wx.setBLEMTU === "function") {
      ensureConnectWithinDeadline(connectDeadline);
      await safeCall(wx.setBLEMTU, {
        deviceId: safeDeviceId,
        mtu: config.preferredMtu,
      }, BLE_API_TIMEOUT_SET_MTU_MS).catch(() => null);
    }
    ensureConnectWithinDeadline(connectDeadline);
    const channel = await resolveNotifyChannel(safeDeviceId);
    const connection = {
      deviceId: safeDeviceId,
      role,
      ...channel,
    };
    if (config.startCommand) {
      ensureConnectWithinDeadline(connectDeadline);
      await sendControlCommand({
        deviceId: safeDeviceId,
        command: config.startCommand,
        notifyChannel: channel,
      });
    }
    state.roleDeviceMap.set(role, connection);
    state.connected = state.roleDeviceMap.size > 0;
    state._lastConnectedDeviceId = safeDeviceId;
    state._lastConnectedServiceId = channel && channel.notifyServiceId ? channel.notifyServiceId : "";
    state._lastConnectedCharId = channel && channel.notifyCharacteristicId ? channel.notifyCharacteristicId : "";
    return connection;
  };

  const connectByWifi = async (connectDeadline) => {
    const wifiHost = String(config.wifiHost || config.serverHost || "192.168.1.100").trim();
    const wifiPort = Math.max(1, Math.min(65535, Math.floor(toNumber(config.wifiPort || config.serverPort || 8080))));
    const wifiPath = String(config.wifiPath || config.serverPath || "/sensor").trim();

    if (!wifiHost) {
      throw new Error("device_wifi_host_not_configured");
    }

    resetDynamicRoleBindings();
    state.roleDeviceMap.clear();
    state.connected = false;
    state.writeChannelByDevice.clear();
    state.discoveredDevices.clear();
    resetRuntimeStreamState();

    const wifiDeviceId = `wifi://${wifiHost}:${wifiPort}`;
    state.deviceRoleMap.set(wifiDeviceId, "head");

    try {
      const url = `http://${wifiHost}:${wifiPort}${wifiPath}/connect`;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("device_wifi_connect_timeout"));
        }, WIFI_API_TIMEOUT_CONNECT_MS);

        wx.request({
          url,
          method: "POST",
          data: {
            roles: config.expectedRoles,
            sampleIntervalMs: config.sampleIntervalMs,
          },
          success: (res) => {
            clearTimeout(timer);
            resolve(res);
          },
          fail: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });

      if (response && response.data && response.data.success) {
        state.roleDeviceMap.set("head", {
          deviceId: wifiDeviceId,
          role: "head",
          wifiHost,
          wifiPort,
          wifiPath,
          connectedAt: Date.now(),
        });
        state.connected = true;
        state.connectFailureCount = 0;
        state._lastConnectedDeviceId = wifiDeviceId;
        console.log("[WIFI] Connected to:", wifiDeviceId);
        startWifiDataStream(wifiHost, wifiPort, wifiPath);
      } else {
        throw new Error("device_wifi_connect_failed");
      }
    } catch (error) {
      state.connectFailureCount = Math.min(8, toNumber(state.connectFailureCount, 0) + 1);
      throw new Error(`device_wifi_connect_failed:${extractErrorText(error)}`);
    }
  };

  const startWifiDataStream = (host, port, path) => {
    const url = `ws://${host}:${port}${path}/stream`;
    let reconnectAttempt = 0;
    const maxReconnectAttempts = 5;

    const connectWs = () => {
      if (!state.connected) return;

      const ws = wx.connectSocket({
        url,
        header: {
          "content-type": "application/json",
        },
        timeout: 5000,
      });

      ws.onOpen(() => {
        console.log("[WIFI WS] Connection opened");
        reconnectAttempt = 0;
      });

      ws.onMessage((event) => {
        const rawData = event && event.data ? String(event.data) : "";
        if (!rawData.trim()) return;

        try {
          const parsed = JSON.parse(rawData);
          const records = Array.isArray(parsed) ? parsed : (parsed.data ? parsed.data : (parsed.records ? parsed.records : []));

          records.forEach((record) => {
            const safe = record && typeof record === "object" ? record : {};
            const role = normalizeRole(safe.role || safe.name || safe.deviceRole || safe.id);
            if (!role) return;

            const timestamp = Math.round(toNumber(firstDefined(safe.t, safe.ts, safe.timestamp), Date.now()));
            const point = normalizeVector(safe);

            state.latestSampleByRole.set(role, { t: timestamp, point });
            state.notifyCount += 1;
            state.parsedEntryCount += 1;
            state.lastNotifyAt = Date.now();

            const roleCount = state.parsedRoleCount.get(role) || 0;
            state.parsedRoleCount.set(role, roleCount + 1);
            state.lastParsedRoles = Array.from(state.parsedRoleCount.keys());
          });
        } catch (e) {
          console.warn("[WIFI WS] Parse error:", e);
        }
      });

      ws.onClose(() => {
        console.log("[WIFI WS] Connection closed");
        if (state.connected && reconnectAttempt < maxReconnectAttempts) {
          reconnectAttempt += 1;
          setTimeout(connectWs, Math.min(5000, reconnectAttempt * 1000));
        } else if (reconnectAttempt >= maxReconnectAttempts) {
          state.connected = false;
        }
      });

      ws.onError((error) => {
        console.error("[WIFI WS] Error:", error);
        state.connected = false;
      });

      state._wifiSocket = ws;
    };

    connectWs();
  };

  const connect = async () => {
    if (state.connectPromise) {
      return state.connectPromise;
    }

    state.connectPromise = (async () => {
      const connectDeadline = Date.now() + config.connectTimeoutMs;

      ensureInitialized();
      ensureConnectWithinDeadline(connectDeadline);

      if (config.transport === "wifi") {
        return await connectByWifi(connectDeadline);
      }

      if (config.transport !== "ble") {
        throw new Error("device_sdk_driver_not_configured");
      }
      if (state.connectFailureCount > 0) {
        await releaseExistingConnections().catch(() => null);
        await reopenAdapter();
        const lastDeviceId = String(state._lastConnectedDeviceId || "").trim();
        if (lastDeviceId) {
          try {
            await safeCall(
              wx.createBLEConnection,
              { deviceId: lastDeviceId, timeout: 5000 },
              8000
            );
            await delay(300);
            if (typeof wx.onBLEMTUChange === "function") {
              wx.onBLEMTUChange((mtuEvent) => {
                console.log("[BLE MTU]", mtuEvent && mtuEvent.mtu ? mtuEvent.mtu : "unknown", "deviceId:", lastDeviceId);
              });
            }
            const services = await safeCall(wx.getBLEDeviceServices, { deviceId: lastDeviceId }, 5000).catch(() => null);
            const serviceList = services && Array.isArray(services.services) ? services.services : [];
            console.log("[BLE SERVICES]", serviceList.map(s => `${s.isPrimary===false?"[secondary]":"[primary]"} ${s.uuid||s.serviceId}`).join(" "));
            if (serviceList.length) {
              let targetServiceId = "";
              if (config.notifyServiceUUID) {
                const found = serviceList.find((s) => {
                  const id = String(s && (s.uuid || s.serviceId) ? (s.uuid || s.serviceId) : "").trim().toLowerCase();
                  return id === String(config.notifyServiceUUID).trim().toLowerCase();
                });
                if (found) {
                  targetServiceId = String(found.uuid || found.serviceId || "").trim();
                }
              }
              if (!targetServiceId) {
                const readable = serviceList.filter((s) => s.isPrimary !== false);
                targetServiceId = String(readable[0] && (readable[0].uuid || readable[0].serviceId) ? (readable[0].uuid || readable[0].serviceId) : "").trim();
              }
              if (targetServiceId) {
                const chars = await safeCall(
                  wx.getBLEDeviceCharacteristics,
                  { deviceId: lastDeviceId, serviceId: targetServiceId },
                  5000
                ).catch(() => null);
                const charList = chars && Array.isArray(chars.characteristics) ? chars.characteristics : [];
                console.log("[BLE CHARS] service:", targetServiceId, "list:", charList.map(c => {
                  const props = c && typeof c.properties === "object" ? c.properties : {};
                  const flags = [];
                  if (props.read) flags.push("R");
                  if (props.write) flags.push("W");
                  if (props.notify) flags.push("N");
                  if (props.indicate) flags.push("I");
                  if (props.writeNoResponse) flags.push("WN");
                  return `${c.uuid||c.characteristicId}[${flags.join(",")}]`;
                }).join(" "));
                const notifyChar = charList.find((c) => {
                  const props = c && typeof c.properties === "object" ? c.properties : {};
                  return props.notify === true || props.indicate === true;
                });
                if (notifyChar) {
                  const charId = String(notifyChar.uuid || notifyChar.characteristicId || "").trim();
                  console.log("[BLE SELECTED] charId:", charId);
                  await safeCall(
                    wx.notifyBLECharacteristicValueChange,
                    { deviceId: lastDeviceId, serviceId: targetServiceId, characteristicId: charId, state: true },
                    5000
                  ).catch(() => null);
                  state.roleDeviceMap.set("head", {
                    deviceId: lastDeviceId,
                    role: "head",
                    notifyServiceId: targetServiceId,
                    notifyCharacteristicId: charId,
                  });
                  state.deviceRoleMap.set(lastDeviceId, "head");
                  state.connected = true;
                  state.connectFailureCount = 0;
                  return;
                }
              }
            }
            await safeCall(wx.closeBLEConnection, { deviceId: lastDeviceId }, 5000).catch(() => null);
          } catch (e) {
            await safeCall(wx.closeBLEConnection, { deviceId: lastDeviceId }, 5000).catch(() => null);
          }
        }
      } else {
        await openAdapter();
      }
      ensureConnectWithinDeadline(connectDeadline);
      // Device ids can rotate between scans on some BLE stacks; rebuild bindings each connect attempt.
      resetDynamicRoleBindings();
      state.roleDeviceMap.clear();
      state.connected = false;
      state.writeChannelByDevice.clear();
      state.discoveredDevices.clear();
      resetRuntimeStreamState();
      await startDiscovery();
      const deadline = Math.min(Date.now() + config.discoveryTimeoutMs, connectDeadline);

      while (Date.now() < deadline) {
        ensureConnectWithinDeadline(connectDeadline);
        const knownRoles = Array.from(state.deviceRoleMap.values());
        const needRoles = config.expectedRoles.filter((role) => !knownRoles.includes(role));
        if (!needRoles.length) {
          break;
        }
        await delay(200);
      }
      ensureConnectWithinDeadline(connectDeadline);
      await stopDiscovery();
      if (!state.discoveredDevices.size) {
        await hydrateDiscoveredDevices();
      }
      ensureConnectWithinDeadline(connectDeadline);

      if (state.discoveredDevices.size) {
        const discoveredList = Array.from(state.discoveredDevices.values());
        const ranked = rankDiscoveredDevices(
          discoveredList,
          config.notifyServiceUUID,
          config.preferSingleHostStream,
          config.preferredDeviceId,
          config.preferredDeviceIdPrefix
        );
        let pool = ranked.length ? ranked : discoveredList;
        const hasPreferredTarget =
          !!String(config.preferredDeviceId || "").trim()
          || !!String(config.preferredDeviceIdPrefix || "").trim();
        if (hasPreferredTarget) {
          const preferredPool = pool.filter((item) =>
            deviceMatchesPreferredTarget(
              item,
              config.preferredDeviceId,
              config.preferredDeviceIdPrefix
            )
          );
          if (!preferredPool.length) {
            const likelySensorPool = pool.filter((item) => {
              const name = getDeviceNameLower(item);
              return isLikelySensorDeviceName(name) || hasAdvertisedService(item, config.notifyServiceUUID);
            });
            if (likelySensorPool.length) {
              // Keep likely sensor devices first, but append other ranked items as fallback.
              pool = mergeDevicesByDeviceId(likelySensorPool, pool);
            } else if (config.strictPreferredDevice) {
              const targetText =
                String(config.preferredDeviceId || "").trim()
                || String(config.preferredDeviceIdPrefix || "").trim()
                || "unknown";
              throw new Error(`device_ble_preferred_not_found:${targetText}`);
            }
          } else {
            pool = preferredPool;
          }
        }
        if (pool.length && state.deviceRoleMap.size) {
          const allowedIdSet = new Set(
            pool
              .map((item) => String(item && item.deviceId ? item.deviceId : "").trim())
              .filter(Boolean)
          );
          Array.from(state.deviceRoleMap.keys()).forEach((deviceId) => {
            const safeId = String(deviceId || "").trim();
            if (safeId && !allowedIdSet.has(safeId)) {
              state.deviceRoleMap.delete(safeId);
            }
          });
        }
        // Bind discovered devices by fallback strategy.
        if (config.preferSingleHostStream) {
          // Single-host topology: always append several top candidates as "head".
          // This avoids hard-failing when a cached/configured id is stale/non-connectable.
          const limit = Math.max(1, Number(config.hostCandidateCount) || 1);
          let added = 0;
          for (let i = 0; i < pool.length && added < limit; i += 1) {
            const item = pool[i];
            const deviceId = String(item && item.deviceId ? item.deviceId : "").trim();
            if (!deviceId || state.deviceRoleMap.has(deviceId)) {
              continue;
            }
            state.deviceRoleMap.set(deviceId, "head");
            added += 1;
          }
          // If only one candidate exists, still ensure a conservative single-role binding.
          if (!state.deviceRoleMap.size && pool.length === 1) {
            const only = pool[0];
            const onlyId = String(only && only.deviceId ? only.deviceId : "").trim();
            if (onlyId) {
              state.deviceRoleMap.set(onlyId, "head");
            }
          }
        } else if (!state.deviceRoleMap.size) {
          // No role-name mapping found: keep conservative single-stream binding instead of
          // assigning random nearby devices to nine body roles.
          const limit = Math.max(1, Number(config.fallbackCandidateCount) || 1);
          let added = 0;
          for (let i = 0; i < pool.length && added < limit; i += 1) {
            const item = pool[i];
            const deviceId = String(item && item.deviceId ? item.deviceId : "").trim();
            if (!deviceId || state.deviceRoleMap.has(deviceId)) {
              continue;
            }
            state.deviceRoleMap.set(deviceId, "head");
            added += 1;
          }
        }
      }

      const entries = Array.from(state.deviceRoleMap.entries());
      if (!entries.length) {
        throw new Error("device_ble_no_role_binding_found");
      }

      const failedReasons = [];
      for (let i = 0; i < entries.length; i += 1) {
        ensureConnectWithinDeadline(connectDeadline);
        const [deviceId, role] = entries[i];
        const remainMs = Math.max(0, connectDeadline - Date.now());
        const remainSlots = Math.max(1, entries.length - i);
        const perDeviceBudgetMs = entries.length === 1
          ? Math.max(8000, Math.min(20000, remainMs))
          : Math.max(5000, Math.min(10000, Math.floor(remainMs / remainSlots)));
        const deviceDeadline = Math.min(connectDeadline, Date.now() + perDeviceBudgetMs);
        try {
          await connectDevice(deviceId, role, deviceDeadline);
        } catch (e) {
          failedReasons.push(`${deviceId}:${extractErrorText(e)}`);
        }
      }

      if (!state.roleDeviceMap.size) {
        const detail = failedReasons.join(" | ");
        throw new Error(detail ? `device_ble_connect_failed:${detail}` : "device_ble_connect_failed");
      }
      state.connected = true;
      state.connectFailureCount = 0;
    })();

    try {
      return await state.connectPromise;
    } catch (error) {
      state.connectFailureCount = Math.min(8, toNumber(state.connectFailureCount, 0) + 1);
      throw error;
    } finally {
      state.connectPromise = null;
    }
  };

  const collectFrames = async (optionsInput = {}) => {
    const optionsSafe = optionsInput && typeof optionsInput === "object" ? optionsInput : {};
    const frameCount = Math.max(1, Math.floor(toNumber(optionsSafe.frameCount, 60)));
    const timeoutMs = Math.max(3000, toNumber(optionsSafe.timeoutMs, config.collectTimeoutMs));
    const sampleIntervalMs = Math.max(20, toNumber(optionsSafe.sampleIntervalMs, config.sampleIntervalMs));
    const onProgress = typeof optionsSafe.onProgress === "function" ? optionsSafe.onProgress : null;
    const roleSampleMaxAgeMs = Math.max(
      200,
      toNumber(optionsSafe.roleSampleMaxAgeMs, config.roleSampleMaxAgeMs)
    );
    const roles = (Array.isArray(optionsSafe.roles) ? optionsSafe.roles : config.expectedRoles)
      .map((item) => normalizeRole(item))
      .filter(Boolean);

    if (!state.connected) {
      await connect();
    }
    if (config.transport !== "wifi") {
      state.latestSampleByRole.clear();

      const lastNotifyAge = state.lastNotifyAt > 0 ? Date.now() - state.lastNotifyAt : 99999;
      if (state.connected && (lastNotifyAge > 3000 || state.notifyCount === 0)) {
        if (!state.adapterReady) {
          try {
            await safeCall(wx.openBluetoothAdapter, { mode: "central" }, 5000);
            state.adapterReady = true;
            await delay(200);
          } catch (e) {}
        }
        state.latestSampleByRole.clear();
        state.notifyTextBufferByDevice.clear();
        const entries = Array.from(state.roleDeviceMap.entries());
        for (let i = 0; i < entries.length; i += 1) {
          const [role, connection] = entries[i];
          const safe = connection && typeof connection === "object" ? connection : {};
          const deviceId = String(safe.deviceId || "").trim();
          const serviceId = String(safe.notifyServiceId || "").trim();
          const charId = String(safe.notifyCharacteristicId || "").trim();
          if (deviceId && serviceId && charId) {
            await safeCall(
              wx.notifyBLECharacteristicValueChange,
              { deviceId, serviceId, characteristicId: charId, state: false },
              2000
            ).catch(() => null);
            await delay(50);
            await safeCall(
              wx.notifyBLECharacteristicValueChange,
              { deviceId, serviceId, characteristicId: charId, state: true },
              2000
            ).catch(() => null);
            if (config.startCommand) {
              try {
                await sendControlCommand({
                  deviceId,
                  command: config.startCommand,
                  notifyChannel: { notifyServiceId: serviceId, notifyCharacteristicId: charId },
                });
              } catch (e) {}
            }
          }
        }
        const waitDeadline = Date.now() + 6000;
        while (Date.now() < waitDeadline && state.notifyCount === 0) {
          await delay(200);
        }
        if (state.notifyCount > 0) {
          await delay(500);
        }
      }
    }

    const frames = [];
    const observedRolesInThisCollect = new Set();
    const collectStartedAt = Date.now();
    let lastProgressEmitAt = 0;
    const emitProgress = (phase, force = false, extra = {}) => {
      if (!onProgress) {
        return;
      }
      const nowTs = Date.now();
      if (!force && nowTs - lastProgressEmitAt < 120) {
        return;
      }
      lastProgressEmitAt = nowTs;
      try {
        onProgress({
          phase: String(phase || "collecting"),
          collectedCount: frames.length,
          frameCount,
          elapsedMs: Math.max(0, nowTs - collectStartedAt),
          notifyCount: toNumber(state.notifyCount, 0),
          parsedEntryCount: toNumber(state.parsedEntryCount, 0),
          parsedRoles: Array.from(state.parsedRoleCount.keys()),
          lastNotifyAt: toNumber(state.lastNotifyAt, 0),
          ...extra,
        });
      } catch (e) {
        // Ignore callback errors from caller to keep collection loop stable.
      }
    };
    emitProgress("prepare", true);
    const deadline = Date.now() + timeoutMs;
    let lastProcessedNotifyCount = 0;
    let lastActiveRoleCount = 0;
    let lastSampleRole = "";
    let lastSamplePoint = null;
    while (Date.now() < deadline && frames.length < frameCount) {
      const nowTs = Date.now();
      const currentNotifyCount = state.notifyCount;
      if (currentNotifyCount === lastProcessedNotifyCount) {
        await delay(sampleIntervalMs);
        continue;
      }
      lastProcessedNotifyCount = currentNotifyCount;
      const frame = {
        t: nowTs,
        points: {},
      };
      const sourceRoles = roles.length ? roles : SENSOR_ROLES;
      sourceRoles.forEach((role) => {
        const sample = state.latestSampleByRole.get(role);
        if (!sample || !sample.point) {
          return;
        }
        const sampleTs = Math.round(toNumber(sample.t, 0));
        if (!sampleTs) {
          return;
        }
        if (nowTs - sampleTs > roleSampleMaxAgeMs) {
          return;
        }
        frame.points[role] = { ...sample.point };
        observedRolesInThisCollect.add(role);
        frame.t = Math.max(frame.t, sampleTs);
      });
      const roleKeys = Object.keys(frame.points);
      lastActiveRoleCount = roleKeys.length;
      if (roleKeys.length) {
        lastSampleRole = String(roleKeys[0] || "").trim();
        lastSamplePoint = lastSampleRole && frame.points[lastSampleRole]
          ? { ...frame.points[lastSampleRole] }
          : null;
        frames.push(frame);
      }
      emitProgress("collecting", false, {
        activeRoleCount: lastActiveRoleCount,
        sampleRole: lastSampleRole,
        samplePoint: lastSamplePoint,
        lastChunkPreview: String(state.lastChunkPreview || "").slice(-120),
      });
      await delay(Math.max(4, sampleIntervalMs - 8));
    }
    const timedOut = Date.now() >= deadline && frames.length < frameCount;
    emitProgress(timedOut ? "timeout" : "done", true, {
      timeoutMs,
      activeRoleCount: lastActiveRoleCount,
      observedRoleCount: observedRolesInThisCollect.size,
      observedRoles: Array.from(observedRolesInThisCollect),
      sampleRole: lastSampleRole,
      samplePoint: lastSamplePoint,
      lastChunkPreview: String(state.lastChunkPreview || "").slice(-120),
    });
    if (!observedRolesInThisCollect.size) {
      return frames;
    }
    const allowedRoles = new Set(Array.from(observedRolesInThisCollect));
    return frames
      .map((frame) => {
        const safe = frame && typeof frame === "object" ? frame : {};
        const sourcePoints = safe.points && typeof safe.points === "object" ? safe.points : {};
        const points = {};
        Object.keys(sourcePoints).forEach((role) => {
          if (allowedRoles.has(role)) {
            points[role] = sourcePoints[role];
          }
        });
        return {
          t: toNumber(safe.t, 0),
          points,
        };
      })
      .filter((item) => item && item.points && Object.keys(item.points).length > 0);
  };

  const setRoleBinding = (deviceId, role) => {
    const safeId = String(deviceId || "").trim();
    const safeRole = normalizeRole(role);
    if (!safeId || !safeRole) {
      return false;
    }
    stickyRoleBindings.set(safeId, safeRole);
    state.deviceRoleMap.set(safeId, safeRole);
    return true;
  };

  const injectSample = (role, point, timestamp) => {
    const safeRole = normalizeRole(role);
    if (!safeRole) {
      return false;
    }
    state.latestSampleByRole.set(safeRole, {
      t: Math.round(toNumber(timestamp, Date.now())),
      point: normalizeVector(point),
    });
    return true;
  };

  const getState = () => {
    const connectedDevices = Array.from(state.roleDeviceMap.entries()).map(([role, connection]) => {
      const safeConnection = connection && typeof connection === "object" ? connection : {};
      const deviceId = String(safeConnection.deviceId || "").trim();
      const discovered = deviceId ? (state.discoveredDevices.get(deviceId) || {}) : {};
      return {
        role: String(role || "").trim(),
        deviceId,
        name: String(discovered.name || discovered.localName || "").trim(),
        localName: String(discovered.localName || "").trim(),
        notifyServiceId: String(safeConnection.notifyServiceId || "").trim(),
        notifyCharacteristicId: String(safeConnection.notifyCharacteristicId || "").trim(),
      };
    });

    return {
      connected: state.connected,
      adapterReady: state.adapterReady,
      discovering: state.discovering,
      discoveredDeviceIds: Array.from(state.discoveredDevices.keys()),
      connectedRoles: Array.from(state.roleDeviceMap.keys()),
      connectedDevices,
      boundDevices: Array.from(state.deviceRoleMap.entries()).map(([deviceId, role]) => ({ deviceId, role })),
      notifyCount: state.notifyCount,
      parsedEntryCount: state.parsedEntryCount,
      parsedRoles: Array.from(state.parsedRoleCount.entries()).map(([role, count]) => ({
        role,
        count: toNumber(count, 0),
      })),
      lastParsedRoles: Array.isArray(state.lastParsedRoles) ? state.lastParsedRoles.slice() : [],
      lastNotifyAt: state.lastNotifyAt || 0,
      lastChunkPreview: String(state.lastChunkPreview || ""),
    };
  };

  return {
    isConnected: () => !!state.connected,
    connect,
    collectFrames,
    setRoleBinding,
    injectSample,
    getState,
    setRawDataCallback,
  };
};

module.exports = {
  createWearableDeviceSdk,
  SENSOR_ROLES,
};
