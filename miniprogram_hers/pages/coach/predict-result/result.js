Page({
  data: {
    score: 0,
    scoreColor: "mid",
    quality: "-",
    qualityClass: "mid",
    confidence: 0,
    similarity: 0,
    comment: "",
    advice: "",
    details: [],
    voicePlaying: false,
    sessionId: "",
    actionType: "",
  },

  onLoad(options) {
    const eventChannel = this.getOpenerEventChannel();
    if (eventChannel) {
      eventChannel.on("sendPredictResult", (data) => {
        this.displayResult(data);
      });
    }
  },

  displayResult(data) {
    const safe = data || {};
    const rawScore = Number(safe.score || 0);
    const score = Math.round(rawScore);
    const scoreColor = this.getScoreColor(score);
    const quality = String(safe.quality || this.qualityFromScore(score)).trim();
    const qualityClass = this.getQualityClass(quality);
    const confidence = Math.round(Number(safe.confidence || 0));
    const similarity = Math.round(Number(safe.similarity || 0));
    const comment = String(safe.comment || "暂无评语").trim();
    const advice = String(safe.advice || `动作: ${comment}, 参考相似度: ${similarity}%`).trim();
    const details = Array.isArray(safe.details) ? safe.details : [];

    console.log("真实分数：", score, "建议：", advice, "相似度：", similarity);

    this.setData({
      score,
      scoreColor,
      quality,
      qualityClass,
      confidence,
      similarity,
      comment,
      advice,
      details,
      sessionId: String(safe.sessionId || "").trim(),
      actionType: String(safe.actionType || "").trim(),
    }, () => {
      if (advice) {
        setTimeout(() => this.startVoice(), 600);
      }
    });
  },

  getScoreColor(score) {
    if (score >= 90) return "excellent";
    if (score >= 75) return "good";
    if (score >= 60) return "mid";
    return "fail";
  },

  getQualityClass(quality) {
    const map = {
      "优秀": "excellent",
      "excellent": "excellent",
      "良好": "good",
      "good": "good",
      "中等": "mid",
      "mid": "mid",
      "不及格": "fail",
      "fail": "fail",
    };
    const key = String(quality).toLowerCase();
    return map[key] || "mid";
  },

  qualityFromScore(score) {
    if (score >= 90) return "优秀";
    if (score >= 75) return "良好";
    if (score >= 60) return "中等";
    return "不及格";
  },

  onToggleVoice() {
    if (this.data.voicePlaying) {
      this.stopVoice();
      return;
    }
    this.startVoice();
  },

  startVoice() {
    const text = String(this.data.advice || this.data.comment || "").trim();
    if (!text) {
      wx.showToast({ title: "没有可播报的建议", icon: "none" });
      return;
    }

    const speakText = `动作评分${this.data.score}分。${text}`;

    this.setData({ voicePlaying: true });

    let plugin = null;
    try {
      plugin = requirePlugin("WechatSI");
    } catch (e) {
      plugin = null;
    }

    if (plugin && plugin.textToSpeech) {
      plugin.textToSpeech({
        lang: "zh_CN",
        tts: true,
        content: speakText,
        success: (res) => {
          const innerAudioContext = wx.createInnerAudioContext();
          innerAudioContext.src = res.filename;
          innerAudioContext.onEnded(() => {
            this.setData({ voicePlaying: false });
          });
          innerAudioContext.onError(() => {
            this.setData({ voicePlaying: false });
            wx.showToast({ title: "语音播报失败", icon: "none" });
          });
          innerAudioContext.play();
        },
        fail: () => {
          this.fallbackSpeak(speakText);
        },
      });
    } else {
      this.fallbackSpeak(speakText);
    }
  },

  fallbackSpeak(text) {
    wx.showModal({
      title: "语音播报内容",
      content: text,
      showCancel: false,
      success: () => {
        this.setData({ voicePlaying: false });
      },
    });
  },

  stopVoice() {
    this.setData({ voicePlaying: false });
  },

  onGoBack() {
    wx.navigateBack();
  },

  onSaveResult() {
    const resultData = {
      score: this.data.score,
      quality: this.data.quality,
      comment: this.data.comment,
      confidence: this.data.confidence,
      details: this.data.details,
      sessionId: this.data.sessionId,
      actionType: this.data.actionType,
      savedAt: Date.now(),
    };

    try {
      const history = wx.getStorageSync("predict_history") || [];
      history.unshift(resultData);
      wx.setStorageSync("predict_history", history.slice(0, 50));
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (e) {
      wx.showToast({ title: "保存失败", icon: "none" });
    }
  },
});
