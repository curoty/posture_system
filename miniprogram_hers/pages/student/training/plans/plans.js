const TASK_COLLECTION = 'training_tasks';
const USER_COLLECTION = 'users';

Page({
  data: {
    plans: [],
    loading: false,
    loadError: ''
  },

  onLoad() {
    this.loadPlans();
  },

  onShow() {
    this.loadPlans();
  },

  onPullDownRefresh() {
    this.loadPlans(true);
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

  resolveStudentCoachId(db) {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const localCoachId = String(userInfo.coachId || '').trim();
    if (localCoachId) {
      return Promise.resolve(localCoachId);
    }

    const userId = String(userInfo.id || userInfo._id || '').trim();
    const userPhone = String(userInfo.phone || '').trim();

    const saveCoachId = (coachId) => {
      if (!coachId) {
        return '';
      }
      wx.setStorageSync('userInfo', {
        ...userInfo,
        coachId
      });
      return coachId;
    };

    if (userId) {
      return db.collection(USER_COLLECTION)
        .doc(userId)
        .get()
        .then((res) => {
          const data = res && res.data ? res.data : {};
          return saveCoachId(String(data.coachId || '').trim());
        })
        .catch(() => '');
    }

    if (!userPhone) {
      return Promise.resolve('');
    }

    return db.collection(USER_COLLECTION)
      .where({ phone: userPhone })
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        const data = list.length ? list[0] : {};
        return saveCoachId(String(data.coachId || '').trim());
      })
      .catch(() => '');
  },

  getTimestamp(value) {
    if (!value) {
      return NaN;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === 'string') {
      return new Date(value).getTime();
    }
    if (value && typeof value.toDate === 'function') {
      return value.toDate().getTime();
    }
    if (value && typeof value._seconds === 'number') {
      return value._seconds * 1000;
    }
    return new Date(value).getTime();
  },

  formatDate(value) {
    const timestamp = this.getTimestamp(value);
    if (Number.isNaN(timestamp)) {
      return '-';
    }
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  normalizeStatus(status) {
    const raw = String(status || '').toLowerCase();
    if (raw === 'completed' || raw === 'finished') {
      return { text: '已完成', className: 'completed' };
    }
    if (raw === 'active' || raw === 'in_progress' || raw === 'ongoing') {
      return { text: '进行中', className: 'active' };
    }
    return { text: '待完成', className: 'pending' };
  },

  normalizePlan(item) {
    const safe = item || {};
    const statusInfo = this.normalizeStatus(safe.status);
    const planTime = this.getTimestamp(safe.trainingDate || safe.startDate || safe.createdAt);
    return {
      id: safe._id || safe.id || `task_${Date.now()}`,
      title: safe.trainingType || safe.title || '训练任务',
      date: this.formatDate(safe.trainingDate || safe.startDate || safe.createdAt),
      durationText: `${Number(safe.duration || 0) || 0} 分钟`,
      intensityText: `${safe.intensity || '中'}强度`,
      content: safe.content || '',
      coachName: safe.coachName || '教练',
      statusText: statusInfo.text,
      statusClass: statusInfo.className,
      sortTime: Number.isNaN(planTime) ? 0 : planTime
    };
  },

  fetchTasksByFilter(db, filter, useOrderBy) {
    let query = db.collection(TASK_COLLECTION).where(filter);
    if (useOrderBy) {
      query = query.orderBy('trainingDate', 'asc');
    }
    return query
      .limit(200)
      .get()
      .then((res) => (res && res.data ? res.data : []));
  },

  loadPlans(isPullDown) {
    if (!this.initCloud()) {
      this.setData({
        loading: false,
        loadError: '当前基础库不支持云开发',
        plans: []
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

    const db = wx.cloud.database();
    this.resolveStudentCoachId(db)
      .then((coachId) => {
        if (!coachId) {
          this.setData({
            plans: [],
            loadError: '未绑定教练，暂无任务'
          });
          return [];
        }
        return this.fetchTasksByFilter(db, { coachId }, true)
          .catch(() => this.fetchTasksByFilter(db, { coachId }, false));
      })
      .then((records) => {
        const plans = (records || [])
          .map((item) => this.normalizePlan(item))
          .sort((a, b) => a.sortTime - b.sortTime);

        this.setData({ plans });
      })
      .catch((error) => {
        console.error('加载训练任务失败:', error);
        this.setData({
          plans: [],
          loadError: '加载训练任务失败，请稍后重试'
        });
      })
      .finally(() => {
        this.setData({ loading: false });
        if (isPullDown) {
          wx.stopPullDownRefresh();
        }
      });
  }
});
