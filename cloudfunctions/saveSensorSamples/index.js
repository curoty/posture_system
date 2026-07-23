const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
// 使用项目中已经存在的原始采样集合；四节点数据通过 recordType/layout 区分。
const COLLECTION_NAME = "static_sample_nofiltering";
const FOUR_NODE_ROLES = [
  "left_ankle",
  "right_ankle",
  "left_knee",
  "right_knee",
];
const MAX_CHUNK_FRAMES = 500;

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const resolveCaller = () => {
  const context = cloud.getWXContext();
  const openid = context && context.OPENID ? String(context.OPENID) : "";
  return openid
    ? { success: true, openid }
    : { success: false, message: "operator_openid_required" };
};

const normalizeVector = (value) => {
  const safe = value && typeof value === "object" ? value : {};
  return {
    ax: toNumber(safe.ax),
    ay: toNumber(safe.ay),
    az: toNumber(safe.az),
    gx: toNumber(safe.gx),
    gy: toNumber(safe.gy),
    gz: toNumber(safe.gz),
    temperature_c: toNumber(safe.temperature_c),
  };
};

const normalizeCompositeFrames = (value) => {
  const source = Array.isArray(value) ? value.slice(0, MAX_CHUNK_FRAMES) : [];
  return source
    .map((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const points =
        safe.points && typeof safe.points === "object" ? safe.points : {};
      if (!FOUR_NODE_ROLES.every((role) => points[role])) return null;
      return {
        t: toNumber(safe.t),
        unix_ts_ms: toNumber(safe.unix_ts_ms, toNumber(safe.t)),
        time_synced: safe.time_synced !== false,
        sample_rate_hz: toNumber(safe.sample_rate_hz, 50),
        points: FOUR_NODE_ROLES.reduce((result, role) => {
          result[role] = normalizeVector(points[role]);
          return result;
        }, {}),
        node_seq:
          safe.node_seq && typeof safe.node_seq === "object"
            ? FOUR_NODE_ROLES.reduce((result, role) => {
                result[role] = toNumber(safe.node_seq[role]);
                return result;
              }, {})
            : {},
        node_device_ids:
          safe.node_device_ids && typeof safe.node_device_ids === "object"
            ? FOUR_NODE_ROLES.reduce((result, role) => {
                result[role] = String(safe.node_device_ids[role] || "");
                return result;
              }, {})
            : {},
        node_temperature_c:
          safe.node_temperature_c &&
          typeof safe.node_temperature_c === "object"
            ? FOUR_NODE_ROLES.reduce((result, role) => {
                result[role] = toNumber(safe.node_temperature_c[role]);
                return result;
              }, {})
            : {},
      };
    })
    .filter(Boolean);
};

const makeDocumentId = (kind, captureId, suffix = "") =>
  `${kind}_${captureId}${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "_");

const saveStaticSampleChunk = async (event, caller) => {
  const captureId = String(event.captureId || "").trim();
  const chunkIndex = Math.max(0, Math.floor(toNumber(event.chunkIndex)));
  if (!captureId) {
    return { ok: false, success: false, message: "capture_id_required" };
  }

  const frames = normalizeCompositeFrames(event.frames);
  if (!frames.length) {
    return { ok: false, success: false, message: "complete_frames_required" };
  }
  if (frames.length !== (Array.isArray(event.frames) ? event.frames.length : 0)) {
    return {
      ok: false,
      success: false,
      message: "incomplete_four_node_frame_detected",
    };
  }

  // 确定性文档 ID 让重试天然幂等，只需一次数据库写入；
  // 避免先 get 再 add 超过云函数 3 秒执行上限。
  const documentId = makeDocumentId(
    "four_node_chunk",
    captureId,
    `_${chunkIndex}`,
  );
  await db.collection(COLLECTION_NAME).doc(documentId).set({
    data: {
      recordType: "four_node_static_chunk",
      schemaVersion: 1,
      layout: "four_node_composite_50hz",
      captureId,
      phase: String(event.phase || "").trim(),
      groupNumber: Math.max(1, Math.floor(toNumber(event.groupNumber, 1))),
      durationSeconds: Math.max(1, Math.floor(toNumber(event.durationSeconds, 1))),
      chunkIndex,
      sampleRateHz: toNumber(event.sampleRateHz, 50),
      expectedRoles: FOUR_NODE_ROLES,
      frameCount: frames.length,
      firstTimestampMs: toNumber(frames[0].unix_ts_ms),
      lastTimestampMs: toNumber(frames[frames.length - 1].unix_ts_ms),
      frames,
      softwareFilteringApplied: false,
      filterStatus: "hardware_dlpf_only",
      operatorOpenId: caller.openid,
      createdAt: db.serverDate(),
    },
  });
  return {
    ok: true,
    success: true,
    documentId,
    captureId,
    chunkIndex,
    frameCount: frames.length,
  };
};

const finishStaticSampleCapture = async (event, caller) => {
  const captureId = String(event.captureId || "").trim();
  if (!captureId) {
    return { ok: false, success: false, message: "capture_id_required" };
  }
  const status = String(event.status || "completed").trim();
  const totalFrames = Math.max(0, Math.floor(toNumber(event.totalFrames)));
  const totalChunks = Math.max(0, Math.floor(toNumber(event.totalChunks)));
  const data = {
    recordType: "four_node_static_manifest",
    schemaVersion: 1,
    layout: "four_node_composite_50hz",
    captureId,
    phase: String(event.phase || "").trim(),
    groupNumber: Math.max(1, Math.floor(toNumber(event.groupNumber, 1))),
    durationSeconds: Math.max(1, Math.floor(toNumber(event.durationSeconds, 1))),
    sampleRateHz: toNumber(event.sampleRateHz, 50),
    expectedRoles: FOUR_NODE_ROLES,
    totalFrames,
    totalChunks,
    nodeFrameCounts: FOUR_NODE_ROLES.reduce((result, role) => {
      result[role] = Math.max(
        0,
        Math.floor(toNumber(event.nodeFrameCounts && event.nodeFrameCounts[role])),
      );
      return result;
    }, {}),
    status,
    softwareFilteringApplied: false,
    operatorOpenId: caller.openid,
    updatedAt: db.serverDate(),
  };

  const documentId = makeDocumentId("four_node_manifest", captureId);
  await db.collection(COLLECTION_NAME).doc(documentId).set({
    data: { ...data, createdAt: db.serverDate() },
  });
  return {
    ok: true,
    success: true,
    documentId,
  };
};

exports.main = async (event = {}) => {
  try {
    const caller = resolveCaller();
    if (!caller.success) {
      return { ok: false, success: false, message: caller.message };
    }
    const type = String(event.type || "").trim();
    if (type === "saveStaticSampleChunk") {
      return await saveStaticSampleChunk(event, caller);
    }
    if (type === "finishStaticSampleCapture") {
      return await finishStaticSampleCapture(event, caller);
    }
    return { ok: false, success: false, message: "unsupported_operation" };
  } catch (error) {
    console.error("[saveSensorSamples] failed", error);
    return {
      ok: false,
      success: false,
      message: (error && error.message) || "save_failed",
    };
  }
};
