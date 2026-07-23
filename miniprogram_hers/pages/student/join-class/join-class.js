Page({
  data: {
    inputCode: '',
    scanCode: '',
    hasResult: false,
    resultType: '', // 'success' | 'error'
    resultTitle: '',
    resultDesc: '',
    resultClassName: '',
    resultCoachName: '',
    loading: false,
  },

  onLoad(options) {
    // 通过扫码或分享链接进入时，预填班级码
    const scene = decodeURIComponent(options.scene || '');
    const code = decodeURIComponent(options.code || '');
    const q = decodeURIComponent(options.q || '');

    // 解析 scene 参数 (小程序码 getUnlimited 的 scene)
    if (scene) {
      const codeMatch = scene.match(/code=(\d{6})/);
      if (codeMatch) {
        this.setData({ inputCode: codeMatch[1] });
        return;
      }
    }

    // 解析普通链接参数 q
    if (q) {
      const parsedScene = this.parseQueryString(q);
      const qCode = parsedScene.code || '';
      if (qCode && /^\d{6}$/.test(qCode)) {
        this.setData({ inputCode: qCode });
        return;
      }
    }

    // 直接传参
    if (code && /^\d{6}$/.test(code)) {
      this.setData({ inputCode: code });
    }
  },

  parseQueryString(str) {
    const result = {};
    const pairs = String(str || '').split('&');
    pairs.forEach((pair) => {
      const [key, val] = pair.split('=');
      if (key) {
        result[decodeURIComponent(key)] = decodeURIComponent(val || '');
      }
    });
    return result;
  },

  onCodeInput(e) {
    const value = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({
      inputCode: value,
      hasResult: false,
    });
  },

  onScanCode() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: (res) => {
        const result = res.result || '';
        // 尝试从小程序码结果中提取班级码
        const codeMatch = result.match(/code=(\d{6})/);
        if (codeMatch) {
          this.setData({ inputCode: codeMatch[1], hasResult: false });
        } else if (/^\d{6}$/.test(result.trim())) {
          this.setData({ inputCode: result.trim(), hasResult: false });
        } else {
          // 可能是小程序路径
          const pathMatch = result.match(/(\d{6})(?:&|$)/);
          if (pathMatch) {
            this.setData({ inputCode: pathMatch[1], hasResult: false });
          } else {
            wx.showToast({ title: '未识别到班级码，请手动输入', icon: 'none' });
          }
        }
      },
      fail: () => {
        // 用户取消扫码，不提示
      },
    });
  },

  onJoinClass() {
    const code = this.data.inputCode.trim();
    if (!code || !/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入6位数字班级码', icon: 'none' });
      return;
    }

    if (!this.initCloud()) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' });
      return;
    }

    this.setData({ loading: true });

    const userInfo = wx.getStorageSync('userInfo') || {};
    const userId = String(userInfo.id || userInfo._id || '').trim();

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'joinClassByCode',
        classCode: code,
        userId,
        preferUserId: !!userId,
        expectedRole: 'student',
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const msg = String(result.message || '');
          if (msg === 'already_in_this_class') {
            this.showResult('info', '已在班级中', '你已经加入过该教练的班级，无需重复加入');
            return;
          }
          if (msg === 'class_code_not_found' || msg === 'invalid_class_code') {
            this.showResult('error', '班级码无效', '未找到该班级码对应的班级，请检查后重试');
            return;
          }
          if (msg === 'student_not_found') {
            this.showResult('error', '用户信息异常', '请重新登录后再试');
            return;
          }
          throw new Error(msg || 'join_failed');
        }
        const data = result.data || {};
        this.showResult(
          'success',
          '加入成功',
          `你已成功加入${data.coachName || '教练'}的${data.className || '班级'}`,
          data.className || '',
          data.coachName || ''
        );
      })
      .catch((err) => {
        console.error('join class failed:', err);
        this.showResult('error', '加入失败', '请检查班级码是否正确，或稍后重试');
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  showResult(type, title, desc, className, coachName) {
    this.setData({
      hasResult: true,
      resultType: type,
      resultTitle: title,
      resultDesc: desc,
      resultClassName: className || '',
      resultCoachName: coachName || '',
    });
  },

  onBackToHome() {
    wx.switchTab({
      url: '/pages/student/index/index',
    });
  },

  onRefreshInput() {
    this.setData({
      inputCode: '',
      hasResult: false,
    });
  },

  initCloud() {
    if (!wx.cloud) return false;
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  },
});
