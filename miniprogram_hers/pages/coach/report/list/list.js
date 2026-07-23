const USER_COLLECTION = "users";
const MAX_COACH_ALIAS_SIZE = 20;
const MAX_STUDENTS_PER_COACH = 500;

Page({
  data: {
    titleInput: "",
    contentInput: "",
    publishing: false,
    loading: false,
    loadError: "",
    reports: [],
    students: [],
    studentsLoading: false,
    studentLoadError: "",
    effectiveCoachId: "",
  },

  onLoad() {
    this.loadStudents();
    this.loadReports();
  },

  onShow() {
    this.loadStudents();
    this.loadReports();
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

  getLocalUserInfo() {
    return wx.getStorageSync("userInfo") || {};
  },

  getCurrentCoachId() {
    const localUserInfo = this.getLocalUserInfo();
    return String(localUserInfo.id || localUserInfo._id || "").trim();
  },

  normalizePhone(phone) {
    return String(phone || "").replace(/\s+/g, "");
  },

  isValidPhone(phone) {
    return /^1\d{10}$/.test(String(phone || ""));
  },

  resolveCoachSeedIds() {
    const localUserInfo = this.getLocalUserInfo();
    const rawIds = [
      localUserInfo.id,
      localUserInfo._id,
    ];
    const idSet = new Set();
    rawIds.forEach((item) => {
      const id = String(item || "").trim();
      if (id) {
        idSet.add(id);
      }
    });
    return Array.from(idSet);
  },

  fetchCoachAliasIds(db, seedIds, phone) {
    const idSet = new Set(Array.isArray(seedIds) ? seedIds.filter(Boolean) : []);
    const normalizedPhone = this.normalizePhone(phone);
    if (!this.isValidPhone(normalizedPhone)) {
      return Promise.resolve(Array.from(idSet));
    }

    const _ = db.command;
    return db.collection(USER_COLLECTION)
      .where({
        phone: normalizedPhone,
        role: _.in(["coach", "admin"]),
      })
      .limit(MAX_COACH_ALIAS_SIZE)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        list.forEach((item) => {
          const id = String(item && item._id ? item._id : "").trim();
          if (id) {
            idSet.add(id);
          }
        });
        return Array.from(idSet);
      })
      .catch(() => Array.from(idSet));
  },

  fetchStudentsBySingleCoachId(db, coachId) {
    const id = String(coachId || "").trim();
    if (!id) {
      return Promise.resolve([]);
    }

    return db.collection(USER_COLLECTION)
      .where({ coachId: id })
      .limit(MAX_STUDENTS_PER_COACH)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        return list.filter((item) => {
          const role = String(item && item.role ? item.role : "").trim().toLowerCase();
          return role !== "coach" && role !== "admin";
        });
      })
      .catch(() => []);
  },

  fetchStudentsByCoachIds(db, coachIds) {
    const ids = Array.from(
      new Set((Array.isArray(coachIds) ? coachIds : []).map((id) => String(id || "").trim()).filter(Boolean))
    );
    if (!ids.length) {
      return Promise.resolve([]);
    }

    return Promise.all(ids.map((coachId) => this.fetchStudentsBySingleCoachId(db, coachId)))
      .then((resultList) => {
        const merged = [];
        (Array.isArray(resultList) ? resultList : []).forEach((group) => {
          if (Array.isArray(group)) {
            merged.push(...group);
          }
        });
        return merged;
      });
  },

  resolveEffectiveCoachId(coachIds, studentDocs, fallbackCoachId) {
    const ids = Array.isArray(coachIds) ? coachIds.filter(Boolean) : [];
    if (!ids.length) {
      return String(fallbackCoachId || "").trim();
    }

    const countMap = {};
    ids.forEach((id) => {
      countMap[id] = 0;
    });
    (Array.isArray(studentDocs) ? studentDocs : []).forEach((item) => {
      const id = String(item && item.coachId ? item.coachId : "").trim();
      if (!id) {
        return;
      }
      countMap[id] = Number(countMap[id] || 0) + 1;
    });

    let bestId = ids[0];
    let maxCount = Number(countMap[bestId] || 0);
    ids.forEach((id) => {
      const count = Number(countMap[id] || 0);
      if (count > maxCount) {
        maxCount = count;
        bestId = id;
      }
    });

    return bestId || String(fallbackCoachId || "").trim();
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

  normalizeReport(item) {
    const safe = item || {};
    return {
      id: safe.id || safe._id || "",
      title: String(safe.title || "训练总反馈"),
      contentPreview: String(safe.contentPreview || ""),
      studentCount: Number(safe.studentCount || 0),
      totalFlowerCount: Number(safe.totalFlowerCount || 0),
      createdAtText: this.normalizeDate(safe.createdAt || safe.updatedAt),
    };
  },

  normalizeStudent(item) {
    const safe = item || {};
    const fallbackId = `${String(safe.phone || "").trim()}_${String(safe.name || safe.nickName || "").trim()}`;
    const hasCanReceiveFlower = Object.prototype.hasOwnProperty.call(safe, "canReceiveFlower");
    const hasCompletedLessonCount = Object.prototype.hasOwnProperty.call(safe, "completedLessonCount");
    const hasLessonPackage = Object.prototype.hasOwnProperty.call(safe, "hasLessonPackage")
      ? safe.hasLessonPackage !== false
      : true;
    const flowerDisabledReasonRaw = String(safe.flowerDisabledReason || "").trim();
    const completedLessonCount = Math.max(0, Number(safe.completedLessonCount || 0));
    let canReceiveFlower = true;
    if (hasCanReceiveFlower) {
      canReceiveFlower = safe.canReceiveFlower !== false;
    } else if (hasCompletedLessonCount) {
      canReceiveFlower = completedLessonCount > 0;
    }
    let flowerDisabledReason = flowerDisabledReasonRaw;
    if (!canReceiveFlower && !flowerDisabledReason) {
      flowerDisabledReason = hasLessonPackage ? "no_completed_lesson" : "lesson_package_not_configured";
    }
    const flowerDisabledText = !canReceiveFlower
      ? (flowerDisabledReason === "lesson_package_not_configured" ? "未设置课时" : "未上课")
      : "";
    return {
      id: String(safe._id || safe.id || safe.openid || fallbackId).trim(),
      name: String(safe.name || safe.nickName || "学员").trim() || "学员",
      completedLessonCount,
      canReceiveFlower,
      flowerDisabledReason,
      flowerDisabledText,
      flowerCount: 0,
      flowerInputText: "0",
    };
  },

  canStudentReceiveFlower(student) {
    const safe = student || {};
    return safe.canReceiveFlower !== false;
  },

  onTitleInput(e) {
    this.setData({
      titleInput: String(e && e.detail ? e.detail.value : "").slice(0, 40),
    });
  },

  onContentInput(e) {
    this.setData({
      contentInput: String(e && e.detail ? e.detail.value : "").slice(0, 3000),
    });
  },

  normalizeFlowerCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return 0;
    }
    const clamped = Math.max(0, Math.min(5, n));
    return Math.round(clamped * 2) / 2;
  },

  formatFlowerCount(value) {
    const n = this.normalizeFlowerCount(value);
    return Number.isInteger(n) ? String(n) : String(n);
  },

  sanitizeFlowerInputText(value) {
    const raw = String(value || "");
    const cleaned = raw.replace(/[^\d.]/g, "");
    const parts = cleaned.split(".");
    if (parts.length <= 1) {
      return cleaned;
    }
    const intPart = parts.shift();
    const decimalPart = parts.join("").slice(0, 2);
    return `${intPart}.${decimalPart}`;
  },

  parseFlowerInput(value) {
    const raw = this.sanitizeFlowerInputText(value).trim();
    if (!raw) {
      return 0;
    }
    const normalizedText = raw === "." ? "0." : raw;
    return this.normalizeFlowerCount(Number(normalizedText));
  },

  updateStudentFlowerInput(studentId, rawValue) {
    const targetId = String(studentId || "").trim();
    if (!targetId) {
      return;
    }
    const nextText = this.sanitizeFlowerInputText(rawValue);
    const students = (this.data.students || []).map((item) => {
      if (item.id !== targetId) {
        return item;
      }
      if (!this.canStudentReceiveFlower(item)) {
        return {
          ...item,
          flowerCount: 0,
          flowerInputText: "0",
        };
      }
      return {
        ...item,
        flowerInputText: nextText,
      };
    });
    this.setData({ students });
  },

  updateStudentFlower(studentId, nextCount) {
    const targetId = String(studentId || "").trim();
    if (!targetId) {
      return;
    }
    const normalized = this.normalizeFlowerCount(nextCount);
    const students = (this.data.students || []).map((item) => {
      if (item.id !== targetId) {
        return item;
      }
      if (!this.canStudentReceiveFlower(item)) {
        return {
          ...item,
          flowerCount: 0,
          flowerInputText: "0",
        };
      }
      return {
        ...item,
        flowerCount: normalized,
        flowerInputText: this.formatFlowerCount(normalized),
      };
    });
    this.setData({ students });
  },

  onFlowerInput(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || "").trim();
    const value = String(e && e.detail ? e.detail.value : "");
    this.updateStudentFlowerInput(studentId, value);
  },

  onFlowerInputBlur(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || "").trim();
    const value = String(e && e.detail ? e.detail.value : "");
    this.updateStudentFlower(studentId, this.parseFlowerInput(value));
  },
  onFlowerMinus(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || "").trim();
    const current = Number(dataset.count || 0);
    this.updateStudentFlower(studentId, current - 0.5);
  },

  onFlowerPlus(e) {
    const dataset = e && e.currentTarget ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || "").trim();
    const current = Number(dataset.count || 0);
    this.updateStudentFlower(studentId, current + 0.5);
  },

  loadStudents() {
    if (this.data.studentsLoading) {
      return;
    }

    if (!this.initCloud()) {
      this.setData({
        students: [],
        studentsLoading: false,
        studentLoadError: "当前基础库不支持云开发",
      });
      return;
    }

    const localUserInfo = this.getLocalUserInfo();
    const fallbackCoachId = this.getCurrentCoachId();
    const seedIds = this.resolveCoachSeedIds();
    const phone = this.normalizePhone(localUserInfo.phone || "");

    if (!seedIds.length && !this.isValidPhone(phone)) {
      this.setData({
        students: [],
        studentsLoading: false,
        studentLoadError: "教练信息缺失，请重新登录",
      });
      return;
    }

    this.setData({
      studentsLoading: true,
      studentLoadError: "",
    });

    const applyStudents = (docs, coachIds, fixedCoachId) => {
      const normalized = (Array.isArray(docs) ? docs : []).map((item) => this.normalizeStudent(item));
      const dedupMap = {};
      const students = [];
      normalized.forEach((item, index) => {
        const key = String(item && item.id ? item.id : `fallback_${index}`);
        if (dedupMap[key]) {
          return;
        }
        dedupMap[key] = true;
        students.push(item);
      });
      this.setData({
        students,
        effectiveCoachId: String(fixedCoachId || '').trim()
          || this.resolveEffectiveCoachId(coachIds, docs, fallbackCoachId),
      });
    };

    const callCloudStudents = () => wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listCoachReportStudents',
        userId: fallbackCoachId,
        preferUserId: true,
        expectedRole: 'coach_or_admin',
        coachId: fallbackCoachId,
        coachIds: seedIds,
        phone,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || 'list_coach_report_students_failed');
        }
        console.log('[report] cloud students loaded, count:', (result.students || []).length);
        const students = Array.isArray(result.students) ? result.students : [];
        const effectiveCoachId = String(result.effectiveCoachId || '').trim();
        const docs = students.map((item) => ({
          _id: item.id,
          name: item.name,
          coachId: item.coachId,
          completedLessonCount: Number(item && item.completedLessonCount ? item.completedLessonCount : 0),
          canReceiveFlower: item && Object.prototype.hasOwnProperty.call(item, "canReceiveFlower")
            ? item.canReceiveFlower !== false
            : true,
        }));
        applyStudents(docs, [], effectiveCoachId);
      });

    const fetchStudentsByCoachIdLocal = (coachId) => {
      const id = String(coachId || '').trim();
      if (!id) return Promise.resolve([]);
      const db = wx.cloud.database();
      return db.collection(USER_COLLECTION)
        .where({ coachId: id })
        .limit(200)
        .get()
        .then((res) => {
          const list = res && Array.isArray(res.data) ? res.data : [];
          return list.filter((item) => {
            const role = String(item && item.role ? item.role : '').trim().toLowerCase();
            return role !== 'coach' && role !== 'admin';
          });
        })
        .catch(() => []);
    };

    const fetchStudentsLocal = () => {
      const tasks = seedIds.map((id) => fetchStudentsByCoachIdLocal(id));
      return Promise.all(tasks).then((groupList) => {
        const merged = [];
        groupList.forEach((group) => {
          if (Array.isArray(group)) merged.push(...group);
        });
        return merged;
      });
    };

    callCloudStudents()
      .catch((error) => {
        console.error('[report] cloud load students failed:', error);
        console.error('[report] error details - message:', (error && error.message), 'errCode:', (error && error.errCode), 'errMsg:', (error && error.errMsg));
        const msg = String((error && error.message) || "");
        if (msg.includes("unsupported_type") || msg.includes("function_not_found")) {
          this.setData({
            students: [],
            studentLoadError: "请先部署云函数 quickstartFunctions",
            effectiveCoachId: fallbackCoachId,
          });
          return;
        }
        console.log('[report] falling back to local DB query...');
        return fetchStudentsLocal().then((localDocs) => {
          console.log('[report] local students loaded, count:', localDocs.length);
          if (localDocs.length === 0) {
            throw new Error('local students empty');
          }
          applyStudents(localDocs, seedIds, fallbackCoachId);
        });
      })
      .catch(() => {
        this.setData({
          students: [],
          studentLoadError: "加载学员失败，请检查数据库权限或重新登录",
          effectiveCoachId: fallbackCoachId,
        });
      })
      .finally(() => {
        this.setData({ studentsLoading: false });
      });
  },
  buildStudentFlowersPayload() {
    return (this.data.students || []).map((item) => {
      const studentId = String(item && item.id ? item.id : "").trim();
      const canReceiveFlower = this.canStudentReceiveFlower(item);
      const inputText = String(item && item.flowerInputText ? item.flowerInputText : "").trim();
      const parsedByInput = this.parseFlowerInput(inputText);
      const fallbackCount = this.normalizeFlowerCount(item && item.flowerCount ? item.flowerCount : 0);
      return {
        studentId,
        studentName: String(item && item.name ? item.name : "").trim(),
        // Do not rely on blur event. Always parse latest input text when publishing.
        flowerCount: canReceiveFlower
          ? this.normalizeFlowerCount(inputText ? parsedByInput : fallbackCount)
          : 0,
      };
    });
  },

  publishReport() {
    if (this.data.publishing) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: "当前基础库不支持云开发", icon: "none" });
      return;
    }

    const title = String(this.data.titleInput || "").trim();
    const content = String(this.data.contentInput || "").trim();
    if (!content) {
      wx.showToast({ title: "请先输入训练反馈", icon: "none" });
      return;
    }

    this.setData({ publishing: true });

    const localUserInfo = this.getLocalUserInfo();
    const localCoachId = String(localUserInfo.id || localUserInfo._id || "").trim();
    const effectiveCoachId = String(this.data.effectiveCoachId || localCoachId).trim();
    const coachIds = this.resolveCoachSeedIds();
    const publisherName = String(localUserInfo.name || localUserInfo.nickName || "").trim();
    const publisherLevel = String(localUserInfo.level || "").trim();
    const studentFlowers = this.buildStudentFlowersPayload();

    wx.showLoading({ title: "发布中...", mask: true });

    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "publishTrainingReport",
          userId: localCoachId,
          preferUserId: true,
          expectedRole: 'coach_or_admin',
          title,
          content,
          coachId: effectiveCoachId,
          coachIds,
          publisherName,
          publisherLevel,
          studentFlowers,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const err = new Error(result.message || "publish_training_report_failed");
          err.detail = result;
          throw err;
        }

        const studentCount = Number(result.studentCount || 0);
        const totalFlowerCount = Number(result.totalFlowerCount || 0);
        console.log('[report] published to', studentCount, 'students,', totalFlowerCount, 'flowers');
        this.setData({
          titleInput: "",
          contentInput: "",
          students: (this.data.students || []).map((item) => ({
            ...item,
            flowerCount: 0,
            flowerInputText: "0",
          })),
        });
        wx.showToast({
          title: `已发布给${studentCount}人，发放${totalFlowerCount}朵小红花`,
          icon: "success",
        });
        this.loadReports();
      })
      .catch((error) => {
        console.error("[report] publish report failed:", error);
        const msg = String((error && error.message) || "");
        const detail = error && error.detail ? error.detail : {};
        if (msg.includes("flower_requires_completed_lesson")) {
          const invalidStudents = Array.isArray(detail.invalidStudents) ? detail.invalidStudents : [];
          const first = invalidStudents[0] && typeof invalidStudents[0] === "object" ? invalidStudents[0] : {};
          const firstName = String(first.studentName || "").trim();
          const firstReason = String(first.reason || "").trim();
          let tip = "仅已上课且已设置课时的学员可发小红花";
          if (firstName) {
            tip = firstReason === "lesson_package_not_configured"
              ? `${firstName}未设置课时，不能发花`
              : `${firstName}未上课，不能发花`;
          }
          wx.showToast({ title: tip, icon: "none" });
          this.loadStudents();
          return;
        }
        if (msg.includes("permission_denied")) {
          wx.showToast({ title: "仅教练可发布报告", icon: "none" });
          return;
        }
        if (msg.includes("report_content_required")) {
          wx.showToast({ title: "请先输入训练反馈", icon: "none" });
          return;
        }
        wx.showToast({ title: "发布失败，请稍后重试", icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ publishing: false });
      });
  },

  loadReports() {
    if (!this.initCloud()) {
      this.setData({
        reports: [],
        loadError: "当前基础库不支持云开发",
      });
      return;
    }

    this.setData({
      loading: true,
      loadError: "",
    });

    const localUserInfo = this.getLocalUserInfo();
    const localCoachId = String(localUserInfo.id || localUserInfo._id || "").trim();

    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "listCoachTrainingReports",
          userId: localCoachId,
          preferUserId: true,
          expectedRole: 'coach_or_admin',
          coachId: localCoachId,
        },
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || "list_coach_training_reports_failed");
        }

        const reports = Array.isArray(result.reports) ? result.reports : [];
        console.log('[report] reports loaded, count:', reports.length);
        this.setData({
          reports: reports.map((item) => this.normalizeReport(item)),
        });
      })
      .catch((error) => {
        console.error("[report] load reports failed:", error);
        const msg = String((error && error.message) || "");
        this.setData({
          reports: [],
          loadError: msg.includes("permission_denied")
            ? "仅教练可查看训练报告"
            : "加载训练报告失败",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  goDetail(e) {
    const id = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "");
    if (!id) {
      return;
    }

    wx.navigateTo({
      url: `/pages/coach/report/detail/detail?id=${id}`,
    });
  },
});
