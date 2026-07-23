const USER_COLLECTION = 'users';
const TASK_COLLECTION = 'training_tasks';
const NOTIFICATION_COLLECTION = 'notifications';

Page({
  data: {
    trainingDate: '',
    trainingType: '',
    duration: '',
    intensities: ['低', '中', '高'],
    selectedIntensity: '中',
    content: '',
    submitting: false,
    loadError: ''
  },

  onLoad() {
    this.initDate();
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

  getCurrentCoachInfo() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    return {
      id: localUserInfo.id || localUserInfo._id || '',
      name: localUserInfo.name || localUserInfo.nickName || '教练',
      phone: localUserInfo.phone || ''
    };
  },

  initDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    this.setData({
      trainingDate: `${year}-${month}-${day}`
    });
  },

  bindDateChange(e) {
    this.setData({ trainingDate: e.detail.value || '' });
  },

  bindTypeInput(e) {
    this.setData({ trainingType: e.detail.value || '' });
  },

  bindDurationInput(e) {
    this.setData({ duration: e.detail.value || '' });
  },

  bindIntensityChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      selectedIntensity: this.data.intensities[index] || '中'
    });
  },

  bindContentInput(e) {
    this.setData({ content: e.detail.value || '' });
  },

  fetchStudentsByCoachId(db, coachId) {
    if (!coachId) {
      return Promise.resolve([]);
    }

    const fetch = (query) => query
      .limit(500)
      .get()
      .then((res) => (res && res.data ? res.data : []));

    return fetch(db.collection(USER_COLLECTION).where({ role: 'student', coachId }).orderBy('createdAt', 'desc'))
      .catch(() => fetch(db.collection(USER_COLLECTION).where({ role: 'student', coachId })))
      .catch(() => []);
  },

  createTaskNotificationsForCoachStudents(db, coachId, coachName, trainingType) {
    return this.fetchStudentsByCoachId(db, coachId)
      .then((students) => {
        if (!students || students.length === 0) {
          return;
        }
        const title = '新训练任务';
        const content = `${coachName || '教练'}发布了任务：${trainingType || '训练任务'}`;
        const tasks = students
          .map((student) => String(student && (student._id || student.id) || '').trim())
          .filter((id) => !!id)
          .map((studentId) => db.collection(NOTIFICATION_COLLECTION).add({
            data: {
              userId: studentId,
              type: 'training_task',
              title,
              content,
              relatedPath: '/pages/student/training/plans/plans',
              isRead: false,
              createdAt: db.serverDate(),
              updatedAt: db.serverDate()
            }
          }).catch(() => null));
        return Promise.all(tasks).then(() => {});
      });
  },

  submitTrainingRecord() {
    if (this.data.submitting) {
      return;
    }

    const {
      trainingDate,
      trainingType,
      duration,
      selectedIntensity,
      content
    } = this.data;

    const taskType = String(trainingType || '').trim();
    if (!taskType) {
      wx.showToast({ title: '请输入训练类型', icon: 'none' });
      return;
    }

    const durationValue = Number(duration);
    if (!Number.isFinite(durationValue) || durationValue <= 0) {
      wx.showToast({ title: '请输入有效训练时长', icon: 'none' });
      return;
    }

    const taskContent = String(content || '').trim();
    if (!taskContent) {
      wx.showToast({ title: '请输入训练内容', icon: 'none' });
      return;
    }

    if (!this.initCloud()) {
      wx.showToast({ title: '当前基础库不支持云开发', icon: 'none' });
      return;
    }

    const coach = this.getCurrentCoachInfo();
    if (!coach.id) {
      wx.showToast({ title: '教练信息缺失，请重新登录', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中...', mask: true });

    const db = wx.cloud.database();
    const taskData = {
      coachId: coach.id,
      coachName: coach.name || '教练',
      coachPhone: coach.phone || '',
      trainingDate: trainingDate || '',
      trainingType: taskType,
      duration: durationValue,
      intensity: selectedIntensity || '中',
      content: taskContent,
      status: 'pending',
      targetType: 'coach_students',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    };

    db.collection(TASK_COLLECTION).add({
      data: taskData
    })
      .then(() => this.createTaskNotificationsForCoachStudents(db, coach.id, coach.name, taskType))
      .then(() => {
        this.setData({
          trainingType: '',
          duration: '',
          selectedIntensity: '中',
          content: ''
        });
        wx.showToast({ title: '任务发布成功', icon: 'success' });
      })
      .catch((error) => {
        console.error('发布训练任务失败:', error);
        wx.showToast({ title: '发布失败，请稍后重试', icon: 'none' });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ submitting: false });
      });
  }
});
