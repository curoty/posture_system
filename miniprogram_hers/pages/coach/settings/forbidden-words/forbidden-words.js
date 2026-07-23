const { getAllWords, addForbiddenWord, deleteForbiddenWord, toggleForbiddenWord, CATEGORIES } = require("../../../../utils/forbidden-words");
const { hasAdminAccessInStorage, normalizeRoleToken } = require("../../../../utils/permission");

const isCoachInStorage = () => {
  const localUserInfo = wx.getStorageSync("userInfo") || {};
  const roleList = [
    wx.getStorageSync("accountRole"),
    wx.getStorageSync("userRole"),
    localUserInfo.role,
  ];
  return roleList.some((role) => normalizeRoleToken(role) === "coach");
};

Page({
  data: {
    categoryOptions: ["全部", ...CATEGORIES],
    activeCategory: "全部",
    searchKeyword: "",
    newWord: "",
    newWordCategoryIndex: 0,
    words: [],
    filteredWords: [],
    loading: false,
  },

  onLoad() {
    if (!hasAdminAccessInStorage() && !isCoachInStorage()) {
      wx.showToast({ title: "仅管理员或教练可访问", icon: "none" });
      setTimeout(() => {
        wx.navigateBack({ fail: () => {} });
      }, 300);
      return;
    }
    this.loadWords();
  },

  onShow() {
    if (hasAdminAccessInStorage() || isCoachInStorage()) {
      this.loadWords();
    }
  },

  computeFilteredWords() {
    let result = this.data.words || [];
    if (this.data.activeCategory !== "全部") {
      result = result.filter((item) => item.category === this.data.activeCategory);
    }
    if (this.data.searchKeyword) {
      const keyword = String(this.data.searchKeyword || "").trim().toLowerCase();
      result = result.filter((item) => 
        String(item.word || "").toLowerCase().includes(keyword)
      );
    }
    return result;
  },

  async loadWords() {
    this.setData({ loading: true });
    try {
      const words = await getAllWords();
      this.setData({ words, filteredWords: words });
    } catch (e) {
      console.error("load words failed:", e);
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  refreshList() {
    this.loadWords();
  },

  bindSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value || "" });
    this.setData({ filteredWords: this.computeFilteredWords() });
  },

  bindCategoryTap(e) {
    const category = String(e.currentTarget.dataset.category || "").trim();
    this.setData({ activeCategory: category });
    this.setData({ filteredWords: this.computeFilteredWords() });
  },

  bindNewWordInput(e) {
    this.setData({ newWord: e.detail.value || "" });
  },

  bindNewWordCategoryChange(e) {
    this.setData({ newWordCategoryIndex: Number(e.detail.value || 0) });
  },

  async addWord() {
    const word = String(this.data.newWord || "").trim();
    if (!word) {
      wx.showToast({ title: "请输入违禁词", icon: "none" });
      return;
    }
    const category = this.data.categoryOptions[Number(this.data.newWordCategoryIndex || 0)] || "其他";
    console.log("addWord:", { word, category, newWordCategoryIndex: this.data.newWordCategoryIndex });
    const result = await addForbiddenWord(word, category);
    console.log("addWord result:", result);
    wx.showToast({ title: result.message, icon: result.success ? "success" : "none" });
    if (result.success) {
      this.setData({ newWord: "" });
      this.loadWords();
    }
  },

  async toggleWord(e) {
    const word = String(e.currentTarget.dataset.word || "").trim();
    const enabled = e.currentTarget.dataset.enabled !== "false";
    const result = await toggleForbiddenWord(word, !enabled);
    wx.showToast({ title: result.message, icon: result.success ? "success" : "none" });
    if (result.success) {
      this.loadWords();
    }
  },

  async confirmDeleteWord(e) {
    const word = String(e.currentTarget.dataset.word || "").trim();
    wx.showModal({
      title: "确认删除",
      content: `确定要删除违禁词 "${word}" 吗？`,
      success: async (res) => {
        if (res.confirm) {
          const result = await deleteForbiddenWord(word);
          wx.showToast({ title: result.message, icon: result.success ? "success" : "none" });
          if (result.success) {
            this.loadWords();
          }
        }
      },
    });
  },
});
