Page({
  data: {
    loading: false,
    message: '',
    progress: []
  },

  onLoad() {
    this.initDatabase();
  },

  initDatabase() {
    this.setData({ 
      loading: true, 
      message: '正在初始化数据库集合...',
      progress: []
    });

    // 初始化云开发环境
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });

    const db = wx.cloud.database();
    const collections = [
      {
        name: 'community_posts',
        data: {
          title: '欢迎来到轮滑社区',
          content: '这是一个测试帖子，欢迎大家在这里交流轮滑技巧和经验。',
          author: {
            name: '系统',
            avatarUrl: ''
          },
          tag: '公告',
          status: 'active',
          likes: 0,
          comments: 0,
          views: 0,
          createdAt: new Date()
        }
      },
      {
        name: 'courses',
        data: {
          title: '轮滑基础入门课程',
          description: '适合零基础学员，学习基础站立、滑行、转弯和刹车等基本技巧。',
          price: 800,
          startTime: new Date('2026-03-01'),
          endTime: new Date('2026-04-12'),
          status: 'active',
          category: '基础课程',
          createdAt: new Date()
        }
      },
      {
        name: 'activities',
        data: {
          icon: '🎉',
          text: '系统初始化完成',
          createdAt: new Date()
        }
      }
    ];

    const promises = collections.map((collection) => {
      if (collection.name === 'community_posts') {
        return db.collection(collection.name)
          .where({
            title: collection.data.title,
            tag: collection.data.tag
          })
          .limit(1)
          .get()
          .then((res) => {
            const data = (res && res.data) || [];
            if (data.length > 0) {
              this.setData({
                progress: [...this.data.progress, `${collection.name} 默认欢迎帖已存在，跳过创建`]
              });
              return;
            }
            return db.collection(collection.name).add({
              data: collection.data
            }).then(() => {
              this.setData({
                progress: [...this.data.progress, `${collection.name} 默认欢迎帖创建成功`]
              });
            });
          })
          .catch((err) => {
            console.error(`创建 ${collection.name} 集合失败:`, err);
            this.setData({
              progress: [...this.data.progress, `${collection.name} 集合创建失败: ${err.message}`]
            });
          });
      }

      return db.collection(collection.name).add({
        data: collection.data
      })
      .then(() => {
        console.log(`${collection.name} 集合创建成功`);
        this.setData({
          progress: [...this.data.progress, `${collection.name} 集合创建成功`]
        });
      })
      .catch((err) => {
        if (err.errCode === -502005) {
          console.log(`${collection.name} 集合已存在`);
          this.setData({
            progress: [...this.data.progress, `${collection.name} 集合已存在`]
          });
        } else {
          console.error(`创建 ${collection.name} 集合失败:`, err);
          this.setData({
            progress: [...this.data.progress, `${collection.name} 集合创建失败: ${err.message}`]
          });
        }
      });
    });

    Promise.all(promises)
    .then(() => {
      this.setData({ message: '数据库集合初始化完成！' });
      console.log('所有集合初始化完成');
    })
    .catch((error) => {
      console.error('初始化数据库集合失败:', error);
      this.setData({ message: '初始化过程中出现错误: ' + error.message });
    })
    .finally(() => {
      this.setData({ loading: false });
    });
  },

  goBack() {
    wx.navigateBack();
  }
});
