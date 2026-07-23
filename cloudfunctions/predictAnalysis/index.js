const cloud = require("wx-server-sdk");
const http = require("http");
const https = require("https");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const PREDICT_URL = process.env.PREDICT_URL;
const REQUEST_TIMEOUT_MS = 60000;

function normalizeLegacyResults(body) {
  const safe = body && typeof body === "object" ? body : {};
  if (safe.analysis && typeof safe.analysis === "object") {
    const analysis = safe.analysis;
    const sensorSession =
      analysis.sensorSession && typeof analysis.sensorSession === "object"
        ? analysis.sensorSession
        : {};
    return [
      {
        label_name: String(sensorSession.predictedAction || "").trim(),
        quality_score:
          analysis.overallScore !== undefined ? Number(analysis.overallScore) : 0,
        quality_level: String(
          sensorSession.qualityLevel || analysis.qualityLevel || "",
        ).trim(),
        confidence:
          analysis.confidence !== undefined
            ? Number(analysis.confidence) / 100
            : Number(sensorSession.actionConfidence || 0),
        prediction: {
          label_name: String(sensorSession.predictedAction || "").trim(),
          confidence:
            analysis.confidence !== undefined
              ? Number(analysis.confidence) / 100
              : Number(sensorSession.actionConfidence || 0),
        },
        quality_prediction:
          sensorSession.qualityScore !== undefined || sensorSession.qualityLevel
            ? {
                label: String(sensorSession.qualityLevel || "").trim(),
                quality_score:
                  sensorSession.qualityScore !== undefined
                    ? Number(sensorSession.qualityScore)
                    : analysis.overallScore !== undefined
                      ? Number(analysis.overallScore)
                      : 0,
              }
            : null,
        top_predictions: Array.isArray(sensorSession.topPredictions)
          ? sensorSession.topPredictions
          : [],
        coaching_advice: String(analysis.summary || "").trim(),
        inference_mode: "sensor_api_v1",
        model_version: String(analysis.modelVersion || "").trim(),
      },
    ];
  }
  if (safe.data && Array.isArray(safe.data.results)) {
    return safe.data.results;
  }

  const segments = Array.isArray(safe.segments) ? safe.segments : [];
  return segments.map((segment) => {
    const prediction =
      segment && typeof segment.prediction === "object"
        ? segment.prediction
        : {};
    const qualityPrediction =
      segment && typeof segment.quality_prediction === "object"
        ? segment.quality_prediction
        : {};
    return {
      label_name: String(prediction.label_name || "").trim(),
      quality_score:
        segment && segment.quality_score !== undefined
          ? Number(segment.quality_score)
          : 0,
      quality_level: String(
        segment.quality_level || qualityPrediction.label || "",
      ).trim(),
      confidence: Number(prediction.confidence || 0),
      prediction,
      quality_prediction: qualityPrediction,
      top_predictions: Array.isArray(segment.top_predictions)
        ? segment.top_predictions
        : [],
      start_ms: Number(segment.start_ms || 0),
      end_ms: Number(segment.end_ms || 0),
      duration_seconds: Number(segment.duration_seconds || 0),
    };
  });
}

function httpPost(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const transport = urlObj.protocol === "https:" ? https : http;

    console.log(`\n\n========== HTTP POST ${url} ==========`);
    console.log(`请求体 JSON 长度: ${Buffer.byteLength(data)} 字节`);
    console.log(`请求体前 200 字符: ${data.substring(0, 200)}...`);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    };

    console.log("请求 options:", JSON.stringify(options, null, 2));

    const req = transport.request(options, (res) => {
      console.log(`HTTP 响应状态码: ${res.statusCode}`);
      console.log("HTTP 响应 headers:", JSON.stringify(res.headers, null, 2));

      let chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          console.log(
            `HTTP 响应原始内容 (前 500 字符): ${raw.substring(0, 500)}${raw.length > 500 ? "...(共 " + raw.length + " 字符)" : ""}`,
          );
          const json = JSON.parse(raw);
          console.log("HTTP 响应解析后 JSON:", JSON.stringify(json, null, 2));
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: json,
            rawString: raw,
          });
        } catch (e) {
          console.error(
            "HTTP 响应 JSON 解析失败:",
            e.message,
            "\n原始内容为:",
            raw,
          );
          reject(
            new Error(
              `解析响应失败: ${e.message} | 原始内容前200字符: ${String(raw || "").substring(0, 200)}`,
            ),
          );
        }
      });
      res.on("error", (err) => {
        console.error("HTTP 响应 error 事件:", err.code, err.message);
        reject(err);
      });
      res.on("timeout", () => {
        console.error("HTTP 响应 timeout 事件");
        reject(new Error("SOCKET_TIMEOUT"));
      });
    });

    req.on("error", (err) => {
      console.error("HTTP 请求 error 事件:", err.code, err.message, err.stack);
      reject(err);
    });
    req.on("timeout", () => {
      console.error("HTTP 请求 timeout 事件, 主动 destroy");
      req.destroy();
      reject(new Error("REQUEST_TIMEOUT"));
    });

    req.write(data);
    req.end();
    console.log("HTTP 请求已发送\n");
  });
}

exports.main = async (event, context) => {
  const {
    frames,
    sessionId,
    actionType,
    activeRoles,
    minActiveRoles,
    sensorProfile,
    legacy9WaistAsHeadDebug,
  } = event;

  console.log(`\n\n========== 云函数 predictAnalysis 入口 ==========`);
  console.log(`event keys: ${Object.keys(event).join(", ")}`);
  console.log(
    `frames: Array.isArray=${Array.isArray(frames)}, length=${Array.isArray(frames) ? frames.length : "N/A"}`,
  );

  if (Array.isArray(frames) && frames.length > 0) {
    console.log("frames[0] 完整结构:", JSON.stringify(frames[0], null, 2));
    if (frames.length > 1) {
      console.log(
        `frames[${frames.length - 1}]:`,
        JSON.stringify(frames[frames.length - 1]),
      );
    }
  }

  if (!PREDICT_URL) {
    console.log("错误: 环境变量 PREDICT_URL 未配置");
    return {
      success: false,
      message: "服务端未配置预测 API 地址，请在云函数环境变量中设置 PREDICT_URL",
    };
  }

  if (!Array.isArray(frames) || frames.length === 0) {
    console.log("错误: frames 不是数组或为空");
    return {
      success: false,
      message: "缺少帧数据",
    };
  }

  const targetPath = (() => {
    try {
      return new URL(PREDICT_URL).pathname || "";
    } catch (error) {
      return "";
    }
  })();

  const requestBody = targetPath.endsWith("/infer")
    ? {
        scene: "sensor_session_analysis_v1",
        version: "miniapp_wifi_v1",
        input: {
          sessionId: sessionId || "",
          actionType: actionType || "",
          activeRoles: Array.isArray(activeRoles) ? activeRoles : [],
          minActiveRoles: Number(minActiveRoles || 1),
          sensorProfile: String(sensorProfile || "full_body_9_v1"),
          legacy9WaistAsHeadDebug: legacy9WaistAsHeadDebug === true,
          frames,
        },
      }
    : {
        sessionId: sessionId || "",
        frames,
        windowSeconds: 4,
        stepSeconds: 2,
      };
  console.log(
    `\n缁勮鏈€缁堣姹備綋 key 涓?'frames'锛屽寘鍚?${
      targetPath.endsWith("/infer")
        ? requestBody.input.frames.length
        : requestBody.frames.length
    } 甯n`,
  );

  try {
    const response = await httpPost(PREDICT_URL, requestBody);

    if (response.statusCode !== 200) {
      console.log(`错误: HTTP 状态码非 200: ${response.statusCode}`);
      return {
        success: false,
        message: `服务器返回异常状态码: ${response.statusCode}`,
      };
    }

    console.log("\n========== 请求成功 ==========\n");
    return {
      success: true,
      data: {
        results: normalizeLegacyResults(response.body),
        raw: response.body,
        analysis:
          response.body && typeof response.body.analysis === "object"
            ? response.body.analysis
            : null,
        sensorProfile: String(sensorProfile || "full_body_9_v1"),
        legacy9WaistAsHeadDebug: legacy9WaistAsHeadDebug === true,
        predictionTrusted: true,
      },
    };
  } catch (error) {
    console.error("\n========== 云函数捕获异常 ==========\n");
    console.error("异常类型:", error.constructor.name);
    console.error("异常 code:", error.code);
    console.error("异常 message:", error.message);
    console.error("异常 stack:", error.stack);
    const errMsg = error.message || "未知网络错误";
    return {
      success: false,
      message: errMsg,
    };
  }
};
