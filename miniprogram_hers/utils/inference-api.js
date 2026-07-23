let BASE_URL = "http://82.156.18.205:18080/api/inference";

const setBaseUrl = (url) => {
  BASE_URL = url;
  console.log("[API] BaseURL updated to:", BASE_URL);
};

const request = (url, options) => {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    console.log("[API Request]", url, opts);
    wx.request({
      url,
      method: opts.method || "GET",
      data: opts.data || {},
      header: { "Content-Type": "application/json" },
      timeout: 30000,
      success: (res) => {
        console.log("[API Response]", url, res);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = res.data;
          if (body && typeof body === "object" && "code" in body && "data" in body) {
            if (body.code === 200) {
              resolve(body.data || body);
            } else {
              reject({ code: body.code, message: body.message || "请求失败" });
            }
          } else {
            resolve(body);
          }
        } else {
          const body = res.data || {};
          reject({ statusCode: res.statusCode, code: body.code, message: body.message || "请求失败" });
        }
      },
      fail: (err) => {
        console.error("[API Error]", err);
        const detail = {
          ...err,
          requestUrl: url,
          hint: "必看排查步骤：\n1. 右上角「详情」→「本地设置」→ 勾选「不校验合法域名」\n2. 后端SpringBoot配置 server.address=0.0.0.0\n3. application.properties: server.port=5000\n4. 关闭代理/VPN软件\n5. 放行Windows防火墙5000端口\n\n开发者工具优先用 127.0.0.1"
        };
        reject(detail);
      },
    });
  });
};

const getLatestAdvice = () => request(`${BASE_URL}/advice/latest`);

const getHistory = (page, size) => {
  const p = Number(page) || 0;
  const s = Number(size) || 20;
  return request(`${BASE_URL}/history?page=${p}&size=${s}`);
};

const getTaskDetail = (taskNo) => request(`${BASE_URL}/tasks/${taskNo}`);

const getTaskResult = (taskNo) => request(`${BASE_URL}/tasks/${taskNo}/result`);

const setTaskScore = (taskNo, score) =>
  request(`${BASE_URL}/tasks/${taskNo}/score`, { method: "PUT", data: { score: Number(score) || 0 } });

module.exports = {
  setBaseUrl,
  getLatestAdvice,
  getHistory,
  getTaskDetail,
  getTaskResult,
  setTaskScore,
};
