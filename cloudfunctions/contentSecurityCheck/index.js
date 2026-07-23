const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const type = String(event.type || "").trim();
  const content = String(event.content || "").trim();
  const mediaUrl = String(event.mediaUrl || "").trim();
  const mediaType = Number(event.mediaType || 0);

  if (!content && !mediaUrl) {
    return { success: true, passed: true };
  }

  if (content && type === "text") {
    try {
      const res = await cloud.openapi.security.msgSecCheck({
        content: content.slice(0, 500),
      });
      if (res && res.errCode !== 0) {
        return { success: false, message: "文本包含违规内容，请修改后重试" };
      }
    } catch (err) {
      if (err && err.errCode === 87014) {
        return { success: false, message: "文本包含违规内容，请修改后重试" };
      }
      throw err;
    }
  }

  if (mediaUrl && type === "image") {
    try {
      const bufferResult = await cloud.downloadFile({ fileID: mediaUrl });
      if (!bufferResult || !bufferResult.fileContent) {
        return { success: false, message: "图片下载失败，请重新上传" };
      }
      const res = await cloud.openapi.security.imgSecCheck({
        media: {
          contentType: "image/png",
          value: bufferResult.fileContent,
        },
      });
      if (res && res.errCode !== 0) {
        return { success: false, message: "图片包含违规内容，请更换后重试" };
      }
    } catch (err) {
      if (err && err.errCode === 87014) {
        return { success: false, message: "图片包含违规内容，请更换后重试" };
      }
      throw err;
    }
    return { success: true, passed: true };
  }

  return { success: true, passed: true };
};
