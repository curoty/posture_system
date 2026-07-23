const QRCodeUtil = require('../../../utils/qrcode.js');

Page({
  data: {
    classCode: '',
    coachName: '',
    qrCodeTempUrl: '',
    studentCount: 0,
    loading: false,
    hasInvitation: false,
    codeCopied: false,
  },

  onLoad() {
    this.loadInvitation();
  },

  onShow() {
    this.loadInvitation();
  },

  initCloud() {
    if (!wx.cloud) return false;
    wx.cloud.init({
      env: getApp().globalData.env,
      traceUser: true,
    });
    return true;
  },

  getCurrentUserId() {
    const userInfo = wx.getStorageSync('userInfo') || {};
    return String(userInfo.id || userInfo._id || '').trim();
  },

  loadInvitation() {
    if (!this.initCloud()) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' });
      return;
    }
    this.setData({ loading: true });

    const userId = this.getCurrentUserId();
    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'getCoachClassInvitation',
        userId,
        preferUserId: true,
        expectedRole: 'coach_or_admin',
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || 'get_invitation_failed');
        }
        const data = result.data;
        if (data && data.classCode) {
          this.setData({
            hasInvitation: true,
            classCode: data.classCode,
            coachName: data.coachName || '',
            studentCount: data.studentCount || 0,
          });
          setTimeout(() => {
            this.generateQRCode(data.classCode);
          }, 200);
        } else {
          this.setData({ hasInvitation: false });
        }
      })
      .catch((err) => {
        console.error('load invitation failed:', err);
        this.setData({ hasInvitation: false });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onGenerateCode() {
    if (!this.initCloud()) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '生成中...', mask: true });
    const userId = this.getCurrentUserId();

    wx.cloud.callFunction({
      name: 'quickstartFunctions',
      data: {
        type: 'generateClassCode',
        userId,
        preferUserId: true,
        expectedRole: 'coach_or_admin',
        forceRegenerate: true,
      },
    })
      .then((res) => {
        const result = res && res.result ? res.result : {};
        if (!result.success) {
          throw new Error(result.message || 'generate_class_code_failed');
        }
        const data = result.data || {};
        this.setData({
          hasInvitation: true,
          classCode: data.classCode || '',
          coachName: data.coachName || '',
          studentCount: 0,
          codeCopied: false,
        });
        setTimeout(() => {
          this.generateQRCode(data.classCode);
        }, 200);
        wx.showToast({ title: '生成成功', icon: 'success' });
      })
      .catch((err) => {
        console.error('generate class code failed:', err);
        wx.showToast({ title: '生成失败，请重试', icon: 'none' });
      })
      .finally(() => {
        wx.hideLoading();
      });
  },

  generateQRCode(classCode) {
    if (!classCode) return;

    const sysInfo = wx.getSystemInfoSync();
    const pixelRatio = sysInfo.pixelRatio || 2;
    const canvasWidth = 300 * pixelRatio;
    const canvasHeight = 300 * pixelRatio;

    const qrContent = classCode;
    
    try {
      const offscreenCanvas = wx.createOffscreenCanvas({
        type: '2d',
        width: canvasWidth,
        height: canvasHeight
      });
      const ctx = offscreenCanvas.getContext('2d');

      const qrCode = this.createQRCode(qrContent, 'H');
      const moduleCount = qrCode.getModuleCount();
      const margin = Math.floor(canvasWidth * 0.08);
      const cellSize = (canvasWidth - margin * 2) / moduleCount;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = '#000000';

      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qrCode.isDark(row, col)) {
            ctx.fillRect(
              Math.round(col * cellSize + margin),
              Math.round(row * cellSize + margin),
              Math.round(cellSize),
              Math.round(cellSize)
            );
          }
        }
      }

      const tempFilePath = offscreenCanvas.toDataURL('image/png');
      this.setData({ qrCodeTempUrl: tempFilePath });

    } catch (err) {
      console.error('generate qrcode failed:', err);
      this.generateQRCodeFallback(classCode);
    }
  },

  generateQRCodeFallback(classCode) {
    if (!classCode) return;

    const logicalSize = 300;

    const qrContent = classCode;
    
    try {
      const qrCode = this.createQRCode(qrContent, 'H');
      const moduleCount = qrCode.getModuleCount();
      const margin = Math.floor(logicalSize * 0.08);
      const cellSize = (logicalSize - margin * 2) / moduleCount;

      const ctx = wx.createCanvasContext('qrCodeCanvas');
      
      ctx.setFillStyle('#ffffff');
      ctx.fillRect(0, 0, logicalSize, logicalSize);
      
      ctx.setFillStyle('#000000');
      
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qrCode.isDark(row, col)) {
            ctx.fillRect(
              Math.round(col * cellSize + margin),
              Math.round(row * cellSize + margin),
              Math.round(cellSize),
              Math.round(cellSize)
            );
          }
        }
      }
      
      ctx.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: 'qrCodeCanvas',
          success: (res) => {
            this.setData({ qrCodeTempUrl: res.tempFilePath });
          },
          fail: (err) => {
            console.error('canvasToTempFilePath failed:', err);
            wx.showToast({ title: '二维码生成失败', icon: 'none' });
          }
        });
      });

    } catch (err) {
      console.error('generate qrcode fallback failed:', err);
      wx.showToast({ title: '二维码生成失败', icon: 'none' });
    }
  },

  createQRCode(data, errorCorrectionLevel) {
    const QR8bitByte = function(d) {
      this.mode = 4;
      this.data = d;
      this.getLength = function() { return d.length; };
      this.write = function(buf) {
        for (let i = 0; i < d.length; i++) {
          buf.put(d.charCodeAt(i), 8);
        }
      };
    };

    const QRBitBuffer = function() {
      this.buffer = [];
      this.length = 0;
      this.get = function(idx) {
        const bufIdx = Math.floor(idx / 8);
        return ((this.buffer[bufIdx] >>> (7 - idx % 8)) & 1) == 1;
      };
      this.put = function(num, len) {
        for (let i = 0; i < len; i++) {
          this.putBit(((num >>> (len - i - 1)) & 1) == 1);
        }
      };
      this.putBit = function(bit) {
        const bufIdx = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIdx) this.buffer.push(0);
        if (bit) this.buffer[bufIdx] |= (0x80 >>> (this.length % 8));
        this.length++;
      };
      this.getLengthInBits = function() { return this.length; };
    };

    const EXP_TABLE = new Array(256);
    const LOG_TABLE = new Array(256);
    for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
    for (let i = 8; i < 256; i++) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
    for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

    const QRMath = {
      glog: function(n) { return LOG_TABLE[n]; },
      gexp: function(n) {
        while (n < 0) n += 255;
        while (n >= 256) n -= 255;
        return EXP_TABLE[n];
      }
    };

    const QRPolynomial = function(num, shift) {
      let offset = 0;
      while (offset < num.length && num[offset] == 0) offset++;
      this.num = new Array(num.length - offset + shift);
      for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
      this.get = function(idx) { return this.num[idx]; };
      this.getLength = function() { return this.num.length; };
      this.multiply = function(e) {
        const num = new Array(this.getLength() + e.getLength() - 1);
        for (let i = 0; i < this.getLength(); i++) {
          for (let j = 0; j < e.getLength(); j++) {
            num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
          }
        }
        return new QRPolynomial(num, 0);
      };
      this.mod = function(e) {
        if (this.getLength() - e.getLength() < 0) return this;
        const ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
        const num = new Array(this.getLength());
        for (let i = 0; i < this.getLength(); i++) num[i] = this.get(i);
        for (let i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
        return new QRPolynomial(num, 0).mod(e);
      };
    };

    const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);

    const QRUtil = {
      getBCHTypeInfo: function(data) {
        let d = data << 10;
        while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(G15) >= 0) {
          d ^= (G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(G15)));
        }
        return ((data << 10) | d) ^ 0x5412;
      },
      getBCHTypeNumber: function(data) {
        let d = data << 12;
        while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(G18) >= 0) {
          d ^= (G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(G18)));
        }
        return (data << 12) | d;
      },
      getBCHDigit: function(data) {
        let digit = 0;
        while (data != 0) { digit++; data >>>= 1; }
        return digit;
      },
      getErrorCorrectPolynomial: function(length) {
        let a = new QRPolynomial([1], 0);
        for (let i = 0; i < length; i++) {
          a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
        }
        return a;
      },
      getLengthInBits: function(mode, type) {
        if (type < 10) return { 1: 10, 2: 9, 4: 8, 8: 8 }[mode];
        if (type < 27) return { 1: 12, 2: 11, 4: 16, 8: 10 }[mode];
        return { 1: 14, 2: 13, 4: 16, 8: 12 }[mode];
      }
    };

    const QRRSBlock = {
      getRSBlocks: function(typeNumber, errorCorrectionLevel) {
        const EC_LEVEL = { L: 1, M: 0, Q: 3, H: 2 };
        const RS_BLOCK_TABLE = [
          [{count:1,data:19,total:26}],[{count:1,data:16,total:26}],[{count:1,data:13,total:26}],[{count:1,data:9,total:26}],
          [{count:1,data:34,total:44}],[{count:1,data:28,total:44}],[{count:1,data:22,total:44}],[{count:1,data:16,total:44}],
          [{count:1,data:55,total:70}],[{count:1,data:44,total:70}],[{count:1,data:34,total:70}],[{count:1,data:26,total:70}],
          [{count:1,data:80,total:100}],[{count:1,data:64,total:100}],[{count:1,data:48,total:100}],[{count:1,data:36,total:100}],
          [{count:1,data:108,total:134}],[{count:1,data:86,total:134}],[{count:1,data:64,total:134}],[{count:1,data:48,total:134}]
        ];
        const rsBlock = RS_BLOCK_TABLE[(typeNumber - 1) * 4 + EC_LEVEL[errorCorrectionLevel]];
        const list = [];
        for (let i = 0; i < rsBlock.length; i++) {
          for (let j = 0; j < rsBlock[i].count; j++) {
            list.push({ totalCount: rsBlock[i].total, dataCount: rsBlock[i].data });
          }
        }
        return list;
      }
    };

    const QRCode = function(typeNumber, errorCorrectionLevel) {
      this.typeNumber = typeNumber;
      this.errorCorrectionLevel = errorCorrectionLevel;
      this.dataList = [];
      this.addData = function(d) { this.dataList.push(new QR8bitByte(d)); };
      this.make = function() {
        const rsBlocks = QRRSBlock.getRSBlocks(this.typeNumber, this.errorCorrectionLevel);
        const buffer = new QRBitBuffer();
        for (let i = 0; i < this.dataList.length; i++) {
          const d = this.dataList[i];
          buffer.put(d.mode, 4);
          buffer.put(d.getLength(), QRUtil.getLengthInBits(d.mode, this.typeNumber));
          d.write(buffer);
        }
        let totalCount = 0;
        for (let i = 0; i < rsBlocks.length; i++) totalCount += rsBlocks[i].totalCount;
        while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false);
        while (buffer.getLengthInBits() < totalCount * 8) {
          buffer.put(0xec, 8);
          if (buffer.getLengthInBits() < totalCount * 8) buffer.put(0x11, 8);
        }
        const data = QRUtil.makeErrorCorrection(buffer, rsBlocks);
        this.mapData(data);
      };
      QRUtil.makeErrorCorrection = function(buffer, rsBlocks) {
        const dcdata = [];
        const ecdata = [];
        let offset = 0;
        for (let r = 0; r < rsBlocks.length; r++) {
          const dcCount = rsBlocks[r].dataCount;
          const ecCount = rsBlocks[r].totalCount - dcCount;
          dcdata[r] = [];
          for (let i = 0; i < dcCount; i++) dcdata[r][i] = 0xff & buffer.buffer[offset + i];
          offset += dcCount;
          const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
          const rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
          const modPoly = rawPoly.mod(rsPoly);
          ecdata[r] = [];
          for (let i = 0; i < ecdata[r].length; i++) {
            const modIdx = i + modPoly.getLength() - ecdata[r].length;
            ecdata[r][i] = modIdx >= 0 ? modPoly.get(modIdx) : 0;
          }
        }
        const result = [];
        let maxDc = 0, maxEc = 0;
        for (let r = 0; r < rsBlocks.length; r++) { maxDc = Math.max(maxDc, dcdata[r].length); maxEc = Math.max(maxEc, ecdata[r].length); }
        for (let i = 0; i < maxDc; i++) for (let r = 0; r < rsBlocks.length; r++) if (i < dcdata[r].length) result.push(dcdata[r][i]);
        for (let i = 0; i < maxEc; i++) for (let r = 0; r < rsBlocks.length; r++) if (i < ecdata[r].length) result.push(ecdata[r][i]);
        return result;
      };
      this.mapData = function(data) {
        this.moduleCount = this.typeNumber * 4 + 17;
        this.modules = new Array(this.moduleCount);
        for (let row = 0; row < this.moduleCount; row++) {
          this.modules[row] = new Array(this.moduleCount);
          for (let col = 0; col < this.moduleCount; col++) this.modules[row][col] = null;
        }
        this.setupPositionProbePattern(0, 0);
        this.setupPositionProbePattern(this.moduleCount - 7, 0);
        this.setupPositionProbePattern(0, this.moduleCount - 7);
        this.setupPositionAdjustPattern();
        this.setupTimingPattern();
        this.setupTypeNumber();
        this.setupTypeInfo();
        this.mapCodeData(data);
      };
      this.setupPositionProbePattern = function(row, col) {
        for (let r = -1; r <= 7; r++) {
          for (let c = -1; c <= 7; c++) {
            if (row + r < 0 || row + r >= this.moduleCount || col + c < 0 || col + c >= this.moduleCount) continue;
            if ((0 <= r && r <= 6 && (c == 0 || c == 6)) || (0 <= c && c <= 6 && (r == 0 || r == 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
              this.modules[row + r][col + c] = true;
            } else {
              this.modules[row + r][col + c] = false;
            }
          }
        }
      };
      this.setupPositionAdjustPattern = function() {
        const PATTERN_POSITION_TABLE = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
        const pos = PATTERN_POSITION_TABLE[this.typeNumber - 1] || [];
        for (let i = 0; i < pos.length; i++) {
          for (let j = 0; j < pos.length; j++) {
            const row = pos[i], col = pos[j];
            if (this.modules[row][col] != null) continue;
            for (let r = -2; r <= 2; r++) {
              for (let c = -2; c <= 2; c++) {
                this.modules[row + r][col + c] = (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0));
              }
            }
          }
        }
      };
      this.setupTimingPattern = function() {
        for (let r = 8; r < this.moduleCount - 8; r++) if (this.modules[r][6] == null) this.modules[r][6] = (r % 2 == 0);
        for (let c = 8; c < this.moduleCount - 8; c++) if (this.modules[6][c] == null) this.modules[6][c] = (c % 2 == 0);
      };
      this.setupTypeNumber = function() {
        const bits = QRUtil.getBCHTypeNumber(this.typeNumber);
        for (let i = 0; i < 18; i++) {
          const mod = ((bits >> i) & 1) == 1;
          this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
          this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
        }
      };
      this.setupTypeInfo = function() {
        const EC_LEVEL = { L: 1, M: 0, Q: 3, H: 2 };
        const data = (0x5412 << 10) | QRUtil.getBCHTypeInfo(EC_LEVEL[this.errorCorrectionLevel]);
        for (let i = 0; i < 15; i++) {
          const mod = ((data >> i) & 1) == 1;
          if (i < 6) this.modules[i][8] = mod;
          else if (i < 8) this.modules[i + 1][8] = mod;
          else this.modules[this.moduleCount - 15 + i][8] = mod;
          if (i < 8) this.modules[8][this.moduleCount - 1 - i] = mod;
          else this.modules[8][15 - i - 1 + 1] = mod;
        }
        this.modules[this.moduleCount - 8][8] = true;
      };
      this.mapCodeData = function(data) {
        let inc = -1, row = this.moduleCount - 1, bitIdx = 7, byteIdx = 0;
        for (let col = this.moduleCount - 1; col > 0; col -= 2) {
          if (col == 6) col--;
          while (true) {
            for (let c = 0; c < 2; c++) {
              if (this.modules[row][col - c] == null) {
                let dark = false;
                if (byteIdx < data.length) dark = (((data[byteIdx] >>> bitIdx) & 1) == 1);
                if (((row + col - c) % 2 + ((row * (col - c)) % 3)) % 2 == 0) dark = !dark;
                this.modules[row][col - c] = dark;
                bitIdx--;
                if (bitIdx == -1) { byteIdx++; bitIdx = 7; }
              }
            }
            row += inc;
            if (row < 0 || row >= this.moduleCount) { row -= inc; inc = -inc; break; }
          }
        }
      };
      this.isDark = function(row, col) { return this.modules[row][col]; };
      this.getModuleCount = function() { return this.moduleCount; };
    };

    for (let typeNumber = 1; typeNumber <= 10; typeNumber++) {
      const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
      let totalDataCount = 0;
      for (let i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
      const buffer = new QRBitBuffer();
      const testData = new QR8bitByte(data);
      buffer.put(testData.mode, 4);
      buffer.put(testData.getLength(), QRUtil.getLengthInBits(testData.mode, typeNumber));
      testData.write(buffer);
      if (buffer.getLengthInBits() <= totalDataCount * 8) {
        const qrCode = new QRCode(typeNumber, errorCorrectionLevel);
        qrCode.addData(data);
        qrCode.make();
        return qrCode;
      }
    }
    throw new Error('Too much data');
  },

  onPreviewQRCode() {
    const tempUrl = this.data.qrCodeTempUrl;
    if (!tempUrl) {
      wx.showToast({ title: '二维码生成中', icon: 'none' });
      return;
    }
    wx.previewImage({
      urls: [tempUrl],
      current: tempUrl,
    });
  },

  onCopyCode() {
    const code = this.data.classCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => {
        this.setData({ codeCopied: true });
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' });
        setTimeout(() => {
          this.setData({ codeCopied: false });
        }, 3000);
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' });
      },
    });
  },

  onShareAppMessage() {
    const code = this.data.classCode;
    const coachName = this.data.coachName || '教练';
    return {
      title: `${coachName}邀请你加入轮滑班级`,
      path: `/pages/student/join-class/join-class?code=${code}`,
    };
  },
});
