const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const mysql = require("mysql2/promise");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const documentDb = cloud.database();

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

// Keep the existing parameterized SQL call sites while using mysql2 directly.
// CloudBase Node SDK 3.18.3 deployed by the function does not expose app.models.
const runSQL = async (statement, params = {}) => {
  const values = [];
  const sql = String(statement).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    values.push(Object.prototype.hasOwnProperty.call(params, key) ? params[key] : null);
    return "?";
  });
  const [result] = await getMysqlPool().execute(sql, values);
  const list = Array.isArray(result) ? result : [];
  return {
    data: {
      executeResultList: list,
      total: Array.isArray(result) ? result.length : Number(result.affectedRows || 0),
    },
  };
};
const models = { $runSQL: runSQL };

const PASSWORD_HASH_SALT = String(process.env.PASSWORD_HASH_SALT || "aiwork_pwd_v1").trim();
const rows = (result) => {
  const data = result && result.data ? result.data : {};
  return Array.isArray(data.executeResultList) ? data.executeResultList : [];
};
const makeId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
const hashPassword = (password) => crypto
  .createHash("sha256")
  .update(`${PASSWORD_HASH_SALT}:${String(password || "").trim()}`)
  .digest("hex");

const mapUser = (row) => {
  if (!row) return null;
  let coachIds = [];
  let adminOwnerIds = [];
  try { coachIds = Array.isArray(row.coach_ids) ? row.coach_ids : JSON.parse(row.coach_ids || "[]"); } catch (_) {}
  try { adminOwnerIds = Array.isArray(row.admin_owner_ids) ? row.admin_owner_ids : JSON.parse(row.admin_owner_ids || "[]"); } catch (_) {}
  return {
    _id: row._id,
    _openid: row._openid,
    phone: row.phone || "",
    name: row.name || "",
    nickName: row.nick_name || row.name || "",
    avatarUrl: row.avatar_url || "",
    role: row.role || "student",
    status: row.status || "active",
    level: Number(row.level || 0),
    coachId: row.coach_id || "",
    coachIds,
    adminAccess: Boolean(row.admin_access),
    adminOwnerId: row.admin_owner_id || "",
    adminOwnerIds,
    joinDate: row.join_date || "",
    studentSince: row.student_since || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const selectUserByPhone = async (phone) => rows(await models.$runSQL(
  "SELECT * FROM `users` WHERE phone = {{phone}} LIMIT 1", { phone },
))[0] || null;

const selectUserByOpenid = async (openid) => rows(await models.$runSQL(
  "SELECT * FROM `users` WHERE `_openid` = {{openid}} LIMIT 1", { openid },
))[0] || null;

const asDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const migrateUserByPhoneOnDemand = async (phone) => {
  const result = await documentDb.collection("users").where({ phone }).limit(1).get();
  const item = result && Array.isArray(result.data) ? result.data[0] : null;
  if (!item || !item._id) return null;
  const ownerOpenid = String(item._openid || item.openid || "").trim();
  if (!ownerOpenid) return null;
  const params = {
    id: String(item._id),
    openid: ownerOpenid,
    phone: String(item.phone || ""),
    passwordHash: String(item.passwordHash || ""),
    name: String(item.name || item.nickName || item.nickname || ""),
    nickName: String(item.nickName || item.nickname || item.name || ""),
    avatarUrl: String(item.avatarUrl || ""),
    role: String(item.role || "student"),
    status: String(item.status || "active"),
    level: Number(item.level || 0),
    coachId: String(item.coachId || ""),
    adminAccess: item.adminAccess === true,
    adminOwnerId: String(item.adminOwnerId || ""),
    joinDate: asDate(item.joinDate),
    studentSince: asDate(item.studentSince),
    roleUpdatedAt: asDate(item.roleUpdatedAt),
    createdAt: asDate(item.createdAt || item.createTime) || new Date(),
    updatedAt: asDate(item.updatedAt) || new Date(),
  };
  await models.$runSQL(
    "INSERT INTO `users` (`_id`,`_openid`,phone,password_hash,name,nick_name,avatar_url," +
      "role,status,level,coach_id,admin_access,admin_owner_id,join_date,student_since," +
      "role_updated_at,created_at,updated_at) VALUES " +
      "({{id}},{{openid}},{{phone}},{{passwordHash}},{{name}},{{nickName}},{{avatarUrl}}," +
      "{{role}},{{status}},{{level}},{{coachId}},{{adminAccess}},{{adminOwnerId}},{{joinDate}}," +
      "{{studentSince}},{{roleUpdatedAt}},{{createdAt}},{{updatedAt}}) " +
      "ON DUPLICATE KEY UPDATE `_openid`=VALUES(`_openid`), phone=VALUES(phone), " +
      "password_hash=VALUES(password_hash), name=VALUES(name), nick_name=VALUES(nick_name), " +
      "avatar_url=VALUES(avatar_url), role=VALUES(role), status=VALUES(status), " +
      "level=VALUES(level), coach_id=VALUES(coach_id), admin_access=VALUES(admin_access), " +
      "admin_owner_id=VALUES(admin_owner_id), updated_at=VALUES(updated_at)",
    params,
  );
  return selectUserByPhone(phone);
};

const loginByPhonePassword = async (event, openid) => {
  const phone = String(event.phone || "").trim();
  const password = String(event.password || "");
  if (!/^1\d{10}$/.test(phone)) return { success: false, message: "invalid_phone" };
  let user = await selectUserByPhone(phone);
  // Transitional compatibility: migrate this account on its first MySQL login.
  // Subsequent logins read MySQL only.
  if (!user) user = await migrateUserByPhoneOnDemand(phone);
  if (!user) return { success: false, message: "account_not_found" };
  if (String(user.status || "active") !== "active") return { success: false, message: "account_disabled" };
  if (!user.password_hash) return { success: false, message: "password_not_set" };
  if (hashPassword(password) !== String(user.password_hash)) {
    return { success: false, message: "password_incorrect" };
  }
  if (openid && !user._openid) {
    const conflict = await selectUserByOpenid(openid);
    if (conflict && conflict._id !== user._id) {
      return { success: false, message: "openid_bound_to_other_phone" };
    }
    await models.$runSQL(
      "UPDATE `users` SET `_openid` = {{openid}}, updated_at = NOW(3) WHERE `_id` = {{id}}",
      { openid, id: user._id },
    );
    user._openid = openid;
  }
  return { success: true, user: mapUser(user) };
};

const loginWechat = async (event, openid) => {
  if (!openid) return { success: false, message: "openid_not_found" };
  const phone = String(event.phone || "").trim();
  let user = await selectUserByOpenid(openid);
  if (!user && phone) {
    user = await selectUserByPhone(phone);
    if (user && user._openid && user._openid !== openid) {
      return { success: false, message: "phone_bound_to_other_wechat" };
    }
    if (user) {
      await models.$runSQL(
        "UPDATE `users` SET `_openid` = {{openid}}, updated_at = NOW(3) WHERE `_id` = {{id}}",
        { openid, id: user._id },
      );
      user._openid = openid;
    }
  }
  if (!user) {
    const id = makeId("user");
    const name = `WeChatUser${openid.slice(-6)}`;
    await models.$runSQL(
      "INSERT INTO `users` (`_id`, `_openid`, phone, password_hash, name, nick_name, " +
        "avatar_url, role, status, level, coach_id, admin_access, admin_owner_id, created_at, updated_at) " +
        "VALUES ({{id}}, {{openid}}, {{phone}}, '', {{name}}, {{name}}, '', 'student', " +
        "'active', 0, '', false, '', NOW(3), NOW(3))",
      { id, openid, phone, name },
    );
    user = await selectUserByOpenid(openid);
  }
  return { success: true, user: mapUser(user) };
};

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  const type = String(event.type || "").trim();
  try {
    if (type === "health") {
      const result = await models.$runSQL("SELECT 1 AS ok");
      return { success: true, mysql: rows(result)[0] || { ok: 1 } };
    }
    if (type === "getOpenId") return { success: true, openid };
    if (type === "loginByPhonePassword") return loginByPhonePassword(event, openid);
    if (type === "loginWechat") return loginWechat(event, openid);
    if (type === "getCurrentUser") {
      return { success: true, user: mapUser(await selectUserByOpenid(openid)) };
    }
    return { success: false, message: "unsupported_type" };
  } catch (error) {
    console.error("mysqlBusiness failed", type, error);
    const safeCodes = new Set([
      "MYSQL_CONFIG_MISSING",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ER_ACCESS_DENIED_ERROR",
      "ER_BAD_DB_ERROR",
      "ER_NO_SUCH_TABLE",
      "ER_BAD_FIELD_ERROR",
    ]);
    const code = String((error && error.code) || "MYSQL_UNKNOWN_ERROR");
    return {
      success: false,
      message: "mysql_operation_failed",
      code: safeCodes.has(code) ? code : "MYSQL_UNKNOWN_ERROR",
    };
  }
};
