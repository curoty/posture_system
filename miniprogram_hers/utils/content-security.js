const checkContentSafe = async (type, content, options) => {
  const safeOpts = options || {};
  try {
    const res = await wx.cloud.callFunction({
      name: "contentSecurityCheck",
      data: {
        type: String(type || "text"),
        content: String(content || "").slice(0, 500),
        mediaUrl: String(safeOpts.mediaUrl || ""),
        mediaType: Number(safeOpts.mediaType || 0),
      },
    });
    const result = res && res.result ? res.result : {};
    return result;
  } catch (err) {
    return { success: false, message: "内容安全检测失败，请重试" };
  }
};

const checkTextSafe = (content) => checkContentSafe("text", content);

const checkImageSafe = (mediaUrl) => checkContentSafe("image", "", { mediaUrl });

module.exports = { checkContentSafe, checkTextSafe, checkImageSafe };
