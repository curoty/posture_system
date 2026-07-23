Page({
  data: {
    reportId: "",
    report: null,
    loading: false,
    loadError: "",
  },

  onLoad(options) {
    const reportId = String(options && options.id ? options.id : "").trim();
    this.setData({ reportId });
    this.loadReportDetail();
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
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
  },

  normalizeFlowerList(list) {
    return (Array.isArray(list) ? list : []).map((item) => ({
      studentId: String(item && item.studentId ? item.studentId : "").trim(),
      studentName: String((item && item.studentName) || "学员").trim() || "学员",
      flowerCount: Math.max(0, Math.floor(Number(item && item.flowerCount ? item.flowerCount : 0))),
    }));
  },

  loadReportDetail() {
    if (!this.data.reportId) {
      this.setData({
        report: null,
        loadError: "报告ID缺失",
      });
      return;
    }

    if (!this.initCloud()) {
      this.setData({
        report: null,
        loadError: "当前基础库不支持云开发",
      });
      return;
    }

    this.setData({
      loading: true,
      loadError: "",
    });

    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "getTrainingReportDetail",
          reportId: this.data.reportId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || "get_training_report_detail_failed");
        }

        const report = result.report || {};
        const studentFlowerList = this.normalizeFlowerList(report.studentFlowerList);
        this.setData({
          report: {
            title: report.title || "训练总反馈",
            content: report.content || "",
            coachName: report.coachName || "教练",
            studentCount: Number(report.studentCount || 0),
            totalFlowerCount: Number(report.totalFlowerCount || 0),
            studentFlowerList,
            createdAtText: this.normalizeDate(report.createdAt || report.updatedAt),
          },
        });
      })
      .catch((error) => {
        console.error("load coach report detail failed:", error);
        const msg = String((error && error.message) || "");
        this.setData({
          report: null,
          loadError: msg.includes("permission_denied") ? "暂无权限查看该报告" : "加载报告详情失败",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },
});
