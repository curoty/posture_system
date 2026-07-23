Component({
  properties: {
    course: {
      type: Object,
      value: null
    }
  },

  methods: {
    previewAssistantQr(url) {
      wx.previewImage({
        current: url,
        urls: [url],
        fail: () => {
          wx.showModal({
            title: '添加助理微信',
            content: '请添加助理微信：wxid_2c2q2dj6s4zu22',
            showCancel: false
          });
        }
      });
    },

    handleEnroll() {
      const localQr = '/images/assistant-wechat-qr.png';
      const fallbackQr = 'https://api.qrserver.com/v1/create-qr-code/?size=800x800&data=wxid_2c2q2dj6s4zu22';
      wx.getImageInfo({
        src: localQr,
        success: () => this.previewAssistantQr(localQr),
        fail: () => this.previewAssistantQr(fallbackQr)
      });
    }
  }
});
