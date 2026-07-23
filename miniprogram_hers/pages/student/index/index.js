Page({
  _cloudInited: false,
  _refreshDataPromise: null,
  _lastRefreshAt: 0,

  data: {
    userName: '学员',
    weeklyTrainingCount: 0,
    weeklyTrainingMinutes: 0,
    unreadNotificationCount: 0,
    recentSchedules: [],
    bookingModule: {
      availableCount: 0,
      nextSlotText: '当前暂无预约课程',
      hasAvailable: false
    },
    lessonPackage: {
      enabled: false,
      totalLessons: 0,
      remainingLessons: 0,
      usedLessons: 0
    }
  },

  onLoad() {
    this.loadLocalUserName();
    this.refreshData();
  },

  onShow() {
    this.loadLocalUserName();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    if (Date.now() - this._lastRefreshAt > 1200) {
      this.refreshData();
    }
  },

  loadLocalUserName() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const rawName = String(userInfo.name || userInfo.nickName || '').trim();
    this.setData({ userName: rawName || '学员' });
  },

  refreshData() {
    if (this._refreshDataPromise) {
      return this._refreshDataPromise;
    }
    this._lastRefreshAt = Date.now();
    this._refreshDataPromise = Promise.allSettled([
      this.loadRecentSchedules(),
      this.loadLessonPackageSummary(),
      this.loadNotificationUnreadCount()
    ]).finally(() => {
      this._refreshDataPromise = null;
    });
    return this._refreshDataPromise;
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    if (this._cloudInited) {
      return true;
    }
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });
    this._cloudInited = true;
    return true;
  },

  getLocalUserId() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    return String(userInfo.id || userInfo._id || '').trim();
  },

  getScheduleViewerParams() {
    const userId = this.getLocalUserId();
    const params = {
      forceStudentView: true,
      expectedRole: 'student'
    };
    if (userId) {
      params.userId = userId;
      params.preferUserId = true;
    }
    return params;
  },

  buildScheduleTimestamp(dateText, timeText) {
    const date = String(dateText || '').trim();
    const time = String(timeText || '').trim();
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
    const ts = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    return Number.isNaN(ts) ? NaN : ts;
  },

  buildScheduleStatus(startTs, endTs) {
    if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
      return { text: '待上课', className: 'pending' };
    }
    const now = Date.now();
    if (now < startTs) {
      return { text: '待上课', className: 'pending' };
    }
    if (now >= startTs && now <= endTs) {
      return { text: '进行中', className: 'active' };
    }
    return { text: '已结束', className: 'completed' };
  },

  formatScheduleDisplayDate(dateText) {
    const raw = String(dateText || '').trim();
    const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) {
      return {
        displayDate: raw || '05.25',
        weekday: '周'
      };
    }
    const month = String(Number(match[2])).padStart(2, '0');
    const day = String(Number(match[3])).padStart(2, '0');
    const dateObj = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return {
      displayDate: `${month}.${day}`,
      weekday: weekNames[dateObj.getDay()] || '周'
    };
  },

  normalizeScheduleItem(item) {
    const safe = item || {};
    const date = String(safe.date || '').trim();
    const startTime = String(safe.startTime || '').trim();
    const endTime = String(safe.endTime || '').trim();
    const startTs = this.buildScheduleTimestamp(date, startTime);
    const endTs = this.buildScheduleTimestamp(date, endTime);
    const statusInfo = this.buildScheduleStatus(startTs, endTs);
    const dateParts = this.formatScheduleDisplayDate(date);
    const timeRange = startTime && endTime
      ? `${startTime}-${endTime}`
      : (startTime || endTime || '10:00');
    return {
      id: String(safe.id || safe._id || `${date}-${startTime}`),
      scheduleDate: date || '待定',
      scheduleTime: timeRange,
      displayDate: dateParts.displayDate,
      weekday: dateParts.weekday,
      displayTime: startTime || '10:00',
      courseName: safe.courseName || safe.title || safe.name || '课程',
      location: safe.location || safe.venue || safe.address || '--',
      statusText: statusInfo.text,
      statusClass: statusInfo.className,
      sortTime: Number.isNaN(startTs) ? Number.MAX_SAFE_INTEGER : startTs,
      endTimeForSort: Number.isNaN(endTs) ? Number.MAX_SAFE_INTEGER : endTs
    };
  },

  mapLessonPackage(input) {
    const safe = input && typeof input === 'object' ? input : {};
    const enabled = !!safe.enabled;
    return {
      enabled,
      totalLessons: Math.max(0, Number(safe.totalLessons || 0)),
      remainingLessons: Math.max(0, Number(safe.remainingLessons || 0)),
      usedLessons: Math.max(0, Number(safe.usedLessons || 0))
    };
  },

  buildSlotSortTime(slot) {
    const safe = slot || {};
    const ts = this.buildScheduleTimestamp(safe.date, safe.startTime);
    return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts;
  },

  isSlotAvailableForBooking(slot) {
    const safe = slot || {};
    if (!safe.canBook) {
      return false;
    }
    const endTs = this.buildScheduleTimestamp(safe.date, safe.endTime || safe.startTime);
    return Number.isNaN(endTs) || endTs >= Date.now();
  },

  formatSlotPreview(slot) {
    const safe = slot || {};
    const date = String(safe.date || '').trim() || '未知日期';
    const startTime = String(safe.startTime || '').trim();
    const endTime = String(safe.endTime || '').trim();
    const timeRange = startTime && endTime
      ? `${startTime}-${endTime}`
      : (startTime || endTime || '未知时间');
    return `${date} ${timeRange}`;
  },

  updateBookingModule(slots) {
    const list = Array.isArray(slots) ? slots : [];
    const available = list
      .filter((item) => this.isSlotAvailableForBooking(item))
      .sort((a, b) => this.buildSlotSortTime(a) - this.buildSlotSortTime(b));
    const nextSlot = available[0] || null;
    this.setData({
      bookingModule: {
        availableCount: available.length,
        nextSlotText: nextSlot ? this.formatSlotPreview(nextSlot) : '当前暂无预约课程',
        hasAvailable: available.length > 0
      }
    });
  },

  loadLessonPackageSummary() {
    if (!this.initCloud()) {
      this.updateBookingModule([]);
      this.setData({ lessonPackage: this.mapLessonPackage(null) });
      return Promise.resolve();
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listStudentBookableSlots',
        ...this.getScheduleViewerParams()
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        this.updateBookingModule([]);
        return;
      }
      const slots = Array.isArray(result.slots) ? result.slots : [];
      this.setData({ lessonPackage: this.mapLessonPackage(result.lessonPackage) });
      this.updateBookingModule(slots);
    }).catch(() => {
      this.updateBookingModule([]);
    });
  },

  loadRecentBookedSchedulesFromSlots() {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listStudentBookableSlots',
        ...this.getScheduleViewerParams()
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        return [];
      }
      const slots = Array.isArray(result.slots) ? result.slots : [];
      this.setData({ lessonPackage: this.mapLessonPackage(result.lessonPackage) });
      this.updateBookingModule(slots);
      return slots
        .filter((item) => !!(item && item.isBookedByMe))
        .map((item) => this.normalizeScheduleItem(item))
        .sort((a, b) => a.sortTime - b.sortTime)
        .slice(0, 3);
    }).catch(() => []);
  },

  loadRecentSchedules() {
    if (!this.initCloud()) {
      this.setData({ recentSchedules: [] });
      return Promise.resolve();
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listMyScheduleBookings',
        asBooker: true,
        ...this.getScheduleViewerParams()
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'list_my_schedule_bookings_failed'));
      }
      const bookings = Array.isArray(result.bookings) ? result.bookings : [];
      const normalized = bookings
        .map((item) => this.normalizeScheduleItem(item))
        .sort((a, b) => a.sortTime - b.sortTime);
      const notEnded = normalized.filter((item) => item.statusClass !== 'completed');
      const ended = normalized.filter((item) => item.statusClass === 'completed');
      const ordered = notEnded.length > 0 ? notEnded.concat(ended) : normalized;
      const displayList = ordered.slice(0, 3);
      if (displayList.length > 0) {
        this.setData({ recentSchedules: displayList });
        return;
      }
      return this.loadRecentBookedSchedulesFromSlots().then((fallbackList) => {
        this.setData({ recentSchedules: fallbackList });
      });
    }).catch((error) => {
      console.error('load recent schedules failed:', error);
      return this.loadRecentBookedSchedulesFromSlots()
        .then((fallbackList) => {
          this.setData({ recentSchedules: fallbackList });
        })
        .catch(() => {
          this.setData({ recentSchedules: [] });
        });
    });
  },

  loadNotificationUnreadCount() {
    if (!this.initCloud()) {
      return Promise.resolve();
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'getNotificationUnreadCount',
        ...this.getScheduleViewerParams(),
        excludeTypes: ['schedule_booking']
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        return;
      }
      this.setData({ unreadNotificationCount: Number(result.unreadCount || 0) });
    }).catch(() => {});
  },

  goToNotificationList() {
    wx.navigateTo({ url: '/pages/notification/list/list?mode=student' });
  },

  navigateSchedulePage(url) {
    if (this._navigatingSchedulePage) {
      return;
    }
    this._navigatingSchedulePage = true;
    wx.navigateTo({
      url,
      complete: () => {
        setTimeout(() => {
          this._navigatingSchedulePage = false;
        }, 500);
      }
    });
  },

  goToScheduleList() {
    this.navigateSchedulePage('/pages/student/schedule/list/list?view=student');
  },

  goToBookedScheduleList() {
    this.navigateSchedulePage('/pages/booking/my-booking/my-booking');
  },

  goToJoinClass() {
    wx.navigateTo({
      url: '/pages/student/join-class/join-class',
    });
  }
});



