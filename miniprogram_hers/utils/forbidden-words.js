// 业务层最终仍需接入微信官方 security.msgSecCheck 或云函数做语义级审核
// 当前方案仅为前端基础拦截，用于初步过滤明显违规内容

const COLLECTION_NAME = "forbidden_words";

const DEFAULT_FORBIDDEN_WORDS = [
  { word: "色情", category: "色情" },
  { word: "淫秽", category: "色情" },
  { word: "淫乱", category: "色情" },
  { word: "赌博", category: "赌博" },
  { word: "毒品", category: "毒品" },
  { word: "毒贩", category: "毒品" },
  { word: "贩毒", category: "毒品" },
  { word: "吸毒", category: "毒品" },
  { word: "大麻", category: "毒品" },
  { word: "冰毒", category: "毒品" },
  { word: "海洛因", category: "毒品" },
  { word: "毒", category: "毒品" },
  { word: "枪支", category: "枪支" },
  { word: "枪械", category: "枪支" },
  { word: "子弹", category: "枪支" },
  { word: "武器", category: "枪支" },
  { word: "军火", category: "枪支" },
  { word: "枪", category: "枪支" },
  { word: "暴力", category: "暴力" },
  { word: "血腥", category: "暴力" },
  { word: "恐怖", category: "暴力" },
  { word: "恐怖主义", category: "暴力" },
  { word: "暴", category: "暴力" },
  { word: "反动", category: "政治" },
  { word: "颠覆", category: "政治" },
  { word: "分裂", category: "政治" },
  { word: "台独", category: "政治" },
  { word: "港独", category: "政治" },
  { word: "藏独", category: "政治" },
  { word: "邪教", category: "邪教" },
  { word: "法轮功", category: "邪教" },
  { word: "侮辱", category: "辱骂" },
  { word: "诽谤", category: "辱骂" },
  { word: "诈骗", category: "诈骗" },
  { word: "欺诈", category: "诈骗" },
  { word: "传销", category: "诈骗" },
  { word: "非法集资", category: "诈骗" },
  { word: "裸体", category: "低俗" },
  { word: "露点", category: "低俗" },
  { word: "性器官", category: "低俗" },
  { word: "三级片", category: "低俗" },
  { word: "AV", category: "低俗" },
  { word: "杀人", category: "违法" },
  { word: "抢劫", category: "违法" },
  { word: "盗窃", category: "违法" },
  { word: "强奸", category: "违法" },
  { word: "绑架", category: "违法" },
  { word: "走私", category: "违法" },
  { word: "造假", category: "违法" },
  { word: "偷税", category: "违法" },
  { word: "漏税", category: "违法" },
  { word: "兴奋剂", category: "违规" },
  { word: "壮阳药", category: "违规" },
  { word: "迷药", category: "违规" },
  { word: "春药", category: "违规" },
  { word: "假币", category: "违规" },
  { word: "伪造", category: "违规" },
];

const CATEGORIES = ["色情", "赌博", "毒品", "枪支", "暴力", "政治", "邪教", "辱骂", "诈骗", "低俗", "违法", "违规"];

let _cachedWords = [];
let _cacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

const cleanText = (text) => {
  let result = String(text || "").trim();
  result = result.toLowerCase();
  result = result.replace(/[\uFEFF\u200B\u200C\u200D\u2060\u180E]/g, "");
  result = result.replace(/[\u3000\u202F\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u205F]/g, "");
  result = result.replace(/\s+/g, "");
  result = result.replace(/！/g, "!").replace(/？/g, "?").replace(/。/g, ".").replace(/，/g, ",");
  result = result.replace(/：/g, ":").replace(/；/g, ";").replace(/、/g, ",").replace(/（/g, "(").replace(/）/g, ")");
  result = result.replace(/【/g, "[").replace(/】/g, "]").replace(/《/g, "<").replace(/》/g, ">");
  result = result.replace(/‘/g, "'").replace(/’/g, "'").replace(/“/g, '"').replace(/”/g, '"');
  result = result.replace(/—/g, "-").replace(/–/g, "-").replace(/／/g, "/");
  return result;
};

const escapeRegex = (str) => {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const buildRegexPattern = (word) => {
  const chars = String(word || "").split("");
  if (chars.length === 0) {
    return "";
  }
  const escapedChars = chars.map((char) => escapeRegex(char));
  return escapedChars.join("[\\s\\W]*");
};

const containsForbidden = (text, word) => {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return false;
  }
  const pattern = buildRegexPattern(word);
  if (!pattern) {
    return false;
  }
  try {
    const regex = new RegExp(pattern);
    return regex.test(cleaned);
  } catch (e) {
    return false;
  }
};

const initCloud = () => {
  if (!wx.cloud) {
    return false;
  }
  try {
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  } catch (e) {
    return false;
  }
};

const getDb = () => {
  if (!initCloud()) {
    return null;
  }
  return wx.cloud.database();
};

const loadFromCloud = async () => {
  const db = getDb();
  if (!db) {
    return DEFAULT_FORBIDDEN_WORDS;
  }
  try {
    const res = await db.collection(COLLECTION_NAME).where({
      enabled: true,
    }).get();
    const cloudWords = (res && res.data && Array.isArray(res.data)) ? res.data : [];
    if (cloudWords.length === 0) {
      await initDefaultWords(db);
      return DEFAULT_FORBIDDEN_WORDS;
    }
    const existingWords = new Set(cloudWords.map((item) => String(item.word || "").trim()));
    const missingWords = DEFAULT_FORBIDDEN_WORDS.filter((item) => !existingWords.has(item.word));
    if (missingWords.length > 0) {
      await initDefaultWords(db, existingWords);
    }
    return cloudWords.map((item) => ({
      word: String(item.word || "").trim(),
      category: String(item.category || "").trim() || "其他",
      enabled: item.enabled !== false,
    })).filter((item) => item.word);
  } catch (e) {
    return DEFAULT_FORBIDDEN_WORDS;
  }
};

const initDefaultWords = async (db, existingWords = new Set()) => {
  const failedWords = [];
  for (const item of DEFAULT_FORBIDDEN_WORDS) {
    if (existingWords.has(item.word)) {
      continue;
    }
    try {
      await db.collection(COLLECTION_NAME).add({
        data: {
          word: item.word,
          category: item.category,
          enabled: true,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
        },
      });
    } catch (addErr) {
      console.error("init default word failed:", item.word, addErr);
      failedWords.push(item.word);
    }
  }
  if (failedWords.length > 0) {
    console.warn("init default words partially failed, failed count:", failedWords.length);
  }
};

const getForbiddenWords = async (forceRefresh = false) => {
  if (!forceRefresh && _cachedWords.length > 0 && Date.now() - _cacheTime < CACHE_DURATION) {
    return _cachedWords;
  }
  const words = await loadFromCloud();
  _cachedWords = words;
  _cacheTime = Date.now();
  return words;
};

const getWordList = async () => {
  const words = await getForbiddenWords();
  return words.map((item) => item.word);
};

const hasForbiddenWords = async (text) => {
  const raw = String(text || "").trim();
  if (!raw) {
    return { found: false, words: [], categories: [] };
  }
  const words = await getForbiddenWords();
  const foundWithCategory = words.filter((item) => containsForbidden(raw, item.word));
  const foundWords = foundWithCategory.map((item) => item.word);
  const categories = [...new Set(foundWithCategory.map((item) => item.category))];
  return { found: foundWords.length > 0, words: foundWords, categories };
};

const addForbiddenWord = async (word, category = "其他") => {
  const db = getDb();
  if (!db) {
    return { success: false, message: "云环境不可用" };
  }
  const trimmedWord = String(word || "").trim();
  if (!trimmedWord) {
    return { success: false, message: "请输入违禁词" };
  }
  const finalCategory = String(category || "").trim() === "全部" ? "其他" : (String(category || "").trim() || "其他");
  try {
    const existing = await db.collection(COLLECTION_NAME).where({
      word: trimmedWord,
    }).get();
    if (existing && existing.data && existing.data.length > 0) {
      return { success: false, message: "该违禁词已存在" };
    }
    await db.collection(COLLECTION_NAME).add({
      data: {
        word: trimmedWord,
        category: finalCategory,
        enabled: true,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    _cachedWords = [];
    return { success: true, message: "添加成功" };
  } catch (e) {
    console.error("addForbiddenWord failed:", e);
    const errMsg = String(e.message || e.errMsg || "").toLowerCase();
    if (errMsg.includes("collection not exists") || errMsg.includes("-502005")) {
      try {
        await initDefaultWords(db, new Set([trimmedWord]));
        const existingAfterInit = await db.collection(COLLECTION_NAME).where({
          word: trimmedWord,
        }).get();
        if (existingAfterInit && existingAfterInit.data && existingAfterInit.data.length > 0) {
          return { success: false, message: "该违禁词已存在" };
        }
        await db.collection(COLLECTION_NAME).add({
          data: {
            word: trimmedWord,
            category: finalCategory,
            enabled: true,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        });
        _cachedWords = [];
        return { success: true, message: "添加成功" };
      } catch (retryErr) {
        console.error("addForbiddenWord retry failed:", retryErr);
        return { success: false, message: "添加失败: " + (retryErr.message || retryErr.errMsg || String(retryErr)) };
      }
    }
    return { success: false, message: "添加失败: " + (e.message || e.errMsg || String(e)) };
  }
};

const deleteForbiddenWord = async (word) => {
  const db = getDb();
  if (!db) {
    return { success: false, message: "云环境不可用" };
  }
  const trimmedWord = String(word || "").trim();
  if (!trimmedWord) {
    return { success: false, message: "请输入要删除的违禁词" };
  }
  try {
    const res = await db.collection(COLLECTION_NAME).where({
      word: trimmedWord,
    }).get();
    if (!res || !res.data || res.data.length === 0) {
      return { success: false, message: "该违禁词不存在" };
    }
    await db.collection(COLLECTION_NAME).doc(res.data[0]._id).remove();
    _cachedWords = [];
    return { success: true, message: "删除成功" };
  } catch (e) {
    return { success: false, message: "删除失败" };
  }
};

const toggleForbiddenWord = async (word, enabled) => {
  const db = getDb();
  if (!db) {
    return { success: false, message: "云环境不可用" };
  }
  const trimmedWord = String(word || "").trim();
  if (!trimmedWord) {
    return { success: false, message: "参数错误" };
  }
  try {
    const res = await db.collection(COLLECTION_NAME).where({
      word: trimmedWord,
    }).get();
    if (!res || !res.data || res.data.length === 0) {
      return { success: false, message: "该违禁词不存在" };
    }
    await db.collection(COLLECTION_NAME).doc(res.data[0]._id).update({
      data: {
        enabled: !!enabled,
        updatedAt: db.serverDate(),
      },
    });
    _cachedWords = [];
    return { success: true, message: enabled ? "已启用" : "已禁用" };
  } catch (e) {
    return { success: false, message: "操作失败" };
  }
};

const getAllWords = async () => {
  const db = getDb();
  if (!db) {
    return DEFAULT_FORBIDDEN_WORDS;
  }
  try {
    const res = await db.collection(COLLECTION_NAME).orderBy("category", "asc").orderBy("word", "asc").get();
    const cloudWords = (res && res.data && Array.isArray(res.data)) ? res.data : [];
    if (cloudWords.length === 0) {
      await initDefaultWords(db);
      return DEFAULT_FORBIDDEN_WORDS;
    }
    const existingWords = new Set(cloudWords.map((item) => String(item.word || "").trim()));
    const missingWords = DEFAULT_FORBIDDEN_WORDS.filter((item) => !existingWords.has(item.word));
    if (missingWords.length > 0) {
      await initDefaultWords(db, existingWords);
    }
    return cloudWords.map((item) => ({
      _id: item._id,
      word: String(item.word || "").trim(),
      category: String(item.category || "").trim() || "其他",
      enabled: item.enabled !== false,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })).filter((item) => item.word);
  } catch (e) {
    return DEFAULT_FORBIDDEN_WORDS;
  }
};

module.exports = {
  getForbiddenWords,
  getWordList,
  hasForbiddenWords,
  containsForbidden,
  cleanText,
  addForbiddenWord,
  deleteForbiddenWord,
  toggleForbiddenWord,
  getAllWords,
  CATEGORIES,
  DEFAULT_FORBIDDEN_WORDS,
};
