# AI动作分析核心代码文档（挑战杯版）

## 1. 系统目标
本项目的 AI 动作分析链路是：
1. 小程序上传视频并发起分析。
2. 云函数 `skateActionAnalyze` 作为编排层，负责超时控制、远程推理调用、兜底策略、结果落库。
3. `keypointInfer` 转发到 `hunyuanVisionService`。
4. `hunyuanVisionService` 调用腾讯混元视觉视频模型 `hunyuan-turbos-vision-video` 返回结构化 JSON。

当前真实模型标识（来自返回）：
- `provider: "hunyuan_vision_video"`
- `model: "hunyuan-turbos-vision-video"`

---

## 2. 前端触发分析（小程序）
文件：`miniprogram/pages/student/ai/analyze/analyze.js`

```js
analyzeAction() {
  if (this.data.analyzing) return;
  if (!this.initCloud()) {
    wx.showToast({ title: "当前基础库不支持云开发", icon: "none" });
    return;
  }
  if (!this.data.videoPath && !this.data.videoCloudFileId && !this.data.remoteVideoUrl) {
    wx.showToast({ title: "请先选择视频", icon: "none" });
    return;
  }

  this.setData({ analyzing: true });
  this.showAnalyzeLoading();

  const actionType = this.data.actionTypeOptions[this.data.actionTypeIndex] || ACTION_TYPE_OPTIONS[0];

  this.uploadVideoIfNeeded()
    .then((fileID) =>
      wx.cloud.callFunction({
        name: "skateActionAnalyze",
        data: {
          type: "analyze",
          fileID,
          actionType,
          note: this.data.note,
          videoInfo: this.data.videoInfo,
        },
      })
    )
    .then((res) => {
      const result = res && res.result ? res.result : {};
      if (!result.success) {
        throw new Error(result.message || result.errMsg || "analyze_failed");
      }
      const inferenceMode = String(result.inferenceMode || "local_rule");
      this.setData({
        analysisResult: normalizeAnalysisResult(result.analysis || {}, inferenceMode),
      });
      if (inferenceMode === "api_keypoint") {
        this.showAnalyzeToast({ title: "模型分析完成", icon: "success" });
        return;
      }
      this.showAnalyzeToast({ title: "已回退到本地分析" });
    })
    .catch((error) => {
      const msg = String((error && error.message) || "");
      console.error("AI分析失败详情:", error);
      this.showAnalyzeToast({ title: mapAnalyzeErrorText(msg) });
    })
    .finally(() => {
      this.hideAnalyzeLoading();
      this.setData({ analyzing: false });
    });
}
```

作用：负责触发云端分析、状态管理（loading）、回显结果。

---

## 3. 编排层：`skateActionAnalyze`（核心中枢）
文件：`cloudfunctions/skateActionAnalyze/index.js`

### 3.1 远程配置读取
```js
const getRemoteConfig = () => {
  const enabledFlag = String(process.env.KEYPOINT_API_ENABLED || "").trim().toLowerCase();
  const enabled = enabledFlag !== "false";
  const url = String(process.env.KEYPOINT_API_URL || "").trim();
  const token = String(process.env.KEYPOINT_API_TOKEN || "").trim();
  const functionName = String(process.env.KEYPOINT_API_FUNCTION || "keypointInfer").trim();
  const timeoutMs = Math.max(3000, toNumber(process.env.KEYPOINT_API_TIMEOUT_MS, 15000));
  return { enabled, url, token, functionName, timeoutMs };
};
```

### 3.2 超时保护（防止小程序 12s 调用超时）
```js
const withTimeout = (promise, timeoutMs, errorCode) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorCode || "api_timeout"));
    }, Math.max(1000, toNumber(timeoutMs, 10000)));
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
```

### 3.3 调用下游模型函数
```js
const callRemoteFunctionInference = async (config, payload) => {
  if (!config.functionName) {
    return { analysis: null, error: "api_function_not_configured" };
  }

  const functionTimeoutMs = Math.min(Math.max(3000, toNumber(config.timeoutMs, 9000)), 10000);
  const resp = await withTimeout(
    cloud.callFunction({
      name: config.functionName,
      data: {
        scene: "inline_skating_action_analysis",
        version: "v1",
        input: payload,
      },
    }),
    functionTimeoutMs,
    "api_function_timeout"
  );

  const raw = resp && typeof resp === "object" && resp.result ? resp.result : resp;
  const analysis = normalizeApiAnalysis(raw);
  if (!analysis) return { analysis: null, error: "api_invalid_result" };
  if (isPlaceholderAnalysis(analysis)) return { analysis: null, error: "api_placeholder_result" };

  return { analysis, error: "" };
};
```

### 3.4 主入口（远程优先 + 本地兜底 + 落库）
```js
exports.main = async (event) => {
  try {
    if (!event || event.type !== "analyze") {
      return { success: false, message: "unsupported_type" };
    }

    const fileID = String(event.fileID || "").trim();
    const actionType = String(event.actionType || "").trim();
    const note = String(event.note || "").trim();
    const videoInfo = event.videoInfo && typeof event.videoInfo === "object" ? event.videoInfo : {};

    if (!fileID) {
      return { success: false, message: "file_id_required" };
    }

    const fallbackAnalysis = buildAnalysis({ fileID, actionType, note, videoInfo });
    const remoteConfig = getRemoteConfig();
    let inferenceMode = "local_rule";
    let apiError = "";
    let analysis = fallbackAnalysis;

    try {
      const remoteResult = await callRemoteInference(remoteConfig, { fileID, actionType, note, videoInfo });
      if (remoteResult && remoteResult.analysis) {
        analysis = mergeAnalysis(remoteResult.analysis, fallbackAnalysis);
        inferenceMode = "api_keypoint";
      } else {
        apiError = remoteResult && remoteResult.error ? remoteResult.error : "api_unavailable";
        inferenceMode = "local_fallback";
      }
    } catch (e) {
      apiError = e && e.message ? e.message : "api_request_failed";
      inferenceMode = "local_fallback";
    }

    const wxContext = cloud.getWXContext();
    const openid = wxContext && wxContext.OPENID ? String(wxContext.OPENID) : "";
    const recordId = await saveAnalysisRecord({
      userId: String(event.userId || ""),
      openid,
      fileID,
      actionType,
      note,
      videoInfo,
      analysis,
      inferenceMode,
      apiError,
    });

    return { success: true, analysis, recordId, inferenceMode };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : "analyze_failed" };
  }
};
```

### 3.5 结果存档（可追溯）
```js
const saveAnalysisRecord = async ({ userId, openid, fileID, actionType, note, videoInfo, analysis, inferenceMode, apiError }) => {
  try {
    const res = await db.collection(RECORD_COLLECTION).add({
      data: {
        userId: String(userId || ""),
        openid: String(openid || ""),
        fileID: String(fileID || ""),
        actionType: String(actionType || ""),
        note: String(note || ""),
        videoInfo: videoInfo && typeof videoInfo === "object" ? videoInfo : {},
        analysis,
        inferenceMode: String(inferenceMode || "local_rule"),
        apiError: String(apiError || ""),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return res && res._id ? res._id : "";
  } catch (e) {
    return "";
  }
};
```

---

## 4. 模型网关：`hunyuanVisionService`（真实大模型调用）
文件：`cloudfunctions/hunyuanVisionService/index.js`

### 4.1 模型配置（默认混元视觉视频）
```js
const getConfig = () => {
  const apiKey = String(process.env.HUNYUAN_API_KEY || "").trim();
  const model = String(process.env.HUNYUAN_MODEL || "hunyuan-turbos-vision-video").trim() || "hunyuan-turbos-vision-video";
  const endpoint = String(process.env.HUNYUAN_API_ENDPOINT || "https://api.hunyuan.cloud.tencent.com/v1/chat/completions").trim();
  const timeoutMs = Math.max(5000, toNumber(process.env.HUNYUAN_TIMEOUT_MS, 30000));
  const temperature = clamp(toNumber(process.env.HUNYUAN_TEMPERATURE, 0.2), 0, 2);
  const maxTokens = clamp(toNumber(process.env.HUNYUAN_MAX_TOKENS, 500), 200, 2000);
  const stubOnErrorRaw = String(process.env.STUB_ON_ERROR || "false").trim().toLowerCase();
  const stubOnError = ["true", "1", "yes"].includes(stubOnErrorRaw);
  const videoFps = clamp(toNumber(process.env.HUNYUAN_VIDEO_FPS, 2), 1, 8);
  return { apiKey, model, endpoint, timeoutMs, temperature, maxTokens, stubOnError, videoFps };
};
```

### 4.2 多 payload 兼容（提升接口适配成功率）
```js
const buildPayloadVariants = ({ model, prompt, videoURL, temperature, maxTokens, videoFps }) => {
  const system = "Return JSON only.";
  const basePayloads = [
    {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "video_url", video_url: { url: videoURL, fps: videoFps } },
          ],
        },
      ],
    },
    {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "video_url", video_url: videoURL },
          ],
        },
      ],
    },
  ];
  const strictPayloads = basePayloads.map((item) => ({ ...item, response_format: { type: "json_object" } }));
  return [...strictPayloads, ...basePayloads];
};
```

### 4.3 调用混元 API + 解析 JSON 输出
```js
const invokeModel = async (config, payload) => {
  const requestPayloads = buildPayloadVariants(payload);
  const headers = { Authorization: `Bearer ${config.apiKey}` };

  let lastError = "hunyuan_request_failed";
  for (let i = 0; i < requestPayloads.length; i += 1) {
    try {
      const response = await requestJson({
        url: config.endpoint,
        method: "POST",
        headers,
        timeoutMs: config.timeoutMs,
        body: requestPayloads[i],
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        lastError = `hunyuan_http_${response.statusCode}`;
        continue;
      }
      return { data: response.data, error: "" };
    } catch (error) {
      lastError = error && error.message ? String(error.message) : "hunyuan_request_failed";
    }
  }
  return { data: null, error: lastError };
};

const parseModelJSON = (responseData) => {
  const safe = responseData && typeof responseData === "object" ? responseData : {};
  if (safe.analysis && typeof safe.analysis === "object") return safe.analysis;

  const message = safe.choices && safe.choices[0] && safe.choices[0].message ? safe.choices[0].message : {};
  const candidates = [
    extractContentText(message.content),
    extractContentText(message.reasoning_content),
    extractContentText(safe.choices && safe.choices[0] ? safe.choices[0].text : ""),
    extractContentText(safe.output_text),
  ].filter(Boolean);

  for (let i = 0; i < candidates.length; i += 1) {
    const jsonText = extractJsonText(candidates[i]);
    if (!jsonText) continue;
    try {
      return JSON.parse(jsonText);
    } catch (e) {}
  }
  return null;
};
```

### 4.4 返回模型身份字段（用于证明“真模型输出”）
```js
return {
  success: true,
  provider: "hunyuan_vision_video",
  model: config.model,
  usage,
  analysis,
};
```

---

## 5. 挑战杯材料可直接使用的“技术亮点”
1. 多级容错：前端超时控制 + 编排层降级 + 模型网关 stub（可关闭）。
2. 标准化输出：将大模型自由文本强制整理为结构化 JSON（分数、阶段、建议、计划）。
3. 可追溯：每次分析都入库，记录 `inferenceMode / apiError / generatedAt`，便于论文与答辩展示。
4. 低耦合：前端只调用 `skateActionAnalyze`，底层模型可替换（混元/其他）而不改页面逻辑。

---

## 6. 环境变量清单（答辩常问）

### `hunyuanVisionService`
- `HUNYUAN_API_KEY`
- `HUNYUAN_MODEL`（默认 `hunyuan-turbos-vision-video`）
- `HUNYUAN_API_ENDPOINT`
- `HUNYUAN_TIMEOUT_MS`
- `HUNYUAN_MAX_TOKENS`
- `HUNYUAN_VIDEO_FPS`
- `STUB_ON_ERROR`

### `skateActionAnalyze`
- `KEYPOINT_API_ENABLED`
- `KEYPOINT_API_FUNCTION`（通常为 `keypointInfer`）
- `KEYPOINT_API_URL`（函数直连模式可空）
- `KEYPOINT_API_TIMEOUT_MS`

### `keypointInfer`
- `KEYPOINT_REAL_ENABLED=true`
- `KEYPOINT_REAL_ENDPOINT=<hunyuanVisionService 的 HTTP URL>`
- `KEYPOINT_REAL_TIMEOUT_MS`

---

## 7. 如何证明当前走的是大模型
查看云函数返回日志中以下字段：
- `provider = "hunyuan_vision_video"`
- `model = "hunyuan-turbos-vision-video"`
- `usage.total_tokens > 0`

若出现：
- `provider = "hunyuan_vision_video_stub"`，说明走了兜底，不是实时大模型。

