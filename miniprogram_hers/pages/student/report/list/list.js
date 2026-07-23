Page({
  data: {
    reports: [],
    loading: false,
    loadError: "",
    totalFlowers: 0,
  },

  onLoad() {
    this.loadReports();
  },

  onShow() {
    this.loadReports();
  },

  onPullDownRefresh() {
    this.loadReports().finally(() => {
      wx.stopPullDownRefresh();
    });
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

  normalizeDate(value) {
    if (!value) {
      return "-";
    }

    let dateObj = null;
    if (typeof value === "string") {
      dateObj = new Date(value);
    } else if (value instanceof Date) {
      dateObj = value;
    } else if (value && typeof value.toDate === "function") {
      dateObj = value.toDate();
    } else if (value && typeof value._seconds === "number") {
      dateObj = new Date(value._seconds * 1000);
    } else {
      dateObj = new Date(value);
    }

    if (!dateObj || Number.isNaN(dateObj.getTime())) {
      return "-";
    }

    const pad = (num) => String(num).padStart(2, "0");
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
  },

  normalizeReport(item) {
    const safe = item || {};
    const studentFlowerCount = Math.max(0, Number(safe.studentFlowerCount || 0));
    return {
      id: safe.id || safe._id || "",
      title: String(safe.title || "训练总结反馈"),
      contentPreview: String(safe.contentPreview || ""),
      coachName: String(safe.coachName || "教练"),
      createdDate: this.normalizeDate(safe.createdAt || safe.updatedAt),
      studentCount: Number(safe.studentCount || 0),
      studentFlowerCount,
      flowerText: `${studentFlowerCount}朵`,
      dailyFlowerText: `获得 ${studentFlowerCount} 朵小红花`,
      statusText: "已发布",
      reportTag: studentFlowerCount > 0 ? "小红花奖励" : "课程反馈",
    };
  },

  loadReports() {
    if (!this.initCloud()) {
      this.setData({
        reports: [],
        totalFlowers: 0,
        loadError: "当前基础库不支持云开发",
      });
      return Promise.resolve();
    }

    this.setData({
      loading: true,
      loadError: "",
    });

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listStudentTrainingReports",
        // 学生端不再强绑本地缓存 userId，直接以当前登录 openid 对应账号为准。
        forceStudentView: true,
        expectedRole: "student",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || "list_student_training_reports_failed");
        }

        const reports = Array.isArray(result.reports) ? result.reports : [];
        const mappedReports = reports.map((item) => this.normalizeReport(item));
        this.setData({
          reports: mappedReports,
          totalFlowers: mappedReports.reduce((sum, item) => sum + Number(item.studentFlowerCount || 0), 0),
        });
      })
      .catch((error) => {
        console.error("load student reports failed:", error);
        this.setData({
          reports: [],
          totalFlowers: 0,
          loadError: "加载训练报告失败",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },
});
