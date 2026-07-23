const DEFAULT_TITLE = "轮滑训练课程";
const MAX_STUDENTS = 3;
const STUDENT_UNLIMITED = true;
const DEFAULT_WEEKLY_TEMPLATE = [
  { weekday: 2, startTime: "18:50", endTime: "20:30" },
  { weekday: 4, startTime: "18:50", endTime: "20:30" },
  { weekday: 5, startTime: "18:50", endTime: "20:30" },
  { weekday: 6, startTime: "10:00", endTime: "11:30" },
  { weekday: 6, startTime: "18:50", endTime: "20:30" },
  { weekday: 7, startTime: "15:00", endTime: "16:30" },
  { weekday: 7, startTime: "18:50", endTime: "20:30" },
];

const CREATE_ERROR_TEXT = {
  date_required: "请先选择日期",
  time_required: "请完整选择时间",
  invalid_time_range: "结束时间需晚于开始时间",
  slot_conflict: "该时间段已有其他课表",
  permission_denied: "仅教练或管理员可发布课程",
  target_not_coach: "请选择有效教练",
  coach_not_found: "教练不存在",
};

const TEXT = {
  coach: "教练",
  noPageForStudent: "学生端不能查看该页面",
  onlyCoachOrAdminCanPublish: "仅教练或管理员可发布课程",
  noCloud: "当前不支持云开发",
  publishSuccess: "课程发布成功",
  publishFail: "发布失败，请重试",
  coachListLoadFail: "教练列表加载失败",
  noManagedCoach: "暂无可发布教练，请先配置",
  weeklyTitle: "一键生成本周课表",
  weeklyContent: "将按固定模板生成本周课表，重复时间会自动跳过。",
  weeklyLoading: "生成中...",
  weeklyResultTitle: "生成结果",
  weeklyResultContent: "新增 %s 节，跳过 %s 节",
  weeklyFail: "生成失败",
  publishLoading: "发布中...",
};

Page({
  data: {
    role: "",
    isAdmin: false,
    canPublishPermission: false,
    coachOptions: [],
    selectedCoachCount: 0,
    totalCoachCount: 0,
    form: {
      date: "",
      startTime: "",
      endTime: "",
      notes: "",
    },
    creating: false,
    generatingWeekly: false,
  },

  onLoad(options) {
    if (!this.guardCoachAccess()) {
      return;
    }

    const incomingRole = String(options && options.role ? options.role : "").trim().toLowerCase();
    if (incomingRole === "admin") {
      wx.setStorageSync("userRole", "admin");
    } else if (incomingRole === "coach") {
      wx.setStorageSync("userRole", "coach");
    }

    const role = this.resolveRole();
    const isAdmin = role === "admin";
    this.setData({
      role,
      isAdmin,
      canPublishPermission: this.isSeniorCoachOrAdmin(),
      coachOptions: [],
      selectedCoachCount: 0,
      totalCoachCount: 0,
    });

    this.setTodayDate();
    const app = getApp();
    if (app && typeof app.requestScheduleBookingSubscribe === "function") {
      app.requestScheduleBookingSubscribe({ silent: true }).catch(() => null);
    }
    this.loadCoachOptions();
  },

  onShow() {
    if (!this.guardCoachAccess()) {
      return;
    }
    const role = this.resolveRole();
    const isAdmin = role === "admin";
    const canPublishPermission = this.isSeniorCoachOrAdmin();
    if (
      this.data.role !== role
      || this.data.isAdmin !== isAdmin
      || this.data.canPublishPermission !== canPublishPermission
    ) {
      this.setData({ role, isAdmin, canPublishPermission });
    }
    this.loadCoachOptions();
  },

  resolveRole() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roles = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    if (roles.some((role) => String(role || "").trim().toLowerCase() === "admin")) {
      return "admin";
    }
    if (roles.some((role) => String(role || "").trim().toLowerCase() === "coach")) {
      return "coach";
    }
    return "";
  },

  isCoachOrAdmin() {
    const role = this.resolveRole();
    return role === "coach" || role === "admin";
  },

  guardCoachAccess() {
    if (this.isCoachOrAdmin()) {
      return true;
    }
    wx.showToast({ title: TEXT.noPageForStudent, icon: "none" });
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: 1 });
        return;
      }
      wx.switchTab({ url: "/pages/student/index/index" });
    }, 280);
    return false;
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

  setTodayDate() {
    if (this.data.form.date) {
      return;
    }
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const today = `${now.getFullYear()}-${month}-${day}`;
    this.setData({ "form.date": today });
  },

  getLocalCoachId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  getCurrentUserId() {
    return this.getLocalCoachId();
  },

  getActorPayload() {
    const userId = this.getCurrentUserId();
    const payload = {
      expectedRole: "coach_or_admin",
    };
    if (userId) {
      payload.userId = userId;
      payload.preferUserId = true;
    }
    return payload;
  },

  isSeniorCoachOrAdmin() {
    return this.isCoachOrAdmin();
  },

  ensurePublishPermission() {
    const role = this.resolveRole();
    const isAdmin = role === "admin";
    const canPublishPermission = this.isSeniorCoachOrAdmin();
    if (
      this.data.role !== role
      || this.data.isAdmin !== isAdmin
      || this.data.canPublishPermission !== canPublishPermission
    ) {
      this.setData({ role, isAdmin, canPublishPermission });
    }
    if (canPublishPermission) {
      return true;
    }
    if (role === "coach") {
      wx.showToast({ title: TEXT.onlyCoachOrAdminCanPublish, icon: "none" });
      return false;
    }
    wx.showToast({ title: TEXT.onlyCoachOrAdminCanPublish, icon: "none" });
    return false;
  },

  applyCoachOptions(options) {
    const list = Array.isArray(options) ? options : [];
    const selectedCount = list.filter((item) => !!item.checked).length;
    this.setData({
      coachOptions: list,
      selectedCoachCount: selectedCount,
      totalCoachCount: list.length,
    });
  },

  loadCoachOptions() {
    if (!this.initCloud()) {
      return Promise.resolve();
    }

    const role = this.resolveRole();
    const isAdmin = role === "admin";
    if (!isAdmin) {
      const coachId = this.getLocalCoachId();
      const userInfo = wx.getStorageSync("userInfo") || {};
      const coachName = String(userInfo.name || userInfo.nickName || "").trim() || TEXT.coach;
      const selfOptions = coachId
        ? [{
          id: coachId,
          name: coachName,
          role: "coach",
          levelLabel: "",
          checked: true,
        }]
        : [];
      this.applyCoachOptions(selfOptions);
      return Promise.resolve();
    }

    const payload = {
      type: "listCoachAdminAccessUsers",
      ...this.getActorPayload(),
    };

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: payload,
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || "list_coach_admin_access_users_failed"));
      }
      const list = Array.isArray(result.users) ? result.users : [];
      const options = list
        .filter((item) => String(item && item.role ? item.role : "").trim().toLowerCase() === "coach")
        .map((item) => ({
          id: String(item.id || item._id || "").trim(),
          name: String(item.name || item.nickName || "").trim() || TEXT.coach,
          role: "coach",
          levelLabel: String(item.levelLabel || "").trim(),
          checked: false,
        }))
        .filter((item) => item.id);
      this.applyCoachOptions(options);
    }).catch((error) => {
      console.error("load coach options failed:", error);
      this.applyCoachOptions([]);
      wx.showToast({ title: TEXT.coachListLoadFail, icon: "none" });
    });
  },

  onCoachMultiChange(e) {
    const selectedValues = Array.isArray(e && e.detail && e.detail.value) ? e.detail.value : [];
    const selectedSet = new Set(selectedValues.map((item) => String(item || "").trim()).filter(Boolean));
    const options = (Array.isArray(this.data.coachOptions) ? this.data.coachOptions : []).map((item) => ({
      ...item,
      checked: selectedSet.has(String(item.id || "").trim()),
    }));
    this.applyCoachOptions(options);
  },

  onSelectAllCoaches() {
    const options = (Array.isArray(this.data.coachOptions) ? this.data.coachOptions : []).map((item) => ({
      ...item,
      checked: true,
    }));
    this.applyCoachOptions(options);
  },

  onClearCoachSelection() {
    const options = (Array.isArray(this.data.coachOptions) ? this.data.coachOptions : []).map((item) => ({
      ...item,
      checked: false,
    }));
    this.applyCoachOptions(options);
  },

  getPublishCoachIds() {
    if (!this.data.isAdmin) {
      const selfId = this.getLocalCoachId();
      return selfId ? [selfId] : [];
    }
    return (Array.isArray(this.data.coachOptions) ? this.data.coachOptions : [])
      .map((item) => String(item && item.id ? item.id : "").trim())
      .filter(Boolean);
  },

  onDateChange(e) {
    this.setData({
      "form.date": String(e && e.detail ? e.detail.value : "").trim(),
    });
  },

  onStartTimeChange(e) {
    this.setData({
      "form.startTime": String(e && e.detail ? e.detail.value : "").trim(),
    });
  },

  onEndTimeChange(e) {
    this.setData({
      "form.endTime": String(e && e.detail ? e.detail.value : "").trim(),
    });
  },

  onNotesInput(e) {
    this.setData({
      "form.notes": String(e && e.detail ? e.detail.value : "").slice(0, 300),
    });
  },

  buildCreatePayload(coachId) {
    const form = this.data.form || {};
    return {
      ...this.getActorPayload(),
      coachId: String(coachId || "").trim(),
      date: String(form.date || "").trim(),
      startTime: String(form.startTime || "").trim(),
      endTime: String(form.endTime || "").trim(),
      title: DEFAULT_TITLE,
      maxStudents: MAX_STUDENTS,
      studentUnlimited: STUDENT_UNLIMITED,
      notes: String(form.notes || "").trim(),
    };
  },

  buildWeeklyTemplatePayload() {
    const notes = String((this.data.form || {}).notes || "").trim();
    return DEFAULT_WEEKLY_TEMPLATE.map((item) => ({
      ...item,
      title: DEFAULT_TITLE,
      notes,
      maxStudents: MAX_STUDENTS,
      studentUnlimited: STUDENT_UNLIMITED,
    }));
  },

  extractErrorMessage(error) {
    const text = String((error && error.message) || "");
    return text || "unknown_error";
  },

  getCoachNameMap(coachIds) {
    const idList = Array.isArray(coachIds) ? coachIds : [];
    const map = {};
    const options = Array.isArray(this.data.coachOptions) ? this.data.coachOptions : [];
    options.forEach((item) => {
      const id = String(item && item.id ? item.id : "").trim();
      if (!id) {
        return;
      }
      map[id] = String(item && item.name ? item.name : "").trim() || TEXT.coach;
    });

    const selfId = this.getLocalCoachId();
    if (selfId && !map[selfId]) {
      const userInfo = wx.getStorageSync("userInfo") || {};
      map[selfId] = String(userInfo.name || userInfo.nickName || "").trim() || TEXT.coach;
    }

    idList.forEach((id) => {
      const key = String(id || "").trim();
      if (key && !map[key]) {
        map[key] = TEXT.coach;
      }
    });
    return map;
  },

  getErrorTextByCode(code) {
    const key = String(code || "").trim();
    if (key === "senior_coach_required") {
      return "\u4ec5\u9ad8\u7ea7\u6559\u7ec3\u548c\u7ba1\u7406\u5458\u53ef\u53d1\u5e03\u8bfe\u7a0b";
    }
    return CREATE_ERROR_TEXT[key] || key || "未知错误";
  },

  formatCoachFailureLines(failureDetails) {
    const list = Array.isArray(failureDetails) ? failureDetails : [];
    return list.map((item) => {
      const name = String(item && item.coachName ? item.coachName : "").trim() || TEXT.coach;
      const errorCode = String(item && item.errorCode ? item.errorCode : "").trim();
      return `${name}: ${this.getErrorTextByCode(errorCode)}`;
    });
  },

  onCreateSlot() {
    if (!this.guardCoachAccess() || !this.ensurePublishPermission()) {
      return;
    }
    if (this.data.creating) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TEXT.noCloud, icon: "none" });
      return;
    }

    const coachIds = this.getPublishCoachIds();
    if (!coachIds.length) {
      wx.showToast({ title: TEXT.noManagedCoach, icon: "none" });
      return;
    }

    const samplePayload = this.buildCreatePayload(coachIds[0]);
    if (!samplePayload.date) {
      wx.showToast({ title: CREATE_ERROR_TEXT.date_required, icon: "none" });
      return;
    }
    if (!samplePayload.startTime || !samplePayload.endTime) {
      wx.showToast({ title: CREATE_ERROR_TEXT.time_required, icon: "none" });
      return;
    }

    this.setData({ creating: true });
    wx.showLoading({ title: TEXT.publishLoading, mask: true });

    const coachNameMap = this.getCoachNameMap(coachIds);
    const tasks = coachIds.map((coachId) => wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "createScheduleSlot",
        ...this.buildCreatePayload(coachId),
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || "create_schedule_slot_failed"));
      }
      return { coachId, result };
    }).catch((error) => {
      throw { coachId, error };
    }));

    Promise.allSettled(tasks)
      .then((results) => {
        const successCount = results.filter((item) => item.status === "fulfilled").length;
        const failed = results.filter((item) => item.status === "rejected");
        const failCount = failed.length;
        const failureDetails = failed.map((item) => {
          const reason = item && item.reason ? item.reason : {};
          const coachId = String(reason.coachId || "").trim();
          const errorCode = this.extractErrorMessage(reason.error || reason);
          return {
            coachId,
            coachName: coachNameMap[coachId] || TEXT.coach,
            errorCode,
          };
        });
        if (!successCount) {
          const firstMsg = failureDetails[0] && failureDetails[0].errorCode
            ? failureDetails[0].errorCode
            : this.extractErrorMessage(failed[0] && failed[0].reason);
          wx.showToast({ title: CREATE_ERROR_TEXT[firstMsg] || TEXT.publishFail, icon: "none" });
          return;
        }
        this.setData({
          "form.startTime": "",
          "form.endTime": "",
          "form.notes": "",
        });
        if (!failCount) {
          wx.showToast({ title: TEXT.publishSuccess, icon: "success" });
          return;
        }
        const failLines = this.formatCoachFailureLines(failureDetails);
        const contentLines = [
          `成功 ${successCount} 位教练，失败 ${failCount} 位教练`,
          "",
          ...failLines.slice(0, 6),
        ];
        if (failLines.length > 6) {
          contentLines.push(`其余 ${failLines.length - 6} 位请稍后重试`);
        }
        wx.showModal({
          title: "发布结果",
          content: contentLines.join("\n"),
          showCancel: false,
        });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ creating: false });
      });
  },

  onGenerateWeeklySlots() {
    if (!this.guardCoachAccess() || !this.ensurePublishPermission()) {
      return;
    }
    if (this.data.generatingWeekly || this.data.creating) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TEXT.noCloud, icon: "none" });
      return;
    }

    const coachIds = this.getPublishCoachIds();
    if (!coachIds.length) {
      wx.showToast({ title: TEXT.noManagedCoach, icon: "none" });
      return;
    }
    const template = this.buildWeeklyTemplatePayload();

    wx.showModal({
      title: TEXT.weeklyTitle,
      content: TEXT.weeklyContent,
      success: (modalRes) => {
        if (!modalRes.confirm) {
          return;
        }

        this.setData({ generatingWeekly: true });
        wx.showLoading({ title: TEXT.weeklyLoading, mask: true });

        const coachNameMap = this.getCoachNameMap(coachIds);
        const tasks = coachIds.map((coachId) => wx.cloud.callFunction({
          name: "quickstartFunctions",
          data: {
            type: "createWeeklyScheduleSlots",
            ...this.getActorPayload(),
            coachId,
            template,
          },
        }).then((res) => {
          const result = res && res.result ? res.result : {};
          if (!result.success) {
            throw new Error(String(result.message || "create_weekly_schedule_slots_failed"));
          }
          return { coachId, result };
        }).catch((error) => {
          throw { coachId, error };
        }));

        Promise.allSettled(tasks)
          .then((results) => {
            let createdCount = 0;
            let skippedCount = 0;
            let failCount = 0;
            const failureDetails = [];
            results.forEach((item) => {
              if (item.status === "fulfilled") {
                const value = item.value && item.value.result ? item.value.result : {};
                createdCount += Number(value.createdCount || 0);
                skippedCount += Number(value.skippedCount || 0);
              } else {
                failCount += 1;
                const reason = item && item.reason ? item.reason : {};
                const coachId = String(reason.coachId || "").trim();
                failureDetails.push({
                  coachId,
                  coachName: coachNameMap[coachId] || TEXT.coach,
                  errorCode: this.extractErrorMessage(reason.error || reason),
                });
              }
            });
            if (!createdCount && failCount) {
              const firstError = failureDetails[0] && failureDetails[0].errorCode
                ? failureDetails[0].errorCode
                : "";
              wx.showToast({ title: CREATE_ERROR_TEXT[firstError] || TEXT.weeklyFail, icon: "none" });
              return;
            }
            const failLines = this.formatCoachFailureLines(failureDetails);
            const extraText = failCount ? `，失败 ${failCount} 位教练` : "";
            const contentLines = [
              `${TEXT.weeklyResultContent.replace("%s", createdCount).replace("%s", skippedCount)}${extraText}`,
            ];
            if (failLines.length) {
              contentLines.push("", ...failLines.slice(0, 6));
              if (failLines.length > 6) {
                contentLines.push(`其余 ${failLines.length - 6} 位请稍后重试`);
              }
            }
            wx.showModal({
              title: TEXT.weeklyResultTitle,
              content: contentLines.join("\n"),
              showCancel: false,
            });
          })
          .finally(() => {
            wx.hideLoading();
            this.setData({ generatingWeekly: false });
          });
      },
    });
  },
});

