const appConfig = require("../../../../config");

const API_BASE_URL = appConfig.wifi.apiBaseUrl;
const NODE_NAMES = ["left_ankle", "right_ankle", "left_knee", "right_knee"];
const SAMPLE_RATE_HZ = 50;
const SAMPLE_INTERVAL_MS = 20;
const ASSEMBLY_TOLERANCE_MS = 25;
const CHUNK_FRAME_COUNT = 500;
const POLL_FRAME_COUNT = 100;
const PREPARE_TIMEOUT_MS = 30000;
const PREPARE_POLL_INTERVAL_MS = 300;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const request = (options) =>
  new Promise((resolve, reject) => {
    wx.request({
      timeout: 20000,
      ...options,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {});
          return;
        }
        reject(new Error(`HTTP_${res.statusCode}`));
      },
      fail: (error) => reject(new Error(error.errMsg || "request_failed")),
    });
  });

const callCloud = (data) =>
  wx.cloud
    .callFunction({ name: "saveSensorSamples", data, config: { timeout: 20000 } })
    .then((res) => (res && res.result ? res.result : {}));

const callCloudReliable = async (data, attempts = 3) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await callCloud(data);
      if (result && Object.keys(result).length) return result;
      lastError = new Error("云函数返回为空");
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(attempt * 500);
  }
  throw lastError || new Error("云函数调用失败");
};

const isTransientFramesError = (error) => {
  const message = String((error && error.message) || "").toLowerCase();
  return (
    message === "http_503" ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection reset") ||
    message.includes("socket")
  );
};

const isCompleteFourNodeFrame = (frame) => {
  const points = frame && frame.points && typeof frame.points === "object"
    ? frame.points
    : {};
  return NODE_NAMES.every(
    (nodeName) =>
      points[nodeName] &&
      typeof points[nodeName] === "object" &&
      ["ax", "ay", "az", "gx", "gy", "gz"].every((axis) =>
        Number.isFinite(Number(points[nodeName][axis])),
      ),
  );
};

const collectCompleteFrames = (response, sinceSampleMs) => {
  const frames = Array.isArray(response && response.frames) ? response.frames : [];
  return frames.filter(
    (frame) =>
      isCompleteFourNodeFrame(frame) &&
      Number(frame && frame.t) > Number(sinceSampleMs || 0),
  );
};

Page({
  data: {
    phaseOptions: [
      { label: "30秒链路测试", value: "test", seconds: 30 },
      { label: "1分钟采集", value: "1min", seconds: 60 },
      { label: "3分钟采集", value: "3min", seconds: 180 },
      { label: "5分钟采集", value: "5min", seconds: 300 },
      { label: "10分钟采集", value: "10min", seconds: 600 },
    ],
    groupOptions: [1, 2, 3, 4],
    phaseIndex: 0,
    groupIndex: 0,
    running: false,
    statusText: "待开始",
    elapsedSeconds: 0,
    targetSeconds: 30,
    progress: 0,
    totalFrames: 0,
    totalChunks: 0,
    nodeFrames: {
      left_ankle: 0,
      right_ankle: 0,
      left_knee: 0,
      right_knee: 0,
    },
    latestTemperature: "-",
    captureId: "",
    errorText: "",
  },

  onPhaseChange(event) {
    const phaseIndex = Number(event.detail.value) || 0;
    this.setData({
      phaseIndex,
      targetSeconds: this.data.phaseOptions[phaseIndex].seconds,
    });
  },

  onGroupChange(event) {
    this.setData({ groupIndex: Number(event.detail.value) || 0 });
  },

  stopCapture() {
    this._stopRequested = true;
    this.setData({ statusText: "正在停止并保存已采集数据..." });
  },

  async waitForMqttReady() {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    while (!this._stopRequested && Date.now() < deadline) {
      try {
        const health = await request({ url: `${API_BASE_URL}/health`, method: "GET" });
        if (
          health &&
          health.mqtt &&
          health.mqtt.mqtt_connected
        ) {
          return;
        }
      } catch (error) {}
      this.setData({ statusText: "等待 MQTT Broker 连接..." });
      await sleep(PREPARE_POLL_INTERVAL_MS);
    }
    throw new Error("MQTT设备未在线，请检查四个节点的供电、WiFi和MQTT连接");
  },

  buildFramesRequest(
    captureStartReceivedMs,
    sinceSampleMs,
    frameCount = POLL_FRAME_COUNT,
  ) {
    return {
      frameCount,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sinceReceivedMs: captureStartReceivedMs,
      captureStartReceivedMs,
      sinceSampleMs,
      roles: NODE_NAMES,
      assembleNodes: true,
      assemblyToleranceMs: ASSEMBLY_TOLERANCE_MS,
    };
  },

  async waitForAllFourNodes() {
    const snapshot = await request({
      url: `${API_BASE_URL}/frames`,
      method: "POST",
      header: { "Content-Type": "application/json" },
      data: { frameCount: 1 },
    });
    const captureStartReceivedMs = Number(snapshot.server_now_ms || 0);
    if (!Number.isFinite(captureStartReceivedMs) || captureStartReceivedMs <= 0) {
      throw new Error("服务端未返回有效的采集起点");
    }
    let sinceSampleMs = 0;

    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    while (!this._stopRequested && Date.now() < deadline) {
      this.setData({ statusText: "等待四个节点完成时间同步并连续出帧..." });
      try {
        const response = await request({
          url: `${API_BASE_URL}/frames`,
          method: "POST",
          header: { "Content-Type": "application/json" },
          data: this.buildFramesRequest(
            captureStartReceivedMs,
            sinceSampleMs,
            25,
          ),
        });
        const frames = collectCompleteFrames(response, sinceSampleMs);
        if (frames.length) {
          sinceSampleMs = Math.max(
            sinceSampleMs,
            ...frames.map((frame) => Number(frame.t || 0)),
          );
          return { captureStartReceivedMs, sinceSampleMs };
        }
      } catch (error) {
        if (!isTransientFramesError(error)) {
          throw error;
        }
      }
      await sleep(PREPARE_POLL_INTERVAL_MS);
    }
    throw new Error(
      "30秒内未形成完整四节点帧，请确认四个节点均在线且NTP时间同步成功",
    );
  },

  async saveChunk({
    captureId,
    phase,
    groupNumber,
    chunkIndex,
    frames,
  }) {
    const result = await callCloudReliable({
      type: "saveStaticSampleChunk",
      captureId,
      phase: phase.value,
      groupNumber,
      durationSeconds: phase.seconds,
      chunkIndex,
      sampleRateHz: SAMPLE_RATE_HZ,
      expectedRoles: NODE_NAMES,
      frames,
    });
    if (!result || result.success !== true || result.ok !== true) {
      throw new Error((result && result.message) || `第${chunkIndex + 1}分块保存失败`);
    }
  },

  async finishCapture({
    captureId,
    phase,
    groupNumber,
    totalFrames,
    totalChunks,
    status,
  }) {
    const result = await callCloudReliable({
      type: "finishStaticSampleCapture",
      captureId,
      phase: phase.value,
      groupNumber,
      durationSeconds: phase.seconds,
      sampleRateHz: SAMPLE_RATE_HZ,
      expectedRoles: NODE_NAMES,
      totalFrames,
      totalChunks,
      nodeFrameCounts: {
        left_ankle: totalFrames,
        right_ankle: totalFrames,
        left_knee: totalFrames,
        right_knee: totalFrames,
      },
      status,
    });
    if (!result || result.success !== true || result.ok !== true) {
      throw new Error((result && result.message) || "采集汇总记录保存失败");
    }
  },

  async startCapture() {
    if (this.data.running) return;

    const phase = this.data.phaseOptions[this.data.phaseIndex];
    const groupNumber = this.data.groupOptions[this.data.groupIndex];
    const captureId = `four_nodes_${phase.value}_g${groupNumber}_${Date.now()}`;
    const expectedFrames = phase.seconds * SAMPLE_RATE_HZ;
    const pendingFrames = [];
    let captureStartReceivedMs = 0;
    let sinceSampleMs = 0;
    let totalFrames = 0;
    let totalChunks = 0;
    let finalStatus = "completed";
    let manifestSaved = false;
    let enqueuedChunks = 0;
    let saveError = null;
    let saveQueue = Promise.resolve();

    const enqueueChunkSave = (frames) => {
      const chunkIndex = enqueuedChunks;
      enqueuedChunks += 1;
      saveQueue = saveQueue
        .then(async () => {
          if (saveError) return;
          await this.saveChunk({
            captureId,
            phase,
            groupNumber,
            chunkIndex,
            frames,
          });
          totalChunks += 1;
          this.setData({ totalChunks });
        })
        .catch((error) => {
          saveError = error;
        });
    };

    this._stopRequested = false;
    wx.setKeepScreenOn({ keepScreenOn: true });
    this.setData({
      running: true,
      statusText: "检查设备与MQTT...",
      elapsedSeconds: 0,
      targetSeconds: phase.seconds,
      progress: 0,
      totalFrames: 0,
      totalChunks: 0,
      nodeFrames: {
        left_ankle: 0,
        right_ankle: 0,
        left_knee: 0,
        right_knee: 0,
      },
      latestTemperature: "-",
      captureId,
      errorText: "",
    });

    try {
      await this.waitForMqttReady();
      const cursors = await this.waitForAllFourNodes();
      captureStartReceivedMs = cursors.captureStartReceivedMs;
      sinceSampleMs = cursors.sinceSampleMs;
      this.setData({ statusText: "采集中，请保持四个设备绝对静止" });

      const maxCaptureMs = phase.seconds * 1000 + 60000;
      const endAt = Date.now() + maxCaptureMs;
      while (
        !this._stopRequested &&
        totalFrames < expectedFrames &&
        Date.now() < endAt
      ) {
        if (saveError) throw saveError;
        let response;
        try {
          response = await request({
            url: `${API_BASE_URL}/frames`,
            method: "POST",
            header: { "Content-Type": "application/json" },
            data: this.buildFramesRequest(
              captureStartReceivedMs,
              sinceSampleMs,
            ),
          });
        } catch (error) {
          if (isTransientFramesError(error)) {
            this.setData({ statusText: "网络短暂超时，正在继续采集..." });
            await sleep(200);
            continue;
          }
          throw error;
        }

        const frames = collectCompleteFrames(response, sinceSampleMs);
        if (!frames.length) continue;
        sinceSampleMs = Math.max(
          sinceSampleMs,
          ...frames.map((frame) => Number(frame.t || 0)),
        );

        const accepted = frames.slice(0, expectedFrames - totalFrames);
        pendingFrames.push(...accepted);
        totalFrames += accepted.length;

        const elapsedSeconds = Math.min(
          phase.seconds,
          Math.floor(totalFrames / SAMPLE_RATE_HZ),
        );
        const nodeFrames = {
          left_ankle: totalFrames,
          right_ankle: totalFrames,
          left_knee: totalFrames,
          right_knee: totalFrames,
        };
        const last = accepted[accepted.length - 1] || {};
        const temperatures = last.node_temperature_c || {};
        const temperatureValues = NODE_NAMES
          .map((name) => Number(temperatures[name]))
          .filter(Number.isFinite);
        this.setData({
          totalFrames,
          totalChunks,
          elapsedSeconds,
          progress: Math.floor((elapsedSeconds * 100) / phase.seconds),
          nodeFrames,
          latestTemperature: temperatureValues.length
            ? (
                temperatureValues.reduce((sum, value) => sum + value, 0) /
                temperatureValues.length
              ).toFixed(2)
            : "-",
        });

        while (pendingFrames.length >= CHUNK_FRAME_COUNT) {
          const chunk = pendingFrames.splice(0, CHUNK_FRAME_COUNT);
          enqueueChunkSave(chunk);
        }

        // 正常情况下后台写入会追上采集；只有积压三个分块时才反压，
        // 避免云函数短暂变慢导致内存无限增长。
        if (enqueuedChunks - totalChunks >= 3) {
          this.setData({ statusText: "采集中，后台正在写入..." });
          await saveQueue;
          if (saveError) throw saveError;
          this.setData({ statusText: "采集中，请保持四个设备绝对静止" });
        }
      }

      if (this._stopRequested) {
        finalStatus = "stopped";
      } else if (totalFrames !== expectedFrames) {
        throw new Error(
          `完整帧不足：实际${totalFrames}帧，目标${expectedFrames}帧`,
        );
      }

      if (pendingFrames.length) {
        enqueueChunkSave(pendingFrames.splice(0));
      }

      this.setData({ statusText: "采集完成，正在确认后台保存..." });
      await saveQueue;
      if (saveError) throw saveError;
      await this.finishCapture({
        captureId,
        phase,
        groupNumber,
        totalFrames,
        totalChunks,
        status: finalStatus,
      });
      manifestSaved = true;
    } catch (error) {
      finalStatus = "failed";
      this.setData({ errorText: error.message || "采集失败" });
    } finally {
      if (!manifestSaved) {
        await saveQueue;
        if (saveError && !this.data.errorText) {
          finalStatus = "failed";
          this.setData({ errorText: saveError.message || "后台分块保存失败" });
        }
        try {
          await this.finishCapture({
            captureId,
            phase,
            groupNumber,
            totalFrames,
            totalChunks,
            status: finalStatus,
          });
        } catch (manifestError) {
          if (!this.data.errorText) {
            this.setData({
              errorText: manifestError.message || "采集汇总记录保存失败",
            });
          }
          finalStatus = "failed";
        }
      }
      wx.setKeepScreenOn({ keepScreenOn: false });
      this.setData({
        running: false,
        statusText:
          finalStatus === "completed"
            ? "采集并保存完成"
            : finalStatus === "stopped"
              ? "已停止并保存"
              : "采集失败",
      });
    }
  },
});
