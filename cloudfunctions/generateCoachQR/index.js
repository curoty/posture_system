const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const USER_COLLECTION = "users";

const normalizeRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  if (role === "admin" || role === "administrator" || role === "管理员" || role === "管理員") {
    return "admin";
  }
  if (role === "coach" || role === "教练" || role === "教練") {
    return "coach";
  }
  if (role === "student" || role === "学员" || role === "學員") {
    return "student";
  }
  return "user";
};

const isValidInviteCode = (value) => /^\d{6}$/.test(String(value || "").trim());

const generateInviteCode = () => String(Math.floor(100000 + Math.random() * 900000));

const findCoachByOpenId = async (openid) => {
  const safeOpenid = String(openid || "").trim();
  if (!safeOpenid) {
    return null;
  }
  const _ = db.command;
  const res = await db.collection(USER_COLLECTION)
    .where(_.or([{ openid: safeOpenid }, { _openid: safeOpenid }]))
    .limit(20)
    .get()
    .catch(() => ({ data: [] }));
  const list = Array.isArray(res && res.data) ? res.data : [];
  return list.find((item) => {
    const role = normalizeRole(item && item.role);
    return role === "coach" || role === "admin";
  }) || null;
};

const queryInviteCodeOwner = async (inviteCode) => {
  const safeCode = String(inviteCode || "").trim();
  if (!isValidInviteCode(safeCode)) {
    return null;
  }
  const _ = db.command;
  const res = await db.collection(USER_COLLECTION)
    .where(_.or([
      { coachInviteCode: safeCode },
      { classCode: safeCode },
      { class_code: safeCode },
    ]))
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const list = Array.isArray(res && res.data) ? res.data : [];
  return list[0] || null;
};

const ensureInviteCode = async (coach) => {
  const currentCode = String(
    coach && (coach.coachInviteCode || coach.classCode || coach.class_code) || ""
  ).trim();
  if (isValidInviteCode(currentCode)) {
    return currentCode;
  }

  let inviteCode = "";
  for (let i = 0; i < 12; i += 1) {
    const candidate = generateInviteCode();
    const existing = await queryInviteCodeOwner(candidate);
    if (!existing || String(existing._id || "").trim() === String(coach && coach._id || "").trim()) {
      inviteCode = candidate;
      break;
    }
  }

  if (!inviteCode) {
    throw new Error("invite_code_generate_failed");
  }

  await db.collection(USER_COLLECTION).doc(coach._id).update({
    data: {
      coachInviteCode: inviteCode,
      classCode: inviteCode,
      class_code: inviteCode,
      updatedAt: db.serverDate(),
    },
  });
  return inviteCode;
};

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext();
    const coach = await findCoachByOpenId(OPENID);
    if (!coach || !coach._id) {
      return { success: false, message: "coach_not_found" };
    }

    const role = normalizeRole(coach.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const inviteCode = await ensureInviteCode(coach);
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: `code=${inviteCode}`,
      page: "pages/student/index/index",
      width: 430,
      autoColor: true,
      isHyaline: false,
      checkPath: false,
    });

    if (!result || !result.buffer) {
      return { success: false, message: "generate_qr_failed" };
    }

    return {
      success: true,
      qrBase64: result.buffer.toString("base64"),
      mimeType: result.contentType || "image/png",
      inviteCode,
    };
  } catch (error) {
    return {
      success: false,
      message: error && error.message ? error.message : "generate_coach_qr_failed",
    };
  }
};
