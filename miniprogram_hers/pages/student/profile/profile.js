const USER_COLLECTION = 'users';
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 32;
const DEFAULT_AVATAR_URL = '/images/default-student-avatar.png';
const LEGACY_DEFAULT_AVATAR_URL = '/images/avatar.png';

Page({
  data: {
    userInfo: {
      name: '',
      phone: '',
      avatarUrl: '',
      joinDate: '',
      level: 0,
      courseCount: 0,
      totalFlowers: 0
    },
    maskedPhone: '157****5396',
    defaultAvatarUrl: DEFAULT_AVATAR_URL,
    accountRole: 'user',
    displayRole: '普通用户',
    loading: false
  },

  onLoad() {
    this.loadUserInfo();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    this.loadUserInfo();
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
      return Promise.reject(new Error('cloud_not_supported'));
    }
    const userId = this.getCurrentUserId();
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type,
        userId,
        preferUserId: !!userId,
        ...(payload || {})
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === 'undefined') {
        throw new Error('function_not_updated');
      }
      if (!result.success) {
        throw new Error(String(result.message || `${type}_failed`));
      }
      return result;
    });
  },

  resolvePasswordErrorMessage(error, fallback) {
    const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
    if (raw.includes('cloud_not_supported')) return '云能力不可用';
    if (raw.includes('old_password_required')) return '请输入当前密码';
    if (raw.includes('old_password_incorrect')) return '当前密码不正确';
    if (raw.includes('password_too_short')) return '密码至少6位';
    if (raw.includes('password_same_as_old')) return '新密码不能与旧密码相同';
    if (raw.includes('password_not_set')) return '账号未设置密码';
    if (raw.includes('password_already_set')) return '账号已设置密码';
    if (raw.includes('account_disabled')) return '账号已被禁用';
    if (raw.includes('user_not_found')) return '用户不存在，请重新登录';
    if (raw.includes('function_not_updated')) return '请重新部署 quickstartFunctions';
    if (raw.includes('cloud.callfunction:fail') || raw.includes('request:fail') || raw.includes('network')) {
      return '网络异常，请重试';
    }
    return fallback || '操作失败，请重试';
  },

  normalizePhone(phone) {
    return String(phone || '').replace(/\s+/g, '');
  },

  maskPhone(phone) {
    const normalized = this.normalizePhone(phone);
    if (/^1\d{10}$/.test(normalized)) {
      return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
    }
    return '未设置';
  },

  isValidPhone(phone) {
    return /^1\d{10}$/.test(phone);
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
    if (lower === LEGACY_DEFAULT_AVATAR_URL || lower.endsWith(LEGACY_DEFAULT_AVATAR_URL)) {
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

  getCurrentUserId() {
    const localUserInfo = wx.getStorageSync('userInfo') || {};
    return localUserInfo.id || localUserInfo._id || '';
  },

  getCurrentLocalUser() {
    return wx.getStorageSync('userInfo') || {};
  },

  resolveUserFilter() {
    const localUserInfo = this.getCurrentLocalUser();
    const userId = localUserInfo.id || localUserInfo._id || '';
    const phone = this.normalizePhone(localUserInfo.phone);
    if (userId) {
      return { userId };
    }
    if (phone) {
      return { userPhone: phone };
    }
    return null;
  },

  getFileExt(filePath, fallbackExt) {
    const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match && match[1] ? match[1].toLowerCase() : fallbackExt;
  },

  uploadAvatarToCloud(tempFilePath) {
    if (!this.initCloud()) {
      return Promise.reject(new Error('cloud_not_supported'));
    }
    const ext = this.getFileExt(tempFilePath, 'jpg');
    const userId = this.getCurrentUserId() || 'user';
    const cloudPath = `users/avatars/${userId}_${Date.now()}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
      .then((res) => {
        const fileID = res && res.fileID ? res.fileID : '';
        if (!fileID) {
          throw new Error('avatar_upload_failed');
        }
        return fileID;
      });
  },

  updateUserProfileInCloud(patch) {
    if (!this.initCloud()) {
      return Promise.reject(new Error('cloud_not_supported'));
    }
    const userId = String(this.getCurrentUserId() || '').trim();
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'updateMyProfile',
        patch: { ...(patch || {}) },
        userId,
        preferUserId: !!userId
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === 'undefined') {
        throw new Error('function_not_updated');
      }
      if (!result.success) {
        throw new Error(String(result.message || 'update_profile_failed'));
      }
      return result.user || null;
    });
  },

  applyLocalUserPatch(patch) {
    const localUserInfo = this.getCurrentLocalUser();
    wx.setStorageSync('userInfo', { ...localUserInfo, ...patch });
  },

  resolveAccountRole(role) {
    const raw = String(role || '').toLowerCase();
    if (raw === 'coach') return 'coach';
    if (raw === 'student') return 'student';
    return 'user';
  },

  resolveDisplayRole(role) {
    if (role === 'coach') return '教练';
    if (role === 'student') return '学员';
    return '普通用户';
  },

  resolveJoinDateValue(user, accountRole) {
    const safe = user && typeof user === 'object' ? user : {};
    const role = this.resolveAccountRole(accountRole || safe.role);
    if (role === 'student') {
      return safe.studentSince
        || safe.studentJoinedAt
        || safe.studentStartAt
        || safe.studentAt
        || safe.joinDate
        || safe.roleUpdatedAt
        || safe.updatedAt
        || safe.createdAt
        || '';
    }
    return safe.joinDate || safe.createdAt || '';
  },

  formatJoinDate(user, accountRole) {
    const value = this.resolveJoinDateValue(user, accountRole);
    return this.formatDate(value);
  },

  formatDate(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.slice(0, 10);

    let dateObj = null;
    if (value instanceof Date) {
      dateObj = value;
    } else if (value && typeof value.toDate === 'function') {
      dateObj = value.toDate();
    } else if (value && typeof value._seconds === 'number') {
      dateObj = new Date(value._seconds * 1000);
    } else {
      dateObj = new Date(value);
    }

    if (!dateObj || Number.isNaN(dateObj.getTime())) return '';

    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  buildScheduleTimestamp(dateText, timeText) {
    const date = String(dateText || '').trim();
    const time = String(timeText || '').trim();
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

  fetchCurrentUserFromCloud() {
    if (!this.initCloud()) {
      return Promise.resolve(null);
    }
    const db = wx.cloud.database();
    const localUserInfo = this.getCurrentLocalUser();
    const userId = localUserInfo.id || localUserInfo._id || '';
    const openid = String(localUserInfo.openid || '').trim();
    const phone = this.normalizePhone(localUserInfo.phone);

    if (userId) {
      return db.collection(USER_COLLECTION).doc(userId).get()
        .then((res) => (res && res.data ? res.data : null))
        .catch(() => null);
    }
    if (openid) {
      return db.collection(USER_COLLECTION).where({ openid }).limit(1).get()
        .then((res) => {
          const list = res && Array.isArray(res.data) ? res.data : [];
          return list[0] || null;
        })
        .catch(() => null);
    }
    if (this.isValidPhone(phone)) {
      return db.collection(USER_COLLECTION).where({ phone }).limit(1).get()
        .then((res) => {
          const list = res && Array.isArray(res.data) ? res.data : [];
          return list[0] || null;
        })
        .catch(() => null);
    }
    return Promise.resolve(null);
  },

  refreshUserProfileFromCloud() {
    this.fetchCurrentUserFromCloud()
      .then((cloudUser) => {
        if (!cloudUser || !cloudUser._id) {
          return;
        }

        const localUserInfo = this.getCurrentLocalUser();
        const accountRole = this.resolveAccountRole(
          wx.getStorageSync('accountRole') || cloudUser.role || localUserInfo.role
        );
        const nextJoinDate = this.formatJoinDate(cloudUser, accountRole) || '未设置';
        const nextAvatar = this.normalizeAvatarUrl(cloudUser.avatarUrl) || this.normalizeAvatarUrl(localUserInfo.avatarUrl);
        const patch = {
          id: cloudUser._id || localUserInfo.id || '',
          name: cloudUser.name || cloudUser.nickName || localUserInfo.name || '',
          phone: cloudUser.phone || localUserInfo.phone || '',
          avatarUrl: nextAvatar,
          role: cloudUser.role || localUserInfo.role || '',
          joinDate: cloudUser.joinDate || localUserInfo.joinDate || '',
          studentSince: cloudUser.studentSince || localUserInfo.studentSince || '',
          roleUpdatedAt: cloudUser.roleUpdatedAt || localUserInfo.roleUpdatedAt || '',
          createdAt: cloudUser.createdAt || localUserInfo.createdAt || '',
          updatedAt: cloudUser.updatedAt || localUserInfo.updatedAt || '',
          level: Number(cloudUser.level || localUserInfo.level || 0),
          passwordHash: cloudUser.passwordHash || localUserInfo.passwordHash || ''
        };
        this.applyLocalUserPatch(patch);
        this.setData({
          accountRole,
          displayRole: this.resolveDisplayRole(accountRole),
          maskedPhone: this.maskPhone(patch.phone),
          userInfo: {
            ...this.data.userInfo,
            name: patch.name || '未设置',
            phone: patch.phone || '未设置',
            avatarUrl: nextAvatar,
            joinDate: nextJoinDate,
            level: patch.level,
            hasPassword: !!cloudUser.passwordHash
          }
        });
      })
      .catch((error) => {
        console.error('加载云端用户资料失败:', error);
      });
  },

  loadUserInfo() {
    const localUserInfo = this.getCurrentLocalUser();
    const accountRole = this.resolveAccountRole(wx.getStorageSync('accountRole') || localUserInfo.role);

    this.setData({
      userInfo: {
        name: localUserInfo.name || '未设置',
        phone: localUserInfo.phone || '未设置',
        avatarUrl: this.normalizeAvatarUrl(localUserInfo.avatarUrl),
        joinDate: this.formatJoinDate(localUserInfo, accountRole) || '未设置',
        level: Number(localUserInfo.level || 0),
        courseCount: Number(localUserInfo.courseCount || 0),
        totalFlowers: Number(localUserInfo.totalFlowers || 0),
        hasPassword: !!localUserInfo.passwordHash
      },
      maskedPhone: this.maskPhone(localUserInfo.phone),
      accountRole,
      displayRole: this.resolveDisplayRole(accountRole),
      loading: false
    });
    this.refreshUserProfileFromCloud();
    this.refreshCourseCountFromCloud();
    this.refreshFlowerSummaryFromCloud();
  },

  countScheduleBookingsFromCloud() {
    if (!this.initCloud()) {
      return Promise.resolve(0);
    }
    const currentUserId = this.getCurrentUserId();
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'listMyScheduleBookings',
        userId: currentUserId,
        preferUserId: !!currentUserId,
        asBooker: true,
        forceStudentView: true,
        expectedRole: 'student'
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return 0;
        }
        const bookings = Array.isArray(result.bookings) ? result.bookings : [];
        const now = Date.now();
        const completedCount = bookings.reduce((total, item) => {
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
        return completedCount;
      })
      .catch(() => 0);
  },

  refreshCourseCountFromCloud() {
    const applyCourseCount = (value) => {
      const courseCount = Math.max(0, Number(value || 0));
      this.applyLocalUserPatch({ courseCount });
      this.setData({
        userInfo: {
          ...this.data.userInfo,
          courseCount
        }
      });
    };

    this.countScheduleBookingsFromCloud()
      .then((completedLessons) => {
        applyCourseCount(completedLessons);
      })
      .catch((error) => {
        console.error('加载已上课程统计失败:', error);
      });
  },

  refreshFlowerSummaryFromCloud() {
    if (!this.initCloud()) {
      return;
    }
    const localUserInfo = this.getCurrentLocalUser();
    const currentUserId = localUserInfo.id || localUserInfo._id || '';
    const applyTotalFlowers = (value) => {
      const totalFlowers = Math.max(0, Number(value || 0));
      this.applyLocalUserPatch({ totalFlowers });
      this.setData({
        userInfo: {
          ...this.data.userInfo,
          totalFlowers
        }
      });
    };

    const fallbackFromReports = () => {
      return wx.cloud.callFunction({
        name: 'quickstartFunctions',
        data: {
          type: 'listStudentTrainingReports',
          userId: currentUserId,
          forceStudentView: true,
          expectedRole: 'student'
        }
      })
        .then((res) => {
          const result = res && res.result ? res.result : {};
          if (!result.success) {
            return 0;
          }
          const reports = Array.isArray(result.reports) ? result.reports : [];
          return reports.reduce((sum, item) => (
            sum + Math.max(0, Number(item && item.studentFlowerCount ? item.studentFlowerCount : 0))
          ), 0);
        })
        .catch(() => 0);
    };

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'getStudentFlowerSummary',
        userId: currentUserId,
        forceStudentView: true,
        expectedRole: 'student'
      }
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          return fallbackFromReports().then((sum) => {
            applyTotalFlowers(sum);
          });
        }
        applyTotalFlowers(result.totalFlowerCount || 0);
      })
      .catch((error) => {
        console.error('加载小红花统计失败:', error);
        fallbackFromReports().then((sum) => {
          applyTotalFlowers(sum);
        });
      });
  },

  bindPhoneInCloud(phone) {
    if (!this.initCloud()) {
      return Promise.reject(new Error('cloud_not_supported'));
    }

    const localUserInfo = this.getCurrentLocalUser();
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'bindUserPhone',
        phone,
        userId: localUserInfo.id || localUserInfo._id || ''
      }
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (typeof result.success === 'undefined') {
        throw new Error('function_not_updated');
      }
      if (!result.success) {
        throw new Error(result.message || 'bind_phone_failed');
      }
      return result.user || {};
    });
  },

  changeAvatar() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const list = res && res.tempFilePaths ? res.tempFilePaths : [];
        const tempFilePath = list[0] || '';
        const previousAvatar = this.normalizeAvatarUrl(this.data.userInfo.avatarUrl);
        if (!tempFilePath) {
          wx.showToast({ title: '图片读取失败', icon: 'none' });
          return;
        }

        this.applyLocalUserPatch({ avatarUrl: tempFilePath });
        this.setData({ userInfo: { ...this.data.userInfo, avatarUrl: tempFilePath } });

        wx.showLoading({ title: '上传中...', mask: true });
        let cloudAvatarUrl = '';
        this.uploadAvatarToCloud(tempFilePath)
          .then((fileID) => {
            cloudAvatarUrl = fileID;
            return this.updateUserProfileInCloud({ avatarUrl: cloudAvatarUrl });
          })
          .then(() => {
            this.applyLocalUserPatch({ avatarUrl: cloudAvatarUrl });
            this.setData({ userInfo: { ...this.data.userInfo, avatarUrl: cloudAvatarUrl } });
            wx.showToast({ title: '头像已更新', icon: 'success' });
          })
          .catch((error) => {
            console.error('更新头像失败:', error);
            this.applyLocalUserPatch({ avatarUrl: previousAvatar });
            this.setData({ userInfo: { ...this.data.userInfo, avatarUrl: previousAvatar } });
            wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
      fail: () => {
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      }
    });
  },

  editProfile() {
    const currentName = String(this.data.userInfo.name || '').trim();
    wx.showModal({
      title: '编辑昵称',
      editable: true,
      placeholderText: '请输入昵称',
      content: currentName,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = String(res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '昵称不能为空', icon: 'none' });
          return;
        }
        if (name.length > 20) {
          wx.showToast({ title: '昵称最多20个字', icon: 'none' });
          return;
        }

        this.applyLocalUserPatch({ name, nickName: name });
        this.setData({ userInfo: { ...this.data.userInfo, name } });

        wx.showLoading({ title: '保存中...', mask: true });
        this.updateUserProfileInCloud({ name, nickName: name })
          .then(() => {
            wx.showToast({ title: '昵称已更新', icon: 'success' });
          })
          .catch((error) => {
            console.error('更新昵称失败:', error);
            const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
            const message = raw.includes('function_not_updated')
              ? '请重新部署 quickstartFunctions'
              : '昵称更新失败，请重试';
            wx.showToast({ title: message, icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      }
    });
  },

  editPhone() {
    wx.showToast({ title: '手机号暂不支持修改', icon: 'none' });
  },

  bindPhone() {
    const currentPhone = this.data.userInfo.phone && this.data.userInfo.phone !== '未设置' ? this.data.userInfo.phone : '';
    wx.showModal({
      title: currentPhone ? '更换手机号' : '绑定手机号',
      editable: true,
      placeholderText: '请输入11位手机号',
      content: currentPhone || '',
      confirmText: '确认',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const phone = this.normalizePhone(res.content);
        if (!this.isValidPhone(phone)) {
          wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
          return;
        }

        wx.showLoading({ title: '绑定中...', mask: true });
        this.bindPhoneInCloud(phone)
          .then(() => {
            this.applyLocalUserPatch({ phone });
            this.setData({
              maskedPhone: this.maskPhone(phone),
              userInfo: { ...this.data.userInfo, phone }
            });
            wx.showToast({ title: '手机号绑定成功', icon: 'success' });
          })
          .catch((error) => {
            console.error('绑定手机号失败:', error);
            const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
            let message = '绑定失败，请重试';
            if (raw.includes('function_not_updated')) {
              message = '请重新部署 quickstartFunctions';
            } else if (raw.includes('phone_in_use')) {
              message = '该手机号已绑定其他账号';
            } else if (raw.includes('invalid_phone')) {
              message = '手机号格式不正确';
            }
            wx.showToast({ title: message, icon: 'none' });
          })
          .finally(() => {
            wx.hideLoading();
          });
      },
    });
  },

  changePassword() {
    const hasPassword = this.data.userInfo.hasPassword;
    
    if (!hasPassword) {
      wx.showModal({
        title: '设置初始密码',
        editable: true,
        placeholderText: '请设置初始密码（至少6位）',
        content: '',
        success: (res) => {
          if (!res.confirm) {
            return;
          }
          const newPassword = String(res.content || '').trim();
          if (newPassword.length < PASSWORD_MIN_LENGTH) {
            wx.showToast({ title: '密码至少6位', icon: 'none' });
            return;
          }
          if (newPassword.length > PASSWORD_MAX_LENGTH) {
            wx.showToast({ title: '密码最多32位', icon: 'none' });
            return;
          }

          wx.showLoading({ title: '保存中...', mask: true });
          this.callPasswordCloudFunction('setInitialPassword', { newPassword })
            .then(() => {
              wx.showToast({ title: '密码设置成功', icon: 'success' });
              this.setData({ userInfo: { ...this.data.userInfo, hasPassword: true } });
            })
            .catch((error) => {
              wx.showToast({
                title: this.resolvePasswordErrorMessage(error, '密码设置失败'),
                icon: 'none'
              });
            })
            .finally(() => {
              wx.hideLoading();
            });
        }
      });
      return;
    }

    wx.showModal({
      title: '修改密码',
      editable: true,
      placeholderText: '请输入当前密码',
      content: '',
      success: (oldRes) => {
        if (!oldRes.confirm) {
          return;
        }
        const oldPassword = String(oldRes.content || '').trim();
        if (!oldPassword) {
          wx.showToast({ title: '请输入当前密码', icon: 'none' });
          return;
        }

        wx.showModal({
          title: '设置新密码',
          editable: true,
          placeholderText: '请输入新密码（至少6位）',
          content: '',
          success: (newRes) => {
            if (!newRes.confirm) {
              return;
            }
            const newPassword = String(newRes.content || '').trim();
            if (newPassword.length < PASSWORD_MIN_LENGTH) {
              wx.showToast({ title: '新密码至少6位', icon: 'none' });
              return;
            }
            if (newPassword.length > PASSWORD_MAX_LENGTH) {
              wx.showToast({ title: '新密码最多32位', icon: 'none' });
              return;
            }

            wx.showLoading({ title: '保存中...', mask: true });
            this.callPasswordCloudFunction('changeMyPassword', { oldPassword, newPassword })
              .then(() => {
                wx.showToast({ title: '密码修改成功', icon: 'success' });
              })
              .catch((error) => {
                wx.showToast({
                  title: this.resolvePasswordErrorMessage(error, '密码修改失败'),
                  icon: 'none'
                });
              })
              .finally(() => {
                wx.hideLoading();
              });
          }
        });
      }
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('userRole');
          wx.removeStorageSync('accountRole');
          wx.removeStorageSync('userInfo');
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  },

  openSettings() {
    wx.showActionSheet({
      itemList: ['修改密码', '退出登录'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.changePassword();
          return;
        }
        if (res.tapIndex === 1) {
          this.logout();
        }
      }
    });
  },

  onShareAppMessage() {
    return {
      title: 'AI上轮滑',
      path: '/pages/login/login',
      imageUrl: DEFAULT_AVATAR_URL
    };
  }
});



