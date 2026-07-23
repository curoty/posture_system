const COLLECTION_NAME = 'users';
const { pickRandomAvatar, resolveAvatarSeed } = require('../../../../utils/avatar');

Page({
  data: {
    students: [],
    originalStudents: [],
    assignedStudents: [],
    unassignedStudents: [],
    displayStudents: [],
    assignableUsers: [],
    coachesAndAdmins: [],
    searchKeyword: '',
    coachId: '',
    coachName: '',
    loading: false,
    loadError: '',
    activeTab: 'all',
    stats: {
      total: 0,
      assigned: 0,
      unassigned: 0
    },
    i18n: {
      searchPlaceholder: '搜索学生姓名或手机号',
      loadingStudents: '正在加载学生数据...',
      emptyIcon: '\ud83d\udc65',
      emptyNoStudent: '暂无学生',
      emptyTip: '可点击右上角「添加学生」，通过手机号或候选列表添加',
      tabAll: '全部',
      tabAssigned: '已分班',
      tabUnassigned: '未分班',
      statTotal: '总学员',
      statAssigned: '已分班',
      statUnassigned: '未分班',
      btnSetLesson: '设置课时',
      btnExitClass: '退出班级',
      btnTransferAdmin: '移交管理',
      btnAssignClass: '分班',
      btnDelete: '删除',
      tagUnassigned: '暂未分班',
      tagActive: '活跃',
      tagLeave: '请假',
      unitPeople: '人',
      unitLessons: '课时',
      classDefault: '轮滑班'
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setTabBarList();
      this.getTabBar().setData({
        selected: 2
      });
    }
    this.loadStudents();
  },

  onPullDownRefresh() {
    this.loadStudents(true);
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true
    });
    return true;
  },

  normalizePhone(phone) {
    return String(phone || '').replace(/\s+/g, '');
  },

  maskPhone(phone) {
    const raw = this.normalizePhone(phone);
    if (!/^1\d{10}$/.test(raw)) {
      return raw || '\u672a\u8bbe\u7f6e\u624b\u673a\u53f7';
    }
    return `${raw.slice(0, 3)}****${raw.slice(7)}`;
  },

  isValidPhone(phone) {
    return /^1\d{10}$/.test(phone);
  },

  normalizeStatus(status) {
    const raw = String(status || '').toLowerCase();
    if (raw === 'leave' || raw === 'paused') {
      return { value: 'leave', text: this.data.i18n.tagLeave };
    }
    if (raw === 'inactive' || raw === 'disabled') {
      return { value: 'leave', text: this.data.i18n.tagLeave };
    }
    return { value: 'active', text: this.data.i18n.tagActive };
  },

  normalizeAvatarUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const lower = raw.toLowerCase();
    if (lower === 'none' || lower === 'null' || lower === 'undefined') {
      return '';
    }
    if (
      lower.includes('/__tmp__/')
      || lower.startsWith('http://127.0.0.1')
      || lower.startsWith('wxfile://')
      || lower.startsWith('file://')
      || lower.startsWith('blob:')
    ) {
      return '';
    }
    return raw;
  },

  hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  },

  formatDate(value) {
    if (!value) return '';
    let d;
    if (typeof value === 'string') {
      d = new Date(value);
    } else if (value instanceof Date) {
      d = value;
    } else if (value.seconds) {
      d = new Date(value.seconds * 1000);
    } else {
      d = new Date(value);
    }
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  parseLessonPackage(item) {
    const safe = item || {};
    const hasTotal = this.hasOwn(safe, 'lessonTotal');
    const hasRemaining = this.hasOwn(safe, 'lessonRemaining');
    const hasUsed = this.hasOwn(safe, 'lessonUsed');
    const configured = hasTotal || hasRemaining || hasUsed;
    if (!configured) {
      return {
        lessonConfigured: false,
        lessonTotal: 0,
        lessonRemaining: 0,
        lessonUsed: 0,
        lessonSummary: '课时未设置'
      };
    }

    const total = Math.max(0, Math.floor(Number(safe.lessonTotal || 0)));
    const used = Math.max(0, Math.floor(Number(safe.lessonUsed || 0)));
    const remaining = hasRemaining
      ? Math.max(0, Math.floor(Number(safe.lessonRemaining || 0)))
      : Math.max(0, total - used);
    const normalizedUsed = hasUsed ? used : Math.max(0, total - remaining);
    const normalizedTotal = hasTotal ? total : (remaining + normalizedUsed);

    return {
      lessonConfigured: true,
      lessonTotal: normalizedTotal,
      lessonRemaining: remaining,
      lessonUsed: normalizedUsed,
      lessonSummary: `剩余 ${remaining} 课时 / 总 ${normalizedTotal} 课时`
    };
  },

  normalizeStudent(item) {
    const safeItem = item || {};
    const statusInfo = this.normalizeStatus(safeItem.status);
    const rawPhone = this.normalizePhone(safeItem.phone || safeItem.mobile || '');
    const lesson = this.parseLessonPackage(safeItem);
    const avatarUrl = this.normalizeAvatarUrl(safeItem.avatarUrl)
      || pickRandomAvatar(resolveAvatarSeed(safeItem, rawPhone || safeItem._id || safeItem.id));

    const existingCoachIds = this.extractCoachIds(safeItem);
    const isAssigned = lesson.lessonConfigured;
    const joinDate = this.formatDate(
      safeItem.studentSince || safeItem.roleUpdatedAt || safeItem.createdAt || ''
    );
    const className = safeItem.className
      || safeItem.class_name
      || safeItem.class
      || this.data.i18n.classDefault;

    return {
      id: safeItem._id || safeItem.id || '',
      name: safeItem.name || safeItem.nickName || '\u672a\u547d\u540d\u5b66\u5458',
      phone: this.maskPhone(rawPhone),
      rawPhone,
      avatarUrl,
      status: statusInfo.value,
      statusText: statusInfo.text,
      lessonConfigured: lesson.lessonConfigured,
      lessonTotal: lesson.lessonTotal,
      lessonRemaining: lesson.lessonRemaining,
      lessonUsed: lesson.lessonUsed,
      lessonSummary: lesson.lessonSummary,
      isAssigned,
      className,
      joinDate
    };
  },

  normalizeAssignableUser(item) {
    const safeItem = item || {};
    const role = String(safeItem.role || '').toLowerCase();
    return {
      id: safeItem._id || safeItem.id || '',
      name: safeItem.name || safeItem.nickName || '\u672a\u547d\u540d\u7528\u6237',
      phone: safeItem.phone || '',
      role: role === 'student' ? 'student' : 'user'
    };
  },

  fetchAllStudents(db, useOrderBy, skip, list) {
    const currentSkip = typeof skip === 'number' ? skip : 0;
    const currentList = Array.isArray(list) ? list : [];
    const pageSize = 20;
    const _ = db.command;

    let filter = { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']) };
    if (this.data.coachId) {
      filter = _.or([
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachId: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachID: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachIds: _.in([this.data.coachId]) },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachIDs: _.in([this.data.coachId]) },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOwnerId: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOwnerID: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOwnerIds: _.in([this.data.coachId]) },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOwnerIDs: _.in([this.data.coachId]) },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOpenId: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOpenID: this.data.coachId },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOpenIds: _.in([this.data.coachId]) },
        { role: _.in(['student', 'user', 'Student', 'User', 'STUDENT', 'USER']), coachOpenIDs: _.in([this.data.coachId]) }
      ]);
    }

    let query = db.collection(COLLECTION_NAME).where(filter);
    if (useOrderBy) {
      query = query.orderBy('createdAt', 'desc');
    }

    return query
      .skip(currentSkip)
      .limit(pageSize)
      .get()
      .then((res) => {
        const data = res && res.data ? res.data : [];
        const merged = currentList.concat(data);
        const canContinue = data.length === pageSize && merged.length < 500;
        if (!canContinue) {
          return merged;
        }
        return this.fetchAllStudents(db, useOrderBy, currentSkip + data.length, merged);
      });
  },

  fetchSharedStudents(userIdInput) {
    const userId = String(userIdInput || this.data.coachId || '').trim();
    if (!userId) {
      return Promise.resolve([]);
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listCoachSharedStudents',
        userId,
        preferUserId: true,
        expectedRole: 'coach_or_admin'
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'list_coach_shared_students_failed'));
      }
      return Array.isArray(result.students) ? result.students : [];
    });
  },

  normalizeId(value) {
    return String(value || '').trim();
  },

  normalizeRoleValue(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'admin' || raw === 'administrator' || raw === '\u7ba1\u7406\u5458' || raw === '\u7ba1\u7406\u54e1') {
      return 'admin';
    }
    if (raw === 'coach' || raw === '\u6559\u7ec3' || raw === '\u6559\u7df4') {
      return 'coach';
    }
    if (raw === 'student' || raw === '\u5b66\u5458' || raw === '\u5b78\u54e1') {
      return 'student';
    }
    if (raw === 'user') {
      return 'user';
    }
    return raw;
  },

  isCoachOrAdminUser(user) {
    const safe = user && typeof user === 'object' ? user : {};
    const role = this.normalizeRoleValue(safe.role);
    if (role === 'coach' || role === 'admin') {
      return true;
    }
    const roles = Array.isArray(safe.roles) ? safe.roles : [];
    return roles.some((item) => {
      const itemRole = this.normalizeRoleValue(item);
      return itemRole === 'coach' || itemRole === 'admin';
    });
  },

  mergeUniqueIds(...inputs) {
    const set = new Set();
    (inputs || []).forEach((input) => {
      const arr = Array.isArray(input) ? input : [input];
      arr.forEach((item) => {
        const id = this.normalizeId(item);
        if (id) {
          set.add(id);
        }
      });
    });
    return Array.from(set);
  },

  extractAdminOwnerIds(user) {
    const safe = user && typeof user === 'object' ? user : {};
    return this.mergeUniqueIds(
      safe.adminOwnerId,
      safe.adminOwnerID,
      safe.ownerId,
      safe.ownerID,
      Array.isArray(safe.adminOwnerIds) ? safe.adminOwnerIds : [],
      Array.isArray(safe.adminOwnerIDs) ? safe.adminOwnerIDs : [],
      Array.isArray(safe.ownerIds) ? safe.ownerIds : [],
      Array.isArray(safe.ownerIDs) ? safe.ownerIDs : []
    );
  },

  extractCoachIds(user) {
    const safe = user && typeof user === 'object' ? user : {};
    return this.mergeUniqueIds(
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
  },

  fetchUserDocById(db, userId) {
    const id = this.normalizeId(userId);
    if (!id) {
      return Promise.resolve(null);
    }
    return db.collection(COLLECTION_NAME).doc(id).get()
      .then((res) => (res && res.data ? res.data : null))
      .catch(() => null);
  },

  fetchUsersByIdsLocal(db, ids) {
    const list = this.mergeUniqueIds(ids);
    if (!list.length) {
      return Promise.resolve([]);
    }
    const tasks = list.map((id) => this.fetchUserDocById(db, id));
    return Promise.all(tasks)
      .then((rows) => (Array.isArray(rows) ? rows.filter(Boolean) : []))
      .catch(() => []);
  },

  fetchCoachesByOwnerIdsLocal(db, ownerIds) {
    const ids = this.mergeUniqueIds(ownerIds);
    if (!ids.length) {
      return Promise.resolve([]);
    }
    const _ = db.command;
    return db.collection(COLLECTION_NAME)
      .where(_.or([
        { adminOwnerId: _.in(ids) },
        { adminOwnerID: _.in(ids) },
        { adminOwnerIds: _.in(ids) },
        { adminOwnerIDs: _.in(ids) },
        { ownerId: _.in(ids) },
        { ownerID: _.in(ids) },
        { ownerIds: _.in(ids) },
        { ownerIDs: _.in(ids) }
      ]))
      .limit(500)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        return list.filter((item) => this.isCoachOrAdminUser(item));
      })
      .catch(() => []);
  },

  fetchStudentsByCoachIdsLocal(db, coachIds) {
    const ids = this.mergeUniqueIds(coachIds);
    if (!ids.length) {
      return Promise.resolve([]);
    }
    const _ = db.command;
    return db.collection(COLLECTION_NAME)
      .where(_.or([
        { coachId: _.in(ids) },
        { coachID: _.in(ids) },
        { coachIds: _.in(ids) },
        { coachIDs: _.in(ids) },
        { coachids: _.in(ids) },
        { coachOwnerId: _.in(ids) },
        { coachOwnerID: _.in(ids) },
        { coachOwnerIds: _.in(ids) },
        { coachOwnerIDs: _.in(ids) },
        { coachOpenId: _.in(ids) },
        { coachOpenID: _.in(ids) },
        { coachOpenIds: _.in(ids) },
        { coachOpenIDs: _.in(ids) }
      ]))
      .limit(1000)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        return list.filter((item) => !this.isCoachOrAdminUser(item));
      })
      .catch(() => []);
  },

  fetchStudentsByOwnerIdsLocal(db, ownerIds) {
    const ids = this.mergeUniqueIds(ownerIds);
    if (!ids.length) {
      return Promise.resolve([]);
    }
    const _ = db.command;
    return db.collection(COLLECTION_NAME)
      .where(_.or([
        { adminOwnerId: _.in(ids) },
        { adminOwnerID: _.in(ids) },
        { adminOwnerIds: _.in(ids) },
        { adminOwnerIDs: _.in(ids) },
        { ownerId: _.in(ids) },
        { ownerID: _.in(ids) },
        { ownerIds: _.in(ids) },
        { ownerIDs: _.in(ids) }
      ]))
      .limit(1000)
      .get()
      .then((res) => {
        const list = res && Array.isArray(res.data) ? res.data : [];
        return list.filter((item) => !this.isCoachOrAdminUser(item));
      })
      .catch(() => []);
  },

  dedupStudentsById(docs) {
    const list = Array.isArray(docs) ? docs : [];
    const map = {};
    list.forEach((item) => {
      const key = this.normalizeId(
        item && (item._id || item.id || item.openid || item._openid)
      );
      if (!key || map[key]) {
        return;
      }
      if (this.isCoachOrAdminUser(item)) {
        return;
      }
      map[key] = item;
    });
    return Object.keys(map).map((key) => map[key]);
  },

  fetchSharedStudentsLocal(db, coachIdInput) {
    const coachId = this.normalizeId(coachIdInput || this.data.coachId);
    if (!coachId) {
      return Promise.resolve([]);
    }
    return this.fetchUserDocById(db, coachId)
      .then((coachDoc) => {
        const ownerIds = this.extractAdminOwnerIds(coachDoc);
        return Promise.all([
          this.fetchCoachesByOwnerIdsLocal(db, ownerIds),
          this.fetchUsersByIdsLocal(db, ownerIds)
        ]).then(([peers, ownerDocs]) => {
            const peerCoachIds = (Array.isArray(peers) ? peers : []).reduce((acc, item) => {
              const safe = item && typeof item === 'object' ? item : {};
              return acc.concat([
                this.normalizeId(safe._id),
                this.normalizeId(safe.openid),
                this.normalizeId(safe._openid),
                this.normalizePhone(safe.phone)
              ]);
            }, []).filter(Boolean);
            const ownerCoachIds = (Array.isArray(ownerDocs) ? ownerDocs : []).reduce((acc, item) => {
              return acc.concat(this.extractCoachIds(item));
            }, []).filter(Boolean);
            const scopedCoachIds = this.mergeUniqueIds(
              coachId,
              this.extractCoachIds(coachDoc),
              ownerIds,
              this.normalizeId(coachDoc && coachDoc.openid),
              this.normalizeId(coachDoc && coachDoc._openid),
              this.normalizePhone(coachDoc && coachDoc.phone),
              ownerCoachIds,
              peerCoachIds
            );
            return Promise.all([
              this.fetchStudentsByCoachIdsLocal(db, scopedCoachIds),
              this.fetchStudentsByOwnerIdsLocal(db, ownerIds)
            ]).then(([studentsByCoach, studentsByOwner]) =>
              this.dedupStudentsById([].concat(studentsByCoach || [], studentsByOwner || []))
            );
          });
      })
      .catch(() => []);
  },

  fetchOwnStudentsFallback(db) {
    return this.fetchAllStudents(db, true).catch(() => this.fetchAllStudents(db, false));
  },

  loadStudents(isPullDown) {
    if (!this.initCloud()) {
      this.setData({
        students: [],
        originalStudents: [],
        displayStudents: [],
        loading: false,
        stats: { total: 0, assigned: 0, unassigned: 0 },
        loadError: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1'
      });
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    this.setData({
      loading: true,
      loadError: ''
    });

    const localUserInfo = wx.getStorageSync('userInfo') || {};
    const coachId = localUserInfo.id || localUserInfo._id || '';
    const coachName = localUserInfo.name || localUserInfo.nickName || '';
    this.setData({ coachId, coachName });

    const db = wx.cloud.database();
    const studentsTask = this.fetchSharedStudents(coachId)
      .then((docs) => {
        const cloudDocs = Array.isArray(docs) ? docs : [];
        if (cloudDocs.length) {
          return cloudDocs;
        }
        return this.fetchSharedStudentsLocal(db, coachId)
          .then((localDocs) => (Array.isArray(localDocs) && localDocs.length ? localDocs : this.fetchOwnStudentsFallback(db)));
      })
      .catch((error) => {
        console.warn('load shared students failed, fallback to local query:', error);
        return this.fetchSharedStudentsLocal(db, coachId)
          .then((localDocs) => (Array.isArray(localDocs) && localDocs.length ? localDocs : this.fetchOwnStudentsFallback(db)))
          .catch(() => this.fetchOwnStudentsFallback(db));
      });

    studentsTask
      .then((docs) => {
        const originalStudents = (Array.isArray(docs) ? docs : [])
          .filter((item) => !this.isCoachOrAdminUser(item))
          .map((item) => this.normalizeStudent(item));
        return this.fetchAssignableUsers(db, originalStudents)
          .then((assignableUsers) => ({ originalStudents, assignableUsers }));
      })
      .then(({ originalStudents, assignableUsers }) => {
        const currentCoachId = this.normalizeId(this.data.coachId);
        if (currentCoachId) {
          const countCacheMap = wx.getStorageSync('coachSharedStudentCountMap') || {};
          countCacheMap[currentCoachId] = originalStudents.length;
          wx.setStorageSync('coachSharedStudentCountMap', countCacheMap);
        }
        wx.setStorageSync('coachSharedStudentCountLast', originalStudents.length);
        return this.fetchCoachesAndAdmins()
          .then((coachesAndAdmins) => ({
            originalStudents,
            assignableUsers: assignableUsers || [],
            coachesAndAdmins
          }));
      })
      .then(({ originalStudents, assignableUsers, coachesAndAdmins }) => {
        this.setData({
          originalStudents,
          assignableUsers,
          coachesAndAdmins: coachesAndAdmins || []
        });
        this.refreshDisplay();
      })
      .catch((error) => {
        console.error('load students failed:', error);
        this.setData({
          students: [],
          originalStudents: [],
          assignedStudents: [],
          unassignedStudents: [],
          displayStudents: [],
          assignableUsers: [],
          coachesAndAdmins: [],
          stats: { total: 0, assigned: 0, unassigned: 0 },
          loadError: '\u52a0\u8f7d\u5b66\u751f\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
        });
      })
      .finally(() => {
        this.setData({ loading: false });
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  },

  bindSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value || '' });
    this.refreshDisplay();
  },

  onTabChange(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const tab = dataset.tab || 'all';
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    this.refreshDisplay();
  },

  refreshDisplay() {
    const keyword = (this.data.searchKeyword || '').trim().toLowerCase();
    const original = Array.isArray(this.data.originalStudents) ? this.data.originalStudents : [];

    const filteredStudents = keyword
      ? original.filter((item) => {
        const fields = [item.name, item.phone, item.rawPhone];
        return fields.some((value) => String(value || '').toLowerCase().includes(keyword));
      })
      : original;

    const assignedStudents = filteredStudents.filter((item) => item.isAssigned);
    const unassignedStudents = filteredStudents.filter((item) => !item.isAssigned);

    let displayStudents = [];
    switch (this.data.activeTab) {
      case 'assigned':
        displayStudents = assignedStudents;
        break;
      case 'unassigned':
        displayStudents = unassignedStudents;
        break;
      default:
        displayStudents = filteredStudents;
        break;
    }

    this.setData({
      students: filteredStudents,
      assignedStudents,
      unassignedStudents,
      displayStudents,
      stats: {
        total: filteredStudents.length,
        assigned: assignedStudents.length,
        unassigned: unassignedStudents.length
      }
    });
  },

  assignStudentByPhone(phone) {
    return this.assignStudent({ phone });
  },

  assignStudentById(studentId) {
    return this.assignStudent({ studentId });
  },

  assignStudent(params) {
    if (!this.data.coachId) {
      wx.showToast({ title: '\u6559\u7ec3\u4fe1\u606f\u7f3a\u5931\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55', icon: 'none' });
      return Promise.resolve(false);
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return Promise.resolve(false);
    }

    wx.showLoading({ title: '\u5206\u914d\u4e2d...', mask: true });
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'assignStudentToCoach',
        phone: params && params.phone ? params.phone : '',
        studentId: params && params.studentId ? params.studentId : '',
        coachId: this.data.coachId,
        userId: this.data.coachId,
        preferUserId: true
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (typeof result.success === 'undefined') {
          throw new Error('function_not_updated');
        }
        if (!result.success) {
          throw new Error(result.message || 'assign_student_failed');
        }
        wx.showToast({ title: '\u5206\u914d\u6210\u529f', icon: 'success' });
        this.loadStudents();
        return true;
      })
      .catch((error) => {
        console.error('assign student failed:', error);
        const msg = String((error && error.message) || '');
        if (msg.includes('student_not_found')) {
          const phone = this.normalizePhone(params && params.phone ? params.phone : '');
          if (this.isValidPhone(phone)) {
            return this.createStudentByPhone(phone);
          }
          wx.showToast({ title: '\u624b\u673a\u53f7\u672a\u627e\u5230\u7528\u6237', icon: 'none' });
          return false;
        }
        if (msg.includes('invalid_student_role')) {
          wx.showToast({ title: '\u8be5\u7528\u6237\u662f\u6559\u7ec3\u6216\u7ba1\u7406\u5458\uff0c\u4e0d\u53ef\u6dfb\u52a0\u4e3a\u5b66\u5458', icon: 'none' });
          return;
        }
        if (msg.includes('function_not_updated')) {
          wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
          return;
        }
        wx.showToast({ title: '\u5206\u914d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
        return false;
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  createStudentByPhone(phone) {
    if (!this.data.coachId) {
      wx.showToast({ title: '\u6559\u7ec3\u4fe1\u606f\u7f3a\u5931\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55', icon: 'none' });
      return Promise.resolve(false);
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return Promise.resolve(false);
    }
    if (!this.isValidPhone(phone)) {
      wx.showToast({ title: '\u8bf7\u8f93\u5165\u6b63\u786e\u624b\u673a\u53f7', icon: 'none' });
      return Promise.resolve(false);
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'adminSetUserRoleByPhone',
        userId: this.data.coachId,
        preferUserId: true,
        phone,
        role: 'student'
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(String(result.message || 'admin_set_user_role_by_phone_failed'));
        }
        const isCreated = !!result.created;
        wx.showToast({
          title: isCreated ? '\u5df2\u65b0\u5efa\u5b66\u5458' : '\u5df2\u6dfb\u52a0\u5230\u6211\u7684\u5b66\u751f',
          icon: 'success'
        });
        this.loadStudents();
        return true;
      })
      .catch((error) => {
        console.error('create student by phone failed:', error);
        const msg = String((error && error.message) || '');
        if (msg.includes('cannot_update_builtin_admin') || msg.includes('role_not_supported')) {
          wx.showToast({ title: '\u8be5\u8d26\u53f7\u4e0d\u80fd\u8bbe\u7f6e\u4e3a\u5b66\u5458', icon: 'none' });
          return false;
        }
        if (msg.includes('permission_denied')) {
          wx.showToast({ title: '\u6ca1\u6709\u6743\u9650\u6dfb\u52a0\u5b66\u751f', icon: 'none' });
          return false;
        }
        if (msg.includes('invalid_phone')) {
          wx.showToast({ title: '\u624b\u673a\u53f7\u683c\u5f0f\u4e0d\u6b63\u786e', icon: 'none' });
          return false;
        }
        if (msg.includes('function_not_found') || msg.includes('unsupported_type')) {
          wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
          return false;
        }
        wx.showToast({ title: '\u6dfb\u52a0\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
        return false;
      });
  },

  fetchAssignableUsers(db, existingStudents) {
    const _ = db.command;
    const roleCondition = _.in(['user', 'student']);
    const coachId = String(this.data.coachId || '').trim();
    const existingStudentList = Array.isArray(existingStudents) ? existingStudents : [];
    const existingStudentIdSet = new Set(
      existingStudentList.map((item) => String(item && item.id ? item.id : '').trim()).filter(Boolean)
    );
    const query = db.collection(COLLECTION_NAME)
      .where({ role: roleCondition })
      .orderBy('updatedAt', 'desc')
      .limit(200)
      .get()
      .catch(() => ({ data: [] }));

    return query.then((res) => {
      const dataList = res && res.data ? res.data : [];
      const merged = [];
      const idSet = {};
      dataList.forEach((item) => {
        const id = item && item._id ? item._id : '';
        if (!id || idSet[id] || (coachId && id === coachId) || existingStudentIdSet.has(String(id).trim())) {
          return;
        }
        const primaryCoachId = String(item && item.coachId ? item.coachId : '').trim();
        const extraCoachIds = Array.isArray(item && item.coachIds)
          ? item.coachIds.map((coach) => String(coach || '').trim()).filter(Boolean)
          : [];
        if (coachId && (primaryCoachId === coachId || extraCoachIds.includes(coachId))) {
          return;
        }
        idSet[id] = true;
        merged.push(this.normalizeAssignableUser(item));
      });
      return merged;
    });
  },

  fetchCoachesAndAdmins() {
    if (!this.initCloud()) {
      return Promise.resolve([]);
    }
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listCoachesAndAdmins',
        userId: this.data.coachId,
        preferUserId: true
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(result.message || 'list_coaches_admins_failed');
      }
      const list = Array.isArray(result.users) ? result.users : [];
      const currentCoachId = this.normalizeId(this.data.coachId);
      return list.filter((item) => {
        const itemId = this.normalizeId(item.id);
        return itemId && itemId !== currentCoachId;
      });
    }).catch(() => []);
  },

  addStudentByPhoneInput() {
    wx.showModal({
      title: '\u6dfb\u52a0\u5b66\u5458',
      editable: true,
      placeholderText: '\u8bf7\u8f93\u5165\u5b66\u5458\u624b\u673a\u53f7\uff0811\u4f4d\uff09',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const phone = this.normalizePhone(res.content);
        if (!this.isValidPhone(phone)) {
          wx.showToast({ title: '\u8bf7\u8f93\u5165\u6b63\u786e\u624b\u673a\u53f7', icon: 'none' });
          return;
        }
        this.createStudentByPhone(phone);
      }
    });
  },

  addStudent() {
    const candidates = Array.isArray(this.data.assignableUsers) ? this.data.assignableUsers : [];
    if (!candidates.length) {
      this.addStudentByPhoneInput();
      return;
    }

    const maxCount = 5;
    const sliced = candidates.slice(0, maxCount);
    const labels = sliced.map((item) => {
      const roleText = item.role === 'student' ? '\u5b66\u5458' : '\u666e\u901a\u7528\u6237';
      const phoneText = item.phone || '\u672a\u7ed1\u5b9a\u624b\u673a\u53f7';
      return `${item.name} - ${phoneText} - ${roleText}`;
    });
    labels.push('\u624b\u52a8\u8f93\u5165\u624b\u673a\u53f7\uff08\u53ef\u65b0\u5efa\uff09');

    wx.showActionSheet({
      itemList: labels,
      success: (res) => {
        const index = Number(res.tapIndex);
        if (Number.isNaN(index)) {
          return;
        }
        if (index === labels.length - 1) {
          this.addStudentByPhoneInput();
          return;
        }
        const target = sliced[index];
        if (!target || !target.id) {
          return;
        }
        this.assignStudentById(target.id);
      },
      fail: () => {
        wx.showToast({ title: '\u8bf7\u91cd\u8bd5\uff0c\u6216\u76f4\u63a5\u8f93\u5165\u624b\u673a\u53f7', icon: 'none' });
      }
    });
  },

  onSetLessonQuota(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || '').trim();
    const studentName = String(dataset.name || '').trim() || '\u5b66\u5458';
    const currentTotal = Number(dataset.total || 0);
    const currentRemaining = Number(dataset.remaining || 0);
    if (!studentId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return;
    }

    wx.showModal({
      title: `\u8bbe\u7f6e\u8bfe\u65f6 - ${studentName}`,
      editable: true,
      placeholderText: '\u8bf7\u8f93\u5165 \u5269\u4f59/\u603b\u8bfe\u65f6\uff08\u975e\u8d1f\u6574\u6570\uff09\uff0c\u4f8b\u5982 20/20',
      content: `${Math.max(0, currentRemaining)}/${Math.max(0, currentTotal)}`,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const text = String(res.content || '').trim();
        const matched = text.match(/^(\d+)\s*[\/\uff0f]\s*(\d+)$/);
        if (!matched) {
          wx.showToast({ title: '\u8bf7\u8f93\u5165 \u5269\u4f59/\u603b\u8bfe\u65f6\uff08\u975e\u8d1f\u6574\u6570\uff09', icon: 'none' });
          return;
        }
        const remainingLessons = Number(matched[1]);
        const totalLessons = Number(matched[2]);
        if (remainingLessons > totalLessons) {
          wx.showToast({ title: '\u5269\u4f59\u8bfe\u65f6\u4e0d\u80fd\u5927\u4e8e\u603b\u8bfe\u65f6', icon: 'none' });
          return;
        }
        const localUserInfo = wx.getStorageSync('userInfo') || {};
        const operatorUserId = String(
          this.data.coachId
          || localUserInfo.id
          || localUserInfo._id
          || ''
        ).trim();
        if (!operatorUserId) {
          wx.showToast({ title: '\u6559\u7ec3\u4fe1\u606f\u7f3a\u5931\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '\u4fdd\u5b58\u4e2d...', mask: true });
        wx.cloud.callFunction({
          name: 'quickstartFunctions',
          data: {
            type: 'setStudentLessonQuota',
            userId: operatorUserId,
            studentId,
            totalLessons,
            remainingLessons
          }
        })
          .then((callRes) => {
            const result = callRes && callRes.result ? callRes.result : {};
            if (!result.success) {
              throw new Error(result.message || 'set_student_lesson_quota_failed');
            }
            wx.showToast({ title: '\u66f4\u65b0\u6210\u529f', icon: 'success' });
            this.loadStudents();
          })
          .catch((error) => {
            console.error('set lesson quota failed:', error);
            const msg = String((error && error.message) || '');
            if (msg.includes('student_not_assigned_to_coach')) {
              wx.showToast({ title: '\u8be5\u5b66\u5458\u4e0d\u5728\u5f53\u524d\u7ba1\u7406\u5458\u540d\u4e0b', icon: 'none' });
              return;
            }
            if (msg.includes('permission_denied')) {
              wx.showToast({ title: '\u6ca1\u6709\u6743\u9650\u8bbe\u7f6e\u8bfe\u65f6\uff08\u8bf7\u786e\u8ba4\u540c\u5c5e\u4e00\u4e2a\u7ba1\u7406\u5458\uff09', icon: 'none' });
              return;
            }
            if (msg.includes('remaining_exceed_total')) {
              wx.showToast({ title: '\u5269\u4f59\u8bfe\u65f6\u4e0d\u80fd\u5927\u4e8e\u603b\u8bfe\u65f6', icon: 'none' });
              return;
            }
            if (msg.includes('function_not_found') || msg.includes('unsupported_type')) {
              wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
              return;
            }
            wx.showToast({ title: '\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      }
    });
  },

  onRemoveStudent(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || '').trim();
    const studentName = String(dataset.name || '').trim() || '\u5b66\u5458';
    if (!studentId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '\u9000\u51fa\u73ed\u7ea7',
      content: `\u786e\u5b9a\u8981\u5c06\u5b66\u5458\u300c${studentName}\u300d\u79fb\u51fa\u672c\u73ed\u5417\uff1f\u79fb\u51fa\u540e\u8be5\u5b66\u5458\u5c06\u4e0d\u518d\u663e\u793a\u5728\u4f60\u7684\u5b66\u751f\u5217\u8868\u4e2d\u3002`,
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showLoading({ title: '\u5904\u7406\u4e2d...', mask: true });
        wx.cloud.callFunction({
          name: 'quickstartFunctions',
          data: {
            type: 'removeStudentFromCoach',
            userId: this.data.coachId,
            coachId: this.data.coachId,
            studentId,
            preferUserId: true
          }
        })
          .then((callRes) => {
            const result = callRes && callRes.result ? callRes.result : {};
            if (!result.success) {
              throw new Error(result.message || 'remove_student_failed');
            }
            wx.showToast({ title: '\u64cd\u4f5c\u6210\u529f', icon: 'success' });
            this.loadStudents();
          })
          .catch((error) => {
            console.error('remove student failed:', error);
            const msg = String((error && error.message) || '');
            if (msg.includes('student_not_assigned_to_coach')) {
              wx.showToast({ title: '\u8be5\u5b66\u5458\u4e0d\u5728\u5f53\u524d\u6559\u7ec3\u540d\u4e0b', icon: 'none' });
              return;
            }
            if (msg.includes('permission_denied')) {
              wx.showToast({ title: '\u6ca1\u6709\u6743\u9650\u79fb\u51fa\u5b66\u5458', icon: 'none' });
              return;
            }
            if (msg.includes('function_not_found') || msg.includes('unsupported_type')) {
              wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
              return;
            }
            wx.showToast({ title: '\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      }
    });
  },

  onTransferAdmin(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || '').trim();
    const studentName = String(dataset.name || '').trim() || '\u5b66\u5458';
    if (!studentId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return;
    }

    const coachesAndAdmins = Array.isArray(this.data.coachesAndAdmins) ? this.data.coachesAndAdmins : [];
    if (!coachesAndAdmins.length) {
      wx.showToast({ title: '\u6682\u65e0\u53ef\u8f6c\u4ea4\u7684\u6559\u7ec3/\u7ba1\u7406\u5458', icon: 'none' });
      return;
    }

    const labels = coachesAndAdmins.map((item) => {
      const roleText = item.role === 'admin' ? '\u7ba1\u7406\u5458' : '\u6559\u7ec3';
      const phoneText = item.phone ? `(${item.phone})` : '';
      return `${item.name} ${phoneText} - ${roleText}`;
    });

    wx.showActionSheet({
      itemList: labels,
      success: (res) => {
        const index = Number(res.tapIndex);
        if (Number.isNaN(index) || index < 0 || index >= coachesAndAdmins.length) {
          return;
        }
        const target = coachesAndAdmins[index];
        wx.showModal({
          title: '\u79fb\u4ea4\u7ba1\u7406\u5458',
          content: `\u786e\u5b9a\u8981\u5c06\u5b66\u5458\u300c${studentName}\u300d\u7684\u7ba1\u7406\u6743\u79fb\u4ea4\u7ed9\u300c${target.name}\u300d\u5417\uff1f`,
          confirmColor: '#722ed1',
          success: (modalRes) => {
            if (!modalRes.confirm) {
              return;
            }
            wx.showLoading({ title: '\u79fb\u4ea4\u4e2d...', mask: true });
            wx.cloud.callFunction({
              name: 'quickstartFunctions',
              data: {
                type: 'transferStudentToCoach',
                userId: this.data.coachId,
                coachId: this.data.coachId,
                studentId,
                targetCoachId: target.id,
                preferUserId: true
              }
            })
              .then((callRes) => {
                const result = callRes && callRes.result ? callRes.result : {};
                if (!result.success) {
                  throw new Error(result.message || 'transfer_student_failed');
                }
                wx.showToast({ title: '\u79fb\u4ea4\u6210\u529f', icon: 'success' });
                this.loadStudents();
              })
              .catch((error) => {
                console.error('transfer student failed:', error);
                const msg = String((error && error.message) || '');
                if (msg.includes('student_not_assigned_to_coach')) {
                  wx.showToast({ title: '\u8be5\u5b66\u5458\u4e0d\u5728\u5f53\u524d\u6559\u7ec3\u540d\u4e0b', icon: 'none' });
                  return;
                }
                if (msg.includes('permission_denied')) {
                  wx.showToast({ title: '\u6ca1\u6709\u6743\u9650\u79fb\u4ea4\u5b66\u5458', icon: 'none' });
                  return;
                }
                if (msg.includes('function_not_found') || msg.includes('unsupported_type')) {
                  wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
                  return;
                }
                wx.showToast({ title: '\u79fb\u4ea4\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
              })
              .finally(() => {
                wx.hideLoading();
              });
          }
        });
      },
      fail: () => {
        wx.showToast({ title: '\u5df2\u53d6\u6d88\u64cd\u4f5c', icon: 'none' });
      }
    });
  },

  onAssignClass(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || '').trim();
    const studentName = String(dataset.name || '').trim() || '\u5b66\u5458';
    if (!studentId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '\u5206\u73ed\u786e\u8ba4',
      content: `\u786e\u5b9a\u8981\u5c06\u300c${studentName}\u300d\u5206\u914d\u5230\u300c${this.data.i18n.classDefault}\u300d\u5417\uff1f`,
      confirmColor: '#52c41a',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showLoading({ title: '\u5206\u73ed\u4e2d...', mask: true });
        wx.cloud.callFunction({
          name: 'quickstartFunctions',
          data: {
            type: 'assignStudentToClass',
            userId: this.data.coachId,
            coachId: this.data.coachId,
            studentId,
            className: this.data.i18n.classDefault,
            preferUserId: true
          }
        })
          .then((callRes) => {
            const result = callRes && callRes.result ? callRes.result : {};
            if (!result.success) {
              throw new Error(result.message || 'assign_student_to_class_failed');
            }
            wx.showToast({ title: '\u5206\u73ed\u6210\u529f', icon: 'success' });
            this.loadStudents();
          })
          .catch((error) => {
            console.error('assign class failed:', error);
            const msg = String((error && error.message) || '');
            if (msg.includes('function_not_found') || msg.includes('unsupported_type')) {
              wx.showToast({ title: '\u8bf7\u91cd\u65b0\u90e8\u7f72 quickstartFunctions', icon: 'none' });
              return;
            }
            wx.showToast({ title: '\u5206\u73ed\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      }
    });
  },

  onDeleteStudent(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset : {};
    const studentId = String(dataset.id || '').trim();
    const studentName = String(dataset.name || '').trim() || '\u5b66\u5458';
    if (!studentId) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '\u5220\u9664\u5b66\u5458',
      content: `\u786e\u5b9a\u8981\u5220\u9664\u5b66\u5458\u300c${studentName}\u300d\u5417\uff1f\u5220\u9664\u540e\u5c06\u4e0d\u53ef\u6062\u590d\u3002`,
      confirmColor: '#8c8c8c',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showLoading({ title: '\u5220\u9664\u4e2d...', mask: true });
        wx.cloud.callFunction({
          name: 'quickstartFunctions',
          data: {
            type: 'removeStudentFromCoach',
            userId: this.data.coachId,
            coachId: this.data.coachId,
            studentId,
            preferUserId: true
          }
        })
          .then((callRes) => {
            const result = callRes && callRes.result ? callRes.result : {};
            if (!result.success) {
              throw new Error(result.message || 'remove_student_failed');
            }
            wx.showToast({ title: '\u5220\u9664\u6210\u529f', icon: 'success' });
            this.loadStudents();
          })
          .catch((error) => {
            console.error('delete student failed:', error);
            wx.showToast({ title: '\u5220\u9664\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      }
    });
  },

  viewReports() {
    wx.showToast({
      title: '\u62a5\u544a\u5206\u6790\u529f\u80fd\u5df2\u4e0b\u7ebf',
      icon: 'none'
    });
  }
});
