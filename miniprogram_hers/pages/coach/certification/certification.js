const COLLECTION_NAME = {
  USERS: "users",
};

Page({
  data: {
    idCardFront: "",
    idCardBack: "",
    certificates: [],
    submitting: false,
  },

  onLoad() {
    const accountRole = String(wx.getStorageSync("accountRole") || "").toLowerCase();
    if (accountRole !== "coach") {
      wx.showToast({ title: "只有教练才能申请认证", icon: "none" });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    }
  },

  initCloud() {
    if (!wx.cloud) {
      return false;
    }
    wx.cloud.init({ env: getApp().globalData.env, traceUser: true });
    return true;
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync("userInfo") || {};
    return userInfo.id || userInfo._id || "";
  },

  chooseIdCardFront() {
    this.chooseImage((filePath) => {
      this.setData({ idCardFront: filePath });
    });
  },

  chooseIdCardBack() {
    this.chooseImage((filePath) => {
      this.setData({ idCardBack: filePath });
    });
  },

  chooseCertificate() {
    this.chooseImage((filePath) => {
      const certificates = this.data.certificates.concat([filePath]);
      this.setData({ certificates });
    }, true);
  },

  removeCertificate(e) {
    const index = e.currentTarget.dataset.index;
    const certificates = this.data.certificates.filter((_, i) => i !== index);
    this.setData({ certificates });
  },

  chooseImage(callback, multiple = false) {
    wx.chooseImage({
      count: multiple ? 9 : 1,
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const tempFilePaths = res.tempFilePaths || [];
        if (tempFilePaths.length > 0) {
          callback(tempFilePaths[0]);
        }
      },
      fail: () => {
        wx.showToast({ title: "选择图片失败", icon: "none" });
      },
    });
  },

  async uploadImage(filePath) {
    if (!filePath) return "";
    const cloudPath = `certification/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
    const result = await wx.cloud.uploadFile({
      cloudPath,
      filePath,
    });
    return result.fileID || "";
  },

  async submitCertification() {
    if (!this.data.idCardFront || !this.data.idCardBack) {
      wx.showToast({ title: "请上传身份证照片", icon: "none" });
      return;
    }
    if (this.data.certificates.length === 0) {
      wx.showToast({ title: "请上传至少一张资质证明", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: "提交中...", mask: true });

    try {
      const idCardFrontFileId = await this.uploadImage(this.data.idCardFront);
      const idCardBackFileId = await this.uploadImage(this.data.idCardBack);
      const certificateFileIds = await Promise.all(
        this.data.certificates.map((path) => this.uploadImage(path))
      );

      if (!idCardFrontFileId || !idCardBackFileId) {
        throw new Error("身份证上传失败");
      }

      await wx.cloud.callFunction({
        name: "quickstartFunctions",
        data: {
          type: "applyCoachCertification",
          userId: this.getCurrentUserId(),
          preferUserId: true,
          materials: {
            idCardFront: idCardFrontFileId,
            idCardBack: idCardBackFileId,
            certificates: certificateFileIds.filter(Boolean),
          },
        },
      });

      wx.showToast({ title: "提交成功，等待审核", icon: "success" });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
    } catch (error) {
      console.error("submitCertification error:", error);
      wx.showToast({ title: "提交失败，请重试", icon: "none" });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
