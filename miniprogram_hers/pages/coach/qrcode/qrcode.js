Page({
  data: {
    qrBase64: "",
    inviteCode: "",
    loading: false,
    errorMsg: "",
  },

  onLoad() {
    this.generateQR();
  },

  async generateQR() {
    this.setData({ loading: true, errorMsg: "" });
    try {
      const res = await wx.cloud.callFunction({
        name: "generateCoachQR",
      });
      if (res.result && res.result.success) {
        this.setData({
          qrBase64: res.result.qrBase64,
          inviteCode: String(res.result.inviteCode || "").trim(),
        });
      } else {
        this.setData({ errorMsg: (res.result && res.result.message) || "生成失败" });
      }
    } catch (err) {
      this.setData({ errorMsg: "云函数调用失败，请检查是否已部署" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onTapSaveQR() {
    if (!this.data.qrBase64) return;
    wx.showLoading({ title: "保存中..." });
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/coach_qr.png`;
    fs.writeFile({
      filePath,
      data: this.data.qrBase64,
      encoding: "base64",
      success: () => {
        wx.hideLoading();
        wx.saveImageToPhotosAlbum({
          filePath,
          success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
          fail: () => wx.showToast({ title: "保存失败，请授权相册权限", icon: "none" }),
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "图片写入失败", icon: "none" });
      },
    });
  },

  onRetry() {
    this.generateQR();
  },

  onTapCopyCode() {
    const inviteCode = String(this.data.inviteCode || "").trim();
    if (!inviteCode) return;
    wx.setClipboardData({
      data: inviteCode,
      success: () => wx.showToast({ title: "6位码已复制", icon: "success" }),
    });
  },
});
