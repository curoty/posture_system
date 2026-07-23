Page({
  data: {
    isAdmin: false,
    loading: true,
    loadError: "",
    userList: [],
    total: 0,
    page: 1,
    pageSize: 20,
    hasMore: false,
    updatingUserId: "",
  },

  onLoad() {
    const isAdmin = this.checkIsAdmin();
    if (!isAdmin) {
      wx.showToast({ title: "无权限访问", icon: "none" });
      setTimeout(() => {
        wx.redirectTo({ url: "/pages/coach/index/index" });
      }, 1200);
      return;
    }
    this.setData({ isAdmin: true });
    this.loadUserList();
  },

  onPullDownRefresh() {
    this.setData({ page: 1 });
    this.loadUserList().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadMore();
    }
  },

  checkIsAdmin() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const role = String(localUserInfo.role || "").trim().toLowerCase();
    const storedRole = String(wx.getStorageSync("userRole") || "").toLowerCase();
    return role === "admin" || storedRole === "admin";
  },

  initCloud() {
    if (!wx.cloud) return false;
    wx.cloud.init({ env: getApp().globalData.env, traceUser: true });
    return true;
  },

  getUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  loadUserList() {
    if (!this.initCloud()) {
      this.setData({ loadError: "云开发未初始化", loading: false });
      return Promise.resolve();
    }

    this.setData({ loading: true, loadError: "" });

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listAllUsers",
        userId: this.getUserId(),
        preferUserId: true,
        expectedRole: "admin",
        page: 1,
        pageSize: this.data.pageSize,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) throw new Error(result.message || "load_failed");
        const data = result.data || {};
        const list = (data.list || []).map((item) => this.mapUser(item));
        this.setData({
          userList: list,
          total: data.total || 0,
          page: 1,
          hasMore: list.length >= this.data.pageSize,
          loading: false,
        });
      })
      .catch((err) => {
        console.error("load users failed:", err);
        this.setData({
          loadError: "加载失败，请下拉刷新重试",
          loading: false,
        });
      });
  },

  loadMore() {
    if (!this.initCloud()) return;

    const nextPage = this.data.page + 1;
    this.setData({ loading: true });

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listAllUsers",
        userId: this.getUserId(),
        preferUserId: true,
        expectedRole: "admin",
        page: nextPage,
        pageSize: this.data.pageSize,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) throw new Error(result.message || "load_failed");
        const data = result.data || {};
        const list = (data.list || []).map((item) => this.mapUser(item));
        this.setData({
          userList: [...this.data.userList, ...list],
          page: nextPage,
          hasMore: list.length >= this.data.pageSize,
          loading: false,
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载更多失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  mapUser(item) {
    const safe = item || {};
    return {
      id: String(safe._id || ""),
      name: safe.name || "未设置",
      phone: this.maskPhone(safe.phone),
      phoneRaw: String(safe.phone || "").trim(),
      role: String(safe.role || "student").toLowerCase(),
      roleLabel: safe.role === "coach" ? "教练" : "学员",
      createdAt: this.formatDate(safe.createdAt),
      avatarUrl: safe.avatarUrl || "",
    };
  },

  maskPhone(phone) {
    const raw = String(phone || "").trim();
    if (raw.length === 11) {
      return raw.slice(0, 3) + "****" + raw.slice(7);
    }
    return raw || "未设置";
  },

  formatDate(value) {
    if (!value) return "";
    let dateObj;
    if (value instanceof Date) dateObj = value;
    else if (value && typeof value.toDate === "function") dateObj = value.toDate();
    else if (value && typeof value._seconds === "number") dateObj = new Date(value._seconds * 1000);
    else dateObj = new Date(value);
    if (!dateObj || Number.isNaN(dateObj.getTime())) return "";
    return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;
  },

  onChangeRole(e) {
    const userId = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!userId || this.data.updatingUserId) return;

    const user = this.data.userList.find((u) => u.id === userId);
    if (!user) return;

    const currentRole = user.role;
    const targetRole = currentRole === "coach" ? "student" : "coach";
    const currentLabel = currentRole === "coach" ? "教练" : "学员";
    const targetLabel = targetRole === "coach" ? "教练" : "学员";

    wx.showModal({
      title: "确认修改角色",
      content: `确定将「${user.name}」的角色从「${currentLabel}」改为「${targetLabel}」吗？`,
      confirmText: "确定修改",
      success: (modalRes) => {
        if (!modalRes.confirm) return;
        this.doUpdateRole(userId, targetRole);
      },
    });
  },

  doUpdateRole(userId, targetRole) {
    if (!this.initCloud()) return;

    this.setData({ updatingUserId: userId });

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "updateUserRole",
        userId: this.getUserId(),
        preferUserId: true,
        expectedRole: "admin",
        targetUserId: userId,
        targetRole,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) throw new Error(result.message || "update_failed");

        const newRoleLabel = targetRole === "coach" ? "教练" : "学员";
        const userList = this.data.userList.map((u) => {
          if (u.id !== userId) return u;
          return { ...u, role: targetRole, roleLabel: newRoleLabel };
        });
        this.setData({ userList });

        wx.showToast({ title: `已设为${newRoleLabel}`, icon: "success" });
      })
      .catch((err) => {
        console.error("update role failed:", err);
        wx.showToast({ title: "修改失败，请重试", icon: "none" });
      })
      .finally(() => {
        this.setData({ updatingUserId: "" });
      });
  },
});
