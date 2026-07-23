Component({
  properties: {
    selected: {
      type: String,
      value: "home",
    },
  },

  data: {
    items: [
      {
        key: "home",
        text: "首页",
        pagePath: "/pages/coach/index/index",
        iconPath: "/images/icons/home.png",
        selectedIconPath: "/images/icons/home-active.png",
      },
      {
        key: "community",
        text: "社区",
        pagePath: "/pages/coach/community/manage/manage",
        iconPath: "/images/icons/examples.png",
        selectedIconPath: "/images/icons/examples-active.png",
      },
      {
        key: "mall",
        text: "商城",
        pagePath: "/pages/coach/activities/list/list",
        iconPath: "/images/icons/goods.png",
        selectedIconPath: "/images/icons/goods-active.png",
      },
      {
        key: "profile",
        text: "我的",
        pagePath: "/pages/coach/profile/profile",
        iconPath: "/images/icons/usercenter.png",
        selectedIconPath: "/images/icons/usercenter-active.png",
      },
    ],
  },

  methods: {
    onTapItem(event) {
      const { path, key } = event.currentTarget.dataset || {};
      const targetPath = String(path || "").trim();
      const targetKey = String(key || "").trim();
      if (!targetPath || !targetKey || targetKey === this.properties.selected) {
        return;
      }
      wx.reLaunch({
        url: targetPath,
      });
    },
  },
});
