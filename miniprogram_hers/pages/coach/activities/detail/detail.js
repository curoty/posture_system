const COLLECTION_NAME = "activity_events";
const GOODS_PLACEHOLDER = "/images/goods-placeholder.png";
const { hasAdminAccessInStorage } = require("../../../../utils/permission");
const MALL_CATEGORIES = [
  { key: "skates", label: "轮滑鞋" },
  { key: "protective", label: "护具" },
  { key: "helmet", label: "头盔" },
  { key: "clothes", label: "服饰" },
  { key: "parts", label: "配件" }
];

Page({
  data: {
    i18n: {
      deleteConfirmTitle: "删除商品",
      deleteConfirmContent: "删除后无法恢复，确定删除？",
      toastDeleteSuccess: "删除成功",
      toastDeleteFail: "删除失败",
      toastNoPermission: "仅管理员有权限操作"
    },
    activity: null,
    imageUrls: [],
    isAdmin: false,
    isSeller: false,
    loading: false,
    loadError: ""
  },

  onLoad(options) {
    this.setData({
      isAdmin: hasAdminAccessInStorage(),
      isSeller: this.isSellerAccount(),
      activityId: String(options.id || "").trim()
    });
    if (!this.data.activityId) {
      this.setData({ loadError: "商品ID无效" });
      return;
    }
    this.loadDetail();
  },

  onShow() {
    this.setData({ isAdmin: hasAdminAccessInStorage() });
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

  toTimestamp(value) {
    if (!value) return Number.NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") return new Date(value.replace(/-/g, "/")).getTime();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    if (value && typeof value._seconds === "number") return value._seconds * 1000;
    return new Date(value).getTime();
  },

  normalizeImageUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (lower.includes("__tmp__") || lower.includes("127.0.0.1") || lower.includes("localhost") ||
        lower.startsWith("http://tmp/") || lower.startsWith("http://usr/") ||
        lower.startsWith("wxfile://") || lower.startsWith("file://") || lower.startsWith("blob:")) {
      return "";
    }
    return raw;
  },

  resolveStatus(item) {
    const now = Date.now();
    const raw = String(item.status || "active").toLowerCase();
    if (raw === "cancelled") return { key: "ended", text: "已下架" };
    const endTs = this.toTimestamp(item.endAt);
    if (!Number.isNaN(endTs) && endTs < now) return { key: "ended", text: "已下架" };
    return { key: "active", text: "在售" };
  },

  normalizeActivity(item) {
    const safe = item || {};
    const maxParticipants = Number(safe.maxParticipants || 0);
    const enrollCount = Number(safe.enrollCount || 0);
    const statusInfo = this.resolveStatus(safe);
    const capacityText = maxParticipants > 0
      ? `${Math.max(0, maxParticipants - enrollCount)}/${maxParticipants}`
      : "库存充足";

    const priceRaw = safe.price != null && safe.price !== ""
      ? safe.price
      : (safe.salePrice != null ? safe.salePrice : safe.amount);
    const priceNum = Number(priceRaw);
    const priceText = Number.isFinite(priceNum) && priceNum > 0
      ? `${priceNum % 1 === 0 ? priceNum : priceNum.toFixed(2)}`
      : "--";

    const categoryKey = String(safe.category || "").trim();
    const categoryOption = MALL_CATEGORIES.find((cat) => cat.key === categoryKey);

    return {
      id: safe._id || safe.id || "",
      rawImageRef: String(safe.imageUrl || "").trim(),
      imageUrl: this.normalizeImageUrl(safe.imageUrl),
      title: safe.title || "未命名商品",
      price: Number.isFinite(priceNum) ? priceNum : 0,
      priceText,
      category: categoryKey,
      categoryLabel: categoryOption ? categoryOption.label : "其他",
      description: safe.description || "",
      location: safe.location || "",
      startAt: safe.startAt || "",
      endAt: safe.endAt || "",
      deadlineAt: safe.deadlineAt || "",
      statusKey: statusInfo.key,
      statusText: statusInfo.text,
      capacityText,
      enrollCount,
      maxParticipants
    };
  },

  resolveCloudImageUrl(value) {
    const normalized = this.normalizeImageUrl(value);
    if (!normalized) return Promise.resolve("");
    if (normalized.startsWith("cloud://") && wx.cloud) {
      return wx.cloud.downloadFile({ fileID: normalized })
        .then((res) => String((res && res.tempFilePath) || "").trim())
        .catch(() => wx.cloud.getTempFileURL({ fileList: [normalized] })
          .then((res) => {
            const fileList = Array.isArray(res && res.fileList) ? res.fileList : [];
            const first = fileList[0] || {};
            return String(first.tempFileURL || "").trim();
          }))
        .catch(() => "");
    }
    return Promise.resolve(normalized);
  },

  async loadDetail() {
    if (!this.initCloud()) {
      this.setData({ loadError: "云环境不可用" });
      return;
    }

    this.setData({ loading: true, loadError: "" });
    const db = wx.cloud.database();

    try {
      const res = await db.collection(COLLECTION_NAME).doc(this.data.activityId).get();
      const activity = this.normalizeActivity(res && res.data || {});
      const imageUrls = activity.imageUrl ? [activity.imageUrl] : [];
      const resolvedUrls = await Promise.all(imageUrls.map((url) => this.resolveCloudImageUrl(url)));
      const finalUrls = resolvedUrls.filter((url) => url).length > 0
        ? resolvedUrls.filter((url) => url)
        : [GOODS_PLACEHOLDER];

      this.setData({
        activity,
        imageUrls: finalUrls,
        loadError: ""
      });
    } catch (e) {
      console.error("load detail failed:", e);
      this.setData({ loadError: "加载失败，请重试" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goEdit() {
    wx.navigateTo({
      url: `/pages/coach/activities/publish/publish?id=${encodeURIComponent(this.data.activityId)}`
    });
  },

  confirmDelete() {
    wx.showModal({
      title: this.data.i18n.deleteConfirmTitle,
      content: this.data.i18n.deleteConfirmContent,
      confirmColor: "#d9534f",
      success: (res) => {
        if (res && res.confirm) {
          this.deleteActivity();
        }
      }
    });
  },

  async deleteActivity() {
    if (!this.data.isSeller) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: this.data.i18n.toastDeleteFail, icon: "none" });
      return;
    }

    wx.showLoading({ title: "删除中...", mask: true });
    const db = wx.cloud.database();

    try {
      await db.collection(COLLECTION_NAME).doc(this.data.activityId).remove();
      const imageRef = String(this.data.activity.rawImageRef || "").trim();
      if (imageRef.startsWith("cloud://") && wx.cloud) {
        await wx.cloud.deleteFile({ fileList: [imageRef] }).catch(() => null);
      }
      wx.showToast({ title: this.data.i18n.toastDeleteSuccess, icon: "success" });
      setTimeout(() => {
        wx.navigateBack({ fail: () => {} });
      }, 1500);
    } catch (e) {
      console.error("delete failed:", e);
      wx.showToast({ title: this.data.i18n.toastDeleteFail, icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  isSellerAccount() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const role = String(localUserInfo.role || "").trim().toLowerCase();
    const storedRole = String(wx.getStorageSync("userRole") || "").toLowerCase();
    return role === "admin" || role === "coach" || storedRole === "admin" || storedRole === "coach";
  }
});