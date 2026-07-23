let _cachedUserId = "";

Page({
  data: {
    isEdit: false,
    editId: "",
    className: "",
    description: "",
    scheduleTime: "",
    submitting: false,
  },

  onLoad(options) {
    _cachedUserId = getCachedUserId();
    const editId = String(options.id || "").trim();
    if (editId) {
      this.setData({ isEdit: true, editId });
      this.loadClass(editId);
    }
    wx.setNavigationBarTitle({
      title: editId ? "编辑班级" : "创建班级",
    });
  },

  loadClass(classId) {
    wx.showLoading({ title: "加载中..." });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "getClassDetail",
          userId: _cachedUserId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "加载失败", icon: "none" });
          return;
        }
        const info = result.data && result.data.classInfo ? result.data.classInfo : {};
        this.setData({
          className: info.className || "",
          description: info.description || "",
          scheduleTime: info.scheduleTime || "",
        });
      })
      .catch(() => wx.showToast({ title: "加载失败", icon: "none" }))
      .finally(() => wx.hideLoading());
  },

  onNameInput(e) {
    this.setData({ className: String(e.detail.value || "").trim() });
  },

  onDescInput(e) {
    this.setData({ description: String(e.detail.value || "").trim() });
  },

  onScheduleInput(e) {
    this.setData({ scheduleTime: String(e.detail.value || "").trim() });
  },

  submit() {
    const { className, description, scheduleTime, isEdit, editId, submitting } = this.data;
    if (submitting) return;
    if (!className) {
      wx.showToast({ title: "请输入班级名称", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    const cloudData = {
      type: isEdit ? "updateClass" : "createClass",
      userId: _cachedUserId,
      preferUserId: true,
      expectedRole: "coach_or_admin",
      className,
      description,
      scheduleTime,
    };
    if (isEdit) {
      cloudData.classId = editId;
    }

    wx.cloud
      .callFunction({ name: "quickstartFunctions", data: cloudData })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "保存失败", icon: "none" });
          return;
        }
        wx.showToast({ title: isEdit ? "已更新" : "创建成功", icon: "success" });
        setTimeout(() => {
          wx.redirectTo({ url: "/pages/coach/classes/index/index" });
        }, 800);
      })
      .catch(() => wx.showToast({ title: "保存失败", icon: "none" }))
      .finally(() => this.setData({ submitting: false }));
  },
});

function getCachedUserId() {
  const ui = wx.getStorageSync("userInfo") || {};
  return String(ui.id || ui._id || "").trim();
}
