const TRUE_FLAG_SET = new Set(["1", "true", "yes", "y", "on"]);

const isTrueFlag = (value) => {
  if (value === true) {
    return true;
  }
  if (value === false || value === null || typeof value === "undefined") {
    return false;
  }
  const raw = String(value).trim().toLowerCase();
  return TRUE_FLAG_SET.has(raw);
};

const normalizeRoleToken = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  if (raw === "admin" || raw === "administrator" || raw === "管理员" || raw === "管理員") {
    return "admin";
  }
  if (raw === "coach" || raw === "教练" || raw === "教練") {
    return "coach";
  }
  if (raw === "student" || raw === "user" || raw === "学员" || raw === "學員") {
    return raw === "student" ? "student" : "user";
  }
  return raw;
};

const toStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeRoleToken(item))
    .filter(Boolean);
};

const collectRoleTokens = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  const tokens = [];
  const roleToken = normalizeRoleToken(safeUser.role);
  if (roleToken) {
    tokens.push(roleToken);
  }
  return Array.from(new Set([
    ...tokens,
    ...toStringArray(safeUser.roles),
    ...toStringArray(safeUser.roleList),
    ...toStringArray(safeUser.permissions),
  ]));
};

const isBuiltinAdminByUser = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  return normalizeRoleToken(safeUser.role) === "admin";
};

const hasAdminAccessByUser = (user) => {
  const safeUser = user && typeof user === "object" ? user : {};
  if (isTrueFlag(safeUser.adminAccess) || isTrueFlag(safeUser.isAdmin) || isTrueFlag(safeUser.admin)) {
    return true;
  }
  const roles = collectRoleTokens(safeUser);
  return roles.includes("admin");
};

const isBuiltinAdminInStorage = () => {
  const localUserInfo = wx.getStorageSync("userInfo") || {};
  const roleList = [
    wx.getStorageSync("accountRole"),
    localUserInfo.role,
  ];
  return roleList.some((role) => normalizeRoleToken(role) === "admin");
};

const hasAdminAccessInStorage = () => {
  const localUserInfo = wx.getStorageSync("userInfo") || {};
  const roleList = [
    wx.getStorageSync("accountRole"),
    wx.getStorageSync("userRole"),
    localUserInfo.role,
  ];
  const hasRoleAdmin = roleList.some((role) => normalizeRoleToken(role) === "admin");
  if (hasRoleAdmin) {
    return true;
  }
  if (isTrueFlag(wx.getStorageSync("adminAccess"))) {
    return true;
  }
  return hasAdminAccessByUser(localUserInfo);
};

module.exports = {
  isTrueFlag,
  normalizeRoleToken,
  collectRoleTokens,
  isBuiltinAdminByUser,
  isBuiltinAdminInStorage,
  hasAdminAccessByUser,
  hasAdminAccessInStorage,
};
