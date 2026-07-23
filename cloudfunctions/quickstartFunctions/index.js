const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const COMMUNITY_POST_COLLECTION = "community_posts";
const USER_COLLECTION = "users";
const SMS_CODE_COLLECTION = "sms_codes";
const ACTIVITY_COLLECTION = "activities";
const NOTIFICATION_COLLECTION = "notifications";
const TRAINING_REPORT_COLLECTION = "training_reports";
const FLOWER_LOGIC_VERSION = "2026-04-09-flower-student-id-only-v6";
const SCHEDULE_SLOT_COLLECTION = "schedule_slots";
const SCHEDULE_BOOKING_COLLECTION = "schedule_bookings";
const EVENT_COLLECTION = "activity_events";
const CLASS_INVITATION_COLLECTION = "class_invitations";
const CLASSES_COLLECTION = "classes";
const TRANSFERS_COLLECTION = "class_transfers";
const LESSON_TOTAL_FIELD = "lessonTotal";
const LESSON_REMAINING_FIELD = "lessonRemaining";
const LESSON_USED_FIELD = "lessonUsed";
const LEGACY_LESSON_TOTAL_FIELD = "totalLessons";
const LEGACY_LESSON_REMAINING_FIELD = "remainingLessons";
const LEGACY_LESSON_USED_FIELD = "usedLessons";
const ADMIN_OWNER_ID_FIELD = "adminOwnerId";
const ADMIN_OWNER_IDS_FIELD = "adminOwnerIds";
const COMMUNITY_MUTE_THRESHOLD = 3;
const COMMUNITY_MUTE_THRESHOLD_EXTREME = 7;
const COMMUNITY_MUTE_HOURS_BASE = 2;
const COMMUNITY_MUTE_HOURS_SEVERE = 48;
const COMMUNITY_MUTE_HOURS_EXTREME = 24 * 30;
const NOTIFICATION_FETCH_LIMIT = 100;
const TRAINING_REPORT_FETCH_LIMIT = 100;
const SCHEDULE_FETCH_LIMIT = 500;
const SCHEDULE_FETCH_BATCH_SIZE = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_DEFAULT_TITLE = "\u8f6e\u6ed1\u8bad\u7ec3\u8bfe\u7a0b";
const SCHEDULE_COACH_MAX_STUDENTS = 3;
const SCHEDULE_STUDENT_UNLIMITED = true;
const DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_PAGE = "pages/coach/schedule/manage/manage";
const SCHEDULE_BOOKING_SUBSCRIBE_TEMPLATE_ID = String(
  process.env.SCHEDULE_BOOKING_SUBSCRIBE_TEMPLATE_ID || ""
).trim();
const SCHEDULE_BOOKING_SUBSCRIBE_PAGE = String(
  process.env.SCHEDULE_BOOKING_SUBSCRIBE_PAGE || DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_PAGE
)
  .trim()
  .replace(/^\//, "");

const isCollectionNotExistsError = (error) => {
  const text = String(
    (error && (error.message || error.errMsg || error.toString && error.toString()))
    || ""
  ).toLowerCase();
  return text.includes("collection not exists")
    || text.includes("db or table not exist")
    || text.includes("database_collection_not_exist")
    || text.includes("-502005");
};

const isCollectionAlreadyExistsError = (error) => {
  const text = String(
    (error && (error.message || error.errMsg || error.toString && error.toString()))
    || ""
  ).toLowerCase();
  return text.includes("already exists")
    || text.includes("database collection already exists");
};

const parseObjectFromEnv = (raw) => {
  const text = String(raw || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (e) {
    return {};
  }
};

const DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP = {
  studentName: "thing1",
  scheduleTime: "time2",
  courseTitle: "thing3",
  remark: "thing4",
};

const SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP = {
  ...DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP,
  ...parseObjectFromEnv(process.env.SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP),
};

const getOpenId = async () => {
  const wxContext = cloud.getWXContext();
  return {
    openid: wxContext.OPENID,
    appid: wxContext.APPID,
    unionid: wxContext.UNIONID,
  };
};

const getMiniProgramCode = async () => {
  const resp = await cloud.openapi.wxacode.get({
    path: "pages/index/index",
  });
  const { buffer } = resp;
  const upload = await cloud.uploadFile({
    cloudPath: "code.png",
    fileContent: buffer,
  });
  return upload.fileID;
};

const createCollection = async () => {
  try {
    await db.createCollection("sales");
    await db.collection("sales").add({
      data: {
        region: "??",
        city: "??",
        sales: 11,
      },
    });
    await db.collection("sales").add({
      data: {
        region: "??",
        city: "??",
        sales: 11,
      },
    });
    await db.collection("sales").add({
      data: {
        region: "??",
        city: "??",
        sales: 22,
      },
    });
    await db.collection("sales").add({
      data: {
        region: "??",
        city: "??",
        sales: 22,
      },
    });
    return {
      success: true,
    };
  } catch (e) {
    return {
      success: true,
      data: "create collection success",
    };
  }
};

const selectRecord = async () => {
  return await db.collection("sales").get();
};

const updateRecord = async (event) => {
  try {
    for (let i = 0; i < event.data.length; i += 1) {
      await db
        .collection("sales")
        .where({
          _id: event.data[i]._id,
        })
        .update({
          data: {
            sales: event.data[i].sales,
          },
        });
    }
    return {
      success: true,
      data: event.data,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};

const insertRecord = async (event) => {
  try {
    const insertData = event.data;
    await db.collection("sales").add({
      data: {
        region: insertData.region,
        city: insertData.city,
        sales: Number(insertData.sales),
      },
    });
    return {
      success: true,
      data: event.data,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};

const deleteRecord = async (event) => {
  try {
    await db
      .collection("sales")
      .where({
        _id: event.data._id,
      })
      .remove();
    return {
      success: true,
    };
  } catch (e) {
    return {
      success: false,
      errMsg: e,
    };
  }
};

const resolveNumber = (value) => {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num;
};

const hasOwn = (obj, key) =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const toNonNegativeInt = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.floor(n));
};

const normalizeFlowerCount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(5, n));
  return Math.round(clamped * 2) / 2;
};

const sumFlowerCount = (list) => {
  const arr = Array.isArray(list) ? list : [];
  const total = arr.reduce((sum, item) => {
    const count = normalizeFlowerCount(item && item.flowerCount);
    return sum + count;
  }, 0);
  return Math.round(total * 10) / 10;
};

const mapStudentLessonPackage = (userDoc) => {
  const safe = userDoc && typeof userDoc === "object" ? userDoc : {};
  const hasTotal = hasOwn(safe, LESSON_TOTAL_FIELD) || hasOwn(safe, LEGACY_LESSON_TOTAL_FIELD);
  const hasRemaining = hasOwn(safe, LESSON_REMAINING_FIELD) || hasOwn(safe, LEGACY_LESSON_REMAINING_FIELD);
  const hasUsed = hasOwn(safe, LESSON_USED_FIELD) || hasOwn(safe, LEGACY_LESSON_USED_FIELD);
  const enabled = hasTotal || hasRemaining || hasUsed;
  if (!enabled) {
    return {
      enabled: false,
      totalLessons: 0,
      remainingLessons: 0,
      usedLessons: 0,
    };
  }

  const totalSource = hasOwn(safe, LESSON_TOTAL_FIELD) ? safe[LESSON_TOTAL_FIELD] : safe[LEGACY_LESSON_TOTAL_FIELD];
  const usedSource = hasOwn(safe, LESSON_USED_FIELD) ? safe[LESSON_USED_FIELD] : safe[LEGACY_LESSON_USED_FIELD];
  const remainingSource = hasOwn(safe, LESSON_REMAINING_FIELD)
    ? safe[LESSON_REMAINING_FIELD]
    : safe[LEGACY_LESSON_REMAINING_FIELD];

  const total = toNonNegativeInt(totalSource);
  const used = toNonNegativeInt(usedSource);
  const remaining = hasRemaining
    ? toNonNegativeInt(remainingSource)
    : Math.max(0, total - used);
  const normalizedUsed = hasUsed ? used : Math.max(0, total - remaining);
  const normalizedTotal = hasTotal ? total : (remaining + normalizedUsed);

  return {
    enabled: true,
    totalLessons: Math.max(0, normalizedTotal),
    remainingLessons: Math.max(0, remaining),
    usedLessons: Math.max(0, normalizedUsed),
  };
};

const adjustStudentLessonPackage = async (studentId, delta) => {
  const targetStudentId = String(studentId || "").trim();
  if (!targetStudentId) {
    return { success: false, message: "student_id_required" };
  }

  return db.runTransaction(async (transaction) => {
    const studentRes = await transaction.collection(USER_COLLECTION).doc(targetStudentId).get().catch(() => null);
    const student = studentRes && studentRes.data ? studentRes.data : null;
    if (!student) {
      return { success: false, message: "student_not_found" };
    }

    const current = mapStudentLessonPackage(student);
    if (!current.enabled) {
      return { success: false, message: "lesson_quota_not_set" };
    }

    const step = toNonNegativeInt(Math.abs(delta));
    let nextRemaining = current.remainingLessons;
    let nextUsed = current.usedLessons;
    if (delta < 0) {
      if (nextRemaining < step) {
        return { success: false, message: "no_remaining_lessons" };
      }
      nextRemaining -= step;
      nextUsed += step;
    } else if (delta > 0) {
      nextRemaining += step;
      nextUsed = Math.max(0, nextUsed - step);
    }

    const nextTotal = Math.max(current.totalLessons, nextRemaining + nextUsed);
    await transaction.collection(USER_COLLECTION).doc(targetStudentId).update({
      data: {
        [LESSON_TOTAL_FIELD]: nextTotal,
        [LESSON_REMAINING_FIELD]: nextRemaining,
        [LESSON_USED_FIELD]: nextUsed,
        [LEGACY_LESSON_TOTAL_FIELD]: nextTotal,
        [LEGACY_LESSON_REMAINING_FIELD]: nextRemaining,
        [LEGACY_LESSON_USED_FIELD]: nextUsed,
        lessonUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      lessonPackage: {
        enabled: true,
        totalLessons: nextTotal,
        remainingLessons: nextRemaining,
        usedLessons: nextUsed,
      },
    };
  }).catch((e) => ({
    success: false,
    message: e && e.message ? e.message : "adjust_lesson_quota_failed",
    errMsg: e,
  }));
};

const normalizePhone = (phone) => String(phone || "").replace(/\s+/g, "");

const isValidPhone = (phone) => /^1\d{10}$/.test(phone);

const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 32;
const PASSWORD_HASH_ALGO = "sha256";
const PASSWORD_HASH_SALT = String(process.env.PASSWORD_HASH_SALT || "aiwork_pwd_v1").trim();
const DEFAULT_LOGIN_PASSWORD = "123456";

const normalizePassword = (value) => String(value || "").trim();

const isValidPassword = (password) => {
  const text = normalizePassword(password);
  return text.length >= PASSWORD_MIN_LENGTH && text.length <= PASSWORD_MAX_LENGTH;
};

const hashPassword = (password) =>
  crypto
    .createHash(PASSWORD_HASH_ALGO)
    .update(`${PASSWORD_HASH_SALT}:${normalizePassword(password)}`)
    .digest("hex");

const LOGIN_USER_QUERY_FIELDS = {
  _id: true,
  name: true,
  nickName: true,
  phone: true,
  openid: true,
  _openid: true,
  avatarUrl: true,
  role: true,
  status: true,
  level: true,
  adminAccess: true,
  coachId: true,
  coachid: true,
  coachIds: true,
  coachids: true,
  joinDate: true,
  studentSince: true,
  roleUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  passwordHash: true,
};

const TRUE_FLAG_SET = new Set(["1", "true", "yes", "y", "on"]);

const isTrueFlag = (value) => {
  if (value === true) {
    return true;
  }
  if (value === false || value === null || typeof value === "undefined") {
    return false;
  }
  return TRUE_FLAG_SET.has(String(value).trim().toLowerCase());
};

const normalizeRole = (role) => {
  const raw = String(role || "").trim().toLowerCase();
  if (raw === "admin" || raw === "administrator" || raw === "管理员" || raw === "管理員") {
    return "admin";
  }
  if (raw === "coach" || raw === "教练" || raw === "教練") {
    return "coach";
  }
  if (raw === "student" || raw === "学员" || raw === "學員") {
    return "student";
  }
  return "user";
};

const normalizeRoleToken = (value) => {
  const role = normalizeRole(value);
  return role || "";
};

const normalizeRoleArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeRoleToken(item))
    .filter(Boolean);
};

const collectUserRoleTokens = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  return Array.from(new Set([
    normalizeRoleToken(safeUser.role),
    ...normalizeRoleArray(safeUser.roles),
    ...normalizeRoleArray(safeUser.roleList),
    ...normalizeRoleArray(safeUser.permissions),
  ].filter(Boolean)));
};

const hasAdminAccess = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  if (isTrueFlag(safeUser.adminAccess) || isTrueFlag(safeUser.isAdmin) || isTrueFlag(safeUser.admin)) {
    return true;
  }
  const roleTokens = collectUserRoleTokens(safeUser);
  return roleTokens.includes("admin");
};

const hasCoachRole = (user) => {
  const roleTokens = collectUserRoleTokens(user);
  return roleTokens.includes("coach");
};

const hasStudentRole = (user) => {
  const roleTokens = collectUserRoleTokens(user);
  return roleTokens.includes("student") || roleTokens.includes("user");
};

const normalizeAvatarUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower === "none" || lower === "null" || lower === "undefined") {
    return "";
  }
  return raw;
};

const normalizeIdList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
};

const mergeUniqueIdList = (...inputList) => {
  const set = new Set();
  (inputList || []).forEach((list) => {
    const arr = Array.isArray(list) ? list : [list];
    arr.forEach((item) => {
      const id = String(item || "").trim();
      if (id) {
        set.add(id);
      }
    });
  });
  return Array.from(set);
};

const extractUserCoachIds = (user, event) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const safeEvent = event && typeof event === "object" ? event : {};
  return mergeUniqueIdList(
    normalizeIdList(safeEvent.coachIds),
    normalizeIdList(safeEvent.coachIDs),
    safeEvent.coachId,
    safeEvent.coachID,
    normalizeIdList(safeEvent.coachOwnerIds),
    normalizeIdList(safeEvent.coachOwnerIDs),
    safeEvent.coachOwnerId,
    safeEvent.coachOwnerID,
    normalizeIdList(safeUser.coachIds),
    normalizeIdList(safeUser.coachIDs),
    normalizeIdList(safeUser.coachids),
    safeUser.coachId,
    safeUser.coachID,
    safeUser.coachid,
    normalizeIdList(safeUser.coachOwnerIds),
    normalizeIdList(safeUser.coachOwnerIDs),
    safeUser.coachOwnerId,
    safeUser.coachOwnerID
  );
};

const extractUserAdminOwnerIds = (user, event) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const safeEvent = event && typeof event === "object" ? event : {};
  return mergeUniqueIdList(
    normalizeIdList(safeEvent.adminOwnerIds),
    normalizeIdList(safeEvent.adminOwnerIDs),
    safeEvent.adminOwnerId,
    safeEvent.adminOwnerID,
    normalizeIdList(safeEvent.ownerIds),
    normalizeIdList(safeEvent.ownerIDs),
    safeEvent.ownerId,
    safeEvent.ownerID,
    normalizeIdList(safeUser[ADMIN_OWNER_IDS_FIELD]),
    normalizeIdList(safeUser.adminOwnerIDs),
    safeUser[ADMIN_OWNER_ID_FIELD],
    safeUser.adminOwnerID,
    normalizeIdList(safeUser.ownerIds),
    normalizeIdList(safeUser.ownerIDs),
    safeUser.ownerId,
    safeUser.ownerID
  );
};

const buildAdminOwnerPatch = (ownerIds) => {
  const ids = mergeUniqueIdList(ownerIds);
  return {
    [ADMIN_OWNER_ID_FIELD]: ids[0] || "",
    [ADMIN_OWNER_IDS_FIELD]: ids,
    ownerId: ids[0] || "",
    ownerIds: ids,
    ownerID: ids[0] || "",
    ownerIDs: ids,
  };
};

const isManagedByAdminOwner = (doc, adminUserId) => {
  const safeAdminId = String(adminUserId || "").trim();
  if (!safeAdminId) {
    return false;
  }
  const targetId = String(doc && (doc._id || doc.id) ? (doc._id || doc.id) : "").trim();
  if (targetId && targetId === safeAdminId) {
    return true;
  }
  const ownerIds = extractUserAdminOwnerIds(doc, null);
  return ownerIds.includes(safeAdminId);
};

const queryManagedCoachIdsByAdmin = async (adminUser) => {
  const adminId = String(adminUser && adminUser._id ? adminUser._id : "").trim();
  if (!adminId) {
    return [];
  }
  const adminOpenId = String(adminUser && (adminUser.openid || adminUser._openid) ? (adminUser.openid || adminUser._openid) : "").trim();
  const adminPhone = normalizePhone(adminUser && adminUser.phone ? adminUser.phone : "");
  const scopedOwnerIds = mergeUniqueIdList(
    adminId,
    adminOpenId,
    adminPhone,
    extractUserAdminOwnerIds(adminUser, null)
  );
  if (!scopedOwnerIds.length) {
    return [];
  }
  const _ = db.command;
  const where = _.and([
    { role: _.in(["coach", "admin", "Coach", "Admin", "COACH", "ADMIN", "教练", "教練", "管理员", "管理員"]) },
    _.or([
      { [ADMIN_OWNER_ID_FIELD]: _.in(scopedOwnerIds) },
      { [ADMIN_OWNER_IDS_FIELD]: _.in(scopedOwnerIds) },
      { adminOwnerID: _.in(scopedOwnerIds) },
      { adminOwnerIDs: _.in(scopedOwnerIds) },
      { ownerId: _.in(scopedOwnerIds) },
      { ownerIds: _.in(scopedOwnerIds) },
      { ownerID: _.in(scopedOwnerIds) },
      { ownerIDs: _.in(scopedOwnerIds) },
    ]),
  ]);
  const res = await db.collection(USER_COLLECTION).where(where).limit(1000).get().catch(() => ({ data: [] }));
  const list = Array.isArray(res && res.data) ? res.data : [];
  const ids = mergeUniqueIdList(
    list.map((item) => String(item && item._id ? item._id : "").trim()),
    adminId
  );
  return ids.filter(Boolean);
};

const filterCoachIdsByAdminScope = async (adminUser, coachIds) => {
  const ids = mergeUniqueIdList(coachIds);
  const managedIds = await queryManagedCoachIdsByAdmin(adminUser);
  if (!managedIds.length) {
    return [];
  }
  const managedSet = new Set(managedIds);
  if (!ids.length) {
    return Array.from(managedSet);
  }
  return ids.filter((id) => managedSet.has(String(id || "").trim()));
};

const queryCoachUsersByAdminOwnerIds = async (ownerIds) => {
  const ids = mergeUniqueIdList(ownerIds);
  if (!ids.length) {
    return [];
  }
  const _ = db.command;
  const where = _.and([
    { role: _.in(["coach", "admin", "Coach", "Admin", "COACH", "ADMIN", "教练", "教練", "管理员", "管理員"]) },
    _.or([
      { [ADMIN_OWNER_ID_FIELD]: _.in(ids) },
      { adminOwnerID: _.in(ids) },
      { [ADMIN_OWNER_IDS_FIELD]: _.in(ids) },
      { adminOwnerIDs: _.in(ids) },
      { ownerId: _.in(ids) },
      { ownerID: _.in(ids) },
      { ownerIds: _.in(ids) },
      { ownerIDs: _.in(ids) },
    ]),
  ]);
  const res = await db.collection(USER_COLLECTION).where(where).limit(1000).get().catch(() => ({ data: [] }));
  return Array.isArray(res && res.data) ? res.data : [];
};

const queryPeerCoachIdsByCoach = async (coachUser) => {
  const selfId = String(coachUser && coachUser._id ? coachUser._id : "").trim();
  if (!selfId) {
    return [];
  }
  const ownerIds = extractUserAdminOwnerIds(coachUser, null);
  if (!ownerIds.length) {
    return [selfId];
  }
  const peers = await queryCoachUsersByAdminOwnerIds(ownerIds);
  const peerIds = peers
    .map((item) => String(item && item._id ? item._id : "").trim())
    .filter(Boolean);
  return mergeUniqueIdList(selfId, peerIds);
};

const isStudentManagedByAdmin = async (adminUser, studentDoc) => {
  const adminId = String(adminUser && adminUser._id ? adminUser._id : "").trim();
  if (!adminId) {
    return false;
  }
  const safeStudent = studentDoc && typeof studentDoc === "object" ? studentDoc : {};
  const role = normalizeRole(safeStudent.role);
  if (role !== "student" && role !== "user") {
    return false;
  }
  if (isManagedByAdminOwner(safeStudent, adminId)) {
    return true;
  }
  const studentCoachIds = extractUserCoachIds(safeStudent, null);
  if (!studentCoachIds.length) {
    return false;
  }
  const managedCoachIds = await filterCoachIdsByAdminScope(adminUser, studentCoachIds);
  return managedCoachIds.length > 0;
};

const normalizeOpenIdList = (value) => normalizeIdList(value);

const normalizeMediaImages = (images) => {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        return item.fileID || item.url || "";
      }
      return "";
    })
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 9);
};

const normalizeMediaVideo = (video) => {
  if (!video) {
    return null;
  }
  if (typeof video === "string") {
    const fileID = String(video || "").trim();
    return fileID ? { fileID } : null;
  }
  if (video && typeof video === "object") {
    const fileID = String(video.fileID || video.url || "").trim();
    if (!fileID) {
      return null;
    }
    const poster = String(
      video.poster
      || video.posterFileID
      || video.posterUrl
      || video.cover
      || video.thumb
      || ""
    ).trim();
    const normalized = {
      fileID,
      duration: resolveNumber(video.duration),
      size: resolveNumber(video.size),
      width: resolveNumber(video.width),
      height: resolveNumber(video.height),
    };
    if (poster) {
      normalized.poster = poster;
    }
    return normalized;
  }
  return null;
};

const normalizeCommunityPostType = (value, hasVideo) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "video") {
    return "video";
  }
  if (raw === "post") {
    return "post";
  }
  return hasVideo ? "video" : "post";
};

const normalizeDateLike = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value && typeof value.toDate === "function") {
    const dateObj = value.toDate();
    return dateObj && !Number.isNaN(dateObj.getTime()) ? dateObj : null;
  }
  if (value && typeof value._seconds === "number") {
    const dateObj = new Date(value._seconds * 1000);
    return Number.isNaN(dateObj.getTime()) ? null : dateObj;
  }
  const dateObj = new Date(value);
  return Number.isNaN(dateObj.getTime()) ? null : dateObj;
};

const getCommentCount = (doc) => {
  if (!doc || typeof doc !== "object") {
    return 0;
  }
  if (typeof doc.commentCount === "number") {
    return doc.commentCount;
  }
  if (typeof doc.comments === "number") {
    return doc.comments;
  }

  const countFromList = (list) => list.reduce((sum, item) => {
    const replyLen = Array.isArray(item && item.replies) ? item.replies.length : 0;
    return sum + 1 + replyLen;
  }, 0);

  if (Array.isArray(doc.commentList)) {
    return countFromList(doc.commentList);
  }
  if (Array.isArray(doc.comments)) {
    return countFromList(doc.comments);
  }
  return 0;
};

const stringifyDate = (dateObj) => {
  if (!dateObj || !(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    return "";
  }
  return dateObj.toISOString();
};

const resolveCurrentUser = async (event) => {
  const safeEvent = event && typeof event === "object" ? event : {};
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID).trim() : "";
  const eventUserId = safeEvent && safeEvent.userId ? String(safeEvent.userId).trim() : "";
  const preferEventUserId = !!(safeEvent.forceStudentView || safeEvent.preferUserId || safeEvent.forceUserId);
  const expectedRoleText = String(safeEvent.expectedRole || "").trim().toLowerCase();
  const roleMatch = (doc) => {
    const normalized = normalizeRole(doc && doc.role);
    if (!expectedRoleText) {
      return true;
    }
    if (expectedRoleText === "student" || expectedRoleText === "user") {
      if (normalized === "student" || normalized === "user") {
        return true;
      }
      // Legacy fallback: role field may be missing, then inspect role tokens.
      return hasStudentRole(doc);
    }
    if (expectedRoleText === "coach") {
      if (normalized === "coach") {
        return true;
      }
      return hasCoachRole(doc);
    }
    if (expectedRoleText === "admin") {
      if (normalized === "admin") {
        return true;
      }
      return hasAdminAccess(doc);
    }
    if (expectedRoleText === "coach_or_admin" || expectedRoleText === "staff") {
      if (normalized === "coach" || normalized === "admin") {
        return true;
      }
      return hasCoachRole(doc) || hasAdminAccess(doc);
    }
    return true;
  };
  let user = null;

  if (preferEventUserId && eventUserId) {
    try {
      const byIdRes = await db.collection(USER_COLLECTION).doc(eventUserId).get();
      const byIdUser = byIdRes && byIdRes.data ? byIdRes.data : null;
      const byIdOpenid = String((byIdUser && (byIdUser.openid || byIdUser._openid)) || "").trim();
      if (byIdUser && roleMatch(byIdUser) && (!openid || !byIdOpenid || byIdOpenid === openid)) {
        user = byIdUser;
      } else {
        user = null;
      }
    } catch (e) {
      user = null;
    }
  }

  if (!user && openid) {
    const _ = db.command;
    const byOpenIdRes = await db.collection(USER_COLLECTION).where(_.or([
      { openid },
      { _openid: openid },
    ])).limit(20).get();
    const byOpenIdList = byOpenIdRes && byOpenIdRes.data ? byOpenIdRes.data : [];
    if (byOpenIdList.length) {
      const preferred = byOpenIdList.find((item) => roleMatch(item));
      user = preferred || (expectedRoleText ? null : byOpenIdList[0]);
    }
  }

  if (!user && eventUserId) {
    try {
      const byIdRes = await db.collection(USER_COLLECTION).doc(eventUserId).get();
      const byIdUser = byIdRes && byIdRes.data ? byIdRes.data : null;
      user = roleMatch(byIdUser) ? byIdUser : null;
    } catch (e) {
      user = null;
    }
  }

  if (user && !user.openid && user._openid) {
    user = {
      ...user,
      openid: String(user._openid || "").trim(),
    };
  }

  if (user && openid && !user.openid) {
    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        openid,
        updatedAt: db.serverDate(),
      },
    });
    user = {
      ...user,
      openid,
    };
  }

  if (user && user._id) {
    user = await ensureUserIntegrity(user, openid);
  }

  return {
    user,
    openid,
  };
};

const resolveScheduleActorUser = async (event) => {
  const safeEvent = event && typeof event === "object" ? event : {};
  const requestedUserId = String(safeEvent.userId || "").trim();
  const forceStudentView = !!(safeEvent.forceStudentView || safeEvent.forceStudent);
  const expectedRole = String(safeEvent.expectedRole || (forceStudentView ? "student" : "")).trim().toLowerCase();
  const getUserOpenid = (userDoc) =>
    String((userDoc && (userDoc.openid || userDoc._openid)) || "").trim();
  const matchesExpectedRole = (doc) => {
    const normalized = normalizeRole(doc && doc.role);
    if (!expectedRole) {
      return true;
    }
    if (expectedRole === "student" || expectedRole === "user") {
      if (normalized === "student" || normalized === "user") {
        return true;
      }
      return hasStudentRole(doc);
    }
    if (expectedRole === "coach") {
      if (normalized === "coach") {
        return true;
      }
      return hasCoachRole(doc);
    }
    if (expectedRole === "admin") {
      if (normalized === "admin") {
        return true;
      }
      return hasAdminAccess(doc);
    }
    if (expectedRole === "coach_or_admin" || expectedRole === "staff") {
      if (normalized === "coach" || normalized === "admin") {
        return true;
      }
      return hasCoachRole(doc) || hasAdminAccess(doc);
    }
    return true;
  };

  const buildResult = (user, actorOpenid) => ({
    user: user || null,
    actorOpenid: String(actorOpenid || "").trim(),
  });

  const currentResolveEvent = {
    ...(safeEvent && typeof safeEvent === "object" ? safeEvent : {}),
  };
  if (expectedRole) {
    currentResolveEvent.expectedRole = expectedRole;
  }
  const { user: currentUser, openid } = await resolveCurrentUser(currentResolveEvent);
  const selfOpenid = String(openid || (currentUser && currentUser.openid) || "").trim();

  if (!currentUser || !currentUser._id) {
    if (!requestedUserId) {
      return buildResult(null, "");
    }
    const byIdRes = await db.collection(USER_COLLECTION).doc(requestedUserId).get().catch(() => null);
    const byIdUser = byIdRes && byIdRes.data ? byIdRes.data : null;
    if (!byIdUser || !byIdUser._id) {
      return buildResult(null, "");
    }
    if (!matchesExpectedRole(byIdUser)) {
      return buildResult(null, "");
    }
    const targetOpenid = getUserOpenid(byIdUser);
    if (selfOpenid && targetOpenid && targetOpenid !== selfOpenid) {
      return buildResult(null, "");
    }
    return buildResult(byIdUser, targetOpenid || selfOpenid);
  }

  const currentId = String(currentUser._id || "").trim();
  if (!requestedUserId || requestedUserId === currentId) {
    return buildResult(currentUser, selfOpenid);
  }

  const requestedRes = await db.collection(USER_COLLECTION).doc(requestedUserId).get().catch(() => null);
  const requestedUser = requestedRes && requestedRes.data ? requestedRes.data : null;
  if (requestedUser && requestedUser._id) {
    const requestedOpenid = getUserOpenid(requestedUser);
    if (selfOpenid && requestedOpenid && requestedOpenid === selfOpenid && matchesExpectedRole(requestedUser)) {
      return buildResult(requestedUser, requestedOpenid);
    }
  }

  const currentRole = normalizeRole(currentUser.role);
  if (currentRole !== "coach" && currentRole !== "admin") {
    return buildResult(currentUser, selfOpenid);
  }

  const targetUser = requestedUser || null;
  if (!targetUser || !targetUser._id) {
    return buildResult(currentUser, selfOpenid);
  }

  const targetRole = normalizeRole(targetUser.role);
  if (targetRole !== "student" && targetRole !== "user") {
    return buildResult(currentUser, selfOpenid);
  }

  if (currentRole === "coach") {
    const targetCoachId = String(targetUser.coachId || "").trim();
    if (!targetCoachId || targetCoachId !== currentId) {
      return buildResult(currentUser, selfOpenid);
    }
  }
  if (!matchesExpectedRole(targetUser)) {
    return buildResult(currentUser, selfOpenid);
  }

  return buildResult(targetUser, getUserOpenid(targetUser));
};

const buildNotificationReceiverFilterByIdentities = (userIds, openids) => {
  const idList = mergeUniqueIdList(userIds);
  const openidList = normalizeOpenIdList(openids);
  const _ = db.command;
  const whereList = [];
  if (idList.length === 1) {
    whereList.push({ receiverUserId: idList[0] });
  } else if (idList.length > 1) {
    whereList.push({ receiverUserId: _.in(idList) });
  }
  if (openidList.length === 1) {
    whereList.push({ receiverOpenId: openidList[0] });
  } else if (openidList.length > 1) {
    whereList.push({ receiverOpenId: _.in(openidList) });
  }
  if (!whereList.length) {
    return null;
  }
  return whereList.length > 1 ? _.or(whereList) : whereList[0];
};

const buildNotificationReceiverFilter = (userId, openid) => {
  return buildNotificationReceiverFilterByIdentities([userId], [openid]);
};

const isNotificationOwnedByUser = (notificationDoc, userId, openid) => {
  const safeDoc = notificationDoc && typeof notificationDoc === "object" ? notificationDoc : {};
  const safeUserId = String(userId || "").trim();
  const safeOpenid = String(openid || "").trim();
  const receiverUserId = String(safeDoc.receiverUserId || "").trim();
  const receiverOpenId = String(safeDoc.receiverOpenId || "").trim();
  if (receiverUserId && safeUserId && receiverUserId === safeUserId) {
    return true;
  }
  if (receiverOpenId && safeOpenid && receiverOpenId === safeOpenid) {
    return true;
  }
  return false;
};

const isNotificationOwnedByAnyIdentity = (notificationDoc, userIds, openids) => {
  const safeDoc = notificationDoc && typeof notificationDoc === "object" ? notificationDoc : {};
  const receiverUserId = String(safeDoc.receiverUserId || "").trim();
  const receiverOpenId = String(safeDoc.receiverOpenId || "").trim();
  const idList = mergeUniqueIdList(userIds);
  const openidList = normalizeOpenIdList(openids);
  if (receiverUserId && idList.includes(receiverUserId)) {
    return true;
  }
  if (receiverOpenId && openidList.includes(receiverOpenId)) {
    return true;
  }
  return false;
};

const appendReadStatusToFilter = (baseFilter, isRead) => {
  const _ = db.command;
  const readFilter = isRead
    ? { isRead: true }
    : { isRead: _.neq(true) };
  return _.and([
    baseFilter,
    readFilter,
  ]);
};

const isSameUser = (sourceId, sourceOpenid, targetId, targetOpenid) => {
  if (sourceId && targetId && sourceId === targetId) {
    return true;
  }
  if (sourceOpenid && targetOpenid && sourceOpenid === targetOpenid) {
    return true;
  }
  return false;
};

const createNotification = async (payload) => {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const receiverUserId = String(safePayload.receiverUserId || "").trim();
  const receiverOpenId = String(safePayload.receiverOpenId || "").trim();
  if (!receiverUserId && !receiverOpenId) {
    return null;
  }

  const title = String(safePayload.title || "").trim();
  const content = String(safePayload.content || "").trim();
  if (!title && !content) {
    return null;
  }

  const addRes = await db.collection(NOTIFICATION_COLLECTION).add({
    data: {
      receiverUserId,
      receiverOpenId,
      senderUserId: String(safePayload.senderUserId || "").trim(),
      senderOpenId: String(safePayload.senderOpenId || "").trim(),
      senderName: String(safePayload.senderName || "").trim(),
      type: String(safePayload.type || "system").trim() || "system",
      title: title || "系统通知",
      content,
      relatedId: String(safePayload.relatedId || "").trim(),
      relatedType: String(safePayload.relatedType || "").trim(),
      relatedPath: String(safePayload.relatedPath || "").trim(),
      isRead: false,
      readAt: null,
      extra: safePayload.extra && typeof safePayload.extra === "object" ? safePayload.extra : {},
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  return addRes && addRes._id ? addRes._id : null;
};

const truncateSubscribeValue = (value, maxLength) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const appendSubscribeDataField = (data, fieldName, value) => {
  const key = String(fieldName || "").trim();
  if (!key) {
    return;
  }
  const text = String(value || "").trim();
  if (!text) {
    return;
  }
  data[key] = { value: text };
};

const buildScheduleBookingSubscribeData = (payload) => {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const data = {};
  appendSubscribeDataField(
    data,
    SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP.studentName,
    truncateSubscribeValue(safePayload.studentName, 20)
  );
  appendSubscribeDataField(
    data,
    SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP.scheduleTime,
    truncateSubscribeValue(safePayload.scheduleTime, 32)
  );
  appendSubscribeDataField(
    data,
    SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP.courseTitle,
    truncateSubscribeValue(safePayload.courseTitle, 20)
  );
  appendSubscribeDataField(
    data,
    SCHEDULE_BOOKING_SUBSCRIBE_KEY_MAP.remark,
    truncateSubscribeValue(safePayload.remark, 20)
  );
  return data;
};

const sendScheduleBookingSubscribeMessage = async (payload) => {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const receiverOpenId = String(safePayload.receiverOpenId || "").trim();
  if (!SCHEDULE_BOOKING_SUBSCRIBE_TEMPLATE_ID || !receiverOpenId) {
    return { success: false, reason: "subscribe_config_missing" };
  }

  const data = buildScheduleBookingSubscribeData(safePayload);
  if (!Object.keys(data).length) {
    return { success: false, reason: "subscribe_data_empty" };
  }

  await cloud.openapi.subscribeMessage.send({
    touser: receiverOpenId,
    templateId: SCHEDULE_BOOKING_SUBSCRIBE_TEMPLATE_ID,
    page: SCHEDULE_BOOKING_SUBSCRIBE_PAGE || DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_PAGE,
    lang: "zh_CN",
    data,
  });
  return { success: true };
};

const getSubscribeTemplateConfig = async () => ({
  success: true,
  templates: {
    scheduleBooking: SCHEDULE_BOOKING_SUBSCRIBE_TEMPLATE_ID,
  },
  pages: {
    scheduleBooking: SCHEDULE_BOOKING_SUBSCRIBE_PAGE || DEFAULT_SCHEDULE_BOOKING_SUBSCRIBE_PAGE,
  },
});

const getUsersByRole = async (roles) => {
  const list = Array.isArray(roles) ? roles : [];
  const normalizedRoles = list
    .map((item) => normalizeRole(item))
    .filter(Boolean);
  if (!normalizedRoles.length) {
    return [];
  }
  const _ = db.command;
  const res = await db.collection(USER_COLLECTION).where({
    role: _.in(normalizedRoles),
  }).limit(200).get();
  return res && res.data ? res.data : [];
};

const normalizeNotificationTypeList = (value) =>
  normalizeIdList(value)
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);

const appendNotificationTypeFilter = (baseFilter, event) => {
  const _ = db.command;
  const safeEvent = event && typeof event === "object" ? event : {};
  const includeTypes = normalizeNotificationTypeList(safeEvent.includeTypes);
  const excludeTypes = normalizeNotificationTypeList(safeEvent.excludeTypes)
    .filter((type) => !includeTypes.includes(type));
  const conditionList = [baseFilter];
  if (includeTypes.length === 1) {
    conditionList.push({ type: includeTypes[0] });
  } else if (includeTypes.length > 1) {
    conditionList.push({ type: _.in(includeTypes) });
  }
  if (excludeTypes.length === 1) {
    conditionList.push({ type: _.neq(excludeTypes[0]) });
  } else if (excludeTypes.length > 1) {
    conditionList.push({ type: _.nin(excludeTypes) });
  }
  if (conditionList.length === 1) {
    return baseFilter;
  }
  return _.and(conditionList);
};

const listNotifications = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", notifications: [], unreadCount: 0 };
    }

    const role = normalizeRole(user.role);
    const studentContext = (role === "student" || role === "user")
      ? await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      }).catch(() => null)
      : null;
    const where = studentContext
      ? buildNotificationReceiverFilterByIdentities(
        studentContext.studentIds,
        mergeUniqueIdList(studentContext.studentOpenIds, openid || user.openid || user._openid || "")
      )
      : buildNotificationReceiverFilter(user._id, openid || user.openid);
    if (!where) {
      return { success: true, notifications: [], unreadCount: 0 };
    }

    const typedWhere = appendNotificationTypeFilter(where, event);
    const listRes = await db.collection(NOTIFICATION_COLLECTION)
      .where(typedWhere)
      .orderBy("createdAt", "desc")
      .limit(NOTIFICATION_FETCH_LIMIT)
      .get()
      .catch(() => ({ data: [] }));
    const unreadRes = await db.collection(NOTIFICATION_COLLECTION)
      .where(appendReadStatusToFilter(typedWhere, false))
      .count()
      .catch(() => ({ total: 0 }));

    const list = listRes && listRes.data ? listRes.data : [];
    return {
      success: true,
      notifications: list.map((item) => ({
        id: item._id || "",
        type: item.type || "system",
        title: item.title || "系统通知",
        content: item.content || "",
        senderName: item.senderName || "",
        relatedId: item.relatedId || "",
        relatedType: item.relatedType || "",
        relatedPath: item.relatedPath || "",
        isRead: !!item.isRead,
        createdAt: item.createdAt || item.updatedAt || null,
      })),
      unreadCount: unreadRes && typeof unreadRes.total === "number" ? unreadRes.total : 0,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_notifications_failed",
      notifications: [],
      unreadCount: 0,
      errMsg: e,
    };
  }
};

const markNotificationRead = async (event) => {
  try {
    const notificationId = event && event.notificationId ? String(event.notificationId).trim() : "";
    if (!notificationId) {
      return { success: false, message: "notification_id_required" };
    }

    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const docRes = await db.collection(NOTIFICATION_COLLECTION).doc(notificationId).get();
    const doc = docRes && docRes.data ? docRes.data : null;
    if (!doc) {
      return { success: false, message: "notification_not_found" };
    }

    const role = normalizeRole(user.role);
    const studentContext = (role === "student" || role === "user")
      ? await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      }).catch(() => null)
      : null;
    const belongsToCurrentUser = studentContext
      ? isNotificationOwnedByAnyIdentity(
        doc,
        studentContext.studentIds,
        mergeUniqueIdList(studentContext.studentOpenIds, openid || user.openid || user._openid || "")
      )
      : isNotificationOwnedByUser(
        doc,
        String(user._id || ""),
        String(openid || user.openid || "")
      );
    if (!belongsToCurrentUser) {
      return { success: false, message: "permission_denied" };
    }

    if (!doc.isRead) {
      await db.collection(NOTIFICATION_COLLECTION).doc(notificationId).update({
        data: {
          isRead: true,
          readAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "mark_notification_read_failed",
      errMsg: e,
    };
  }
};

const markAllNotificationsRead = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = normalizeRole(user.role);
    const studentContext = (role === "student" || role === "user")
      ? await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      }).catch(() => null)
      : null;
    const where = studentContext
      ? buildNotificationReceiverFilterByIdentities(
        studentContext.studentIds,
        mergeUniqueIdList(studentContext.studentOpenIds, openid || user.openid || user._openid || "")
      )
      : buildNotificationReceiverFilter(user._id, openid || user.openid);
    if (!where) {
      return { success: true, updated: 0 };
    }

    const updateRes = await db.collection(NOTIFICATION_COLLECTION).where(
      appendReadStatusToFilter(where, false)
    ).update({
      data: {
        isRead: true,
        readAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    const updated = updateRes && updateRes.stats && updateRes.stats.updated
      ? updateRes.stats.updated
      : 0;
    return {
      success: true,
      updated,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "mark_all_notifications_read_failed",
      errMsg: e,
    };
  }
};

const getNotificationUnreadCount = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", unreadCount: 0 };
    }

    const role = normalizeRole(user.role);
    const studentContext = (role === "student" || role === "user")
      ? await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      }).catch(() => null)
      : null;
    const where = studentContext
      ? buildNotificationReceiverFilterByIdentities(
        studentContext.studentIds,
        mergeUniqueIdList(studentContext.studentOpenIds, openid || user.openid || user._openid || "")
      )
      : buildNotificationReceiverFilter(user._id, openid || user.openid);
    if (!where) {
      return { success: true, unreadCount: 0 };
    }
    const typedWhere = appendNotificationTypeFilter(where, event);
    const res = await db.collection(NOTIFICATION_COLLECTION)
      .where(appendReadStatusToFilter(typedWhere, false))
      .count();
    return {
      success: true,
      unreadCount: res && typeof res.total === "number" ? res.total : 0,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_unread_count_failed",
      unreadCount: 0,
      errMsg: e,
    };
  }
};

const getCommunityMuteInfo = (user) => {
  const muteUntil = normalizeDateLike(
    user && (user.communityMutedUntil || user.communityBanUntil || user.muteUntil)
  );
  if (!muteUntil) {
    return {
      blocked: false,
      blockedUntil: "",
      remainingMinutes: 0,
    };
  }
  const nowMs = Date.now();
  const untilMs = muteUntil.getTime();
  if (untilMs <= nowMs) {
    return {
      blocked: false,
      blockedUntil: "",
      remainingMinutes: 0,
    };
  }
  return {
    blocked: true,
    blockedUntil: stringifyDate(muteUntil),
    remainingMinutes: Math.max(1, Math.ceil((untilMs - nowMs) / 60000)),
  };
};

const createCommunityBlockedResult = (muteInfo) => ({
  success: false,
  message: "community_blocked",
  blockedUntil: muteInfo.blockedUntil || "",
  remainingMinutes: resolveNumber(muteInfo.remainingMinutes),
});

const getAuthorNameByRole = (role) => {
  if (role === "admin") {
    return "Admin";
  }
  if (role === "coach") {
    return "Coach";
  }
  return "Student";
};

const buildAuthorFromUser = (user, openid, authorNameOverride, authorAvatarOverride) => {
  const role = normalizeRole(user && user.role);
  const fallbackName = getAuthorNameByRole(role);
  let authorName = role === "admin"
    ? fallbackName
    : ((user && (user.name || user.nickName)) || fallbackName);
  if (authorNameOverride && String(authorNameOverride).trim()) {
    authorName = String(authorNameOverride).trim();
  }
  let avatarUrl = normalizeAvatarUrl(user && user.avatarUrl);
  if (authorAvatarOverride && String(authorAvatarOverride).trim()) {
    avatarUrl = normalizeAvatarUrl(String(authorAvatarOverride).trim());
  }
  return {
    id: (user && (user._id || user.id)) || "",
    openid: (user && user.openid) || openid || "",
    source: role === "coach" ? "coach" : (role === "admin" ? "admin" : "student"),
    author: {
      name: authorName,
      avatarUrl,
    },
  };
};

const createCommunityActivity = async (text, relatedId, extra) => {
  if (!text) {
    return;
  }
  const safeExtra = extra && typeof extra === "object" ? extra : {};
  await db.collection(ACTIVITY_COLLECTION).add({
    data: {      icon: "\uD83D\uDCE3",
      text,
      relatedType: "community_post",
      relatedId: relatedId || "",
      visibleForCoach: typeof safeExtra.visibleForCoach === "boolean" ? safeExtra.visibleForCoach : true,
      relatedSource: String(safeExtra.relatedSource || "").trim(),
      createdAt: db.serverDate(),
    },
  });
};

const createCommunityPost = async (event) => {
  try {
    const title = event && event.title ? String(event.title).trim() : "";
    const content = event && event.content ? String(event.content).trim() : "";
    const tag = event && event.tag ? String(event.tag).trim() : "";
    const images = normalizeMediaImages(event && event.images);
    const video = normalizeMediaVideo(event && event.video);
    const postType = normalizeCommunityPostType(event && event.postType, !!video);
    const minTitleLength = postType === "video" ? 2 : 3;

    if (postType !== "video") {
      return { success: false, message: "post_disabled" };
    }
    if (!video) {
      return { success: false, message: "video_required" };
    }

    if (!title) {
      return { success: false, message: "title_required" };
    }
    if (title.length < minTitleLength) {
      return { success: false, message: "title_too_short" };
    }
    if (!content && images.length === 0 && !video) {
      return { success: false, message: "content_or_media_required" };
    }

    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const muteInfo = getCommunityMuteInfo(user);
    if (muteInfo.blocked) {
      return createCommunityBlockedResult(muteInfo);
    }

    const role = normalizeRole(user.role);
    const authorNameOverride = event && event.authorName ? String(event.authorName).trim() : "";
    const authorAvatarOverride = event && event.authorAvatarUrl ? String(event.authorAvatarUrl).trim() : "";
    const authorInfo = buildAuthorFromUser(user, openid, authorNameOverride, authorAvatarOverride);
    const isAdminPost = role === "admin";
        const defaultTag = role === "coach" ? "Coach Post" : (isAdminPost ? "Admin Post" : "Student Post");
    const pinUntil = isAdminPost ? new Date(Date.now() + ONE_DAY_MS) : null;

    const addRes = await db.collection(COMMUNITY_POST_COLLECTION).add({
      data: {
        title,
        content,
        tag: isAdminPost ? defaultTag : (tag || defaultTag),
        author: authorInfo.author,
        authorId: authorInfo.id,
        authorOpenId: authorInfo.openid,
        authorRole: role,
        status: "active",
        likes: 0,
        comments: 0,
        commentList: [],
        commentCount: 0,
        views: 0,
        isNotice: isAdminPost,
        pinUntil,
        source: authorInfo.source,
        images,
        video: video || null,
        postType,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    const postId = addRes && addRes._id ? addRes._id : "";
    if (!isAdminPost) {
      await createCommunityActivity(`${authorInfo.author.name}\u53d1\u5e03\u4e86\u65b0\u89c6\u9891`, postId, {
        visibleForCoach: true,
        relatedSource: authorInfo.source,
      }).catch(() => {});
    }

    const adminUsers = await getUsersByRole(["admin"]).catch(() => []);
    await Promise.all(
      (adminUsers || []).map((adminUser) => {
        if (!adminUser || !adminUser._id) {
          return Promise.resolve();
        }
        if (isSameUser(authorInfo.id, authorInfo.openid, adminUser._id, adminUser.openid)) {
          return Promise.resolve();
        }
        return createNotification({
          receiverUserId: adminUser._id,
          receiverOpenId: adminUser.openid || "",
          senderUserId: authorInfo.id,
          senderOpenId: authorInfo.openid,
          senderName: authorInfo.author.name,
          type: "community_post_created",
          title: "\u89c6\u9891\u5ba1\u6838\u63d0\u9192",
          content: `${authorInfo.author.name} \u53d1\u5e03\u4e86\u89c6\u9891\uff1a${title.slice(0, 18)}`,
          relatedId: postId,
          relatedType: "community_post",
          relatedPath: `/pages/student/community/detail/detail?id=${postId}`,
        }).catch(() => null);
      })
    );

    return {
      success: true,
      postId,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "create_post_failed",
      errMsg: e,
    };
  }
};

const normalizeCommunityFeedCategory = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "latest" || raw === "follow" || raw === "recommend") {
    return raw;
  }
  return "recommend";
};

const getCommunityFollowIdSets = (user) => {
  const safe = user && typeof user === "object" ? user : {};
  return {
    userIds: new Set(mergeUniqueIdList(
      safe.followingIds,
      safe.followingUserIds,
      safe.followedUserIds,
      safe.communityFollowingIds,
      safe.communityFollowingUserIds
    )),
    openids: new Set(mergeUniqueIdList(
      safe.followingOpenIds,
      safe.followedOpenIds,
      safe.communityFollowingOpenIds
    )),
  };
};

const getPostPopularityScore = (post) => {
  const safe = post && typeof post === "object" ? post : {};
  return resolveNumber(safe.likes || safe.likeCount || 0) * 3
    + resolveNumber(safe.comments || safe.commentCount || 0) * 2
    + resolveNumber(safe.views || safe.viewCount || 0);
};

const isCommunityPostPinned = (post) => {
  const safe = post && typeof post === "object" ? post : {};
  const pinUntil = normalizeDateLike(safe.pinUntil);
  return !!pinUntil && pinUntil.getTime() > Date.now();
};

const isVideoCommunityPost = (post) => {
  const safe = post && typeof post === "object" ? post : {};
  const postType = String(safe.postType || "").trim().toLowerCase();
  const video = safe.video;
  const hasVideo = typeof video === "string"
    ? !!String(video).trim()
    : !!(video && typeof video === "object" && String(video.fileID || video.url || "").trim());
  return postType === "video" || hasVideo;
};

const filterCommunityPostsByKeyword = (posts, keyword) => {
  const text = String(keyword || "").trim().toLowerCase();
  const list = Array.isArray(posts) ? posts : [];
  if (!text) {
    return list;
  }
  return list.filter((item) => {
    const safe = item && typeof item === "object" ? item : {};
    const author = safe.author && typeof safe.author === "object" ? safe.author : {};
    return String(safe.title || "").toLowerCase().includes(text)
      || String(safe.content || "").toLowerCase().includes(text)
      || String(safe.tag || "").toLowerCase().includes(text)
      || String(author.name || safe.authorName || "").toLowerCase().includes(text);
  });
};

const sortCommunityPostsForCategory = (posts, category) => {
  const list = Array.isArray(posts) ? posts.slice() : [];
  return list.sort((a, b) => {
    const aPinned = isCommunityPostPinned(a);
    const bPinned = isCommunityPostPinned(b);
    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1;
    }
    const aTs = getDateTimestamp(a && (a.createdAt || a.time || a.createdTime));
    const bTs = getDateTimestamp(b && (b.createdAt || b.time || b.createdTime));
    if (category === "latest") {
      return bTs - aTs;
    }
    const scoreDiff = getPostPopularityScore(b) - getPostPopularityScore(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return bTs - aTs;
  });
};

const listCommunityPosts = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const category = normalizeCommunityFeedCategory(safeEvent.category);
    const limit = Math.max(1, Math.min(resolveNumber(safeEvent.limit || 12), 30));
    const keyword = String(safeEvent.keyword || "").trim();
    const { user } = await resolveCurrentUser(event).catch(() => ({ user: null }));
    const followSets = getCommunityFollowIdSets(user);

    const res = await db.collection(COMMUNITY_POST_COLLECTION)
      .where({ status: "active" })
      .orderBy("createdAt", "desc")
      .limit(100)
      .get()
      .catch(() => ({ data: [] }));
    let posts = res && Array.isArray(res.data) ? res.data : [];
    posts = posts.filter(isVideoCommunityPost);

    if (category === "follow") {
      posts = posts.filter((item) => {
        const authorId = String(item && (item.authorId || item.authorUserId) || "").trim();
        const authorOpenId = String(item && (item.authorOpenId || item.authorOpenid) || "").trim();
        return (authorId && followSets.userIds.has(authorId))
          || (authorOpenId && followSets.openids.has(authorOpenId));
      });
    }

    posts = filterCommunityPostsByKeyword(posts, keyword);
    posts = sortCommunityPostsForCategory(posts, category).slice(0, limit);
    return {
      success: true,
      category,
      posts,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_community_posts_failed",
      posts: [],
      errMsg: e,
    };
  }
};

const toggleCommunityFollowAuthor = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const targetAuthorId = String(safeEvent.targetAuthorId || safeEvent.authorId || "").trim();
    const targetAuthorOpenId = String(safeEvent.targetAuthorOpenId || safeEvent.authorOpenId || "").trim();
    if (!targetAuthorId && !targetAuthorOpenId) {
      return { success: false, message: "author_identity_required" };
    }

    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const selfId = String(user._id || "").trim();
    const selfOpenId = String(user.openid || user._openid || "").trim();
    if (
      (targetAuthorId && targetAuthorId === selfId)
      || (targetAuthorOpenId && targetAuthorOpenId === selfOpenId)
    ) {
      return { success: false, message: "cannot_follow_self" };
    }

    const followingIds = mergeUniqueIdList(
      user.followingIds,
      user.followingUserIds,
      user.followedUserIds,
      user.communityFollowingIds,
      user.communityFollowingUserIds
    );
    const followingOpenIds = mergeUniqueIdList(
      user.followingOpenIds,
      user.followedOpenIds,
      user.communityFollowingOpenIds
    );
    const alreadyFollowing = (targetAuthorId && followingIds.includes(targetAuthorId))
      || (targetAuthorOpenId && followingOpenIds.includes(targetAuthorOpenId));
    const nextFollowing = !alreadyFollowing;
    const nextIds = nextFollowing && targetAuthorId
      ? mergeUniqueIdList(followingIds, targetAuthorId)
      : followingIds.filter((id) => id !== targetAuthorId);
    const nextOpenIds = nextFollowing && targetAuthorOpenId
      ? mergeUniqueIdList(followingOpenIds, targetAuthorOpenId)
      : followingOpenIds.filter((id) => id !== targetAuthorOpenId);

    await db.collection(USER_COLLECTION).doc(selfId).update({
      data: {
        followingIds: nextIds,
        followingUserIds: nextIds,
        followingOpenIds: nextOpenIds,
        communityFollowingIds: nextIds,
        communityFollowingOpenIds: nextOpenIds,
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      following: nextFollowing,
      followingIds: nextIds,
      followingOpenIds: nextOpenIds,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "toggle_community_follow_failed",
      errMsg: e,
    };
  }
};

const addCommunityComment = async (event) => {
  try {
    const postId = event && event.postId ? String(event.postId) : "";
    const content = event && event.content ? String(event.content).trim() : "";
    const images = normalizeMediaImages(event && event.images);
    const parentCommentId = event && event.parentCommentId ? String(event.parentCommentId).trim() : "";
    const replyToNameInput = event && event.replyToName ? String(event.replyToName).trim() : "";
    const now = new Date();

    if (!postId) {
      return { success: false, message: "post_id_required" };
    }
    if (!content && images.length === 0) {
      return { success: false, message: "content_or_images_required" };
    }
    if (content.length > 200) {
      return { success: false, message: "content_too_long" };
    }

    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const muteInfo = getCommunityMuteInfo(user);
    if (muteInfo.blocked) {
      return createCommunityBlockedResult(muteInfo);
    }

    const postRes = await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).get();
    const doc = postRes && postRes.data ? postRes.data : null;
    if (!doc) {
      return { success: false, message: "post_not_found" };
    }

    const postStatus = String(doc.status || "active").toLowerCase();
    if (postStatus === "offline" || postStatus === "removed" || postStatus === "blocked") {
      return { success: false, message: "post_unavailable" };
    }

    const currentList = Array.isArray(doc.commentList)
      ? doc.commentList.slice()
      : (Array.isArray(doc.comments) ? doc.comments.slice() : []);

    const nextCount = getCommentCount(doc) + 1;
    const authorInfo = buildAuthorFromUser(user, openid);
    const commentBase = {
      id: `comment_${Date.now()}`,
      author: authorInfo.author,
      authorId: authorInfo.id,
      authorOpenId: authorInfo.openid,
      authorName: authorInfo.author.name,
      content,
      images,
      source: authorInfo.source,
      time: now,
      createdAt: now,
    };

    const postAuthorId = String(doc.authorId || "").trim();
    const postAuthorOpenId = String(doc.authorOpenId || "").trim();
    const postDetailPath = `/pages/student/community/detail/detail?id=${postId}`;
    const notificationTasks = [];
    let commentDoc = null;

    if (parentCommentId) {
      const targetIndex = currentList.findIndex(
        (item) => String((item && item.id) || (item && item._id) || "").trim() === parentCommentId
      );
      if (targetIndex < 0) {
        return { success: false, message: "parent_comment_not_found" };
      }

      const parentComment = currentList[targetIndex] || {};
      const parentReplies = Array.isArray(parentComment.replies) ? parentComment.replies.slice() : [];
      const replyToName = String(
        parentComment.authorName
        || (parentComment.author && parentComment.author.name)
        || replyToNameInput
        || "\u7528\u6237"
      ).trim();
      const replyToAuthorId = String(parentComment.authorId || "").trim();
      const replyToAuthorOpenId = String(parentComment.authorOpenId || "").trim();

      commentDoc = {
        ...commentBase,
        parentCommentId,
        replyTo: {
          commentId: parentCommentId,
          authorId: replyToAuthorId,
          authorOpenId: replyToAuthorOpenId,
          name: replyToName,
        },
      };

      parentReplies.push(commentDoc);
      currentList[targetIndex] = {
        ...parentComment,
        replies: parentReplies,
        replyCount: parentReplies.length,
      };

      if (
        !isSameUser(authorInfo.id, authorInfo.openid, replyToAuthorId, replyToAuthorOpenId)
      ) {
        notificationTasks.push(
          createNotification({
            receiverUserId: replyToAuthorId,
            receiverOpenId: replyToAuthorOpenId,
            senderUserId: authorInfo.id,
            senderOpenId: authorInfo.openid,
            senderName: authorInfo.author.name,
            type: "community_comment_reply",
            title: "\u8bc4\u8bba\u56de\u590d\u901a\u77e5",
            content: `${authorInfo.author.name} \u56de\u590d\u4e86\u4f60\u7684\u8bc4\u8bba`,
            relatedId: postId,
            relatedType: "community_post",
            relatedPath: postDetailPath,
          }).catch(() => null)
        );
      }

      if (
        !isSameUser(authorInfo.id, authorInfo.openid, postAuthorId, postAuthorOpenId)
        && !isSameUser(postAuthorId, postAuthorOpenId, replyToAuthorId, replyToAuthorOpenId)
      ) {
        notificationTasks.push(
          createNotification({
            receiverUserId: postAuthorId,
            receiverOpenId: postAuthorOpenId,
            senderUserId: authorInfo.id,
            senderOpenId: authorInfo.openid,
            senderName: authorInfo.author.name,
            type: "community_post_reply",
            title: "\u5e16\u5b50\u56de\u590d\u901a\u77e5",
            content: `${authorInfo.author.name} \u5728\u5e16\u5b50\u4e0b\u56de\u590d\u4e86\u8bc4\u8bba`,
            relatedId: postId,
            relatedType: "community_post",
            relatedPath: postDetailPath,
          }).catch(() => null)
        );
      }
    } else {
      commentDoc = {
        ...commentBase,
        replies: [],
        replyCount: 0,
      };
      currentList.push(commentDoc);

      if (!isSameUser(authorInfo.id, authorInfo.openid, postAuthorId, postAuthorOpenId)) {
        notificationTasks.push(
          createNotification({
            receiverUserId: postAuthorId,
            receiverOpenId: postAuthorOpenId,
            senderUserId: authorInfo.id,
            senderOpenId: authorInfo.openid,
            senderName: authorInfo.author.name,
            type: "community_post_comment",
            title: "\u5e16\u5b50\u8bc4\u8bba\u901a\u77e5",
            content: `${authorInfo.author.name} \u8bc4\u8bba\u4e86\u4f60\u7684\u5e16\u5b50`,
            relatedId: postId,
            relatedType: "community_post",
            relatedPath: postDetailPath,
          }).catch(() => null)
        );
      }
    }

    await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).update({
      data: {
        commentList: currentList,
        comments: nextCount,
        commentCount: nextCount,
        updatedAt: db.serverDate(),
      },
    });

    if (notificationTasks.length) {
      await Promise.all(notificationTasks);
    }

    return {
      success: true,
      comment: commentDoc,
      commentCount: nextCount,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "add_comment_failed",
      errMsg: e,
    };
  }
};

const viewCommunityPost = async (event) => {
  try {
    const postId = event && event.postId ? String(event.postId) : "";
    if (!postId) {
      return { success: false, message: "post_id_required" };
    }

    const postRes = await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).get();
    const doc = postRes && postRes.data ? postRes.data : null;
    if (!doc) {
      return { success: false, message: "post_not_found" };
    }

    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";
    const userId = event && event.userId ? String(event.userId).trim() : "";
    const viewedOpenIds = normalizeOpenIdList(doc.viewedOpenIds);
    const viewedUserIds = normalizeIdList(doc.viewedUserIds);
    const currentViews = Math.max(
      resolveNumber(doc.views || doc.viewCount || 0),
      viewedOpenIds.length,
      viewedUserIds.length
    );

    const useUserId = !!userId;
    const viewerKey = useUserId ? userId : openid;
    if (!viewerKey) {
      return {
        success: true,
        views: currentViews,
        counted: false,
      };
    }

    const viewedList = useUserId ? viewedUserIds : viewedOpenIds;
    if (viewedList.includes(viewerKey)) {
      return {
        success: true,
        views: currentViews,
        counted: false,
      };
    }

    const nextViewedOpenIds = useUserId ? viewedOpenIds : viewedOpenIds.concat(viewerKey);
    const nextViewedUserIds = useUserId ? viewedUserIds.concat(viewerKey) : viewedUserIds;
    const nextViews = currentViews + 1;

    await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).update({
      data: {
        views: nextViews,
        viewCount: nextViews,
        viewedOpenIds: nextViewedOpenIds,
        viewedUserIds: nextViewedUserIds,
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      views: nextViews,
      counted: true,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "view_post_failed",
      errMsg: e,
    };
  }
};

const toggleCommunityLike = async (event) => {
  try {
    const postId = event && event.postId ? String(event.postId) : "";
    if (!postId) {
      return { success: false, message: "post_id_required" };
    }

    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";
    if (!openid) {
      return { success: false, message: "openid_not_found" };
    }

    const postRes = await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).get();
    const doc = postRes && postRes.data ? postRes.data : null;
    if (!doc) {
      return { success: false, message: "post_not_found" };
    }

    const likeList = normalizeOpenIdList(doc.likedOpenIds);
    const likedIndex = likeList.indexOf(openid);
    const hasLiked = likedIndex > -1;
    const nextLiked = !hasLiked;

    const nextLikeList = likeList.slice();
    if (nextLiked) {
      nextLikeList.push(openid);
    } else {
      nextLikeList.splice(likedIndex, 1);
    }

    const currentLikes = resolveNumber(doc.likes || doc.likeCount || 0);
    const nextLikes = nextLiked
      ? currentLikes + 1
      : Math.max(0, currentLikes - 1);

    await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).update({
      data: {
        likes: nextLikes,
        likeCount: nextLikes,
        likedOpenIds: nextLikeList,
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      liked: nextLiked,
      likes: nextLikes,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "toggle_like_failed",
      errMsg: e,
    };
  }
};

/**
 * 删除社区帖子（管理员可删除任意帖子，发布者只能删除自己的）
 */
const deleteCommunityPost = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const postId = String(safeEvent.postId || "").trim();
    if (!postId) {
      return { success: false, message: "post_id_required" };
    }

    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "student_or_coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }
    const currentUserId = String(currentUser._id);
    const isAdmin = hasAdminAccess(currentUser);

    const postRes = await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).get();
    const postDoc = postRes && postRes.data ? postRes.data : null;
    if (!postDoc) {
      return { success: false, message: "post_not_found" };
    }

    // 允许条件：管理员 或 发布者本人
    const authorId = String(postDoc.uploaderId || postDoc.authorId || postDoc.authorUserId || "");
    if (!isAdmin && authorId !== currentUserId) {
      return { success: false, message: "permission_denied" };
    }

    await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).remove();

    return {
      success: true,
      removed: true,
      postId,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "delete_post_failed",
    };
  }
};

const moderateCommunityPost = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const postId = event && event.postId ? String(event.postId).trim() : "";
    const reasonRaw = event && event.reason ? String(event.reason).trim() : "";
    const reason = reasonRaw || "Content violated rules and was removed";

    if (!postId) {
      return { success: false, message: "post_id_required" };
    }

    const operatorUserId = String(safeEvent.userId || "").trim();
    const { user: adminUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "admin",
      preferUserId: !!operatorUserId,
    });
    if (!adminUser || !adminUser._id) {
      return { success: false, message: "admin_user_not_found" };
    }
    if (!hasAdminAccess(adminUser)) {
      return { success: false, message: "permission_denied" };
    }

    const postRes = await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).get();
    const postDoc = postRes && postRes.data ? postRes.data : null;
    if (!postDoc) {
      return { success: false, message: "post_not_found" };
    }

    await db.collection(COMMUNITY_POST_COLLECTION).doc(postId).remove();

    await createCommunityActivity(
      `${adminUser.name || "\u7ba1\u7406\u5458"}\u5904\u7406\u4e86\u8fdd\u89c4\u5e16\u5b50`,
      postId
    ).catch(() => {});

    return {
      success: true,
      removed: true,
      reason,
      postId,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "moderate_post_failed",
      errMsg: e,
    };
  }
};

const loginByPhonePassword = async (event) => {
  try {
    const phone = normalizePhone(event && event.phone);
    const password = normalizePassword(event && event.password);
    if (!isValidPhone(phone)) {
      return { success: false, message: "invalid_phone" };
    }
    if (!isValidPassword(password)) {
      return { success: false, message: "password_too_short" };
    }

    const queryRes = await db.collection(USER_COLLECTION)
      .where({ phone })
      .field(LOGIN_USER_QUERY_FIELDS)
      .limit(20)
      .get()
      .catch(() => ({ data: [] }));
    const list = Array.isArray(queryRes && queryRes.data) ? queryRes.data : [];
    let user = list.find((item) => hasStudentRole(item) || hasCoachRole(item) || hasAdminAccess(item)) || list[0] || null;
    let created = false;

    if (!user || !user._id) {
      const defaultName = buildRoleSetDefaultName(phone);
      const addRes = await db.collection(USER_COLLECTION).add({
        data: {
          name: defaultName,
          nickName: defaultName,
          phone,
          openid: "",
          avatarUrl: "",
          role: "user",
          status: "active",
          level: 0,
          adminAccess: false,
          coachId: "",
          coachIds: [],
          joinDate: "",
          studentSince: "",
          roleUpdatedAt: "",
          passwordHash: hashPassword(password),
          passwordUpdatedAt: db.serverDate(),
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      const userId = String(addRes && addRes._id ? addRes._id : "").trim();
      if (!userId) {
        return { success: false, message: "account_auto_register_failed" };
      }
      user = {
        _id: userId,
        name: defaultName,
        nickName: defaultName,
        phone,
        openid: "",
        avatarUrl: "",
        role: "user",
        status: "active",
        level: 0,
        adminAccess: false,
        coachId: "",
        coachIds: [],
        joinDate: "",
        studentSince: "",
        roleUpdatedAt: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordHash: hashPassword(password),
      };
      created = true;
    }

    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    let savedHash = String(user.passwordHash || "").trim();
    if (!savedHash && password === DEFAULT_LOGIN_PASSWORD) {
      const defaultHash = hashPassword(DEFAULT_LOGIN_PASSWORD);
      // Do not block login on this write; best-effort backfill to reduce timeout risk.
      db.collection(USER_COLLECTION).doc(user._id).update({
        data: {
          passwordHash: defaultHash,
          passwordUpdatedAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      }).catch(() => null);
      savedHash = defaultHash;
    }
    if (!savedHash) {
      return { success: false, message: "password_not_set" };
    }
    const inputHash = hashPassword(password);
    if (savedHash !== inputHash) {
      return { success: false, message: "password_incorrect" };
    }

    const safeUser = { ...(user || {}) };
    if (hasOwn(safeUser, "passwordHash")) {
      delete safeUser.passwordHash;
    }
    return {
      success: true,
      created,
      user: safeUser,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "login_by_phone_password_failed",
      errMsg: e,
    };
  }
};

const changeMyPassword = async (event) => {
  try {
    const oldPassword = normalizePassword(event && (event.oldPassword || event.currentPassword));
    const newPassword = normalizePassword(event && (event.newPassword || event.password));
    if (!oldPassword) {
      return { success: false, message: "old_password_required" };
    }
    if (!isValidPassword(newPassword)) {
      return { success: false, message: "password_too_short" };
    }

    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    const savedHash = String(user.passwordHash || "").trim();
    if (!savedHash) {
      return { success: false, message: "password_not_set" };
    }

    const oldHash = hashPassword(oldPassword);
    if (oldHash !== savedHash) {
      return { success: false, message: "old_password_incorrect" };
    }

    const nextHash = hashPassword(newPassword);
    if (nextHash === savedHash) {
      return { success: false, message: "password_same_as_old" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        passwordHash: nextHash,
        passwordUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "change_my_password_failed",
      errMsg: e,
    };
  }
};

const setInitialPassword = async (event) => {
  try {
    const newPassword = normalizePassword(event && (event.newPassword || event.password));
    if (!isValidPassword(newPassword)) {
      return { success: false, message: "password_too_short" };
    }

    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    const savedHash = String(user.passwordHash || "").trim();
    if (savedHash) {
      return { success: false, message: "password_already_set" };
    }

    const nextHash = hashPassword(newPassword);

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        passwordHash: nextHash,
        passwordUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "set_initial_password_failed",
      errMsg: e,
    };
  }
};

const sendSmsCode = async (event) => {
  try {
    const phone = String(event && event.phone || "").trim();
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return { success: false, message: "invalid_phone" };
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expireAt = Date.now() + 5 * 60 * 1000;

    console.log(`[sendSmsCode] phone=${phone}, code=${code}, expireAt=${new Date(expireAt).toISOString()}`);

    try {
      await db.collection(SMS_CODE_COLLECTION).add({
        data: {
          phone,
          code,
          expireAt,
          createdAt: db.serverDate(),
        },
      });
    } catch (addErr) {
      if (isCollectionNotExistsError(addErr)) {
        await db.createCollection(SMS_CODE_COLLECTION);
        await db.collection(SMS_CODE_COLLECTION).add({
          data: {
            phone,
            code,
            expireAt,
            createdAt: db.serverDate(),
          },
        });
      } else {
        throw addErr;
      }
    }

    return { success: true, code };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "send_sms_code_failed",
      errMsg: e,
    };
  }
};

const resetPasswordWithCode = async (event) => {
  try {
    const phone = String(event && event.phone || "").trim();
    const code = String(event && event.code || "").trim();
    const newPassword = normalizePassword(event && (event.newPassword || event.password));

    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      return { success: false, message: "invalid_phone" };
    }
    if (!code || !/^\d{6}$/.test(code)) {
      return { success: false, message: "sms_code_error" };
    }
    if (!isValidPassword(newPassword)) {
      return { success: false, message: "password_too_short" };
    }

    const userRes = await db.collection(USER_COLLECTION).where({ phone }).get();
    const users = userRes && userRes.data ? userRes.data : [];
    if (!users.length) {
      return { success: false, message: "phone_not_registered" };
    }

    const user = users[0];
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    const smsRes = await db.collection(SMS_CODE_COLLECTION).where({
      phone,
      code,
      expireAt: db.command.gt(Date.now()),
    }).orderBy("createdAt", "desc").limit(1).get();

    const smsCodes = smsRes && smsRes.data ? smsRes.data : [];
    if (!smsCodes.length) {
      const expiredRes = await db.collection(SMS_CODE_COLLECTION).where({
        phone,
        code,
        expireAt: db.command.lte(Date.now()),
      }).orderBy("createdAt", "desc").limit(1).get();
      const expiredCodes = expiredRes && expiredRes.data ? expiredRes.data : [];
      if (expiredCodes.length) {
        return { success: false, message: "sms_code_expired" };
      }
      return { success: false, message: "sms_code_error" };
    }

    await db.collection(SMS_CODE_COLLECTION).where({ phone, code }).remove();

    const nextHash = hashPassword(newPassword);

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        password: newPassword,
        passwordHash: nextHash,
        passwordUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "reset_password_with_code_failed",
      errMsg: e,
    };
  }
};

const applyCoachCertification = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = String(user.role || "").trim().toLowerCase();
    const roles = Array.isArray(user.roles) ? user.roles.map((r) => String(r || "").trim().toLowerCase()) : [];
    if (!role.includes("coach") && !roles.includes("coach") && !role.includes("admin") && !roles.includes("admin")) {
      return { success: false, message: "not_a_coach" };
    }

    const materials = event && event.materials ? event.materials : {};
    if (!materials.idCardFront || !materials.idCardBack) {
      return { success: false, message: "missing_id_card" };
    }
    if (!materials.certificates || !Array.isArray(materials.certificates) || materials.certificates.length === 0) {
      return { success: false, message: "missing_certificates" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        certificationStatus: "待审核",
        certificationMaterials: materials,
        certificationRemark: "",
        applyTime: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "apply_certification_failed",
      errMsg: e,
    };
  }
};

const getCertificationStatus = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    return {
      success: true,
      data: {
        certificationStatus: user.certificationStatus || "未认证",
        certificationMaterials: user.certificationMaterials || {},
        certificationRemark: user.certificationRemark || "",
        applyTime: user.applyTime,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_certification_status_failed",
      errMsg: e,
    };
  }
};

const adminGetPendingList = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = String(user.role || "").trim().toLowerCase();
    const roles = Array.isArray(user.roles) ? user.roles.map((r) => String(r || "").trim().toLowerCase()) : [];
    if (!role.includes("admin") && !roles.includes("admin")) {
      return { success: false, message: "permission_denied" };
    }

    const res = await db.collection(USER_COLLECTION)
      .where({
        certificationStatus: "待审核",
      })
      .orderBy("applyTime", "desc")
      .get();

    return {
      success: true,
      list: res && res.data ? res.data : [],
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_pending_list_failed",
      errMsg: e,
    };
  }
};

const adminReviewCertification = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = String(user.role || "").trim().toLowerCase();
    const roles = Array.isArray(user.roles) ? user.roles.map((r) => String(r || "").trim().toLowerCase()) : [];
    if (!role.includes("admin") && !roles.includes("admin")) {
      return { success: false, message: "permission_denied" };
    }

    const targetUserId = String(event && event.userId || "").trim();
    if (!targetUserId) {
      return { success: false, message: "target_user_id_required" };
    }

    const status = String(event && event.status || "").trim();
    if (!["已认证", "已拒绝"].includes(status)) {
      return { success: false, message: "invalid_status" };
    }

    const remark = String(event && event.remark || "").trim();

    await db.collection(USER_COLLECTION).doc(targetUserId).update({
      data: {
        certificationStatus: status,
        certificationRemark: remark,
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "review_certification_failed",
      errMsg: e,
    };
  }
};

const resetMyPassword = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    const confirmPhone = normalizePhone(event && (event.phone || event.confirmPhone));
    const userPhone = normalizePhone(user && user.phone);
    if (confirmPhone && userPhone && confirmPhone !== userPhone) {
      return { success: false, message: "phone_mismatch" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        passwordHash: hashPassword(DEFAULT_LOGIN_PASSWORD),
        passwordUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      defaultPassword: DEFAULT_LOGIN_PASSWORD,
      needChangeAfterLogin: true,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "reset_my_password_failed",
      errMsg: e,
    };
  }
};

const resetPasswordByPhone = async (event) => {
  try {
    const phone = normalizePhone(event && event.phone);
    const newPassword = normalizePassword(event && (event.newPassword || event.password));
    if (!isValidPhone(phone)) {
      return { success: false, message: "invalid_phone" };
    }

    const queryRes = await db.collection(USER_COLLECTION).where({ phone }).limit(20).get().catch(() => ({ data: [] }));
    const list = Array.isArray(queryRes && queryRes.data) ? queryRes.data : [];
    if (!list.length) {
      return { success: false, message: "account_not_found" };
    }

    const user = list.find((item) => hasStudentRole(item) || hasCoachRole(item) || hasAdminAccess(item)) || list[0];
    if (!user || !user._id) {
      return { success: false, message: "account_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    const usePassword = isValidPassword(newPassword) ? newPassword : DEFAULT_LOGIN_PASSWORD;

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        passwordHash: hashPassword(usePassword),
        passwordUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      defaultPassword: usePassword,
      userId: String(user._id || "").trim(),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "reset_password_by_phone_failed",
      errMsg: e,
    };
  }
};

const updateMyProfile = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const patchInput = safeEvent.patch && typeof safeEvent.patch === "object"
      ? safeEvent.patch
      : {};
    const fallbackPatch = {
      name: safeEvent.name,
      nickName: safeEvent.nickName,
      avatarUrl: safeEvent.avatarUrl,
      teachYear: safeEvent.teachYear,
    };
    const sourcePatch = Object.keys(patchInput).length ? patchInput : fallbackPatch;

    const nextPatch = {};
    const hasName = Object.prototype.hasOwnProperty.call(sourcePatch, "name");
    const hasNickName = Object.prototype.hasOwnProperty.call(sourcePatch, "nickName");
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(sourcePatch, "avatarUrl");
    const hasTeachYear = Object.prototype.hasOwnProperty.call(sourcePatch, "teachYear");

    if (hasName) {
      const name = String(sourcePatch.name || "").trim();
      if (!name) {
        return { success: false, message: "invalid_name" };
      }
      if (name.length > 20) {
        return { success: false, message: "name_too_long" };
      }
      nextPatch.name = name;
    }

    if (hasNickName) {
      const nickName = String(sourcePatch.nickName || "").trim();
      if (!nickName) {
        return { success: false, message: "invalid_nickname" };
      }
      if (nickName.length > 20) {
        return { success: false, message: "nickname_too_long" };
      }
      nextPatch.nickName = nickName;
    }

    if (hasName && !hasNickName) {
      nextPatch.nickName = nextPatch.name;
    }

    if (hasAvatarUrl) {
      const avatarUrl = String(sourcePatch.avatarUrl || "").trim();
      if (avatarUrl.length > 1024) {
        return { success: false, message: "avatar_url_too_long" };
      }
      nextPatch.avatarUrl = avatarUrl;
    }

    if (hasTeachYear) {
      const teachYear = Number(sourcePatch.teachYear);
      if (!Number.isFinite(teachYear) || teachYear <= 0 || teachYear > 99) {
        return { success: false, message: "invalid_teach_year" };
      }
      nextPatch.teachYear = teachYear;
    }

    if (!Object.keys(nextPatch).length) {
      return { success: false, message: "empty_profile_patch" };
    }

    const { user } = await resolveCurrentUser(safeEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        ...nextPatch,
        updatedAt: db.serverDate(),
      },
    });

    const latestRes = await db.collection(USER_COLLECTION).doc(user._id).get().catch(() => null);
    const latestUser = latestRes && latestRes.data ? latestRes.data : {
      ...user,
      ...nextPatch,
    };
    const safeUser = { ...(latestUser || {}) };
    if (hasOwn(safeUser, "passwordHash")) {
      delete safeUser.passwordHash;
    }
    return {
      success: true,
      user: safeUser,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "update_my_profile_failed",
      errMsg: e,
    };
  }
};

const bindUserPhone = async (event) => {
  try {
    const phone = normalizePhone(event && event.phone);
    const userId = event && event.userId ? String(event.userId) : "";

    if (!isValidPhone(phone)) {
      return { success: false, message: "invalid_phone" };
    }

    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";

    let currentUser = null;
    if (openid) {
      const res = await db.collection(USER_COLLECTION).where({ openid }).limit(1).get();
      const list = res && res.data ? res.data : [];
      if (list.length) {
        currentUser = list[0];
      }
    }
    if (!currentUser && userId) {
      const doc = await db.collection(USER_COLLECTION).doc(userId).get();
      currentUser = doc && doc.data ? doc.data : null;
    }
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const conflictRes = await db.collection(USER_COLLECTION).where({ phone }).limit(1).get();
    const conflictList = conflictRes && conflictRes.data ? conflictRes.data : [];
    if (conflictList.length && conflictList[0]._id !== currentUser._id) {
      return { success: false, message: "phone_in_use" };
    }

    await db.collection(USER_COLLECTION).doc(currentUser._id).update({
      data: {
        phone,
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      user: {
        id: currentUser._id,
        phone,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "bind_phone_failed",
      errMsg: e,
    };
  }
};

const getWechatPhoneNumber = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const code = String(safeEvent.code || "").trim();

    if (!code) {
      return { success: false, message: "code_required" };
    }

    if (!cloud.getPhoneNumber) {
      return { success: false, message: "sdk_version_not_supported", reason: "wx-server-sdk version < 2.6.0" };
    }

    const result = await cloud.getPhoneNumber({
      code,
    });

    const phoneInfo = result && result.phoneInfo ? result.phoneInfo : {};
    const phoneNumber = phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || "";

    if (!phoneNumber) {
      return { success: false, message: "phone_number_not_found" };
    }

    return {
      success: true,
      phoneNumber,
      phone: phoneNumber,
      countryCode: phoneInfo.countryCode || "",
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_phone_number_failed",
      errMsg: e,
    };
  }
};

const bindUserPhoneByCode = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const phone = normalizePhone(safeEvent.phone);
    const code = String(safeEvent.code || "").trim();

    if (!isValidPhone(phone)) {
      return { success: false, message: "invalid_phone" };
    }

    const { user } = await resolveCurrentUser(safeEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const conflictRes = await db.collection(USER_COLLECTION).where({ phone }).limit(1).get();
    const conflictList = conflictRes && conflictRes.data ? conflictRes.data : [];
    if (conflictList.length && conflictList[0]._id !== user._id) {
      return { success: false, message: "phone_in_use" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        phone,
        updatedAt: db.serverDate(),
      },
    });

    const latestRes = await db.collection(USER_COLLECTION).doc(user._id).get().catch(() => null);
    const latestUser = latestRes && latestRes.data ? latestRes.data : user;
    return {
      success: true,
      phone,
      user: latestUser,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "bind_phone_by_code_failed",
      errMsg: e,
    };
  }
};

const assignStudentToCoach = async (event) => {
  try {
    const coachId = event && event.coachId ? String(event.coachId).trim() : "";
    const studentId = event && event.studentId ? String(event.studentId).trim() : "";
    const phone = normalizePhone(event && event.phone);

    if (!coachId) {
      return { success: false, message: "coach_id_required" };
    }
    if (!studentId && !isValidPhone(phone)) {
      return { success: false, message: "student_phone_or_id_required" };
    }

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const operatorRole = normalizeRole(operator.role);

    const coachDoc = await db.collection(USER_COLLECTION).doc(coachId).get();
    const coach = coachDoc && coachDoc.data ? coachDoc.data : null;
    if (!coach) {
      return { success: false, message: "coach_not_found" };
    }
    const coachRole = normalizeRole(coach.role);
    if (coachRole !== "coach" && coachRole !== "admin") {
      return { success: false, message: "coach_not_found" };
    }
    const operatorId = String(operator._id || "").trim();
    if (operatorRole === "coach" && coachId !== operatorId) {
      return { success: false, message: "permission_denied" };
    }
    if (operatorRole === "admin") {
      const allowedCoachIds = await filterCoachIdsByAdminScope(operator, [coachId]);
      if (!allowedCoachIds.length && coachId !== operatorId) {
        return { success: false, message: "permission_denied" };
      }
    }

    let student = null;
    if (studentId) {
      const doc = await db.collection(USER_COLLECTION).doc(studentId).get();
      student = doc && doc.data ? doc.data : null;
    } else {
      const res = await db.collection(USER_COLLECTION).where({ phone }).limit(1).get();
      const list = res && res.data ? res.data : [];
      student = list.length ? list[0] : null;
    }

    if (!student || !student._id) {
      return { success: false, message: "student_not_found" };
    }
    if (student._id === coachId) {
      return { success: false, message: "invalid_student" };
    }
    const studentRole = normalizeRole(student.role);
    if (studentRole === "coach" || studentRole === "admin") {
      return { success: false, message: "invalid_student_role" };
    }

    const existingCoachId = String(student.coachId || "").trim();
    const existingCoachIds = mergeUniqueIdList(
      normalizeIdList(student.coachIds),
      existingCoachId
    );
    const coachAdminOwnerIds = mergeUniqueIdList(
      extractUserAdminOwnerIds(coach, null),
      coachRole === "admin" ? coachId : ""
    );
    let sharedCoachIds = [coachId];
    if (coachRole === "admin") {
      const managedCoachIds = await queryManagedCoachIdsByAdmin(coach).catch(() => []);
      sharedCoachIds = mergeUniqueIdList(sharedCoachIds, managedCoachIds);
    } else {
      const peerCoachIds = await queryPeerCoachIdsByCoach(coach).catch(() => []);
      sharedCoachIds = mergeUniqueIdList(sharedCoachIds, peerCoachIds);
    }
    const scopedCoachIds = mergeUniqueIdList(sharedCoachIds);
    const existingInScopeCoachIds = existingCoachIds.filter((id) => scopedCoachIds.includes(id));
    const nextCoachIds = mergeUniqueIdList(existingInScopeCoachIds, scopedCoachIds);
    const nextCoachId = (existingCoachId && nextCoachIds.includes(existingCoachId))
      ? existingCoachId
      : (nextCoachIds[0] || coachId);
    const studentAdminOwnerIds = coachAdminOwnerIds.length
      ? coachAdminOwnerIds
      : mergeUniqueIdList(extractUserAdminOwnerIds(student, null));

    const wasStudent = normalizeRole(student.role) === "student";
    const hasStudentSince = !!student.studentSince;
    const alreadyBoundToCoach = existingCoachIds.includes(coachId);
    const updateData = {
      role: "student",
      coachId: nextCoachId,
      coachIds: nextCoachIds,
      status: student.status || "active",
      roleUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate(),
      ...buildAdminOwnerPatch(studentAdminOwnerIds),
    };
    if (!wasStudent || !hasStudentSince || !alreadyBoundToCoach) {
      updateData.studentSince = db.serverDate();
    }

    await db.collection(USER_COLLECTION).doc(student._id).update({
      data: updateData,
    });

    return {
      success: true,
      student: {
        id: student._id,
        phone: student.phone || phone,
        name: student.name || "",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "assign_student_failed",
      errMsg: e,
    };
  }
};

const removeStudentFromCoach = async (event) => {
  try {
    const coachId = event && event.coachId ? String(event.coachId).trim() : "";
    const studentId = event && event.studentId ? String(event.studentId).trim() : "";

    if (!coachId) {
      return { success: false, message: "coach_id_required" };
    }
    if (!studentId) {
      return { success: false, message: "student_id_required" };
    }

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const operatorRole = normalizeRole(operator.role);

    const coachDoc = await db.collection(USER_COLLECTION).doc(coachId).get();
    const coach = coachDoc && coachDoc.data ? coachDoc.data : null;
    if (!coach) {
      return { success: false, message: "coach_not_found" };
    }
    const coachRole = normalizeRole(coach.role);
    if (coachRole !== "coach" && coachRole !== "admin") {
      return { success: false, message: "coach_not_found" };
    }
    const operatorId = String(operator._id || "").trim();
    if (operatorRole === "coach" && coachId !== operatorId) {
      return { success: false, message: "permission_denied" };
    }
    if (operatorRole === "admin") {
      const allowedCoachIds = await filterCoachIdsByAdminScope(operator, [coachId]);
      if (!allowedCoachIds.length && coachId !== operatorId) {
        return { success: false, message: "permission_denied" };
      }
    }

    const studentDoc = await db.collection(USER_COLLECTION).doc(studentId).get();
    const student = studentDoc && studentDoc.data ? studentDoc.data : null;
    if (!student || !student._id) {
      return { success: false, message: "student_not_found" };
    }
    if (student._id === coachId) {
      return { success: false, message: "invalid_student" };
    }
    const studentRole = normalizeRole(student.role);
    if (studentRole === "coach" || studentRole === "admin") {
      return { success: false, message: "invalid_student_role" };
    }

    const existingCoachId = String(student.coachId || "").trim();
    const existingCoachIds = mergeUniqueIdList(
      normalizeIdList(student.coachIds),
      existingCoachId
    );

    if (!existingCoachIds.includes(coachId)) {
      return { success: false, message: "student_not_assigned_to_coach" };
    }

    let sharedCoachIds = [coachId];
    if (coachRole === "admin") {
      const managedCoachIds = await queryManagedCoachIdsByAdmin(coach).catch(() => []);
      sharedCoachIds = mergeUniqueIdList(sharedCoachIds, managedCoachIds);
    } else {
      const peerCoachIds = await queryPeerCoachIdsByCoach(coach).catch(() => []);
      sharedCoachIds = mergeUniqueIdList(sharedCoachIds, peerCoachIds);
    }

    const nextCoachIds = existingCoachIds.filter((id) => !sharedCoachIds.includes(id));
    const nextCoachId = nextCoachIds.length > 0 ? nextCoachIds[0] : "";

    const updateData = {
      coachId: nextCoachId,
      coachIds: nextCoachIds,
      coachID: nextCoachId,
      coachIDs: nextCoachIds,
      updatedAt: db.serverDate(),
    };

    if (nextCoachIds.length === 0) {
      updateData.role = "user";
      updateData.status = "inactive";
    }

    await db.collection(USER_COLLECTION).doc(student._id).update({
      data: updateData,
    });

    return {
      success: true,
      student: {
        id: student._id,
        phone: student.phone || "",
        name: student.name || "",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "remove_student_failed",
      errMsg: e,
    };
  }
};

const transferStudentToCoach = async (event) => {
  try {
    const coachId = event && event.coachId ? String(event.coachId).trim() : "";
    const studentId = event && event.studentId ? String(event.studentId).trim() : "";
    const targetCoachId = event && event.targetCoachId ? String(event.targetCoachId).trim() : "";

    if (!coachId) {
      return { success: false, message: "coach_id_required" };
    }
    if (!studentId) {
      return { success: false, message: "student_id_required" };
    }
    if (!targetCoachId) {
      return { success: false, message: "target_coach_id_required" };
    }
    if (coachId === targetCoachId) {
      return { success: false, message: "target_coach_same_as_current" };
    }

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const operatorRole = normalizeRole(operator.role);

    const coachDoc = await db.collection(USER_COLLECTION).doc(coachId).get();
    const coach = coachDoc && coachDoc.data ? coachDoc.data : null;
    if (!coach) {
      return { success: false, message: "coach_not_found" };
    }
    const coachRole = normalizeRole(coach.role);
    if (coachRole !== "coach" && coachRole !== "admin") {
      return { success: false, message: "coach_not_found" };
    }
    const operatorId = String(operator._id || "").trim();
    if (operatorRole === "coach" && coachId !== operatorId) {
      return { success: false, message: "permission_denied" };
    }
    if (operatorRole === "admin") {
      const allowedCoachIds = await filterCoachIdsByAdminScope(operator, [coachId]);
      if (!allowedCoachIds.length && coachId !== operatorId) {
        return { success: false, message: "permission_denied" };
      }
    }

    const targetCoachDoc = await db.collection(USER_COLLECTION).doc(targetCoachId).get();
    const targetCoach = targetCoachDoc && targetCoachDoc.data ? targetCoachDoc.data : null;
    if (!targetCoach) {
      return { success: false, message: "target_coach_not_found" };
    }
    const targetCoachRole = normalizeRole(targetCoach.role);
    if (targetCoachRole !== "coach" && targetCoachRole !== "admin") {
      return { success: false, message: "target_coach_not_found" };
    }

    const studentDoc = await db.collection(USER_COLLECTION).doc(studentId).get();
    const student = studentDoc && studentDoc.data ? studentDoc.data : null;
    if (!student || !student._id) {
      return { success: false, message: "student_not_found" };
    }
    if (student._id === coachId || student._id === targetCoachId) {
      return { success: false, message: "invalid_student" };
    }
    const studentRole = normalizeRole(student.role);
    if (studentRole === "coach" || studentRole === "admin") {
      return { success: false, message: "invalid_student_role" };
    }

    const existingCoachId = String(student.coachId || "").trim();
    const existingCoachIds = mergeUniqueIdList(
      normalizeIdList(student.coachIds),
      existingCoachId
    );

    if (!existingCoachIds.includes(coachId)) {
      return { success: false, message: "student_not_assigned_to_coach" };
    }

    let currentSharedCoachIds = [coachId];
    if (coachRole === "admin") {
      const managedCoachIds = await queryManagedCoachIdsByAdmin(coach).catch(() => []);
      currentSharedCoachIds = mergeUniqueIdList(currentSharedCoachIds, managedCoachIds);
    } else {
      const peerCoachIds = await queryPeerCoachIdsByCoach(coach).catch(() => []);
      currentSharedCoachIds = mergeUniqueIdList(currentSharedCoachIds, peerCoachIds);
    }

    const remainingCoachIds = existingCoachIds.filter((id) => !currentSharedCoachIds.includes(id));

    const targetCoachAdminOwnerIds = mergeUniqueIdList(
      extractUserAdminOwnerIds(targetCoach, null),
      targetCoachRole === "admin" ? targetCoachId : ""
    );
    let targetSharedCoachIds = [targetCoachId];
    if (targetCoachRole === "admin") {
      const managedCoachIds = await queryManagedCoachIdsByAdmin(targetCoach).catch(() => []);
      targetSharedCoachIds = mergeUniqueIdList(targetSharedCoachIds, managedCoachIds);
    } else {
      const peerCoachIds = await queryPeerCoachIdsByCoach(targetCoach).catch(() => []);
      targetSharedCoachIds = mergeUniqueIdList(targetSharedCoachIds, peerCoachIds);
    }

    const nextCoachIds = mergeUniqueIdList(remainingCoachIds, targetSharedCoachIds);
    const nextCoachId = nextCoachIds.length > 0 ? nextCoachIds[0] : targetCoachId;
    const studentAdminOwnerIds = targetCoachAdminOwnerIds.length
      ? targetCoachAdminOwnerIds
      : mergeUniqueIdList(extractUserAdminOwnerIds(student, null));

    const updateData = {
      role: "student",
      coachId: nextCoachId,
      coachIds: nextCoachIds,
      status: student.status || "active",
      roleUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate(),
      ...buildAdminOwnerPatch(studentAdminOwnerIds),
    };

    await db.collection(USER_COLLECTION).doc(student._id).update({
      data: updateData,
    });

    return {
      success: true,
      student: {
        id: student._id,
        phone: student.phone || "",
        name: student.name || "",
      },
      targetCoach: {
        id: targetCoach._id,
        name: targetCoach.name || "",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "transfer_student_failed",
      errMsg: e,
    };
  }
};

const listCoachesAndAdmins = async (event) => {
  try {
    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied", users: [] };
    }

    const _ = db.command;
    const res = await db.collection(USER_COLLECTION)
      .where({
        role: _.in(["coach", "admin"])
      })
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const dataList = res && res.data ? res.data : [];
    const users = dataList.map((item) => ({
      id: String(item._id || item.id || "").trim(),
      name: String(item.name || item.nickName || "").trim() || "未命名",
      phone: normalizePhone(item.phone || ""),
      role: normalizeRole(item.role)
    }));

    return {
      success: true,
      users
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coaches_admins_failed",
      errMsg: e,
      users: []
    };
  }
};

const assignStudentToClass = async (event) => {
  try {
    const coachId = event && event.coachId ? String(event.coachId).trim() : "";
    const studentId = event && event.studentId ? String(event.studentId).trim() : "";
    const className = event && event.className ? String(event.className).trim() : "";

    if (!coachId) {
      return { success: false, message: "coach_id_required" };
    }
    if (!studentId) {
      return { success: false, message: "student_id_required" };
    }

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }

    const studentDoc = await db.collection(USER_COLLECTION).doc(studentId).get();
    const student = studentDoc && studentDoc.data ? studentDoc.data : null;
    if (!student || !student._id) {
      return { success: false, message: "student_not_found" };
    }

    const existingCoachId = String(student.coachId || "").trim();
    const existingCoachIds = mergeUniqueIdList(
      normalizeIdList(student.coachIds),
      existingCoachId
    );
    if (!existingCoachIds.includes(coachId)) {
      return { success: false, message: "student_not_assigned_to_coach" };
    }

    const updateData = {
      className: className || "",
      studentSince: student.studentSince || db.serverDate(),
      roleUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };

    await db.collection(USER_COLLECTION).doc(student._id).update({
      data: updateData,
    });

    return {
      success: true,
      student: {
        id: student._id,
        name: student.name || "",
        className: className || "",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "assign_student_to_class_failed",
      errMsg: e,
    };
  }
};

const formatPermissionManageUser = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const role = normalizeRole(safeUser.role);
  const levelCode = Number(safeUser.level);
  const levelLabelMap = {
    1: "助理教练",
    2: "初级教练员",
    3: "中级教练员",
    4: "高级教练员",
  };
  const roleLabel = role === "admin"
    ? "管理员"
    : (role === "coach" ? "教练" : "用户");
  const adminAccess = hasAdminAccess(safeUser);
  return {
    id: String(safeUser._id || safeUser.id || "").trim(),
    name: String(safeUser.name || safeUser.nickName || "").trim() || "未命名",
    phone: normalizePhone(safeUser.phone || ""),
    role,
    roleLabel,
    level: Number.isInteger(levelCode) ? levelCode : 0,
    levelLabel: role === "coach" ? (levelLabelMap[levelCode] || "") : "",
    adminAccess,
    adminAccessSource: role === "admin" ? "role" : (adminAccess ? "flag" : "none"),
    updatedAt: safeUser.updatedAt || safeUser.roleUpdatedAt || safeUser.createdAt || null,
    createdAt: safeUser.createdAt || null,
  };
};

const listCoachAdminAccessUsers = async (event) => {
  try {
    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "admin",
    });
    if (!operator || !operator._id || normalizeRole(operator.role) !== "admin") {
      return { success: false, message: "permission_denied", users: [] };
    }

    const operatorId = String(operator._id || "").trim();
    const managedCoachIds = await queryManagedCoachIdsByAdmin(operator);
    const list = await queryUsersByIds(mergeUniqueIdList(operatorId, managedCoachIds));

    const users = list
      .map((item) => formatPermissionManageUser(item))
      .filter((item) => !!item.id)
      .sort((a, b) => {
        if (a.role === "admin" && b.role !== "admin") {
          return -1;
        }
        if (a.role !== "admin" && b.role === "admin") {
          return 1;
        }
        const aTime = normalizeDateLike(a.updatedAt);
        const bTime = normalizeDateLike(b.updatedAt);
        const aTs = aTime ? aTime.getTime() : 0;
        const bTs = bTime ? bTime.getTime() : 0;
        if (aTs !== bTs) {
          return bTs - aTs;
        }
        return String(a.name || "").localeCompare(String(b.name || ""));
      });

    return {
      success: true,
      users,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coach_admin_access_users_failed",
      users: [],
      errMsg: e,
    };
  }
};

const setCoachAdminAccess = async (event) => {
  try {
    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "admin",
    });
    if (!operator || !operator._id || normalizeRole(operator.role) !== "admin") {
      return { success: false, message: "permission_denied" };
    }
    const operatorId = String(operator._id || "").trim();

    const targetUserId = String(event && event.targetUserId ? event.targetUserId : "").trim();
    if (!targetUserId) {
      return { success: false, message: "target_user_id_required" };
    }
    const nextAdminAccess = !!(event && event.adminAccess);

    const targetRes = await db.collection(USER_COLLECTION).doc(targetUserId).get().catch(() => null);
    const targetUser = targetRes && targetRes.data ? targetRes.data : null;
    if (!targetUser || !targetUser._id) {
      return { success: false, message: "target_user_not_found" };
    }

    const targetRole = normalizeRole(targetUser.role);
    if (targetRole !== "coach" && targetRole !== "admin") {
      return { success: false, message: "target_user_not_coach" };
    }
    if (targetRole === "admin") {
      if (targetUserId !== operatorId) {
        return { success: false, message: "permission_denied" };
      }
      if (!nextAdminAccess) {
        return { success: false, message: "cannot_disable_builtin_admin" };
      }
      return {
        success: true,
        user: formatPermissionManageUser(targetUser),
      };
    }

    const targetOwnerIds = extractUserAdminOwnerIds(targetUser, null);
    const targetManaged = targetOwnerIds.includes(operatorId);
    if (targetOwnerIds.length && !targetManaged) {
      return { success: false, message: "permission_denied" };
    }
    const nextOwnerIds = mergeUniqueIdList(targetOwnerIds, operatorId);

    await db.collection(USER_COLLECTION).doc(targetUserId).update({
      data: {
        adminAccess: nextAdminAccess,
        ...buildAdminOwnerPatch(nextOwnerIds),
        updatedAt: db.serverDate(),
      },
    });

    const latestRes = await db.collection(USER_COLLECTION).doc(targetUserId).get().catch(() => null);
    const latest = latestRes && latestRes.data ? latestRes.data : {
      ...targetUser,
      adminAccess: nextAdminAccess,
    };

    return {
      success: true,
      user: formatPermissionManageUser(latest),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "set_coach_admin_access_failed",
      errMsg: e,
    };
  }
};

const normalizeCoachLevelValue = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }
  const asNum = Number(raw);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 4) {
    return asNum;
  }
  const aliasMap = {
    "助理教练": 1,
    "初级教练员": 2,
    "中级教练员": 3,
    "高级教练员": 4,
    assistant: 1,
    junior: 2,
    intermediate: 3,
    middle: 3,
    senior: 4,
  };
  return Number(aliasMap[raw] || aliasMap[raw.toLowerCase()] || 0);
};

const isSeniorCoachUser = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  if (normalizeRole(safeUser.role) !== "coach") {
    return false;
  }
  return normalizeCoachLevelValue(safeUser.level) >= 4;
};

const buildRoleSetDefaultName = (phone) => {
  const tail = String(phone || "").slice(-4);
  return `User${tail || "0000"}`;
};

const buildDefaultWechatUserName = (openid) => {
  const tail = String(openid || "").slice(-6);
  return `WeChatUser${tail || "000000"}`;
};

const buildUserIntegrityPatch = (user, fallbackOpenid) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const patch = {};
  const role = normalizeRole(safeUser.role);
  const roleRaw = String(safeUser.role || "").trim().toLowerCase();

  if (!roleRaw || roleRaw !== role) {
    patch.role = role;
  }
  if (!String(safeUser.status || "").trim()) {
    patch.status = "active";
  }

  const levelCode = normalizeCoachLevelValue(safeUser.level);
  if (role === "coach") {
    if (!levelCode) {
      patch.level = 1;
    }
  } else if (typeof safeUser.level === "undefined" || safeUser.level === null || safeUser.level === "") {
    patch.level = 0;
  }

  if (typeof safeUser.adminAccess === "undefined") {
    patch.adminAccess = false;
  }
  if (typeof safeUser[ADMIN_OWNER_ID_FIELD] === "undefined" && typeof safeUser.adminOwnerID === "undefined") {
    patch[ADMIN_OWNER_ID_FIELD] = "";
  }
  if (!Array.isArray(safeUser[ADMIN_OWNER_IDS_FIELD]) && !Array.isArray(safeUser.adminOwnerIDs)) {
    patch[ADMIN_OWNER_IDS_FIELD] = [];
  }
  if (typeof safeUser.coachId === "undefined" && typeof safeUser.coachid === "undefined") {
    patch.coachId = "";
  }
  if (!Array.isArray(safeUser.coachIds) && !Array.isArray(safeUser.coachids)) {
    patch.coachIds = [];
  }

  const phone = normalizePhone(safeUser.phone || "");
  const openid = String(safeUser.openid || safeUser._openid || fallbackOpenid || "").trim();
  const fallbackName = phone
    ? buildRoleSetDefaultName(phone)
    : buildDefaultWechatUserName(openid);
  const safeName = String(safeUser.name || safeUser.nickName || "").trim();
  const safeNickName = String(safeUser.nickName || "").trim();

  if (!safeName) {
    patch.name = fallbackName;
  }
  if (!safeNickName) {
    patch.nickName = safeName || patch.name || fallbackName;
  }
  if (!String(safeUser.openid || safeUser._openid || "").trim() && openid) {
    patch.openid = openid;
  }
  if (typeof safeUser.avatarUrl === "undefined") {
    patch.avatarUrl = "";
  }
  if (typeof safeUser.joinDate === "undefined") {
    patch.joinDate = "";
  }
  if (typeof safeUser.studentSince === "undefined") {
    patch.studentSince = "";
  }
  if (typeof safeUser.roleUpdatedAt === "undefined") {
    patch.roleUpdatedAt = "";
  }

  return patch;
};

const ensureUserIntegrity = async (user, fallbackOpenid) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const userId = String(safeUser._id || "").trim();
  if (!userId) {
    return safeUser;
  }
  const patch = buildUserIntegrityPatch(safeUser, fallbackOpenid);
  if (!Object.keys(patch).length) {
    return safeUser;
  }
  await db.collection(USER_COLLECTION).doc(userId).update({
    data: {
      ...patch,
      updatedAt: db.serverDate(),
    },
  }).catch(() => null);
  return {
    ...safeUser,
    ...patch,
  };
};

const backfillMyUserFields = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event || {});
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const beforePatch = buildUserIntegrityPatch(user, openid);
    const beforeMissing = Object.keys(beforePatch);
    const nextUser = await ensureUserIntegrity(user, openid);
    const afterPatch = buildUserIntegrityPatch(nextUser, openid);
    return {
      success: true,
      userId: String(nextUser._id || "").trim(),
      beforeMissingFields: beforeMissing,
      patched: beforeMissing.length > 0,
      remainingMissingFields: Object.keys(afterPatch),
      user: formatPermissionManageUser(nextUser),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "backfill_my_user_fields_failed",
      errMsg: e,
    };
  }
};

const adminSetUserRoleByPhone = async (event) => {
  try {
    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const operatorRole = normalizeRole(operator.role);
    const operatorIsBuiltinAdmin = operatorRole === "admin";
    const operatorIsCoach = operatorRole === "coach" || hasCoachRole(operator);
    const operatorId = String(operator._id || "").trim();
    const operatorAdminOwnerIds = extractUserAdminOwnerIds(operator, null);
    if (!operatorIsCoach && !operatorIsBuiltinAdmin) {
      return { success: false, message: "permission_denied" };
    }

    const phone = normalizePhone(event && event.phone);
    const targetRole = normalizeRole(event && event.role);
    const rawPassword = normalizePassword(event && event.password);
    const hasPasswordInput = !!rawPassword;
    const password = hasPasswordInput ? rawPassword : DEFAULT_LOGIN_PASSWORD;
    if (!isValidPhone(phone)) {
      return { success: false, message: "invalid_phone" };
    }
    if (targetRole !== "student" && targetRole !== "coach") {
      return { success: false, message: "role_not_supported" };
    }
    if (hasPasswordInput && !isValidPassword(password)) {
      return { success: false, message: "password_too_short" };
    }

    const operatorIsSeniorCoach = operatorIsCoach && normalizeCoachLevelValue(operator.level) >= 4;
    if (targetRole === "coach" && !operatorIsBuiltinAdmin && !operatorIsSeniorCoach) {
      return { success: false, message: "permission_denied" };
    }

    const coachLevel = targetRole === "coach"
      ? normalizeCoachLevelValue(event && (event.level || event.coachLevel))
      : 0;
    if (targetRole === "coach" && !coachLevel) {
      return { success: false, message: "coach_level_required" };
    }

    const queryRes = await db.collection(USER_COLLECTION).where({ phone }).limit(20).get().catch(() => ({ data: [] }));
    const list = Array.isArray(queryRes && queryRes.data) ? queryRes.data : [];
    const existedUser = list.find((item) => !!(item && item._id)) || null;
    const existedRole = normalizeRole(existedUser && existedUser.role);
    const existedOwnerIds = extractUserAdminOwnerIds(existedUser, null);
    if (existedUser && existedRole === "admin") {
      return { success: false, message: "cannot_update_builtin_admin" };
    }
    if (
      operatorIsBuiltinAdmin
      && existedUser
      && existedUser._id
      && existedOwnerIds.length
      && !existedOwnerIds.includes(operatorId)
    ) {
      return { success: false, message: "permission_denied" };
    }
    if (operatorIsBuiltinAdmin && existedUser && existedUser._id && (existedRole === "student" || existedRole === "user")) {
      const existedCoachIds = extractUserCoachIds(existedUser, null);
      if (existedCoachIds.length) {
        const managedCoachIds = await filterCoachIdsByAdminScope(operator, existedCoachIds);
        if (!managedCoachIds.length) {
          return { success: false, message: "permission_denied" };
        }
      }
    }

    const nowPatch = {
      role: targetRole,
      status: (existedUser && existedUser.status) || "active",
      roleUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };
    const existedPasswordHash = String(existedUser && existedUser.passwordHash ? existedUser.passwordHash : "").trim();
    const shouldResetPassword = hasPasswordInput || !existedPasswordHash;
    if (shouldResetPassword) {
      nowPatch.passwordHash = hashPassword(password);
      nowPatch.passwordUpdatedAt = db.serverDate();
    }

    const operatorScopedOwnerIds = mergeUniqueIdList(
      operatorIsBuiltinAdmin ? operatorId : "",
      operatorAdminOwnerIds
    );
    const nextBaseOwnerIds = operatorScopedOwnerIds.length
      ? operatorScopedOwnerIds
      : mergeUniqueIdList(existedOwnerIds);

    if (targetRole === "coach") {
      nowPatch.level = coachLevel;
      nowPatch.coachId = "";
      nowPatch.coachIds = [];
      Object.assign(nowPatch, buildAdminOwnerPatch(nextBaseOwnerIds));
    } else {
      const operatorCoachId = operatorId;
      const existedCoachId = String(existedUser && existedUser.coachId ? existedUser.coachId : "").trim();
      const existedCoachIds = mergeUniqueIdList(
        normalizeIdList(existedUser && existedUser.coachIds),
        existedCoachId
      );
      let scopedCoachIds = [];
      if (operatorIsCoach) {
        const peerCoachIds = await queryPeerCoachIdsByCoach(operator).catch(() => []);
        scopedCoachIds = mergeUniqueIdList(operatorCoachId, peerCoachIds);
      } else if (operatorIsBuiltinAdmin) {
        const managedCoachIds = await queryManagedCoachIdsByAdmin(operator).catch(() => []);
        scopedCoachIds = mergeUniqueIdList(managedCoachIds);
      }
      const scopedCoachSet = new Set(scopedCoachIds);
      const retainedExistedCoachIds = existedCoachIds.filter((id) => scopedCoachSet.has(String(id || "").trim()));
      const nextStudentCoachIds = mergeUniqueIdList(retainedExistedCoachIds, scopedCoachIds);
      nowPatch.level = "";
      nowPatch.adminAccess = false;
      const preferredCoachId = (existedCoachId && nextStudentCoachIds.includes(existedCoachId))
        ? existedCoachId
        : "";
      nowPatch.coachId = preferredCoachId || (nextStudentCoachIds[0] || (operatorIsCoach ? operatorCoachId : ""));
      nowPatch.coachIds = nextStudentCoachIds;
      const wasStudentRole = existedRole === "student" || existedRole === "user";
      const operatorAddingNewCoachBinding = operatorIsCoach
        && !!operatorCoachId
        && !existedCoachIds.includes(operatorCoachId);
      if (!existedUser || !existedUser.studentSince || !wasStudentRole || operatorAddingNewCoachBinding) {
        nowPatch.studentSince = db.serverDate();
      }
      Object.assign(nowPatch, buildAdminOwnerPatch(nextBaseOwnerIds));
    }

    let userId = "";
    let created = false;
    if (existedUser && existedUser._id) {
      userId = String(existedUser._id || "").trim();
      await db.collection(USER_COLLECTION).doc(userId).update({ data: nowPatch });
    } else {
      const defaultName = buildRoleSetDefaultName(phone);
      const addRes = await db.collection(USER_COLLECTION).add({
        data: {
          name: defaultName,
          nickName: defaultName,
          phone,
          openid: "",
          avatarUrl: "",
          adminAccess: false,
          joinDate: "",
          studentSince: "",
          ...nowPatch,
          createdAt: db.serverDate(),
        },
      });
      userId = String(addRes && addRes._id ? addRes._id : "").trim();
      created = true;
    }

    if (!userId) {
      return { success: false, message: "role_update_failed" };
    }

    const latestRes = await db.collection(USER_COLLECTION).doc(userId).get().catch(() => null);
    const latest = latestRes && latestRes.data ? latestRes.data : {
      ...(existedUser || {}),
      _id: userId,
      phone,
      ...nowPatch,
    };

    let studentCoachBackfill = { success: true, patchedCount: 0 };
    if (targetRole === "coach") {
      const coachOwnerIds = mergeUniqueIdList(
        extractUserAdminOwnerIds(latest, null),
        nextBaseOwnerIds,
        operatorId
      );
      studentCoachBackfill = await backfillStudentsCoachIdsByAdminOwners(userId, coachOwnerIds).catch(() => ({
        success: false,
        patchedCount: 0,
      }));
    }

    return {
      success: true,
      created,
      passwordInitialized: shouldResetPassword,
      studentCoachBackfill,
      user: formatPermissionManageUser(latest),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "admin_set_user_role_by_phone_failed",
      errMsg: e,
    };
  }
};

const normalizeDateText = (value) => {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
};

const normalizeTimeText = (value) => {
  const text = String(value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(text)) {
    return "";
  }
  const [h, m] = text.split(":").map((item) => Number(item));
  if (!Number.isInteger(h) || !Number.isInteger(m)) {
    return "";
  }
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return "";
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const toScheduleMinutes = (timeText) => {
  const normalized = normalizeTimeText(timeText);
  if (!normalized) {
    return -1;
  }
  const [h, m] = normalized.split(":").map((item) => Number(item));
  return h * 60 + m;
};

const isScheduleSlotExpired = (dateText, endTimeText, now) => {
  const dateObj = toScheduleDateObject(dateText);
  const endMinutes = toScheduleMinutes(endTimeText);
  if (!dateObj || endMinutes < 0) {
    return false;
  }
  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;
  const endDateTime = new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    endHour,
    endMinute,
    59,
    999
  );
  const nowDate = now instanceof Date ? now : new Date();
  return nowDate.getTime() > endDateTime.getTime();
};

const isScheduleTimeConflict = (startA, endA, startB, endB) => {
  const aStart = toScheduleMinutes(startA);
  const aEnd = toScheduleMinutes(endA);
  const bStart = toScheduleMinutes(startB);
  const bEnd = toScheduleMinutes(endB);
  if (aStart < 0 || aEnd < 0 || bStart < 0 || bEnd < 0) {
    return false;
  }
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
};

const clampScheduleMaxStudents = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 3;
  }
  return Math.max(1, Math.min(3, Math.floor(num)));
};

const normalizeScheduleStudentUnlimited = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
};

const normalizeScheduleBookerRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  if (role === "coach" || role === "admin") {
    return "coach";
  }
  return "student";
};

const resolveEffectiveScheduleBookerRole = (booking) => {
  const safe = booking && typeof booking === "object" ? booking : {};
  if (typeof safe.bookerIsCoach === "boolean") {
    return safe.bookerIsCoach ? "coach" : "student";
  }
  const roleByFlag = String(safe.bookerIsCoach || "").trim().toLowerCase();
  if (roleByFlag === "1" || roleByFlag === "true" || roleByFlag === "yes" || roleByFlag === "on") {
    return "coach";
  }
  if (roleByFlag === "0" || roleByFlag === "false" || roleByFlag === "no" || roleByFlag === "off") {
    return "student";
  }
  const actorRole = normalizeRole(safe.bookerUserRole || safe.studentRole || safe.role);
  if (actorRole === "coach" || actorRole === "admin") {
    return "coach";
  }
  const declaredRole = normalizeScheduleBookerRole(safe.bookerRole);
  return declaredRole === "coach" ? "coach" : "student";
};

const getTodayDateText = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toScheduleDateObject = (dateText) => {
  const normalized = normalizeDateText(dateText);
  if (!normalized) {
    return null;
  }
  const [year, month, day] = normalized.split("-").map((item) => Number(item));
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatScheduleDateObject = (dateObj) => {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    return "";
  }
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getScheduleWeekStartDate = (dateObj) => {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    return null;
  }
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const day = base.getDay(); // 0=Sunday, 1=Monday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  base.setDate(base.getDate() + diffToMonday);
  return base;
};

const sortScheduleListByDateTime = (list, dateKey, startTimeKey) =>
  (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const dateA = String((a && a[dateKey]) || "");
    const dateB = String((b && b[dateKey]) || "");
    if (dateA !== dateB) {
      return dateA.localeCompare(dateB);
    }
    const startA = toScheduleMinutes(a && a[startTimeKey]);
    const startB = toScheduleMinutes(b && b[startTimeKey]);
    return startA - startB;
  });

const buildScheduleSlotFingerprint = (slot, includeStatus) => {
  const safe = slot && typeof slot === "object" ? slot : {};
  const coachKey = String(safe.coachOwnerId || safe.coachId || "").trim();
  const date = String(safe.date || "").trim();
  const startTime = String(safe.startTime || "").trim();
  const endTime = String(safe.endTime || "").trim();
  const status = includeStatus ? String(safe.status || "open").trim().toLowerCase() : "";
  if (!coachKey || !date || !startTime || !endTime) {
    return "";
  }
  return [coachKey, date, startTime, endTime, status].join("|");
};

const dedupScheduleSlotsByFingerprint = (slots, options) => {
  const list = Array.isArray(slots) ? slots : [];
  const safeOptions = options && typeof options === "object" ? options : {};
  const includeStatus = safeOptions.includeStatus !== false;
  const map = {};

  list.forEach((item) => {
    const safe = item && typeof item === "object" ? item : {};
    const key = buildScheduleSlotFingerprint(safe, includeStatus);
    if (!key) {
      return;
    }
    const id = String(safe._id || safe.id || "").trim();
    const ts = getDateTimestamp(safe.updatedAt || safe.createdAt);
    const prev = map[key];
    if (!prev || ts > prev.ts || (ts === prev.ts && id > prev.id)) {
      map[key] = { item: safe, id, ts };
    }
  });

  return Object.keys(map).map((key) => map[key].item);
};

const buildGenericIdentityFilter = (userIdField, openIdField, userId, openid) => {
  const _ = db.command;
  const conditionList = [];
  const safeUserId = String(userId || "").trim();
  const safeOpenid = String(openid || "").trim();
  if (safeUserId) {
    conditionList.push({ [userIdField]: safeUserId });
  }
  if (safeOpenid) {
    conditionList.push({ [openIdField]: safeOpenid });
  }
  if (!conditionList.length) {
    return null;
  }
  if (conditionList.length === 1) {
    return conditionList[0];
  }
  return _.or(conditionList);
};

const buildScheduleBookerIdentityFilter = (studentId, studentOpenId) => {
  const safeStudentId = String(studentId || "").trim();
  const safeStudentOpenId = String(studentOpenId || "").trim();
  if (safeStudentId) {
    // Prefer stable user id to avoid cross-account collisions under same openid.
    return { studentId: safeStudentId };
  }
  if (safeStudentOpenId) {
    return { studentOpenId: safeStudentOpenId };
  }
  return null;
};

const isSameScheduleBooker = (bookingStudentId, bookingStudentOpenId, currentUserId, currentOpenId) => {
  const sourceId = String(bookingStudentId || "").trim();
  const targetId = String(currentUserId || "").trim();
  if (sourceId && targetId) {
    return sourceId === targetId;
  }
  const sourceOpenId = String(bookingStudentOpenId || "").trim();
  const targetOpenId = String(currentOpenId || "").trim();
  if (sourceOpenId && targetOpenId) {
    return sourceOpenId === targetOpenId;
  }
  return false;
};

const mapScheduleSlot = (slot, bookedCount, isBookedByMe) => {
  const safe = slot && typeof slot === "object" ? slot : {};
  const maxStudents = clampScheduleMaxStudents(safe.maxStudents);
  const studentUnlimited = normalizeScheduleStudentUnlimited(safe.studentUnlimited);
  const booked = Math.max(0, resolveNumber(bookedCount));
  const hasLimit = maxStudents > 0;
  const isFull = hasLimit && booked >= maxStudents;
  const rawStatus = String(safe.status || "open").trim() || "open";
  const normalizedStatus = rawStatus.toLowerCase();
  const expired = isScheduleSlotExpired(safe.date, safe.endTime);
  const effectiveStatus = normalizedStatus === "open" && expired ? "closed" : normalizedStatus;
  return {
    id: safe._id || "",
    coachId: String(safe.coachId || "").trim(),
    coachOwnerId: String(safe.coachOwnerId || "").trim(),
    coachName: String(safe.coachName || "").trim() || "\u6559\u7ec3",
    title: String(safe.title || "").trim() || SCHEDULE_DEFAULT_TITLE,
    date: String(safe.date || "").trim(),
    startTime: String(safe.startTime || "").trim(),
    endTime: String(safe.endTime || "").trim(),
    notes: String(safe.notes || "").trim(),
    status: effectiveStatus,
    maxStudents,
    studentUnlimited,
    bookedCount: booked,
    remainingCount: hasLimit ? Math.max(0, maxStudents - booked) : 0,
    isFull,
    isBookedByMe: !!isBookedByMe,
    canBook: effectiveStatus === "open" && !isBookedByMe && !isFull,
    expired,
    createdAt: safe.createdAt || null,
    updatedAt: safe.updatedAt || null,
  };
};

const dedupeStudentVisibleSlotsByTimeslot = (slots, preferredCoachIds) => {
  const list = Array.isArray(slots) ? slots : [];
  if (!list.length) {
    return [];
  }
  const preferredSet = new Set(mergeUniqueIdList(preferredCoachIds));
  const resolveCoachKey = (item) => mergeUniqueIdList(
    String(item && item.coachId ? item.coachId : "").trim(),
    String(item && item.coachOwnerId ? item.coachOwnerId : "").trim()
  );
  const isPreferredCoachSlot = (item) => {
    const keys = resolveCoachKey(item);
    return keys.some((key) => preferredSet.has(String(key || "").trim()));
  };
  const pickBetter = (left, right) => {
    const a = left && typeof left === "object" ? left : {};
    const b = right && typeof right === "object" ? right : {};
    if (!!a.isBookedByMe !== !!b.isBookedByMe) {
      return a.isBookedByMe ? a : b;
    }
    const aPreferred = isPreferredCoachSlot(a);
    const bPreferred = isPreferredCoachSlot(b);
    if (aPreferred !== bPreferred) {
      return aPreferred ? a : b;
    }
    const aTs = getDateTimestamp(a.updatedAt || a.createdAt);
    const bTs = getDateTimestamp(b.updatedAt || b.createdAt);
    if (aTs !== bTs) {
      return aTs > bTs ? a : b;
    }
    const aId = String(a.id || "").trim();
    const bId = String(b.id || "").trim();
    return aId.localeCompare(bId) <= 0 ? a : b;
  };

  const dedupMap = {};
  list.forEach((item) => {
    const safe = item && typeof item === "object" ? item : {};
    const key = [
      String(safe.date || "").trim(),
      String(safe.startTime || "").trim(),
      String(safe.endTime || "").trim(),
    ].join("|");
    if (!key || key === "||") {
      return;
    }
    if (!dedupMap[key]) {
      dedupMap[key] = safe;
      return;
    }
    dedupMap[key] = pickBetter(dedupMap[key], safe);
  });

  return sortScheduleListByDateTime(
    Object.keys(dedupMap).map((key) => dedupMap[key]),
    "date",
    "startTime"
  );
};

const mapScheduleBooking = (booking) => {
  const safe = booking && typeof booking === "object" ? booking : {};
  return {
    id: safe._id || "",
    slotId: String(safe.slotId || "").trim(),
    coachId: String(safe.coachId || "").trim(),
    coachOwnerId: String(safe.coachOwnerId || "").trim(),
    coachName: String(safe.coachName || "").trim() || "\u6559\u7ec3",
    studentId: String(safe.studentId || "").trim(),
    studentName: String(safe.studentName || "").trim() || "\u5b66\u5458",
    bookerRole: resolveEffectiveScheduleBookerRole(safe),
    title: String(safe.title || "").trim() || SCHEDULE_DEFAULT_TITLE,
    date: String(safe.date || "").trim(),
    startTime: String(safe.startTime || "").trim(),
    endTime: String(safe.endTime || "").trim(),
    status: String(safe.status || "active").trim() || "active",
    cancelReason: String(safe.cancelReason || "").trim(),
    createdAt: safe.createdAt || null,
    updatedAt: safe.updatedAt || null,
    cancelledAt: safe.cancelledAt || null,
  };
};

const getActiveBookingStatsBySlotIds = async (slotIds) => {
  const validIds = Array.isArray(slotIds)
    ? slotIds.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!validIds.length) {
    return { countBySlotId: {}, activeBookings: [] };
  }
  const _ = db.command;
  const res = await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
    slotId: _.in(validIds),
    status: "active",
  }).limit(500).get().catch(() => ({ data: [] }));
  const list = res && res.data ? res.data : [];
  const countBySlotId = {};
  list.forEach((item) => {
    const slotId = String(item && item.slotId ? item.slotId : "").trim();
    if (!slotId) {
      return;
    }
    countBySlotId[slotId] = resolveNumber(countBySlotId[slotId]) + 1;
  });
  return {
    countBySlotId,
    activeBookings: list,
  };
};

const queryScheduleCollectionByPages = async (collectionName, where, sortFields, orderAsc) => {
  const safeWhere = where && typeof where === "object" ? where : {};
  const safeCollection = String(collectionName || "").trim();
  if (!safeCollection) {
    return [];
  }

  const pageSize = Math.max(1, Math.min(SCHEDULE_FETCH_BATCH_SIZE, 100));
  const maxCount = Math.max(pageSize, SCHEDULE_FETCH_LIMIT);
  const sortDirection = orderAsc ? "asc" : "desc";

  const fetchPagedList = async (withSort) => {
    const all = [];
    let skip = 0;
    while (all.length < maxCount) {
      let query = db.collection(safeCollection).where(safeWhere).skip(skip).limit(
        Math.min(pageSize, maxCount - all.length)
      );
      if (withSort && Array.isArray(sortFields)) {
        sortFields.forEach((field) => {
          if (field) {
            query = query.orderBy(field, sortDirection);
          }
        });
      }

      const res = await query.get().catch(() => null);
      if (!res) {
        return null;
      }
      const data = Array.isArray(res.data) ? res.data : [];
      all.push(...data);
      if (data.length < pageSize) {
        break;
      }
      skip += pageSize;
      if (skip >= maxCount) {
        break;
      }
    }
    return all.slice(0, maxCount);
  };

  const orderedList = await fetchPagedList(true);
  if (orderedList) {
    return orderedList;
  }
  const plainList = await fetchPagedList(false);
  return plainList || [];
};

const queryScheduleSlots = async (where, orderAsc) => {
  const list = await queryScheduleCollectionByPages(
    SCHEDULE_SLOT_COLLECTION,
    where,
    ["date", "startTime"],
    orderAsc
  );
  const sorted = sortScheduleListByDateTime(list, "date", "startTime");
  return orderAsc ? sorted : sorted.reverse();
};

const queryRecentScheduleSlots = async (where, orderAsc, limitInput) => {
  const safeWhere = where && typeof where === "object" ? where : {};
  const limit = Math.max(1, Math.min(Number(limitInput || 8), 30));
  const direction = orderAsc ? "asc" : "desc";
  let query = db.collection(SCHEDULE_SLOT_COLLECTION)
    .where(safeWhere)
    .orderBy("date", direction)
    .orderBy("startTime", direction)
    .limit(limit);
  const res = await query.get().catch(() => null);
  const list = res && Array.isArray(res.data) ? res.data : [];
  const sorted = sortScheduleListByDateTime(list, "date", "startTime");
  return orderAsc ? sorted : sorted.reverse();
};

const queryScheduleBookings = async (where, orderAsc) => {
  const list = await queryScheduleCollectionByPages(
    SCHEDULE_BOOKING_COLLECTION,
    where,
    ["date", "startTime"],
    orderAsc
  );
  const sorted = sortScheduleListByDateTime(list, "date", "startTime");
  return orderAsc ? sorted : sorted.reverse();
};

const splitIdList = (value, chunkSize) => {
  const safeSize = Number.isFinite(Number(chunkSize)) ? Math.max(1, Math.floor(Number(chunkSize))) : 20;
  const list = mergeUniqueIdList(value);
  const chunks = [];
  for (let i = 0; i < list.length; i += safeSize) {
    chunks.push(list.slice(i, i + safeSize));
  }
  return chunks;
};

const queryActiveScheduleBookingsByCoachIds = async (coachIds) => {
  const idChunks = splitIdList(coachIds, 20);
  if (!idChunks.length) {
    return [];
  }
  const _ = db.command;
  const taskList = idChunks.map((chunk) => {
    const coachWhere = chunk.length === 1
      ? _.or([{ coachId: chunk[0] }, { coachOwnerId: chunk[0] }])
      : _.or([{ coachId: _.in(chunk) }, { coachOwnerId: _.in(chunk) }]);
    const where = _.and([coachWhere, { status: "active" }]);
    return queryScheduleBookings(where, false).catch(() => []);
  });
  const resultList = await Promise.all(taskList);
  const dedupMap = {};
  const merged = [];
  resultList.forEach((group) => {
    (Array.isArray(group) ? group : []).forEach((item) => {
      const key = String(item && item._id ? item._id : "").trim();
      if (key && dedupMap[key]) {
        return;
      }
      if (key) {
        dedupMap[key] = true;
      }
      merged.push(item);
    });
  });
  return merged;
};

const countCompletedLessonsByStudentIds = async (studentIds, coachIds) => {
  const idList = mergeUniqueIdList(studentIds);
  if (!idList.length) {
    return {};
  }
  const studentIdSet = new Set(idList);
  const bookingList = await queryActiveScheduleBookingsByCoachIds(coachIds);
  const nowDate = new Date();
  const countMap = {};
  bookingList.forEach((item) => {
    const studentId = String(item && item.studentId ? item.studentId : "").trim();
    if (!studentId || !studentIdSet.has(studentId)) {
      return;
    }
    const date = String(item && item.date ? item.date : "").trim();
    const endTime = String(
      (item && (item.endTime || item.startTime)) ? (item.endTime || item.startTime) : ""
    ).trim();
    if (!isScheduleSlotExpired(date, endTime, nowDate)) {
      return;
    }
    countMap[studentId] = Number(countMap[studentId] || 0) + 1;
  });
  return countMap;
};

const resolveFlowerEligibilityByStudent = (studentDoc, completedLessonCount) => {
  const safeStudent = studentDoc && typeof studentDoc === "object" ? studentDoc : {};
  const safeCompletedLessonCount = Math.max(0, Number(completedLessonCount || 0));
  const lessonPackage = mapStudentLessonPackage(safeStudent);
  const hasLessonPackage = !!lessonPackage.enabled && lessonPackage.totalLessons > 0;
  if (!hasLessonPackage) {
    return {
      canReceiveFlower: false,
      reason: "lesson_package_not_configured",
    };
  }
  if (safeCompletedLessonCount <= 0) {
    return {
      canReceiveFlower: false,
      reason: "no_completed_lesson",
    };
  }
  return {
    canReceiveFlower: true,
    reason: "ok",
  };
};

const queryBookedStudentsByCoachIds = async (coachIds) => {
  const ids = mergeUniqueIdList(coachIds);
  if (!ids.length) {
    return [];
  }
  const _ = db.command;
  const coachFilter = ids.length === 1
    ? _.or([{ coachId: ids[0] }, { coachOwnerId: ids[0] }])
    : _.or([{ coachId: _.in(ids) }, { coachOwnerId: _.in(ids) }]);
  const res = await db.collection(SCHEDULE_BOOKING_COLLECTION)
    .where(coachFilter)
    .limit(1000)
    .get()
    .catch(() => ({ data: [] }));
  const bookingList = Array.isArray(res && res.data) ? res.data : [];
  if (!bookingList.length) {
    return [];
  }
  const identityKeys = mergeUniqueIdList(
    bookingList.map((item) => String(item && item.studentId ? item.studentId : "").trim()),
    bookingList.map((item) => String(item && item.studentOpenId ? item.studentOpenId : "").trim()),
    bookingList.map((item) => normalizePhone(item && item.studentPhone ? item.studentPhone : ""))
  );
  if (!identityKeys.length) {
    return [];
  }
  const users = await queryUsersByIdentityKeys(identityKeys).catch(() => []);
  return users.filter((item) => {
    const role = normalizeRole(item && item.role);
    return role !== "coach" && role !== "admin";
  });
};

const expandStudentNotificationReceivers = async (students) => {
  const baseList = Array.isArray(students) ? students : [];
  const seedKeys = mergeUniqueIdList(
    baseList.map((item) => String(item && (item._id || item.id) ? (item._id || item.id) : "").trim()),
    baseList.map((item) => String(item && (item.openid || item._openid) ? (item.openid || item._openid) : "").trim()),
    baseList.map((item) => normalizePhone(item && item.phone ? item.phone : "")),
    baseList.reduce((acc, item) => acc.concat(extractUserCoachIds(item, null)), []),
    baseList.reduce((acc, item) => acc.concat(extractUserAdminOwnerIds(item, null)), [])
  );
  const identityExpanded = seedKeys.length
    ? await queryUsersByIdentityKeys(seedKeys).catch(() => [])
    : [];
  const merged = [].concat(baseList, identityExpanded || []);
  const map = {};
  merged.forEach((item) => {
    const role = normalizeRole(item && item.role);
    if (role === "coach" || role === "admin") {
      return;
    }
    const receiverUserId = String(item && (item._id || item.id) ? (item._id || item.id) : "").trim();
    const receiverOpenId = String(item && (item.openid || item._openid) ? (item.openid || item._openid) : "").trim();
    if (!receiverUserId && !receiverOpenId) {
      return;
    }
    const key = receiverUserId ? `id:${receiverUserId}` : `openid:${receiverOpenId}`;
    if (map[key]) {
      return;
    }
    map[key] = {
      receiverUserId,
      receiverOpenId,
    };
  });
  return Object.keys(map).map((key) => map[key]);
};

const resolveStudentReceiversForSchedulePublish = async (payload) => {
  const safe = payload && typeof payload === "object" ? payload : {};
  const publisher = safe.publisher && typeof safe.publisher === "object" ? safe.publisher : {};
  const coachId = String(safe.coachId || "").trim();
  const publisherRole = normalizeRole(publisher.role);
  const hasIdIntersection = (left, right) => {
    const leftSet = new Set(mergeUniqueIdList(left));
    if (!leftSet.size) {
      return false;
    }
    return mergeUniqueIdList(right).some((id) => leftSet.has(String(id || "").trim()));
  };
  let ownerIds = mergeUniqueIdList(
    extractUserAdminOwnerIds(publisher, null),
    extractUserAdminOwnerIds(safe, null)
  );
  if (!ownerIds.length && coachId) {
    const coachRes = await db.collection(USER_COLLECTION).doc(coachId).get().catch(() => null);
    const coachUser = coachRes && coachRes.data ? coachRes.data : null;
    ownerIds = mergeUniqueIdList(ownerIds, extractUserAdminOwnerIds(coachUser, null));
    if (normalizeRole(coachUser && coachUser.role) === "admin") {
      ownerIds = mergeUniqueIdList(ownerIds, String(coachUser && coachUser._id ? coachUser._id : "").trim());
    }
  }
  if (publisherRole === "admin") {
    ownerIds = mergeUniqueIdList(ownerIds, String(publisher._id || "").trim());
  }

  let students = [];
  let peerCoachIds = [];
  if (ownerIds.length) {
    const peerCoaches = await queryCoachUsersByAdminOwnerIds(ownerIds).catch(() => []);
    peerCoachIds = peerCoaches
      .map((item) => String(item && item._id ? item._id : "").trim())
      .filter(Boolean);
    const [ownerStudents, coachStudents] = await Promise.all([
      queryStudentsByAdminOwnerIds(ownerIds).catch(() => []),
      peerCoachIds.length ? queryStudentsByCoachIds(peerCoachIds).catch(() => []) : Promise.resolve([]),
    ]);
    students = [].concat(ownerStudents || [], coachStudents || []);
  }
  if (coachId) {
    const directStudents = await queryStudentsByCoachIds([coachId]).catch(() => []);
    students = [].concat(students || [], directStudents || []);
  }
  const coachScopeIds = mergeUniqueIdList(coachId, peerCoachIds);
  const ownerScopeIds = mergeUniqueIdList(ownerIds);

  // Schema-safe fallback: when direct where queries miss due historical field drift,
  // scan current users and match by normalized coach/admin-owner bindings.
  const fallbackStudentUsers = await db.collection(USER_COLLECTION)
    .limit(2000)
    .get()
    .then((res) => (Array.isArray(res && res.data) ? res.data : []))
    .catch(() => []);
  const repairedStudents = fallbackStudentUsers.filter((item) => {
    const role = normalizeRole(item && item.role);
    if (role === "coach" || role === "admin") {
      return false;
    }
    const itemCoachIds = extractUserCoachIds(item, null);
    const itemOwnerIds = extractUserAdminOwnerIds(item, null);
    return hasIdIntersection(itemCoachIds, coachScopeIds)
      || hasIdIntersection(itemOwnerIds, ownerScopeIds);
  });
  students = [].concat(students || [], repairedStudents || []);
  if (coachScopeIds.length) {
    const bookedStudents = await queryBookedStudentsByCoachIds(coachScopeIds).catch(() => []);
    students = [].concat(students || [], bookedStudents || []);
  }

  const map = {};
  (Array.isArray(students) ? students : []).forEach((item) => {
    const key = String(item && (item._id || item.id || item.openid || item._openid) ? (item._id || item.id || item.openid || item._openid) : "").trim();
    if (!key || map[key]) {
      return;
    }
    const role = normalizeRole(item && item.role);
    if (role === "coach" || role === "admin") {
      return;
    }
    map[key] = item;
  });
  return Object.keys(map).map((key) => map[key]);
};

const notifyStudentsForSchedulePublish = async (payload) => {
  const safe = payload && typeof payload === "object" ? payload : {};
  const publisher = safe.publisher && typeof safe.publisher === "object" ? safe.publisher : {};
  const coachId = String(safe.coachId || "").trim();
  const coachOpenId = String(safe.coachOpenId || "").trim();
  const coachName = String(safe.coachName || "").trim() || "\u6559\u7ec3";
  const slots = Array.isArray(safe.slots) ? safe.slots : [];
  if (!coachId || !slots.length) {
    return;
  }

  const students = await resolveStudentReceiversForSchedulePublish(safe);
  if (!Array.isArray(students) || !students.length) {
    return;
  }
  const receivers = await expandStudentNotificationReceivers(students);
  if (!Array.isArray(receivers) || !receivers.length) {
    return;
  }

  const sortedSlots = slots
    .map((item) => ({
      id: String(item && item.id ? item.id : "").trim(),
      date: String(item && item.date ? item.date : "").trim(),
      startTime: String(item && item.startTime ? item.startTime : "").trim(),
      endTime: String(item && item.endTime ? item.endTime : "").trim(),
    }))
    .filter((item) => item.date)
    .sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });
  if (!sortedSlots.length) {
    return;
  }

  const firstSlot = sortedSlots[0];
  const lastSlot = sortedSlots[sortedSlots.length - 1];
  const isBatch = sortedSlots.length > 1;
  const title = isBatch ? "\u65b0\u8bfe\u7a0b\u6279\u91cf\u53d1\u5e03" : "\u65b0\u8bfe\u7a0b\u53d1\u5e03";
  const content = isBatch
    ? `${coachName} \u65b0\u53d1\u5e03\u4e86 ${sortedSlots.length} \u8282\u8bfe\uff08${firstSlot.date} \u81f3 ${lastSlot.date}\uff09\uff0c\u5feb\u53bb\u9884\u7ea6`
    : `${coachName} \u53d1\u5e03\u4e86 ${firstSlot.date} ${firstSlot.startTime}-${firstSlot.endTime} \u8bfe\u7a0b\uff0c\u5feb\u53bb\u9884\u7ea6`;

  await Promise.all(receivers.map((receiver) => createNotification({
    receiverUserId: String(receiver && receiver.receiverUserId ? receiver.receiverUserId : "").trim(),
    receiverOpenId: String(receiver && receiver.receiverOpenId ? receiver.receiverOpenId : "").trim(),
    senderUserId: String(publisher._id || coachId).trim(),
    senderOpenId: String(publisher.openid || publisher._openid || coachOpenId).trim(),
    senderName: coachName,
    type: "schedule_slot_published",
    title,
    content,
    relatedId: isBatch ? "" : firstSlot.id,
    relatedType: isBatch ? "schedule_slot_batch" : "schedule_slot",
    relatedPath: "/pages/student/schedule/list/list",
    extra: {
      coachId,
      coachOwnerId: coachId,
      coachName,
      slotCount: sortedSlots.length,
      firstSlotDate: firstSlot.date,
      lastSlotDate: lastSlot.date,
    },
  }).catch(() => null)));
};

const resolveCoachReceiversForSchedulePublish = async (payload) => {
  const safe = payload && typeof payload === "object" ? payload : {};
  const publisher = safe.publisher && typeof safe.publisher === "object" ? safe.publisher : {};
  const publisherRole = normalizeRole(publisher.role);
  const targetCoachId = String(safe.targetCoachId || "").trim();
  let receiverCoachIds = [];

  if (publisherRole === "admin") {
    receiverCoachIds = await queryManagedCoachIdsByAdmin(publisher);
  } else if (publisherRole === "coach") {
    const ownerIds = extractUserAdminOwnerIds(publisher, null);
    if (ownerIds.length) {
      const peerCoaches = await queryCoachUsersByAdminOwnerIds(ownerIds);
      receiverCoachIds = peerCoaches
        .map((item) => String(item && item._id ? item._id : "").trim())
        .filter(Boolean);
    }
  }

  receiverCoachIds = mergeUniqueIdList(receiverCoachIds, targetCoachId);
  if (!receiverCoachIds.length) {
    return [];
  }

  const users = await queryUsersByIds(receiverCoachIds);
  return users.filter((item) => normalizeRole(item && item.role) === "coach");
};

const notifyCoachesForSchedulePublish = async (payload) => {
  const safe = payload && typeof payload === "object" ? payload : {};
  const slots = Array.isArray(safe.slots) ? safe.slots : [];
  if (!slots.length) {
    return;
  }
  const receiverCoaches = await resolveCoachReceiversForSchedulePublish({
    publisher: safe.publisher,
    targetCoachId: safe.coachId,
  });
  if (!receiverCoaches.length) {
    return;
  }

  const publisher = safe.publisher && typeof safe.publisher === "object" ? safe.publisher : {};
  const publisherName = String(publisher.name || publisher.nickName || "").trim() || "\u6559\u7ec3";
  const senderUserId = String(publisher._id || "").trim();
  const senderOpenId = String(publisher.openid || publisher._openid || "").trim();
  const targetCoachName = String(safe.coachName || "").trim() || "\u6559\u7ec3";
  const sortedSlots = slots
    .map((item) => ({
      id: String(item && item.id ? item.id : "").trim(),
      date: String(item && item.date ? item.date : "").trim(),
      startTime: String(item && item.startTime ? item.startTime : "").trim(),
      endTime: String(item && item.endTime ? item.endTime : "").trim(),
    }))
    .filter((item) => item.date)
    .sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });
  if (!sortedSlots.length) {
    return;
  }

  const firstSlot = sortedSlots[0];
  const lastSlot = sortedSlots[sortedSlots.length - 1];
  const isBatch = sortedSlots.length > 1;
  const title = isBatch ? "\u6559\u7ec3\u7ec4\u8bfe\u7a0b\u66f4\u65b0" : "\u6559\u7ec3\u7ec4\u65b0\u8bfe\u7a0b";
  const content = isBatch
    ? `${publisherName} \u53d1\u5e03\u4e86 ${targetCoachName} \u7684 ${sortedSlots.length} \u8282\u8bfe\uff08${firstSlot.date} \u81f3 ${lastSlot.date}\uff09`
    : `${publisherName} \u53d1\u5e03\u4e86 ${targetCoachName} \u7684\u8bfe\u7a0b\uff1a${firstSlot.date} ${firstSlot.startTime}-${firstSlot.endTime}`;

  await Promise.all(receiverCoaches.map((coach) => createNotification({
    receiverUserId: String(coach && coach._id ? coach._id : "").trim(),
    receiverOpenId: String(coach && (coach.openid || coach._openid) ? (coach.openid || coach._openid) : "").trim(),
    senderUserId,
    senderOpenId,
    senderName: publisherName,
    type: "schedule_slot_published",
    title,
    content,
    relatedId: isBatch ? "" : firstSlot.id,
    relatedType: isBatch ? "schedule_slot_batch" : "schedule_slot",
    relatedPath: "/pages/student/schedule/list/list?view=coach",
  }).catch(() => null)));
};

const createScheduleSlot = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const targetCoach = await resolveScheduleCoachTarget(event, user, openid);
    if (targetCoach && targetCoach.errorMessage) {
      return { success: false, message: targetCoach.errorMessage };
    }
    const coachOwnerId = String(targetCoach.coachOwnerId || "").trim();
    const coachId = String(targetCoach.coachId || "").trim();
    const coachOpenId = String(targetCoach.coachOpenId || "").trim();
    const coachName = String(targetCoach.coachName || "").trim() || "\u6559\u7ec3";

    const date = normalizeDateText(event && event.date);
    const startTime = normalizeTimeText(event && event.startTime);
    const endTime = normalizeTimeText(event && event.endTime);
    const title = String(event && event.title ? event.title : "").trim().slice(0, 40) || SCHEDULE_DEFAULT_TITLE;
    const notes = String(event && event.notes ? event.notes : "").trim().slice(0, 300);
    const maxStudents = SCHEDULE_COACH_MAX_STUDENTS;
    const studentUnlimited = SCHEDULE_STUDENT_UNLIMITED;

    if (!date) {
      return { success: false, message: "date_required" };
    }
    if (!startTime || !endTime) {
      return { success: false, message: "time_required" };
    }
    if (toScheduleMinutes(startTime) >= toScheduleMinutes(endTime)) {
      return { success: false, message: "invalid_time_range" };
    }

    const _ = db.command;
    const scopedCoachIds = mergeUniqueIdList(coachId, coachOwnerId);
    const coachFilter = scopedCoachIds.length === 1
      ? _.or([{ coachId: scopedCoachIds[0] }, { coachOwnerId: scopedCoachIds[0] }])
      : _.or([{ coachId: _.in(scopedCoachIds) }, { coachOwnerId: _.in(scopedCoachIds) }]);
    const existingSlots = await db.collection(SCHEDULE_SLOT_COLLECTION).where(_.and([
      coachFilter,
      { date },
      { status: _.in(["open", "closed"]) },
    ])).limit(200).get().catch(() => ({ data: [] }));
    const slotList = existingSlots && existingSlots.data ? existingSlots.data : [];
    const hasConflict = slotList.some((item) =>
      isScheduleTimeConflict(startTime, endTime, item.startTime, item.endTime)
    );
    if (hasConflict) {
      return { success: false, message: "slot_conflict" };
    }

    const addRes = await db.collection(SCHEDULE_SLOT_COLLECTION).add({
      data: {
        coachId,
        coachOwnerId,
        coachOpenId,
        coachName,
        date,
        startTime,
        endTime,
        title,
        notes,
        maxStudents,
        studentUnlimited,
        bookedCount: 0,
        status: "open",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    const slotId = addRes && addRes._id ? addRes._id : "";
    if (slotId) {
      const publishPayload = {
        publisher: user,
        coachId,
        coachOpenId,
        coachName,
        slots: [{ id: slotId, date, startTime, endTime }],
      };
      await Promise.all([
        notifyStudentsForSchedulePublish(publishPayload).catch(() => null),
        notifyCoachesForSchedulePublish(publishPayload).catch(() => null),
      ]);
    }
    return {
      success: !!slotId,
      slotId,
      slot: {
        id: slotId,
        coachId,
        coachName,
        date,
        startTime,
        endTime,
        title,
        notes,
        maxStudents,
        studentUnlimited,
        bookedCount: 0,
        status: "open",
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "create_schedule_slot_failed",
      errMsg: e,
    };
  }
};

const createWeeklyScheduleSlots = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const templateRaw = Array.isArray(event && event.template) ? event.template : [];
    if (!templateRaw.length) {
      return { success: false, message: "template_required" };
    }

    const targetCoach = await resolveScheduleCoachTarget(event, user, openid);
    if (targetCoach && targetCoach.errorMessage) {
      return { success: false, message: targetCoach.errorMessage };
    }
    const coachOwnerId = String(targetCoach.coachOwnerId || "").trim();
    const coachId = String(targetCoach.coachId || "").trim();
    const coachOpenId = String(targetCoach.coachOpenId || "").trim();
    const coachName = String(targetCoach.coachName || "").trim() || "\u6559\u7ec3";

    const weekOffsetNum = Number(event && event.weekOffset);
    const weekOffset = Number.isFinite(weekOffsetNum) ? Math.max(0, Math.min(8, Math.floor(weekOffsetNum))) : 0;
    const globalMaxStudents = SCHEDULE_COACH_MAX_STUDENTS;
    const globalStudentUnlimited = SCHEDULE_STUDENT_UNLIMITED;
    const globalTitle = String(event && event.title ? event.title : "").trim().slice(0, 40);
    const globalNotes = String(event && event.notes ? event.notes : "").trim().slice(0, 300);

    const template = templateRaw
      .map((item) => {
        const safe = item && typeof item === "object" ? item : {};
        const weekday = Number(safe.weekday);
        const startTime = normalizeTimeText(safe.startTime);
        const endTime = normalizeTimeText(safe.endTime);
        const title = String(safe.title || globalTitle || "").trim().slice(0, 40) || SCHEDULE_DEFAULT_TITLE;
        const notes = String(safe.notes || globalNotes || "").trim().slice(0, 300);
        const maxStudents = globalMaxStudents;
        const studentUnlimited = globalStudentUnlimited;
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
          return null;
        }
        if (!startTime || !endTime) {
          return null;
        }
        if (toScheduleMinutes(startTime) >= toScheduleMinutes(endTime)) {
          return null;
        }
        return {
          weekday,
          startTime,
          endTime,
          title,
          notes,
          maxStudents,
          studentUnlimited,
        };
      })
      .filter(Boolean);

    if (!template.length) {
      return { success: false, message: "template_invalid" };
    }

    const todayText = getTodayDateText();
    const todayDate = toScheduleDateObject(todayText);
    const thisWeekStart = getScheduleWeekStartDate(todayDate);
    if (!thisWeekStart) {
      return { success: false, message: "invalid_today_date" };
    }
    const targetWeekStart = new Date(thisWeekStart.getTime());
    targetWeekStart.setDate(targetWeekStart.getDate() + weekOffset * 7);
    const targetWeekEnd = new Date(targetWeekStart.getTime());
    targetWeekEnd.setDate(targetWeekEnd.getDate() + 6);
    const weekStartText = formatScheduleDateObject(targetWeekStart);
    const weekEndText = formatScheduleDateObject(targetWeekEnd);

    const candidateSlots = template
      .map((item) => {
        const dateObj = new Date(targetWeekStart.getTime());
        dateObj.setDate(dateObj.getDate() + (item.weekday - 1));
        const dateText = formatScheduleDateObject(dateObj);
        return {
          ...item,
          date: dateText,
        };
      })
      .filter((item) => item.date && item.date >= todayText)
      .sort((a, b) => {
        if (a.date !== b.date) {
          return a.date.localeCompare(b.date);
        }
        return toScheduleMinutes(a.startTime) - toScheduleMinutes(b.startTime);
      });

    if (!candidateSlots.length) {
      return {
        success: true,
        createdCount: 0,
        skippedCount: template.length,
        skipped: [{ reason: "all_in_past_or_invalid" }],
      };
    }

    const _ = db.command;
    const scopedCoachIds = mergeUniqueIdList(coachId, coachOwnerId);
    const coachFilter = scopedCoachIds.length === 1
      ? _.or([{ coachId: scopedCoachIds[0] }, { coachOwnerId: scopedCoachIds[0] }])
      : _.or([{ coachId: _.in(scopedCoachIds) }, { coachOwnerId: _.in(scopedCoachIds) }]);
    const existingRes = await db.collection(SCHEDULE_SLOT_COLLECTION).where(_.and([
      coachFilter,
      { status: _.in(["open", "closed"]) },
      { date: _.gte(weekStartText) },
    ])).limit(500).get().catch(() => ({ data: [] }));
    const existingList = (existingRes && existingRes.data ? existingRes.data : [])
      .filter((item) => String(item && item.date ? item.date : "") <= weekEndText);

    const slotsByDate = {};
    existingList.forEach((item) => {
      const date = String(item && item.date ? item.date : "").trim();
      if (!date) {
        return;
      }
      if (!slotsByDate[date]) {
        slotsByDate[date] = [];
      }
      slotsByDate[date].push(item);
    });

    const created = [];
    const skipped = [];
    for (const slot of candidateSlots) {
      const sameDaySlots = Array.isArray(slotsByDate[slot.date]) ? slotsByDate[slot.date] : [];
      const hasConflict = sameDaySlots.some((item) =>
        isScheduleTimeConflict(slot.startTime, slot.endTime, item.startTime, item.endTime)
      );
      if (hasConflict) {
        skipped.push({
          date: slot.date,
          startTime: slot.startTime,
          endTime: slot.endTime,
          reason: "slot_conflict",
        });
        continue;
      }

      const addRes = await db.collection(SCHEDULE_SLOT_COLLECTION).add({
        data: {
          coachId,
          coachOwnerId,
          coachOpenId,
          coachName,
          date: slot.date,
          startTime: slot.startTime,
          endTime: slot.endTime,
          title: slot.title,
          notes: slot.notes,
          maxStudents: slot.maxStudents,
          studentUnlimited: slot.studentUnlimited,
          bookedCount: 0,
          status: "open",
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
      const slotId = addRes && addRes._id ? addRes._id : "";
      created.push({
        id: slotId,
        date: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
      sameDaySlots.push({
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
      slotsByDate[slot.date] = sameDaySlots;
    }

    if (created.length) {
      const publishPayload = {
        publisher: user,
        coachId,
        coachOpenId,
        coachName,
        slots: created,
      };
      await Promise.all([
        notifyStudentsForSchedulePublish(publishPayload).catch(() => null),
        notifyCoachesForSchedulePublish(publishPayload).catch(() => null),
      ]);
    }

    return {
      success: true,
      weekStart: weekStartText,
      weekEnd: weekEndText,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "create_weekly_schedule_slots_failed",
      errMsg: e,
    };
  }
};

const listCoachScheduleSlots = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", slots: [] };
    }
    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied", slots: [] };
    }

    const coachOwnerId = String(user._id || "").trim();
    const coachOpenId = String(user.openid || "").trim();
    const requestedCoachId = String(event && event.coachId ? event.coachId : "").trim();
    const _ = db.command;
    let where = null;
    if (role === "admin") {
      let scopedCoachIds = [];
      if (requestedCoachId) {
        scopedCoachIds = mergeUniqueIdList(
          await filterCoachIdsByAdminScope(user, [requestedCoachId]),
          requestedCoachId === coachOwnerId ? coachOwnerId : ""
        );
        if (!scopedCoachIds.length) {
          return { success: false, message: "permission_denied", slots: [] };
        }
      } else {
        scopedCoachIds = mergeUniqueIdList(
          await queryManagedCoachIdsByAdmin(user),
          coachOwnerId
        );
      }
      if (!scopedCoachIds.length) {
        return { success: true, slots: [], hasNoCoachBinding: true };
      }
      if (scopedCoachIds.length === 1) {
        const id = scopedCoachIds[0];
        where = _.or([{ coachId: id }, { coachOwnerId: id }]);
      } else {
        where = _.or([{ coachId: _.in(scopedCoachIds) }, { coachOwnerId: _.in(scopedCoachIds) }]);
      }
    } else {
      const coachId = requestedCoachId || coachOwnerId;
      const whereList = [{ coachId }, { coachOwnerId }];
      if (coachOpenId) {
        whereList.push({ coachOpenId });
      }
      where = _.or(whereList);
    }
    const lightweight = !!(event && (event.lightweight || event.recentOnly));
    const requestedLimit = Number(event && event.limit ? event.limit : 8);
    const slotsRaw = lightweight
      ? await queryRecentScheduleSlots(where, true, requestedLimit)
      : await queryScheduleSlots(where, true);
    const slots = dedupScheduleSlotsByFingerprint(slotsRaw, { includeStatus: true });
    if (lightweight) {
      return {
        success: true,
        slots: sortScheduleListByDateTime(
          slots.map((item) => mapScheduleSlot(item, 0, false)),
          "date",
          "startTime"
        ),
      };
    }
    const slotIds = slots.map((item) => String(item && item._id ? item._id : "").trim()).filter(Boolean);
    const { activeBookings } = await getActiveBookingStatsBySlotIds(slotIds);
    const myUserId = String(user._id || "").trim();
    const myOpenid = String(openid || user.openid || user._openid || "").trim();
    const myBookedSlotMap = {};
    const coachBookedCountBySlotId = {};
    const studentBookedCountBySlotId = {};
    (Array.isArray(activeBookings) ? activeBookings : []).forEach((booking) => {
      const slotId = String(booking && booking.slotId ? booking.slotId : "").trim();
      if (!slotId) {
        return;
      }
      const roleText = resolveEffectiveScheduleBookerRole(booking);
      if (roleText === "coach") {
        coachBookedCountBySlotId[slotId] = (coachBookedCountBySlotId[slotId] || 0) + 1;
      } else {
        studentBookedCountBySlotId[slotId] = (studentBookedCountBySlotId[slotId] || 0) + 1;
      }
      const same = isSameScheduleBooker(
        String(booking && booking.studentId ? booking.studentId : "").trim(),
        String(booking && booking.studentOpenId ? booking.studentOpenId : "").trim(),
        myUserId,
        myOpenid
      );
      if (same) {
        myBookedSlotMap[slotId] = true;
      }
    });

    return {
      success: true,
      slots: sortScheduleListByDateTime(
        slots.map((item) => {
          const slotId = String(item && item._id ? item._id : "").trim();
          const coachBookedCount = Math.max(0, Number(coachBookedCountBySlotId[slotId] || 0));
          const studentBookedCount = Math.max(0, Number(studentBookedCountBySlotId[slotId] || 0));
          const totalBookedCount = coachBookedCount + studentBookedCount;
          const mapped = mapScheduleSlot(item, coachBookedCount, !!myBookedSlotMap[slotId]);
          return {
            ...mapped,
            coachBookedCount,
            studentBookedCount,
            totalBookedCount,
          };
        }),
        "date",
        "startTime"
      ),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coach_schedule_slots_failed",
      slots: [],
      errMsg: e,
    };
  }
};

const listStudentBookableSlots = async (event) => {
  try {
    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    const actorEvent = forceStudentView
      ? { ...(event && typeof event === "object" ? event : {}), expectedRole: "student" }
      : event;
    const { user, actorOpenid } = await resolveScheduleActorUser(actorEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", slots: [] };
    }
    const role = normalizeRole(user.role);
    if (role !== "student" && role !== "user" && role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied", slots: [] };
    }
    // 无身份账号（role=user）在学生视角下不开放预约：返回空列表，前端展示可预约 0
    if (forceStudentView && role !== "student" && role !== "user") {
      return { success: false, message: "permission_denied", slots: [] };
    }
    const isCoachViewer = !forceStudentView && (role === "coach" || role === "admin");
    const _ = db.command;
    const selfCoachId = String(user._id || "").trim();
    const eventCoachIds = mergeUniqueIdList(
      normalizeIdList(event && event.coachIds),
      normalizeIdList(event && event.coachIDs),
      event && event.coachId,
      event && event.coachID
    );
    let coachIds = [];
    if (isCoachViewer) {
      if (role === "admin") {
        const adminScopedCoachIds = eventCoachIds.length
          ? await filterCoachIdsByAdminScope(user, eventCoachIds)
          : await queryManagedCoachIdsByAdmin(user);
        coachIds = mergeUniqueIdList(adminScopedCoachIds);
      } else {
        coachIds = await queryPeerCoachIdsByCoach(user);
      }
    } else {
      coachIds = await resolveStudentSharedCoachIdsForSchedule(user, event);
    }
    if (!coachIds.length) {
      return {
        success: true,
        lessonPackage: mapStudentLessonPackage(user),
        slots: [],
        hasNoCoachBinding: true,
      };
    }
    const today = getTodayDateText();
    const coachWhereList = coachIds.length === 1
      ? [{ coachId: coachIds[0] }, { coachOwnerId: coachIds[0] }]
      : [{ coachId: _.in(coachIds) }, { coachOwnerId: _.in(coachIds) }];
    const where = _.and([
      { status: "open" },
      { date: _.gte(today) },
      _.or(coachWhereList),
    ]);
    const slotsRaw = await queryScheduleSlots(where, true);
    const slots = dedupScheduleSlotsByFingerprint(slotsRaw, { includeStatus: false });

    const slotIds = slots.map((item) => String(item && item._id ? item._id : "").trim()).filter(Boolean);
    const { countBySlotId, activeBookings } = await getActiveBookingStatsBySlotIds(slotIds);
    const myUserId = String(user._id || "").trim();
    const myOpenid = String(actorOpenid || user.openid || "").trim();

    const myBookedSlotMap = {};
    const coachBookedCountBySlotId = {};
    const studentBookedCountBySlotId = {};
    (activeBookings || []).forEach((item) => {
      const itemSlotId = String(item && item.slotId ? item.slotId : "").trim();
      const currentBookerRole = resolveEffectiveScheduleBookerRole(item);
      if (itemSlotId && currentBookerRole === "coach") {
        coachBookedCountBySlotId[itemSlotId] = (coachBookedCountBySlotId[itemSlotId] || 0) + 1;
      } else if (itemSlotId) {
        studentBookedCountBySlotId[itemSlotId] = (studentBookedCountBySlotId[itemSlotId] || 0) + 1;
      }
      const same = isSameScheduleBooker(
        String(item && item.studentId ? item.studentId : "").trim(),
        String(item && item.studentOpenId ? item.studentOpenId : "").trim(),
        myUserId,
        myOpenid
      );
      if (!same) {
        return;
      }
      if (itemSlotId) {
        myBookedSlotMap[itemSlotId] = true;
      }
    });

    const lessonPackage = mapStudentLessonPackage(user);
    const mappedSlots = slots.map((item) => {
        const slotId = String(item && item._id ? item._id : "").trim();
        const mapped = mapScheduleSlot(item, countBySlotId[slotId] || 0, !!myBookedSlotMap[slotId]);
        const coachBookedCount = Math.max(0, Number(coachBookedCountBySlotId[slotId] || 0));
        const studentBookedCount = Math.max(0, Number(studentBookedCountBySlotId[slotId] || 0));
        if (isCoachViewer) {
          const coachIsFull = coachBookedCount >= SCHEDULE_COACH_MAX_STUDENTS;
          return {
            ...mapped,
            coachBookedCount,
            bookedCount: coachBookedCount,
            studentBookedCount,
            remainingCount: Math.max(0, SCHEDULE_COACH_MAX_STUDENTS - coachBookedCount),
            isFull: coachIsFull,
            canBook: mapped.status === "open" && !mapped.isBookedByMe && !coachIsFull,
          };
        }
        // Student booking is always unlimited by headcount.
        return {
          ...mapped,
          coachBookedCount,
          studentBookedCount,
          canBook: mapped.status === "open" && !mapped.isBookedByMe,
            isFull: false,
        };
      });
    const preferredCoachIds = mergeUniqueIdList(
      String(user && user.coachId ? user.coachId : "").trim(),
      normalizeIdList(user && user.coachIds),
      normalizeIdList(user && user.coachIDs),
      normalizeIdList(user && user.coachids)
    );
    const finalSlots = isCoachViewer
      ? mappedSlots
      : dedupeStudentVisibleSlotsByTimeslot(mappedSlots, preferredCoachIds);
    return {
      success: true,
      lessonPackage,
      slots: finalSlots,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_student_bookable_slots_failed",
      lessonPackage: {
        enabled: false,
        totalLessons: 0,
        remainingLessons: 0,
        usedLessons: 0,
      },
      slots: [],
      errMsg: e,
    };
  }
};

const setStudentLessonQuota = async (event) => {
  try {
    const studentId = String(event && event.studentId ? event.studentId : "").trim();
    if (!studentId) {
      return { success: false, message: "student_id_required" };
    }

    const totalRaw = event && event.totalLessons;
    if (typeof totalRaw === "undefined" || totalRaw === null || String(totalRaw).trim() === "") {
      return { success: false, message: "total_lessons_required" };
    }
    const totalLessons = toNonNegativeInt(totalRaw);
    const hasRemainingInput = !(
      typeof (event && event.remainingLessons) === "undefined"
      || (event && event.remainingLessons) === null
      || String(event && event.remainingLessons).trim() === ""
    );
    const remainingLessons = hasRemainingInput
      ? toNonNegativeInt(event.remainingLessons)
      : totalLessons;
    if (remainingLessons > totalLessons) {
      return { success: false, message: "remaining_exceed_total" };
    }

    const { user } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const studentRes = await db.collection(USER_COLLECTION).doc(studentId).get().catch(() => null);
    const student = studentRes && studentRes.data ? studentRes.data : null;
    if (!student) {
      return { success: false, message: "student_not_found" };
    }

    if (role === "coach") {
      const coachId = String(user._id || "").trim();
      const studentCoachIds = extractUserCoachIds(student, null);
      const peerCoachIds = await queryPeerCoachIdsByCoach(user);
      const scopedCoachIds = mergeUniqueIdList(coachId, peerCoachIds);
      const matchedCoach = studentCoachIds.some((id) => scopedCoachIds.includes(id));
      if (!matchedCoach) {
        const studentOwnerIds = extractUserAdminOwnerIds(student, null);
        const coachOwnerIds = extractUserAdminOwnerIds(user, null);
        const sameAdmin = studentOwnerIds.some((id) => coachOwnerIds.includes(id));
        if (!sameAdmin) {
          return { success: false, message: "student_not_assigned_to_coach" };
        }
      }
    } else if (role === "admin") {
      const canManageStudent = await isStudentManagedByAdmin(user, student);
      if (!canManageStudent) {
        return { success: false, message: "permission_denied" };
      }
    }

    const usedLessons = Math.max(0, totalLessons - remainingLessons);
    await db.collection(USER_COLLECTION).doc(studentId).update({
      data: {
        [LESSON_TOTAL_FIELD]: totalLessons,
        [LESSON_REMAINING_FIELD]: remainingLessons,
        [LESSON_USED_FIELD]: usedLessons,
        [LEGACY_LESSON_TOTAL_FIELD]: totalLessons,
        [LEGACY_LESSON_REMAINING_FIELD]: remainingLessons,
        [LEGACY_LESSON_USED_FIELD]: usedLessons,
        lessonUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      studentId,
      lessonPackage: {
        enabled: true,
        totalLessons,
        remainingLessons,
        usedLessons,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "set_student_lesson_quota_failed",
      errMsg: e,
    };
  }
};

const bookScheduleSlot = async (event) => {
  let consumedStudentId = "";
  let shouldRollbackLesson = false;
  try {
    const slotId = String(event && event.slotId ? event.slotId : "").trim();
    if (!slotId) {
      return { success: false, message: "slot_id_required" };
    }

    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    const actorEvent = forceStudentView
      ? { ...(event && typeof event === "object" ? event : {}), expectedRole: "student" }
      : event;
    const { user, actorOpenid } = await resolveScheduleActorUser(actorEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const role = normalizeRole(user.role);
    if (role !== "student" && role !== "user" && role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }
    // 学生视角下仅允许已分配学员身份的账号预约
    if (forceStudentView && role !== "student" && role !== "user") {
      return { success: false, message: "permission_denied" };
    }
    const isCoachBooker = !forceStudentView && (role === "coach" || role === "admin");
    const bookerRole = isCoachBooker ? "coach" : "student";

    const slotRes = await db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).get().catch(() => null);
    const slot = slotRes && slotRes.data ? slotRes.data : null;
    if (!slot) {
      return { success: false, message: "slot_not_found" };
    }
    if (String(slot.status || "open") !== "open" || isScheduleSlotExpired(slot.date, slot.endTime)) {
      return { success: false, message: "slot_not_open" };
    }

    const slotCoachId = String(slot.coachId || "").trim();
    const slotCoachOwnerId = String(slot.coachOwnerId || "").trim();
    if (!isCoachBooker) {
      const studentCoachIds = await resolveStudentSharedCoachIdsForSchedule(user, event);
      const matched = studentCoachIds.includes(slotCoachId) || studentCoachIds.includes(slotCoachOwnerId);
      if (!studentCoachIds.length || !matched) {
        return { success: false, message: "not_your_coach_slot" };
      }
    } else if (role === "admin") {
      const scopedCoachIds = await filterCoachIdsByAdminScope(user, [slotCoachOwnerId || slotCoachId]);
      if (!scopedCoachIds.length) {
        return { success: false, message: "permission_denied" };
      }
    }

    const studentId = String(user._id || "").trim();
    const studentOpenId = String(actorOpenid || user.openid || "").trim();
    const studentName = String(user.name || user.nickName || "").trim() || "\u5b66\u5458";

    const _ = db.command;
    const identityFilter = buildScheduleBookerIdentityFilter(studentId, studentOpenId);
    if (!identityFilter) {
      return { success: false, message: "user_identity_missing" };
    }

    const duplicatedRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where(_.and([
      { slotId, status: "active" },
      identityFilter,
    ])).limit(1).get().catch(() => ({ data: [] }));
    const duplicatedList = duplicatedRes && duplicatedRes.data ? duplicatedRes.data : [];
    if (duplicatedList.length) {
      return { success: false, message: "already_booked" };
    }

    const mySameDayRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where(_.and([
      { status: "active", date: String(slot.date || "").trim() },
      identityFilter,
    ])).limit(100).get().catch(() => ({ data: [] }));
    const mySameDayBookings = mySameDayRes && mySameDayRes.data ? mySameDayRes.data : [];
    const hasTimeConflict = mySameDayBookings.some((item) =>
      isScheduleTimeConflict(slot.startTime, slot.endTime, item.startTime, item.endTime)
    );
    if (hasTimeConflict) {
      return { success: false, message: "booking_conflict" };
    }

    const activeSlotBookingRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
      slotId,
      status: "active",
    }).count().catch(() => ({ total: 0 }));
    const activeCount = activeSlotBookingRes && typeof activeSlotBookingRes.total === "number"
      ? activeSlotBookingRes.total
      : 0;
    let consumeRes = { success: true, lessonPackage: null };
    if (isCoachBooker) {
      const coachBookingCountRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
        slotId,
        status: "active",
        bookerRole: "coach",
      }).count().catch(() => ({ total: 0 }));
      const coachBookingCount = coachBookingCountRes && typeof coachBookingCountRes.total === "number"
        ? coachBookingCountRes.total
        : 0;
      if (coachBookingCount >= SCHEDULE_COACH_MAX_STUDENTS) {
        return { success: false, message: "slot_full" };
      }
    } else {
      // Student booking never enforces slot headcount.
      consumeRes = await adjustStudentLessonPackage(studentId, -1);
      if (!consumeRes || !consumeRes.success) {
        const msg = consumeRes && consumeRes.message ? consumeRes.message : "";
        if (msg === "lesson_quota_not_set") {
          await db.collection(USER_COLLECTION).doc(studentId).update({
            data: {
              [LESSON_TOTAL_FIELD]: 10,
              [LESSON_REMAINING_FIELD]: 9,
              [LESSON_USED_FIELD]: 1,
              [LEGACY_LESSON_TOTAL_FIELD]: 10,
              [LEGACY_LESSON_REMAINING_FIELD]: 9,
              [LEGACY_LESSON_USED_FIELD]: 1,
              lessonUpdatedAt: db.serverDate(),
              updatedAt: db.serverDate(),
            },
          }).catch(() => null);
          consumeRes = { success: true, lessonPackage: { enabled: true, totalLessons: 10, remainingLessons: 9, usedLessons: 1 } };
        } else {
          return { success: false, message: msg || "consume_lesson_failed" };
        }
      }
      consumedStudentId = studentId;
      shouldRollbackLesson = true;
    }

    const addRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).add({
      data: {
        slotId,
        coachId: slotCoachId,
        coachOwnerId: slotCoachOwnerId,
        coachOpenId: String(slot.coachOpenId || "").trim(),
        coachName: String(slot.coachName || "").trim() || "\u6559\u7ec3",
        studentId,
        studentOpenId,
        studentName,
        bookerRole,
        bookerIsCoach: isCoachBooker,
        bookerUserRole: role,
        title: String(slot.title || "").trim() || SCHEDULE_DEFAULT_TITLE,
        date: String(slot.date || "").trim(),
        startTime: String(slot.startTime || "").trim(),
        endTime: String(slot.endTime || "").trim(),
        status: "active",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    const bookingId = addRes && addRes._id ? addRes._id : "";
    if (!bookingId) {
      throw new Error("booking_create_failed");
    }

    await db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).update({
      data: {
        bookedCount: activeCount + 1,
        updatedAt: db.serverDate(),
      },
    }).catch(() => null);

    await createNotification({
      receiverUserId: slotCoachOwnerId,
      receiverOpenId: String(slot.coachOpenId || "").trim(),
      senderUserId: studentId,
      senderOpenId: studentOpenId,
      senderName: studentName,
      type: "schedule_booking",
      title: "\u8bfe\u7a0b\u9884\u7ea6\u901a\u77e5",
      content: `${isCoachBooker ? "\u6559\u7ec3" : "\u5b66\u5458"}${studentName} \u9884\u7ea6\u4e86 ${slot.date} ${slot.startTime}-${slot.endTime}`,
      relatedId: bookingId,
      relatedType: "schedule_booking",
      relatedPath: "/pages/coach/schedule/manage/manage",
    }).catch(() => null);

    await sendScheduleBookingSubscribeMessage({
      receiverOpenId: String(slot.coachOpenId || "").trim(),
      studentName,
      scheduleTime: `${String(slot.date || "").trim()} ${String(slot.startTime || "").trim()}-${String(slot.endTime || "").trim()}`,
      courseTitle: String(slot.title || "").trim() || SCHEDULE_DEFAULT_TITLE,
      remark: isCoachBooker ? "\u6709\u6559\u7ec3\u9884\u7ea6\u4e86\u8bfe\u7a0b" : "\u6709\u5b66\u5458\u9884\u7ea6\u4e86\u65b0\u8bfe\u7a0b",
    }).catch(() => null);

    shouldRollbackLesson = false;
    return {
      success: true,
      bookingId,
      lessonPackage: isCoachBooker ? null : (consumeRes.lessonPackage || null),
    };
  } catch (e) {
    if (shouldRollbackLesson && consumedStudentId) {
      await adjustStudentLessonPackage(consumedStudentId, 1).catch(() => null);
    }
    return {
      success: false,
      message: e && e.message ? e.message : "book_schedule_slot_failed",
      errMsg: e,
    };
  }
};

const listMyScheduleBookings = async (event) => {
  try {
    const asBooker = !!(event && event.asBooker);
    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    const shouldStudentView = forceStudentView;
    const actorEvent = shouldStudentView
      ? { ...(event && typeof event === "object" ? event : {}), expectedRole: "student" }
      : event;
    const { user, actorOpenid } = await resolveScheduleActorUser(actorEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", bookings: [] };
    }
    const role = normalizeRole(user.role);
    const includeCancelled = !!(event && event.includeCancelled);

    const _ = db.command;
    let where = null;
    if (asBooker) {
      const studentId = String(user._id || "").trim();
      const studentOpenId = String(actorOpenid || user.openid || "").trim();
      where = buildScheduleBookerIdentityFilter(studentId, studentOpenId);
    } else if (role === "coach" || role === "admin") {
      const requestedCoachId = String(event && event.coachId ? event.coachId : "").trim();
      const coachOwnerId = String(user._id || "").trim();
      const coachOpenId = String(actorOpenid || user.openid || "").trim();
      const list = [];
      if (role === "admin") {
        const scopedCoachIds = requestedCoachId
          ? await filterCoachIdsByAdminScope(user, [requestedCoachId])
          : await queryManagedCoachIdsByAdmin(user);
        if (!scopedCoachIds.length) {
          return { success: true, bookings: [] };
        }
        if (scopedCoachIds.length === 1) {
          const onlyCoachId = scopedCoachIds[0];
          list.push({ coachOwnerId: onlyCoachId }, { coachId: onlyCoachId });
        } else {
          list.push({ coachOwnerId: _.in(scopedCoachIds) }, { coachId: _.in(scopedCoachIds) });
        }
      } else {
        list.push({ coachOwnerId }, { coachId: coachOwnerId });
        if (coachOpenId) {
          list.push({ coachOpenId });
        }
      }
      where = _.or(list);
    } else {
      const studentId = String(user._id || "").trim();
      const studentOpenId = String(actorOpenid || user.openid || "").trim();
      where = buildScheduleBookerIdentityFilter(studentId, studentOpenId);
    }

    if (!where) {
      return { success: true, bookings: [] };
    }

    if (!includeCancelled) {
      where = _.and([where, { status: "active" }]);
    }

    const bookings = await queryScheduleBookings(where, true);
    return {
      success: true,
      bookings: sortScheduleListByDateTime(
        bookings.map((item) => mapScheduleBooking(item)),
        "date",
        "startTime"
      ),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_my_schedule_bookings_failed",
      bookings: [],
      errMsg: e,
    };
  }
};

const cancelScheduleBooking = async (event) => {
  try {
    const bookingId = String(event && event.bookingId ? event.bookingId : "").trim();
    if (!bookingId) {
      return { success: false, message: "booking_id_required" };
    }

    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    const actorEvent = forceStudentView
      ? { ...(event && typeof event === "object" ? event : {}), expectedRole: "student" }
      : event;
    const { user, actorOpenid } = await resolveScheduleActorUser(actorEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const role = normalizeRole(user.role);

    const bookingRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).doc(bookingId).get().catch(() => null);
    const booking = bookingRes && bookingRes.data ? bookingRes.data : null;
    if (!booking) {
      return { success: false, message: "booking_not_found" };
    }
    if (String(booking.status || "") !== "active") {
      return { success: false, message: "booking_not_active" };
    }

    const currentUserId = String(user._id || "").trim();
    const currentOpenid = String(actorOpenid || user.openid || "").trim();
    const canByStudent = isSameScheduleBooker(
      String(booking.studentId || "").trim(),
      String(booking.studentOpenId || "").trim(),
      currentUserId,
      currentOpenid
    );
    let canByAdminScope = false;
    if (role === "admin" && !canByStudent) {
      const bookingCoachId = String(booking.coachOwnerId || booking.coachId || "").trim();
      const scopedCoachIds = await filterCoachIdsByAdminScope(user, [bookingCoachId]);
      canByAdminScope = scopedCoachIds.length > 0;
    }
    const canOperate = canByStudent || canByAdminScope;
    if (!canOperate) {
      return { success: false, message: "permission_denied" };
    }

    const cancelReason = String(event && event.cancelReason ? event.cancelReason : "").trim().slice(0, 80);
    await db.collection(SCHEDULE_BOOKING_COLLECTION).doc(bookingId).update({
      data: {
        status: "cancelled",
        cancelReason: cancelReason || "",
        cancelledAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    const slotId = String(booking.slotId || "").trim();
    if (slotId) {
      const activeCountRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
        slotId,
        status: "active",
      }).count().catch(() => ({ total: 0 }));
      const activeCount = activeCountRes && typeof activeCountRes.total === "number" ? activeCountRes.total : 0;
      await db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).update({
        data: {
          bookedCount: Math.max(0, activeCount),
          updatedAt: db.serverDate(),
        },
      }).catch(() => null);
    }

    const bookingStudentId = String(booking.studentId || "").trim();
    if (resolveEffectiveScheduleBookerRole(booking) === "student" && bookingStudentId) {
      await adjustStudentLessonPackage(bookingStudentId, 1).catch(() => null);
    }

    return {
      success: true,
      bookingId,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "cancel_schedule_booking_failed",
      errMsg: e,
    };
  }
};

const cancelScheduleSlot = async (event) => {
  try {
    const slotId = String(event && event.slotId ? event.slotId : "").trim();
    if (!slotId) {
      return { success: false, message: "slot_id_required" };
    }

    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const slotRes = await db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).get().catch(() => null);
    const slot = slotRes && slotRes.data ? slotRes.data : null;
    if (!slot) {
      return { success: false, message: "slot_not_found" };
    }

    let canOperate = isSameUser(
      String(slot.coachOwnerId || slot.coachId || "").trim(),
      String(slot.coachOpenId || "").trim(),
      String(user._id || "").trim(),
      String(openid || user.openid || "").trim()
    );
    if (!canOperate && role === "admin") {
      const slotCoachId = String(slot.coachOwnerId || slot.coachId || "").trim();
      const scopedCoachIds = await filterCoachIdsByAdminScope(user, [slotCoachId]);
      canOperate = scopedCoachIds.length > 0;
    }
    if (!canOperate) {
      return { success: false, message: "permission_denied" };
    }

    const activeBookingRes = await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
      slotId,
      status: "active",
    }).limit(200).get().catch(() => ({ data: [] }));
    const activeBookings = activeBookingRes && activeBookingRes.data ? activeBookingRes.data : [];

    await db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).update({
      data: {
        status: "cancelled",
        bookedCount: 0,
        updatedAt: db.serverDate(),
      },
    });

    if (activeBookings.length) {
      await db.collection(SCHEDULE_BOOKING_COLLECTION).where({
        slotId,
        status: "active",
      }).update({
        data: {
          status: "cancelled",
          cancelReason: "coach_cancelled_slot",
          cancelledAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      }).catch(() => null);

      await Promise.all(activeBookings.map((item) => {
        const studentId = String(item && item.studentId ? item.studentId : "").trim();
        if (!studentId || resolveEffectiveScheduleBookerRole(item) !== "student") {
          return Promise.resolve(null);
        }
        return adjustStudentLessonPackage(studentId, 1).catch(() => null);
      }));

      await Promise.all(activeBookings.map((item) =>
        createNotification({
          receiverUserId: String(item.studentId || "").trim(),
          receiverOpenId: String(item.studentOpenId || "").trim(),
          senderUserId: String(slot.coachOwnerId || slot.coachId || "").trim(),
          senderOpenId: String(slot.coachOpenId || "").trim(),
          senderName: String(slot.coachName || "").trim() || "\u6559\u7ec3",
          type: "schedule_slot_cancelled",
          title: "\u8bfe\u7a0b\u53d6\u6d88\u901a\u77e5",
          content: `${slot.date} ${slot.startTime}-${slot.endTime} \u8bfe\u7a0b\u5df2\u53d6\u6d88`,
          relatedId: slotId,
          relatedType: "schedule_slot",
          relatedPath: "/pages/student/schedule/list/list",
        }).catch(() => null)
      ));
    }

    return {
      success: true,
      slotId,
      cancelledBookingCount: activeBookings.length,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "cancel_schedule_slot_failed",
      errMsg: e,
    };
  }
};

const cleanupDuplicateScheduleSlots = async (event) => {
  try {
    const { user } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "admin",
    });
    if (!user || !user._id || normalizeRole(user.role) !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const operatorId = String(user._id || "").trim();
    const requestedCoachId = String(
      (event && (event.coachId || event.targetCoachId || event.coachID || event.targetCoachID)) || ""
    ).trim();
    const _ = db.command;

    let scopedCoachIds = [];
    if (requestedCoachId) {
      scopedCoachIds = mergeUniqueIdList(
        await filterCoachIdsByAdminScope(user, [requestedCoachId]),
        requestedCoachId === operatorId ? operatorId : ""
      );
      if (!scopedCoachIds.length) {
        return { success: false, message: "permission_denied" };
      }
    } else {
      scopedCoachIds = mergeUniqueIdList(
        await queryManagedCoachIdsByAdmin(user),
        operatorId
      );
    }
    if (!scopedCoachIds.length) {
      return {
        success: true,
        checkedCount: 0,
        duplicateGroupCount: 0,
        cleanedCount: 0,
        skippedWithBookings: 0,
        failedCount: 0,
      };
    }

    const coachFilter = scopedCoachIds.length === 1
      ? _.or([{ coachId: scopedCoachIds[0] }, { coachOwnerId: scopedCoachIds[0] }])
      : _.or([{ coachId: _.in(scopedCoachIds) }, { coachOwnerId: _.in(scopedCoachIds) }]);
    const where = _.and([
      coachFilter,
      { status: _.in(["open", "closed"]) },
    ]);
    const slots = await queryScheduleSlots(where, true);
    if (!slots.length) {
      return {
        success: true,
        checkedCount: 0,
        duplicateGroupCount: 0,
        cleanedCount: 0,
        skippedWithBookings: 0,
        failedCount: 0,
      };
    }

    const slotIds = slots.map((item) => String(item && item._id ? item._id : "").trim()).filter(Boolean);
    const { countBySlotId } = await getActiveBookingStatsBySlotIds(slotIds);

    const grouped = {};
    slots.forEach((slot) => {
      const key = buildScheduleSlotFingerprint(slot, true);
      if (!key) {
        return;
      }
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(slot);
    });

    const toCancel = [];
    let duplicateGroupCount = 0;
    let skippedWithBookings = 0;

    Object.keys(grouped).forEach((key) => {
      const list = Array.isArray(grouped[key]) ? grouped[key] : [];
      if (list.length <= 1) {
        return;
      }
      duplicateGroupCount += 1;
      const ranked = list
        .map((slot) => {
          const id = String(slot && slot._id ? slot._id : "").trim();
          const activeBookings = Math.max(0, Number(countBySlotId[id] || 0));
          return {
            slot,
            id,
            activeBookings,
            ts: getDateTimestamp(slot && (slot.updatedAt || slot.createdAt)),
          };
        })
        .sort((a, b) => {
          if (a.activeBookings !== b.activeBookings) {
            return b.activeBookings - a.activeBookings;
          }
          if (a.ts !== b.ts) {
            return b.ts - a.ts;
          }
          return String(b.id || "").localeCompare(String(a.id || ""));
        });

      const keepId = String(ranked[0] && ranked[0].id ? ranked[0].id : "").trim();
      ranked.slice(1).forEach((item) => {
        if (!item.id || item.id === keepId) {
          return;
        }
        if (item.activeBookings > 0) {
          skippedWithBookings += 1;
          return;
        }
        toCancel.push(item.id);
      });
    });

    const updateTargets = Array.from(new Set(toCancel)).filter(Boolean);
    const settled = await Promise.allSettled(updateTargets.map((slotId) =>
      db.collection(SCHEDULE_SLOT_COLLECTION).doc(slotId).update({
        data: {
          status: "cancelled",
          cancelReason: "duplicate_cleanup",
          updatedAt: db.serverDate(),
          duplicateCleanupAt: db.serverDate(),
        },
      })
    ));
    const cleanedCount = settled.filter((item) => item.status === "fulfilled").length;
    const failedCount = settled.length - cleanedCount;

    return {
      success: true,
      checkedCount: slots.length,
      duplicateGroupCount,
      cleanedCount,
      skippedWithBookings,
      failedCount,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "cleanup_duplicate_schedule_slots_failed",
      errMsg: e,
    };
  }
};

const normalizeReportText = (value, maxLength) =>
  String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);

const maskPublisherName = (value) => {
  const raw = String(value || "").replace(/\s+/g, "").trim();
  if (!raw) {
    return "";
  }
  const chars = Array.from(raw);
  return chars[0] || "";
};

const splitPublisherNameAndTag = (value) => {
  const raw = String(value || "").trim();
  const match = raw.match(/(\u52a9\u7406|\u6559\u7ec3|\u7ba1\u7406\u5458|Assistant|Coach|Admin)$/);
  if (!match) {
    return { name: raw, tag: "" };
  }
  const tag = String(match[1] || "");
  return {
    name: raw.slice(0, Math.max(0, raw.length - tag.length)).trim(),
    tag,
  };
};

const resolveScheduleCoachTarget = async (event, user, openid) => {
  const role = normalizeRole(user && user.role);
  const selfId = String(user && user._id ? user._id : "").trim();
  const selfOpenid = String(openid || (user && user.openid) || "").trim();
  const selfName = String((user && (user.name || user.nickName)) || "").trim() || "\u6559\u7ec3";
  const requestedCoachId = String(event && event.coachId ? event.coachId : "").trim();

  if (!selfId) {
    return { errorMessage: "user_not_found" };
  }

  if (role !== "admin") {
    return {
      coachId: selfId,
      coachOwnerId: selfId,
      coachOpenId: selfOpenid,
      coachName: selfName,
    };
  }

  if (!requestedCoachId || requestedCoachId === selfId) {
    return {
      coachId: selfId,
      coachOwnerId: selfId,
      coachOpenId: selfOpenid,
      coachName: selfName,
    };
  }

  const managedCoachIds = await filterCoachIdsByAdminScope(user, [requestedCoachId]);
  if (!managedCoachIds.length) {
    return { errorMessage: "permission_denied" };
  }

  const targetRes = await db.collection(USER_COLLECTION).doc(requestedCoachId).get().catch(() => null);
  const targetCoach = targetRes && targetRes.data ? targetRes.data : null;
  if (!targetCoach || !targetCoach._id) {
    return { errorMessage: "coach_not_found" };
  }

  const targetRole = normalizeRole(targetCoach.role);
  if (targetRole !== "coach" && targetRole !== "admin") {
    return { errorMessage: "target_not_coach" };
  }

  return {
    coachId: requestedCoachId,
    coachOwnerId: requestedCoachId,
    coachOpenId: String(targetCoach.openid || "").trim(),
    coachName: String(targetCoach.name || targetCoach.nickName || "").trim() || "\u6559\u7ec3",
  };
};

const resolvePublisherTag = (user, event) => {
  const role = normalizeRole(user && user.role);
  const levelRaw = String(
    (event && event.publisherLevel)
    || (user && user.level)
    || ""
  ).trim();
  const levelNum = Number(levelRaw);
  if (levelRaw.includes("Assistant") || levelNum === 1 || levelRaw === "1") {
    return "\u52a9\u7406";
  }
  if (role === "admin") {
    return "\u7ba1\u7406\u5458";
  }
  return "\u6559\u7ec3";
};

const formatPublisherDisplayName = (name, fallbackTag) => {
  const parsed = splitPublisherNameAndTag(name);
    const roleTag = parsed.tag || String(fallbackTag || "Coach").trim() || "Coach";
  const baseName = parsed.name || String(name || "").trim();
  if (!baseName) {
    return roleTag;
  }
  const masked = maskPublisherName(baseName);
  return masked ? `${masked}${roleTag}` : roleTag;
};

const buildPublisherNameInfo = (user, event) => {
  const rawName = String(
    (event && event.publisherName)
    || (user && user.name)
    || (user && user.nickName)
    || ""
  ).trim();
  const roleTag = resolvePublisherTag(user, event);
  const displayName = formatPublisherDisplayName(rawName, roleTag);
  return {
    roleTag,
        displayName: displayName || roleTag || "Coach",
  };
};

const buildReportPreview = (content) => {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
};

const getDateTimestamp = (value) => {
  const dateObj = normalizeDateLike(value);
  return dateObj ? dateObj.getTime() : 0;
};

const normalizeStudentFlowerList = (value) => {
  const list = Array.isArray(value) ? value : [];
  return list
  .map((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const studentId = String(safe.studentId || "").trim();
      if (!studentId) {
        return null;
      }
      return {
        studentId,
        studentName: String(safe.studentName || "\u5b66\u5458").trim() || "\u5b66\u5458",
        studentOpenId: String(safe.studentOpenId || "").trim(),
        studentPhone: normalizePhone(safe.studentPhone || ""),
        flowerCount: normalizeFlowerCount(safe.flowerCount),
      };
    })
    .filter(Boolean);
};

const normalizeStudentNameKey = (value) => String(value || "").replace(/\s+/g, "").trim();

const resolveViewerFlowerCount = (flowerList, viewerInfo, options) => {
  const safeOptions = options && typeof options === "object" ? options : {};
  const idOnly = !!safeOptions.idOnly;
  const safeInfo = viewerInfo && typeof viewerInfo === "object"
    ? viewerInfo
    : { studentIds: mergeUniqueIdList(viewerInfo) };
  const studentIds = mergeUniqueIdList(safeInfo.studentIds);
  const studentOpenIds = idOnly ? [] : normalizeOpenIdList(safeInfo.studentOpenIds);
  if (!studentIds.length && !studentOpenIds.length) {
    return 0;
  }
  let matched = flowerList.find((item) => {
    const id = String(item && item.studentId ? item.studentId : "").trim();
    return !!id && studentIds.includes(id);
  });
  if (!matched && studentOpenIds.length) {
    matched = flowerList.find((item) => {
      const openid = String(item && item.studentOpenId ? item.studentOpenId : "").trim();
      return !!openid && studentOpenIds.includes(openid);
    });
  }
  return matched ? normalizeFlowerCount(matched.flowerCount) : 0;
};

const mapTrainingReport = (item, options) => {
  const safeOptions = options && typeof options === "object" ? options : {};
  const includeContent = !!safeOptions.includeContent;
  const includeFlowerList = !!safeOptions.includeFlowerList;
  const viewerMatchByStudentIdOnly = !!safeOptions.viewerMatchByStudentIdOnly;
  const viewerStudentIds = mergeUniqueIdList(safeOptions.viewerStudentIds, safeOptions.viewerStudentId);
  const viewerStudentOpenIds = normalizeOpenIdList(safeOptions.viewerStudentOpenIds);
  const viewerStudentPhones = normalizeIdList(safeOptions.viewerStudentPhones)
    .map((item) => normalizePhone(item))
    .filter(Boolean);
  const viewerStudentNames = normalizeIdList(safeOptions.viewerStudentNames);

  const safe = item && typeof item === "object" ? item : {};
  const coachRoleTag = String(safe.coachRoleTag || "Coach").trim();
  const coachName = formatPublisherDisplayName(
    String(safe.coachName || "").trim(),
    coachRoleTag || "Coach"
  );

  const studentFlowerList = normalizeStudentFlowerList(safe.studentFlowerList);
  const totalFlowerCount = hasOwn(safe, "totalFlowerCount")
    ? Math.max(0, Math.round(resolveNumber(safe.totalFlowerCount) * 10) / 10)
    : sumFlowerCount(studentFlowerList);

  return {
    id: safe._id || "",
        title: safe.title || "Training Summary",
    content: includeContent ? String(safe.content || "") : "",
    contentPreview: buildReportPreview(safe.content),
    coachId: String(safe.coachId || "").trim(),
    coachName: coachName || "Coach",
    coachRoleTag,
    studentCount: resolveNumber(safe.studentCount),
    totalFlowerCount,
    studentFlowerCount: resolveViewerFlowerCount(studentFlowerList, {
      studentIds: viewerStudentIds,
      studentOpenIds: viewerStudentOpenIds,
      studentPhones: viewerStudentPhones,
      studentNames: viewerStudentNames,
    }, {
      idOnly: viewerMatchByStudentIdOnly,
    }),
    studentFlowerList: includeFlowerList ? studentFlowerList : [],
    status: String(safe.status || "published"),
    createdAt: safe.createdAt || safe.updatedAt || null,
    updatedAt: safe.updatedAt || safe.createdAt || null,
  };
};

const TRAINING_REPORT_DURATION_FIELDS = [
  "duration",
  "trainingDuration",
  "lessonDuration",
  "classDuration",
];

const stripTrainingReportDurationFields = (report) => {
  const safe = report && typeof report === "object" ? { ...report } : {};
  TRAINING_REPORT_DURATION_FIELDS.forEach((field) => {
    if (hasOwn(safe, field)) {
      delete safe[field];
    }
  });
  return safe;
};

const cleanupTrainingReportDurationFields = async (reportId, report) => {
  const hasLegacyDurationField = TRAINING_REPORT_DURATION_FIELDS.some((field) => hasOwn(report, field));
  if (!reportId || !hasLegacyDurationField) {
    return;
  }
  const removeData = {};
  TRAINING_REPORT_DURATION_FIELDS.forEach((field) => {
    removeData[field] = db.command.remove();
  });
  await db.collection(TRAINING_REPORT_COLLECTION).doc(reportId).update({
    data: removeData,
  }).catch(() => null);
};

const resolveViewerFlowerCountFromReport = (report, viewerContext) => {
  const idOnly = !!(viewerContext && viewerContext.idOnly);
  const mapped = mapTrainingReport(report, {
    includeContent: false,
    includeFlowerList: false,
    viewerStudentIds: viewerContext.studentIds,
    viewerStudentOpenIds: viewerContext.studentOpenIds,
    viewerStudentPhones: viewerContext.studentPhones,
    viewerStudentNames: viewerContext.studentNames,
    viewerMatchByStudentIdOnly: idOnly,
  });
  return normalizeFlowerCount(mapped.studentFlowerCount);
};

const sumViewerFlowersFromReports = (reports, viewerContext, options) => {
  const safeOptions = options && typeof options === "object" ? options : {};
  const minCreatedAtTs = Number.isFinite(Number(safeOptions.minCreatedAtTs))
    ? Number(safeOptions.minCreatedAtTs)
    : 0;
  const list = Array.isArray(reports) ? reports : [];
  return Math.round(list.reduce((sum, item) => {
    if (String(item && item.status ? item.status : "").trim() !== "published") {
      return sum;
    }
    if (minCreatedAtTs > 0) {
      const reportTs = getDateTimestamp(item && (item.createdAt || item.updatedAt));
      if (reportTs > 0 && reportTs < minCreatedAtTs) {
        return sum;
      }
    }
    return sum + resolveViewerFlowerCountFromReport(item, viewerContext);
  }, 0) * 10) / 10;
};

const sumViewerFlowersFromNotifications = async (userIds, openids, options) => {
  const safeOptions = options && typeof options === "object" ? options : {};
  const idOnly = !!safeOptions.idOnly;
  const minCreatedAtTs = Number.isFinite(Number(safeOptions.minCreatedAtTs))
    ? Number(safeOptions.minCreatedAtTs)
    : 0;
  const idList = mergeUniqueIdList(userIds);
  const openidList = idOnly ? [] : normalizeOpenIdList(openids);
  const _ = db.command;
  const whereList = [];
  if (idList.length === 1) {
    whereList.push({ receiverUserId: idList[0] });
  } else if (idList.length > 1) {
    whereList.push({ receiverUserId: _.in(idList) });
  }
  if (openidList.length === 1) {
    whereList.push({ receiverOpenId: openidList[0] });
  } else if (openidList.length > 1) {
    whereList.push({ receiverOpenId: _.in(openidList) });
  }
  if (!whereList.length) {
    return 0;
  }
  const receiverFilter = whereList.length > 1 ? _.or(whereList) : whereList[0];
  const where = _.and([
    receiverFilter,
    { type: "training_report" },
  ]);
  const res = await db.collection(NOTIFICATION_COLLECTION)
    .where(where)
    .limit(500)
    .get()
    .catch(() => ({ data: [] }));
  const list = res && Array.isArray(res.data) ? res.data : [];
  const reportFlowerMap = {};
  let looseTotal = 0;
  list.forEach((item) => {
    if (minCreatedAtTs > 0) {
      const notifyTs = getDateTimestamp(item && (item.createdAt || item.updatedAt));
      if (notifyTs > 0 && notifyTs < minCreatedAtTs) {
        return;
      }
    }
    const extra = item && typeof item.extra === "object" ? item.extra : {};
    const value = normalizeFlowerCount(extra.flowerCount);
    if (value <= 0) {
      return;
    }
    const reportId = String(item && item.relatedId ? item.relatedId : "").trim();
    if (!reportId) {
      looseTotal += value;
      return;
    }
    reportFlowerMap[reportId] = Math.max(Number(reportFlowerMap[reportId] || 0), value);
  });
  const reportTotal = Object.keys(reportFlowerMap).reduce((sum, key) => {
    return sum + normalizeFlowerCount(reportFlowerMap[key]);
  }, 0);
  const total = looseTotal + reportTotal;
  return Math.round(total * 10) / 10;
};

const queryTrainingReportNotificationFlowerMap = async (userIds, openids, options) => {
  const safeOptions = options && typeof options === "object" ? options : {};
  const idOnly = !!safeOptions.idOnly;
  const minCreatedAtTs = Number.isFinite(Number(safeOptions.minCreatedAtTs))
    ? Number(safeOptions.minCreatedAtTs)
    : 0;
  const idList = mergeUniqueIdList(userIds);
  const openidList = idOnly ? [] : normalizeOpenIdList(openids);
  const _ = db.command;
  const whereList = [];
  if (idList.length === 1) {
    whereList.push({ receiverUserId: idList[0] });
  } else if (idList.length > 1) {
    whereList.push({ receiverUserId: _.in(idList) });
  }
  if (openidList.length === 1) {
    whereList.push({ receiverOpenId: openidList[0] });
  } else if (openidList.length > 1) {
    whereList.push({ receiverOpenId: _.in(openidList) });
  }
  if (!whereList.length) {
    return {};
  }
  const receiverFilter = whereList.length > 1 ? _.or(whereList) : whereList[0];
  const where = _.and([
    receiverFilter,
    { type: "training_report" },
  ]);
  const res = await db.collection(NOTIFICATION_COLLECTION)
    .where(where)
    .limit(500)
    .get()
    .catch(() => ({ data: [] }));
  const list = res && Array.isArray(res.data) ? res.data : [];
  const map = {};
  list.forEach((item) => {
    if (minCreatedAtTs > 0) {
      const notifyTs = getDateTimestamp(item && (item.createdAt || item.updatedAt));
      if (notifyTs > 0 && notifyTs < minCreatedAtTs) {
        return;
      }
    }
    const reportId = String(item && item.relatedId ? item.relatedId : "").trim();
    if (!reportId) {
      return;
    }
    const extra = item && typeof item.extra === "object" ? item.extra : {};
    const flowerCount = normalizeFlowerCount(extra.flowerCount);
    if (flowerCount <= 0) {
      return;
    }
    map[reportId] = Math.max(Number(map[reportId] || 0), flowerCount);
  });
  return map;
};

const queryUsersByIds = async (ids) => {
  const idList = mergeUniqueIdList(ids);
  if (!idList.length) {
    return [];
  }
  const taskList = idList.map((id) => db.collection(USER_COLLECTION).doc(id).get().catch(() => null));
  const resList = await Promise.all(taskList);
  return resList
    .map((res) => (res && res.data ? res.data : null))
    .filter(Boolean);
};

const queryUsersByIdentityKeys = async (ids) => {
  const keyList = mergeUniqueIdList(ids);
  if (!keyList.length) {
    return [];
  }
  const _ = db.command;
  const chunks = splitIdList(keyList, 30);
  const taskList = chunks.map((chunk) => {
    const chunkKeys = mergeUniqueIdList(chunk);
    const phoneKeys = chunkKeys
      .map((item) => normalizePhone(item))
      .filter((item) => isValidPhone(item));
    const conditionList = [
      { openid: _.in(chunkKeys) },
      { _openid: _.in(chunkKeys) },
    ];
    if (phoneKeys.length) {
      conditionList.push({ phone: _.in(phoneKeys) });
    }
    return db.collection(USER_COLLECTION).where(_.or(conditionList)).limit(1000).get().catch(() => ({ data: [] }));
  });
  const resList = await Promise.all(taskList);
  const dedupMap = {};
  const list = [];
  resList.forEach((res) => {
    const rows = Array.isArray(res && res.data) ? res.data : [];
    rows.forEach((item) => {
      const id = String(item && item._id ? item._id : "").trim();
      const key = id || `open:${String(item && (item.openid || item._openid) ? (item.openid || item._openid) : "").trim()}`;
      if (!key || dedupMap[key]) {
        return;
      }
      dedupMap[key] = true;
      list.push(item);
    });
  });
  return list;
};

const resolveUserIdentityKeys = async (ids) => {
  const baseIds = mergeUniqueIdList(ids);
  if (!baseIds.length) {
    return [];
  }
  const usersById = await queryUsersByIds(baseIds).catch(() => []);
  const usersByIdentity = await queryUsersByIdentityKeys(baseIds).catch(() => []);
  const users = mergeUniqueIdList(
    usersById.map((item) => String(item && item._id ? item._id : "").trim()),
    usersByIdentity.map((item) => String(item && item._id ? item._id : "").trim())
  ).map((userId) => {
    const byId = usersById.find((item) => String(item && item._id ? item._id : "").trim() === userId)
      || usersByIdentity.find((item) => String(item && item._id ? item._id : "").trim() === userId);
    return byId || null;
  }).filter(Boolean);
  const openIds = users.map((item) => String(item && (item.openid || item._openid) ? (item.openid || item._openid) : "").trim());
  const phones = users.map((item) => normalizePhone(item && item.phone ? item.phone : ""));
  const linkedCoachIds = users.reduce((acc, item) => {
    const ids = extractUserCoachIds(item, null);
    return acc.concat(Array.isArray(ids) ? ids : []);
  }, []);
  const linkedOwnerIds = users.reduce((acc, item) => {
    const ids = extractUserAdminOwnerIds(item, null);
    return acc.concat(Array.isArray(ids) ? ids : []);
  }, []);
  return mergeUniqueIdList(baseIds, openIds, phones, linkedCoachIds, linkedOwnerIds);
};

const queryTrainingReports = async (where) => {
  const query = db.collection(TRAINING_REPORT_COLLECTION).where(where).limit(TRAINING_REPORT_FETCH_LIMIT);

  try {
    const orderedRes = await query.orderBy("createdAt", "desc").get();
    return orderedRes && orderedRes.data ? orderedRes.data : [];
  } catch (e) {
    const res = await query.get().catch(() => ({ data: [] }));
    const list = res && res.data ? res.data : [];
    return list.sort(
      (a, b) => getDateTimestamp(b.createdAt || b.updatedAt) - getDateTimestamp(a.createdAt || a.updatedAt)
    );
  }
};

const queryStudentsByCoachIds = async (coachIds) => {
  const ids = Array.from(new Set((Array.isArray(coachIds) ? coachIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  const keys = mergeUniqueIdList(ids);
  if (!keys.length) {
    return [];
  }

  const _ = db.command;
  const where = _.or([
    { coachId: _.in(keys) },
    { coachID: _.in(keys) },
    { coachIds: _.in(keys) },
    { coachIDs: _.in(keys) },
    { coachids: _.in(keys) },
    { coachOwnerId: _.in(keys) },
    { coachOwnerID: _.in(keys) },
    { coachOwnerIds: _.in(keys) },
    { coachOwnerIDs: _.in(keys) },
    { coachOpenId: _.in(keys) },
    { coachOpenID: _.in(keys) },
    { coachOpenIds: _.in(keys) },
    { coachOpenIDs: _.in(keys) },
  ]);
  const res = await db.collection(USER_COLLECTION).where(where).limit(1000).get().catch(() => ({ data: [] }));
  const list = res && Array.isArray(res.data) ? res.data : [];
  return list.filter((item) => {
    const roleText = normalizeRole(item && item.role);
    return roleText !== "coach" && roleText !== "admin";
  });
};

const queryStudentsByAdminOwnerIds = async (adminOwnerIds) => {
  const ids = mergeUniqueIdList(adminOwnerIds);
  const keys = mergeUniqueIdList(ids);
  if (!keys.length) {
    return [];
  }
  const _ = db.command;
  const where = _.or([
    { [ADMIN_OWNER_ID_FIELD]: _.in(keys) },
    { adminOwnerID: _.in(keys) },
    { [ADMIN_OWNER_IDS_FIELD]: _.in(keys) },
    { adminOwnerIDs: _.in(keys) },
    { ownerId: _.in(keys) },
    { ownerID: _.in(keys) },
    { ownerIds: _.in(keys) },
    { ownerIDs: _.in(keys) },
  ]);
  const res = await db.collection(USER_COLLECTION).where(where).limit(1000).get().catch(() => ({ data: [] }));
  const list = res && Array.isArray(res.data) ? res.data : [];
  return list.filter((item) => {
    const roleText = normalizeRole(item && item.role);
    return roleText !== "coach" && roleText !== "admin";
  });
};

const backfillStudentsCoachIdsByAdminOwners = async (coachId, adminOwnerIds) => {
  const targetCoachId = String(coachId || "").trim();
  const ownerIds = mergeUniqueIdList(adminOwnerIds);
  if (!targetCoachId || !ownerIds.length) {
    return { success: true, patchedCount: 0 };
  }

  const students = await queryStudentsByAdminOwnerIds(ownerIds).catch(() => []);
  if (!Array.isArray(students) || !students.length) {
    return { success: true, patchedCount: 0 };
  }

  const patchTasks = [];
  students.forEach((student) => {
    const studentId = String(student && student._id ? student._id : "").trim();
    if (!studentId) {
      return;
    }
    const currentCoachIds = mergeUniqueIdList(extractUserCoachIds(student, null));
    const nextCoachIds = mergeUniqueIdList(currentCoachIds, targetCoachId);
    const sameLength = currentCoachIds.length === nextCoachIds.length;
    const sameMembers = sameLength && currentCoachIds.every((id) => nextCoachIds.includes(id));
    if (sameMembers) {
      return;
    }
    const currentCoachId = String(student && student.coachId ? student.coachId : "").trim();
    const patch = {
      coachIds: nextCoachIds,
      updatedAt: db.serverDate(),
    };
    if (!currentCoachId) {
      patch.coachId = targetCoachId;
    }
    patchTasks.push(
      db.collection(USER_COLLECTION).doc(studentId).update({ data: patch }).catch(() => null)
    );
  });

  if (!patchTasks.length) {
    return { success: true, patchedCount: 0 };
  }
  const res = await Promise.all(patchTasks);
  const patchedCount = Array.isArray(res) ? res.filter(Boolean).length : 0;
  return { success: true, patchedCount };
};

const queryBookedCoachIdsByStudent = async (studentUser, event) => {
  const safeUser = studentUser && typeof studentUser === "object" ? studentUser : {};
  const safeEvent = event && typeof event === "object" ? event : {};
  const identityKeys = await resolveUserIdentityKeys(
    mergeUniqueIdList(
      String(safeUser._id || "").trim(),
      String(safeUser.openid || safeUser._openid || "").trim(),
      normalizePhone(safeUser.phone || ""),
      String(safeEvent.userId || "").trim(),
      String(safeEvent.studentId || "").trim()
    )
  );
  if (!identityKeys.length) {
    return [];
  }
  const _ = db.command;
  const where = _.or([
    { studentId: _.in(identityKeys) },
    { studentOpenId: _.in(identityKeys) },
  ]);
  const res = await db.collection(SCHEDULE_BOOKING_COLLECTION)
    .where(where)
    .limit(1000)
    .get()
    .catch(() => ({ data: [] }));
  const list = Array.isArray(res && res.data) ? res.data : [];
  return mergeUniqueIdList(
    list.map((item) => String(item && item.coachId ? item.coachId : "").trim()),
    list.map((item) => String(item && item.coachOwnerId ? item.coachOwnerId : "").trim())
  );
};

const queryNotifiedCoachIdsByStudent = async (studentUser, event) => {
  const safeUser = studentUser && typeof studentUser === "object" ? studentUser : {};
  const studentContext = await resolveStudentViewContext(safeUser, {
    ...(event && typeof event === "object" ? event : {}),
    strictIdentity: false,
  }).catch(() => null);
  const receiverFilter = studentContext
    ? buildNotificationReceiverFilterByIdentities(
      studentContext.studentIds,
      studentContext.studentOpenIds
    )
    : buildNotificationReceiverFilter(
      String(safeUser._id || "").trim(),
      String(safeUser.openid || safeUser._openid || "").trim()
    );
  if (!receiverFilter) {
    return [];
  }
  const _ = db.command;
  const where = _.and([
    receiverFilter,
    { type: "schedule_slot_published" },
  ]);
  const res = await db.collection(NOTIFICATION_COLLECTION)
    .where(where)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get()
    .catch(() => ({ data: [] }));
  const list = Array.isArray(res && res.data) ? res.data : [];
  if (!list.length) {
    return [];
  }

  const explicitCoachIds = mergeUniqueIdList(
    list.map((item) => String(item && item.extra && item.extra.coachId ? item.extra.coachId : "").trim()),
    list.map((item) => String(item && item.extra && item.extra.coachOwnerId ? item.extra.coachOwnerId : "").trim())
  );
  const senderIds = mergeUniqueIdList(
    list.map((item) => String(item && item.senderUserId ? item.senderUserId : "").trim())
  );
  const candidateCoachIds = mergeUniqueIdList(explicitCoachIds, senderIds);
  if (!candidateCoachIds.length) {
    return [];
  }
  const users = await queryUsersByIds(candidateCoachIds).catch(() => []);
  const validCoachIds = users
    .filter((item) => {
      const role = normalizeRole(item && item.role);
      return role === "coach" || role === "admin";
    })
    .map((item) => String(item && item._id ? item._id : "").trim())
    .filter(Boolean);
  return mergeUniqueIdList(explicitCoachIds, validCoachIds);
};

const resolveStudentSharedCoachIdsForSchedule = async (studentUser, event) => {
  const studentContext = await resolveStudentViewContext(studentUser, {
    ...(event && typeof event === "object" ? event : {}),
    strictIdentity: false,
  }).catch(() => null);
  const directCoachIds = mergeUniqueIdList(
    extractUserCoachIds(studentUser, event),
    studentContext && studentContext.coachIds
  );
  const ownerIds = extractUserAdminOwnerIds(studentUser, event);
  const [bookedCoachIds, notifiedCoachIds] = await Promise.all([
    queryBookedCoachIdsByStudent(studentUser, event).catch(() => []),
    queryNotifiedCoachIdsByStudent(studentUser, event).catch(() => []),
  ]);
  if (!ownerIds.length) {
    return mergeUniqueIdList(directCoachIds, bookedCoachIds, notifiedCoachIds);
  }
  const peerCoaches = await queryCoachUsersByAdminOwnerIds(ownerIds);
  const peerCoachIds = peerCoaches
    .map((item) => String(item && item._id ? item._id : "").trim())
    .filter(Boolean);
  if (!peerCoachIds.length) {
    return mergeUniqueIdList(directCoachIds, bookedCoachIds, notifiedCoachIds);
  }
  const peerSet = new Set(peerCoachIds);
  const pickInPeerScope = (ids) => mergeUniqueIdList(ids).filter((id) => peerSet.has(String(id || "").trim()));
  const directScoped = pickInPeerScope(directCoachIds);
  const bookedScoped = pickInPeerScope(bookedCoachIds);
  const notifiedScoped = pickInPeerScope(notifiedCoachIds);
  return mergeUniqueIdList(peerCoachIds, directScoped, bookedScoped, notifiedScoped);
};

const queryTrainingReportsByCoachIds = async (coachIds) => {
  const ids = Array.from(new Set((Array.isArray(coachIds) ? coachIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length) {
    return [];
  }
  const _ = db.command;
  const where = _.or([
    { coachId: _.in(ids) },
    { coachOwnerId: _.in(ids) },
  ]);
  return queryTrainingReports(where);
};

const hasReportCoachPermissionForStudent = (studentCoachIds, reportCoachId, reportCoachOwnerId) => {
  const ids = Array.from(new Set((Array.isArray(studentCoachIds) ? studentCoachIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length) {
    return false;
  }
  const reportIds = [String(reportCoachId || "").trim(), String(reportCoachOwnerId || "").trim()].filter(Boolean);
  if (!reportIds.length) {
    return false;
  }
  return reportIds.some((id) => ids.includes(id));
};

const resolveStudentViewContext = async (user, event) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const safeEvent = event && typeof event === "object" ? event : {};
  const strictIdentity = !!(safeEvent.strictIdentity || safeEvent.strictFlowerIdentity);
  const baseId = String(safeUser._id || "").trim();
  const baseOpenId = String(safeUser.openid || safeUser._openid || "").trim();
  const basePhone = normalizePhone(safeUser.phone || "");
  const eventUserId = String(
    safeEvent.userId || safeEvent.studentId || safeEvent.targetStudentId || ""
  ).trim();

  const studentIds = new Set(mergeUniqueIdList(baseId, strictIdentity ? "" : eventUserId));
  const studentOpenIds = new Set(normalizeOpenIdList([baseOpenId]));
  const studentPhones = new Set();
  const studentNames = new Set();
  if (!strictIdentity) {
    normalizeIdList([basePhone]).map((item) => normalizePhone(item)).filter(Boolean).forEach((item) => {
      studentPhones.add(item);
    });
    normalizeIdList([
      String(safeUser.name || "").trim(),
      String(safeUser.nickName || "").trim(),
      String(safeEvent.studentName || "").trim(),
    ])
      .map((item) => normalizeStudentNameKey(item))
      .filter(Boolean)
      .forEach((item) => {
        studentNames.add(item);
      });
  }
  const coachIds = new Set(extractUserCoachIds(safeUser, safeEvent));

  if (eventUserId && !strictIdentity) {
    const eventUserList = await queryUsersByIds([eventUserId]);
    eventUserList.forEach((item) => {
      const roleText = normalizeRole(item && item.role);
      if (roleText === "coach" || roleText === "admin") {
        return;
      }
      const id = String(item && item._id ? item._id : "").trim();
      const openid = String((item && (item.openid || item._openid)) ? (item.openid || item._openid) : "").trim();
      const phone = normalizePhone(item && item.phone ? item.phone : "");
      const nameKey = normalizeStudentNameKey(
        String((item && (item.name || item.nickName)) || "").trim()
      );
      if (id) {
        studentIds.add(id);
      }
      if (openid) {
        studentOpenIds.add(openid);
      }
      if (phone) {
        studentPhones.add(phone);
      }
      if (nameKey) {
        studentNames.add(nameKey);
      }
      extractUserCoachIds(item, null).forEach((coachId) => {
        if (coachId) {
          coachIds.add(coachId);
        }
      });
    });
  }

  const _ = db.command;
  const whereList = [];
  if (baseOpenId) {
    whereList.push({ openid: baseOpenId });
  }
  if (isValidPhone(basePhone)) {
    whereList.push({ phone: basePhone });
  }
  if (!strictIdentity && whereList.length) {
    if (baseOpenId) {
      whereList.push({ _openid: baseOpenId });
    }
    const where = whereList.length > 1 ? _.or(whereList) : whereList[0];
    const aliasRes = await db.collection(USER_COLLECTION).where(where).limit(50).get().catch(() => ({ data: [] }));
    const aliasList = aliasRes && Array.isArray(aliasRes.data) ? aliasRes.data : [];
    aliasList.forEach((item) => {
      const aliasRole = normalizeRole(item && item.role);
      if (aliasRole === "coach" || aliasRole === "admin") {
        return;
      }
      const id = String(item && item._id ? item._id : "").trim();
      const openid = String((item && (item.openid || item._openid)) ? (item.openid || item._openid) : "").trim();
      const phone = normalizePhone(item && item.phone ? item.phone : "");
      if (id) {
        studentIds.add(id);
      }
      if (openid) {
        studentOpenIds.add(openid);
      }
      if (phone) {
        studentPhones.add(phone);
      }
      const nameKey = normalizeStudentNameKey(
        String((item && (item.name || item.nickName)) || "").trim()
      );
      if (nameKey) {
        studentNames.add(nameKey);
      }
      extractUserCoachIds(item, null).forEach((coachId) => {
        if (coachId) {
          coachIds.add(coachId);
        }
      });
    });
  }

  return {
    studentIds: Array.from(studentIds),
    studentOpenIds: Array.from(studentOpenIds),
    studentPhones: Array.from(studentPhones),
    studentNames: Array.from(studentNames),
    coachIds: Array.from(coachIds),
  };
};

const publishTrainingReport = async (event) => {
  try {
    const { user, openid } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const coachId = String(user._id || "").trim();
    const legacyCoachId = String(event && event.coachId ? event.coachId : "").trim();
    const coachOpenId = String(openid || user.openid || user._openid || "").trim();
    const publisherInfo = buildPublisherNameInfo(user, event);
    const coachName = publisherInfo.displayName;
    const coachRoleTag = publisherInfo.roleTag;
        const title = normalizeReportText(event && event.title, 40) || "Training Summary";
    const content = normalizeReportText(event && event.content, 3000);

    if (!content || content.length < 2) {
      return { success: false, message: "report_content_required" };
    }

    // Coach account should only operate on its own students.
    // Avoid mixing legacy student coachId/coachIds or phone aliases.
    const coachIdCandidates = role === "admin"
      ? mergeUniqueIdList(
        coachId,
        legacyCoachId,
        normalizeIdList(event && event.coachIds),
        normalizeIdList(user && user.coachIds),
        user && user.coachId
      )
      : mergeUniqueIdList(coachId);
    const students = await queryStudentsByCoachIds(coachIdCandidates);
    const countMap = {};
    coachIdCandidates.forEach((id) => {
      countMap[id] = 0;
    });
    students.forEach((item) => {
      const itemCoachId = String(item && item.coachId ? item.coachId : "").trim();
      if (itemCoachId && hasOwn(countMap, itemCoachId)) {
        countMap[itemCoachId] = Number(countMap[itemCoachId] || 0) + 1;
      }
    });
    let effectiveCoachId = String(coachId || "").trim();
    let maxCount = Number(countMap[effectiveCoachId] || 0);
    coachIdCandidates.forEach((id) => {
      const count = Number(countMap[id] || 0);
      if (!effectiveCoachId || count > maxCount) {
        effectiveCoachId = id;
        maxCount = count;
      }
    });

    const rawStudentFlowers = Array.isArray(event && event.studentFlowers) ? event.studentFlowers : [];
    const inputFlowerMap = {};
    const inputStudentNameMap = {};
    rawStudentFlowers.forEach((item) => {
      const safe = item && typeof item === "object" ? item : {};
      const studentId = String(safe.studentId || "").trim();
      if (!studentId) {
        return;
      }
      inputFlowerMap[studentId] = normalizeFlowerCount(safe.flowerCount);
      const studentName = String(safe.studentName || "").trim();
      if (studentName) {
        inputStudentNameMap[studentId] = studentName;
      }
    });
    const inputStudentIds = Object.keys(inputFlowerMap);

    const profileMap = {};
    students.forEach((student) => {
      const studentId = String(student && student._id ? student._id : "").trim();
      if (studentId) {
        profileMap[studentId] = student;
      }
    });
    const userByInputIds = await queryUsersByIds(inputStudentIds);
    userByInputIds.forEach((student) => {
      const studentId = String(student && student._id ? student._id : "").trim();
      if (studentId) {
        profileMap[studentId] = student;
      }
    });

    const finalStudentIds = inputStudentIds.length
      ? inputStudentIds
      : students
        .map((student) => String(student && student._id ? student._id : "").trim())
        .filter(Boolean);
    const completedLessonCountMap = await countCompletedLessonsByStudentIds(finalStudentIds, coachIdCandidates);
    const invalidStudents = [];

    const studentFlowerList = finalStudentIds.map((studentId) => {
      const student = profileMap[studentId] || {};
      const studentName = String(
        inputStudentNameMap[studentId]
        || student.name
        || student.nickName
        || "\u5b66\u5458"
      ).trim() || "\u5b66\u5458";
      const requestedFlowerCount = normalizeFlowerCount(inputFlowerMap[studentId]);
      const completedLessonCount = Math.max(0, Number(completedLessonCountMap[studentId] || 0));
      const eligibility = resolveFlowerEligibilityByStudent(student, completedLessonCount);
      const canReceiveFlower = eligibility.canReceiveFlower;
      if (!canReceiveFlower && requestedFlowerCount > 0) {
        invalidStudents.push({
          studentId,
          studentName,
          requestedFlowerCount,
          reason: eligibility.reason,
        });
      }
      return {
        studentId,
        studentName,
        studentOpenId: String(
          (student && (student.openid || student._openid)) ? (student.openid || student._openid) : ""
        ).trim(),
        studentPhone: normalizePhone(student && student.phone ? student.phone : ""),
        flowerCount: canReceiveFlower ? requestedFlowerCount : 0,
      };
    }).filter(Boolean);
    if (invalidStudents.length) {
      return {
        success: false,
        message: "flower_requires_completed_lesson",
        invalidStudents,
      };
    }
    const totalFlowerCount = sumFlowerCount(studentFlowerList);

    const addRes = await db.collection(TRAINING_REPORT_COLLECTION).add({
      data: {
        title,
        content,
        coachId: effectiveCoachId,
        coachOwnerId: coachId,
        coachOpenId,
        coachName,
        coachRoleTag,
        receiverScope: "coach_students",
        status: "published",
        studentCount: studentFlowerList.length,
        totalFlowerCount,
        studentFlowerList,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    const reportId = addRes && addRes._id ? addRes._id : "";
    if (!reportId) {
      return { success: false, message: "report_create_failed" };
    }

    const notifyTitle = "\u8bad\u7ec3\u62a5\u544a";
    const notifyContentBase = `${coachName} \u53d1\u5e03\u4e86\u8bad\u7ec3\u62a5\u544a\uff1a${title}`;
    const notifyPath = `/pages/student/report/detail/detail?id=${reportId}`;
    const notifyTasks = studentFlowerList
      .map((flowerInfo) => {
        const studentId = String(flowerInfo && flowerInfo.studentId ? flowerInfo.studentId : "").trim();
        const student = profileMap[studentId] || {};
        const receiverUserId = String(student && student._id ? student._id : studentId).trim();
        const receiverOpenId = String(
          (student && (student.openid || student._openid)) ? (student.openid || student._openid) : ""
        ).trim();
        if (!receiverUserId && !receiverOpenId) {
          return null;
        }
        const flowerCount = normalizeFlowerCount(flowerInfo && flowerInfo.flowerCount);
        const notifyContent = flowerCount > 0
          ? `${notifyContentBase}\uFF0C\u5E76\u8D60\u9001\u4E86 ${flowerCount} \u6735\u5C0F\u7EA2\u82B1`
          : notifyContentBase;
        return createNotification({
          receiverUserId,
          receiverOpenId,
          senderUserId: coachId,
          senderOpenId: coachOpenId,
          senderName: coachName,
          type: "training_report",
          title: notifyTitle,
          content: notifyContent,
          relatedId: reportId,
          relatedType: "training_report",
          relatedPath: notifyPath,
          extra: {
            coachId: effectiveCoachId,
            coachOwnerId: coachId,
            coachName,
            coachRoleTag,
            flowerCount,
          },
        }).catch(() => null);
      })
      .filter(Boolean);

    if (notifyTasks.length) {
      await Promise.allSettled(notifyTasks);
    }

    return {
      success: true,
      reportId,
      studentCount: studentFlowerList.length,
      totalFlowerCount,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "publish_training_report_failed",
      errMsg: e,
    };
  }
};

const mapCoachSharedStudent = (item) => {
  const safe = item && typeof item === "object" ? item : {};
  const id = String((safe._id || safe.id || safe.openid || safe._openid) || "").trim();
  return {
    id,
    _id: id,
    name: String(safe.name || safe.nickName || "Student").trim() || "Student",
    nickName: String(safe.nickName || safe.name || "").trim(),
    phone: normalizePhone(safe.phone || ""),
    avatarUrl: String(safe.avatarUrl || "").trim(),
    status: String(safe.status || "active").trim() || "active",
    role: normalizeRole(safe.role),
    coachId: String(safe.coachId || "").trim(),
    coachIds: mergeUniqueIdList(
      normalizeIdList(safe.coachIds),
      normalizeIdList(safe.coachIDs),
      normalizeIdList(safe.coachids),
      safe.coachId,
      safe.coachID,
      safe.coachid
    ),
    lessonTotal: toNonNegativeInt(safe[LESSON_TOTAL_FIELD]),
    lessonRemaining: toNonNegativeInt(
      typeof safe[LESSON_REMAINING_FIELD] === "undefined"
        ? safe[LESSON_TOTAL_FIELD]
        : safe[LESSON_REMAINING_FIELD]
    ),
    lessonUsed: toNonNegativeInt(
      typeof safe[LESSON_USED_FIELD] === "undefined"
        ? Math.max(0, toNonNegativeInt(safe[LESSON_TOTAL_FIELD]) - toNonNegativeInt(safe[LESSON_REMAINING_FIELD]))
        : safe[LESSON_USED_FIELD]
    ),
    studentSince: safe.studentSince || "",
    updatedAt: safe.updatedAt || safe.roleUpdatedAt || safe.createdAt || null,
    createdAt: safe.createdAt || null,
  };
};

const listCoachSharedStudents = async (event) => {
  try {
    const { user } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "coach_or_admin",
    });
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", students: [] };
    }
    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied", students: [] };
    }

    let scopedCoachIds = [];
    if (role === "admin") {
      const eventCoachIds = mergeUniqueIdList(
        normalizeIdList(event && event.coachIds),
        normalizeIdList(event && event.coachIDs),
        event && event.coachId,
        event && event.coachID
      );
      scopedCoachIds = eventCoachIds.length
        ? await filterCoachIdsByAdminScope(user, eventCoachIds)
        : await queryManagedCoachIdsByAdmin(user);
      scopedCoachIds = mergeUniqueIdList(scopedCoachIds, String(user._id || "").trim());
    } else {
      scopedCoachIds = await queryPeerCoachIdsByCoach(user);
    }

    const scopedOwnerIds = role === "admin"
      ? mergeUniqueIdList(String(user._id || "").trim(), extractUserAdminOwnerIds(user, event))
      : extractUserAdminOwnerIds(user, event);

    const [studentsByCoach, studentsByOwner] = await Promise.all([
      scopedCoachIds.length ? queryStudentsByCoachIds(scopedCoachIds).catch(() => []) : Promise.resolve([]),
      scopedOwnerIds.length ? queryStudentsByAdminOwnerIds(scopedOwnerIds).catch(() => []) : Promise.resolve([]),
    ]);

    const merged = [].concat(studentsByCoach || [], studentsByOwner || []);
    const dedup = {};
    merged.forEach((item) => {
      const id = String((item && (item._id || item.id || item.openid || item._openid)) || "").trim();
      if (!id || dedup[id]) {
        return;
      }
      const itemRole = normalizeRole(item && item.role);
      if (itemRole === "coach" || itemRole === "admin") {
        return;
      }
      dedup[id] = mapCoachSharedStudent(item);
    });

    const students = Object.keys(dedup)
      .map((id) => dedup[id])
      .sort((a, b) => {
        const aTs = getDateTimestamp(a && (a.updatedAt || a.createdAt));
        const bTs = getDateTimestamp(b && (b.updatedAt || b.createdAt));
        return bTs - aTs;
      });

    return {
      success: true,
      students,
      coachIds: scopedCoachIds,
      adminOwnerIds: scopedOwnerIds,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coach_shared_students_failed",
      students: [],
      errMsg: e,
    };
  }
};

const listCoachReportStudents = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", students: [], effectiveCoachId: "" };
    }

    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied", students: [], effectiveCoachId: "" };
    }

    const coachOwnerId = String(user._id || "").trim();
    const idSet = new Set();
    const eventCoachId = String(event && event.coachId ? event.coachId : "").trim();
    const eventCoachIds = normalizeIdList(event && event.coachIds);

    if (role === "admin") {
      eventCoachIds.forEach((id) => {
        if (id) {
          idSet.add(id);
        }
      });
      const adminTargetCoachId = eventCoachId || coachOwnerId;
      if (adminTargetCoachId) {
        idSet.add(adminTargetCoachId);
      }
    } else if (coachOwnerId) {
      // Coach account only uses own id to avoid cross-account student leakage.
      idSet.add(coachOwnerId);
    }

    const coachIds = Array.from(idSet).filter(Boolean);
    if (!coachIds.length) {
      return {
        success: true,
        students: [],
        effectiveCoachId: coachOwnerId,
      };
    }

    const rawStudents = await queryStudentsByCoachIds(coachIds);

    const dedupMap = {};
    const students = [];
    rawStudents.forEach((item) => {
      const id = String((item && (item._id || item.id || item.openid)) || "").trim();
      if (!id || dedupMap[id]) {
        return;
      }
      dedupMap[id] = true;
      const lessonPackage = mapStudentLessonPackage(item);
      const hasLessonPackage = !!lessonPackage.enabled && lessonPackage.totalLessons > 0;
      students.push({
        id,
        coachId: String(item && item.coachId ? item.coachId : "").trim(),
        name: String((item && (item.name || item.nickName)) || "Student").trim() || "Student",
        hasLessonPackage,
      });
    });
    const completedLessonCountMap = await countCompletedLessonsByStudentIds(
      students.map((item) => String(item && item.id ? item.id : "").trim()),
      coachIds
    );
    const studentsWithLessonState = students.map((item) => {
      const studentId = String(item && item.id ? item.id : "").trim();
      const completedLessonCount = Math.max(0, Number(completedLessonCountMap[studentId] || 0));
      const hasLessonPackage = !!(item && item.hasLessonPackage);
      const canReceiveFlower = hasLessonPackage && completedLessonCount > 0;
      return {
        ...item,
        completedLessonCount,
        canReceiveFlower,
        flowerDisabledReason: canReceiveFlower
          ? ""
          : (hasLessonPackage ? "no_completed_lesson" : "lesson_package_not_configured"),
      };
    });

    const countMap = {};
    coachIds.forEach((id) => {
      countMap[id] = 0;
    });
    students.forEach((item) => {
      const id = String(item && item.coachId ? item.coachId : "").trim();
      if (!id) {
        return;
      }
      countMap[id] = Number(countMap[id] || 0) + 1;
    });
    let effectiveCoachId = coachIds[0] || coachOwnerId;
    let maxCount = Number(countMap[effectiveCoachId] || 0);
    coachIds.forEach((id) => {
      const count = Number(countMap[id] || 0);
      if (count > maxCount) {
        maxCount = count;
        effectiveCoachId = id;
      }
    });

    return {
      success: true,
      students: studentsWithLessonState,
      effectiveCoachId: effectiveCoachId || coachOwnerId,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coach_report_students_failed",
      students: [],
      effectiveCoachId: "",
      errMsg: e,
    };
  }
};

const listCoachTrainingReports = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", reports: [] };
    }

    const role = normalizeRole(user.role);
    if (role !== "coach" && role !== "admin") {
      return { success: false, message: "permission_denied", reports: [] };
    }

    const coachId = role === "admin"
      ? String(event && event.coachId ? event.coachId : user._id).trim()
      : String(user._id).trim();
    const coachOpenId = String(user.openid || "").trim();
    if (!coachId && !coachOpenId) {
      return { success: true, reports: [] };
    }

    const _ = db.command;
    const whereList = [];
    if (coachId) {
      whereList.push({ coachId });
      whereList.push({ coachOwnerId: coachId });
    }
    if (coachOpenId) {
      whereList.push({ coachOpenId });
    }
    const where = whereList.length > 1 ? _.or(whereList) : (whereList[0] || {});
    const list = await queryTrainingReports(where);
    return {
      success: true,
      reports: list.map((item) => mapTrainingReport(item, {
        includeContent: false,
        includeFlowerList: false,
      })),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_coach_training_reports_failed",
      reports: [],
      errMsg: e,
    };
  }
};

const listStudentTrainingReports = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", reports: [] };
    }

    const role = normalizeRole(user.role);
    const isStudentViewerRole = role === "student" || role === "user";
    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    let viewerContext = {
      studentIds: [],
      studentOpenIds: [],
      studentPhones: [],
      studentNames: [],
    };
    const studentSinceTs = getDateTimestamp(
      user && (user.studentSince || user.roleUpdatedAt || user.createdAt)
    );
    let coachIds = [];
    if (!forceStudentView && (role === "coach" || role === "admin")) {
      coachIds = mergeUniqueIdList(
        String(event && event.coachId ? event.coachId : user._id).trim(),
        normalizeIdList(event && event.coachIds)
      );
    } else {
      viewerContext = await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      });
      coachIds = viewerContext.coachIds;
    }
    const viewerContextForFlower = isStudentViewerRole
      ? {
        studentIds: viewerContext.studentIds,
        studentOpenIds: viewerContext.studentOpenIds,
        studentPhones: viewerContext.studentPhones,
        studentNames: viewerContext.studentNames,
        idOnly: false,
      }
      : viewerContext;

    if (!coachIds.length) {
      const fallbackReports = await queryTrainingReports({ status: "published" });
      const matchedReports = fallbackReports
        .filter((item) => {
          if (!isStudentViewerRole || !(studentSinceTs > 0)) {
            return true;
          }
          const reportTs = getDateTimestamp(item && (item.createdAt || item.updatedAt));
          return !(reportTs > 0 && reportTs < studentSinceTs);
        })
        .map((item) => ({
          item,
          flower: resolveViewerFlowerCountFromReport(item, viewerContextForFlower),
        }))
        .filter((entry) => entry.flower > 0)
        .map((entry) => mapTrainingReport(entry.item, {
          includeContent: false,
          includeFlowerList: false,
          viewerStudentIds: viewerContextForFlower.studentIds,
          viewerStudentOpenIds: viewerContextForFlower.studentOpenIds,
          viewerStudentPhones: viewerContextForFlower.studentPhones,
          viewerStudentNames: viewerContextForFlower.studentNames,
          viewerMatchByStudentIdOnly: !!viewerContextForFlower.idOnly,
        }));
      return { success: true, reports: matchedReports };
    }

    const list = await queryTrainingReportsByCoachIds(coachIds);
    const isStudentViewer = isStudentViewerRole;
    const notificationFlowerMap = isStudentViewer
      ? await queryTrainingReportNotificationFlowerMap(
        viewerContextForFlower.studentIds,
        [],
        {
          minCreatedAtTs: studentSinceTs > 0 ? studentSinceTs : 0,
          idOnly: true,
        }
      )
      : {};
    const mappedReports = list
      .filter((item) => {
        if (!isStudentViewer || !(studentSinceTs > 0)) {
          return true;
        }
        const reportTs = getDateTimestamp(item && (item.createdAt || item.updatedAt));
        return !(reportTs > 0 && reportTs < studentSinceTs);
      })
      .filter((item) => String(item && item.status ? item.status : "").trim() === "published")
      .map((item) => mapTrainingReport(item, {
        includeContent: false,
        includeFlowerList: false,
        viewerStudentIds: viewerContextForFlower.studentIds,
        viewerStudentOpenIds: viewerContextForFlower.studentOpenIds,
        viewerStudentPhones: viewerContextForFlower.studentPhones,
        viewerStudentNames: viewerContextForFlower.studentNames,
        viewerMatchByStudentIdOnly: !!viewerContextForFlower.idOnly,
      }))
      .map((item) => {
        const reportId = String(item && item.id ? item.id : "").trim();
        const fallbackFlower = normalizeFlowerCount(notificationFlowerMap[reportId]);
        if (fallbackFlower > 0 && normalizeFlowerCount(item.studentFlowerCount) <= 0) {
          return {
            ...item,
            studentFlowerCount: fallbackFlower,
          };
        }
        return item;
      });
    return {
      success: true,
      reports: mappedReports,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_student_training_reports_failed",
      reports: [],
      errMsg: e,
    };
  }
};

const getTrainingReportDetail = async (event) => {
  try {
    const reportId = String(event && event.reportId ? event.reportId : "").trim();
    if (!reportId) {
      return { success: false, message: "report_id_required" };
    }

    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const docRes = await db.collection(TRAINING_REPORT_COLLECTION).doc(reportId).get().catch(() => null);
    const report = docRes && docRes.data ? docRes.data : null;
    if (!report) {
      return { success: false, message: "report_not_found" };
    }
    const safeReport = stripTrainingReportDurationFields(report);

    const role = normalizeRole(user.role);
    const reportCoachId = String(safeReport.coachId || "").trim();
    const reportCoachOwnerId = String(safeReport.coachOwnerId || "").trim();
    const reportCoachOpenId = String(safeReport.coachOpenId || "").trim();
    const userId = String(user._id || "").trim();
    const userOpenId = String(user.openid || user._openid || "").trim();
    const needStudentContext = role === "student" || role === "user";
    const studentContext = needStudentContext
      ? await resolveStudentViewContext(user, {
        ...(event && typeof event === "object" ? event : {}),
        strictIdentity: false,
      })
      : {
        studentIds: [],
        studentOpenIds: [],
        studentPhones: [],
        studentNames: [],
        coachIds: [],
      };
    const studentContextForFlower = needStudentContext
      ? {
        studentIds: studentContext.studentIds,
        studentOpenIds: studentContext.studentOpenIds,
        studentPhones: studentContext.studentPhones,
        studentNames: studentContext.studentNames,
        coachIds: studentContext.coachIds,
        idOnly: false,
      }
      : studentContext;

    const canRead = role === "admin"
      || (role === "coach" && (
        (userId && reportCoachId && userId === reportCoachId)
        || (userId && reportCoachOwnerId && userId === reportCoachOwnerId)
        || (userOpenId && reportCoachOpenId && userOpenId === reportCoachOpenId)
      ))
      || ((role === "student" || role === "user") && hasReportCoachPermissionForStudent(
        studentContext.coachIds,
        reportCoachId,
        reportCoachOwnerId
      ));

    if (!canRead) {
      return { success: false, message: "permission_denied" };
    }
    await cleanupTrainingReportDurationFields(reportId, report);

    const options = {
      includeContent: true,
      includeFlowerList: role === "coach" || role === "admin",
      viewerStudentIds: studentContextForFlower.studentIds,
      viewerStudentOpenIds: studentContextForFlower.studentOpenIds,
      viewerStudentPhones: studentContextForFlower.studentPhones,
      viewerStudentNames: studentContextForFlower.studentNames,
      viewerMatchByStudentIdOnly: !!studentContextForFlower.idOnly,
    };

    return {
      success: true,
      report: mapTrainingReport(safeReport, options),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_training_report_detail_failed",
      errMsg: e,
    };
  }
};

const getStudentFlowerSummary = async (event) => {
  try {
    const { user } = await resolveCurrentUser(event);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found", totalFlowerCount: 0 };
    }

    const role = normalizeRole(user.role);
    const forceStudentView = !!(event && (event.forceStudentView || event.forceStudent));
    if (!forceStudentView && role !== "student" && role !== "user") {
      return { success: false, message: "permission_denied", totalFlowerCount: 0 };
    }

    const studentContext = await resolveStudentViewContext(user, {
      ...(event && typeof event === "object" ? event : {}),
      strictIdentity: false,
    });
    const studentContextForFlower = {
      studentIds: studentContext.studentIds,
      studentOpenIds: studentContext.studentOpenIds,
      studentPhones: studentContext.studentPhones,
      studentNames: studentContext.studentNames,
      coachIds: studentContext.coachIds,
      idOnly: false,
    };
    const studentSinceTs = getDateTimestamp(
      user && (user.studentSince || user.roleUpdatedAt || user.createdAt)
    );
    const coachIds = studentContextForFlower.coachIds;
    let reportTotal = 0;
    if (coachIds.length) {
      const list = await queryTrainingReportsByCoachIds(coachIds);
      reportTotal = sumViewerFlowersFromReports(list, studentContextForFlower, {
        minCreatedAtTs: studentSinceTs > 0 ? studentSinceTs : 0,
      });
    }
    if (reportTotal <= 0) {
      const fallbackList = await queryTrainingReports({ status: "published" });
      reportTotal = Math.max(reportTotal, sumViewerFlowersFromReports(fallbackList, studentContextForFlower, {
        minCreatedAtTs: studentSinceTs > 0 ? studentSinceTs : 0,
      }));
    }
    const notificationTotal = await sumViewerFlowersFromNotifications(
      studentContextForFlower.studentIds,
      studentContextForFlower.studentOpenIds,
      {
        minCreatedAtTs: studentSinceTs > 0 ? studentSinceTs : 0,
        idOnly: false,
      }
    );
    const canonicalTotal = reportTotal > 0 ? reportTotal : notificationTotal;
    const totalFlowerCount = Math.round(canonicalTotal * 10) / 10;

    return {
      success: true,
      totalFlowerCount,
      debug: {
        version: FLOWER_LOGIC_VERSION,
        reportTotal,
        notificationTotal,
        canonicalTotal,
        coachIds: studentContextForFlower.coachIds,
        studentIds: studentContextForFlower.studentIds,
        studentOpenIds: studentContextForFlower.studentOpenIds,
        studentPhones: studentContextForFlower.studentPhones,
        studentSinceTs: studentSinceTs > 0 ? studentSinceTs : 0,
        idOnlyMode: true,
      },
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "get_student_flower_summary_failed",
      totalFlowerCount: 0,
      errMsg: e,
    };
  }
};

const ORGANIZATION_COLLECTION = "organizations";

const listOrganizations = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const status = String(safeEvent.status || "").trim().toLowerCase() || "active";
    
    const query = status === "all"
      ? db.collection(ORGANIZATION_COLLECTION)
      : db.collection(ORGANIZATION_COLLECTION).where({ status });
    
    const res = await query.orderBy("createdAt", "desc").get();
    let organizations = res && res.data ? res.data : [];
    
    if (organizations.length === 0) {
      const defaultOrganizations = [
        { name: "轮滑协会", status: "active", createdAt: db.serverDate() },
        { name: "青少年体育中心", status: "active", createdAt: db.serverDate() },
        { name: "城市轮滑俱乐部", status: "active", createdAt: db.serverDate() },
        { name: "全民健身中心", status: "active", createdAt: db.serverDate() },
      ];
      
      for (const org of defaultOrganizations) {
        await db.collection(ORGANIZATION_COLLECTION).add({ data: org }).catch(() => {});
      }
      
      const retryRes = await query.orderBy("createdAt", "desc").get();
      organizations = retryRes && retryRes.data ? retryRes.data : [];
    }
    
    return {
      success: true,
      organizations,
      count: organizations.length,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "list_organizations_failed",
      errMsg: e,
    };
  }
};

const updateMyOrgIds = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const orgIds = Array.isArray(safeEvent.orgIds) ? safeEvent.orgIds : [];
    
    const normalizedOrgIds = orgIds.map(id => String(id || "").trim()).filter(id => id);
    
    const { user } = await resolveCurrentUser(safeEvent);
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }
    if (String(user.status || "active").trim().toLowerCase() === "disabled") {
      return { success: false, message: "account_disabled" };
    }

    await db.collection(USER_COLLECTION).doc(user._id).update({
      data: {
        orgIds: normalizedOrgIds,
        updatedAt: db.serverDate(),
      },
    });

    const latestRes = await db.collection(USER_COLLECTION).doc(user._id).get().catch(() => null);
    const latestUser = latestRes && latestRes.data ? latestRes.data : {
      ...user,
      orgIds: normalizedOrgIds,
    };
    
    return {
      success: true,
      orgIds: normalizedOrgIds,
      user: latestUser,
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "update_my_org_ids_failed",
      errMsg: e,
    };
  }
};

const publishGoods = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user } = await resolveCurrentUser(safeEvent);
    const role = String(user && user.role ? user.role : "").trim().toLowerCase();
    if (role !== "admin" && role !== "coach") {
      return { success: false, message: "permission_denied", reason: "only_admin_or_coach_can_publish" };
    }

    const title = String(safeEvent.title || "").trim();
    const description = String(safeEvent.description || "").trim();
    const category = String(safeEvent.category || "").trim();
    const categoryLabel = String(safeEvent.categoryLabel || "").trim();
    const startAt = String(safeEvent.startAt || "").trim();
    const endAt = String(safeEvent.endAt || "").trim();
    const deadlineAt = String(safeEvent.deadlineAt || "").trim();
    const price = Number(safeEvent.price) || 0;
    const maxParticipants = Number(safeEvent.maxParticipants) || 0;
    const imageUrl = String(safeEvent.imageUrl || "").trim();
    const imageUrls = Array.isArray(safeEvent.imageUrls) ? safeEvent.imageUrls : [];
    const coachId = String(safeEvent.coachId || user._id || "").trim();
    const coachName = String(safeEvent.coachName || user.name || "").trim();
    const editId = String(safeEvent.editId || "").trim();

    if (!title) {
      return { success: false, message: "title_required" };
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { success: false, message: "invalid_price" };
    }

    const updateData = {
      title,
      description,
      price,
      priceLabel: `¥${price}`,
      category,
      categoryLabel,
      startAt,
      endAt,
      deadlineAt,
      maxParticipants,
      updatedAt: db.serverDate(),
    };
    if (imageUrl) {
      updateData.imageUrl = imageUrl;
    }
    if (imageUrls.length > 0) {
      updateData.imageUrls = imageUrls;
    }

    if (editId) {
      await db.collection(EVENT_COLLECTION).doc(editId).update({ data: updateData });
      return { success: true, activityId: editId, updated: true };
    }

    const addRes = await db.collection(EVENT_COLLECTION).add({
      data: {
        ...updateData,
        enrollCount: 0,
        status: "active",
        coachId,
        coachName,
        createdAt: db.serverDate(),
      },
    });
    return { success: true, activityId: addRes._id, created: true };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "publish_goods_failed",
      errMsg: e,
    };
  }
};

const deleteGoods = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user } = await resolveCurrentUser(safeEvent);
    const role = String(user && user.role ? user.role : "").trim().toLowerCase();
    if (role !== "admin" && role !== "coach") {
      return { success: false, message: "permission_denied", reason: "only_admin_or_coach_can_delete" };
    }

    const activityId = String(safeEvent.activityId || "").trim();
    if (!activityId) {
      return { success: false, message: "activity_id_required" };
    }

    await db.collection(EVENT_COLLECTION).doc(activityId).remove();

    const imageRef = String(safeEvent.imageRef || "").trim();
    if (imageRef && imageRef.startsWith("cloud://")) {
      try {
        await cloud.deleteFile({ fileList: [imageRef] });
      } catch (e) {
        // 删除云文件失败不阻塞主流程
      }
    }

    return { success: true, deletedId: activityId };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "delete_goods_failed",
      errMsg: e,
    };
  }
};

/**
 * 生成6位唯一数字班级码
 */
const generateUniqueClassCode = async () => {
  const MAX_ATTEMPTS = 10;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await db.collection(CLASS_INVITATION_COLLECTION)
      .where({ classCode: code })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    if (!existing.data || existing.data.length === 0) {
      return code;
    }
  }
  throw new Error("generate_unique_class_code_failed");
};

const ensureClassInvitationCollection = async () => {
  try {
    await db.createCollection(CLASS_INVITATION_COLLECTION);
  } catch (e) {
    if (!isCollectionAlreadyExistsError(e)) {
      console.warn("create class_invitations collection failed:", e);
    }
  }
};

/**
 * 教练生成/重新生成班级邀请码
 */
const generateClassCode = async (event) => {
  try {
    await ensureClassInvitationCollection();

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const coachId = String(operator._id).trim();
    const forceRegenerate = !!(event && event.forceRegenerate);

    // 检查是否已有邀请码
    const existing = await db.collection(CLASS_INVITATION_COLLECTION)
      .where({ coachId })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    const existingDoc = existing.data && existing.data.length > 0 ? existing.data[0] : null;

    let classCode = "";
    let generateNew = true;

    if (existingDoc && !forceRegenerate) {
      const createdAt = existingDoc.createdAt ? new Date(existingDoc.createdAt).getTime() : 0;
      const now = Date.now();
      if (now - createdAt < 24 * 60 * 60 * 1000) {
        classCode = String(existingDoc.classCode || "").trim();
        if (classCode) {
          generateNew = false;
        }
      }
    }

    if (generateNew) {
      classCode = await generateUniqueClassCode();
    }

    const coachName = operator.name || operator.nickName || "";
    const now = db.serverDate();

    if (existingDoc) {
      await db.collection(CLASS_INVITATION_COLLECTION)
        .doc(existingDoc._id)
        .update({
          data: {
            classCode,
            updatedAt: now,
            ...(generateNew ? { createdAt: now, studentCount: 0 } : {}),
          },
        });
    } else {
      await db.collection(CLASS_INVITATION_COLLECTION).add({
        data: {
          coachId,
          coachName,
          classCode,
          className: coachName ? `${coachName}的轮滑班` : "轮滑班",
          studentCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    return {
      success: true,
      data: {
        classCode,
        coachName,
      },
    };
  } catch (error) {
    console.error("generateClassCode failed:", error);
    return { success: false, message: String(error.message || "generate_class_code_failed") };
  }
};

/**
 * 教练获取已有班级邀请信息
 */
const getCoachClassInvitation = async (event) => {
  try {
    await ensureClassInvitationCollection();

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const coachId = String(operator._id).trim();

    const existing = await db.collection(CLASS_INVITATION_COLLECTION)
      .where({ coachId })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    const doc = existing.data && existing.data.length > 0 ? existing.data[0] : null;

    if (!doc) {
      return {
        success: true,
        data: null,
      };
    }

    return {
      success: true,
      data: {
        classCode: doc.classCode || "",
        className: doc.className || "",
        coachName: doc.coachName || "",
        studentCount: doc.studentCount || 0,
        createdAt: doc.createdAt || "",
      },
    };
  } catch (error) {
    console.error("getCoachClassInvitation failed:", error);
    return { success: false, message: String(error.message || "get_invitation_failed") };
  }
};

/**
 * 更新班级二维码（前端生成后上传的 fileId）
 */
const updateClassQRCode = async (event) => {
  try {
    await ensureClassInvitationCollection();

    const { user: operator } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      forceUserId: true,
      expectedRole: "coach_or_admin",
    });
    if (!operator || !operator._id) {
      return { success: false, message: "permission_denied" };
    }
    const coachId = String(operator._id).trim();
    const qrCodeFileId = String(event.qrCodeFileId || "").trim();

    if (!qrCodeFileId) {
      return { success: false, message: "invalid_file_id" };
    }

    const existing = await db.collection(CLASS_INVITATION_COLLECTION)
      .where({ coachId })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    const doc = existing.data && existing.data.length > 0 ? existing.data[0] : null;

    if (!doc) {
      return { success: false, message: "no_class_invitation_found" };
    }

    await db.collection(CLASS_INVITATION_COLLECTION)
      .doc(doc._id)
      .update({
        data: {
          qrCodeFileId,
          updatedAt: db.serverDate(),
        },
      });

    return {
      success: true,
      data: {
        qrCodeFileId,
      },
    };
  } catch (error) {
    console.error("updateClassQRCode failed:", error);
    return { success: false, message: String(error.message || "update_qrcode_failed") };
  }
};

/**
 * 学员通过6位数字码加入班级
 */
const joinClassByCode = async (event) => {
  try {
    await ensureClassInvitationCollection();

    const safeEvent = event && typeof event === "object" ? event : {};
    const classCode = String(safeEvent.classCode || "").trim();
    if (!classCode || !/^\d{6}$/.test(classCode)) {
      return { success: false, message: "invalid_class_code" };
    }

    // 查找邀请码对应的教练
    const invitationRes = await db.collection(CLASS_INVITATION_COLLECTION)
      .where({ classCode })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    const invitation = invitationRes.data && invitationRes.data.length > 0 ? invitationRes.data[0] : null;
    if (!invitation) {
      return { success: false, message: "class_code_not_found" };
    }

    const coachId = String(invitation.coachId || "").trim();
    if (!coachId) {
      return { success: false, message: "invalid_invitation" };
    }

    // 获取当前学员
    const { user: student } = await resolveCurrentUser({
      ...safeEvent,
      forceUserId: true,
      expectedRole: "student",
    });
    if (!student || !student._id) {
      return { success: false, message: "student_not_found" };
    }
    const studentId = String(student._id).trim();

    // 检查学员是否已经是该教练的学生
    const existingCoachId = String(student.coachId || "").trim();
    const existingCoachIds = normalizeIdList(
      Array.isArray(student.coachIds) ? student.coachIds : []
    );
    if (existingCoachId) {
      existingCoachIds.push(existingCoachId);
    }
    const uniqueExistingCoachIds = [...new Set(existingCoachIds.filter(Boolean))];
    if (uniqueExistingCoachIds.includes(coachId)) {
      return { success: false, message: "already_in_this_class" };
    }

    // 将学员绑定到教练
    const updateData = {
      coachId: coachId,
      studentSince: student.studentSince || db.serverDate(),
      roleUpdatedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };

    // 如果 invitation 有 className，也设置给学员
    if (invitation.className) {
      updateData.className = invitation.className;
    }

    // 如果学员没有设置课时，自动分配默认课时
    const hasTotal = hasOwn(student, LESSON_TOTAL_FIELD) || hasOwn(student, LEGACY_LESSON_TOTAL_FIELD);
    const hasRemaining = hasOwn(student, LESSON_REMAINING_FIELD) || hasOwn(student, LEGACY_LESSON_REMAINING_FIELD);
    if (!hasTotal && !hasRemaining) {
      updateData[LESSON_TOTAL_FIELD] = 10;
      updateData[LESSON_REMAINING_FIELD] = 10;
      updateData[LEGACY_LESSON_TOTAL_FIELD] = 10;
      updateData[LEGACY_LESSON_REMAINING_FIELD] = 10;
    }

    await db.collection(USER_COLLECTION).doc(studentId).update({
      data: updateData,
    });

    // 更新邀请码的学员计数
    await db.collection(CLASS_INVITATION_COLLECTION)
      .doc(invitation._id)
      .update({
        data: {
          studentCount: db.command.inc(1),
          updatedAt: db.serverDate(),
        },
      })
      .catch(() => {});

    // 获取教练信息用于返回
    const coachDoc = await db.collection(USER_COLLECTION).doc(coachId).get()
      .then((res) => (res && res.data ? res.data : null))
      .catch(() => null);
    const coachName = coachDoc ? (coachDoc.name || coachDoc.nickName || "教练") : "教练";

    return {
      success: true,
      data: {
        className: invitation.className || "轮滑班",
        coachName,
      },
    };
  } catch (error) {
    console.error("joinClassByCode failed:", error);
    return { success: false, message: String(error.message || "join_class_failed") };
  }
};

/**
 * 管理员获取所有用户列表
 */
const listAllUsers = async (event) => {
  try {
    const { user } = await resolveCurrentUser(
      event && typeof event === "object" ? event : {}
    );
    const role = normalizeRole(user && user.role);
    if (role !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const page = Math.max(1, Number(event && event.page ? event.page : 1));
    const pageSize = Math.min(50, Math.max(1, Number(event && event.pageSize ? event.pageSize : 20)));
    const skip = (page - 1) * pageSize;

    const totalRes = await db.collection(USER_COLLECTION).count().catch(() => ({ total: 0 }));
    const total = totalRes && typeof totalRes.total === "number" ? totalRes.total : 0;

    const listRes = await db.collection(USER_COLLECTION)
      .orderBy("createdAt", "desc")
      .skip(skip)
      .limit(pageSize)
      .get()
      .catch(() => ({ data: [] }));
    const list = (listRes && listRes.data ? listRes.data : []).map((item) => ({
      _id: String(item._id || ""),
      name: String(item.name || item.nickName || "").trim() || "未设置",
      phone: String(item.phone || "").trim(),
      role: String(item.role || "student").trim().toLowerCase() || "student",
      createdAt: item.createdAt || null,
      avatarUrl: String(item.avatarUrl || "").trim(),
    }));

    return { success: true, data: { list, total, page, pageSize } };
  } catch (e) {
    console.error("listAllUsers failed:", e);
    return { success: false, message: String(e.message || "list_users_failed") };
  }
};

/**
 * 管理员修改用户角色
 */
const updateUserRole = async (event) => {
  try {
    const { user } = await resolveCurrentUser(
      event && typeof event === "object" ? event : {}
    );
    const adminRole = normalizeRole(user && user.role);
    if (adminRole !== "admin") {
      return { success: false, message: "permission_denied" };
    }

    const userId = String(event && (event.targetUserId || event.userId) ? (event.targetUserId || event.userId) : "").trim();
    const targetRole = String(event && event.targetRole ? event.targetRole : "").trim().toLowerCase();
    if (!userId) {
      return { success: false, message: "user_id_required" };
    }
    if (targetRole !== "student" && targetRole !== "coach") {
      return { success: false, message: "invalid_role" };
    }

    const targetUserRes = await db.collection(USER_COLLECTION).doc(userId).get().catch(() => null);
    if (!targetUserRes || !targetUserRes.data) {
      return { success: false, message: "user_not_found" };
    }

    await db.collection(USER_COLLECTION).doc(userId).update({
      data: {
        role: targetRole,
        roleUpdatedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      data: {
        userId,
        role: targetRole,
      },
    };
  } catch (e) {
    console.error("updateUserRole failed:", e);
    return { success: false, message: String(e.message || "update_role_failed") };
  }
};

const fixCommunityPostAuthorRole = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user } = await resolveCurrentUser(safeEvent);
    const role = normalizeRole(user && user.role);
    if (role !== "admin") {
      return { success: false, message: "permission_denied", reason: "only_admin" };
    }

    const dryRun = !!(safeEvent.dryRun !== false);
    const batchSize = Math.min(Number(safeEvent.batchSize) || 50, 200);

    const allPosts = await db.collection(COMMUNITY_POST_COLLECTION)
      .where({ authorRole: "student", postType: "video" })
      .orderBy("createdAt", "desc")
      .limit(batchSize)
      .get();
    const posts = allPosts && allPosts.data ? allPosts.data : [];

    if (!posts.length) {
      return { success: true, fixed: 0, total: 0, dryRun, message: "no_mismatched_posts" };
    }

    const userIds = [];
    const userMap = {};
    posts.forEach((post) => {
      const uid = String(post.authorId || "").trim();
      if (uid && !userMap[uid]) {
        userMap[uid] = true;
        userIds.push(uid);
      }
    });

    const userLookups = await Promise.all(
      userIds.map((uid) =>
        db.collection(USER_COLLECTION).doc(uid).get()
          .then((res) => (res && res.data ? res.data : null))
          .catch(() => null)
      )
    );
    const userRoleMap = {};
    userLookups.forEach((u) => {
      if (u && u._id) {
        userRoleMap[String(u._id).trim()] = normalizeRole(u.role);
      }
    });

    const toFix = [];
    posts.forEach((post) => {
      const realRole = userRoleMap[String(post.authorId || "").trim()];
      if (realRole && realRole !== "student" && realRole !== "user") {
        toFix.push({
          postId: post._id,
          authorId: post.authorId,
          authorRole: post.authorRole,
          correctRole: realRole,
        });
      }
    });

    if (!dryRun) {
      const updateTasks = toFix.map((item) =>
        db.collection(COMMUNITY_POST_COLLECTION).doc(item.postId).update({
          data: {
            authorRole: item.correctRole,
            updatedAt: db.serverDate(),
          },
        }).catch(() => null)
      );
      await Promise.all(updateTasks);
    }

    return {
      success: true,
      fixed: toFix.length,
      total: posts.length,
      dryRun,
      samples: toFix.slice(0, 5).map((item) => ({
        postId: item.postId,
        oldRole: item.authorRole,
        newRole: item.correctRole,
      })),
    };
  } catch (e) {
    return {
      success: false,
      message: e && e.message ? e.message : "fix_author_role_failed",
      errMsg: e,
    };
  }
};

// ========== 班级管理相关函数 ==========

const ensureClassesCollection = async () => {
  try { await db.createCollection(CLASSES_COLLECTION); } catch (e) { /* ignore */ }
};

const ensureTransfersCollection = async () => {
  try { await db.createCollection(TRANSFERS_COLLECTION); } catch (e) { /* ignore */ }
};

const maskPhone = (phone) => {
  const str = String(phone || "").trim();
  if (str.length === 11) {
    return str.substring(0, 3) + "****" + str.substring(7);
  }
  if (str.length > 4) {
    return str.substring(0, 2) + "***" + str.substring(str.length - 2);
  }
  return str || "****";
};

/**
 * 创建班级
 */
const createClass = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }
    if (!hasCoachRole(currentUser) && !hasAdminAccess(currentUser)) {
      return { success: false, message: "permission_denied" };
    }

    await ensureClassesCollection();

    const className = String(safeEvent.className || "").trim();
    if (!className) {
      return { success: false, message: "class_name_required" };
    }

    const description = String(safeEvent.description || "").trim();
    const scheduleTime = String(safeEvent.scheduleTime || "").trim();
    const coachId = String(currentUser._id);
    const coachName = String(currentUser.name || currentUser.nickName || "");

    const addRes = await db.collection(CLASSES_COLLECTION).add({
      data: {
        className,
        description,
        coachId,
        coachName,
        students: [],
        studentCount: 0,
        scheduleTime,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    return {
      success: true,
      data: {
        classId: addRes && addRes._id ? addRes._id : "",
        className,
      },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "create_class_failed" };
  }
};

/**
 * 更新班级
 */
const updateClass = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    if (!classId) {
      return { success: false, message: "class_id_required" };
    }

    const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get();
    const classDoc = classRes && classRes.data ? classRes.data : null;
    if (!classDoc) {
      return { success: false, message: "class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(classDoc.coachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    const updateData = { updatedAt: db.serverDate() };
    if (safeEvent.className !== undefined) updateData.className = String(safeEvent.className || "").trim();
    if (safeEvent.description !== undefined) updateData.description = String(safeEvent.description || "").trim();
    if (safeEvent.scheduleTime !== undefined) updateData.scheduleTime = String(safeEvent.scheduleTime || "").trim();

    await db.collection(CLASSES_COLLECTION).doc(classId).update({ data: updateData });

    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "update_class_failed" };
  }
};

/**
 * 删除班级（仅自己的班级或管理员）
 */
const deleteClass = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    if (!classId) {
      return { success: false, message: "class_id_required" };
    }

    const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get();
    const classDoc = classRes && classRes.data ? classRes.data : null;
    if (!classDoc) {
      return { success: false, message: "class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(classDoc.coachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    await db.collection(CLASSES_COLLECTION).doc(classId).remove();

    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "delete_class_failed" };
  }
};

/**
 * 获取班级列表（教练看自己的，管理员看所有）
 */
const getMyClasses = async (event) => {
  try {
    await ensureClassesCollection();

    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    const currentUserId = String(currentUser._id);

    let query = db.collection(CLASSES_COLLECTION);
    if (!isAdmin) {
      query = query.where({ coachId: currentUserId });
    }

    const result = await query.orderBy("createdAt", "desc").limit(200).get();
    const list = (result && result.data ? result.data : []).map(c => ({
      _id: c._id,
      className: c.className || "",
      description: c.description || "",
      coachId: c.coachId || "",
      coachName: c.coachName || "",
      studentCount: Array.isArray(c.students) ? c.students.length : (c.studentCount || 0),
      scheduleTime: c.scheduleTime || "",
      createdAt: c.createdAt || "",
      isOwn: String(c.coachId) === currentUserId,
    }));

    return {
      success: true,
      data: {
        classes: list,
        isAdmin,
        currentUserId,
      },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "get_classes_failed" };
  }
};

/**
 * 获取班级详情（含学员列表）
 */
const getClassDetail = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    if (!classId) {
      return { success: false, message: "class_id_required" };
    }

    const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get();
    const classDoc = classRes && classRes.data ? classRes.data : null;
    if (!classDoc) {
      return { success: false, message: "class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    const isOwn = String(classDoc.coachId) === String(currentUser._id);

    if (!isAdmin && !isOwn) {
      return { success: false, message: "permission_denied" };
    }

    // 获取班级中学员的详细信息
    const studentIds = Array.isArray(classDoc.students) ? classDoc.students.map(s => String(s)) : [];
    let studentList = [];
    if (studentIds.length > 0) {
      const _ = db.command;
      const studentRes = await db.collection(USER_COLLECTION)
        .where({ _id: _.in(studentIds) })
        .limit(200)
        .get();
      studentList = (studentRes && studentRes.data ? studentRes.data : []).map(s => ({
        _id: s._id,
        name: s.name || s.nickName || "未命名",
        phone: s.phone || s.mobile || "",
        phoneMasked: maskPhone(s.phone || s.mobile || ""),
        role: s.role || "student",
        lessonTotal: s.lessonTotal !== undefined ? s.lessonTotal : (s.totalLessons || 0),
        lessonRemaining: s.lessonRemaining !== undefined ? s.lessonRemaining : (s.remainingLessons || 0),
        lessonUsed: s.lessonUsed !== undefined ? s.lessonUsed : (s.usedLessons || 0),
        avatarUrl: s.avatarUrl || s.avatar || "",
      }));
    }

    return {
      success: true,
      data: {
        classInfo: {
          _id: classDoc._id,
          className: classDoc.className || "",
          description: classDoc.description || "",
          coachId: classDoc.coachId || "",
          coachName: classDoc.coachName || "",
          studentCount: studentIds.length,
          scheduleTime: classDoc.scheduleTime || "",
          createdAt: classDoc.createdAt || "",
          isOwn,
        },
        students: studentList,
        isAdmin,
      },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "get_class_detail_failed" };
  }
};

/**
 * 添加学员到班级
 */
const addStudentToClass = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    const studentId = String(safeEvent.studentId || "").trim();
    if (!classId || !studentId) {
      return { success: false, message: "missing_params" };
    }

    const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get();
    const classDoc = classRes && classRes.data ? classRes.data : null;
    if (!classDoc) {
      return { success: false, message: "class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(classDoc.coachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    const students = Array.isArray(classDoc.students) ? [...classDoc.students] : [];
    if (students.includes(studentId)) {
      return { success: false, message: "student_already_in_class" };
    }

    students.push(studentId);
    await db.collection(CLASSES_COLLECTION).doc(classId).update({
      data: {
        students,
        studentCount: students.length,
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "add_student_failed" };
  }
};

/**
 * 从班级移出学员
 */
const removeStudentFromClass = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    const studentId = String(safeEvent.studentId || "").trim();
    if (!classId || !studentId) {
      return { success: false, message: "missing_params" };
    }

    const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get();
    const classDoc = classRes && classRes.data ? classRes.data : null;
    if (!classDoc) {
      return { success: false, message: "class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(classDoc.coachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    const students = (Array.isArray(classDoc.students) ? [...classDoc.students] : []).filter(s => String(s) !== studentId);
    await db.collection(CLASSES_COLLECTION).doc(classId).update({
      data: {
        students,
        studentCount: students.length,
        updatedAt: db.serverDate(),
      },
    });

    return { success: true };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "remove_student_failed" };
  }
};

/**
 * 获取可用于添加的学员列表（当前教练名下且未在目标班级中的学员）
 */
const getAvailableStudents = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const classId = String(safeEvent.classId || "").trim();
    const isAdmin = hasAdminAccess(currentUser);
    const currentUserId = String(currentUser._id);

    // 获取目标班级已有学员
    let classStudentIds = [];
    if (classId) {
      const classRes = await db.collection(CLASSES_COLLECTION).doc(classId).get().catch(() => null);
      const classDoc = classRes && classRes.data ? classRes.data : null;
      if (!classDoc) {
        return { success: false, message: "class_not_found" };
      }
      const isOwn = String(classDoc.coachId) === currentUserId;
      if (!isAdmin && !isOwn) {
        return { success: false, message: "permission_denied" };
      }
      classStudentIds = Array.isArray(classDoc.students) ? classDoc.students.map(s => String(s)) : [];
    }

    // 获取教练名下的所有学员（admin可查看所有学员）
    let studentQuery;
    if (isAdmin) {
      studentQuery = db.collection(USER_COLLECTION).where({
        role: db.command.in(["student", "user"]),
      });
    } else {
      studentQuery = db.collection(USER_COLLECTION).where({
        role: db.command.in(["student", "user"]),
        coachId: currentUserId,
      });
    }

    const studentRes = await studentQuery.limit(500).get();
    const students = (studentRes && studentRes.data ? studentRes.data : [])
      .filter(s => !classStudentIds.includes(String(s._id)))
      .map(s => ({
        _id: s._id,
        name: s.name || s.nickName || "未命名",
        phone: s.phone || s.mobile || "",
        phoneMasked: maskPhone(s.phone || s.mobile || ""),
        lessonRemaining: s.lessonRemaining !== undefined ? s.lessonRemaining : (s.remainingLessons || 0),
        role: s.role || "student",
      }));

    return { success: true, data: { students } };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "get_students_failed" };
  }
};

/**
 * 获取可转移的目标班级列表
 */
const getTransferTargetClasses = async (event) => {
  try {
    await ensureClassesCollection();

    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const excludeClassId = String(safeEvent.excludeClassId || "").trim();
    const isAdmin = hasAdminAccess(currentUser);

    let query = db.collection(CLASSES_COLLECTION);
    let list = [];

    // 管理员可转到任意班级，教练只能转到别人的班级（自己的班级只展示）
    if (isAdmin) {
      const result = await query.orderBy("createdAt", "desc").limit(200).get();
      list = (result && result.data ? result.data : []);
    } else {
      const result = await query.orderBy("createdAt", "desc").limit(200).get();
      list = (result && result.data ? result.data : []);
    }

    list = list
      .filter(c => String(c._id) !== excludeClassId)
      .map(c => ({
        _id: c._id,
        className: c.className || "",
        coachName: c.coachName || "",
        coachId: c.coachId || "",
        studentCount: Array.isArray(c.students) ? c.students.length : (c.studentCount || 0),
        scheduleTime: c.scheduleTime || "",
      }));

    return { success: true, data: { classes: list } };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "get_target_classes_failed" };
  }
};

/**
 * 请求移交学员
 */
const requestTransferStudent = async (event) => {
  try {
    await ensureTransfersCollection();

    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const studentId = String(safeEvent.studentId || "").trim();
    const fromClassId = String(safeEvent.fromClassId || "").trim();
    const toClassId = String(safeEvent.toClassId || "").trim();
    if (!studentId || !fromClassId || !toClassId) {
      return { success: false, message: "missing_params" };
    }

    // 验证原班级存在且当前用户有权操作
    const fromClassRes = await db.collection(CLASSES_COLLECTION).doc(fromClassId).get();
    const fromClass = fromClassRes && fromClassRes.data ? fromClassRes.data : null;
    if (!fromClass) {
      return { success: false, message: "from_class_not_found" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(fromClass.coachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    // 验证目标班级存在
    const toClassRes = await db.collection(CLASSES_COLLECTION).doc(toClassId).get();
    const toClass = toClassRes && toClassRes.data ? toClassRes.data : null;
    if (!toClass) {
      return { success: false, message: "to_class_not_found" };
    }

    // 验证学员在原班级中
    const fromStudents = Array.isArray(fromClass.students) ? fromClass.students.map(s => String(s)) : [];
    if (!fromStudents.includes(studentId)) {
      return { success: false, message: "student_not_in_class" };
    }

    // 获取学员信息
    let studentInfo = { name: "未知学员", phone: "", phoneMasked: "" };
    try {
      const stuRes = await db.collection(USER_COLLECTION).doc(studentId).get();
      if (stuRes && stuRes.data) {
        studentInfo = {
          name: stuRes.data.name || stuRes.data.nickName || "未知学员",
          phone: stuRes.data.phone || stuRes.data.mobile || "",
          phoneMasked: maskPhone(stuRes.data.phone || stuRes.data.mobile || ""),
          lessonTotal: stuRes.data.lessonTotal !== undefined ? stuRes.data.lessonTotal : (stuRes.data.totalLessons || 0),
          lessonRemaining: stuRes.data.lessonRemaining !== undefined ? stuRes.data.lessonRemaining : (stuRes.data.remainingLessons || 0),
          lessonUsed: stuRes.data.lessonUsed !== undefined ? stuRes.data.lessonUsed : (stuRes.data.usedLessons || 0),
        };
      }
    } catch (e) { /* ignore */ }

    // 创建移交记录
    const addRes = await db.collection(TRANSFERS_COLLECTION).add({
      data: {
        studentId,
        studentName: studentInfo.name,
        fromClassId,
        fromClassName: fromClass.className || "",
        toClassId,
        toClassName: toClass.className || "",
        fromCoachId: String(currentUser._id),
        fromCoachName: String(currentUser.name || currentUser.nickName || ""),
        toCoachId: String(toClass.coachId),
        toCoachName: String(toClass.coachName || ""),
        status: "pending",
        requestedAt: db.serverDate(),
        processedAt: null,
        studentInfo: {
          phone: studentInfo.phone,
          phoneMasked: studentInfo.phoneMasked,
          lessonTotal: studentInfo.lessonTotal,
          lessonRemaining: studentInfo.lessonRemaining,
          lessonUsed: studentInfo.lessonUsed,
        },
      },
    });

    // 通知目标教练
    const transferId = addRes && addRes._id ? addRes._id : "";
    try {
      await createNotification({
        receiverUserId: String(toClass.coachId),
        senderUserId: String(currentUser._id),
        senderName: String(currentUser.name || currentUser.nickName || ""),
        type: "class_transfer",
        title: "学员移交请求",
        content: `${String(currentUser.name || currentUser.nickName || "")}教练申请将学员「${studentInfo.name}」移入你的「${toClass.className || ""}」班`,
        relatedId: transferId,
        relatedType: "class_transfer",
        relatedPath: "/pages/coach/classes/detail/detail?id=" + toClassId,
        extra: {
          transferId,
          studentId,
          studentName: studentInfo.name,
          fromClassName: fromClass.className || "",
          toClassName: toClass.className || "",
        },
      });
    } catch (e) { /* notification failure should not block transfer */ }

    return {
      success: true,
      data: { transferId },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "transfer_request_failed" };
  }
};

/**
 * 获取我的移交请求列表
 */
const getMyTransferRequests = async (event) => {
  try {
    await ensureTransfersCollection();

    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const currentUserId = String(currentUser._id);
    const isAdmin = hasAdminAccess(currentUser);

    let query = db.collection(TRANSFERS_COLLECTION);
    if (!isAdmin) {
      // 教练看到的：收到的 + 发出的
      const _ = db.command;
      query = query.where(_.or([
        { toCoachId: currentUserId },
        { fromCoachId: currentUserId },
      ]));
    }

    const result = await query.orderBy("requestedAt", "desc").limit(200).get();
    const list = (result && result.data ? result.data : []).map(t => ({
      _id: t._id,
      studentId: t.studentId,
      studentName: t.studentName,
      fromClassId: t.fromClassId,
      fromClassName: t.fromClassName,
      toClassId: t.toClassId,
      toClassName: t.toClassName,
      fromCoachId: t.fromCoachId,
      fromCoachName: t.fromCoachName,
      toCoachId: t.toCoachId,
      toCoachName: t.toCoachName,
      status: t.status,
      requestedAt: t.requestedAt,
      processedAt: t.processedAt,
      studentInfo: t.studentInfo || {},
      isIncoming: String(t.toCoachId) === currentUserId,
    }));

    return { success: true, data: { transfers: list } };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "get_transfers_failed" };
  }
};

/**
 * 处理移交请求（同意/拒绝）
 */
const processTransferRequest = async (event) => {
  try {
    const safeEvent = event && typeof event === "object" ? event : {};
    const { user: currentUser } = await resolveCurrentUser({
      ...safeEvent,
      expectedRole: "coach_or_admin",
    });
    if (!currentUser || !currentUser._id) {
      return { success: false, message: "user_not_found" };
    }

    const transferId = String(safeEvent.transferId || "").trim();
    const action = String(safeEvent.action || "").trim(); // "accept" or "reject"
    if (!transferId || !action) {
      return { success: false, message: "missing_params" };
    }
    if (action !== "accept" && action !== "reject") {
      return { success: false, message: "invalid_action" };
    }

    const transferRes = await db.collection(TRANSFERS_COLLECTION).doc(transferId).get();
    const transfer = transferRes && transferRes.data ? transferRes.data : null;
    if (!transfer) {
      return { success: false, message: "transfer_not_found" };
    }
    if (transfer.status !== "pending") {
      return { success: false, message: "transfer_already_processed" };
    }

    const isAdmin = hasAdminAccess(currentUser);
    if (!isAdmin && String(transfer.toCoachId) !== String(currentUser._id)) {
      return { success: false, message: "permission_denied" };
    }

    if (action === "accept") {
      // 从原班级移出学员
      const fromClassRes = await db.collection(CLASSES_COLLECTION).doc(transfer.fromClassId).get();
      const fromClass = fromClassRes && fromClassRes.data ? fromClassRes.data : null;
      if (fromClass) {
        const fromStudents = (Array.isArray(fromClass.students) ? [...fromClass.students] : [])
          .filter(s => String(s) !== String(transfer.studentId));
        await db.collection(CLASSES_COLLECTION).doc(transfer.fromClassId).update({
          data: { students: fromStudents, studentCount: fromStudents.length, updatedAt: db.serverDate() },
        });
      }

      // 加入目标班级
      const toClassRes = await db.collection(CLASSES_COLLECTION).doc(transfer.toClassId).get();
      const toClass = toClassRes && toClassRes.data ? toClassRes.data : null;
      if (toClass) {
        const toStudents = Array.isArray(toClass.students) ? [...toClass.students] : [];
        if (!toStudents.includes(String(transfer.studentId))) {
          toStudents.push(String(transfer.studentId));
        }
        await db.collection(CLASSES_COLLECTION).doc(transfer.toClassId).update({
          data: { students: toStudents, studentCount: toStudents.length, updatedAt: db.serverDate() },
        });
      }
    }

    // 更新移交状态
    await db.collection(TRANSFERS_COLLECTION).doc(transferId).update({
      data: {
        status: action === "accept" ? "accepted" : "rejected",
        processedAt: db.serverDate(),
      },
    });

    // 通知移交方
    const actionText = action === "accept" ? "已同意" : "已拒绝";
    try {
      await createNotification({
        receiverUserId: String(transfer.fromCoachId || ""),
        senderUserId: String(currentUser._id),
        senderName: String(currentUser.name || currentUser.nickName || ""),
        type: "class_transfer_result",
        title: "移交请求" + actionText,
        content: `${String(currentUser.name || currentUser.nickName || "")}教练${actionText}将学员「${transfer.studentName}」移入「${transfer.toClassName}」的请求`,
        relatedId: transferId,
        relatedType: "class_transfer",
        extra: {
          transferId,
          action,
          studentName: transfer.studentName || "",
          fromClassName: transfer.fromClassName || "",
          toClassName: transfer.toClassName || "",
        },
      });
    } catch (e) { /* ignore */ }

    return {
      success: true,
      data: { status: action === "accept" ? "accepted" : "rejected" },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "process_transfer_failed" };
  }
};

const joinCoachByInviteCode = async (event) => {
  try {
    const inviteCode = String(event && event.inviteCode ? event.inviteCode : "").trim();
    if (!/^\d{6}$/.test(inviteCode)) {
      return { success: false, message: "invite_code_invalid" };
    }

    const { user } = await resolveCurrentUser({
      ...(event && typeof event === "object" ? event : {}),
      expectedRole: "any",
    });
    if (!user || !user._id) {
      return { success: false, message: "user_not_found" };
    }

    const userRole = normalizeRole(user.role);
    if (userRole === "coach" || userRole === "admin") {
      return { success: false, message: "invalid_student_role" };
    }

    const _ = db.command;
    const coachRes = await db.collection(USER_COLLECTION)
      .where(_.or([
        { coachInviteCode: inviteCode },
        { classCode: inviteCode },
        { class_code: inviteCode },
      ]))
      .limit(20)
      .get()
      .catch(() => ({ data: [] }));
    const coachList = Array.isArray(coachRes && coachRes.data) ? coachRes.data : [];
    const coach = coachList.find((item) => {
      const role = normalizeRole(item && item.role);
      return role === "coach" || role === "admin";
    }) || null;
    if (!coach || !coach._id) {
      return { success: false, message: "invite_code_not_found" };
    }

    return await assignStudentToCoach({
      coachId: String(coach._id),
      studentId: String(user._id),
    });
  } catch (e) {
    console.error("[joinCoachByInviteCode]", e);
    return { success: false, message: e && e.message ? e.message : "join_coach_failed" };
  }
};

exports.main = async (event) => {
  switch (event.type) {
    case "getOpenId":
      return await getOpenId();
    case "getMiniProgramCode":
      return await getMiniProgramCode();
    case "createCollection":
      return await createCollection();
    case "selectRecord":
      return await selectRecord();
    case "updateRecord":
      return await updateRecord(event);
    case "insertRecord":
      return await insertRecord(event);
    case "deleteRecord":
      return await deleteRecord(event);
    case "createCommunityPost":
      return await createCommunityPost(event);
    case "listCommunityPosts":
      return await listCommunityPosts(event);
    case "toggleCommunityFollowAuthor":
      return await toggleCommunityFollowAuthor(event);
    case "addCommunityComment":
      return await addCommunityComment(event);
    case "moderateCommunityPost":
      return await moderateCommunityPost(event);
    case "deleteCommunityPost":
      return await deleteCommunityPost(event);
    case "viewCommunityPost":
      return await viewCommunityPost(event);
    case "toggleCommunityLike":
      return await toggleCommunityLike(event);
    case "listNotifications":
      return await listNotifications(event);
    case "markNotificationRead":
      return await markNotificationRead(event);
    case "markAllNotificationsRead":
      return await markAllNotificationsRead(event);
    case "getNotificationUnreadCount":
      return await getNotificationUnreadCount(event);
    case "getSubscribeTemplateConfig":
      return await getSubscribeTemplateConfig(event);
    case "loginByPhonePassword":
      return await loginByPhonePassword(event);
    case "changeMyPassword":
      return await changeMyPassword(event);
    case "setInitialPassword":
      return await setInitialPassword(event);
    case "sendSmsCode":
      return await sendSmsCode(event);
    case "resetPasswordWithCode":
      return await resetPasswordWithCode(event);
    case "applyCoachCertification":
      return await applyCoachCertification(event);
    case "getCertificationStatus":
      return await getCertificationStatus(event);
    case "adminGetPendingList":
      return await adminGetPendingList(event);
    case "adminReviewCertification":
      return await adminReviewCertification(event);
    case "resetMyPassword":
      return await resetMyPassword(event);
    case "resetPasswordByPhone":
      return await resetPasswordByPhone(event);
    case "updateMyProfile":
      return await updateMyProfile(event);
    case "bindUserPhone":
      return await bindUserPhone(event);
    case "getWechatPhoneNumber":
      return await getWechatPhoneNumber(event);
    case "bindUserPhoneByCode":
      return await bindUserPhoneByCode(event);
    case "backfillMyUserFields":
      return await backfillMyUserFields(event);
    case "assignStudentToCoach":
      return await assignStudentToCoach(event);
    case "removeStudentFromCoach":
      return await removeStudentFromCoach(event);
    case "transferStudentToCoach":
      return await transferStudentToCoach(event);
    case "listCoachesAndAdmins":
      return await listCoachesAndAdmins(event);
    case "assignStudentToClass":
      return await assignStudentToClass(event);
    case "listCoachAdminAccessUsers":
      return await listCoachAdminAccessUsers(event);
    case "setCoachAdminAccess":
      return await setCoachAdminAccess(event);
    case "adminSetUserRoleByPhone":
      return await adminSetUserRoleByPhone(event);
    case "setStudentLessonQuota":
      return await setStudentLessonQuota(event);
    case "publishTrainingReport":
      return await publishTrainingReport(event);
    case "listCoachSharedStudents":
      return await listCoachSharedStudents(event);
    case "listCoachReportStudents":
      return await listCoachReportStudents(event);
    case "listCoachTrainingReports":
      return await listCoachTrainingReports(event);
    case "listStudentTrainingReports":
      return await listStudentTrainingReports(event);
    case "getTrainingReportDetail":
      return await getTrainingReportDetail(event);
    case "getStudentFlowerSummary":
      return await getStudentFlowerSummary(event);
    case "createScheduleSlot":
      return await createScheduleSlot(event);
    case "createWeeklyScheduleSlots":
      return await createWeeklyScheduleSlots(event);
    case "listCoachScheduleSlots":
      return await listCoachScheduleSlots(event);
    case "listStudentBookableSlots":
      return await listStudentBookableSlots(event);
    case "bookScheduleSlot":
      return await bookScheduleSlot(event);
    case "listMyScheduleBookings":
      return await listMyScheduleBookings(event);
    case "cancelScheduleBooking":
      return await cancelScheduleBooking(event);
    case "cancelScheduleSlot":
      return await cancelScheduleSlot(event);
    case "cleanupDuplicateScheduleSlots":
      return await cleanupDuplicateScheduleSlots(event);
    case "listOrganizations":
      return await listOrganizations(event);
    case "updateMyOrgIds":
      return await updateMyOrgIds(event);
    case "publishGoods":
      return await publishGoods(event);
    case "deleteGoods":
      return await deleteGoods(event);
    case "fixCommunityPostAuthorRole":
      return await fixCommunityPostAuthorRole(event);
    case "generateClassCode":
      return await generateClassCode(event);
    case "updateClassQRCode":
      return await updateClassQRCode(event);
    case "getCoachClassInvitation":
      return await getCoachClassInvitation(event);
    case "joinClassByCode":
      return await joinClassByCode(event);
    case "listAllUsers":
      return await listAllUsers(event);
    case "updateUserRole":
      return await updateUserRole(event);
    case "createClass":
      return await createClass(event);
    case "updateClass":
      return await updateClass(event);
    case "deleteClass":
      return await deleteClass(event);
    case "getMyClasses":
      return await getMyClasses(event);
    case "getClassDetail":
      return await getClassDetail(event);
    case "addStudentToClass":
      return await addStudentToClass(event);
    case "removeStudentFromClass":
      return await removeStudentFromClass(event);
    case "getAvailableStudents":
      return await getAvailableStudents(event);
    case "getTransferTargetClasses":
      return await getTransferTargetClasses(event);
    case "requestTransferStudent":
      return await requestTransferStudent(event);
    case "getMyTransferRequests":
      return await getMyTransferRequests(event);
    case "processTransferRequest":
      return await processTransferRequest(event);
    case "joinCoachByInviteCode":
      return await joinCoachByInviteCode(event);
    default:
      return {
        success: false,
        message: "unsupported_type",
      };
  }
};






