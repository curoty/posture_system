const USER_COLLECTION = 'users';
const { pickRandomAvatar, resolveAvatarSeed } = require('../../utils/avatar');
const { hasAdminAccessByUser } = require('../../utils/permission');

const UI_TEXT = {
  logo: 'AI\u4e0a\u8f6e\u6ed1',
  phonePlaceholder: '\u8bf7\u8f93\u5165\u624b\u673a\u53f7',
  codePlaceholder: '\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801',
  codeButton: '\u83b7\u53d6\u9a8c\u8bc1\u7801',
  codeLoginButton: '\u767b\u5f55',
  forgotPasswordButton: '\u5fd8\u8bb0\u5bc6\u7801\uff1f\u91cd\u7f6e\u4e3a123456',
  wechatLoginButton: '\u5fae\u4fe1\u767b\u5f55',
};

const TOAST_TEXT = {
  invalidPhone: '\u8bf7\u8f93\u5165\u6b63\u786e\u624b\u673a\u53f7',
  missingCode: '\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801',
  agreementRequired: '\u8bf7\u5148\u52fe\u9009\u7528\u6237\u534f\u8bae\u548c\u9690\u79c1\u653f\u7b56',
  verifyCodeSent: '\u9a8c\u8bc1\u7801\u5df2\u53d1\u9001',
  missingPassword: '\u8bf7\u8f93\u5165\u5bc6\u7801',
  passwordTooShort: '\u5bc6\u7801\u81f3\u5c116\u4f4d',
  passwordNotMatch: '\u4e24\u6b21\u8f93\u5165\u7684\u5bc6\u7801\u4e0d\u4e00\u81f4',
  cloudUnavailable: '\u5f53\u524d\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1',
  openidUnavailable: '\u5fae\u4fe1\u8eab\u4efd\u83b7\u53d6\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5',
  cloudBusy: '\u4e91\u7aef\u5904\u7406\u8d85\u65f6\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5',
  networkError: '\u7f51\u7edc\u5f02\u5e38\uff0c\u8bf7\u68c0\u67e5\u540e\u91cd\u8bd5',
  accountNotFound: '\u8d26\u53f7\u4e0d\u5b58\u5728\uff0c\u8bf7\u5148\u7528\u5fae\u4fe1\u6388\u6743\u767b\u5f55',
  passwordNotSet: '\u8d26\u53f7\u672a\u8bbe\u7f6e\u5bc6\u7801\uff0c\u8bf7\u8054\u7cfb\u6559\u7ec3\u8bbe\u7f6e',
  passwordIncorrect: '\u5bc6\u7801\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5',
  accountDisabled: '\u8d26\u53f7\u5df2\u7981\u7528\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458',
  wechatBoundToOtherPhone: '\u5f53\u524d\u5fae\u4fe1\u5df2\u7ed1\u5b9a\u5176\u4ed6\u624b\u673a\u53f7\u8d26\u53f7',
  loggingIn: '\u767b\u5f55\u4e2d...',
  wechatLoggingIn: '\u5fae\u4fe1\u767b\u5f55\u4e2d...',
  loginSuccess: '\u767b\u5f55\u6210\u529f',
  loginFailed: '\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5',
  phoneBoundToOtherWechat: '\u8be5\u624b\u673a\u53f7\u5df2\u7ed1\u5b9a\u5176\u4ed6\u5fae\u4fe1',
  wechatLoginFailed: '\u5fae\u4fe1\u767b\u5f55\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5',
  resetPasswordConfirm: '\u786e\u8ba4\u5c06\u8be5\u624b\u673a\u53f7\u7684\u5bc6\u7801\u91cd\u7f6e\u4e3a123456\u5417\uff1f',
  resettingPassword: '\u91cd\u7f6e\u4e2d...',
  resetPasswordSuccess: '\u5df2\u91cd\u7f6e\uff0c\u8bf7\u7528123456\u767b\u5f55',
  registering: '\u6ce8\u518c\u4e2d...',
  registerSuccess: '\u6ce8\u518c\u6210\u529f',
  registerFailed: '\u6ce8\u518c\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5',
  phoneAlreadyRegistered: '\u8be5\u624b\u673a\u53f7\u5df2\u6ce8\u518c\uff0c\u8bf7\u76f4\u63a5\u767b\u5f55',
};

Page({
  data: {
    uiText: UI_TEXT,
    phone: '',
    password: '',
    confirmPassword: '',
    code: '',
    agreed: false,
    codeCountdown: 0,
    submitting: false,
    isRegisterMode: false,
  },

  codeCountdownTimer: null,

  onLoad() {
    // 如果已登录，直接跳转
    const userInfo = wx.getStorageSync('userInfo');
    const runtimeRole = wx.getStorageSync('userRole');
    if (userInfo && userInfo.id && runtimeRole) {
      this.redirectByRole(runtimeRole);
    }
  },

  bindPhoneInput(e) {
    this.setData({ phone: e.detail.value || '' });
  },

  bindPasswordInput(e) {
    this.setData({ password: e.detail.value || '' });
  },

  bindCodeInput(e) {
    this.setData({ code: e.detail.value || '' });
  },

  bindConfirmPasswordInput(e) {
    this.setData({ confirmPassword: e.detail.value || '' });
  },

  toggleAgreement() {
    this.setData({ agreed: !this.data.agreed });
  },

  toggleMode() {
    this.setData({
      isRegisterMode: !this.data.isRegisterMode,
      confirmPassword: '',
    });
  },

  requestVerifyCode() {
    if (this.data.submitting || this.data.codeCountdown > 0) {
      return;
    }
    const phone = this.normalizePhone(this.data.phone);
    if (!this.isValidPhone(phone)) {
      wx.showToast({ title: TOAST_TEXT.invalidPhone, icon: 'none' });
      return;
    }
    wx.showToast({ title: TOAST_TEXT.verifyCodeSent, icon: 'success' });
    this.setData({ codeCountdown: 60 });
    this.codeCountdownTimer = setInterval(() => {
      const next = Math.max(0, Number(this.data.codeCountdown || 0) - 1);
      this.setData({ codeCountdown: next });
      if (next <= 0 && this.codeCountdownTimer) {
        clearInterval(this.codeCountdownTimer);
        this.codeCountdownTimer = null;
      }
    }, 1000);
  },

  normalizePhone(phone) {
    return String(phone || '').replace(/\s+/g, '');
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

  resolveDefaultAvatar(user, fallbackSeed) {
    return pickRandomAvatar(resolveAvatarSeed(user, fallbackSeed));
  },

  isValidPhone(phone) {
    return /^1\d{10}$/.test(phone);
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

  resolveRole(role) {
    const raw = String(role || '').toLowerCase();
    if (raw === 'admin') {
      return 'admin';
    }
    if (raw === 'coach') {
      return 'coach';
    }
    if (raw === 'student') {
      return 'student';
    }
    return 'user';
  },

  normalizeCoachIds(user) {
    const safe = user && typeof user === 'object' ? user : {};
    const arr = [];
    const rawList = Array.isArray(safe.coachIds)
      ? safe.coachIds
      : (Array.isArray(safe.coachids) ? safe.coachids : []);
    rawList.forEach((item) => {
      const id = String(item || '').trim();
      if (id) {
        arr.push(id);
      }
    });
    const singleId = String(safe.coachId || safe.coachid || '').trim();
    if (singleId) {
      arr.push(singleId);
    }
    return Array.from(new Set(arr));
  },

  saveSession(user) {
    const accountRole = this.resolveRole(user.role);
    const adminAccess = accountRole === 'admin' || hasAdminAccessByUser(user);
    let runtimeRole = 'student';
    if (accountRole === 'admin') {
      runtimeRole = 'admin';
    } else if (accountRole === 'coach') {
      runtimeRole = 'coach';
    }
    const coachIds = this.normalizeCoachIds(user);
    const coachId = String(user.coachId || user.coachid || coachIds[0] || '').trim();
    const normalizedAvatar = this.normalizeAvatarUrl(user.avatarUrl);
    const resolvedAvatar = normalizedAvatar || this.resolveDefaultAvatar(user);
    if (!normalizedAvatar && user && user._id) {
      this.updateUserDoc(user._id, { avatarUrl: resolvedAvatar }).catch(() => {});
    }
    const userInfo = {
      id: user._id || user.id || '',
      name: user.name || user.nickName || '',
      phone: user.phone || '',
      avatarUrl: resolvedAvatar,
      level: user.level,
      role: accountRole,
      adminAccess,
      status: user.status || 'active',
      coachId,
      coachIds,
      openid: user.openid || user._openid || '',
      joinDate: user.joinDate || '',
      studentSince: user.studentSince || '',
      roleUpdatedAt: user.roleUpdatedAt || '',
      createdAt: user.createdAt || '',
      updatedAt: user.updatedAt || '',
    };

    wx.setStorageSync('accountRole', accountRole);
    wx.setStorageSync('userRole', runtimeRole);
    wx.setStorageSync('adminAccess', adminAccess);
    wx.setStorageSync('userInfo', userInfo);
    return runtimeRole;
  },

  redirectByRole(runtimeRole) {
    if (runtimeRole === 'admin') {
      wx.reLaunch({ url: '/pages/coach/index/index?role=admin' });
      return;
    }
    if (runtimeRole === 'coach') {
      wx.reLaunch({ url: '/pages/coach/index/index' });
      return;
    }
    wx.switchTab({ url: '/pages/student/index/index' });
  },

  fetchUserByPhone(phone) {
    const db = wx.cloud.database();
    return db.collection(USER_COLLECTION)
      .where({ phone })
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        return list.length ? list[0] : null;
      });
  },

  buildDefaultUserFields(baseUser) {
    const safe = baseUser && typeof baseUser === 'object' ? baseUser : {};
    const phone = this.normalizePhone(safe.phone || '');
    const openid = String(safe.openid || safe._openid || '').trim();
    const role = this.resolveRole(safe.role);
    const fallbackName = phone
      ? `User${phone.slice(-4)}`
      : (openid ? `WeChatUser${openid.slice(-6)}` : 'UserNew');
    const name = String(safe.name || safe.nickName || fallbackName).trim() || fallbackName;
    const avatarSeed = openid || phone || name;
    const avatarUrl = this.normalizeAvatarUrl(safe.avatarUrl)
      || this.resolveDefaultAvatar({ ...safe, phone, openid, name }, avatarSeed);
    const levelNumber = Number(safe.level);
    const level = Number.isFinite(levelNumber)
      ? Math.max(0, Math.floor(levelNumber))
      : (role === 'coach' ? 1 : 0);
    const coachIds = this.normalizeCoachIds(safe);
    const coachId = String(safe.coachId || safe.coachid || coachIds[0] || '').trim();

    return {
      name,
      nickName: String(safe.nickName || name).trim() || name,
      phone,
      role,
      status: String(safe.status || 'active').trim() || 'active',
      level,
      adminAccess: !!safe.adminAccess,
      coachId,
      coachIds,
      avatarUrl,
      openid,
      joinDate: safe.joinDate || '',
      studentSince: safe.studentSince || '',
      roleUpdatedAt: safe.roleUpdatedAt || '',
      createdAt: safe.createdAt || new Date(),
      updatedAt: safe.updatedAt || new Date(),
    };
  },

  buildDefaultPhoneUser(phone) {
    const safePhone = this.normalizePhone(phone);
    const defaultName = `User${safePhone.slice(-4)}`;
    return this.buildDefaultUserFields({
      name: defaultName,
      nickName: defaultName,
      phone: safePhone,
      role: 'user',
      status: 'active',
      level: 0,
      adminAccess: false,
      coachId: '',
      coachIds: [],
      openid: '',
      joinDate: '',
      studentSince: '',
      roleUpdatedAt: '',
    });
  },

  ensureUserFields(user, extra) {
    const safe = user && typeof user === 'object' ? user : {};
    const safeExtra = extra && typeof extra === 'object' ? extra : {};
    const fallbackPhone = this.normalizePhone(safeExtra.phone || '');
    const fallbackOpenid = String(safeExtra.openid || '').trim();
    const normalized = this.buildDefaultUserFields({
      ...safe,
      phone: safe.phone || fallbackPhone,
      openid: safe.openid || safe._openid || fallbackOpenid,
    });

    const patch = {};
    const roleRaw = String(safe.role || '').trim();
    if (!roleRaw || this.resolveRole(roleRaw) !== roleRaw.toLowerCase()) {
      patch.role = normalized.role;
    }
    if (!String(safe.status || '').trim()) {
      patch.status = normalized.status;
    }
    const levelNumber = Number(safe.level);
    if (!Number.isFinite(levelNumber) || (normalized.role === 'coach' && levelNumber <= 0)) {
      patch.level = normalized.level;
    }
    if (typeof safe.adminAccess === 'undefined') {
      patch.adminAccess = false;
    }
    if (typeof safe.coachId === 'undefined' && typeof safe.coachid === 'undefined') {
      patch.coachId = normalized.coachId;
    }
    if (!Array.isArray(safe.coachIds) && !Array.isArray(safe.coachids)) {
      patch.coachIds = normalized.coachIds;
    }
    if (!String(safe.name || safe.nickName || '').trim()) {
      patch.name = normalized.name;
    }
    if (!String(safe.nickName || '').trim()) {
      patch.nickName = normalized.nickName;
    }
    if (!String(safe.phone || '').trim() && normalized.phone) {
      patch.phone = normalized.phone;
    }
    if (!String(safe.openid || safe._openid || '').trim() && normalized.openid) {
      patch.openid = normalized.openid;
    }
    if (!this.normalizeAvatarUrl(safe.avatarUrl)) {
      patch.avatarUrl = normalized.avatarUrl;
    }
    if (typeof safe.joinDate === 'undefined') {
      patch.joinDate = normalized.joinDate;
    }
    if (typeof safe.studentSince === 'undefined') {
      patch.studentSince = normalized.studentSince;
    }
    if (typeof safe.roleUpdatedAt === 'undefined') {
      patch.roleUpdatedAt = normalized.roleUpdatedAt;
    }
    if (typeof safe.createdAt === 'undefined') {
      patch.createdAt = normalized.createdAt;
    }
    if (typeof safe.updatedAt === 'undefined') {
      patch.updatedAt = normalized.updatedAt;
    }

    const merged = {
      ...normalized,
      ...safe,
      ...patch,
    };

    if (!safe._id || !Object.keys(patch).length) {
      return Promise.resolve(merged);
    }
    return this.updateUserDoc(safe._id, patch)
      .then(() => merged)
      .catch(() => merged);
  },

  // Backward compatible alias to keep old call sites safe.
  ensureCoachFields(user, extra) {
    return this.ensureUserFields(user, extra);
  },

  fetchOrCreateUserByPhone(phone) {
    const db = wx.cloud.database();
    return this.fetchUserByPhone(phone)
      .then((user) => {
        if (user) {
          return this.ensureUserFields(user, { phone });
        }
        const data = this.buildDefaultPhoneUser(phone);
        return db.collection(USER_COLLECTION)
          .add({ data })
          .then((addRes) => ({
            _id: addRes && addRes._id ? addRes._id : '',
            ...data,
          }));
      });
  },

  getOpenIdFromCloud() {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: { type: 'getOpenId' },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      const openid = result.openid || '';
      if (!openid) {
        throw new Error('openid_not_found');
      }
      return openid;
    });
  },

  resolvePhoneLoginUser(phone) {
    // Account-password login should rely on phone account itself.
    // Do not block login by WeChat openid binding state.
    return this.fetchOrCreateUserByPhone(phone).then((user) => this.ensureUserFields(user, { phone }));
  },

  loginByPhoneWithPassword(phone, password) {
    const invoke = () => wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'loginByPhonePassword',
        phone,
        password,
      },
    });
    return invoke()
      .catch((error) => {
        if (this.isCloudTimeoutError(error)) {
          return invoke();
        }
        throw error;
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const message = String(result.message || 'login_by_phone_password_failed');
          if (message === 'phone_bound_to_other_wechat') {
            return this.fetchUserByPhone(phone).then((user) => user || null);
          }
          throw new Error(message);
        }
        return result.user || null;
      });
  },

  resetPasswordByPhone(phone, newPassword) {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'resetPasswordByPhone',
        phone,
        newPassword,
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'reset_password_by_phone_failed'));
      }
      return result;
    });
  },

  resolveLoginErrorMessage(error, mode) {
    const loginMode = mode === 'wechat' ? 'wechat' : 'phone';
    const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
    const errCode = Number(error && error.errCode);
    if (raw.includes('phone_bound_to_other_wechat')) {
      return TOAST_TEXT.phoneBoundToOtherWechat;
    }
    if (raw.includes('openid_bound_to_other_phone')) {
      return TOAST_TEXT.wechatBoundToOtherPhone;
    }
    if (raw.includes('password_not_set')) {
      return TOAST_TEXT.passwordNotSet;
    }
    if (raw.includes('password_too_short')) {
      return TOAST_TEXT.passwordTooShort;
    }
    if (raw.includes('password_incorrect')) {
      return TOAST_TEXT.passwordIncorrect;
    }
    if (raw.includes('account_disabled')) {
      return TOAST_TEXT.accountDisabled;
    }
    if (raw.includes('account_not_found')) {
      return TOAST_TEXT.accountNotFound;
    }
    if (raw.includes('openid_not_found')) {
      return TOAST_TEXT.openidUnavailable;
    }
    if (this.isCloudTimeoutError(error)) {
      return TOAST_TEXT.cloudBusy;
    }
    if (
      raw.includes('request:fail')
      || raw.includes('network')
      || raw.includes('cloud.callfunction:fail')
      || raw.includes('failed to fetch')
      || raw.includes('econnreset')
      || raw.includes('econnrefused')
    ) {
      return TOAST_TEXT.networkError;
    }
    if (raw.includes('user_not_found')) {
      return loginMode === 'wechat' ? TOAST_TEXT.wechatLoginFailed : TOAST_TEXT.accountNotFound;
    }
    if (raw.includes('sms_code_error')) {
      return '验证码错误';
    }
    if (raw.includes('sms_code_expired')) {
      return '验证码已过期';
    }
    if (raw.includes('phone_not_registered')) {
      return '该手机号未注册';
    }
    if (raw.includes('send_sms_code_failed')) {
      return '发送验证码失败';
    }
    if (raw.includes('reset_password_with_code_failed')) {
      return '重置密码失败';
    }
    return loginMode === 'wechat' ? TOAST_TEXT.wechatLoginFailed : TOAST_TEXT.loginFailed;
  },

  isCloudTimeoutError(error) {
    const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
    const errCode = Number(error && error.errCode);
    return errCode === -404012
      || raw.includes('polling exceed max timeout retry')
      || raw.includes('timeout')
      || raw.includes('function execute timeout');
  },

  fetchUserByOpenId(openid) {
    const db = wx.cloud.database();
    const _ = db.command;
    return db.collection(USER_COLLECTION)
      .where(_.or([{ openid }, { _openid: openid }]))
      .limit(1)
      .get()
      .then((res) => {
        const list = res && res.data ? res.data : [];
        if (!list.length) {
          return null;
        }
        const preferred = list.find((item) => {
          const role = this.resolveRole(item && item.role);
          return role === 'coach' || role === 'admin';
        });
        return preferred || list[0];
      });
  },

  buildDefaultWechatUser(openid, phone) {
    const defaultName = `WeChatUser${String(openid || '').slice(-6)}`;
    return this.buildDefaultUserFields({
      name: defaultName,
      nickName: defaultName,
      phone: phone || '',
      role: 'user',
      status: 'active',
      level: 0,
      adminAccess: false,
      coachId: '',
      coachIds: [],
      openid,
      joinDate: '',
      studentSince: '',
      roleUpdatedAt: '',
    });
  },

  updateUserDoc(docId, patch) {
    if (!docId) {
      return Promise.resolve();
    }
    const db = wx.cloud.database();
    return db.collection(USER_COLLECTION).doc(docId).update({
      data: {
        ...patch,
        updatedAt: new Date(),
      },
    });
  },

  bindOpenIdToUserRecord(user, openid) {
    const safeUser = user && typeof user === 'object' ? user : {};
    const userId = String(safeUser._id || safeUser.id || '').trim();
    const targetOpenId = String(openid || '').trim();
    if (!userId || !targetOpenId) {
      return Promise.resolve(safeUser);
    }
    const currentOpenId = String(safeUser.openid || safeUser._openid || '').trim();
    if (currentOpenId === targetOpenId) {
      return Promise.resolve(safeUser);
    }
    return this.fetchUserByOpenId(targetOpenId)
      .then((boundUser) => {
        if (boundUser && boundUser._id && String(boundUser._id).trim() !== userId) {
          // 覆盖绑定：清除旧记录上的 openid，设置到当前用户
          return this.updateUserDoc(boundUser._id, { openid: '' })
            .then(() => this.updateUserDoc(userId, { openid: targetOpenId }))
            .then(() => ({
              ...safeUser,
              openid: targetOpenId,
            }));
        }
        return this.updateUserDoc(userId, { openid: targetOpenId })
          .then(() => ({
            ...safeUser,
            openid: targetOpenId,
          }));
      });
  },

  tryBindCurrentOpenIdToUser(user) {
    return this.getOpenIdFromCloud()
      .then((openid) => this.bindOpenIdToUserRecord(user, openid))
      .catch((error) => {
        console.warn('bind current openid to phone user skipped:', error);
        return user;
      });
  },

  fetchOrCreateUserByOpenId(openid, phone) {
    const db = wx.cloud.database();
    const safePhone = this.normalizePhone(phone);
    const resolveByPhone = safePhone
      ? this.fetchUserByPhone(safePhone)
        .then((phoneUser) => {
          if (!phoneUser) {
            return null;
          }
          // 不强制绑定检查：如果手机号已存在，直接覆盖 openid
          return this.bindOpenIdToUserRecord(phoneUser, openid)
            .then((nextUser) => this.ensureUserFields(nextUser, { phone: safePhone, openid }));
        })
      : Promise.resolve(null);

    return resolveByPhone
      .then((phoneResolvedUser) => {
        if (phoneResolvedUser) {
          return phoneResolvedUser;
        }
        return this.fetchUserByOpenId(openid)
          .then((openIdUser) => {
            if (!openIdUser) {
              return null;
            }
            if (safePhone && !openIdUser.phone) {
              return this.updateUserDoc(openIdUser._id, { phone: safePhone })
                .then(() => ({
                  ...openIdUser,
                  phone: safePhone,
                }))
                .then((nextUser) => this.ensureUserFields(nextUser, { phone: safePhone, openid }));
            }
            return this.ensureUserFields(openIdUser, { phone: safePhone, openid });
          });
      })
      .then((resolvedUser) => {
        if (resolvedUser) {
          return resolvedUser;
        }
        const data = this.buildDefaultWechatUser(openid, phone);
        return db.collection(USER_COLLECTION)
          .add({ data })
          .then((addRes) => ({
            _id: addRes && addRes._id ? addRes._id : '',
            ...data,
          }));
      });
  },

  loginByPhone(requirePassword) {
    if (this.data.submitting) {
      return;
    }

    const phone = this.normalizePhone(this.data.phone);
    const password = this.data.password || '';

    if (!this.isValidPhone(phone)) {
      wx.showToast({ title: TOAST_TEXT.invalidPhone, icon: 'none' });
      return;
    }
    if (requirePassword && !password) {
      wx.showToast({ title: TOAST_TEXT.missingPassword, icon: 'none' });
      return;
    }
    if (requirePassword && password.length < 6) {
      wx.showToast({ title: TOAST_TEXT.passwordTooShort, icon: 'none' });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TOAST_TEXT.cloudUnavailable, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: TOAST_TEXT.loggingIn, mask: true });
    let loadingVisible = true;
    const safeHideLoading = () => {
      if (!loadingVisible) {
        return;
      }
      loadingVisible = false;
      wx.hideLoading();
    };

    const loginPromise = requirePassword
      ? this.loginByPhoneWithPassword(phone, password).then((user) => this.ensureUserFields(user, { phone }))
      : this.resolvePhoneLoginUser(phone);

    loginPromise
      .then((user) => {
        if (!user) {
          throw new Error('user_not_found');
        }
        return user;
      })
      .then((user) => this.tryBindCurrentOpenIdToUser(user))
      .then((user) => {
        safeHideLoading();
        const runtimeRole = this.saveSession(user);
        wx.showToast({ title: TOAST_TEXT.loginSuccess, icon: 'success' });
        setTimeout(() => {
          this.redirectByRole(runtimeRole);
        }, 300);
      })
      .catch((error) => {
        safeHideLoading();
        console.error('login by phone failed:', error);
        wx.showToast({
          title: this.resolveLoginErrorMessage(error, 'phone'),
          icon: 'none',
        });
      })
      .finally(() => {
        safeHideLoading();
        this.setData({ submitting: false });
      });
  },

  loginWithPassword() {
    if (!this.data.agreed) {
      wx.showToast({ title: TOAST_TEXT.agreementRequired, icon: 'none' });
      return;
    }
    this.loginByPhone(true);
  },

  registerWithPassword() {
    if (!this.data.agreed) {
      wx.showToast({ title: TOAST_TEXT.agreementRequired, icon: 'none' });
      return;
    }

    const phone = this.normalizePhone(this.data.phone);
    const password = this.data.password || '';
    const confirmPassword = this.data.confirmPassword || '';

    if (!this.isValidPhone(phone)) {
      wx.showToast({ title: TOAST_TEXT.invalidPhone, icon: 'none' });
      return;
    }
    if (!password) {
      wx.showToast({ title: TOAST_TEXT.missingPassword, icon: 'none' });
      return;
    }
    if (password.length < 6) {
      wx.showToast({ title: TOAST_TEXT.passwordTooShort, icon: 'none' });
      return;
    }
    if (password !== confirmPassword) {
      wx.showToast({ title: TOAST_TEXT.passwordNotMatch, icon: 'none' });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TOAST_TEXT.cloudUnavailable, icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: TOAST_TEXT.registering, mask: true });
    let loadingVisible = true;
    const safeHideLoading = () => {
      if (!loadingVisible) {
        return;
      }
      loadingVisible = false;
      wx.hideLoading();
    };

    wx.cloud.callFunction({
      name: 'registerUser',
      data: {
        phone,
        password,
        role: 'student',
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (result.code === 200) {
          return result.data;
        }
        throw new Error(String(result.msg || 'register_failed'));
      })
      .then(() => {
        safeHideLoading();
        wx.showToast({ title: TOAST_TEXT.registerSuccess, icon: 'success' });
        setTimeout(() => {
          this.setData({
            isRegisterMode: false,
            phone: '',
            password: '',
            confirmPassword: '',
          });
        }, 1500);
      })
      .catch((error) => {
        safeHideLoading();
        console.error('register failed:', error);
        const raw = String((error && (error.message || error.errMsg)) || '').toLowerCase();
        let message = TOAST_TEXT.registerFailed;
        if (raw.includes('已注册')) {
          message = TOAST_TEXT.phoneAlreadyRegistered;
        }
        wx.showToast({ title: message, icon: 'none' });
      })
      .finally(() => {
        safeHideLoading();
        this.setData({ submitting: false });
      });
  },


  loginWithCode() {
    if (this.data.submitting) {
      return;
    }
    const phone = this.normalizePhone(this.data.phone);
    const code = String(this.data.code || '').trim();
    if (!this.isValidPhone(phone)) {
      wx.showToast({ title: TOAST_TEXT.invalidPhone, icon: 'none' });
      return;
    }
    if (!code) {
      wx.showToast({ title: TOAST_TEXT.missingCode, icon: 'none' });
      return;
    }
    if (!this.data.agreed) {
      wx.showToast({ title: TOAST_TEXT.agreementRequired, icon: 'none' });
      return;
    }
    this.loginByPhone(false);
  },

  onForgotPasswordTap() {
    if (this.data.submitting) {
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TOAST_TEXT.cloudUnavailable, icon: 'none' });
      return;
    }

    wx.showModal({
      title: '重置密码',
      editable: true,
      placeholderText: '请输入手机号',
      content: '',
      confirmText: '下一步',
      success: (phoneRes) => {
        if (!phoneRes.confirm) {
          return;
        }
        const phone = this.normalizePhone(phoneRes.content);
        if (!this.isValidPhone(phone)) {
          wx.showToast({ title: TOAST_TEXT.invalidPhone, icon: 'none' });
          return;
        }

        this.sendSmsCode(phone)
          .then((result) => {
            const code = result && result.code;
            if (code) {
              wx.showModal({
                title: '验证码已发送',
                content: `验证码：${code}（有效期5分钟）`,
                showCancel: false,
                confirmText: '知道了',
                success: () => {
                  this.inputCodeAndPassword(phone);
                },
              });
            } else {
              wx.showToast({ title: '验证码已发送', icon: 'success' });
              this.inputCodeAndPassword(phone);
            }
          })
          .catch((error) => {
            wx.showToast({
              title: this.resolveLoginErrorMessage(error, 'phone'),
              icon: 'none',
            });
          });
      }
    });
  },

  inputCodeAndPassword(phone) {
    wx.showModal({
      title: '输入验证码',
      editable: true,
      placeholderText: '请输入6位验证码',
      content: '',
      confirmText: '下一步',
      success: (codeRes) => {
        if (!codeRes.confirm) {
          return;
        }
        const code = String(codeRes.content || '').trim();
        if (!/^\d{6}$/.test(code)) {
          wx.showToast({ title: '请输入6位验证码', icon: 'none' });
          return;
        }

        wx.showModal({
          title: '设置新密码',
          editable: true,
          placeholderText: '请输入新密码（至少6位）',
          content: '',
          confirmText: '确认重置',
          success: (pwdRes) => {
            if (!pwdRes.confirm) {
              return;
            }
            const newPassword = String(pwdRes.content || '').trim();
            if (newPassword.length < 6) {
              wx.showToast({ title: '密码至少6位', icon: 'none' });
              return;
            }

            this.setData({ submitting: true });
            wx.showLoading({ title: TOAST_TEXT.resettingPassword, mask: true });
            this.resetPasswordWithCode(phone, code, newPassword)
              .then(() => {
                this.setData({ password: newPassword });
                wx.showToast({ title: '密码重置成功', icon: 'success' });
              })
              .catch((error) => {
                wx.showToast({
                  title: this.resolveLoginErrorMessage(error, 'phone'),
                  icon: 'none',
                });
              })
              .finally(() => {
                wx.hideLoading();
                this.setData({ submitting: false });
              });
          }
        });
      }
    });
  },

  sendSmsCode(phone) {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'sendSmsCode',
        phone,
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'send_sms_code_failed'));
      }
      return result;
    });
  },

  resetPasswordWithCode(phone, code, newPassword) {
    return wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'resetPasswordWithCode',
        phone,
        code,
        newPassword,
      },
    }).then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(String(result.message || 'reset_password_with_code_failed'));
      }
      return result;
    });
  },

  loginWithWechat() {
    if (this.data.submitting) {
      return;
    }
    if (!this.data.agreed) {
      wx.showToast({ title: TOAST_TEXT.agreementRequired, icon: 'none' });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: TOAST_TEXT.cloudUnavailable, icon: 'none' });
      return;
    }

    const rawPhone = this.normalizePhone(this.data.phone);
    const phone = this.isValidPhone(rawPhone) ? rawPhone : '';

    this.setData({ submitting: true });
    wx.showLoading({ title: TOAST_TEXT.wechatLoggingIn, mask: true });
    let loadingVisible = true;
    const safeHideLoading = () => {
      if (!loadingVisible) {
        return;
      }
      loadingVisible = false;
      wx.hideLoading();
    };

    this.getOpenIdFromCloud()
      .then((openid) => this.fetchOrCreateUserByOpenId(openid, phone))
      .then((user) => {
        safeHideLoading();
        if (!user) {
          throw new Error('wechat_login_failed');
        }
        const runtimeRole = this.saveSession(user);
        wx.showToast({ title: TOAST_TEXT.loginSuccess, icon: 'success' });
        setTimeout(() => {
          this.redirectByRole(runtimeRole);
        }, 300);
      })
      .catch((error) => {
        safeHideLoading();
        console.error('login with wechat failed:', error);
        wx.showToast({
          title: this.resolveLoginErrorMessage(error, 'wechat'),
          icon: 'none',
        });
      })
      .finally(() => {
        safeHideLoading();
        this.setData({ submitting: false });
      });
  },

  onUnload() {
    if (this.codeCountdownTimer) {
      clearInterval(this.codeCountdownTimer);
      this.codeCountdownTimer = null;
    }
  },
});
