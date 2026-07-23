const CLASSES_PAGE = "pages/coach/classes/index/index";
let _cachedCurrentUserId = "";

Page({
  data: {
    classes: [],
    isAdmin: false,
    loading: false,
    loadError: "",
    currentUserId: "",
  },

  onLoad() {
    this.setData({
      isAdmin: this.isAdminAccount(),
      currentUserId: getCurrentUserId(),
    });
    _cachedCurrentUserId = getCurrentUserId();
  },

  onShow() {
    this.setData({
      isAdmin: this.isAdminAccount(),
      currentUserId: getCurrentUserId(),
    });
    _cachedCurrentUserId = getCurrentUserId();
    this.loadClasses();
  },

  onPullDownRefresh() {
    this.loadClasses().then(() => wx.stopPullDownRefresh());
  },

  isAdminAccount() {
    const ui = wx.getStorageSync("userInfo") || {};
    const role = String(ui.role || "").trim().toLowerCase();
    const sr = String(wx.getStorageSync("userRole") || "").toLowerCase();
    return role === "admin" || sr === "admin";
  },

  loadClasses() {
    this.setData({ loading: true, loadError: "" });
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "getMyClasses",
        userId: _cachedCurrentUserId,
        preferUserId: true,
        expectedRole: "coach_or_admin",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          this.setData({ loadError: "加载失败，请重试" });
          return;
        }
        const data = result.data || {};
        this.setData({
          classes: data.classes || [],
          isAdmin: data.isAdmin || this.data.isAdmin,
          currentUserId: data.currentUserId || this.data.currentUserId,
        });
      })
      .catch(() => {
        this.setData({ loadError: "加载失败，请重试" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  goCreate() {
    wx.navigateTo({ url: "/pages/coach/classes/create/create" });
  },

  goDetail(e) {
    const id = String(e.currentTarget.dataset.id || "").trim();
    if (!id) return;
    wx.navigateTo({ url: "/pages/coach/classes/detail/detail?id=" + id });
  },

  goEdit(e) {
    const id = String(e.currentTarget.dataset.id || "").trim();
    if (!id) return;
    wx.navigateTo({ url: "/pages/coach/classes/create/create?id=" + id });
  },

  confirmDelete(e) {
    const id = String(e.currentTarget.dataset.id || "").trim();
    const name = String(e.currentTarget.dataset.name || "").trim() || "该班级";
    if (!id) return;

    wx.showModal({
      title: "确认删除",
      content: "确定删除「" + name + "」吗？班级内学员将移出班级。",
      confirmText: "删除",
      confirmColor: "#f45b5b",
      success: (res) => {
        if (!res.confirm) return;
        this.deleteClass(id);
      },
    });
  },

  deleteClass(classId) {
    wx.showLoading({ title: "删除中..." });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "deleteClass",
          userId: _cachedCurrentUserId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "删除失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已删除", icon: "success" });
        this.loadClasses();
      })
      .catch(() => wx.showToast({ title: "删除失败", icon: "none" }))
      .finally(() => wx.hideLoading());
  },
});

function getCurrentUserId() {
  const ui = wx.getStorageSync("userInfo") || {};
  return String(ui.id || ui._id || "").trim();
}
