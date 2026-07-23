var QR8bitByte = function (data) {
  this.mode = QRMode.MODE_8BIT_BYTE;
  this.data = data;
};

QR8bitByte.prototype = {
  getLength: function (buffer) {
    return buffer.length;
  },
  write: function (buffer) {
    for (var i = 0; i < this.data.length; i++) {
      buffer.put(this.data.charCodeAt(i), 8);
    }
  }
};

var QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3
};

var QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
};

var QRUtil = {
  getBCHTypeInfo: function (data) {
    var d = data << 10;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRConstants.G15) >= 0) {
      d ^= (QRConstants.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRConstants.G15)));
    }
    return ((data << 10) | d) ^ QRConstants.MASK_PATTERN;
  },
  getBCHTypeNumber: function (data) {
    var d = data << 12;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRConstants.G18) >= 0) {
      d ^= (QRConstants.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRConstants.G18)));
    }
    return (data << 12) | d;
  },
  getBCHDigit: function (data) {
    var digit = 0;
    while (data != 0) {
      digit++;
      data >>>= 1;
    }
    return digit;
  },
  patternPosition: function (typeNumber) {
    return QRConstants.PATTERN_POSITION_TABLE[typeNumber - 1];
  },
  getMask: function (maskPattern, i, j) {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000: return (i + j) % 2 == 0;
      case QRMaskPattern.PATTERN001: return i % 2 == 0;
      case QRMaskPattern.PATTERN010: return j % 3 == 0;
      case QRMaskPattern.PATTERN011: return (i + j) % 3 == 0;
      case QRMaskPattern.PATTERN100: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
      case QRMaskPattern.PATTERN101: return (i * j) % 2 + (i * j) % 3 == 0;
      case QRMaskPattern.PATTERN110: return ((i * j) % 2 + (i * j) % 3) % 2 == 0;
      case QRMaskPattern.PATTERN111: return ((i * j) % 3 + (i + j) % 2) % 2 == 0;
      default: throw new Error("bad maskPattern:" + maskPattern);
    }
  },
  makeErrorCorrection: function (data, rsBlock) {
    var offset = 0;
    var maxDcCount = 0;
    var maxEcCount = 0;
    var dcdata = new Array(rsBlock.length);
    var ecdata = new Array(rsBlock.length);
    for (var r = 0; r < rsBlock.length; r++) {
      var dcCount = rsBlock[r].dataCount;
      var ecCount = rsBlock[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (var i = 0; i < dcdata[r].length; i++) {
        dcdata[r][i] = 0xff & data.get(offset + i);
      }
      offset += dcCount;
      var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
      var modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (var i = 0; i < ecdata[r].length; i++) {
        var modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
      }
    }
    var totalCount = 0;
    for (var i = 0; i < rsBlock.length; i++) {
      totalCount += rsBlock[i].totalCount;
    }
    var data = [];
    var index = 0;
    for (var i = 0; i < maxDcCount; i++) {
      for (var r = 0; r < rsBlock.length; r++) {
        if (i < dcdata[r].length) {
          data[index++] = dcdata[r][i];
        }
      }
    }
    for (var i = 0; i < maxEcCount; i++) {
      for (var r = 0; r < rsBlock.length; r++) {
        if (i < ecdata[r].length) {
          data[index++] = ecdata[r][i];
        }
      }
    }
    return data;
  },
  getErrorCorrectPolynomial: function (errorCorrectLength) {
    var a = new QRPolynomial([1], 0);
    for (var i = 0; i < errorCorrectLength; i++) {
      a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  },
  getLengthInBits: function (mode, type) {
    if (1 <= type && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER: return 10;
        case QRMode.MODE_ALPHA_NUM: return 9;
        case QRMode.MODE_8BIT_BYTE: return 8;
        case QRMode.MODE_KANJI: return 8;
        default: throw new Error("mode:" + mode);
      }
    } else if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER: return 12;
        case QRMode.MODE_ALPHA_NUM: return 11;
        case QRMode.MODE_8BIT_BYTE: return 16;
        case QRMode.MODE_KANJI: return 10;
        default: throw new Error("mode:" + mode);
      }
    } else if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER: return 14;
        case QRMode.MODE_ALPHA_NUM: return 13;
        case QRMode.MODE_8BIT_BYTE: return 16;
        case QRMode.MODE_KANJI: return 12;
        default: throw new Error("mode:" + mode);
      }
    } else {
      throw new Error("type:" + type);
    }
  },
  getQRCode: function (typeNumber, errorCorrectionLevel, dataList) {
    var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
    var buffer = new QRBitBuffer();
    for (var i = 0; i < dataList.length; i++) {
      var data = dataList[i];
      buffer.put(data.mode, 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
      data.write(buffer);
    }
    var totalCount = 0;
    for (var i = 0; i < rsBlocks.length; i++) {
      totalCount += rsBlocks[i].totalCount;
    }
    if (buffer.getLengthInBits() > totalCount * 8) {
      throw new Error("code length overflow. (" + buffer.getLengthInBits() + ">" + totalCount * 8 + ")");
    }
    if (buffer.getLengthInBits() + 4 <= totalCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 != 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalCount * 8) break;
      buffer.put(0xec, 8);
      if (buffer.getLengthInBits() >= totalCount * 8) break;
      buffer.put(0x11, 8);
    }
    return QRUtil.makeErrorCorrection(buffer, rsBlocks);
  },
  getMinimumQRCode: function (dataList, errorCorrectionLevel) {
    for (var typeNumber = 1; typeNumber <= 40; typeNumber++) {
      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
      var totalCount = 0;
      for (var i = 0; i < rsBlocks.length; i++) {
        totalCount += rsBlocks[i].dataCount;
      }
      var buffer = new QRBitBuffer();
      for (var i = 0; i < dataList.length; i++) {
        var data = dataList[i];
        buffer.put(data.mode, 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
        data.write(buffer);
      }
      if (buffer.getLengthInBits() <= totalCount * 8) {
        return { typeNumber: typeNumber, rsBlocks: rsBlocks, data: QRUtil.getQRCode(typeNumber, errorCorrectionLevel, dataList) };
      }
    }
    throw new Error("Too much data");
  }
};

var QRMath = {
  glog: function (n) {
    if (n < 1) throw new Error("glog(" + n + ")");
    return QRConstants.LOG_TABLE[n];
  },
  gexp: function (n) {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return QRConstants.EXP_TABLE[n];
  }
};

var QRConstants = {
  EXP_TABLE: new Array(256),
  LOG_TABLE: new Array(256),
  G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
  G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
  G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
  PATTERN_POSITION_TABLE: [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 30, 54, 78, 102, 122],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ],
  RS_BLOCK_TABLE: [
    { typeNumber: 1, errorCorrectionLevel: 'L', blocks: [{ count: 1, dataCount: 19, totalCount: 26 }] },
    { typeNumber: 1, errorCorrectionLevel: 'M', blocks: [{ count: 1, dataCount: 16, totalCount: 26 }] },
    { typeNumber: 1, errorCorrectionLevel: 'Q', blocks: [{ count: 1, dataCount: 13, totalCount: 26 }] },
    { typeNumber: 1, errorCorrectionLevel: 'H', blocks: [{ count: 1, dataCount: 9, totalCount: 26 }] },
    { typeNumber: 2, errorCorrectionLevel: 'L', blocks: [{ count: 1, dataCount: 34, totalCount: 44 }] },
    { typeNumber: 2, errorCorrectionLevel: 'M', blocks: [{ count: 1, dataCount: 28, totalCount: 44 }] },
    { typeNumber: 2, errorCorrectionLevel: 'Q', blocks: [{ count: 1, dataCount: 22, totalCount: 44 }] },
    { typeNumber: 2, errorCorrectionLevel: 'H', blocks: [{ count: 1, dataCount: 16, totalCount: 44 }] },
    { typeNumber: 3, errorCorrectionLevel: 'L', blocks: [{ count: 1, dataCount: 55, totalCount: 70 }] },
    { typeNumber: 3, errorCorrectionLevel: 'M', blocks: [{ count: 1, dataCount: 44, totalCount: 70 }] },
    { typeNumber: 3, errorCorrectionLevel: 'Q', blocks: [{ count: 1, dataCount: 34, totalCount: 70 }] },
    { typeNumber: 3, errorCorrectionLevel: 'H', blocks: [{ count: 1, dataCount: 26, totalCount: 70 }] },
    { typeNumber: 4, errorCorrectionLevel: 'L', blocks: [{ count: 1, dataCount: 80, totalCount: 100 }] },
    { typeNumber: 4, errorCorrectionLevel: 'M', blocks: [{ count: 1, dataCount: 64, totalCount: 100 }] },
    { typeNumber: 4, errorCorrectionLevel: 'Q', blocks: [{ count: 1, dataCount: 48, totalCount: 100 }] },
    { typeNumber: 4, errorCorrectionLevel: 'H', blocks: [{ count: 1, dataCount: 36, totalCount: 100 }] },
    { typeNumber: 5, errorCorrectionLevel: 'L', blocks: [{ count: 1, dataCount: 108, totalCount: 134 }] },
    { typeNumber: 5, errorCorrectionLevel: 'M', blocks: [{ count: 1, dataCount: 86, totalCount: 134 }] },
    { typeNumber: 5, errorCorrectionLevel: 'Q', blocks: [{ count: 1, dataCount: 64, totalCount: 134 }] },
    { typeNumber: 5, errorCorrectionLevel: 'H', blocks: [{ count: 1, dataCount: 48, totalCount: 134 }] }
  ],
  MASK_PATTERN: 0x5412
};

for (var i = 0; i < 8; i++) QRConstants.EXP_TABLE[i] = 1 << i;
for (var i = 8; i < 256; i++) QRConstants.EXP_TABLE[i] = QRConstants.EXP_TABLE[i - 4] ^ QRConstants.EXP_TABLE[i - 5] ^ QRConstants.EXP_TABLE[i - 6] ^ QRConstants.EXP_TABLE[i - 8];
for (var i = 0; i < 255; i++) QRConstants.LOG_TABLE[QRConstants.EXP_TABLE[i]] = i;

var QRPolynomial = function (num, shift) {
  if (num.length == undefined) throw new Error(num.length + "/" + shift);
  var offset = 0;
  while (offset < num.length && num[offset] == 0) offset++;
  this.num = new Array(num.length - offset + shift);
  for (var i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
};

QRPolynomial.prototype = {
  get: function (index) { return this.num[index]; },
  getLength: function () { return this.num.length; },
  multiply: function (e) {
    var num = new Array(this.getLength() + e.getLength() - 1);
    for (var i = 0; i < this.getLength(); i++) {
      for (var j = 0; j < e.getLength(); j++) {
        num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
      }
    }
    return new QRPolynomial(num, 0);
  },
  mod: function (e) {
    if (this.getLength() - e.getLength() < 0) return this;
    var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
    var num = new Array(this.getLength());
    for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
    for (var i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
    return new QRPolynomial(num, 0).mod(e);
  }
};

var QRBitBuffer = function () {
  this.buffer = [];
  this.length = 0;
};

QRBitBuffer.prototype = {
  get: function (index) {
    var bufIndex = Math.floor(index / 8);
    return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) == 1;
  },
  put: function (num, length) {
    for (var i = 0; i < length; i++) {
      this.putBit(((num >>> (length - i - 1)) & 1) == 1);
    }
  },
  getLengthInBits: function () { return this.length; },
  putBit: function (bit) {
    var bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
    this.length++;
  }
};

var QRRSBlock = {
  getRSBlocks: function (typeNumber, errorCorrectionLevel) {
    var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (rsBlock == undefined) throw new Error("bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel);
    var length = rsBlock.blocks.length;
    var list = [];
    for (var i = 0; i < length; i++) {
      var count = rsBlock.blocks[i].count;
      var totalCount = rsBlock.blocks[i].totalCount;
      var dataCount = rsBlock.blocks[i].dataCount;
      for (var j = 0; j < count; j++) {
        list.push(new QRRSBlock(totalCount, dataCount));
      }
    }
    return list;
  },
  getRsBlockTable: function (typeNumber, errorCorrectionLevel) {
    for (var i = 0; i < QRConstants.RS_BLOCK_TABLE.length; i++) {
      var rsBlock = QRConstants.RS_BLOCK_TABLE[i];
      if (rsBlock.typeNumber == typeNumber && rsBlock.errorCorrectionLevel == errorCorrectionLevel) {
        return rsBlock;
      }
    }
    var rsBlock = {
      typeNumber: typeNumber,
      errorCorrectionLevel: errorCorrectionLevel,
      blocks: [{ count: 1, dataCount: 0, totalCount: 0 }]
    };
    var totalCount = (typeNumber - 1) * 4 + 21;
    var ecCount = QRRSBlock.getErrorCorrectionCount(typeNumber, errorCorrectionLevel);
    var dataCount = totalCount * totalCount - ecCount * (totalCount + 7) / 2;
    if (dataCount < 0) dataCount = 0;
    rsBlock.blocks[0].totalCount = Math.floor(dataCount / 8);
    rsBlock.blocks[0].dataCount = rsBlock.blocks[0].totalCount - ecCount;
    return rsBlock;
  },
  getErrorCorrectionCount: function (typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case 'L': return Math.floor((typeNumber * 4 + 7) / 2);
      case 'M': return typeNumber * 4 + 7;
      case 'Q': return Math.floor((typeNumber * 8 + 13) / 2);
      case 'H': return typeNumber * 8 + 13;
      default: throw new Error("errorCorrectionLevel:" + errorCorrectionLevel);
    }
  }
};

var QRRSBlock = function (totalCount, dataCount) {
  this.totalCount = totalCount;
  this.dataCount = dataCount;
};

var QRCode = function (typeNumber, errorCorrectionLevel) {
  this.typeNumber = typeNumber;
  this.errorCorrectionLevel = errorCorrectionLevel;
  this.modules = null;
  this.moduleCount = 0;
  this.dataCache = null;
  this.dataList = [];
};

QRCode.prototype = {
  addData: function (data) {
    this.dataList.push(new QR8bitByte(data));
    this.dataCache = null;
  },
  isDark: function (row, col) {
    if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) throw new Error(row + "," + col);
    return this.modules[row][col];
  },
  getModuleCount: function () { return this.moduleCount; },
  make: function () {
    this.makeImpl(false, this.getBestMaskPattern());
  },
  makeImpl: function (test, maskPattern) {
    this.moduleCount = this.typeNumber * 4 + 17;
    this.modules = new Array(this.moduleCount);
    for (var row = 0; row < this.moduleCount; row++) {
      this.modules[row] = new Array(this.moduleCount);
      for (var col = 0; col < this.moduleCount; col++) {
        this.modules[row][col] = null;
      }
    }
    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(this.moduleCount - 7, 0);
    this.setupPositionProbePattern(0, this.moduleCount - 7);
    this.setupPositionAdjustPattern();
    this.setupTimingPattern();
    this.setupTypeNumber(test);
    if (test == false) this.setupTypeInfo(test, maskPattern);
    if (this.dataCache == null) {
      this.dataCache = QRUtil.getQRCode(this.typeNumber, this.errorCorrectionLevel, this.dataList);
    }
    this.mapData(this.dataCache, maskPattern);
  },
  setupPositionProbePattern: function (row, col) {
    for (var r = -1; r <= 7; r++) {
      if (row + r <= -1 || this.moduleCount <= row + r) continue;
      for (var c = -1; c <= 7; c++) {
        if (col + c <= -1 || this.moduleCount <= col + c) continue;
        if ((0 <= r && r <= 6 && (c == 0 || c == 6)) || (0 <= c && c <= 6 && (r == 0 || r == 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
          this.modules[row + r][col + c] = true;
        } else {
          this.modules[row + r][col + c] = false;
        }
      }
    }
  },
  getBestMaskPattern: function () {
    var minLostPoint = 0;
    var pattern = 0;
    for (var i = 0; i < 8; i++) {
      this.makeImpl(true, i);
      var lostPoint = QRUtil.getLostPoint(this);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  },
  setupTimingPattern: function () {
    for (var r = 8; r < this.moduleCount - 8; r++) {
      if (this.modules[r][6] != null) continue;
      this.modules[r][6] = (r % 2 == 0);
    }
    for (var c = 8; c < this.moduleCount - 8; c++) {
      if (this.modules[6][c] != null) continue;
      this.modules[6][c] = (c % 2 == 0);
    }
  },
  setupPositionAdjustPattern: function () {
    var pos = QRUtil.patternPosition(this.typeNumber);
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var row = pos[i];
        var col = pos[j];
        if (this.modules[row][col] != null) continue;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            if (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0)) {
              this.modules[row + r][col + c] = true;
            } else {
              this.modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  },
  setupTypeNumber: function (test) {
    var bits = QRUtil.getBCHTypeNumber(this.typeNumber);
    for (var i = 0; i < 18; i++) {
      var mod = (!test && ((bits >> i) & 1) == 1);
      this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
    }
    for (var i = 0; i < 18; i++) {
      var mod = (!test && ((bits >> i) & 1) == 1);
      this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  },
  setupTypeInfo: function (test, maskPattern) {
    var data = (QRConstants.MASK_PATTERN << 10) | QRUtil.getBCHTypeInfo(maskPattern);
    for (var i = 0; i < 15; i++) {
      var mod = (!test && ((data >> i) & 1) == 1);
      if (i < 6) {
        this.modules[i][8] = mod;
      } else if (i < 8) {
        this.modules[i + 1][8] = mod;
      } else {
        this.modules[this.moduleCount - 15 + i][8] = mod;
      }
    }
    for (var i = 0; i < 15; i++) {
      var mod = (!test && ((data >> i) & 1) == 1);
      if (i < 8) {
        this.modules[8][this.moduleCount - 1 - i] = mod;
      } else {
        this.modules[8][15 - i - 1 + 1] = mod;
      }
    }
    this.modules[this.moduleCount - 8][8] = (!test);
  },
  mapData: function (data, maskPattern) {
    var inc = -1;
    var row = this.moduleCount - 1;
    var bitIndex = 7;
    var byteIndex = 0;
    for (var col = this.moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col--;
      while (true) {
        for (var c = 0; c < 2; c++) {
          if (this.modules[row][col - c] == null) {
            var dark = false;
            if (byteIndex < data.length) {
              dark = (((data[byteIndex] >>> bitIndex) & 1) == 1);
            }
            if (QRUtil.getMask(maskPattern, row, col - c)) {
              dark = !dark;
            }
            this.modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex == -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || this.moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }
};

QRUtil.getLostPoint = function (qrCode) {
  var moduleCount = qrCode.getModuleCount();
  var lostPoint = 0;
  for (var row = 0; row < moduleCount; row++) {
    for (var col = 0; col < moduleCount; col++) {
      var sameCount = 0;
      var dark = qrCode.isDark(row, col);
      for (var r = -1; r <= 1; r++) {
        if (row + r < 0 || moduleCount <= row + r) continue;
        for (var c = -1; c <= 1; c++) {
          if (col + c < 0 || moduleCount <= col + c) continue;
          if (r == 0 && c == 0) continue;
          if (dark == qrCode.isDark(row + r, col + c)) sameCount++;
        }
      }
      if (sameCount > 5) lostPoint += (3 + sameCount - 5);
    }
  }
  for (var row = 0; row < moduleCount - 1; row++) {
    for (var col = 0; col < moduleCount - 1; col++) {
      var count = 0;
      if (qrCode.isDark(row, col)) count++;
      if (qrCode.isDark(row + 1, col)) count++;
      if (qrCode.isDark(row, col + 1)) count++;
      if (qrCode.isDark(row + 1, col + 1)) count++;
      if (count == 0 || count == 4) lostPoint += 3;
    }
  }
  for (var row = 0; row < moduleCount; row++) {
    for (var col = 0; col < moduleCount - 6; col++) {
      if (qrCode.isDark(row, col) && !qrCode.isDark(row, col + 1) && qrCode.isDark(row, col + 2) && qrCode.isDark(row, col + 3) && qrCode.isDark(row, col + 4) && !qrCode.isDark(row, col + 5) && qrCode.isDark(row, col + 6)) {
        lostPoint += 40;
      }
    }
  }
  for (var col = 0; col < moduleCount; col++) {
    for (var row = 0; row < moduleCount - 6; row++) {
      if (qrCode.isDark(row, col) && !qrCode.isDark(row + 1, col) && qrCode.isDark(row + 2, col) && qrCode.isDark(row + 3, col) && qrCode.isDark(row + 4, col) && !qrCode.isDark(row + 5, col) && qrCode.isDark(row + 6, col)) {
        lostPoint += 40;
      }
    }
  }
  var darkCount = 0;
  for (var col = 0; col < moduleCount; col++) {
    for (var row = 0; row < moduleCount; row++) {
      if (qrCode.isDark(row, col)) darkCount++;
    }
  }
  var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
  lostPoint += ratio * 10;
  return lostPoint;
};

var QRCodeUtil = {
  toCanvas: function (options) {
    var opts = options || {};
    var text = opts.text || '';
    var canvasId = opts.canvasId || 'qrcode';
    var ctx = wx.createCanvasContext(canvasId);
    var size = opts.size || 200;
    var margin = opts.margin || 20;
    var colorDark = opts.colorDark || '#000000';
    var colorLight = opts.colorLight || '#ffffff';

    var qrCode = new QRCode(0, 'H');
    qrCode.addData(text);
    qrCode.make();

    var moduleCount = qrCode.getModuleCount();
    var cellSize = (size - margin * 2) / moduleCount;

    ctx.setFillStyle(colorLight);
    ctx.fillRect(0, 0, size, size);
    ctx.setFillStyle(colorDark);

    for (var row = 0; row < moduleCount; row++) {
      for (var col = 0; col < moduleCount; col++) {
        if (qrCode.isDark(row, col)) {
          ctx.fillRect(col * cellSize + margin, row * cellSize + margin, cellSize, cellSize);
        }
      }
    }

    ctx.draw(false, function () {
      if (typeof opts.callback === 'function') {
        wx.canvasToTempFilePath({
          canvasId: canvasId,
          success: function (res) {
            opts.callback(res.tempFilePath);
          },
          fail: function (err) {
            opts.callback(null, err);
          }
        });
      }
    });
  },
  toTempFilePath: function (options) {
    var opts = options || {};
    var text = opts.text || '';
    var width = opts.width || 280;
    var height = opts.height || 280;

    var qrCode = new QRCode(0, 'H');
    qrCode.addData(text);
    qrCode.make();

    var moduleCount = qrCode.getModuleCount();
    var scale = width / (moduleCount + 2);
    var margin = scale;

    var pxRatio = wx.getSystemInfoSync().pixelRatio || 2;
    var canvasWidth = width * pxRatio;
    var canvasHeight = height * pxRatio;

    var offscreenCanvas = wx.createOffscreenCanvas({ type: '2d', width: canvasWidth, height: canvasHeight });
    var ctx = offscreenCanvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#000000';

    for (var row = 0; row < moduleCount; row++) {
      for (var col = 0; col < moduleCount; col++) {
        if (qrCode.isDark(row, col)) {
          ctx.fillRect(
            (col * scale + margin) * pxRatio,
            (row * scale + margin) * pxRatio,
            scale * pxRatio,
            scale * pxRatio
          );
        }
      }
    }

    return offscreenCanvas.toDataURL('image/png');
  }
};

module.exports = QRCodeUtil;
