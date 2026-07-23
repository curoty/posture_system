Page({
  onShow() {
    // 更新 tabBar 选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      // 先设置tabBar列表
      this.getTabBar().setTabBarList();
      // 再设置选中状态
      this.getTabBar().setData({
        selected: 3
      });
    }
  },
  data: {
    orders: [],
    searchKeyword: '',
    statusOptions: ['全部', '待支付', '已支付', '已完成', '已取消'],
    selectedStatus: '全部'
  },

  onLoad() {
    this.loadOrders();
  },

  loadOrders() {
    // 模拟从后端获取订单数据
    const orders = [
      {
        id: '1',
        studentName: '张三',
        courseName: '基础轮滑课程',
        amount: 200,
        status: '已支付',
        createTime: '2026-02-20 10:30',
        payTime: '2026-02-20 10:35'
      },
      {
        id: '2',
        studentName: '李四',
        courseName: '进阶轮滑课程',
        amount: 300,
        status: '待支付',
        createTime: '2026-02-21 14:20',
        payTime: ''
      },
      {
        id: '3',
        studentName: '王五',
        courseName: '轮滑表演班',
        amount: 500,
        status: '已完成',
        createTime: '2026-02-19 09:15',
        payTime: '2026-02-19 09:20'
      }
    ];
    this.setData({ orders });
  },

  bindSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value });
  },

  handleStatusChange(e) {
    this.setData({ selectedStatus: e.detail.value });
  },

  handleOrderDetail(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/coach/payment/order-detail/order-detail?id=${orderId}`
    });
  },

  handleRefund(e) {
    const orderId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '退款确认',
      content: '确定要处理此订单的退款吗？',
      success: (res) => {
        if (res.confirm) {
          wx.showToast({ title: '退款处理成功', icon: 'success' });
        }
      }
    });
  }
});