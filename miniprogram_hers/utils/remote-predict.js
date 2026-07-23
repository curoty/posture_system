const appConfig = require("../config");
const CLOUD_FUNCTION_NAME = "predictAnalysis";

const FULL_BODY_9_ROLES = [
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

function getSensorConfig() {
  return appConfig && appConfig.sensor && typeof appConfig.sensor === "object"
    ? appConfig.sensor
    : {};
}

function shouldUseWaistAsHeadDebug(options) {
  const opts = options || {};
  if (typeof opts.legacy9WaistAsHeadDebug === "boolean") {
    return opts.legacy9WaistAsHeadDebug;
  }
  return getSensorConfig().legacy9WaistAsHeadDebug === true;
}

function adaptFramesForLegacy9Model(frames, options = {}) {
  return (Array.isArray(frames) ? frames : []).map((frame) => {
    const safe = frame && typeof frame === "object" ? frame : {};
    const source =
      safe.points && typeof safe.points === "object" ? safe.points : {};
    const points = {};
    FULL_BODY_9_ROLES.forEach((role) => {
      if (source[role]) points[role] = { ...source[role] };
    });
    return { ...safe, points };
  });
}

function pointHasSignal(point) {
  if (!point) return false;
  let values = [];
  if (Array.isArray(point)) {
    values = point.map(Number);
  } else {
    values = [
      Number(point.ax),
      Number(point.ay),
      Number(point.az),
      Number(point.gx),
      Number(point.gy),
      Number(point.gz),
    ];
  }
  return values.some((v) => Number.isFinite(v) && Math.abs(v) > 1e-6);
}

function validateSensorFramesBeforePredict(frames) {
  if (!Array.isArray(frames) || frames.length < 30) {
    throw new Error(
      `有效帧数不足：${frames?.length || 0}，请先采集更多传感器数据`,
    );
  }
  const roleSignalCount = {};
  FULL_BODY_9_ROLES.forEach((role) => {
    roleSignalCount[role] = 0;
  });
  let validFrames = 0;
  for (const frame of frames) {
    const points = frame?.points || frame?.p || {};
    let frameHasSignal = false;
    FULL_BODY_9_ROLES.forEach((role) => {
      if (pointHasSignal(points[role])) {
        roleSignalCount[role] += 1;
        frameHasSignal = true;
      }
    });
    if (frameHasSignal) validFrames += 1;
  }
  const activeRoles = FULL_BODY_9_ROLES.filter(
    (role) => roleSignalCount[role] > 0,
  );
  const completeFrames = (Array.isArray(frames) ? frames : []).filter((frame) => {
    const points = frame?.points || frame?.p || {};
    return FULL_BODY_9_ROLES.every((role) => pointHasSignal(points[role]));
  }).length;
  const completenessRatio = frames.length ? completeFrames / frames.length : 0;
  if (validFrames < 30 || activeRoles.length < 9 || completenessRatio < 0.7) {
    throw new Error(
      `9节点完整帧不足：${completeFrames}/${frames.length}，节点统计：` +
        JSON.stringify(roleSignalCount),
    );
  }
  return { validFrames, activeRoles, roleSignalCount, completeFrames, completenessRatio };
}

function tryParseDeviceStringToFrame(str, timestamp) {
  if (typeof str !== "string") return null;
  const parts = str.split("|").filter((s) => s && s.trim());
  const points = {};
  parts.forEach((part) => {
    const colon = part.indexOf(":");
    if (colon < 0) return;
    let role = part.substring(0, colon).trim().toUpperCase();
    const valuesStr = part.substring(colon + 1);
    const values = valuesStr.split(",").map((s) => parseFloat(s.trim()) || 0);
    if (values.length < 6) return;
    if (role === "HOST" || role === "0") role = "head";
    else if (role === "1A") role = "left_elbow";
    else if (role === "1B") role = "right_elbow";
    else if (role === "2A") role = "left_wrist";
    else if (role === "2B") role = "right_wrist";
    else if (role === "3A") role = "left_knee";
    else if (role === "3B") role = "right_knee";
    else if (role === "4A") role = "left_foot";
    else if (role === "4B") role = "right_foot";
    points[role.toLowerCase()] = {
      ax: values[0],
      ay: values[1],
      az: values[2],
      gx: values[3],
      gy: values[4],
      gz: values[5],
    };
  });
  if (Object.keys(points).length === 0) return null;
  return {
    t: timestamp || Date.now(),
    points,
  };
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  if (typeof frames[0] === "string") {
    console.warn(`⚠️ frames[0] 是字符串！正在自动转成 points 对象...`);
    const ts = Date.now();
    const result = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = tryParseDeviceStringToFrame(frames[i], ts + i * 50);
      if (frame) result.push(frame);
    }
    console.log(`✅ 字符串转对象成功：${result.length} 帧`);
    console.log("转换后 frame[0]:", JSON.stringify(result[0], null, 2));
    return result;
  }
  return frames;
}

function framesToApiFormat(frames) {
  const list = Array.isArray(frames) ? frames : [];
  return list.map((frame) => {
    const safe = frame && typeof frame === "object" ? frame : {};
    const p = {};
    const points =
      safe.points && typeof safe.points === "object" ? safe.points : {};
    Object.keys(points).forEach((role) => {
      const point = points[role];
      if (point && typeof point === "object") {
        p[role] = [
          Number(point.ax || 0),
          Number(point.ay || 0),
          Number(point.az || 0),
          Number(point.gx || 0),
          Number(point.gy || 0),
          Number(point.gz || 0),
        ];
      }
    });
    return {
      t: Math.round(Number(safe.t || 0)),
      p,
    };
  });
}

function callRemotePredict(options) {
  const opts = options || {};
  const rawList = Array.isArray(opts.frames) ? opts.frames : [];

  if (rawList.length === 0) {
    return Promise.reject(new Error("没有有效的帧数据"));
  }

  console.log(`\n\n========== SDK 输出类型 + 自动转换 ==========`);
  console.log(`输入 frames.length = ${rawList.length}`);
  console.log(`输入 frames[0] typeof = ${typeof rawList[0]}`);
  if (typeof rawList[0] === "string") {
    console.log(`输入字符串样例: ${rawList[0].substring(0, 150)}...`);
  }

  const list = normalizeFrames(rawList);

  if (list.length === 0) {
    return Promise.reject(new Error("帧数据转换后为空，请检查格式"));
  }

  let validationSummary;
  try {
    validationSummary = validateSensorFramesBeforePredict(list);
  } catch (validationError) {
    return Promise.reject(validationError);
  }

  const inferenceList = adaptFramesForLegacy9Model(list);

  if (typeof list[0] === "object" && list[0]) {
    console.log(`✅ 输出对象 keys = ${Object.keys(list[0]).join(", ")}`);
  }

  console.log(
    "SDK 输出 frames[0] (points 嵌套对象格式):",
    JSON.stringify(list[0], null, 2),
  );

  const apiFrames = framesToApiFormat(inferenceList);

  console.log(
    `\n\n========== 转换后大模型训练时的输入格式 (API Format) ==========`,
  );
  console.log(`转换后 apiFrames.length = ${apiFrames.length}`);
  console.log(
    "apiFrames[0] (p 数组格式):",
    JSON.stringify(apiFrames[0], null, 2),
  );

  console.log(
    `\n调用云函数 ${CLOUD_FUNCTION_NAME}，发送格式为 'p' + 数组...\n`,
  );

  return wx.cloud
    .callFunction({
      name: CLOUD_FUNCTION_NAME,
      data: {
        frames: apiFrames,
        sessionId: opts.sessionId || "",
        actionType: opts.actionType || "",
        sensorProfile: "full_body_9_v1",
        activeRoles: validationSummary.activeRoles,
        legacy9WaistAsHeadDebug: false,
      },
    })
    .then((res) => {
      console.log(
        `\n\n========== 云函数 ${CLOUD_FUNCTION_NAME} 返回原始结果 ==========`,
      );
      console.log("云函数完整 res:", JSON.stringify(res, null, 2));

      const result = res && res.result ? res.result : {};
      console.log("解析后的 result:", JSON.stringify(result, null, 2));

      if (!result.success) {
        const errorMsg = result.message || "远程预测失败";
        console.error("云函数返回 success=false:", errorMsg);
        throw new Error(errorMsg);
      }

      const data = result.data || {};
      console.log("result.data:", JSON.stringify(data, null, 2));

      const results = Array.isArray(data.results) ? data.results : [];
      console.log(`最终解析返回 results.length = ${results.length}`);

      if (results.length > 0) {
        console.log("results[0]:", JSON.stringify(results[0], null, 2));
      }

      return {
        results,
        raw: data.raw || null,
        analysis: data.analysis || null,
        sensorProfile: "full_body_9_v1",
        inferenceMode: "full_body_9_remote_model",
        predictionTrusted: true,
      };
    })
    .catch((error) => {
      console.error(`\n\n========== 云函数调用异常 ==========`);
      console.error("异常类型:", error.constructor.name);
      console.error("异常 message:", error.message);
      console.error("异常 errMsg:", error.errMsg);
      console.error("异常 stack:", error.stack);
      throw error;
    });
}

module.exports = {
  FULL_BODY_9_ROLES,
  shouldUseWaistAsHeadDebug,
  adaptFramesForLegacy9Model,
  framesToApiFormat,
  callRemotePredict,
  validateSensorFramesBeforePredict,
};
