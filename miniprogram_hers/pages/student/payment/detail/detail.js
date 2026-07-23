const GOODS_PLACEHOLDER = "/images/goods-placeholder.png";
const EVENT_COLLECTION = "activity_events";

const MALL_CATEGORY_MAP = {
  skates: "轮滑鞋",
  protective: "护具",
  helmet: "头盔",
  clothes: "服饰",
  parts: "配件"
};

const MOCK_PRODUCTS = [
  {
    id: 'mock_goods_001',
    title: '专业儿童轮滑鞋 平花休闲两用',
    description: '高品质儿童轮滑鞋，可调节鞋码，舒适内胆，透气网布，安全锁扣。适合4-12岁儿童初学入门及进阶使用。',
    category: 'skates',
    categoryLabel: '轮滑鞋',
    price: 299,
    originalPrice: 399,
    maxParticipants: 100,
    enrollCount: 28,
    stockText: '库存 72 件',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
  {
    id: 'mock_goods_002',
    title: '运动护具套装6件套',
    description: '护手掌、护肘、护膝各一对，高密度EPS缓冲材料，透气面料，魔术贴调节。儿童/成人款可选。',
    category: 'protective',
    categoryLabel: '护具',
    price: 89,
    originalPrice: 129,
    maxParticipants: 500,
    enrollCount: 156,
    stockText: '库存 344 件',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
  {
    id: 'mock_goods_003',
    title: '专业轮滑头盔 多色可选',
    description: '一体成型工艺，EPS发泡内层，PC外壳，12孔通风设计，可调节头围。安全认证，骑行滑板通用。',
    category: 'helmet',
    categoryLabel: '头盔',
    price: 159,
    originalPrice: 199,
    maxParticipants: 200,
    enrollCount: 47,
    stockText: '库存 153 件',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
  {
    id: 'mock_goods_004',
    title: '速滑专用护具',
    description: '专业级速滑护具，碳纤维增强，轻量化设计，人体工学剪裁。适合高阶训练与比赛使用。',
    category: 'protective',
    categoryLabel: '护具',
    price: 269,
    originalPrice: 329,
    maxParticipants: 50,
    enrollCount: 12,
    stockText: '库存 38 件',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
  {
    id: 'mock_goods_005',
    title: '儿童轮滑T恤 速干透气',
    description: '速干功能性面料，排汗透气，不粘身，色彩鲜艳，卡通图案，宽松舒适，上课训练日常都能穿。',
    category: 'clothes',
    categoryLabel: '服饰',
    price: 49,
    originalPrice: 79,
    maxParticipants: 300,
    enrollCount: 88,
    stockText: '库存 212 件',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
  {
    id: 'mock_goods_006',
    title: '轮子替换装4个装',
    description: 'PU高弹轮，耐磨配方，抓地力强，静音轴承。80mm/76mm可选，平花休闲刷街全能。',
    category: 'parts',
    categoryLabel: '配件',
    price: 79,
    originalPrice: 99,
    maxParticipants: 0,
    enrollCount: 0,
    stockText: '库存充足',
    startTime: "2026-05-24",
    endTime: "2026-12-31",
    status: 'published',
    imageUrl: '',
  },
];

Page({
  data: {
    course: null,
  },

  onLoad(options) {
    const courseId = String((options && options.id) || "mock_goods_001").trim();
    this.loadCourseDetail(courseId);
  },

  normalizeActivity(doc) {
    const safeDoc = (typeof doc === "object" && doc !== null) ? doc : {};
    const _id = String(safeDoc._id || safeDoc.id || "").trim();
    const title = String(safeDoc.title || "").trim();
    const description = String(safeDoc.description || "").trim();
    const category = String(safeDoc.category || "other").trim();
    const categoryLabel = String(safeDoc.categoryLabel || MALL_CATEGORY_MAP[category] || "").trim();
    const priceRaw = safeDoc.price;
    const price = Number.isFinite(priceRaw) ? Math.max(0, priceRaw) : 0;
    const originalPriceRaw = safeDoc.originalPrice;
    const originalPrice = Number.isFinite(originalPriceRaw) ? Math.max(0, originalPriceRaw) : 0;
    const maxParticipants = Number(safeDoc.maxParticipants || 0);
    const enrollCount = Number(safeDoc.enrollCount || 0);
    const stockText = maxParticipants > 0 ? `库存 ${Math.max(0, maxParticipants - enrollCount)} 件` : '库存充足';
    const startAt = String(safeDoc.startAt || safeDoc.startTime || "2026-05-24").trim();
    const endAt = String(safeDoc.endAt || safeDoc.endTime || "2026-12-31").trim();
    const status = String(safeDoc.status || "published").trim();
    let imageUrl = String(safeDoc.imageUrl || safeDoc.bannerImage || "").trim();
    if (imageUrl.toLowerCase().includes("tmp")) {
      imageUrl = "";
    }
    return {
      id: _id,
      title,
      description,
      category,
      categoryLabel,
      price,
      originalPrice,
      stockText,
      maxParticipants,
      enrollCount,
      startTime: startAt.split("T")[0],
      endTime: endAt.split("T")[0],
      status,
      imageUrl,
    };
  },

  normalizeImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    const lower = raw.toLowerCase();
    if (
      lower.includes("__tmp__")
      || lower.includes("127.0.0.1")
      || lower.includes("localhost")
      || lower.startsWith("http://tmp/")
      || lower.startsWith("http://usr/")
      || lower.startsWith("wxfile://")
      || lower.startsWith("file://")
      || lower.startsWith("blob:")
    ) {
      return "";
    }
    return raw;
  },

  loadCourseDetail(courseId) {
    const db = wx.cloud.database();
    db.collection(EVENT_COLLECTION)
      .doc(courseId)
      .get()
      .then((res) => {
        if (!res || !res.data) {
          throw new Error("EMPTY_DATA");
        }
        const course = this.normalizeActivity(res.data);
        const imageUrl = this.normalizeImageUrl(course.imageUrl);
        const displayImageUrl = imageUrl || GOODS_PLACEHOLDER;
        this.setData({ course: { ...course, imageUrl, displayImageUrl } });
        wx.setNavigationBarTitle({ title: course.title || "商品详情" });
      })
      .catch(() => {
        const course = MOCK_PRODUCTS.find((item) => item.id === courseId) || MOCK_PRODUCTS[0];
        const imageUrl = this.normalizeImageUrl(course.imageUrl);
        const displayImageUrl = imageUrl || GOODS_PLACEHOLDER;
        this.setData({ course: { ...course, imageUrl, displayImageUrl } });
        wx.setNavigationBarTitle({ title: course.title || "商品详情" });
      });
  },

  handleCourseImageError() {
    const current = this.data.course || {};
    this.setData({
      course: {
        ...current,
        imageUrl: "",
        displayImageUrl: GOODS_PLACEHOLDER,
      },
    });
  },

  onContactCoach() {
    wx.showModal({
      title: '联系教练',
      content: '如需购买或咨询此商品，请联系自己的教练',
      showCancel: false,
      confirmText: '我知道了'
    });
  },
});
