let _userId = "";

Page({
  data: {
    classId: "",
    classInfo: null,
    students: [],
    isAdmin: false,
    loading: false,
    loadError: "",
    // 添加学员弹窗
    showAddModal: false,
    availableStudents: [],
    addLoading: false,
    // 移交弹窗
    showTransferModal: false,
    transferStudentId: "",
    transferStudentName: "",
    targetClasses: [],
    targetLoading: false,
    selectedTargetClassId: "",
    transferring: false,
    // 移出确认
    removingStudentId: "",
  },

  onLoad(options) {
    _userId = getStoredUserId();
    this.setData({
      classId: String(options.id || "").trim(),
      isAdmin: isAdminCheck(),
    });
    wx.setNavigationBarTitle({ title: "班级详情" });
  },

  onShow() {
    _userId = getStoredUserId();
    this.setData({ isAdmin: isAdminCheck() });
    this.loadDetail();
  },

  onPullDownRefresh() {
    this.loadDetail().then(() => wx.stopPullDownRefresh());
  },

  loadDetail() {
    if (!this.data.classId) return Promise.resolve();
    this.setData({ loading: true, loadError: "" });
    return wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "getClassDetail",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId: this.data.classId,
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
          classInfo: data.classInfo || null,
          students: data.students || [],
          isAdmin: data.isAdmin || this.data.isAdmin,
        });
      })
      .catch(() => this.setData({ loadError: "加载失败，请重试" }))
      .finally(() => this.setData({ loading: false }));
  },

  goEdit() {
    wx.navigateTo({
      url: "/pages/coach/classes/create/create?id=" + this.data.classId,
    });
  },

  deleteClass() {
    wx.showModal({
      title: "确认删除",
      content: "确定删除该班级吗？",
      confirmColor: "#f45b5b",
      success: (res) => {
        if (!res.confirm) return;
        wx.cloud
          .callFunction({
            name: "quickstartFunctions",
            data: {
              type: "deleteClass",
              userId: _userId,
              preferUserId: true,
              expectedRole: "coach_or_admin",
              classId: this.data.classId,
            },
          })
          .then((r) => {
            const rd = r && r.result ? r.result : {};
            if (!rd.success) {
              wx.showToast({ title: "删除失败", icon: "none" });
              return;
            }
            wx.showToast({ title: "已删除", icon: "success" });
            setTimeout(() => wx.redirectTo({ url: "/pages/coach/classes/index/index" }), 800);
          })
          .catch(() => wx.showToast({ title: "删除失败", icon: "none" }));
      },
    });
  },

  // ===== 添加学员 =====
  onShowAddModal() {
    this.setData({ showAddModal: true, addLoading: true });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "getAvailableStudents",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId: this.data.classId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        const list = (result.data && result.data.students ? result.data.students : []);
        this.setData({ availableStudents: list });
      })
      .catch(() => wx.showToast({ title: "加载失败", icon: "none" }))
      .finally(() => this.setData({ addLoading: false }));
  },

  onCloseAddModal() {
    this.setData({ showAddModal: false, availableStudents: [] });
  },

  onAddStudent(e) {
    const studentId = String(e.currentTarget.dataset.id || "").trim();
    if (!studentId) return;

    wx.showLoading({ title: "添加中..." });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "addStudentToClass",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId: this.data.classId,
          studentId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "添加失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已添加", icon: "success" });
        this.onCloseAddModal();
        this.loadDetail();
      })
      .catch(() => wx.showToast({ title: "添加失败", icon: "none" }))
      .finally(() => wx.hideLoading());
  },

  // ===== 移出学员 =====
  confirmRemoveStudent(e) {
    const studentId = String(e.currentTarget.dataset.id || "").trim();
    const studentName = String(e.currentTarget.dataset.name || "").trim() || "该学员";
    wx.showModal({
      title: "确认移出",
      content: "确定将「" + studentName + "」移出班级吗？",
      confirmColor: "#f45b5b",
      success: (res) => {
        if (!res.confirm) return;
        this.removeStudent(studentId);
      },
    });
  },

  removeStudent(studentId) {
    wx.showLoading({ title: "移出中..." });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "removeStudentFromClass",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          classId: this.data.classId,
          studentId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "移出失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已移出", icon: "success" });
        this.loadDetail();
      })
      .catch(() => wx.showToast({ title: "移出失败", icon: "none" }))
      .finally(() => wx.hideLoading());
  },

  // ===== 移交学员 =====
  onShowTransferModal(e) {
    const studentId = String(e.currentTarget.dataset.id || "").trim();
    const studentName = String(e.currentTarget.dataset.name || "").trim() || "该学员";
    if (!studentId) return;

    this.setData({
      showTransferModal: true,
      transferStudentId: studentId,
      transferStudentName: studentName,
      selectedTargetClassId: "",
      targetLoading: true,
    });

    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "getTransferTargetClasses",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          excludeClassId: this.data.classId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        const list = (result.data && result.data.classes ? result.data.classes : []);
        this.setData({ targetClasses: list });
      })
      .catch(() => wx.showToast({ title: "加载班级失败", icon: "none" }))
      .finally(() => this.setData({ targetLoading: false }));
  },

  onCloseTransferModal() {
    this.setData({
      showTransferModal: false,
      transferStudentId: "",
      transferStudentName: "",
      targetClasses: [],
      selectedTargetClassId: "",
    });
  },

  onSelectTargetClass(e) {
    const id = String(e.currentTarget.dataset.id || "").trim();
    this.setData({ selectedTargetClassId: id });
  },

  onConfirmTransfer() {
    const { transferStudentId, selectedTargetClassId, classId, transferStudentName, transferring } = this.data;
    if (transferring) return;
    if (!selectedTargetClassId) {
      wx.showToast({ title: "请选择目标班级", icon: "none" });
      return;
    }

    const targetClass = this.data.targetClasses.find((c) => c._id === selectedTargetClassId);
    const targetName = targetClass ? targetClass.className : "";

    wx.showModal({
      title: "确认移交",
      content: "确定将「" + transferStudentName + "」移交给「" + targetName + "」吗？",
      confirmColor: "#35c66b",
      success: (res) => {
        if (!res.confirm) return;
        this.executeTransfer(transferStudentId, selectedTargetClassId);
      },
    });
  },

  executeTransfer(studentId, toClassId) {
    this.setData({ transferring: true });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "requestTransferStudent",
          userId: _userId,
          preferUserId: true,
          expectedRole: "coach_or_admin",
          studentId,
          fromClassId: this.data.classId,
          toClassId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          wx.showToast({ title: "移交失败，请重试", icon: "none" });
          return;
        }
        wx.showToast({ title: "已发送移交请求", icon: "success" });
        this.onCloseTransferModal();
      })
      .catch(() => wx.showToast({ title: "移交失败", icon: "none" }))
      .finally(() => this.setData({ transferring: false }));
  },
});

function getStoredUserId() {
  const ui = wx.getStorageSync("userInfo") || {};
  return String(ui.id || ui._id || "").trim();
}

function isAdminCheck() {
  const ui = wx.getStorageSync("userInfo") || {};
  const role = String(ui.role || "").trim().toLowerCase();
  const sr = String(wx.getStorageSync("userRole") || "").toLowerCase();
  return role === "admin" || sr === "admin";
}
