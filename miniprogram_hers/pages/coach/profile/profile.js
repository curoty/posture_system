const COLLECTION_NAME = {
  USERS: "users",
};

const LEVEL_LABEL_BY_CODE = {
  1: "助理教练",
  2: "初级教练员",
  3: "中级教练员",
  4: "高级教练员",
};
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 32;

Page({
  data: {
    isAdmin: false,
    coachInfo: {
      id: "",
      name: "未设置",
      phone: "",
      organization: "",
      joinDate: "",
      avatarUrl: "",
      levelLabel: "",
      teachingYearsText: "未设置",
      certificationText: "待认证",
    },
    stats: {
      studentCount: 0,
      courseCount: 0,
      publishedCourseCount: 0,
      reviewCount: 0,
    },
    showOrgModal: false,
    organizationList: [],
    selectedOrgIds: [],
  },

  onLoad() {
    const accountRole = String(wx.getStorageSync("accountRole") || "").toLowerCase();
    if (accountRole === "coach") {
      wx.setStorageSync("userRole", "coach");
    } else if (accountRole === "admin") {
      wx.setStorageSync("userRole", "admin");
    }
    const isAdmin = this.isAdminAccount();
    this.setData({ isAdmin });
    this.loadAllData();
  },

  onShow() {
    const isAdmin = this.isAdminAccount();
    this.setData({ isAdmin });
    this.loadAllData();
  },

  isAdminAccount() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const role = String(localUserInfo.role || "").trim().toLowerCase();
    const storedRole = String(wx.getStorageSync("userRole") || "").toLowerCase();
    return role === "admin" || storedRole === "admin";
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({ env: getApp().globalData.env, traceUser: true });
    return true;
  },

  callPasswordCloudFunction(type, payload) {
    if (!this.initCloud()) {
      return Promise.reject(new Error("cloud_not_supported"));
    }
    const coachId = this.getCurrentCoachId();
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type,
        userId: coachId,
        preferUserId: !!coachId,
        ...(payload || {}),
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === "undefined") {
        throw new Error("function_not_updated");
      }
      if (!result.success) {
        throw new Error(String(result.message || `${type}_failed`));
      }
      return result;
    });
  },

  resolvePasswordErrorMessage(error, fallback) {
    const raw = String((error && (error.message || error.errMsg)) || "").toLowerCase();
    if (raw.includes("cloud_not_supported")) return "云能力不可用";
    if (raw.includes("old_password_required")) return "请输入当前密码";
    if (raw.includes("old_password_incorrect")) return "当前密码不正确";
    if (raw.includes("password_too_short")) return "密码至少6位";
    if (raw.includes("password_same_as_old")) return "新密码不能与旧密码相同";
    if (raw.includes("password_not_set")) return "账号未设置密码";
    if (raw.includes("password_already_set")) return "账号已设置密码";
    if (raw.includes("account_disabled")) return "账号已被禁用";
    if (raw.includes("user_not_found")) return "用户不存在，请重新登录";
    if (raw.includes("function_not_updated")) return "请重新部署 quickstartFunctions";
    if (raw.includes("cloud.callfunction:fail") || raw.includes("request:fail") || raw.includes("network")) {
      return "网络异常，请重试";
    }
    return fallback || "操作失败，请重试";
  },

  getCurrentCoachId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return userInfo.id || userInfo._id || "";
  },

  getCurrentLocalUser() {
    return wx.getStorageSync("userInfo") || {};
  },

  loadSharedStudentCount(db, coachIdInput) {
    const _ = db.command;
    const coachId = String(coachIdInput || this.getCurrentCoachId() || "").trim();
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
      .catch(() => countCachedStudentsFallback());
  },

  getFileExt(filePath, fallbackExt) {
    const match = String(filePath || "").match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match && match[1] ? match[1].toLowerCase() : fallbackExt;
  },

  formatDate(value) {
    if (!value) return "";
    if (typeof value === "string") return value.slice(0, 10);

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

    if (!dateObj || Number.isNaN(dateObj.getTime())) return "";

    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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

  normalizeAvatarUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (lower === "none" || lower === "null" || lower === "undefined") return "";
    if (
      lower.includes("/__tmp__/")
      || lower.startsWith("http://127.0.0.1")
      || lower.startsWith("wxfile://")
      || lower.startsWith("file://")
      || lower.startsWith("blob:")
    ) return "";
    return raw;
  },

  resolveCoachLevelLabel(level) {
    if (typeof level === "number" && Number.isFinite(level)) {
      return LEVEL_LABEL_BY_CODE[level] || "";
    }
    const raw = String(level || "").trim();
    if (!raw) return "";

    if (LEVEL_LABEL_BY_CODE[raw]) return LEVEL_LABEL_BY_CODE[raw];
    if (Object.values(LEVEL_LABEL_BY_CODE).includes(raw)) return raw;

    const aliasMap = {
      助理教练: "1",
      初级教练: "2",
      中级教练: "3",
      高级教练: "4",
    };
    const aliasCode = aliasMap[raw];
    if (aliasCode) {
      return LEVEL_LABEL_BY_CODE[aliasCode] || "";
    }
    return "";
  },

  getTeachingYearsText(joinDate, teachYear) {
    if (typeof teachYear === "number" && teachYear > 0) {
      return `${teachYear}年`;
    }
    if (teachYear && typeof teachYear === "string") {
      const num = Number(teachYear);
      if (num > 0) {
        return `${num}年`;
      }
    }
    const raw = String(joinDate || "").trim();
    const match = raw.match(/^(\d{4})/);
    if (!match) {
      return "未设置";
    }
    const joinYear = Number(match[1]);
    const currentYear = new Date().getFullYear();
    if (!joinYear || joinYear > currentYear) {
      return "未设置";
    }
    const years = Math.max(1, currentYear - joinYear + 1);
    return `${years}年`;
  },

  getCertificationText(status) {
    const map = {
      "": "未认证",
      "未认证": "未认证",
      "待审核": "审核中",
      "已认证": "已认证",
      "已拒绝": "审核未通过",
    };
    return map[status] || "未认证";
  },

  goCertification() {
    wx.navigateTo({
      url: "/pages/coach/certification/certification",
    });
  },

  buildCoachInfo(item, organizations) {
    const safeItem = item || {};
    const joinDate = this.formatDate(safeItem.joinDate || safeItem.createdAt) || "未设置";
    const levelLabel = this.resolveCoachLevelLabel(safeItem.level);
    const teachYear = safeItem.teachYear;
    
    const orgIds = Array.isArray(safeItem.orgIds) ? safeItem.orgIds : [];
    const orgList = Array.isArray(organizations) ? organizations : [];
    const matchedOrgs = orgList.filter(org => orgIds.includes(org._id));
    const organization = matchedOrgs.length > 0 ? matchedOrgs.map(o => o.name).join("、") : safeItem.organization || "";
    
    const certificationStatus = String(safeItem.certificationStatus || "").trim();
    const certificationText = this.getCertificationText(certificationStatus);
    
    return {
      id: safeItem._id || safeItem.id || "",
      name: safeItem.name || "未设置",
      phone: safeItem.phone || "",
      organization,
      joinDate,
      avatarUrl: this.normalizeAvatarUrl(safeItem.avatarUrl),
      levelLabel,
      teachingYearsText: this.getTeachingYearsText(joinDate, teachYear),
      certificationText,
      certificationStatus,
      orgIds,
      hasPassword: !!safeItem.passwordHash,
    };
  },

  syncLocalCoachInfo(coachDoc) {
    const localUserInfo = this.getCurrentLocalUser();
    if (!localUserInfo || typeof localUserInfo !== "object") return;

    wx.setStorageSync("userInfo", {
      ...localUserInfo,
      id: coachDoc._id || coachDoc.id || localUserInfo.id || localUserInfo._id || "",
      name: coachDoc.name || localUserInfo.name || "",
      phone: coachDoc.phone || localUserInfo.phone || "",
      avatarUrl: this.normalizeAvatarUrl(coachDoc.avatarUrl) || this.normalizeAvatarUrl(localUserInfo.avatarUrl),
      level: typeof coachDoc.level === "undefined" ? localUserInfo.level : coachDoc.level,
      openid: coachDoc.openid || coachDoc._openid || localUserInfo.openid || "",
    });
  },

  fetchCoachById(db, coachId) {
    if (!coachId) return Promise.resolve(null);
    return db.collection(COLLECTION_NAME.USERS)
      .doc(coachId)
      .get()
      .then((res) => (res && res.data ? res.data : null))
      .catch(() => null);
  },

  getOpenIdFromCloud() {
    if (!this.initCloud()) {
      return Promise.reject(new Error("cloud_not_supported"));
    }
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: { type: "getOpenId" },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      const openid = String(result.openid || "").trim();
      if (!openid) {
        throw new Error("openid_not_found");
      }
      return openid;
    });
  },

  fetchUserByOpenId(db, openid) {
    const safeOpenid = String(openid || "").trim();
    if (!safeOpenid) {
      return Promise.resolve(null);
    }
    const _ = db.command;
    return db.collection(COLLECTION_NAME.USERS)
      .where(_.or([{ openid: safeOpenid }, { _openid: safeOpenid }]))
      .limit(20)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        if (!list.length) {
          return null;
        }
        const preferred = list.find((item) => {
          const role = String(item && item.role ? item.role : "").trim().toLowerCase();
          return role === "coach" || role === "admin";
        });
        return preferred || list[0];
      });
  },

  loadCoachInfo() {
    if (!this.initCloud()) return Promise.resolve(null);

    const db = wx.cloud.database();
    const coachId = this.getCurrentCoachId();
    
    const fetchOrganizations = () => {
      return wx.cloud.callFunction({
        name: "quickstartFunctions",
        data: { type: "listOrganizations" },
      }).then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return [];
        }
        return Array.isArray(result.organizations) ? result.organizations : [];
      }).catch(() => []);
    };
    
    return Promise.all([
      Promise.resolve()
        .then(() => (coachId ? this.fetchCoachById(db, coachId) : null))
        .then((coachDoc) => {
          if (coachDoc && coachDoc._id) {
            return coachDoc;
          }
          return this.getOpenIdFromCloud()
            .then((openid) => this.fetchUserByOpenId(db, openid))
            .catch(() => {
              const localUserInfo = this.getCurrentLocalUser();
              const localOpenid = String(localUserInfo.openid || "").trim();
              return this.fetchUserByOpenId(db, localOpenid);
            });
        }),
      fetchOrganizations(),
    ])
      .then(([coachDoc, organizations]) => {
        if (!coachDoc) return null;
        const coachInfo = this.buildCoachInfo(coachDoc, organizations);
        this.setData({ coachInfo, organizationList: organizations });
        this.syncLocalCoachInfo(coachDoc);
        return coachDoc;
      });
  },

  loadStats() {
    if (!this.initCloud()) return Promise.resolve();

    const db = wx.cloud.database();
    const coachId = this.getCurrentCoachId();
    const getStudentCount = this.loadSharedStudentCount(db, coachId).catch(() => 0);
    const getBookedCourseCount = wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listMyScheduleBookings",
        userId: coachId || "",
        preferUserId: !!coachId,
        asBooker: true,
        expectedRole: "coach_or_admin",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return 0;
        }
        const bookings = Array.isArray(result.bookings) ? result.bookings : [];
        const now = Date.now();
        return bookings.reduce((total, item) => {
          const safe = item || {};
          const endTs = this.buildScheduleTimestamp(
            safe.date,
            safe.endTime || safe.startTime
          );
          if (!Number.isNaN(endTs) && endTs <= now) {
            return total + 1;
          }
          return total;
        }, 0);
      })
      .catch(() => 0);
    const getPublishedCourseCount = wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "listCoachScheduleSlots",
        userId: coachId || "",
        preferUserId: !!coachId,
        expectedRole: "coach_or_admin",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return 0;
        }
        const slots = Array.isArray(result.slots) ? result.slots : [];
        return slots.length;
      })
      .catch(() => 0);

    return Promise.all([getStudentCount, getBookedCourseCount, getPublishedCourseCount])
      .then(([studentsRes, completedBookedCount, publishedCourseCount]) => {
        this.setData({
          stats: {
            studentCount: Math.max(0, Number(studentsRes || 0)),
            courseCount: Math.max(0, Number(completedBookedCount || 0)),
            publishedCourseCount: Math.max(0, Number(publishedCourseCount || 0)),
            reviewCount: 0,
          },
        });
      })
      .catch((error) => {
        console.error("load coach profile stats failed:", error);
        this.setData({
          stats: {
            studentCount: 0,
            courseCount: 0,
            publishedCourseCount: 0,
            reviewCount: 0,
          },
        });
      });
  },

  loadAllData() {
    return Promise.all([this.loadCoachInfo(), this.loadStats()])
      .catch((error) => {
        console.error("load coach profile data failed:", error);
      });
  },

  updateCoachProfileInCloud(patch) {
    if (!this.initCloud()) {
      return Promise.reject(new Error("cloud_not_supported"));
    }
    const coachId = String(this.getCurrentCoachId() || "").trim();
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "updateMyProfile",
        patch: { ...(patch || {}) },
        userId: coachId,
        preferUserId: !!coachId,
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === "undefined") {
        throw new Error("function_not_updated");
      }
      if (!result.success) {
        throw new Error(String(result.message || "update_profile_failed"));
      }
      return result.user || null;
    });
  },

  applyLocalCoachPatch(patch) {
    const localUserInfo = this.getCurrentLocalUser();
    wx.setStorageSync("userInfo", { ...localUserInfo, ...patch });
  },

  uploadAvatarToCloud(tempFilePath) {
    if (!this.initCloud()) {
      return Promise.reject(new Error("cloud_not_supported"));
    }
    const ext = this.getFileExt(tempFilePath, "jpg");
    const coachId = this.getCurrentCoachId() || "coach";
    const cloudPath = `users/avatars/${coachId}_${Date.now()}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
      .then((res) => {
        const fileID = res && res.fileID ? res.fileID : "";
        if (!fileID) {
          throw new Error("avatar_upload_failed");
        }
        return fileID;
      });
  },

  changeAvatar() {
    wx.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const list = res && res.tempFilePaths ? res.tempFilePaths : [];
        const tempFilePath = list[0] || "";
        const previousAvatar = this.normalizeAvatarUrl(this.data.coachInfo.avatarUrl);
        if (!tempFilePath) {
          wx.showToast({ title: "图片读取失败", icon: "none" });
          return;
        }

        this.applyLocalCoachPatch({ avatarUrl: tempFilePath });
        this.setData({ coachInfo: { ...this.data.coachInfo, avatarUrl: tempFilePath } });

        wx.showLoading({ title: "同步中...", mask: true });
        let cloudAvatarUrl = "";
        this.uploadAvatarToCloud(tempFilePath)
          .then((fileID) => {
            cloudAvatarUrl = fileID;
            return this.updateCoachProfileInCloud({ avatarUrl: cloudAvatarUrl });
          })
          .then(() => {
            this.applyLocalCoachPatch({ avatarUrl: cloudAvatarUrl });
            this.setData({ coachInfo: { ...this.data.coachInfo, avatarUrl: cloudAvatarUrl } });
            wx.showToast({ title: "头像已更新", icon: "success" });
          })
          .catch((error) => {
            console.error("更新头像失败:", error);
            this.applyLocalCoachPatch({ avatarUrl: previousAvatar });
            this.setData({ coachInfo: { ...this.data.coachInfo, avatarUrl: previousAvatar } });
            wx.showToast({ title: "头像上传失败，请重试", icon: "none" });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
      fail: () => {
        wx.showToast({ title: "选择图片失败", icon: "none" });
      },
    });
  },

  changePassword() {
    const hasPassword = this.data.coachInfo.hasPassword;
    
    if (!hasPassword) {
      wx.showModal({
        title: "设置初始密码",
        editable: true,
        placeholderText: "请设置初始密码（至少6位）",
        content: "",
        success: (res) => {
          if (!res.confirm) {
            return;
          }
          const newPassword = String(res.content || "").trim();
          if (newPassword.length < PASSWORD_MIN_LENGTH) {
            wx.showToast({ title: "密码至少6位", icon: "none" });
            return;
          }
          if (newPassword.length > PASSWORD_MAX_LENGTH) {
            wx.showToast({ title: "密码最多32位", icon: "none" });
            return;
          }

          wx.showLoading({ title: "保存中...", mask: true });
          this.callPasswordCloudFunction("setInitialPassword", { newPassword })
            .then(() => {
              wx.showToast({ title: "密码设置成功", icon: "success" });
              this.setData({ coachInfo: { ...this.data.coachInfo, hasPassword: true } });
            })
            .catch((error) => {
              wx.showToast({
                title: this.resolvePasswordErrorMessage(error, "密码设置失败"),
                icon: "none",
              });
            })
            .finally(() => {
              wx.hideLoading();
            });
        },
      });
      return;
    }

    wx.showModal({
      title: "修改密码",
      editable: true,
      placeholderText: "请输入当前密码",
      content: "",
      success: (oldRes) => {
        if (!oldRes.confirm) {
          return;
        }
        const oldPassword = String(oldRes.content || "").trim();
        if (!oldPassword) {
          wx.showToast({ title: "请输入当前密码", icon: "none" });
          return;
        }

        wx.showModal({
          title: "设置新密码",
          editable: true,
          placeholderText: "请输入新密码（至少6位）",
          content: "",
          success: (newRes) => {
            if (!newRes.confirm) {
              return;
            }
            const newPassword = String(newRes.content || "").trim();
            if (newPassword.length < PASSWORD_MIN_LENGTH) {
              wx.showToast({ title: "新密码至少6位", icon: "none" });
              return;
            }
            if (newPassword.length > PASSWORD_MAX_LENGTH) {
              wx.showToast({ title: "新密码最多32位", icon: "none" });
              return;
            }

            wx.showLoading({ title: "保存中...", mask: true });
            this.callPasswordCloudFunction("changeMyPassword", { oldPassword, newPassword })
              .then(() => {
                wx.showToast({ title: "密码修改成功", icon: "success" });
              })
              .catch((error) => {
                wx.showToast({
                  title: this.resolvePasswordErrorMessage(error, "密码修改失败"),
                  icon: "none",
                });
              })
              .finally(() => {
                wx.hideLoading();
              });
          },
        });
      },
    });
  },

  editProfile() {
    const currentName = String(this.data.coachInfo.name || "").trim();
    wx.showModal({
      title: "编辑昵称",
      editable: true,
      placeholderText: "请输入昵称",
      content: currentName,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = String(res.content || "").trim();
        if (!name) {
          wx.showToast({ title: "昵称不能为空", icon: "none" });
          return;
        }
        if (name.length > 20) {
          wx.showToast({ title: "昵称最多20个字", icon: "none" });
          return;
        }

        wx.showLoading({ title: "同步中...", mask: true });
        this.updateCoachProfileInCloud({ name, nickName: name })
          .then(() => {
            this.applyLocalCoachPatch({ name, nickName: name });
            this.setData({ coachInfo: { ...this.data.coachInfo, name } });
            wx.showToast({ title: "昵称已更新", icon: "success" });
          })
          .catch((error) => {
            console.error("更新昵称失败:", error);
            const raw = String((error && (error.message || error.errMsg)) || "").toLowerCase();
            const message = raw.includes("function_not_updated")
              ? "请重新部署 quickstartFunctions"
              : "昵称更新失败，请重试";
            wx.showToast({ title: message, icon: "none" });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
    });
  },

  editTeachYear() {
    wx.showModal({
      title: "编辑教学年限",
      editable: true,
      placeholderText: "请输入教学年限（数字）",
      content: "",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const teachYear = Number(res.content || "");
        if (!Number.isFinite(teachYear) || teachYear <= 0 || teachYear > 99) {
          wx.showToast({ title: "请输入1-99之间的数字", icon: "none" });
          return;
        }

        wx.showLoading({ title: "同步中...", mask: true });
        this.updateCoachProfileInCloud({ teachYear })
          .then(() => {
            this.applyLocalCoachPatch({ teachYear });
            const teachingYearsText = `${teachYear}年`;
            this.setData({
              coachInfo: { ...this.data.coachInfo, teachingYearsText },
            });
            wx.showToast({ title: "教学年限已更新", icon: "success" });
          })
          .catch((error) => {
            console.error("更新教学年限失败:", error);
            const raw = String((error && (error.message || error.errMsg)) || "").toLowerCase();
            const message = raw.includes("function_not_updated")
              ? "请重新部署 quickstartFunctions"
              : "教学年限更新失败，请重试";
            wx.showToast({ title: message, icon: "none" });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
    });
  },

  editOrganization() {
    if (!this.initCloud()) {
      wx.showToast({ title: "云能力不可用", icon: "none" });
      return;
    }
    
    wx.showLoading({ title: "加载中...", mask: true });
    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: { type: "listOrganizations" },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        const organizations = result.success && Array.isArray(result.organizations) 
          ? result.organizations 
          : [];
        const orgIds = this.data.coachInfo.orgIds || [];
        this.setData({
          organizationList: organizations,
          selectedOrgIds: [...orgIds],
          showOrgModal: true,
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载机构列表失败", icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  closeOrgModal() {
    this.setData({ showOrgModal: false });
  },

  toggleOrgSelect(e) {
    const orgId = e.currentTarget.dataset.id;
    const selectedOrgIds = [...this.data.selectedOrgIds];
    const index = selectedOrgIds.indexOf(orgId);
    if (index >= 0) {
      selectedOrgIds.splice(index, 1);
    } else {
      selectedOrgIds.push(orgId);
    }
    this.setData({ selectedOrgIds });
  },

  confirmOrgSelect() {
    const selectedOrgIds = [...this.data.selectedOrgIds];
    
    wx.showLoading({ title: "同步中...", mask: true });
    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "updateMyOrgIds",
        orgIds: selectedOrgIds,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(String(result.message || "update_org_ids_failed"));
        }
        
        const organizations = this.data.organizationList;
        const matchedOrgs = organizations.filter(org => selectedOrgIds.includes(org._id));
        const organization = matchedOrgs.length > 0 ? matchedOrgs.map(o => o.name).join("、") : "";
        
        this.applyLocalCoachPatch({ orgIds: selectedOrgIds });
        this.setData({
          showOrgModal: false,
          coachInfo: { ...this.data.coachInfo, organization, orgIds: selectedOrgIds },
        });
        wx.showToast({ title: "所属机构已更新", icon: "success" });
      })
      .catch((error) => {
        console.error("更新所属机构失败:", error);
        const raw = String((error && (error.message || error.errMsg)) || "").toLowerCase();
        const message = raw.includes("function_not_updated")
          ? "请重新部署 quickstartFunctions"
          : "所属机构更新失败，请重试";
        wx.showToast({ title: message, icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  normalizePhone(phone) {
    return String(phone || "").replace(/\s+/g, "");
  },

  isValidPhone(phone) {
    return /^1\d{10}$/.test(phone);
  },

  bindPhoneInCloud(phone) {
    if (!this.initCloud()) {
      return Promise.reject(new Error("cloud_not_supported"));
    }
    const coachId = String(this.getCurrentCoachId() || "").trim();
    return wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "bindUserPhone",
        phone,
        userId: coachId,
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === "undefined") {
        throw new Error("function_not_updated");
      }
      if (!result.success) {
        throw new Error(result.message || "bind_phone_failed");
      }
      return result.user || {};
    });
  },

  bindPhone() {
    wx.showModal({
      title: this.data.coachInfo.phone ? "更换手机号" : "绑定手机号",
      editable: true,
      placeholderText: "请输入11位手机号",
      content: this.data.coachInfo.phone || "",
      confirmText: "确认",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const phone = this.normalizePhone(res.content);
        if (!this.isValidPhone(phone)) {
          wx.showToast({ title: "请输入正确的手机号", icon: "none" });
          return;
        }

        wx.showLoading({ title: "绑定中...", mask: true });
        this.bindPhoneInCloud(phone)
          .then(() => {
            this.applyLocalCoachPatch({ phone });
            this.setData({ coachInfo: { ...this.data.coachInfo, phone } });
            wx.showToast({ title: "手机号绑定成功", icon: "success" });
          })
          .catch((error) => {
            console.error("绑定手机号失败:", error);
            const raw = String((error && (error.message || error.errMsg)) || "").toLowerCase();
            let message = "绑定失败，请重试";
            if (raw.includes("function_not_updated")) {
              message = "请重新部署 quickstartFunctions";
            } else if (raw.includes("phone_in_use")) {
              message = "该手机号已绑定其他账号";
            } else if (raw.includes("invalid_phone")) {
              message = "手机号格式不正确";
            }
            wx.showToast({ title: message, icon: "none" });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
    });
  },

  goForbiddenWords() {
    wx.navigateTo({ url: "/pages/coach/settings/forbidden-words/forbidden-words" });
  },

  logout() {
    wx.showModal({
      title: "退出登录",
      content: "确定要退出登录吗？",
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync("userRole");
          wx.removeStorageSync("accountRole");
          wx.removeStorageSync("userInfo");
          wx.reLaunch({ url: "/pages/login/login" });
        }
      },
    });
  },
});
