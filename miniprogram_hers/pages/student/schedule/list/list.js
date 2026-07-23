const BOOK_ERROR_TEXT = {
  slot_not_found: "该课表不存在",
  slot_not_open: "该课表已不可预约",
  slot_full: "该课表已满员",
  already_booked: "你已经预约过这个课表",
  booking_conflict: "你已有同时段课表",
  not_your_coach_slot: "只能预约自己教练的课表",
  permission_denied: "当前账号无法预约",
  student_role_required: "当前账号未分配学员身份，暂不可预约",
  lesson_quota_not_set: "课时未设置，请联系教练",
  no_remaining_lessons: "剩余课时不足",
};

const LOAD_ERROR_TEXT = {
  permission_denied: "账号无权查看课表",
};

const DEFAULT_SCHEDULE_TITLE = "轮滑训练课程";

Page({
  data: {
    loading: false,
    hasLoaded: false,
    loadError: "",
    bookedOnly: false,
    isCoachView: false,
    forceStudentView: true,
    bookingSlotId: "",
    cancelBookingId: "",
    slots: [],
    bookings: [],
    hasNoCoachBinding: false,
    lessonPackage: {
      enabled: false,
      totalLessons: 0,
      remainingLessons: 0,
      usedLessons: 0,
    },
  },

  onLoad(options) {
    const mode = String(options && options.mode ? options.mode : "").trim().toLowerCase();
    const view = String(options && options.view ? options.view : "").trim().toLowerCase();
    const bookedOnly = mode === "booked";
    const isCoachView = view === "coach";
    this.setData({
      bookedOnly,
      isCoachView,
      forceStudentView: !isCoachView,
    });
    if (bookedOnly) {
      wx.setNavigationBarTitle({ title: "已预约课程" });
    }
    this._skipNextShowReload = true;
    this.loadAll();
  },

  onShow() {
    if (this._skipNextShowReload) {
      this._skipNextShowReload = false;
      return;
    }
    this.loadAll({ silent: true });
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => {
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

  getLocalUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  buildScheduleTimestamp(dateText, timeText) {
    const date = String(dateText || "").trim();
    const time = String(timeText || "").trim();
    if (!date) {
      return NaN;
    }
    const dateMatch = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const timeMatch = time.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!dateMatch) {
      return NaN;
    }
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  },

  getWeekday(dateText) {
    const ts = this.buildScheduleTimestamp(dateText, "00:00");
    if (Number.isNaN(ts)) {
      return "";
    }
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(ts).getDay()];
  },

  formatMonthDay(dateText) {
    const date = String(dateText || "").trim();
    const match = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) {
      return date || "--.--";
    }
    const month = String(match[2]).padStart(2, "0");
    const day = String(match[3]).padStart(2, "0");
    return `${month}.${day}`;
  },

  formatTimeRange(startTime, endTime) {
    const start = String(startTime || "").trim();
    const end = String(endTime || "").trim();
    if (start && end) {
      return `${start} - ${end}`;
    }
    return start || end || "时间待定";
  },

  resolveSlotStatusMeta(status, canBook, isBookedByMe) {
    const safeStatus = String(status || "").toLowerCase();
    if (isBookedByMe) {
      return { statusText: "已预约", statusClass: "open" };
    }
    if (safeStatus === "closed") {
      return { statusText: "已结束", statusClass: "closed" };
    }
    if (safeStatus === "cancelled") {
      return { statusText: "已取消", statusClass: "cancelled" };
    }
    if (!canBook) {
      return { statusText: "不可预约", statusClass: "closed" };
    }
    return { statusText: "可预约", statusClass: "open" };
  },

  isSlotExpired(slot) {
    const safe = slot || {};
    const endTs = this.buildScheduleTimestamp(safe.date, safe.endTime || safe.startTime);
    if (Number.isNaN(endTs)) {
      return false;
    }
    return endTs < Date.now();
  },

  loadAll() {
    if (this._isLoadingAll) {
      return Promise.resolve();
    }
    if (!this.initCloud()) {
      this.setData({
        slots: [],
        bookings: [],
        loadError: "当前不支持云开发",
      });
      return Promise.resolve();
    }

    this._isLoadingAll = true;
    this.setData({
      loading: true,
      loadError: "",
    });

    const tasks = this.data.bookedOnly
      ? [this.loadMyBookings()]
      : [this.loadBookableSlots(), this.loadMyBookings()];

    return Promise.allSettled(tasks)
      .then((results) => {
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length === results.length) {
          const msg = String((failures[0].reason && failures[0].reason.message) || "");
          this.setData({
            loadError: LOAD_ERROR_TEXT[msg] || "加载课表数据失败",
          });
        }
      })
      .finally(() => {
        this._isLoadingAll = false;
        this.setData({ loading: false, hasLoaded: true });
      });
  },

  buildSlotDisplayKey(item) {
    const safe = item || {};
    return [
      String(safe.title || "").trim(),
      String(safe.date || "").trim(),
      String(safe.startTime || "").trim(),
      String(safe.endTime || "").trim(),
    ].join("|");
  },

  shouldPreferSlot(next, prev) {
    if (!prev) {
      return true;
    }
    if (!!next.isBookedByMe !== !!prev.isBookedByMe) {
      return !!next.isBookedByMe;
    }
    const nextTotal = Number(next.totalBookedCount || 0);
    const prevTotal = Number(prev.totalBookedCount || 0);
    if (nextTotal !== prevTotal) {
      return nextTotal > prevTotal;
    }
    return String(next.coachName || "") > String(prev.coachName || "");
  },

  dedupMappedSlots(slots) {
    const map = {};
    (Array.isArray(slots) ? slots : []).forEach((item) => {
      const key = this.buildSlotDisplayKey(item);
      if (!key || key === "|||") {
        return;
      }
      const prev = map[key];
      if (this.shouldPreferSlot(item, prev)) {
        map[key] = item;
      }
    });
    return Object.keys(map).map((key) => map[key]);
  },

  getViewerParams() {
    const params = {};
    if (this.data.forceStudentView) {
      params.forceStudentView = true;
      params.expectedRole = "student";
      return params;
    }

    const userId = this.getLocalUserId();
    if (userId) {
      params.userId = userId;
      params.preferUserId = true;
    }
    if (this.data.isCoachView) {
      params.expectedRole = "coach_or_admin";
    }
    return params;
  },

  loadBookableSlots() {
    const viewerParams = this.getViewerParams();
    if (this.data.isCoachView) {
      return wx.cloud.callFunction({
        name: "quickstartFunctions",
        data: {
          type: "listCoachScheduleSlots",
          ...viewerParams,
        },
      })
        .then((res) => {
          const result = res && res.result ? res.result : {};
          if (!result.success) {
            const msg = String(result.message || "");
            if (msg === "permission_denied") {
              this.setData({ slots: [], lessonPackage: this.mapLessonPackage(result.lessonPackage) });
              return;
            }
            throw new Error(msg || "list_coach_schedule_slots_failed");
          }
          const slots = Array.isArray(result.slots) ? result.slots : [];
          const mapped = this.dedupMappedSlots(slots.map((item) => this.mapSlot(item)));
          mapped.sort((a, b) => {
            const aEnded = (a.status === "closed" || a.status === "cancelled") ? 1 : 0;
            const bEnded = (b.status === "closed" || b.status === "cancelled") ? 1 : 0;
            if (aEnded !== bEnded) {
              return aEnded - bEnded;
            }
            return a.sortTime - b.sortTime;
          });
          this.setData({
            slots: mapped,
            lessonPackage: this.mapLessonPackage(result.lessonPackage),
          });
        });
    }

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listStudentBookableSlots",
        ...viewerParams,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || "");
          if (msg === "permission_denied") {
            this.setData({ slots: [], lessonPackage: this.mapLessonPackage(result.lessonPackage) });
            return;
          }
          throw new Error(msg || "list_student_bookable_slots_failed");
        }
        const slots = Array.isArray(result.slots) ? result.slots : [];
        const activeSlots = slots.filter((item) => !this.isSlotExpired(item));
        this.setData({
          slots: activeSlots.map((item) => this.mapSlot(item)),
          lessonPackage: this.mapLessonPackage(result.lessonPackage),
          hasNoCoachBinding: !!result.hasNoCoachBinding,
        });
      });
  },

  loadMyBookings() {
    const viewerParams = this.getViewerParams();
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listMyScheduleBookings",
        asBooker: true,
        ...viewerParams,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || "");
          if (msg === "permission_denied" || msg === "user_not_found") {
            this.setData({ bookings: [] });
            return;
          }
          throw new Error(msg || "list_my_schedule_bookings_failed");
        }
        const bookings = Array.isArray(result.bookings) ? result.bookings : [];
        const mapped = bookings.map((item) => this.mapBooking(item));
        mapped.sort((a, b) => {
          const aEnded = a.statusClass === "completed" ? 1 : 0;
          const bEnded = b.statusClass === "completed" ? 1 : 0;
          if (aEnded !== bEnded) {
            return aEnded - bEnded;
          }
          return a.sortTime - b.sortTime;
        });
        this.setData({ bookings: mapped });
      });
  },

  mapSlot(item) {
    const safe = item || {};
    const canBook = !!safe.canBook;
    const status = String(safe.status || "").toLowerCase();
    const date = String(safe.date || "");
    const startTime = String(safe.startTime || "");
    const sortTime = this.buildScheduleTimestamp(date, startTime);
    const coachBookedCount = Math.max(0, Number(safe.coachBookedCount || safe.bookedCount || 0));
    const studentBookedCount = Math.max(0, Number(safe.studentBookedCount || 0));
    const totalBookedCount = Math.max(0, Number(safe.totalBookedCount || (coachBookedCount + studentBookedCount)));
    const maxStudents = Math.max(1, Number(safe.maxStudents || 3));
    const statusMeta = this.resolveSlotStatusMeta(status, canBook, !!safe.isBookedByMe);

    let bookBtnText = "立即预约";
    if (safe.isBookedByMe) {
      bookBtnText = "已预约";
    } else if (status === "closed") {
      bookBtnText = "已结束";
    } else if (status === "cancelled") {
      bookBtnText = "已取消";
    } else if (!canBook) {
      bookBtnText = "不可预约";
    }

    return {
      id: String(safe.id || safe._id || ""),
      title: safe.title || safe.courseName || DEFAULT_SCHEDULE_TITLE,
      coachName: String(safe.coachName || "教练"),
      date,
      startTime,
      endTime: String(safe.endTime || ""),
      notes: String(safe.notes || ""),
      status,
      statusText: statusMeta.statusText,
      statusClass: statusMeta.statusClass,
      isBookedByMe: !!safe.isBookedByMe,
      sortTime: Number.isNaN(sortTime) ? Number.MAX_SAFE_INTEGER : sortTime,
      bookedCount: coachBookedCount,
      coachBookedCount,
      studentBookedCount,
      totalBookedCount,
      maxStudents,
      coachBookedText: `${coachBookedCount}/${maxStudents}`,
      studentBookedText: `${studentBookedCount}人`,
      studentBookedRatioText: `${studentBookedCount}/${maxStudents}`,
      bookedText: `${coachBookedCount}/不限`,
      canBook,
      bookBtnText,
      monthDay: this.formatMonthDay(date),
      weekday: this.getWeekday(date),
      fullDate: date,
      timeRange: this.formatTimeRange(startTime, safe.endTime),
    };
  },

  mapBooking(item) {
    const safe = item || {};
    const startTs = this.buildScheduleTimestamp(safe.date, safe.startTime);
    const endTs = this.buildScheduleTimestamp(safe.date, safe.endTime || safe.startTime);
    const now = Date.now();
    let statusText = "待上课";
    let statusClass = "pending";
    let canCancel = true;

    if (!Number.isNaN(endTs) && now > endTs) {
      statusText = "已结束";
      statusClass = "completed";
      canCancel = false;
    } else if (!Number.isNaN(startTs) && now >= startTs) {
      statusText = "已预约";
      statusClass = "active";
    }

    return {
      id: String(safe.id || safe._id || ""),
      title: safe.title || safe.courseName || DEFAULT_SCHEDULE_TITLE,
      coachName: String(safe.coachName || "教练"),
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

  mapLessonPackage(input) {
    const safe = input && typeof input === "object" ? input : {};
    const enabled = !!safe.enabled;
    return {
      enabled,
      totalLessons: Math.max(0, Number(safe.totalLessons || 0)),
      remainingLessons: Math.max(0, Number(safe.remainingLessons || 0)),
      usedLessons: Math.max(0, Number(safe.usedLessons || 0)),
    };
  },

  markSlotBookedLocally(slotId) {
    const slots = (Array.isArray(this.data.slots) ? this.data.slots : []).map((item) => {
      if (String(item && item.id ? item.id : "") !== slotId) {
        return item;
      }
      const isCoachBooker = !!this.data.isCoachView;
      const coachBookedCount = Math.max(0, Number(item.coachBookedCount || 0)) + (isCoachBooker ? 1 : 0);
      const studentBookedCount = Math.max(0, Number(item.studentBookedCount || 0)) + (isCoachBooker ? 0 : 1);
      const maxStudents = Math.max(1, Number(item.maxStudents || 3));
      return {
        ...item,
        coachBookedCount,
        studentBookedCount,
        totalBookedCount: coachBookedCount + studentBookedCount,
        isBookedByMe: true,
        canBook: false,
        bookBtnText: "已预约",
        statusText: "已预约",
        statusClass: "open",
        coachBookedText: `${coachBookedCount}/${maxStudents}`,
        studentBookedText: `${studentBookedCount}人`,
        studentBookedRatioText: `${studentBookedCount}/${maxStudents}`,
      };
    });
    this.setData({ slots });
  },

  onBookSlot(e) {
    const slotId = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!slotId || this.data.bookingSlotId) {
      return;
    }

    this.setData({ bookingSlotId: slotId });
    const viewerParams = this.getViewerParams();
    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "bookScheduleSlot",
        slotId,
        ...viewerParams,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(String(result.message || "book_schedule_slot_failed"));
        }
        wx.showToast({ title: "预约成功", icon: "success" });
        this.markSlotBookedLocally(slotId);
      })
      .catch((error) => {
        const msg = String((error && error.message) || "");
        wx.showToast({
          title: BOOK_ERROR_TEXT[msg] || "预约失败",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ bookingSlotId: "" });
      });
  },

  onCancelBooking(e) {
    const bookingId = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!bookingId || this.data.cancelBookingId) {
      return;
    }

    wx.showModal({
      title: "确认取消",
      content: "确定取消这条预约吗？",
      success: (modalRes) => {
        if (!modalRes.confirm) {
          return;
        }
        this.setData({ cancelBookingId: bookingId });
        const viewerParams = this.getViewerParams();
        wx.cloud.callFunction({
          name: "quickstartFunctions",
          data: {
            type: "cancelScheduleBooking",
            bookingId,
            ...viewerParams,
          },
        })
          .then((res) => {
            const result = res && res.result ? res.result : {};
            if (!result.success) {
              throw new Error(String(result.message || "cancel_schedule_booking_failed"));
            }
            wx.showToast({ title: "已取消", icon: "success" });
            this.loadAll();
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
