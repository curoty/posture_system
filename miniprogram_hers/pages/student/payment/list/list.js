const EVENT_COLLECTION = 'activity_events';
const ENROLL_COLLECTION = 'activity_enrollments';
const ASSISTANT_WECHAT_ID = 'wxid_2c2q2dj6s4zu22';
const ASSISTANT_QR_LOCAL_URL = 'cloud://cloud1-1g0419td698cd252.636c-cloud1-1g0419td698cd252-1410931851/images/assistant-wechat-qr.png';
const ASSISTANT_QR_FALLBACK_URL = `https://api.qrserver.com/v1/create-qr-code/?size=800x800&data=${encodeURIComponent(ASSISTANT_WECHAT_ID)}`;
const GOODS_PLACEHOLDER = '/images/goods-placeholder.png';
const MALL_CATEGORIES = [
  { key: 'skates', label: '轮滑鞋', icon: '../../../../images/icons/mall-cat-skates.svg' },
  { key: 'protective', label: '护具', icon: '../../../../images/icons/mall-cat-protective.svg' },
  { key: 'helmet', label: '头盔', icon: '../../../../images/icons/mall-cat-helmet.svg' },
  { key: 'clothes', label: '服饰', icon: '../../../../images/icons/mall-cat-clothes.svg' },
  { key: 'parts', label: '配件', icon: '../../../../images/icons/mall-cat-parts.svg' }
];

const MOCK_PRODUCTS = [
  {
    _id: 'mock_goods_001',
    title: '专业儿童轮滑鞋 平花休闲两用',
    description: '高品质儿童轮滑鞋，可调节鞋码，舒适内胆，透气网布，安全锁扣。适合4-12岁儿童初学入门及进阶使用。',
    category: 'skates',
    price: 299,
    originalPrice: 399,
    location: '线上发货',
    quota: 100,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 128,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 3)
  },
  {
    _id: 'mock_goods_002',
    title: '运动护具套装6件套',
    description: '护手掌、护肘、护膝各一对，高密度EPS缓冲材料，透气面料，魔术贴调节。儿童/成人款可选。',
    category: 'protective',
    price: 89,
    originalPrice: 129,
    location: '线上发货',
    quota: 500,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 256,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 5)
  },
  {
    _id: 'mock_goods_003',
    title: '专业轮滑头盔 多色可选',
    description: '一体成型工艺，EPS发泡内层，PC外壳，12孔通风设计，可调节头围。安全认证，骑行滑板通用。',
    category: 'helmet',
    price: 159,
    originalPrice: 199,
    location: '线上发货',
    quota: 200,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 87,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 2)
  },
  {
    _id: 'mock_goods_004',
    title: '速滑专用护具',
    description: '专业级速滑护具，碳纤维增强，轻量化设计，人体工学剪裁。适合高阶训练与比赛使用。',
    category: 'protective',
    price: 269,
    originalPrice: 329,
    location: '线上发货',
    quota: 50,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 42,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 7)
  },
  {
    _id: 'mock_goods_005',
    title: '儿童轮滑T恤 速干透气',
    description: '速干功能性面料，排汗透气，不粘身，色彩鲜艳，卡通图案，宽松舒适，上课训练日常都能穿。',
    category: 'clothes',
    price: 49,
    originalPrice: 79,
    location: '线上发货',
    quota: 300,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 176,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 1)
  },
  {
    _id: 'mock_goods_006',
    title: '轮滑轴承保养套装',
    description: '进口轴承润滑油，精密轴承清洁瓶，防锈保养油，拆装扳手小工具一套配齐。延长轮子寿命。',
    category: 'parts',
    price: 39,
    originalPrice: 59,
    location: '线上发货',
    quota: 400,
    bannerImage: '',
    extraImages: [],
    enrolledCount: 93,
    showEnrollCount: true,
    status: 'published',
    createdAt: new Date(Date.now() - 86400000 * 4)
  }
];

Page({
  data: {
    activities: [],
    originalActivities: [],
    categoryOptions: MALL_CATEGORIES,
    activeCategory: '',
    activeCategoryLabel: '',
    searchKeyword: '',
    currentUser: {
      id: '',
      name: '',
      phone: ''
    },
    loading: false,
    loadError: '',
    emptyTip: '上架后会在这里显示'
  },

  onShow() {
    this._imageResolveCache = {};
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.setData({
      activities: [],
      originalActivities: []
    });
    this.loadActivities();
  },

  onPullDownRefresh() {
    this.loadActivities(true);
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

  getCurrentUser() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    return {
      id: String(userInfo.id || userInfo._id || '').trim(),
      name: String(userInfo.name || '').trim() || '学员',
      phone: String(userInfo.phone || '').replace(/\s+/g, '')
    };
  },

  getUserFilter(user) {
    const safe = user || {};
    return {
      studentId: String(safe.id || '').trim(),
      studentPhone: String(safe.phone || '').replace(/\s+/g, '')
    };
  },

  toTimestamp(value) {
    if (!value) {
      return NaN;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      return new Date(value.replace(/-/g, '/')).getTime();
    }
    if (value && typeof value.toDate === 'function') {
      return value.toDate().getTime();
    }
    if (value && typeof value._seconds === 'number') {
      return value._seconds * 1000;
    }
    return new Date(value).getTime();
  },

  normalizeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const lower = raw.toLowerCase();
    if (
      lower.includes('__tmp__')
      || lower.includes('127.0.0.1')
      || lower.includes('localhost')
      || lower.startsWith('http://tmp/')
      || lower.startsWith('http://usr/')
      || lower.startsWith('wxfile://')
      || lower.startsWith('file://')
      || lower.startsWith('blob:')
    ) {
      return '';
    }
    return raw;
  },

  resolveHttpImageToLocal(url) {
    const raw = String(url || '').trim();
    if (!raw) {
      return Promise.resolve('');
    }
    return new Promise((resolve) => {
      wx.getImageInfo({
        src: raw,
        success: (res) => {
          const localPath = String((res && (res.path || res.tempFilePath)) || '').trim();
          resolve(localPath || '');
        },
        fail: () => resolve('')
      });
    });
  },

  resolveCloudImageUrl(value) {
    const normalized = this.normalizeImageUrl(value);
    if (!normalized) {
      return Promise.resolve("");
    }
    this._imageResolveCache = this._imageResolveCache || {};
    if (Object.prototype.hasOwnProperty.call(this._imageResolveCache, normalized)) {
      return Promise.resolve(this._imageResolveCache[normalized]);
    }

    const saveCache = (resolved) => {
      const finalValue = this.normalizeImageUrl(resolved) || "";
      this._imageResolveCache[normalized] = finalValue;
      return finalValue;
    };

    // 直接用云文件ID即可，小程序image组件支持cloud://格式
    if (normalized.startsWith("cloud://")) {
      return Promise.resolve(saveCache(normalized));
    }

    if (/^https?:\/\//i.test(normalized)) {
      return Promise.resolve(saveCache(normalized));
    }

    return Promise.resolve(saveCache(normalized));
  },

  resolveStatus(item, enrolled) {
    const raw = String(item.status || 'active').toLowerCase();
    if (enrolled) {
      return { key: 'enrolled', text: '已购买' };
    }
    if (raw === 'cancelled') {
      return { key: 'cancelled', text: '已下架' };
    }

    const now = Date.now();
    const endTs = this.toTimestamp(item.endAt);
    if (!Number.isNaN(endTs) && endTs < now) {
      return { key: 'ended', text: '已下架' };
    }

    const deadlineTs = this.toTimestamp(item.deadlineAt);
    if (!Number.isNaN(deadlineTs) && deadlineTs < now) {
      return { key: 'ended', text: '已下架' };
    }

    const maxParticipants = Number(item.maxParticipants || 0);
    const enrollCount = Number(item.enrollCount || 0);
    if (maxParticipants > 0 && enrollCount >= maxParticipants) {
      return { key: 'full', text: '已售罄' };
    }

    return { key: 'active', text: '在售' };
  },

  normalizeActivity(item, enrolledSet) {
    const safe = item || {};
    const id = safe._id || safe.id || '';
    const enrolled = !!(id && enrolledSet && enrolledSet[id]);
    const statusInfo = this.resolveStatus(safe, enrolled);
    const maxParticipants = Number(safe.maxParticipants || 0);
    const enrollCount = Number(safe.enrollCount || 0);
    const imageUrl = this.normalizeImageUrl(safe.imageUrl);
    const priceValue = safe.price || safe.salePrice || safe.amount || safe.fee || '';
    const priceText = priceValue === ''
      ? '到店咨询'
      : `¥${Number(priceValue) > 0 ? Number(priceValue).toFixed(0) : String(priceValue)}`;

    return {
      id,
      title: safe.title || '未命名商品',
      description: safe.description || '',
      category: String(safe.category || '').trim(),
      categoryLabel: String(safe.categoryLabel || '').trim(),
      priceText,
      imageUrl,
      displayImageUrl: imageUrl || GOODS_PLACEHOLDER,
      location: safe.location || '未填写',
      startAt: safe.startAt || '',
      endAt: safe.endAt || '',
      deadlineAt: safe.deadlineAt || '',
      statusKey: statusInfo.key,
      statusText: statusInfo.text,
      enrolled,
      canEnroll: statusInfo.key === 'active',
      enrollCount,
      maxParticipants,
      capacityText: maxParticipants > 0 ? `${enrollCount}/${maxParticipants}` : '库存充足'
    };
  },

  normalizeActivityAsync(item, enrolledSet) {
    const safe = item || {};
    return this.resolveCloudImageUrl(safe.imageUrl).then((resolvedImageUrl) => {
      const normalized = this.normalizeActivity(safe, enrolledSet);
      const finalImageUrl = this.normalizeImageUrl(resolvedImageUrl);
      return {
        ...normalized,
        imageUrl: finalImageUrl,
        displayImageUrl: finalImageUrl || GOODS_PLACEHOLDER
      };
    });
  },

  handleActivityImageError(e) {
    const activityId = String(
      e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : ''
    ).trim();
    if (!activityId) {
      return;
    }

    const fixList = (list) => (Array.isArray(list) ? list.map((item) => {
      if (!item || item.id !== activityId) {
        return item;
      }
      return {
        ...item,
        imageUrl: '',
        displayImageUrl: GOODS_PLACEHOLDER
      };
    }) : []);

    this.setData({
      originalActivities: fixList(this.data.originalActivities),
      activities: fixList(this.data.activities)
    });
  },

  loadMyEnrollments(db, userFilter) {
    const tasks = [];
    if (userFilter.studentId) {
      tasks.push(db.collection(ENROLL_COLLECTION).where({ studentId: userFilter.studentId }).limit(200).get());
    }
    if (userFilter.studentPhone) {
      tasks.push(db.collection(ENROLL_COLLECTION).where({ studentPhone: userFilter.studentPhone }).limit(200).get());
    }
    if (!tasks.length) {
      return Promise.resolve({});
    }

    return Promise.all(tasks)
      .then((resList) => {
        const enrolledMap = {};
        resList.forEach((res) => {
          const data = res && res.data ? res.data : [];
          data.forEach((item) => {
            const activityId = String(item.activityId || '').trim();
            if (activityId) {
              enrolledMap[activityId] = true;
            }
          });
        });
        return enrolledMap;
      })
      .catch(() => ({}));
  },

  getFallbackProducts() {
    return MOCK_PRODUCTS.map((item) => {
      const option = MALL_CATEGORIES.find((cat) => cat.key === item.category);
      return {
        id: item._id,
        title: item.title,
        description: item.description,
        category: item.category,
        categoryLabel: option ? option.label : item.category,
        categoryIcon: option ? option.icon : '',
        price: item.price,
        priceText: `¥${item.price}`,
        originalPrice: item.originalPrice,
        originalPriceText: `¥${item.originalPrice}`,
        location: item.location,
        time: item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '',
        weekdayShort: '',
        imageUrl: '',
        displayImageUrl: GOODS_PLACEHOLDER,
        enrolled: false,
        enrolledCount: item.enrolledCount || 0,
        quota: item.quota,
        enrollButtonText: '咨询购买',
        showEnrollCount: true,
        status: { key: 'active', text: '购买中' },
        soldOut: false,
        joinMode: 'qrcode'
      };
    });
  },

  loadActivities(isPullDown) {
    if (!this.initCloud()) {
      const fallbackProducts = this.getFallbackProducts();
      this.setData({
        loading: false,
        loadError: '',
        originalActivities: fallbackProducts
      });
      this.applyFilters();
      if (isPullDown) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    const currentUser = this.getCurrentUser();
    const userFilter = this.getUserFilter(currentUser);
    const db = wx.cloud.database();
    const fetchEvents = (useOrderBy) => {
      let query = db.collection(EVENT_COLLECTION).where({});
      if (useOrderBy) {
        query = query.orderBy('createdAt', 'desc');
      }
      return query.limit(200).get().then((res) => (res && res.data ? res.data : []));
    };

    this.setData({
      loading: true,
      loadError: '',
      currentUser
    });

    Promise.all([
      fetchEvents(true).catch(() => fetchEvents(false)),
      this.loadMyEnrollments(db, userFilter)
    ])
      .then(([events, enrolledMap]) => {
        const source = Array.isArray(events) ? events : [];
        return Promise.all(source.map((item) => this.normalizeActivityAsync(item, enrolledMap)));
      })
      .then((normalized) => {
        const safeList = Array.isArray(normalized) ? normalized : [];
        if (!safeList.length) {
          const fallbackProducts = this.getFallbackProducts();
          this.setData({ originalActivities: fallbackProducts });
        } else {
          this.setData({ originalActivities: safeList });
        }
        this.applyFilters();
      })
      .catch((error) => {
        console.error('load products failed:', error);
        const fallbackProducts = this.getFallbackProducts();
        this.setData({
          originalActivities: fallbackProducts,
          loadError: ''
        });
        this.applyFilters();
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
    this.applyFilters();
  },

  handleSearchTap() {
    this.applyFilters();
  },

  bindCategoryTap(e) {
    const category = String(e.currentTarget.dataset.category || '').trim();
    const current = String(this.data.activeCategory || '').trim();
    const nextCategory = category === current ? '' : category;
    const option = MALL_CATEGORIES.find((item) => item.key === nextCategory) || null;
    this.setData({
      activeCategory: nextCategory,
      activeCategoryLabel: option ? option.label : ''
    });
    this.applyFilters();
  },

  clearCategoryFilter() {
    this.setData({
      activeCategory: '',
      activeCategoryLabel: ''
    });
    this.applyFilters();
  },

  applyFilters() {
    const keyword = String(this.data.searchKeyword || '').trim().toLowerCase();
    const activeCategory = String(this.data.activeCategory || '').trim();
    const source = Array.isArray(this.data.originalActivities) ? this.data.originalActivities : [];

    const filtered = source.filter((item) => {
      if (activeCategory && item.category !== activeCategory) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return [item.title, item.description, item.location, item.categoryLabel]
        .some((field) => String(field || '').toLowerCase().includes(keyword));
    });

    this.setData({ activities: filtered });
  },

  openDetail(e) {
    const item = e.currentTarget.dataset;
    const activity = this.data.activities.find((x) => String(x.id) === String(item.id));
    if (!activity) {
      return;
    }
    wx.navigateTo({
      url: `/pages/student/payment/detail/detail?id=${activity.id}`
    });
  }
});
