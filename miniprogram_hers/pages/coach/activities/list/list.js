const COLLECTION_NAME = "activity_events";
const GOODS_PLACEHOLDER = "/images/goods-placeholder.png";
const { hasAdminAccessInStorage } = require("../../../../utils/permission");
const MALL_CATEGORIES = [
  { key: "skates", label: "轮滑鞋", icon: "../../../../images/icons/mall-cat-skates.svg" },
  { key: "protective", label: "护具", icon: "../../../../images/icons/mall-cat-protective.svg" },
  { key: "helmet", label: "头盔", icon: "../../../../images/icons/mall-cat-helmet.svg" },
  { key: "clothes", label: "服饰", icon: "../../../../images/icons/mall-cat-clothes.svg" },
  { key: "parts", label: "配件", icon: "../../../../images/icons/mall-cat-parts.svg" }
];

Page({
  data: {
    i18n: {
      searchPlaceholder: "\u641c\u7d22\u5546\u54c1",
      addButton: "\u53d1\u5e03\u5546\u54c1",
      coachReadonlyTip: "\u4ec5\u7ba1\u7406\u5458\u53ef\u53d1\u5e03/\u5220\u9664",
      deleteButton: "\u5220\u9664",
      deleting: "\u5220\u9664\u4e2d...",
      deleteConfirmTitle: "\u5220\u9664\u5546\u54c1",
      deleteConfirmContent: "\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\uff0c\u662f\u5426\u7ee7\u7eed\uff1f",
      toastNoPermission: "\u4ec5\u7ba1\u7406\u5458\u6709\u6743\u9650\u64cd\u4f5c",
      toastDeleteSuccess: "\u5220\u9664\u6210\u529f",
      toastDeleteFail: "\u5220\u9664\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5",
      summaryTitle: "\u5168\u90e8\u5546\u54c1",
      summaryUnit: "\u4e2a",
      loadingText: "\u6b63\u5728\u52a0\u8f7d...",
      noMoreText: "\u6ca1\u6709\u66f4\u591a\u4e86",
      emptyText: "\u6682\u65e0\u5546\u54c1",
      emptyTip: "\u53bb\u53d1\u5e03\u7b2c\u4e00\u4e2a\u5546\u54c1\u5427",
      locationPrefix: "\u95e8\u5e97",
      timePrefix: "\u6709\u6548\u671f",
      capacityPrefix: "\u5e93\u5b58",
      capacityUnlimited: "\u5e93\u5b58\u5145\u8db3"
    },
    activities: [],
    filteredActivities: [],
    searchKeyword: "",
    statusOptions: ["\u5168\u90e8", "\u5728\u552e", "\u5df2\u4e0b\u67b6"],
    statusIndex: 0,
    categoryOptions: MALL_CATEGORIES,
    activeCategory: "",
    activeCategoryLabel: "",
    page: 0,
    pageSize: 20,
    total: 0,
    hasMore: true,
    isAdmin: false,
    isSeller: false,
    deletingId: "",
    loading: false,
    loadError: ""
  },

  onLoad() {
    this.setData({
      isAdmin: this.isAdminAccount(),
      isSeller: this.isSellerAccount(),
    });
    this.loadActivities(true);
  },

  onShow() {
    this._imageResolveCache = {};
    this.setData({
      isAdmin: this.isAdminAccount(),
      isSeller: this.isSellerAccount(),
      activities: [],
      filteredActivities: []
    });
    this.loadActivities(true);
  },

  onPullDownRefresh() {
    this.loadActivities(true);
  },

  onReachBottom() {
    this.loadActivities(false);
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

  isAdminAccount() {
    return hasAdminAccessInStorage();
  },

  isSellerAccount() {
    const localUserInfo = wx.getStorageSync("userInfo") || {};
    const role = String(localUserInfo.role || "").trim().toLowerCase();
    const storedRole = String(wx.getStorageSync("userRole") || "").toLowerCase();
    return role === "admin" || role === "coach" || storedRole === "admin" || storedRole === "coach";
  },

  toTimestamp(value) {
    if (!value) {
      return Number.NaN;
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      return new Date(value.replace(/-/g, "/")).getTime();
    }
    if (value && typeof value.toDate === "function") {
      return value.toDate().getTime();
    }
    if (value && typeof value._seconds === "number") {
      return value._seconds * 1000;
    }
    return new Date(value).getTime();
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

  resolveHttpImageToLocal(url) {
    const raw = String(url || "").trim();
    if (!raw) {
      return Promise.resolve("");
    }
    return new Promise((resolve) => {
      wx.getImageInfo({
        src: raw,
        success: (res) => {
          const localPath = String(
            (res && (res.path || res.tempFilePath)) || ""
          ).trim();
          resolve(localPath || "");
        },
        fail: () => resolve("")
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
      const safeResolved = this.normalizeImageUrl(resolved);
      const finalValue = safeResolved || "";
      this._imageResolveCache[normalized] = finalValue;
      return finalValue;
    };

    if (normalized.startsWith("cloud://") && wx.cloud) {
      return wx.cloud.downloadFile({ fileID: normalized })
        .then((res) => String((res && res.tempFilePath) || "").trim())
        .catch(() => wx.cloud.getTempFileURL({ fileList: [normalized] })
          .then((res) => {
            const fileList = Array.isArray(res && res.fileList) ? res.fileList : [];
            const first = fileList[0] || {};
            return String(first.tempFileURL || "").trim();
          }))
        .then((candidate) => {
          if (!candidate) {
            return "";
          }
          if (/^https?:\/\//i.test(candidate)) {
            return this.resolveHttpImageToLocal(candidate);
          }
          return candidate;
        })
        .catch(() => "")
        .then(saveCache);
    }

    if (/^https?:\/\//i.test(normalized)) {
      return this.resolveHttpImageToLocal(normalized)
        .catch(() => "")
        .then(saveCache);
    }

    return Promise.resolve(saveCache(normalized));
  },

  resolveStatus(item) {
    const now = Date.now();
    const raw = String(item.status || "active").toLowerCase();
    if (raw === "cancelled") {
      return { key: "ended", text: "\u5df2\u4e0b\u67b6" };
    }
    const endTs = this.toTimestamp(item.endAt);
    if (!Number.isNaN(endTs) && endTs < now) {
      return { key: "ended", text: "\u5df2\u4e0b\u67b6" };
    }
    return { key: "active", text: "\u5728\u552e" };
  },

  normalizeActivity(item) {
    const safe = item || {};
    const maxParticipants = Number(safe.maxParticipants || 0);
    const enrollCount = Number(safe.enrollCount || 0);
    const statusInfo = this.resolveStatus(safe);
    const capacityText = maxParticipants > 0
      ? `${Math.max(0, maxParticipants - enrollCount)}/${maxParticipants}`
      : this.data.i18n.capacityUnlimited;

    const imageUrl = this.normalizeImageUrl(safe.imageUrl);
    const priceRaw = safe.price != null && safe.price !== ""
      ? safe.price
      : (safe.salePrice != null ? safe.salePrice : safe.amount);
    const priceNum = Number(priceRaw);
    const priceText = Number.isFinite(priceNum) && priceNum > 0
      ? `\u00a5${priceNum % 1 === 0 ? priceNum : priceNum.toFixed(2)}`
      : "\u00a5--";
    return {
      id: safe._id || safe.id || "",
      rawImageRef: String(safe.imageUrl || "").trim(),
      title: safe.title || "\u672a\u547d\u540d\u5546\u54c1",
      price: Number.isFinite(priceNum) ? priceNum : 0,
      priceText,
      category: String(safe.category || "").trim(),
      description: safe.description || "",
      imageUrl,
      displayImageUrl: imageUrl || GOODS_PLACEHOLDER,
      location: safe.location || "\u672a\u586b\u5199",
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

  normalizeActivityAsync(item) {
    const safe = item || {};
    return this.resolveCloudImageUrl(safe.imageUrl).then((resolvedImageUrl) => {
      const normalized = this.normalizeActivity(safe);
      const finalImageUrl = this.normalizeImageUrl(resolvedImageUrl);
      return {
        ...normalized,
        imageUrl: finalImageUrl,
        displayImageUrl: finalImageUrl || GOODS_PLACEHOLDER
      };
    });
  },

  fetchActivities(db, reset, useOrderBy) {
    const pageSize = this.data.pageSize;
    const currentPage = reset ? 0 : this.data.page;
    const skip = currentPage * pageSize;

    let listQuery = db.collection(COLLECTION_NAME);
    if (useOrderBy) {
      listQuery = listQuery.orderBy("createdAt", "desc");
    }
    const listReq = listQuery.skip(skip).limit(pageSize).get();
    const countReq = reset
      ? db.collection(COLLECTION_NAME).count().catch(() => ({ total: 0 }))
      : Promise.resolve({ total: this.data.total });

    return Promise.all([listReq, countReq]).then(([listRes, countRes]) => {
      const list = listRes && listRes.data ? listRes.data : [];
      return Promise.all(list.map((item) => this.normalizeActivityAsync(item))).then((normalized) => {
        const merged = reset ? normalized : this.data.activities.concat(normalized);
        const total = countRes && typeof countRes.total === "number"
          ? countRes.total
          : merged.length;

        this.setData({
          activities: merged,
          total,
          page: currentPage + 1,
          hasMore: merged.length < total
        });
        this.applyFilters();
      });
    });
  },

  loadActivities(reset) {
    if (this.data.loading) {
      return;
    }
    if (!reset && !this.data.hasMore) {
      return;
    }

    if (!this.initCloud()) {
      this.setData({
        loadError: "\u5f53\u524d\u5fae\u4fe1\u57fa\u7840\u5e93\u4e0d\u652f\u6301\u4e91\u5f00\u53d1",
        activities: [],
        filteredActivities: [],
        hasMore: false
      });
      if (reset) {
        wx.stopPullDownRefresh();
      }
      return;
    }

    const db = wx.cloud.database();
    this.setData({ loading: true, loadError: "" });

    this.fetchActivities(db, reset, true)
      .catch(() => this.fetchActivities(db, reset, false))
      .then(() => null)
      .catch((error) => {
        console.error("load products failed:", error);
        this.setData({ loadError: "\u52a0\u8f7d\u5546\u54c1\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" });
      })
      .finally(() => {
        this.setData({ loading: false });
        if (reset) {
          wx.stopPullDownRefresh();
        }
      });
  },

  bindSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value || "" });
    this.applyFilters();
  },

  bindSearchConfirm() {
    this.applyFilters();
  },

  doSearch() {
    this.applyFilters();
  },

  bindStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value || 0) });
    this.applyFilters();
  },

  bindCategoryTap(e) {
    const nextCategory = String(e.currentTarget.dataset.category || "").trim();
    const current = String(this.data.activeCategory || "").trim();
    const isSame = nextCategory === current;
    const option = MALL_CATEGORIES.find((item) => item.key === nextCategory);
    this.setData({
      activeCategory: isSame ? "" : nextCategory,
      activeCategoryLabel: isSame || !option ? "" : option.label
    });
    this.applyFilters();
  },

  clearCategoryFilter() {
    this.setData({ activeCategory: "", activeCategoryLabel: "" });
    this.applyFilters();
  },

  applyFilters() {
    const keyword = String(this.data.searchKeyword || "").trim().toLowerCase();
    const statusIndex = Number(this.data.statusIndex || 0);
    const source = Array.isArray(this.data.activities) ? this.data.activities : [];

    const activeCategory = String(this.data.activeCategory || "").trim();

    const filtered = source.filter((item) => {
      if (statusIndex === 1 && item.statusKey !== "active") {
        return false;
      }
      if (statusIndex === 2 && item.statusKey !== "ended") {
        return false;
      }
      if (activeCategory && item.category !== activeCategory) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return [item.title, item.description, item.location]
        .some((field) => String(field || "").toLowerCase().includes(keyword));
    });

    this.setData({ filteredActivities: filtered });
  },

  handleActivityImageError(e) {
    const activityId = String(
      e && e.currentTarget && e.currentTarget.dataset
        ? e.currentTarget.dataset.id
        : ""
    ).trim();
    if (!activityId) {
      return;
    }

    const updateList = (list) => (Array.isArray(list) ? list.map((item) => {
      if (!item || item.id !== activityId) {
        return item;
      }
      return {
        ...item,
        imageUrl: "",
        displayImageUrl: GOODS_PLACEHOLDER
      };
    }) : []);

    this.setData({
      activities: updateList(this.data.activities),
      filteredActivities: updateList(this.data.filteredActivities)
    });
  },

  goPublish() {
    if (!this.data.isSeller) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      return;
    }
    wx.navigateTo({
      url: "/pages/coach/activities/publish/publish"
    });
  },

  goDetail(e) {
    const id = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!id) return;
    wx.navigateTo({
      url: `/pages/coach/activities/detail/detail?id=${encodeURIComponent(id)}`
    });
  },

  goEdit(e) {
    if (!this.data.isSeller) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      return;
    }
    const id = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    if (!id) return;
    wx.navigateTo({
      url: `/pages/coach/activities/publish/publish?id=${encodeURIComponent(id)}`
    });
  },

  removeActivityLocal(activityId) {
    const safeId = String(activityId || "").trim();
    if (!safeId) {
      return;
    }
    const nextActivities = (this.data.activities || []).filter((item) => item && item.id !== safeId);
    const nextFiltered = (this.data.filteredActivities || []).filter((item) => item && item.id !== safeId);
    this.setData({
      activities: nextActivities,
      filteredActivities: nextFiltered,
      total: Math.max(0, Number(this.data.total || 0) - 1),
    });
  },

  removeCloudImageIfNeeded(rawImageRef) {
    const safeRef = String(rawImageRef || "").trim();
    if (!safeRef || !safeRef.startsWith("cloud://") || !wx.cloud) {
      return Promise.resolve();
    }
    return wx.cloud.deleteFile({
      fileList: [safeRef],
    }).catch(() => null);
  },

  confirmDeleteActivity(e) {
    if (!this.data.isSeller || this.data.deletingId) {
      return;
    }
    const id = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.id : "").trim();
    const imageRef = String(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.imageRef : "").trim();
    if (!id) {
      return;
    }

    wx.showModal({
      title: this.data.i18n.deleteConfirmTitle,
      content: this.data.i18n.deleteConfirmContent,
      confirmColor: "#d9534f",
      success: (res) => {
        if (!res || !res.confirm) {
          return;
        }
        this.deleteActivity(id, imageRef);
      }
    });
  },

  deleteActivity(activityId, imageRef) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: this.data.i18n.toastDeleteFail, icon: "none" });
      return;
    }

    const safeId = String(activityId || "").trim();
    if (!safeId) {
      return;
    }

    this.setData({ deletingId: safeId });
    wx.showLoading({ title: this.data.i18n.deleting, mask: true });

    const userInfo = wx.getStorageSync("userInfo") || {};
    const localUserId = String(userInfo.id || userInfo._id || "").trim();

    wx.cloud.callFunction({
      name: "quickstartFunctions",
      data: {
        type: "deleteGoods",
        userId: localUserId,
        preferUserId: true,
        expectedRole: "admin",
        activityId: safeId,
        imageRef: imageRef || "",
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const err = new Error(result.message || "delete_goods_failed");
          err.detail = result;
          throw err;
        }
        this.removeActivityLocal(safeId);
        wx.showToast({ title: this.data.i18n.toastDeleteSuccess, icon: "success" });
      })
      .catch((error) => {
        console.error("delete product failed:", error);
        const msg = String((error && error.message) || "");
        if (msg.includes("permission_denied")) {
          wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
          return;
        }
        wx.showToast({ title: this.data.i18n.toastDeleteFail, icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ deletingId: "" });
      });
  }
});
