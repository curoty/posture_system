/**
 * 蓝牙设备配置
 * Service UUID 和 Characteristic UUID 需要与 config.js 中的 ble 配置保持一致。
 * 实际连接时也可以从 config.js 或 app.js 全局读取动态配置。
 */
const DEFAULT_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const DEFAULT_CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
const MAX_FRAMES = 180;

Page({
  data: {
    connectionStatus: "disconnected",
    deviceName: "",
    isCollecting: false,
    collectedFrames: 0,
    logs: [],
    resultVisible: false,
    score: 0,
    comment: "",
    similarity: 0,
    advice: "",
    level: "",
  },

  _deviceId: "",
  _serviceId: "",
  _charId: "",
  _frames: [],
  _notifyBuffer: "",
  _collecting: false,
  _adapterOpened: false,

  addLog(text) {
    const time = new Date().toLocaleTimeString();
    const logs = this.data.logs.slice(-19);
    logs.push(`[${time}] ${text}`);
    this.setData({ logs });
  },

  async onTapConnect() {
    if (this.data.connectionStatus === "connected") {
      wx.showModal({
        title: "提示",
        content: "是否重新连接？",
        confirmText: "重连",
        success: async (res) => {
          if (res.confirm) {
            await this.doConnect();
          }
        },
      });
      return;
    }
    await this.doConnect();
  },

  async doConnect() {
    this.setData({ connectionStatus: "connecting" });
    this.addLog("开始蓝牙连接...");
    console.log("\n\n========== 蓝牙连接开始 ==========");

    try {
      await this.closeAll();
      await this.delay(300);

      console.log("[1] 打开适配器");
      await wx.openBluetoothAdapter({ mode: "central" });
      this._adapterOpened = true;
      this.addLog("适配器已打开");

      console.log("[2] 开始搜索设备 (10秒)...");
      this.addLog("搜索设备中...");

      const found = await this.scanDevices();
      if (!found) {
        throw new Error("未找到蓝牙设备");
      }

      console.log("[3] 找到设备:", found.name, found.deviceId);
      this.addLog(`找到设备: ${found.name}`);
      this._deviceId = found.deviceId;

      console.log("[4] 建立连接...");
      await wx.createBLEConnection({
        deviceId: this._deviceId,
        timeout: 8000,
      });
      this.addLog("连接已建立");

      console.log("[5] 获取服务...");
      const service = await this.getService(this._deviceId);
      if (!service) {
        throw new Error("未找到服务 " + DEFAULT_SERVICE_UUID);
      }
      this._serviceId = service.uuid;
      console.log("[5] 获取服务成功:", service.uuid);

      console.log("[6] 获取特征...");
      const char = await this.getCharacteristic(this._deviceId, service.uuid);
      if (!char) {
        throw new Error("未找到特征 " + DEFAULT_CHAR_UUID);
      }
      this._charId = char.uuid;
      console.log("[6] 获取特征成功:", char.uuid);

      console.log("[7] 设置 notify 监听...");
      this.registerNotifyListener();
      await wx.notifyBLECharacteristicValueChange({
        deviceId: this._deviceId,
        serviceId: this._serviceId,
        characteristicId: this._charId,
        state: true,
      });

      await this.delay(500);

      console.log("========== 蓝牙连接成功 ==========\n\n");
      this.addLog("连接成功!");
      this.setData({
        connectionStatus: "connected",
        deviceName: found.name || "未知设备",
      });
      wx.showToast({ title: "连接成功", icon: "success" });
    } catch (e) {
      const msg = e.message || JSON.stringify(e);
      console.log("连接失败:", msg);
      this.addLog("失败: " + msg.substring(0, 40));
      this.setData({ connectionStatus: "disconnected" });
      wx.showToast({ title: "连接失败:" + msg.substring(0, 15), icon: "none" });
    }
  },

  async scanDevices() {
    return new Promise((resolve, reject) => {
      const foundDevices = [];
      const timer = setTimeout(() => {
        wx.offBluetoothDeviceFound();
        wx.stopBluetoothDevicesDiscovery().catch(() => 0);
        console.log(
          "搜索到的设备:",
          foundDevices.map((d) => ({ name: d.name, id: d.deviceId })),
        );
        if (foundDevices.length) {
          resolve(
            foundDevices.sort((a, b) => {
              const aMatch =
                String(a.name || a.localName || "").includes("MiCS") ||
                String(a.name || a.localName || "").includes("MICS");
              const bMatch =
                String(b.name || b.localName || "").includes("MiCS") ||
                String(b.name || b.localName || "").includes("MICS");
              if (aMatch && !bMatch) return -1;
              if (!aMatch && bMatch) return 1;
              return (b.RSSI || -90) - (a.RSSI || -90);
            })[0],
          );
        } else {
          reject(new Error("搜索超时，请重试"));
        }
      }, 10000);

      wx.onBluetoothDeviceFound((res) => {
        const devs = Array.isArray(res.devices) ? res.devices : [res];
        devs.forEach((d) => {
          const name = String(d.name || d.localName || "").trim();
          if (
            name &&
            name.length > 2 &&
            !foundDevices.some((fd) => fd.deviceId === d.deviceId)
          ) {
            foundDevices.push({ ...d, name: name || d.localName });
          }
        });
      });

      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        powerLevel: "high",
      });
    });
  },

  async getService(deviceId) {
    try {
      const res = await wx.getBLEDeviceServices({ deviceId });
      const list = Array.isArray(res.services) ? res.services : [];
      for (let s of list) {
        const id = String(s.uuid || s.serviceId || "").toLowerCase();
        if (id === DEFAULT_SERVICE_UUID.toLowerCase() || id.includes("ffe0")) {
          console.log("找到服务", s);
          return s;
        }
      }
      return list[0];
    } catch (e) {
      console.log("getService err", e);
      return null;
    }
  },

  async getCharacteristic(deviceId, serviceId) {
    try {
      const res = await wx.getBLEDeviceCharacteristics({ deviceId, serviceId });
      const list = Array.isArray(res.characteristics)
        ? res.characteristics
        : [];
      for (let c of list) {
        const id = String(c.uuid || c.characteristicId || "").toLowerCase();
        if (id === DEFAULT_CHAR_UUID.toLowerCase() || id.includes("ffe1")) {
          console.log("找到特征", c);
          return c;
        }
      }
      return list.find((c) => c.properties && c.properties.notify) || list[0];
    } catch (e) {
      console.log("getChar err", e);
      return null;
    }
  },

  registerNotifyListener() {
    wx.onBLECharacteristicValueChange((res) => {
      const deviceId = String(res && res.deviceId ? res.deviceId : "").trim();
      const notifyData = res && res.value;
      let hexStr = "";
      if (notifyData && typeof notifyData.byteLength === "number") {
        const arr = new Uint8Array(notifyData);
        for (let i = 0; i < arr.length; i++) {
          hexStr += (arr[i] < 16 ? "0" : "") + arr[i].toString(16) + " ";
        }
        hexStr = hexStr.trim();
      }
      console.log(
        `[BLE RAW] deviceId=${deviceId} len=${notifyData ? notifyData.byteLength : 0} hex=[${hexStr}]`,
      );

      if (!this._collecting) return;

      const hex = this.ab2hex(res.value);
      const text = this.ab2str(res.value);
      console.log(`[RAW] 收到notify: hex=${hex} str=${text}`);

      this._notifyBuffer += text;

      if (this._notifyBuffer.length > 0) {
        const frame = this.tryParseBuffer(this._notifyBuffer);
        const nodeCount =
          frame && frame.points ? Object.keys(frame.points).length : 0;

        if (frame && nodeCount >= 8) {
          this._notifyBuffer = "";
          this._frames.push(frame);
          const len = this._frames.length;
          const ptsKeys = Object.keys(frame.points).join(",");
          console.log(
            `✅ 完整帧 #${len}, ${nodeCount}节点 [${ptsKeys}], 首值=${JSON.stringify(frame.points[ptsKeys.split(",")[0]]).substring(0, 30)}`,
          );
          this.setData({ collectedFrames: len });

          if (len >= MAX_FRAMES) {
            console.log(
              `\n\n========== 满 ${MAX_FRAMES} 帧自动结束 ==========`,
            );
            console.log(`停止前 frames.length = ${this._frames.length}`);
            if (this._frames.length > MAX_FRAMES) {
              console.log(
                `⚠️ frames 超出 ${MAX_FRAMES}，截取前 ${MAX_FRAMES} 帧`,
              );
            }
            this.addLog(`满 ${MAX_FRAMES} 帧，自动停止`);
            this.stopCollectAndAnalyze();
          }
        } else if (frame && nodeCount > 0 && nodeCount < 8) {
          console.log(
            `⏳ 部分帧 ${nodeCount}节点, 等待更多数据... (buffer=${this._notifyBuffer.length}字节)`,
          );
        }

        if (this._notifyBuffer.length > 3000) {
          console.warn(
            `⚠️ 缓冲区过长 ${this._notifyBuffer.length} 字节，自动清空`,
          );
          this._notifyBuffer = "";
        }
      }
    });
  },

  tryParseBuffer(text) {
    const cleaned = String(text || "")
      .replace(/[0-9a-f]{2}(?::[0-9a-f]{2}){5}/gi, "")
      .trim();

    const points = {};

    const tryRoles = [
      "HOST",
      "1A",
      "1B",
      "2A",
      "2B",
      "3A",
      "3B",
      "4A",
      "4B",
      "host",
      "head",
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ];

    for (const role of tryRoles) {
      const matches = cleaned.match(
        new RegExp(`${role}:\\s*([-+.0-9eE,\\s]+)`, "i"),
      );
      if (matches && matches[1]) {
        const nums = (
          matches[1].match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []
        )
          .map((n) => parseFloat(n))
          .filter((n) => !isNaN(n));
        if (nums.length >= 6) {
          const sensorKey =
            {
              HOST: "head",
              host: "head",
              head: "head",
              "1A": "left_elbow",
              "1B": "right_elbow",
              "2A": "left_wrist",
              "2B": "right_wrist",
              "3A": "left_knee",
              "3B": "right_knee",
              "4A": "left_foot",
              "4B": "right_foot",
              0: "head",
              1: "left_elbow",
              2: "right_elbow",
              3: "left_wrist",
              4: "right_wrist",
              5: "left_knee",
              6: "right_knee",
              7: "left_foot",
              8: "right_foot",
            }[role] || role.toLowerCase();
          points[sensorKey] = {
            ax: nums[0],
            ay: nums[1],
            az: nums[2],
            gx: nums[3],
            gy: nums[4],
            gz: nums[5],
          };
        }
      }
    }

    return Object.keys(points).length ? { t: Date.now(), points } : null;
  },

  async onTapToggleCollect() {
    if (this.data.connectionStatus !== "connected") {
      wx.showToast({ title: "请先连接蓝牙", icon: "none" });
      return;
    }

    if (this._collecting) {
      this.stopCollectAndAnalyze();
    } else {
      await this.startCollect();
    }
  },

  async startCollect() {
    console.log(
      "\n\n========== 开始采集，清空frames ==========",
      new Date().toLocaleString(),
    );
    console.log("清空前frames长度", this._frames.length);

    this._frames = [];
    this._notifyBuffer = "";
    this._collecting = true;

    console.log("清空后frames.length:", this._frames.length);

    try {
      await wx.notifyBLECharacteristicValueChange({
        deviceId: this._deviceId,
        serviceId: this._serviceId,
        characteristicId: this._charId,
        state: true,
      });
      console.log("notify 已打开");
    } catch (e) {
      console.log("notify 开关 err", e);
    }

    this.addLog("开始采集...");
    this.setData({
      isCollecting: true,
      collectedFrames: 0,
      resultVisible: false,
      score: 0,
      comment: "",
      similarity: 0,
      advice: "",
      level: "",
    });
  },

  async stopCollectAndAnalyze() {
    this._collecting = false;
    this.setData({ isCollecting: false });

    try {
      await wx.notifyBLECharacteristicValueChange({
        deviceId: this._deviceId,
        serviceId: this._serviceId,
        characteristicId: this._charId,
        state: false,
      });
      console.log("notify 已关闭(保持连接)");
    } catch (e) {}

    const rawFrames = [...this._frames];
    const frames = rawFrames.slice(0, MAX_FRAMES);
    this.addLog(`采集: raw=${rawFrames.length}, 发送=${frames.length} 帧`);

    if (!frames.length) {
      wx.showToast({ title: "无数据", icon: "none" });
      return;
    }

    console.log(`\n\n========== 【本次发送给AI前最终验证】 ==========`);
    console.log("本次frames长度：", frames.length);
    console.log(
      "【真实上传frames】长度=",
      frames.length,
      "内容=",
      JSON.stringify(frames).substring(0, 200),
    );
    console.log("本次frames[0] 数据：", JSON.stringify(frames[0]));
    console.log("本次frames[1] 数据：", JSON.stringify(frames[1]));
    console.log(
      `本次frames[${Math.floor(frames.length / 2)}] 数据：`,
      JSON.stringify(frames[Math.floor(frames.length / 2)]),
    );
    console.log(
      `本次frames[${frames.length - 1}] 数据：`,
      JSON.stringify(frames[frames.length - 1]),
    );
    console.log(
      "本次frames时间戳跨度：",
      frames[0].t,
      "→",
      frames[frames.length - 1].t,
    );
    if (frames[0].points && frames[0].points.head) {
      console.log("首帧head值：", JSON.stringify(frames[0].points.head));
      console.log(
        "末帧head值：",
        JSON.stringify(frames[frames.length - 1].points.head),
      );
      const sameHead =
        JSON.stringify(frames[0].points.head) ===
        JSON.stringify(frames[frames.length - 1].points.head);
      console.log(
        sameHead
          ? "⚠️ 首尾帧head完全相同！数据可能没更新！"
          : "✅ 首尾帧head不同，数据在实时变化",
      );
    }

    wx.showLoading({ title: "AI分析中..." });
    try {
      const { callRemotePredict } = require("../../../utils/remote-predict");
      console.log(
        `\n\n========== 发送给 AI 的 ${frames.length} 帧内容 ==========`,
      );
      console.log("frames[0]:", JSON.stringify(frames[0]));
      if (frames.length > 1) {
        console.log(
          `frames[${frames.length - 1}]:`,
          JSON.stringify(frames[frames.length - 1]),
        );
      }
      console.log(`调用云函数，共 ${frames.length} 帧...`);
      const results = await callRemotePredict(frames, {
        sessionId: `test_${Date.now()}`,
        actionType: "skating_action",
      });
      wx.hideLoading();

      this.setData({ score: 0, comment: "", resultVisible: false });

      const firstResult = results[0] || {};
      const score = Math.round(Number(firstResult.quality_score || 0));
      const level =
        firstResult.quality_level || firstResult.average_lgb_level || "";
      const labelName =
        firstResult.label_name ||
        (firstResult.prediction && firstResult.prediction.label_name) ||
        "";
      const comment = level || labelName || "OK";
      const similarity = Math.round(Number(firstResult.quality_score || 0));
      const rawAdvice = String(firstResult.coaching_advice || "").trim();
      const advice =
        `本次识别动作为 ${labelName || "未知"}，综合质量评分 ${score}，等级为 ${level || "未知"}。` +
        (rawAdvice
          ? rawAdvice
          : "注意发力与回收节奏，优化动作细节，提升完成度。");
      console.log("真实分数：", score, "建议：", advice);

      this.setData({
        resultVisible: true,
        score,
        comment,
        level,
        similarity,
        advice,
      });
      this.addLog(`得分: ${score} (相似度: ${similarity}%)`);
      console.log("云函数返回 results:", JSON.stringify(results, null, 2));
    } catch (e) {
      wx.hideLoading();
      const msg = e.message || String(e);
      this.addLog("分析失败:" + msg.substring(0, 30));
      wx.showToast({ title: msg.substring(0, 15), icon: "none" });
    }
  },

  async onTapRelease() {
    await this.closeAll();
    this.setData({
      connectionStatus: "disconnected",
      deviceName: "",
      isCollecting: false,
      collectedFrames: 0,
    });
    this.addLog("已释放");
  },

  async closeAll() {
    try {
      if (this._deviceId) {
        try {
          await wx
            .notifyBLECharacteristicValueChange({
              deviceId: this._deviceId,
              serviceId: this._serviceId || DEFAULT_SERVICE_UUID,
              characteristicId: this._charId || DEFAULT_CHAR_UUID,
              state: false,
            })
            .catch(() => 0);
        } catch (e) {}
        try {
          await wx.closeBLEConnection({ deviceId: this._deviceId });
        } catch (e) {}
      }
      wx.offBLECharacteristicValueChange();
      wx.offBluetoothDeviceFound();
      try {
        await wx.closeBluetoothAdapter();
      } catch (e) {}
    } catch (e) {}

    this._deviceId = "";
    this._serviceId = "";
    this._charId = "";
    this._frames = [];
    this._notifyBuffer = "";
    this._collecting = false;
    this._adapterOpened = false;
  },

  async onUnload() {
    await this.closeAll();
  },

  ab2hex(buffer) {
    const arr = Array.prototype.map.call(new Uint8Array(buffer), (x) =>
      ("00" + x.toString(16)).slice(-2),
    );
    return arr.join(" ");
  },

  ab2str(buffer) {
    try {
      return String.fromCharCode.apply(null, new Uint8Array(buffer));
    } catch (e) {
      let s = "";
      const a = new Uint8Array(buffer);
      for (let i = 0; i < a.length; i++) {
        if (a[i] >= 10 && a[i] <= 127) s += String.fromCharCode(a[i]);
      }
      return s;
    }
  },

  delay(ms) {
    return new Promise((r) => setTimeout(r, Math.max(10, ms)));
  },
});
