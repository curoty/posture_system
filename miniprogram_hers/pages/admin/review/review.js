Page({
  data: {
    pendingList: [],
    loading: true,
    showDetail: false,
    currentItem: null,
    remark: "",
  },

  onLoad() {
    this.loadPendingList();
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({ env: getApp().globalData.env, traceUser: true });
    return true;
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return userInfo.id || userInfo._id || "";
  },

  async loadPendingList() {
    if (!this.initCloud()) {
      wx.showToast({ title: "云能力不可用", icon: "none" });
      return;
    }

    this.setData({ loading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: "quickstartFunctions",
        data: {
          type: "adminGetPendingList",
          userId: this.getCurrentUserId(),
          preferUserId: true,
        },
      });

      const result = res && res.result ? res.result : {};
      if (!result.success) {
        if (result.message === "permission_denied") {
          wx.showToast({ title: "权限不足", icon: "none" });
        } else {
          wx.showToast({ title: "获取列表失败", icon: "none" });
        }
        return;
      }

      this.setData({
        pendingList: result.list || [],
      });
    } catch (error) {
      console.error("loadPendingList error:", error);
      wx.showToast({ title: "获取列表失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  viewDetail(e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.pendingList[index];
    this.setData({
      showDetail: true,
      currentItem: item,
      remark: "",
    });
  },

  closeDetail() {
    this.setData({
      showDetail: false,
      currentItem: null,
      remark: "",
    });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  async review(status) {
    if (!this.data.currentItem) return;

    wx.showLoading({ title: "处理中...", mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: "quickstartFunctions",
        data: {
          type: "adminReviewCertification",
          userId: this.getCurrentUserId(),
          preferUserId: true,
          targetUserId: this.data.currentItem._id,
          status,
          remark: this.data.remark,
        },
      });

      const result = res && res.result ? res.result : {};
      if (result.success) {
        wx.showToast({ title: status === "已认证" ? "审核通过" : "审核拒绝", icon: "success" });
        this.closeDetail();
        this.loadPendingList();
      } else {
        wx.showToast({ title: "操作失败", icon: "none" });
      }
    } catch (error) {
      console.error("review error:", error);
      wx.showToast({ title: "操作失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  approve() {
    this.review("已认证");
  },

  reject() {
    this.review("已拒绝");
  },

  formatDate(date) {
    if (!date) return "-";
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },
});
