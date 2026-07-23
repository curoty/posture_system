const appConfig = require("../../../../config");

const API_BASE_URL = appConfig.wifi.apiBaseUrl;
const CHUNK_FRAME_COUNT = 500;
// Fetch two seconds of 50 Hz data at a time. The old 25-frame window caused
// roughly 60 sequential HTTP round trips for a 30-second capture; the server's
// 250 ms polling granularity then stretched a valid 1500-frame run to ~47 s.
const POLL_FRAME_COUNT = 100;
const PREPARE_TIMEOUT_MS = 20000;
const PREPARE_POLL_INTERVAL_MS = 300;
const EXPECTED_WAIST_DEVICE_ID = "a0f262f05508";

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
    .callFunction({ name: "skateActionAnalyze", data, config: { timeout: 20000 } })
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

const sortFramesBySeq = (frames) =>
  frames.sort((a, b) => Number(a && a.seq ? a.seq : 0) - Number(b && b.seq ? b.seq : 0));

const saveStaticChunk = async ({
  captureId,
  phase,
  groupNumber,
  chunkIndex,
  frames,
}) => {
  const result = await callCloudReliable({
    type: "saveStaticSampleChunk",
    captureId,
    phase: phase.value,
    groupNumber,
    durationSeconds: phase.seconds,
    chunkIndex,
    frames: sortFramesBySeq(frames),
  });
  if (!result || result.success !== true) {
    throw new Error((result && result.message) || `第${chunkIndex + 1}分块保存失败`);
  }
};

const getServerReceivedMs = (frame) => {
  const safe = frame && typeof frame === "object" ? frame : {};
  return Number(
    safe.server_received_ms !== undefined
      ? safe.server_received_ms
      : safe._server_received_ms || 0,
  );
};

const isExpectedWaistFrame = (frame) => {
  const deviceId = String(
    (frame && (frame.device_id || frame.deviceId || frame.mac)) || "",
  )
    .replace(/[:-]/g, "")
    .toLowerCase();
  const unixTimestampMs = Number(frame && frame.unix_ts_ms);
  return (
    deviceId === EXPECTED_WAIST_DEVICE_ID &&
    Boolean(frame && frame.time_synced) &&
    Number.isFinite(unixTimestampMs) &&
    unixTimestampMs >= 1000000000000
  );
};

const collectNewWaistFrames = (response, sinceReceivedMs) => {
  const received = Array.isArray(response && response.frames) ? response.frames : [];
  return received.filter((frame) => {
    if (!isExpectedWaistFrame(frame)) return false;
    return getServerReceivedMs(frame) > Number(sinceReceivedMs || 0);
  });
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
    this.setData({ statusText: "正在停止并保存数据..." });
  },

  async waitForMqttReady() {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    while (!this._stopRequested && Date.now() < deadline) {
      const health = await request({ url: `${API_BASE_URL}/health`, method: "GET" });
      // health.device_connected is derived from the server's last received
      // frame cache and can legitimately be false just after startup. The
      // following waitForLiveWaistFrames() performs the authoritative,
      // role-specific freshness check for waist, so do not gate on that
      // global cache here.
      const mqttReady = Boolean(health && health.mqtt && health.mqtt.mqtt_connected);
      if (mqttReady) {
        return health;
      }
      this.setData({ statusText: "等待腰部节点连接MQTT..." });
      await sleep(PREPARE_POLL_INTERVAL_MS);
    }
    throw new Error("MQTT设备未在线，请先确认腰部节点正在发布数据");
  },

  async waitForLiveWaistFrames() {
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    let sinceReceivedMs = null;

    while (!this._stopRequested && Date.now() < deadline) {
      this.setData({ statusText: "等待腰部节点开始连续出帧..." });
      try {
        const response = await request({
          url: `${API_BASE_URL}/frames`,
          method: "POST",
          header: { "Content-Type": "application/json" },
          data: {
            frameCount: 1,
            sampleIntervalMs: 20,
            roles: ["waist"],
            ...(sinceReceivedMs !== null ? { sinceReceivedMs } : {}),
          },
        });

        if (sinceReceivedMs === null) {
          // Establish the capture boundary at the server's current wall clock.
          // latest_server_received_ms may belong to an old buffered frame and
          // must never be used as the start cursor for a new capture.
          sinceReceivedMs = Number(
            response.server_now_ms || Date.now(),
          );
          await sleep(PREPARE_POLL_INTERVAL_MS);
          continue;
        }

        const readyFrames = collectNewWaistFrames(response, sinceReceivedMs);
        if (readyFrames.length) {
          return Math.max(
            sinceReceivedMs,
            ...readyFrames.map((frame) => getServerReceivedMs(frame)),
          );
        }
      } catch (error) {
        const message = String(error && error.message ? error.message : "");
        if (message !== "HTTP_503") {
          throw error;
        }
      }
      await sleep(PREPARE_POLL_INTERVAL_MS);
    }

    throw new Error("腰部节点未开始稳定出帧，请检查供电、WiFi热点与MQTT");
  },

  async startCapture() {
    if (this.data.running) return;

    const phase = this.data.phaseOptions[this.data.phaseIndex];
    const groupNumber = this.data.groupOptions[this.data.groupIndex];
    const captureId = `waist_${phase.value}_g${groupNumber}_${Date.now()}`;
    let sinceReceivedMs = null;
    let startedAt = 0;
    let endAt = 0;
    let totalFrames = 0;
    let totalChunks = 0;
    const pendingFrames = [];
    let finalStatus = "completed";
    let enqueuedChunks = 0;
    let saveError = null;
    let saveQueue = Promise.resolve();

    const enqueueChunkSave = (frames) => {
      const chunkIndex = enqueuedChunks;
      enqueuedChunks += 1;
      saveQueue = saveQueue
        .then(async () => {
          if (saveError) return;
          await saveStaticChunk({
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
      latestTemperature: "-",
      captureId,
      errorText: "",
    });

    try {
      await this.waitForMqttReady();
      sinceReceivedMs = await this.waitForLiveWaistFrames();

      startedAt = Date.now();
      // 以目标帧数作为主要结束条件。/frames 在无新帧时最多等待约 10 秒，
      // 如果只按墙钟 30 秒结束，网络等待会直接吞掉有效采集时间。
      const expectedFrames = phase.seconds * 50;
      const maxCaptureMs = phase.seconds * 1000 + 60000;
      endAt = startedAt + maxCaptureMs;
      this.setData({ statusText: "采集中，请保持设备绝对静止" });

      this._progressTimer = setInterval(() => {
        const elapsedSeconds = Math.min(
          phase.seconds,
          Math.floor((totalFrames / 50)),
        );
        this.setData({
          elapsedSeconds,
          progress: Math.floor((elapsedSeconds * 100) / phase.seconds),
        });
      }, 250);

      while (
        !this._stopRequested &&
        totalFrames < expectedFrames &&
        Date.now() < endAt
      ) {
        if (saveError) throw saveError;
        let response = null;
        try {
          response = await request({
            url: `${API_BASE_URL}/frames`,
            method: "POST",
            header: { "Content-Type": "application/json" },
            data: {
              frameCount: POLL_FRAME_COUNT,
              sampleIntervalMs: 20,
              sinceReceivedMs,
              roles: ["waist"],
            },
          });
        } catch (error) {
          const message = String(error && error.message ? error.message : "");
          if (message === "HTTP_503") {
            continue;
          }
          throw error;
        }

        const frames = collectNewWaistFrames(response, sinceReceivedMs);
        if (!frames.length) {
          continue;
        }

        const remainingFrameCount = expectedFrames - totalFrames;
        const acceptedFrames = frames.slice(0, remainingFrameCount);
        sinceReceivedMs = Math.max(
          sinceReceivedMs,
          ...frames.map((frame) => getServerReceivedMs(frame)),
        );
        pendingFrames.push(...acceptedFrames);
        totalFrames += acceptedFrames.length;

        const last = acceptedFrames[acceptedFrames.length - 1] || {};
        const waist = last.points && last.points.waist ? last.points.waist : {};
        const elapsedSeconds = Math.min(
          phase.seconds,
          Math.min(phase.seconds, Math.floor(totalFrames / 50)),
        );
        const latestTemperatureRaw =
          last.temperature_c !== undefined
            ? last.temperature_c
            : waist.temperature_c;
        const latestTemperature = Number.isFinite(Number(latestTemperatureRaw))
          ? Number(latestTemperatureRaw).toFixed(2)
          : "-";

        this.setData({
          totalFrames,
          totalChunks,
          elapsedSeconds,
          progress: Math.floor((elapsedSeconds * 100) / phase.seconds),
          latestTemperature,
        });

        while (pendingFrames.length >= CHUNK_FRAME_COUNT) {
          const chunk = pendingFrames.splice(0, CHUNK_FRAME_COUNT);
          enqueueChunkSave(chunk);
        }

        // Normally one chunk is produced every 10 seconds and the background
        // writer stays caught up. Apply backpressure only if three chunks are
        // waiting, preventing unbounded memory growth during a cloud outage.
        if (enqueuedChunks - totalChunks >= 3) {
          await saveQueue;
          if (saveError) throw saveError;
        }
      }

      if (this._stopRequested) {
        finalStatus = "stopped";
      }

      if (!this._stopRequested) {
        const minimumAcceptedFrames = Math.floor(expectedFrames * 0.9);
        if (totalFrames < minimumAcceptedFrames) {
          throw new Error(
            `采集帧严重不足：实际${totalFrames}帧，期望约${expectedFrames}帧，至少应达到${minimumAcceptedFrames}帧`,
          );
        }
      }

      if (pendingFrames.length) {
        enqueueChunkSave(pendingFrames.splice(0));
      }
      this.setData({ statusText: "采集完成，正在确认后台保存..." });
      await saveQueue;
      if (saveError) throw saveError;
      this.setData({ totalChunks, totalFrames });
    } catch (error) {
      finalStatus = "failed";
      this.setData({ errorText: error.message || "采集失败" });
    } finally {
      if (this._progressTimer) {
        clearInterval(this._progressTimer);
        this._progressTimer = null;
      }

      await saveQueue;
      if (saveError && !this.data.errorText) {
        finalStatus = "failed";
        this.setData({ errorText: saveError.message || "后台分块保存失败" });
      }

      try {
        await callCloudReliable({
          type: "finishStaticSampleCapture",
          captureId,
          phase: phase.value,
          groupNumber,
          durationSeconds: phase.seconds,
          totalFrames,
          totalChunks,
          status: finalStatus,
        });
      } catch (error) {}

      wx.setKeepScreenOn({ keepScreenOn: false });
      this.setData({
        running: false,
        statusText:
          finalStatus === "completed"
            ? "采集完成"
            : finalStatus === "stopped"
              ? "已停止并保存"
              : "采集失败",
      });
    }
  },
});
