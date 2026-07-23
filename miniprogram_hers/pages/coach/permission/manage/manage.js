const { isBuiltinAdminInStorage } = require("../../../../utils/permission");

const ROLE_OPTIONS = [
  { label: "学员", value: "student" },
  { label: "教练", value: "coach" },
];

const COACH_LEVEL_OPTIONS = [
  { label: "助理教练", value: 1 },
  { label: "初级教练员", value: 2 },
  { label: "中级教练员", value: 3 },
  { label: "高级教练员", value: 4 },
];

Page({
  data: {
    loading: false,
    loadError: "",
    users: [],
    filteredUsers: [],
    keyword: "",
    savingId: "",
    submitting: false,
    submitMessage: "",
    roleOptions: ROLE_OPTIONS,
    roleIndex: 0,
    coachLevelOptions: COACH_LEVEL_OPTIONS,
    coachLevelIndex: COACH_LEVEL_OPTIONS.length - 1,
    phone: "",
  },

  onLoad() {
    if (!this.hasPermission()) {
      wx.showToast({ title: "没有权限", icon: "none" });
      setTimeout(() => {
        wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/coach/index/index" }) });
      }, 300);
      return;
    }
    this.loadUsers();
  },

  onShow() {
    if (!this.hasPermission()) {
      return;
    }
    if (!this.data.users.length && !this.data.loading) {
      this.loadUsers();
    }
  },

  onPullDownRefresh() {
    this.loadUsers(true);
  },

  hasPermission() {
    return isBuiltinAdminInStorage();
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  normalizeUser(item) {
    const safe = item && typeof item === "object" ? item : {};
    const role = String(safe.role || "").trim().toLowerCase();
    const roleLabel = String(safe.roleLabel || "").trim()
      || (role === "admin" ? "管理员" : (role === "coach" ? "教练" : "学员"));
    const phone = String(safe.phone || "").trim();
    return {
      id: String(safe.id || safe._id || "").trim(),
      name: String(safe.name || safe.nickName || "").trim() || "未命名",
      phone,
      phoneText: phone || "未绑定手机号",
      role,
      roleLabel,
      level: Number(safe.level || 0) || 0,
      levelLabel: String(safe.levelLabel || "").trim(),
      adminAccess: !!safe.adminAccess,
      isBuiltinAdmin: role === "admin",
    };
  },

  loadUsers(isPullDown) {
    if (this.data.loading) {
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }
    if (!this.initCloud()) {
      this.setData({
        loadError: "当前环境不支持云开发",
        loading: false,
        users: [],
        filteredUsers: [],
      });
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    this.setData({
      loading: true,
      loadError: "",
    });

    const payload = {
      type: "listCoachAdminAccessUsers",
    };
    const currentUserId = this.getCurrentUserId();
    if (currentUserId) {
      payload.userId = currentUserId;
      payload.preferUserId = true;
    }

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: payload,
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        const msg = String(result.message || "");
        if (msg === "permission_denied") {
          throw new Error("permission_denied");
        }
        throw new Error("list_failed");
      }
      const list = Array.isArray(result.users) ? result.users : [];
      const normalized = list.map((entry) => this.normalizeUser(entry)).filter((entry) => entry.id);
      this.setData({ users: normalized });
      this.applyFilter();
    }).catch((error) => {
      console.error("load permission users failed:", error);
      const text = String((error && error.message) || "");
      this.setData({
        users: [],
        filteredUsers: [],
        loadError: text === "permission_denied" ? "没有权限访问该页面" : "加载失败，请重试",
      });
    }).finally(() => {
      this.setData({ loading: false });
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
    });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value || "" });
    this.applyFilter();
  },

  applyFilter() {
    const keyword = String(this.data.keyword || "").trim().toLowerCase();
    const list = Array.isArray(this.data.users) ? this.data.users : [];
    const filtered = keyword
      ? list.filter((item) => (
        String(item.name || "").toLowerCase().includes(keyword)
        || String(item.phone || "").toLowerCase().includes(keyword)
      ))
      : list;
    this.setData({ filteredUsers: filtered });
  },

  updateUserInList(targetId, updater) {
    const apply = (list) => (Array.isArray(list) ? list.map((item) => {
      if (!item || item.id !== targetId) {
        return item;
      }
      return updater(item);
    }) : []);
    this.setData({
      users: apply(this.data.users),
      filteredUsers: apply(this.data.filteredUsers),
    });
  },

  onPhoneInput(e) {
    const raw = String(e && e.detail ? e.detail.value : "");
    const phone = raw.replace(/[^\d]/g, "").slice(0, 11);
    this.setData({ phone });
  },

  onRoleChange(e) {
    const index = Number(e && e.detail ? e.detail.value : 0);
    const nextIndex = Number.isInteger(index) ? Math.max(0, Math.min(ROLE_OPTIONS.length - 1, index)) : 0;
    this.setData({ roleIndex: nextIndex });
  },

  onCoachLevelChange(e) {
    const index = Number(e && e.detail ? e.detail.value : 0);
    const nextIndex = Number.isInteger(index) ? Math.max(0, Math.min(COACH_LEVEL_OPTIONS.length - 1, index)) : 0;
    this.setData({ coachLevelIndex: nextIndex });
  },

  getSelectedRole() {
    const roleItem = ROLE_OPTIONS[this.data.roleIndex] || ROLE_OPTIONS[0];
    return roleItem.value;
  },

  getSelectedCoachLevel() {
    const levelItem = COACH_LEVEL_OPTIONS[this.data.coachLevelIndex] || COACH_LEVEL_OPTIONS[COACH_LEVEL_OPTIONS.length - 1];
    return Number(levelItem.value || 0);
  },

  onSubmitRoleSetting() {
    if (!this.hasPermission()) {
      wx.showToast({ title: "没有权限", icon: "none" });
      return;
    }
    if (this.data.submitting) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: "云能力不可用", icon: "none" });
      return;
    }

    const phone = String(this.data.phone || "").trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: "请输入正确手机号", icon: "none" });
      return;
    }
    const role = this.getSelectedRole();
    const payload = {
      type: "adminSetUserRoleByPhone",
      phone,
      role,
    };
    if (role === "coach") {
      payload.level = this.getSelectedCoachLevel();
    }

    const currentUserId = this.getCurrentUserId();
    if (currentUserId) {
      payload.userId = currentUserId;
      payload.preferUserId = true;
    }

    this.setData({ submitting: true, submitMessage: "" });
    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: payload,
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        const message = String(result.message || "set_role_failed");
        if (message === "permission_denied") {
          wx.showToast({ title: "该用户不在你的管理范围", icon: "none" });
          return;
        }
        wx.showToast({ title: "保存失败，请重试", icon: "none" });
        return;
      }

      const isCoach = role === "coach";
      const roleText = isCoach ? "教练" : "学员";
      const createdText = result.created ? "新建账号" : "更新账号";
      const passwordText = result.passwordInitialized ? "，初始密码123456" : "";
      const submitMessage = `${phone} 已设为${roleText}（${createdText}${passwordText}）`;
      this.setData({
        phone: "",
        submitMessage,
      });
      wx.showToast({ title: "保存成功", icon: "success" });
      this.loadUsers();
    }).catch((error) => {
      console.error("set user role failed:", error);
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }).finally(() => {
      this.setData({ submitting: false });
    });
  },

  onAdminSwitchChange(e) {
    if (!this.hasPermission()) {
      wx.showToast({ title: "你无权限修改管理员开关", icon: "none" });
      return;
    }

    const targetUserId = String(e.currentTarget.dataset.id || "").trim();
    const role = String(e.currentTarget.dataset.role || "").trim().toLowerCase();
    const previousAdminAccess = !!e.currentTarget.dataset.adminAccess;
    const adminAccess = !!(e.detail && e.detail.value);
    if (!targetUserId) {
      return;
    }
    if (role === "admin" && !adminAccess) {
      wx.showToast({ title: "管理员权限不能关闭", icon: "none" });
      return;
    }
    if (this.data.savingId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: "云能力不可用", icon: "none" });
      return;
    }

    this.setData({ savingId: targetUserId });
    const payload = {
      type: "setCoachAdminAccess",
      targetUserId,
      adminAccess,
    };
    const currentUserId = this.getCurrentUserId();
    if (currentUserId) {
      payload.userId = currentUserId;
      payload.preferUserId = true;
    }

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: payload,
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        const message = String(result.message || "");
        this.updateUserInList(targetUserId, (item) => ({ ...item, adminAccess: previousAdminAccess }));
        if (message === "cannot_disable_builtin_admin") {
          wx.showToast({ title: "管理员权限不能关闭", icon: "none" });
          return;
        }
        if (message === "permission_denied") {
          wx.showToast({ title: "没有权限执行该操作", icon: "none" });
          return;
        }
        wx.showToast({ title: "设置失败，请重试", icon: "none" });
        return;
      }

      const nextUser = this.normalizeUser(result.user || {});
      this.updateUserInList(targetUserId, () => nextUser);
      wx.showToast({ title: adminAccess ? "已开启" : "已关闭", icon: "success" });

      const latestUserId = this.getCurrentUserId();
      if (latestUserId && latestUserId === targetUserId) {
        const info = wx.getStorageSync("userInfo") || {};
        wx.setStorageSync("userInfo", { ...info, adminAccess: nextUser.adminAccess });
        wx.setStorageSync("adminAccess", nextUser.adminAccess);
      }
    }).catch((error) => {
      console.error("set admin access failed:", error);
      this.updateUserInList(targetUserId, (item) => ({ ...item, adminAccess: previousAdminAccess }));
      wx.showToast({ title: "设置失败，请重试", icon: "none" });
    }).finally(() => {
      this.setData({ savingId: "" });
    });
  },
});
