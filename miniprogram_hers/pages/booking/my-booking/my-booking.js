const BOOK_ERROR_TEXT = {
  permission_denied: "当前账号无法查看预约",
};

const DEFAULT_SCHEDULE_TITLE = "轮滑训练课程";

Page({
  data: {
    loading: false,
    hasLoaded: false,
    loadError: "",
    isCoach: false,
    bookings: [],
    cancelBookingId: "",
  },

  onLoad() {
    const role = String(wx.getStorageSync("userRole") || "").toLowerCase();
    const isCoach = role === "coach" || role === "admin";
    this.setData({ isCoach });
    this._skipNextShowReload = true;
    this.loadBookings();
  },

  onShow() {
    if (this._skipNextShowReload) {
      this._skipNextShowReload = false;
      return;
    }
    this.loadBookings({ silent: true });
  },

  onPullDownRefresh() {
    this.loadBookings().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  initCloud() {
    if (!wx.cloud) return false;
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  },

  getLocalUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  loadBookings(opts) {
    if (this._isLoading) return Promise.resolve();
    if (!this.initCloud()) {
      this.setData({ bookings: [], loadError: "当前不支持云开发" });
      return Promise.resolve();
    }

    this._isLoading = true;
    const silent = opts && opts.silent;
    this.setData({
      loading: !silent,
      loadError: "",
    });

    const isCoach = this.data.isCoach;
    const userId = this.getLocalUserId();

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: isCoach
        ? {
            type: "listMyScheduleBookings",
            userId,
            preferUserId: true,
            expectedRole: "coach_or_admin",
          }
        : {
            type: "listMyScheduleBookings",
            asBooker: true,
            userId,
            preferUserId: true,
            expectedRole: "student",
          },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || "");
          if (msg === "permission_denied" || msg === "user_not_found") {
            this.setData({ bookings: [], loadError: "" });
            return;
          }
          throw new Error(msg || "load_bookings_failed");
        }
        const bookings = Array.isArray(result.bookings) ? result.bookings : [];
        const mapped = bookings.map((item) => this.mapBooking(item));
        mapped.sort((a, b) => {
          if (a.statusClass === "completed" ? 1 : 0 !== b.statusClass === "completed" ? 1 : 0) {
            return (a.statusClass === "completed" ? 1 : 0) - (b.statusClass === "completed" ? 1 : 0);
          }
          return a.sortTime - b.sortTime;
        });
        this.setData({ bookings: mapped });
      })
      .catch((err) => {
        console.error("load bookings failed:", err);
        const msg = String((err && err.message) || "");
        this.setData({
          loadError: BOOK_ERROR_TEXT[msg] || "加载预约数据失败",
        });
      })
      .finally(() => {
        this._isLoading = false;
        this.setData({ loading: false, hasLoaded: true });
      });
  },

  mapBooking(item) {
    const safe = item || {};
    const startTs = this.buildTimestamp(safe.date, safe.startTime);
    const endTs = this.buildTimestamp(safe.date, safe.endTime || safe.startTime);
    const now = Date.now();
    let statusText = "待上课";
    let statusClass = "pending";
    let canCancel = true;

    if (String(safe.status || "") === "cancelled") {
      statusText = "已取消";
      statusClass = "cancelled";
      canCancel = false;
    } else if (!Number.isNaN(endTs) && now > endTs) {
      statusText = "已结束";
      statusClass = "completed";
      canCancel = false;
    } else if (!Number.isNaN(startTs) && now >= startTs) {
      statusText = "上课中";
      statusClass = "active";
    }

    return {
      id: String(safe.id || safe._id || ""),
      slotId: String(safe.slotId || ""),
      title: safe.title || safe.courseName || DEFAULT_SCHEDULE_TITLE,
      coachName: String(safe.coachName || "教练"),
      studentName: String(safe.studentName || "学员"),
      date: String(safe.date || ""),
      startTime: String(safe.startTime || ""),
      endTime: String(safe.endTime || ""),
      statusText,
      statusClass,
      canCancel,
      sortTime: Number.isNaN(startTs) ? Number.MAX_SAFE_INTEGER : startTs,
      monthDay: this.formatMonthDay(safe.date),
      weekday: this.getWeekday(safe.date),
      fullDate: String(safe.date || ""),
      timeRange: this.formatTimeRange(safe.startTime, safe.endTime),
    };
  },

  buildTimestamp(dateText, timeText) {
    const date = String(dateText || "").trim();
    const time = String(timeText || "").trim();
    if (!date) return NaN;
    const dateMatch = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const timeMatch = time.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!dateMatch) return NaN;
    return new Date(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      timeMatch ? Number(timeMatch[1]) : 0,
      timeMatch ? Number(timeMatch[2]) : 0,
      0, 0
    ).getTime();
  },

  getWeekday(dateText) {
    const ts = this.buildTimestamp(dateText, "00:00");
    if (Number.isNaN(ts)) return "";
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(ts).getDay()];
  },

  formatMonthDay(dateText) {
    const date = String(dateText || "").trim();
    const match = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) return date || "--.--";
    return `${String(match[2]).padStart(2, "0")}.${String(match[3]).padStart(2, "0")}`;
  },

  formatTimeRange(startTime, endTime) {
    const start = String(startTime || "").trim();
    const end = String(endTime || "").trim();
    if (start && end) return `${start} - ${end}`;
    return start || end || "时间待定";
  },

  onCancelBooking(e) {
    const bookingId = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!bookingId || this.data.cancelBookingId) return;

    wx.showModal({
      title: "确认取消",
      content: "确定取消这条预约吗？",
      success: (modalRes) => {
        if (!modalRes.confirm) return;
        this.setData({ cancelBookingId: bookingId });
        wx.cloud.callFunction({
          name: "quickstartFunctions",
          data: {
            type: "cancelScheduleBooking",
            bookingId,
            userId: this.getLocalUserId(),
            preferUserId: true,
            ...(this.data.isCoach ? { expectedRole: "coach_or_admin" } : { expectedRole: "student" }),
          },
        })
          .then((res) => {
            const result = res && res.result ? res.result : {};
            if (!result.success) throw new Error(String(result.message || "cancel_failed"));
            wx.showToast({ title: "已取消", icon: "success" });
            setTimeout(() => this.loadBookings(), 500);
          })
          .catch(() => {
            wx.showToast({ title: "取消失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ cancelBookingId: "" });
          });
      },
    });
  },
});
