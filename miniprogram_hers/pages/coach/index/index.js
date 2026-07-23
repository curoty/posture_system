const COLLECTION_NAME = {
  USERS: "users",
};
const { hasAdminAccessInStorage, isBuiltinAdminInStorage } = require("../../../utils/permission");
const { FEATURE_GATES } = require("../../../utils/feature-gates");

const LEVEL_LABEL_BY_CODE = {
  1: "助理教练",
  2: "初级教练员",
  3: "中级教练员",
  4: "高级教练员",
};

const plugin = requirePlugin("WechatSI");

Page({
  _cloudInited: false,
  _loadAllDataPromise: null,
  _lastLoadAllDataAt: 0,

  data: {
    isAdmin: false,
    canManageAdminAccess: false,
    canUseSensorDebug: false,
    canPublishSchedule: false,
    coachInfo: {
      name: "教练",
      avatarUrl: "",
      levelLabel: "",
    },
    stats: {
      studentCount: 0,
      todayCourseCount: 0,
      notificationCount: 0,
    },
    unreadNotificationCount: 0,
    recentSchedules: [],
    loading: false,
    loadError: "",

    deviceConnected: false,
    transportMode: "ble",
    analyzing: false,
    latestAnalyzeScore: 0,
    latestAnalyzeLevel: "",
    weightShiftTip: "",
    _voiceCtx: null,
    voicePlaying: false,
  },

  onLoad(options) {
    const accountRole = String(wx.getStorageSync("accountRole") || "").toLowerCase();
    if (accountRole === "admin") {
      wx.setStorageSync("userRole", "admin");
    } else if (accountRole === "coach") {
      wx.setStorageSync("userRole", "coach");
    }
    if (options && options.role) {
      wx.setStorageSync("userRole", options.role);
    }

    const isAdmin = this.isAdminAccount();
    this.setData({
      isAdmin,
      canManageAdminAccess: this.canManageAdminAccess(),
      canUseSensorDebug: this.canUseSensorDebug(),
      canPublishSchedule: this.canPublishSchedule(),
    });
    this.syncNavigationTitle(isAdmin);

    const app = getApp();
    if (app && typeof app.requestScheduleBookingSubscribe === "function") {
      app.requestScheduleBookingSubscribe({ silent: true }).catch(() => null);
    }
    this.loadAllData();
  },

  onShow() {
    const isAdmin = this.isAdminAccount();
    const app = getApp();
    const config = app && app.globalData && app.globalData.wearableBleConfig ? app.globalData.wearableBleConfig : {};
    const transport = String(config.transport || "ble").trim().toLowerCase();
    
    this.setData({
      isAdmin,
      canManageAdminAccess: this.canManageAdminAccess(),
      canUseSensorDebug: this.canUseSensorDebug(),
      canPublishSchedule: this.canPublishSchedule(),
      transportMode: transport,
    });
    this.syncNavigationTitle(isAdmin);

    if (Date.now() - this._lastLoadAllDataAt > 1200) {
      this.loadAllData();
    }
  },

  onPullDownRefresh() {
    this.loadAllData(true);
  },

  isAdminAccount() {
    if (isBuiltinAdminInStorage()) {
      return true;
    }
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roleList = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    return roleList.some((role) => String(role || "").trim().toLowerCase() === "admin");
  },

  canManageAdminAccess() {
    return hasAdminAccessInStorage();
  },

  canUseSensorDebug() {
    if (this.isAdminAccount()) {
      return true;
    }
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roles = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    return roles.some((role) => String(role || "").trim().toLowerCase() === "coach");
  },

  canPublishSchedule() {
    if (this.isAdminAccount()) {
      return true;
    }
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roles = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    return roles.some((role) => String(role || "").trim().toLowerCase() === "coach");
  },

  syncNavigationTitle(isAdmin) {
    if (typeof wx.setNavigationBarTitle !== "function") {
      return;
    }
    wx.setNavigationBarTitle({
      title: isAdmin ? "管理员首页" : "教练首页",
    });
  },

  loadAllData(isPullDown) {
    if (this._loadAllDataPromise) {
      return this._loadAllDataPromise;
    }
    this._lastLoadAllDataAt = Date.now();
    this.setData({ loading: true, loadError: "" });

    const tasks = this.data.isAdmin
      ? [this.loadCoachInfo(), this.loadStats(), this.loadNotificationUnreadCount()]
      : [this.loadCoachInfo(), this.loadStats(), this.loadRecentSchedules(), this.loadNotificationUnreadCount()];

    this._loadAllDataPromise = Promise.allSettled(tasks)
      .then((results) => {
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length === results.length) {
          console.error("load all coach data failed:", failures);
          this.setData({ loadError: "加载数据失败，请重试" });
        }
      })
      .finally(() => {
        this.setData({ loading: false });
        this._loadAllDataPromise = null;
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
      });
    return this._loadAllDataPromise;
  },

  loadNotificationUnreadCount() {
    if (!this.initCloud()) {
      return Promise.resolve();
    }

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "getNotificationUnreadCount",
        userId: this.getCurrentUserId(),
        preferUserId: true,
        expectedRole: "coach_or_admin",
        includeTypes: ["schedule_booking", "schedule_slot_published"],
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return;
        }
        const unreadCount = Number(result.unreadCount || 0);
        this.setData({
          unreadNotificationCount: unreadCount,
          "stats.notificationCount": unreadCount,
        });
      })
      .catch(() => {});
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
      traceUser: true,
    });
    this._cloudInited = true;
    return true;
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  loadSharedStudentCount(db, coachIdInput) {
    const _ = db.command;
    const coachId = String(coachIdInput || this.getCurrentUserId() || "").trim();
    const countCachedStudentsFallback = () => {
      const countCacheMap = wx.getStorageSync("coachSharedStudentCountMap") || {};
      const fallback = coachId
        ? countCacheMap[coachId]
        : wx.getStorageSync("coachSharedStudentCountLast");
      return Math.max(0, Number(fallback || 0));
    };
    if (!coachId) {
      return Promise.resolve(countCachedStudentsFallback());
    }
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listCoachSharedStudents",
        userId: coachId,
        preferUserId: true,
        expectedRole: "coach_or_admin",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(String(result.message || "list_coach_shared_students_failed"));
        }
        const students = Array.isArray(result.students) ? result.students : [];
        const map = {};
        students.forEach((item) => {
          const safe = item && typeof item === "object" ? item : {};
          const role = String(safe.role || "").trim().toLowerCase();
          const roles = Array.isArray(safe.roles) ? safe.roles : [];
          const roleList = [role].concat(roles.map((r) => String(r || "").trim().toLowerCase()));
          if (roleList.includes("coach") || roleList.includes("admin")) {
            return;
          }
          const id = String(safe._id || safe.id || safe.openid || safe._openid || "").trim();
          if (!id || map[id]) {
            return;
          }
          map[id] = true;
        });
        const cloudVisibleCount = Object.keys(map).length;
        if (cloudVisibleCount > 0) {
          return cloudVisibleCount;
        }
        throw new Error("list_coach_shared_students_empty");
      })
      .catch((error) => {
        console.warn("load shared student count failed, fallback to local shared query:", error);
        const normalizeId = (value) => String(value || "").trim();
        const normalizePhone = (value) => String(value || "").replace(/\s+/g, "");
        const normalizeRole = (value) => String(value || "").trim().toLowerCase();
        const mergeUniqueIds = (...inputs) => {
          const set = new Set();
          (inputs || []).forEach((input) => {
            const arr = Array.isArray(input) ? input : [input];
            arr.forEach((item) => {
              const id = normalizeId(item);
              if (id) {
                set.add(id);
              }
            });
          });
          return Array.from(set);
        };
        const extractOwnerIds = (user) => {
          const safe = user && typeof user === "object" ? user : {};
          return mergeUniqueIds(
            safe.adminOwnerId,
            safe.adminOwnerID,
            safe.ownerId,
            safe.ownerID,
            Array.isArray(safe.adminOwnerIds) ? safe.adminOwnerIds : [],
            Array.isArray(safe.adminOwnerIDs) ? safe.adminOwnerIDs : [],
            Array.isArray(safe.ownerIds) ? safe.ownerIds : [],
            Array.isArray(safe.ownerIDs) ? safe.ownerIDs : []
          );
        };
        const extractCoachIds = (user) => {
          const safe = user && typeof user === "object" ? user : {};
          return mergeUniqueIds(
            safe.coachId,
            safe.coachID,
            safe.coachid,
            safe.coachOwnerId,
            safe.coachOwnerID,
            safe.coachOpenId,
            safe.coachOpenID,
            Array.isArray(safe.coachIds) ? safe.coachIds : [],
            Array.isArray(safe.coachIDs) ? safe.coachIDs : [],
            Array.isArray(safe.coachids) ? safe.coachids : [],
            Array.isArray(safe.coachOwnerIds) ? safe.coachOwnerIds : [],
            Array.isArray(safe.coachOwnerIDs) ? safe.coachOwnerIDs : [],
            Array.isArray(safe.coachOpenIds) ? safe.coachOpenIds : [],
            Array.isArray(safe.coachOpenIDs) ? safe.coachOpenIDs : []
          );
        };
        const isCoachOrAdmin = (user) => {
          const role = normalizeRole(user && user.role);
          return role === "coach" || role === "admin";
        };
        const fetchUserById = (id) => {
          const safeId = normalizeId(id);
          if (!safeId) {
            return Promise.resolve(null);
          }
          return db.collection(COLLECTION_NAME.USERS).doc(safeId).get()
            .then((res) => (res && res.data ? res.data : null))
            .catch(() => null);
        };
        return fetchUserById(coachId)
          .then((coachDoc) => {
            const ownerIds = extractOwnerIds(coachDoc);
            const coachKeys = mergeUniqueIds(
              coachId,
              normalizeId(coachDoc && coachDoc.openid),
              normalizeId(coachDoc && coachDoc._openid),
              normalizePhone(coachDoc && coachDoc.phone),
              extractCoachIds(coachDoc),
              ownerIds
            );
            const byCoachQuery = coachKeys.length
              ? db.collection(COLLECTION_NAME.USERS).where(_.or([
                { coachId: _.in(coachKeys) },
                { coachID: _.in(coachKeys) },
                { coachIds: _.in(coachKeys) },
                { coachIDs: _.in(coachKeys) },
                { coachids: _.in(coachKeys) },
                { coachOwnerId: _.in(coachKeys) },
                { coachOwnerID: _.in(coachKeys) },
                { coachOwnerIds: _.in(coachKeys) },
                { coachOwnerIDs: _.in(coachKeys) },
                { coachOpenId: _.in(coachKeys) },
                { coachOpenID: _.in(coachKeys) },
                { coachOpenIds: _.in(coachKeys) },
                { coachOpenIDs: _.in(coachKeys) },
              ])).limit(1000).get().catch(() => ({ data: [] }))
              : Promise.resolve({ data: [] });
            const byOwnerQuery = ownerIds.length
              ? db.collection(COLLECTION_NAME.USERS).where(_.or([
                { adminOwnerId: _.in(ownerIds) },
                { adminOwnerID: _.in(ownerIds) },
                { adminOwnerIds: _.in(ownerIds) },
                { adminOwnerIDs: _.in(ownerIds) },
                { ownerId: _.in(ownerIds) },
                { ownerID: _.in(ownerIds) },
                { ownerIds: _.in(ownerIds) },
                { ownerIDs: _.in(ownerIds) },
              ])).limit(1000).get().catch(() => ({ data: [] }))
              : Promise.resolve({ data: [] });
            return Promise.all([byCoachQuery, byOwnerQuery]);
          })
          .then(([byCoachRes, byOwnerRes]) => {
            const merged = []
              .concat(Array.isArray(byCoachRes && byCoachRes.data) ? byCoachRes.data : [])
              .concat(Array.isArray(byOwnerRes && byOwnerRes.data) ? byOwnerRes.data : []);
            const map = {};
            merged.forEach((item) => {
              const id = normalizeId(item && (item._id || item.id || item.openid || item._openid));
              if (!id || map[id] || isCoachOrAdmin(item)) {
                return;
              }
              map[id] = true;
            });
            const localSharedCount = Object.keys(map).length;
            if (localSharedCount > 0) {
              return localSharedCount;
            }
            return countCachedStudentsFallback();
          })
          .catch(() => countCachedStudentsFallback());
      });
  },

  getDefaultCoachInfo() {
    return {
      name: "教练",
      avatarUrl: "",
      levelLabel: "",
    };
  },

  normalizeAvatarUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    const lower = raw.toLowerCase();
    if (lower === "none" || lower === "null" || lower === "undefined") {
      return "";
    }
    if (
      lower.includes("/__tmp__/")
      || lower.startsWith("http://127.0.0.1")
      || lower.startsWith("wxfile://")
      || lower.startsWith("file://")
      || lower.startsWith("blob:")
    ) {
      return "";
    }
    return raw;
  },

  resolveCoachLevelLabel(level) {
    if (typeof level === "number" && Number.isFinite(level)) {
      return LEVEL_LABEL_BY_CODE[level] || "";
    }
    const raw = String(level || "").trim();
    if (!raw) {
      return "";
    }
    if (LEVEL_LABEL_BY_CODE[raw]) {
      return LEVEL_LABEL_BY_CODE[raw];
    }
    if (Object.values(LEVEL_LABEL_BY_CODE).includes(raw)) {
      return raw;
    }

    const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
    const aliasCode = {
      assistant: "1",
      junior: "2",
      primary: "2",
      intermediate: "3",
      middle: "3",
      senior: "4",
    }[normalized];
    return LEVEL_LABEL_BY_CODE[aliasCode] || "";
  },

  buildCoachInfo(item) {
    const safeItem = item || {};
    return {
      name: safeItem.name || "教练",
      avatarUrl: this.normalizeAvatarUrl(safeItem.avatarUrl),
      levelLabel: this.resolveCoachLevelLabel(safeItem.level),
    };
  },

  fetchUserById(db, userId) {
    if (!userId) {
      return Promise.resolve(null);
    }
    return db.collection(COLLECTION_NAME.USERS)
      .doc(userId)
      .get()
      .then((res) => (res && res.data ? res.data : null))
      .catch(() => null);
  },

  fetchAnyCoach(db) {
    return db.collection(COLLECTION_NAME.USERS)
      .where({ role: "coach" })
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        return list.length ? list[0] : null;
      });
  },

  syncLocalCoachInfo(coachDoc) {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    if (!localUserInfo || (!localUserInfo.id && !localUserInfo._id)) {
      return;
    }

    wx.setStorageSync("userInfo", {
      ...localUserInfo,
      name: coachDoc.name || localUserInfo.name || "",
      avatarUrl: this.normalizeAvatarUrl(coachDoc.avatarUrl) || this.normalizeAvatarUrl(localUserInfo.avatarUrl),
      level: typeof coachDoc.level === "undefined" ? localUserInfo.level : coachDoc.level,
    });
  },

  loadCoachInfo() {
    if (!this.initCloud()) {
      this.setData({ coachInfo: this.getDefaultCoachInfo() });
      return Promise.resolve();
    }

    const db = wx.cloud.database();
    const userId = this.getCurrentUserId();
    const request = userId
      ? this.fetchUserById(db, userId).then((doc) => {
        const role = String(doc && doc.role ? doc.role : "").toLowerCase();
        if (doc && (role === "coach" || role === "admin")) {
          return doc;
        }
        return this.fetchAnyCoach(db);
      })
      : this.fetchAnyCoach(db);

    return Promise.resolve(request)
      .then((coachDoc) => {
        if (!coachDoc) {
          this.setData({ coachInfo: this.getDefaultCoachInfo() });
          return;
        }
        this.setData({
          coachInfo: this.buildCoachInfo(coachDoc),
        });
        this.syncLocalCoachInfo(coachDoc);
      })
      .catch((error) => {
        console.error("load coach info failed:", error);
        this.setData({ coachInfo: this.getDefaultCoachInfo() });
      });
  },

  getTodayText() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  },

  loadStats() {
    if (!this.initCloud()) {
      return Promise.resolve();
    }

    const db = wx.cloud.database();
    const coachId = this.getCurrentUserId();
    const getStudentCount = this.loadSharedStudentCount(db, coachId).catch(() => 0);
    const getScheduleSlots = wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listCoachScheduleSlots",
        userId: coachId,
        preferUserId: !!coachId,
        expectedRole: "coach_or_admin",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        return result.success && Array.isArray(result.slots) ? result.slots : [];
      })
      .catch(() => []);
    return Promise.all([getStudentCount, getScheduleSlots])
      .then(([studentsResult, slotsResult]) => {
        const todayText = this.getTodayText();
        const todayCourseCount = (Array.isArray(slotsResult) ? slotsResult : []).filter((item) => {
          const date = String(item && item.date ? item.date : "").trim();
          return date === todayText;
        }).length;
        this.setData({
          stats: {
            studentCount: Math.max(0, Number(studentsResult || 0)),
            todayCourseCount: Math.max(0, Number(todayCourseCount || 0)),
            notificationCount: Math.max(0, Number(this.data.unreadNotificationCount || 0)),
          },
        });
      })
      .catch((error) => {
        console.error("load coach stats failed:", error);
        this.setData({
          stats: {
            studentCount: 0,
            todayCourseCount: 0,
            notificationCount: Math.max(0, Number(this.data.unreadNotificationCount || 0)),
          },
        });
      });
  },

  formatMonthDay(dateText) {
    const raw = String(dateText || "").trim();
    const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) {
      return "待定";
    }
    return `${String(match[2]).padStart(2, "0")}.${String(match[3]).padStart(2, "0")}`;
  },

  formatWeekday(dateText) {
    const raw = String(dateText || "").trim();
    const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!match) {
      return "待定";
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const weekdayMap = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return weekdayMap[date.getDay()] || "待定";
  },

  extractScheduleTitle(item) {
    const safe = item || {};
    return String(
      safe.title
      || safe.courseName
      || safe.name
      || safe.scheduleTitle
      || "课程待定"
    ).trim();
  },

  extractVenueText(item) {
    const safe = item || {};
    return String(
      safe.venue
      || safe.location
      || safe.place
      || safe.gymName
      || safe.address
      || "场馆待定"
    ).trim();
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

  buildScheduleStatus(startTs, endTs) {
    if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
      return { text: "待上课", className: "pending" };
    }
    const now = Date.now();
    if (now < startTs) {
      return { text: "待上课", className: "pending" };
    }
    if (now >= startTs && now <= endTs) {
      return { text: "进行中", className: "active" };
    }
    return { text: "已结束", className: "completed" };
  },

  loadRecentSchedules() {
    if (!this.initCloud()) {
      this.setData({ recentSchedules: [] });
      return Promise.resolve();
    }

    const currentUserId = this.getCurrentUserId();
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listCoachScheduleSlots",
        userId: currentUserId,
        preferUserId: !!currentUserId,
        expectedRole: "coach_or_admin",
        lightweight: true,
        limit: 8,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || "");
          if (msg === "permission_denied") {
            this.setData({ recentSchedules: [] });
            return;
          }
          throw new Error(msg || "list_coach_schedule_slots_failed");
        }
        const slots = Array.isArray(result.slots) ? result.slots : [];
        const cards = slots
          .map((item) => {
            const safe = item || {};
            const date = String(safe.date || "").trim();
            const startTime = String(safe.startTime || "").trim();
            const endTime = String(safe.endTime || "").trim();
            const endTs = this.buildScheduleTimestamp(date, endTime || startTime);
            const startTs = this.buildScheduleTimestamp(date, startTime);
            const statusInfo = this.buildScheduleStatus(startTs, endTs);
            const timeRange = startTime && endTime
              ? `${startTime}-${endTime}`
              : (startTime || endTime || "时间待定");
            return {
              id: String(safe.id || safe._id || "").trim(),
              monthDay: this.formatMonthDay(date),
              weekday: this.formatWeekday(date),
              scheduleTime: timeRange,
              title: this.extractScheduleTitle(safe),
              venue: this.extractVenueText(safe),
              statusText: statusInfo.text,
              statusClass: statusInfo.className,
              sortTime: Number.isNaN(startTs) ? Number.MAX_SAFE_INTEGER : startTs,
            };
          })
          .filter((item) => item.id)
          .sort((a, b) => a.sortTime - b.sortTime);

        const notEnded = cards.filter((item) => item.statusClass !== "completed");
        const ended = cards.filter((item) => item.statusClass === "completed");
        const ordered = notEnded.length > 0 ? notEnded.concat(ended) : cards;
        this.setData({
          recentSchedules: ordered.slice(0, 4),
        });
      })
      .catch((error) => {
        console.error("load recent schedules failed:", error);
        this.setData({
          recentSchedules: [],
        });
      });
  },

  goToNotificationList() {
    wx.navigateTo({
      url: "/pages/notification/list/list?mode=coach",
    });
  },

  goToNotificationCenter() {
    this.goToNotificationList();
  },

  goToCommunityForum() {
    wx.reLaunch({
      url: "/pages/coach/community/manage/manage",
    });
  },

  goToStudentsList() {
    wx.navigateTo({
      url: "/pages/coach/students/list/list",
    });
  },

  goToProductPublish() {
    wx.navigateTo({
      url: "/pages/coach/activities/publish/publish",
    });
  },

  onTapSensorDebug() {
    if (!this.canUseSensorDebug()) {
      wx.showToast({ title: "当前账号无权限", icon: "none" });
      return;
    }
    if (!FEATURE_GATES.sensorComponentEnabled) {
      wx.showToast({
        title: FEATURE_GATES.sensorComponentLockMessage || "传感器组件功能维护中，暂未开放",
        icon: "none",
      });
      return;
    }
    wx.navigateTo({
      url: "/pages/coach/sensor/debug/debug",
    });
  },

  goToInvitation() {
    wx.navigateTo({
      url: "/pages/coach/invitation/invitation",
    });
  },

  canManageSchedule() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roles = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    return roles.some((role) => {
      const raw = String(role || "").trim().toLowerCase();
      return raw === "coach" || raw === "admin";
    });
  },

  goToSchedulePublish() {
    if (!this.canPublishSchedule()) {
      wx.showToast({ title: "仅教练或管理员可发布课程", icon: "none" });
      return;
    }
    wx.reLaunch({
      url: "/pages/coach/schedule/manage/manage",
    });
  },

  goToScheduleManage() {
    this.goToSchedulePublish();
  },

  goToScheduleBooking() {
    if (!this.canManageSchedule()) {
      wx.showToast({ title: "当前账号无权限", icon: "none" });
      return;
    }
    if (this._navigatingScheduleBooking) {
      return;
    }
    this._navigatingScheduleBooking = true;
    wx.navigateTo({
      url: "/pages/student/schedule/list/list?view=coach",
      complete: () => {
        setTimeout(() => {
          this._navigatingScheduleBooking = false;
        }, 500);
      },
    });
  },

  goToCourseList() {
    this.goToScheduleBooking();
  },

  goToBookedScheduleList() {
    if (!this.canManageSchedule()) {
      wx.showToast({ title: "当前账号无权限", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: "/pages/booking/my-booking/my-booking",
    });
  },

  goToMyScheduleBookings() {
    this.goToBookedScheduleList();
  },

  goToScheduleOverview() {
    this.goToBookedScheduleList();
  },

  goToReportList() {
    wx.navigateTo({
      url: "/pages/coach/report/list/list",
    });
  },

  goToUserManagement() {
    if (!this.isAdminAccount()) {
      wx.showToast({ title: "无权限", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: "/pages/admin/users/index/index",
    });
  },

  goToClassManagement() {
    wx.navigateTo({
      url: "/pages/coach/classes/index/index",
    });
  },

  onSmartCoachAction() {
    if (this.data.analyzing) {
      this.setData({ analyzing: false });
      wx.showToast({ title: "已停止分析", icon: "none" });
      return;
    }

    if (!this.data.deviceConnected) {
      wx.showToast({ title: "请先连接传感器设备", icon: "none" });
      this.simulateDeviceConnect();
      return;
    }

    this.setData({ analyzing: true });
    this.startAnalyzing();
  },

  simulateDeviceConnect() {
    const transport = this.data.transportMode === "wifi" ? "WiFi" : "蓝牙";
    wx.showLoading({ title: `正在连接${transport}...` });
    setTimeout(() => {
      wx.hideLoading();
      this.setData({ deviceConnected: true });
      wx.showToast({ title: `${transport}连接成功`, icon: "success" });
    }, 1500);
  },

  onToggleTransport() {
    const currentMode = this.data.transportMode || "ble";
    const newMode = currentMode === "ble" ? "wifi" : "ble";
    const modeName = newMode === "wifi" ? "WiFi" : "蓝牙";
    
    this.setData({
      transportMode: newMode,
      deviceConnected: false,
    });
    
    const app = getApp();
    if (app && typeof app.setDeviceTransport === "function") {
      app.setDeviceTransport(newMode);
    }
    
    wx.showToast({ title: `已切换至${modeName}模式`, icon: "success" });
  },

  startAnalyzing() {
    setTimeout(() => {
      this.setData({ analyzing: false });
      wx.showToast({ title: "请在传感器调试页进行真实分析", icon: "none", duration: 3000 });
      setTimeout(() => {
        wx.navigateTo({ url: "/pages/coach/sensor/debug/debug" });
      }, 1000);
    }, 500);
  },

  startAutoVoice() {
    const score = Number(this.data.latestAnalyzeScore) || 0;
    const level = String(this.data.latestAnalyzeLevel || "").trim();
    const tip = String(this.data.weightShiftTip || "").trim();
    const text = `分数${score}分，等级${level}。${tip}`;

    if (this.data._voiceCtx) {
      this.data._voiceCtx.destroy();
    }

    const ctx = wx.createInnerAudioContext();
    ctx.onEnded(() => {
      this.setData({ voicePlaying: false });
    });
    ctx.onStop(() => {
      this.setData({ voicePlaying: false });
    });
    ctx.onError(() => {
      this.setData({ voicePlaying: false });
    });

    this.setData({ _voiceCtx: ctx, voicePlaying: false });

    plugin.textToSpeech({
      lang: "zh_CN",
      tts: true,
      content: text,
      success: (res) => {
        ctx.src = res.filename;
        ctx.play();
        this.setData({ voicePlaying: true });
      },
      fail: () => {
        this.setData({ voicePlaying: false });
      }
    });
  },

  onSmartCoachVoice() {
    const ctx = this.data._voiceCtx;
    if (!ctx) {
      this.startAutoVoice();
      return;
    }
    if (this.data.voicePlaying) {
      ctx.pause();
      this.setData({ voicePlaying: false });
    } else {
      ctx.play();
      this.setData({ voicePlaying: true });
    }
  },
});

