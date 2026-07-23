const cloud = require("wx-server-sdk");
const https = require("https");
const http = require("http");
const { URL } = require("url");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const METRIC_TEMPLATE = [
  { key: "balance", name: "Balance Control" },
  { key: "stability", name: "Stability" },
  { key: "posture", name: "Posture" },
  { key: "legDrive", name: "Leg Drive" },
  { key: "rhythm", name: "Rhythm" },
];

const clamp = (num, min, max) => Math.max(min, Math.min(max, num));

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
};

const mean = (list) => {
  const arr = Array.isArray(list) ? list.filter((v) => Number.isFinite(v)) : [];
  if (!arr.length) return 0;
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
};

const normalizeStringList = (value, limit = 6) =>
  Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit)
    : [];

const truncateText = (value, maxLen = 40) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
};

const normalizeMetricKey = (value) => {
  const source = String(value || "").trim();
  const raw = source.toLowerCase().replace(/[\s_-]+/g, "");
  const zh = source.replace(/[\s_-]+/g, "");
  if (!raw && !zh) return "";
  if (["balance", "center", "gravity"].includes(raw) || ["重心平衡", "重心", "平衡", "重心控制"].includes(zh)) return "balance";
  if (["stability", "steady"].includes(raw) || ["动作稳定", "稳定", "稳定性"].includes(zh)) return "stability";
  if (["posture", "form"].includes(raw) || ["姿态", "姿态控制", "动作姿态"].includes(zh)) return "posture";
  if (["legdrive", "drive", "power"].includes(raw) || ["蹬伸发力", "发力", "下肢发力", "腿部发力"].includes(zh)) return "legDrive";
  if (["rhythm", "tempo"].includes(raw) || ["节奏", "节奏连贯", "连贯性", "节奏连贯性"].includes(zh)) return "rhythm";
  return "";
};

const parseRootPayload = (event) => {
  if (!event || typeof event !== "object") return {};
  if (event.body) {
    if (typeof event.body === "string") {
      try {
        return JSON.parse(event.body);
      } catch (e) {
        return {};
      }
    }
    if (typeof event.body === "object") return event.body;
  }
  return event;
};

const requestJson = ({ url, method = "POST", headers = {}, body, timeoutMs = 30000 }) =>
  new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error("invalid_hunyuan_url"));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;
    const payload = typeof body === "string" ? body : JSON.stringify(body || {});

    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (e) {
            reject(new Error("hunyuan_invalid_json"));
            return;
          }
          resolve({
            statusCode: Number(res.statusCode || 0),
            data,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("hunyuan_timeout"));
    });
    req.on("error", (error) => reject(error));
    req.write(payload);
    req.end();
  });

const resolveVideoTempUrl = async (fileID) => {
  const safeFileID = String(fileID || "").trim();
  if (!safeFileID) return "";
  const res = await cloud.getTempFileURL({ fileList: [safeFileID] });
  const list = res && Array.isArray(res.fileList) ? res.fileList : [];
  const item = list[0] || {};
  return String(item.tempFileURL || item.download_url || "").trim();
};

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

const buildPrompt = ({ actionType, note, videoInfo }) => {
  const safeActionType = String(actionType || "basic_skating").trim() || "basic_skating";
  const safeNote = String(note || "").trim();
  const safeInfo = videoInfo && typeof videoInfo === "object" ? videoInfo : {};

  return [
    "你是少儿轮滑动作分析助手，面向家长和孩子。",
    "只输出JSON，不要markdown，不要额外解释。",
    "所有文本用简体中文，语气友好、通俗、具体。",
    "分数字段范围0-100整数。",
    "summary不超过40字；tips最多2条，每条不超过24字。",
    "phaseScores固定3项(warmup/execution/recovery)，comment不超过28字。",
    "strengths最多2项，weaknesses最多2项，riskAlerts最多2条。",
    "trainingPlan固定3天，每天tasks最多2条，每条不超过20字。",
    "metrics必须包含5项key：balance, stability, posture, legDrive, rhythm。",
    "输出结构包含：overallScore, metrics, summary, tips, confidence, phaseScores, strengths, weaknesses, riskAlerts, trainingPlan, videoQuality, noteEcho。",
    `actionType: ${safeActionType}`,
    `note: ${safeNote || "none"}`,
    `videoInfo: ${JSON.stringify({
      duration: toNumber(safeInfo.duration, 0),
      size: toNumber(safeInfo.size, 0),
      width: toNumber(safeInfo.width, 0),
      height: toNumber(safeInfo.height, 0),
    })}`,
  ].join("\n");
};

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
            { type: "input_video", video_url: videoURL },
          ],
        },
      ],
    },
  ];
  const strictPayloads = basePayloads.map((item) => ({
    ...item,
    response_format: { type: "json_object" },
  }));
  return [...strictPayloads, ...basePayloads];
};

const extractContentText = (node) => {
  if (!node) return "";
  if (typeof node === "string") return node.trim();
  if (Array.isArray(node)) {
    return node
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return String(item.text || item.content || item.output_text || "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  if (typeof node === "object") {
    return String(node.text || node.content || node.output_text || "").trim();
  }
  return "";
};

const extractJsonText = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return "";

  if (raw.startsWith("{") && raw.endsWith("}")) {
    return raw;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced && fenced[1]) {
    return String(fenced[1]).trim();
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return raw.slice(first, last + 1).trim();
  }
  return "";
};

const parseModelJSON = (responseData) => {
  const safe = responseData && typeof responseData === "object" ? responseData : {};

  if (safe.analysis && typeof safe.analysis === "object") {
    return safe.analysis;
  }

  const message = safe.choices && safe.choices[0] && safe.choices[0].message ? safe.choices[0].message : {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolArgs = toolCalls.map((item) => item && item.function ? item.function.arguments : "").join("\n");
  const candidates = [
    extractContentText(message.content),
    extractContentText(message.reasoning_content),
    extractContentText(safe.choices && safe.choices[0] ? safe.choices[0].text : ""),
    extractContentText(safe.output_text),
    extractContentText(toolArgs),
  ].filter(Boolean);

  for (let i = 0; i < candidates.length; i += 1) {
    const jsonText = extractJsonText(candidates[i]);
    if (!jsonText) continue;
    try {
      return JSON.parse(jsonText);
    } catch (e) {
      // Try next candidate format
    }
  }
  return null;
};

const normalizeMetrics = (value) => {
  const scoreMap = {};

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const key = normalizeMetricKey(item.key || item.name || item.id);
      if (!key) return;
      scoreMap[key] = clamp(Math.round(toNumber(item.score, 0)), 0, 100);
    });
  } else if (value && typeof value === "object") {
    Object.keys(value).forEach((name) => {
      const key = normalizeMetricKey(name);
      if (!key) return;
      scoreMap[key] = clamp(Math.round(toNumber(value[name], 0)), 0, 100);
    });
  }

  return METRIC_TEMPLATE.map((item) => ({
    key: item.key,
    name: item.name,
    score: typeof scoreMap[item.key] === "number" ? scoreMap[item.key] : null,
  }));
};

const normalizePhaseScores = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        key: String(item && item.key ? item.key : "").trim(),
        name: truncateText(item && item.name ? item.name : "", 12),
        score: clamp(Math.round(toNumber(item && item.score, 0)), 0, 100),
        comment: truncateText(item && item.comment ? item.comment : "", 28),
      }))
      .filter((item) => item.key && item.name)
      .slice(0, 3)
    : [];

const normalizeDetailItems = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        key: normalizeMetricKey(item && (item.key || item.name || item.id)),
        name: truncateText(item && item.name ? item.name : "", 12),
        score: clamp(Math.round(toNumber(item && item.score, 0)), 0, 100),
        note: truncateText(item && item.note ? item.note : "", 36),
      }))
      .filter((item) => item.key && item.name)
      .slice(0, 2)
    : [];

const normalizeTrainingPlan = (value) =>
  Array.isArray(value)
    ? value
      .map((item) => ({
        day: truncateText(item && item.day ? item.day : "", 10),
        focus: truncateText(item && item.focus ? item.focus : "", 18),
        duration: truncateText(item && item.duration ? item.duration : "", 12),
        tasks: normalizeStringList(item && item.tasks, 2).map((task) => truncateText(task, 24)),
      }))
      .filter((item) => item.day || item.focus || item.tasks.length)
      .slice(0, 3)
    : [];

const normalizeModelAnalysis = (raw, fallbackContext = {}) => {
  if (!raw || typeof raw !== "object") return null;

  let metrics = normalizeMetrics(raw.metrics);
  const metricScores = metrics.map((item) => item.score).filter((score) => typeof score === "number");
  if (!metricScores.length) {
    return null;
  }

  let overallScore = toNumber(raw.overallScore, NaN);
  if (Number.isNaN(overallScore)) {
    overallScore = Math.round(mean(metricScores));
  }
  overallScore = clamp(Math.round(overallScore), 0, 100);

  metrics = metrics.map((item) => ({
    ...item,
    score: typeof item.score === "number" ? item.score : overallScore,
  }));

  const phaseScores = normalizePhaseScores(raw.phaseScores);
  const strengths = normalizeDetailItems(raw.strengths);
  const weaknesses = normalizeDetailItems(raw.weaknesses);
  const trainingPlan = normalizeTrainingPlan(raw.trainingPlan);
  const riskAlerts = normalizeStringList(raw.riskAlerts, 5);
  const tips = normalizeStringList(raw.tips, 6);

  const safeVideoQuality = raw.videoQuality && typeof raw.videoQuality === "object" ? raw.videoQuality : {};
  const videoQuality = {
    score: clamp(Math.round(toNumber(safeVideoQuality.score, 0)), 0, 100),
    issues: normalizeStringList(safeVideoQuality.issues, 2).map((item) => truncateText(item, 24)),
    recommendation: truncateText(safeVideoQuality.recommendation || "", 36),
  };

  return {
    overallScore,
    summary: truncateText(raw.summary || "", 48) || "本次动作表现中等，可继续练习。",
    metrics,
    tips: (tips.length ? tips : ["保持稳定拍摄，继续分解练习。"])
      .slice(0, 2)
      .map((item) => truncateText(item, 28)),
    confidence: clamp(Math.round(toNumber(raw.confidence, overallScore)), 0, 100),
    phaseScores,
    strengths,
    weaknesses,
    riskAlerts: riskAlerts.slice(0, 2).map((item) => truncateText(item, 28)),
    trainingPlan,
    videoQuality,
    noteEcho: truncateText(raw.noteEcho || fallbackContext.note || "", 28),
    generatedAt: String(raw.generatedAt || "").trim() || new Date().toISOString(),
  };
};

const buildStubAnalysis = ({ actionType, note }) => {
  const base = {
    balance: 74,
    stability: 76,
    posture: 75,
    legDrive: 72,
    rhythm: 77,
  };
  const metrics = METRIC_TEMPLATE.map((item) => ({
    key: item.key,
    name: item.name,
    score: clamp(base[item.key] || 75, 0, 100),
  }));
  const overallScore = Math.round(mean(metrics.map((item) => item.score)));
  return {
    overallScore,
    summary: "Fallback result only. Check Hunyuan API config and retry.",
    metrics,
    tips: [
      "Configure real model endpoint for accurate analysis.",
      "Keep full body visible and avoid occlusion when recording.",
    ],
    confidence: 60,
    phaseScores: [],
    strengths: [],
    weaknesses: [],
    riskAlerts: ["Current result is fallback and low confidence."],
    trainingPlan: [
      { day: "Day 1", focus: `${String(actionType || "basic_skating")} stability`, duration: "20-25min", tasks: ["Low-speed decomposition drill", "Post-session video review"] },
      { day: "Day 2", focus: "Weakness reinforcement", duration: "20-25min", tasks: ["Center-of-mass and rhythm drills", "Repeat in short sets"] },
      { day: "Day 3", focus: "Continuity and rhythm", duration: "20-25min", tasks: ["Continuous movement cycle", "Review transitions"] },
    ],
    videoQuality: {
      score: 0,
      issues: ["Model call failed"],
      recommendation: "Check HUNYUAN_API_KEY and outbound network availability.",
    },
    noteEcho: String(note || "").trim(),
    generatedAt: new Date().toISOString(),
  };
};

const invokeModel = async (config, payload) => {
  const requestPayloads = buildPayloadVariants(payload);
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
  };

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

exports.main = async (event = {}) => {
  const root = parseRootPayload(event);
  const input = root.input && typeof root.input === "object" ? root.input : root;

  const fileID = String(input.fileID || "").trim();
  const actionType = String(input.actionType || "basic_skating").trim() || "basic_skating";
  const note = String(input.note || "").trim();
  const inputVideoURL = String(input.videoURL || "").trim();
  const videoInfo = input.videoInfo && typeof input.videoInfo === "object" ? input.videoInfo : {};
  const config = getConfig();

  const videoURL = inputVideoURL || await resolveVideoTempUrl(fileID);
  if (!videoURL) {
    return {
      success: false,
      error: "video_url_missing",
    };
  }

  if (!config.apiKey) {
    if (!config.stubOnError) {
      return {
        success: false,
        error: "hunyuan_api_key_missing",
      };
    }
    return {
      success: true,
      provider: "hunyuan_vision_video_stub",
      warning: "hunyuan_api_key_missing_stub",
      analysis: buildStubAnalysis({ actionType, note }),
    };
  }

  const prompt = buildPrompt({ actionType, note, videoInfo });
  const modelResult = await invokeModel(config, {
    model: config.model,
    prompt,
    videoURL,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    videoFps: config.videoFps,
  });

  if (!modelResult.data) {
    if (!config.stubOnError) {
      return {
        success: false,
        error: modelResult.error || "hunyuan_request_failed",
      };
    }
    return {
      success: true,
      provider: "hunyuan_vision_video_stub",
      warning: modelResult.error || "hunyuan_request_failed_stub",
      analysis: buildStubAnalysis({ actionType, note }),
    };
  }

  const parsed = parseModelJSON(modelResult.data);
  const analysis = normalizeModelAnalysis(parsed, { note });
  if (!analysis) {
    console.log("hunyuan_output_invalid_raw:", JSON.stringify(modelResult.data || {}).slice(0, 3000));
    if (!config.stubOnError) {
      return {
        success: false,
        error: "hunyuan_output_invalid",
      };
    }
    return {
      success: true,
      provider: "hunyuan_vision_video_stub",
      warning: "hunyuan_output_invalid_stub",
      analysis: buildStubAnalysis({ actionType, note }),
    };
  }

  const usage = modelResult.data && modelResult.data.usage && typeof modelResult.data.usage === "object"
    ? modelResult.data.usage
    : {};

  return {
    success: true,
    provider: "hunyuan_vision_video",
    model: config.model,
    usage,
    analysis,
  };
};
