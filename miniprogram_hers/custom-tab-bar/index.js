Component({
  data: {
    selected: 0,
    color: '#c7ced6',
    selectedColor: '#35c66b',
    list: [],
    showTabBar: true
  },

  attached() {
    this.setTabBarList();
  },

  ready() {
    this.setTabBarList();
  },

  methods: {
    resolveRuntimeRole() {
      const storedRole = String(wx.getStorageSync('userRole') || '').toLowerCase();
      const accountRole = String(wx.getStorageSync('accountRole') || '').toLowerCase();
      const localUserInfo = wx.getStorageSync('userInfo') || {};
      const profileRole = String(localUserInfo.role || '').toLowerCase();

      const sourceRole = accountRole || profileRole || storedRole;
      if (sourceRole === 'admin') {
        if (storedRole !== 'admin') {
          wx.setStorageSync('userRole', 'admin');
        }
        return 'admin';
      }
      if (sourceRole === 'coach') {
        if (storedRole !== 'coach') {
          wx.setStorageSync('userRole', 'coach');
        }
        return 'coach';
      }
      if (sourceRole === 'student' || sourceRole === 'user') {
        if (storedRole !== 'student') {
          wx.setStorageSync('userRole', 'student');
        }
        return 'student';
      }
      return storedRole || 'student';
    },

    setTabBarList() {
      const userRole = this.resolveRuntimeRole();
      let tabBarList = [];

      if (userRole === 'student') {
        tabBarList = [
          {
            pagePath: '/pages/student/index/index',
            text: '首页',
            iconPath: '/images/icons/home.png',
            selectedIconPath: '/images/icons/home-active.png'
          },
          {
            pagePath: '/pages/student/community/list/list',
            text: '社区',
            iconPath: '/images/icons/examples.png',
            selectedIconPath: '/images/icons/examples-active.png'
          },
          {
            pagePath: '/pages/student/payment/list/list',
            text: '商城',
            iconPath: '/images/icons/goods.png',
            selectedIconPath: '/images/icons/goods-active.png'
          },
          {
            pagePath: '/pages/student/profile/profile',
            text: '我的',
            iconPath: '/images/icons/usercenter.png',
            selectedIconPath: '/images/icons/usercenter-active.png'
          }
        ];
      } else if (userRole === 'admin') {
        tabBarList = [
          {
            pagePath: '/pages/coach/index/index',
            text: '首页',
            iconPath: '/images/icons/home.png',
            selectedIconPath: '/images/icons/home-active.png'
          }
        ];
      } else if (userRole === 'coach') {
        tabBarList = [
          {
            pagePath: '/pages/coach/index/index',
            text: '首页',
            iconPath: '/images/icons/home.png',
            selectedIconPath: '/images/icons/home-active.png'
          },
          {
            pagePath: '/pages/student/community/list/list',
            text: '社区',
            iconPath: '/images/icons/examples.png',
            selectedIconPath: '/images/icons/examples-active.png'
          },
          {
            pagePath: '/pages/coach/students/list/list',
            text: '学生',
            iconPath: '/images/icons/examples.png',
            selectedIconPath: '/images/icons/examples-active.png'
          },
          {
            pagePath: '/pages/coach/profile/profile',
            text: '我的',
            iconPath: '/images/icons/usercenter.png',
            selectedIconPath: '/images/icons/usercenter-active.png'
          }
        ];
      } else {
        // 默认显示登录页面
        tabBarList = [
          {
            pagePath: '/pages/login/login',
            text: '登录',
            iconPath: '/images/icons/usercenter.png',
            selectedIconPath: '/images/icons/usercenter-active.png'
          }
        ];
      }

      this.setData({
        list: tabBarList,
        // 学生端保留底部导航；教练/管理员端按当前需求隐藏
        showTabBar: userRole === 'student'
      });
    },

    switchTab(e) {
      const data = e.currentTarget.dataset;
      if (!data || !data.path) {
        console.error('Invalid tab data:', data);
        return;
      }
      
      const url = data.path;
      const index = data.index || 0;
      
      // 检查是否是登录页面
      if (url === '/pages/login/login') {
        wx.reLaunch({ 
          url
        });
      } else {
        wx.switchTab({
          url,
          fail: () => {
            // 当目标不是 tabBar 页面时，回退到重启路由
            wx.reLaunch({ url });
          }
        });
      }
      
      this.setData({
        selected: index
      });
    }
  }
});

