const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

const ALLOWED_COLLECTIONS = new Set([
  "trainingRecords",
  "student_action_predictions",
]);

const toPlainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = String(wxContext.OPENID || "").trim();

  if (!openid) {
    return {
      ok: false,
      code: "no_openid",
      message: "no openid",
    };
  }

  const userRes = await db.collection("users").where({ openid }).limit(1).get();
  const user = userRes.data && userRes.data[0];

  if (!user) {
    return {
      ok: false,
      code: "user_not_found",
      message: "user not found",
    };
  }

  const isCoach = String(user.role || "").trim() === "coach";
  const isAdmin = user.adminAccess === true;
  if (!isCoach && !isAdmin) {
    return {
      ok: false,
      code: "permission_denied",
      message: "current user is not coach or admin",
    };
  }

  const collectionName = String(event.collectionName || "trainingRecords").trim();
  if (!ALLOWED_COLLECTIONS.has(collectionName)) {
    return {
      ok: false,
      code: "invalid_collection",
      message: "collection is not allowed",
    };
  }

  const now = new Date();
  const record = toPlainObject(event.record);
  const frames = Array.isArray(event.frames) ? event.frames : [];
  const result = toPlainObject(event.result);
  const deviceInfo = toPlainObject(event.deviceInfo);

  let data;
  if (collectionName === "student_action_predictions") {
    data = {
      ...record,
      userId: String(record.userId || event.userId || "").trim(),
      frameCount: Number(record.frameCount || event.frameCount || frames.length || 0),
      score: Number(record.score || 0),
      scoreColor: String(record.scoreColor || "").trim(),
      quality: String(record.quality || "").trim(),
      qualityClass: String(record.qualityClass || "").trim(),
      confidence: Number(record.confidence || 0),
      comment: String(record.comment || "").trim(),
      payload: record.payload === undefined ? null : record.payload,
      frames,
      frameFileId: String(record.frameFileId || event.frameFileId || "").trim(),
      result,
      deviceInfo,
      source: String(record.source || event.source || "miniapp").trim(),
      coachOpenid: openid,
      coachId: String(user._id || "").trim(),
      coachName: String(user.name || user.nickName || "").trim(),
      createdAt: now,
      updatedAt: now,
    };
  } else {
    data = {
      ...record,
      _openid: openid,
      coachOpenid: openid,
      coachId: String(user._id || "").trim(),
      coachName: String(user.name || user.nickName || "").trim(),
      studentId: String(event.studentId || "").trim(),
      actionName: String(event.actionName || "").trim(),
      result,
      frames,
      deviceInfo,
      source: String(event.source || "miniapp").trim(),
      createdAt: now,
      updatedAt: now,
    };
  }

  const addRes = await db.collection(collectionName).add({ data });

  return {
    ok: true,
    code: "success",
    message: "saved",
    id: addRes._id,
    collectionName,
  };
};
