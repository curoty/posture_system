const EVENT_COLLECTION = "activity_events";
const ACTIVITY_LOG_COLLECTION = "activities";
const { hasAdminAccessInStorage } = require("../../../../utils/permission");
const { hasForbiddenWords, getWordList, getForbiddenWords } = require("../../../../utils/forbidden-words");
const PRODUCT_CATEGORIES = [
  { key: "skates", label: "轮滑鞋" },
  { key: "protective", label: "护具" },
  { key: "helmet", label: "头盔" },
  { key: "clothes", label: "服饰" },
  { key: "parts", label: "配件" },
];
const MAX_IMAGE_COUNT = 6;

Page({
  data: {
    i18n: {
      titlePlaceholder: "请输入商品标题",
      descPlaceholder: "请输入商品描述",
      imageLabel: "商品图片",
      addImage: "添加图片",
      submitButton: "发布商品",
      updateButton: "保存修改",
      publishing: "发布中...",
      updating: "保存中...",
      labelTitle: "商品标题",
      labelPrice: "商品价格（元）",
      pricePlaceholder: "0.00",
      labelDesc: "商品描述",
      labelCategory: "商品分类",
      labelStart: "上架时间",
      labelEnd: "下架时间",
      labelStock: "库存（0 表示不限）",
      stockPlaceholder: "例如：10",
      labelTimeSection: "上架时间设置（选填）",
      timeSectionHint: "不设置则默认立即上架、长期有效",
      toastInvalidTemp: "图片临时路径无效",
      toastInvalidPath: "图片路径无效",
      toastCloudUnavailable: "当前环境不支持云开发",
      toastNeedTitle: "请输入商品标题",
      toastNeedPrice: "请输入有效的商品价格",
      toastMaxImages: "最多上传 6 张图片",
      toastNeedTime: "请完整选择时间",
      toastEndAfterStart: "下架时间需晚于上架时间",
      toastPublishSuccess: "发布成功",
      toastUpdateSuccess: "修改成功",
      toastPublishFail: "发布失败，请重试",
      toastNeedRealDevice: "开发者工具图片临时路径无法上传，请真机重试",
      toastNoPermission: "仅管理员可发布商品",
      defaultCoachName: "教练",
      logIcon: "商品",
      logTextPrefix: "发布商品：",
      toastForbiddenWords: "标题或描述包含违禁词，请修改后再提交",
      forbiddenWordsTip: "检测到违禁词："
    },
    title: "",
    price: "",
    description: "",
    titleForbiddenWords: [],
    descForbiddenWords: [],
    categoryOptions: PRODUCT_CATEGORIES,
    categoryIndex: 0,
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    deadlineDate: "",
    deadlineTime: "",
    maxParticipants: "",
    imageTempPaths: [],
    maxImageCount: MAX_IMAGE_COUNT,
    timeSectionOpen: false,
    canSubmit: false,
    isAdmin: false,
    submitting: false
  },

  onLoad(options) {
    const isSeller = this.isSellerAccount();
    this.setData({ isSeller });
    if (!isSeller) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      setTimeout(() => {
        wx.redirectTo({
          url: "/pages/coach/activities/list/list",
          fail: () => wx.navigateBack({ fail: () => {} }),
        });
      }, 300);
      return;
    }
    this.initDefaultDateTime();
    const editId = String(options.id || "").trim();
    if (editId) {
      this.setData({ editId });
      this.loadEditData(editId);
    }
  },

  onShow() {
    const list = (this.data.imageTempPaths || []).filter(
      (p) => p && !this.isInvalidLocalImageUrl(p)
    );
    if (list.length !== (this.data.imageTempPaths || []).length) {
      this.setData({ imageTempPaths: list });
    }
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

  pad(n) {
    return String(n).padStart(2, "0");
  },

  formatDate(d) {
    return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
  },

  formatTime(d) {
    return `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`;
  },

  initDefaultDateTime() {
    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

    this.setData({
      startDate: this.formatDate(start),
      startTime: this.formatTime(start),
      endDate: this.formatDate(end),
      endTime: this.formatTime(end),
      deadlineDate: this.formatDate(start),
      deadlineTime: this.formatTime(start)
    });
  },

  async loadEditData(activityId) {
    if (!this.initCloud()) {
      return;
    }
    const db = wx.cloud.database();
    try {
      const res = await db.collection(EVENT_COLLECTION).doc(activityId).get();
      const data = res && res.data || {};
      const categoryIndex = PRODUCT_CATEGORIES.findIndex((cat) => cat.key === String(data.category || "").trim());
      const startParts = String(data.startAt || "").split(" ");
      const endParts = String(data.endAt || "").split(" ");
      const deadlineParts = String(data.deadlineAt || "").split(" ");

      let imageTempPaths = [];
      if (data.imageUrl) {
        try {
          const downloadRes = await wx.cloud.downloadFile({ fileID: data.imageUrl });
          imageTempPaths = [downloadRes.tempFilePath];
        } catch (e) {
          imageTempPaths = [];
        }
      }

      this.setData({
        title: data.title || "",
        price: data.price != null ? String(data.price) : "",
        description: data.description || "",
        categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
        maxParticipants: data.maxParticipants != null ? String(data.maxParticipants) : "",
        startDate: startParts[0] || this.data.startDate,
        startTime: startParts[1] || this.data.startTime,
        endDate: endParts[0] || this.data.endDate,
        endTime: endParts[1] || this.data.endTime,
        deadlineDate: deadlineParts[0] || this.data.deadlineDate,
        deadlineTime: deadlineParts[1] || this.data.deadlineTime,
        imageTempPaths,
        originalImageUrl: data.imageUrl || ""
      });
      this.updateCanSubmit();
    } catch (e) {
      console.error("load edit data failed:", e);
      wx.showToast({ title: "加载数据失败", icon: "none" });
    }
  },

  toTimestamp(date, time) {
    if (!date || !time) {
      return Number.NaN;
    }
    return new Date(`${date} ${time}`.replace(/-/g, "/")).getTime();
  },

  updateCanSubmit() {
    const title = String(this.data.title || "").trim();
    const priceNum = Number(this.data.price);
    const hasTitleForbidden = (this.data.titleForbiddenWords || []).length > 0;
    const hasDescForbidden = (this.data.descForbiddenWords || []).length > 0;
    const canSubmit = !!title && Number.isFinite(priceNum) && priceNum > 0 && !hasTitleForbidden && !hasDescForbidden;
    if (canSubmit !== this.data.canSubmit) {
      this.setData({ canSubmit });
    }
  },

  async bindTitleInput(e) {
    const value = e.detail.value || "";
    const { words } = await hasForbiddenWords(value);
    this.setData({ 
      title: value,
      titleForbiddenWords: words
    }, () => this.updateCanSubmit());
  },

  bindPriceInput(e) {
    let raw = String(e.detail.value || "").replace(/[^\d.]/g, "");
    const firstDot = raw.indexOf(".");
    if (firstDot !== -1) {
      const intPart = raw.slice(0, firstDot);
      const decPart = raw.slice(firstDot + 1).replace(/\./g, "").slice(0, 2);
      raw = `${intPart}.${decPart}`;
    }
    this.setData({ price: raw }, () => this.updateCanSubmit());
  },

  async bindDescriptionInput(e) {
    const value = e.detail.value || "";
    const { words } = await hasForbiddenWords(value);
    this.setData({ 
      description: value,
      descForbiddenWords: words
    }, () => this.updateCanSubmit());
  },

  bindCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value || 0) });
  },

  bindStartDateChange(e) {
    this.setData({ startDate: e.detail.value || "" });
  },

  bindStartTimeChange(e) {
    this.setData({ startTime: e.detail.value || "" });
  },

  bindEndDateChange(e) {
    this.setData({ endDate: e.detail.value || "" });
  },

  bindEndTimeChange(e) {
    this.setData({ endTime: e.detail.value || "" });
  },

  bindMaxParticipantsInput(e) {
    const raw = String(e.detail.value || "").replace(/[^\d]/g, "");
    this.setData({ maxParticipants: raw });
  },

  toggleTimeSection() {
    this.setData({ timeSectionOpen: !this.data.timeSectionOpen });
  },

  isInvalidLocalImageUrl(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return true;
    }
    return raw.startsWith("blob:");
  },

  isNonPersistentLocalImageUrl(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return false;
    }
    return (
      raw.startsWith("http://tmp/")
      || raw.startsWith("http://usr/")
      || raw.includes("/__tmp__/")
      || raw.startsWith("http://127.0.0.1")
      || raw.startsWith("http://localhost")
    );
  },

  isDevtoolsLocalHttpPath(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return false;
    }
    return (
      raw.startsWith("http://tmp/")
      || raw.startsWith("http://usr/")
      || raw.includes("/__tmp__/")
      || raw.includes("127.0.0.1")
      || raw.includes("localhost")
    );
  },

  normalizeTempPathForUpload(filePath) {
    const raw = String(filePath || "").trim();
    if (!raw) {
      return Promise.resolve("");
    }
    if (raw.startsWith("cloud://")) {
      return Promise.resolve(raw);
    }
    if (!this.isDevtoolsLocalHttpPath(raw)) {
      return Promise.resolve(raw);
    }
    return new Promise((resolve) => {
      wx.downloadFile({
        url: raw,
        success: (res) => {
          const code = Number(res && res.statusCode);
          const localPath = String(res && res.tempFilePath ? res.tempFilePath : "").trim();
          if (code >= 200 && code < 300 && localPath) {
            resolve(localPath);
            return;
          }
          resolve(raw);
        },
        fail: () => resolve(raw),
      });
    });
  },

  chooseImage() {
    const remaining = this.data.maxImageCount - (this.data.imageTempPaths || []).length;
    if (remaining <= 0) {
      wx.showToast({ title: this.data.i18n.toastMaxImages, icon: "none" });
      return;
    }
    wx.chooseImage({
      count: remaining,
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const paths = res && res.tempFilePaths ? res.tempFilePaths : [];
        if (!paths.length) {
          return;
        }
        Promise.all(
          paths.map((p) => this.normalizeTempPathForUpload(String(p || "").trim()))
        ).then((normalized) => {
          const valid = normalized
            .map((p, i) => String(p || paths[i] || "").trim())
            .filter((p) => p && !this.isInvalidLocalImageUrl(p));
          if (!valid.length) {
            wx.showToast({ title: this.data.i18n.toastInvalidTemp, icon: "none" });
            return;
          }
          const merged = (this.data.imageTempPaths || [])
            .concat(valid)
            .slice(0, this.data.maxImageCount);
          this.setData({ imageTempPaths: merged });
        });
      }
    });
  },

  removeImageAt(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(idx)) {
      return;
    }
    const list = (this.data.imageTempPaths || []).slice();
    list.splice(idx, 1);
    this.setData({ imageTempPaths: list });
  },

  previewImage(e) {
    const urls = (this.data.imageTempPaths || []).filter(Boolean);
    if (!urls.length) {
      return;
    }
    const idx = Number(e.currentTarget.dataset.index || 0);
    const current = urls[idx] || urls[0];
    if (this.isInvalidLocalImageUrl(current)) {
      wx.showToast({ title: this.data.i18n.toastInvalidPath, icon: "none" });
      return;
    }
    wx.previewImage({ current, urls });
  },

  handleImagePreviewError() {
    wx.showToast({ title: this.data.i18n.toastInvalidPath, icon: "none" });
  },

  getFileExt(filePath, fallbackExt) {
    const match = String(filePath || "").match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
    return match && match[1] ? match[1].toLowerCase() : fallbackExt;
  },

  uploadFileToCloud(filePath) {
    const ext = this.getFileExt(filePath, "jpg");
    const cloudPath = `activity/events/images/${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => (res && res.fileID ? res.fileID : ""));
  },

  resolveLocalImagePathByInfo(imageUrl) {
    const raw = String(imageUrl || "").trim();
    if (!raw) {
      return Promise.resolve("");
    }
    return new Promise((resolve) => {
      wx.getImageInfo({
        src: raw,
        success: (res) => {
          const path = String(
            (res && (res.path || res.tempFilePath)) || ""
          ).trim();
          resolve(path || raw);
        },
        fail: () => resolve(raw),
      });
    });
  },

  prepareAndUploadOne(imagePath) {
    const raw = String(imagePath || "").trim();
    if (!raw) {
      return Promise.resolve("");
    }
    return this.normalizeTempPathForUpload(raw).then((preparedPath) => {
      const safePath = String(preparedPath || raw).trim();
      if (!safePath || this.isInvalidLocalImageUrl(safePath)) {
        return "";
      }
      if (safePath.startsWith("cloud://") || safePath.startsWith("https://")) {
        return safePath;
      }
      if (this.isNonPersistentLocalImageUrl(safePath)) {
        return this.resolveLocalImagePathByInfo(safePath).then((resolvedPath) => {
          const candidatePath = String(resolvedPath || "").trim();
          if (
            !candidatePath
            || this.isInvalidLocalImageUrl(candidatePath)
            || this.isNonPersistentLocalImageUrl(candidatePath)
          ) {
            throw new Error("LOCAL_IMAGE_NOT_UPLOADABLE");
          }
          const recoveredUploadPath = candidatePath.startsWith("file://")
            ? decodeURIComponent(candidatePath.replace(/^file:\/\//i, ""))
            : candidatePath;
          return this.uploadFileToCloud(recoveredUploadPath);
        });
      }
      const uploadPath = safePath.startsWith("file://")
        ? decodeURIComponent(safePath.replace(/^file:\/\//i, ""))
        : safePath;
      return this.uploadFileToCloud(uploadPath);
    });
  },

  uploadAllImages() {
    const paths = (this.data.imageTempPaths || []).filter(Boolean);
    if (!paths.length) {
      return Promise.resolve([]);
    }
    return Promise.all(paths.map((p) => this.prepareAndUploadOne(p))).then((urls) =>
      urls.filter(Boolean)
    );
  },

  createActivityLog(db, title, activityId) {
    return db.collection(ACTIVITY_LOG_COLLECTION).add({
      data: {
        icon: this.data.i18n.logIcon,
        text: `${this.data.i18n.logTextPrefix}${title}`,
        relatedType: "activity_event",
        relatedId: activityId || "",
        createdAt: db.serverDate()
      }
    }).catch(() => null);
  },

  async submitPublish() {
    if (this.data.submitting) {
      return;
    }
    if (!this.data.isAdmin) {
      wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
      return;
    }
    if (!this.initCloud()) {
      wx.showToast({ title: this.data.i18n.toastCloudUnavailable, icon: "none" });
      return;
    }

    const title = String(this.data.title || "").trim();
    const description = String(this.data.description || "").trim();
    const categoryOption = PRODUCT_CATEGORIES[Number(this.data.categoryIndex || 0)] || PRODUCT_CATEGORIES[0];
    const startAt = `${this.data.startDate} ${this.data.startTime}`.trim();
    const endAt = `${this.data.endDate} ${this.data.endTime}`.trim();
    const deadlineAt = `${this.data.deadlineDate} ${this.data.deadlineTime}`.trim();
    const startTs = this.toTimestamp(this.data.startDate, this.data.startTime);
    const endTs = this.toTimestamp(this.data.endDate, this.data.endTime);

    if (!title) {
      wx.showToast({ title: this.data.i18n.toastNeedTitle, icon: "none" });
      return;
    }
    const titleForbidden = await hasForbiddenWords(title);
    const descForbidden = await hasForbiddenWords(description);
    if (titleForbidden.found || descForbidden.found) {
      wx.showToast({ title: this.data.i18n.toastForbiddenWords, icon: "none" });
      return;
    }
    const priceNum = Number(this.data.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      wx.showToast({ title: this.data.i18n.toastNeedPrice, icon: "none" });
      return;
    }
    const price = Math.round(priceNum * 100) / 100;
    if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
      wx.showToast({ title: this.data.i18n.toastNeedTime, icon: "none" });
      return;
    }
    if (endTs <= startTs) {
      wx.showToast({ title: this.data.i18n.toastEndAfterStart, icon: "none" });
      return;
    }

    const userInfo = wx.getStorageSync("userInfo") || {};
    const coachId = String(userInfo.id || userInfo._id || "").trim();
    const coachName = String(userInfo.name || "").trim() || this.data.i18n.defaultCoachName;
    const maxParticipantsNum = Number(this.data.maxParticipants || 0);

    this.setData({ submitting: true });
    const isEdit = !!this.data.editId;
    wx.showLoading({ title: isEdit ? this.data.i18n.updating : this.data.i18n.publishing, mask: true });

    const db = wx.cloud.database();
    const localCoachId = String(userInfo.id || userInfo._id || "").trim();

    this.uploadAllImages()
      .then((imageUrls) => {
        const imageUrl = imageUrls.length > 0 ? imageUrls[0] : "";
        return wx.cloud.callFunction({
          name: "quickstartFunctions",
          data: {
            type: "publishGoods",
            userId: localCoachId,
            preferUserId: true,
            expectedRole: "coach_or_admin",
            editId: this.data.editId || "",
            title,
            description,
            price,
            category: categoryOption.key,
            categoryLabel: categoryOption.label,
            startAt,
            endAt,
            deadlineAt,
            maxParticipants: Number.isFinite(maxParticipantsNum) ? Math.max(0, maxParticipantsNum) : 0,
            imageUrl,
            imageUrls,
            coachId,
            coachName,
          },
        });
      })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          const err = new Error(result.message || "publish_goods_failed");
          err.detail = result;
          throw err;
        }
        const activityId = result.activityId || (this.data.editId || "");
        console.log('[mall] publish goods result:', result);
        return this.createActivityLog(db, title, activityId);
      })
      .then(() => {
        wx.showToast({ title: isEdit ? this.data.i18n.toastUpdateSuccess : this.data.i18n.toastPublishSuccess, icon: "success" });
        setTimeout(() => {
          wx.navigateBack();
        }, 300);
      })
      .catch((error) => {
        console.error(isEdit ? "update product failed:" : "publish product failed:", error);
        const msg = String((error && error.message) || "");
        if (msg.includes("permission_denied")) {
          wx.showToast({ title: this.data.i18n.toastNoPermission, icon: "none" });
          return;
        }
        if (msg.includes("title_required")) {
          wx.showToast({ title: this.data.i18n.toastNeedTitle, icon: "none" });
          return;
        }
        if (msg.includes("invalid_price")) {
          wx.showToast({ title: this.data.i18n.toastNeedPrice, icon: "none" });
          return;
        }
        if (msg === "LOCAL_IMAGE_NOT_UPLOADABLE") {
          wx.showToast({ title: this.data.i18n.toastNeedRealDevice, icon: "none" });
          return;
        }
        wx.showToast({ title: this.data.i18n.toastPublishFail, icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ submitting: false });
      });
  }
});
