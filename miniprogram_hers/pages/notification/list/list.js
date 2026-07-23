Page({
  data: {
    notifications: [],
    unreadCount: 0,
    isStudentMode: false,
    modeLock: "",
    loading: false,
    loadError: "",
    markingAllRead: false,
  },

  onLoad(options) {
    const modeLock = String(options && options.mode ? options.mode : "").trim().toLowerCase();
    this.setData({
      modeLock,
      isStudentMode: modeLock ? modeLock === "student" : this.resolveStudentMode(),
    });
    this.loadNotifications();
  },

  onShow() {
    this.setData({
      isStudentMode: this.data.modeLock
        ? this.data.modeLock === "student"
        : this.resolveStudentMode(),
    });
    this.loadNotifications();
  },

  onPullDownRefresh() {
    this.loadNotifications(true);
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

  resolveStudentMode() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const roleList = [
      wx.getStorageSync("accountRole"),
      wx.getStorageSync("userRole"),
      localUserInfo.role,
    ];
    const hasCoachAccess = roleList.some((role) => {
      const raw = String(role || "").trim().toLowerCase();
      return raw === "coach" || raw === "admin";
    });
    return !hasCoachAccess;
  },

  getLocalUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return String(userInfo.id || userInfo._id || "").trim();
  },

  getCoachNotificationTypes() {
    return ["schedule_booking", "schedule_slot_published"];
  },

  buildNotificationViewerParams() {
    const params = {
      expectedRole: this.data.isStudentMode ? "student" : "coach_or_admin",
    };

    if (this.data.isStudentMode) {
      // 学生端优先使用云端当前 openid 解析身份，避免本地缓存 userId 过期导致查到旧账号数据。
      params.excludeTypes = ["schedule_booking"];
      return params;
    }

    const userId = this.getLocalUserId();
    if (userId) {
      params.userId = userId;
      params.preferUserId = true;
    }
    params.includeTypes = this.getCoachNotificationTypes();
    return params;
  },

  normalizeDate(value) {
    if (!value) {
      return "-";
    }
    let dateObj = null;
    if (value instanceof Date) {
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

  getFallbackTextByType(type, senderName, title) {
    const sender = senderName || "教练";
    if (type === "training_report") {
      return `${sender} 发布了训练报告`;
    }
    if (type === "schedule_slot_published") {
      return `${sender} 发布了新课程，快去预约`;
    }
    if (type === "schedule_slot_cancelled") {
      return "课程安排有变动，请及时查看";
    }
    if (type === "schedule_booking") {
      return `${sender || "学员"} 提交了课程预约`;
    }
    if (type === "community_comment_reply") {
      return `${sender} 回复了你的评论`;
    }
    if (type === "community_post_reply") {
      return `${sender} 回复了你的帖子`;
    }
    if (type === "community_post_comment") {
      return `${sender} 评论了你的帖子`;
    }
    return title || "系统通知";
  },

  getNotificationMeta(type, content, title) {
    const safeType = String(type || "").trim().toLowerCase();
    const text = `${String(title || "")} ${String(content || "")}`.toLowerCase();

    if (safeType === "training_report") {
      return {
        categoryKey: "report",
        categoryLabel: "训练报告发布",
        icon: "/images/icons/notification-report.svg",
        accentClass: "accent-report",
      };
    }

    if (safeType === "schedule_slot_published") {
      return {
        categoryKey: "course",
        categoryLabel: "教练发布课程",
        icon: "/images/icons/notification-course.svg",
        accentClass: "accent-course",
      };
    }

    if (
      safeType === "schedule_booking"
      || safeType === "schedule_slot_cancelled"
      || safeType.includes("schedule")
      || safeType.includes("reminder")
    ) {
      return {
        categoryKey: "reminder",
        categoryLabel: "课程提醒",
        icon: "/images/icons/notification-reminder.svg",
        accentClass: "accent-reminder",
      };
    }

    if (
      safeType.includes("flower")
      || safeType.includes("reward")
      || text.includes("小红花")
      || text.includes("奖励")
    ) {
      return {
        categoryKey: "reward",
        categoryLabel: "小红花奖励",
        icon: "/images/icons/notification-reward.svg",
        accentClass: "accent-reward",
      };
    }

    return {
      categoryKey: "system",
      categoryLabel: "系统通知",
      icon: "/images/icons/notification-system.svg",
      accentClass: "accent-system",
    };
  },

  normalizeItem(item) {
    const safeItem = item || {};
    const type = String(safeItem.type || "system").trim().toLowerCase();
    const senderName = String(safeItem.senderName || "").trim();
    const title = String(safeItem.title || "").trim() || "系统通知";
    const content = String(safeItem.content || "").trim();
    const isBookingMessage = type === "schedule_booking";
    const isSchedulePublishMessage = type === "schedule_slot_published";
    let displayText = content || title;

    if (type === "training_report") {
      displayText = `${senderName || "教练"} 发布了训练报告`;
    } else if (type === "schedule_slot_published") {
      displayText = `${senderName || "教练"} 发布了新课程`;
    } else if (type === "schedule_slot_cancelled") {
      displayText = "你预约的课程有变动";
    } else if (type === "schedule_booking") {
      displayText = `${senderName || "学员"} 提交了课程预约`;
    } else if (type === "community_comment_reply") {
      displayText = `${senderName || "用户"} 回复了你的评论`;
    } else if (type === "community_post_reply") {
      displayText = `${senderName || "用户"} 回复了你的帖子`;
    } else if (type === "community_post_comment") {
      displayText = `${senderName || "用户"} 评论了你的帖子`;
    }

    if (!displayText) {
      displayText = this.getFallbackTextByType(type, senderName, title);
    }

    const meta = this.getNotificationMeta(type, displayText, title);
    return {
      id: safeItem.id || safeItem._id || "",
      type,
      relatedType: String(safeItem.relatedType || "").toLowerCase(),
      senderName,
      title,
      content,
      displayText,
      displayTitle: meta.categoryLabel,
      displaySummary: displayText || title,
      icon: meta.icon,
      categoryKey: meta.categoryKey,
      categoryLabel: meta.categoryLabel,
      accentClass: meta.accentClass,
      isBookingMessage,
      isSchedulePublishMessage,
      relatedPath: safeItem.relatedPath || "",
      isRead: !!safeItem.isRead,
      timeText: this.normalizeDate(safeItem.createdAt || safeItem.updatedAt),
    };
  },

  loadNotifications(isPullDown) {
    if (!this.initCloud()) {
      this.setData({
        loading: false,
        loadError: "当前基础库不支持云开发",
      });
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return Promise.resolve();
    }

    this.setData({
      loading: true,
      loadError: "",
    });

    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listNotifications",
        ...this.buildNotificationViewerParams(),
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || "");
          if (msg.includes("user_not_found")) {
            this.setData({
              notifications: [],
              unreadCount: 0,
              loadError: "当前账号还没有同步到通知数据",
            });
            return;
          }
          throw new Error(msg || "list_notifications_failed");
        }

        const list = Array.isArray(result.notifications) ? result.notifications : [];
        const normalizedList = list.map((entry) => this.normalizeItem(entry));
        const finalList = this.data.isStudentMode
          ? normalizedList.filter((entry) => !entry.isBookingMessage)
          : normalizedList.filter((entry) => entry.isBookingMessage || entry.isSchedulePublishMessage);
        const unreadCount = finalList.reduce((count, entry) => (entry.isRead ? count : count + 1), 0);

        this.setData({
          notifications: finalList,
          unreadCount,
        });
      })
      .catch((error) => {
        console.error("load notifications failed:", error);
        this.setData({
          notifications: [],
          unreadCount: 0,
          loadError: "加载通知失败",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  },

  markSingleRead(id) {
    if (!id || !this.initCloud()) {
      return Promise.resolve();
    }
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "markNotificationRead",
        notificationId: id,
        ...this.buildNotificationViewerParams(),
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        return;
      }

      let unreadCount = this.data.unreadCount;
      const list = (this.data.notifications || []).map((entry) => {
        if (entry.id !== id || entry.isRead) {
          return entry;
        }
        unreadCount = Math.max(0, unreadCount - 1);
        return {
          ...entry,
          isRead: true,
        };
      });

      this.setData({
        notifications: list,
        unreadCount,
      });
    }).catch(() => {});
  },

  markAllRead() {
    if (this.data.markingAllRead) {
      return;
    }

    if (!this.data.unreadCount) {
      wx.showToast({
        title: "暂无未读消息",
        icon: "none",
      });
      return;
    }

    if (!this.initCloud()) {
      wx.showToast({
        title: "云开发不可用",
        icon: "none",
      });
      return;
    }

    this.setData({ markingAllRead: true });

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "markAllNotificationsRead",
        ...this.buildNotificationViewerParams(),
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(result.message || "mark_all_notifications_read_failed");
      }

      const list = (this.data.notifications || []).map((entry) => ({
        ...entry,
        isRead: true,
      }));

      this.setData({
        notifications: list,
        unreadCount: 0,
      });

      wx.showToast({
        title: "已全部已读",
        icon: "success",
      });
    }).catch((error) => {
      console.error("mark all notifications read failed:", error);
      wx.showToast({
        title: "操作失败",
        icon: "none",
      });
    }).finally(() => {
      this.setData({ markingAllRead: false });
    });
  },

  openNotificationDetail(item) {
    const safeItem = item || {};
    const isBookingMessage = safeItem.type === "schedule_booking" || safeItem.isBookingMessage;
    const title = encodeURIComponent(String(isBookingMessage ? "课程预约" : (safeItem.title || "消息详情")));
    const content = encodeURIComponent(String(
      isBookingMessage
        ? (safeItem.content || safeItem.displayText || "")
        : (safeItem.displayText || safeItem.content || "")
    ));
    const timeText = encodeURIComponent(String(safeItem.timeText || ""));
    const categoryLabel = encodeURIComponent(String(safeItem.categoryLabel || "系统通知"));
    const senderName = encodeURIComponent(String(safeItem.senderName || "系统"));
    const type = encodeURIComponent(String(safeItem.type || "system"));
    wx.navigateTo({
      url: `/pages/notification/detail/detail?title=${title}&content=${content}&timeText=${timeText}&categoryLabel=${categoryLabel}&senderName=${senderName}&type=${type}`,
    });
  },

  tapItem(e) {
    const id = String(e.currentTarget.dataset.id || "");
    const targetItem = (this.data.notifications || []).find((entry) => entry.id === id) || {};
    this.markSingleRead(id).finally(() => {
      this.openNotificationDetail(targetItem);
    });
  },
});
