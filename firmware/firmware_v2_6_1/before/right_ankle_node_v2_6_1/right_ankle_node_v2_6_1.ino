#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_mac.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>
#include <string.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ========================= Node identity configuration =================
// Change only CONFIG_NODE_ID before compiling each physical child node.
constexpr uint8_t CONFIG_NODE_ID = 2;
static_assert(CONFIG_NODE_ID == 2, "Fixed firmware: right ankle node ID 2");
constexpr char FIRMWARE_VERSION[] = "2.6.1";

struct NodeIdentity {
  const char *name;
  uint8_t expectedStaMac[6];
};

constexpr NodeIdentity NODE_IDENTITIES[] = {
    {"left_ankle", {0xD4, 0x05, 0x92, 0x49, 0xC3, 0x94}},
    {"right_ankle", {0xD4, 0x05, 0x92, 0x49, 0xAD, 0xA4}},
    {"left_knee", {0xD4, 0x05, 0x92, 0x48, 0xF5, 0x94}},
    {"right_knee", {0xD4, 0x05, 0x92, 0x48, 0x7D, 0x58}},
};

static_assert(CONFIG_NODE_ID >= 1 && CONFIG_NODE_ID <= 4,
              "CONFIG_NODE_ID must be 1..4");
constexpr const NodeIdentity &ACTIVE_NODE =
    NODE_IDENTITIES[CONFIG_NODE_ID - 1];

// ========================= ESP-NOW radio discovery =====================
constexpr uint8_t MASTER_MAC[6] = {0xA0, 0xF2, 0x62,
                                   0xF0, 0x55, 0x08};
constexpr char ESPNOW_PMK[] = "SkatePMK-v261!!!";
constexpr char ESPNOW_LMK[] = "SkateLMK-v261!!!";
static_assert(sizeof(ESPNOW_PMK) - 1 == ESP_NOW_KEY_LEN,
              "ESP-NOW PMK must be 16 bytes");
static_assert(sizeof(ESPNOW_LMK) - 1 == ESP_NOW_KEY_LEN,
              "ESP-NOW LMK must be 16 bytes");
constexpr uint8_t MIN_WIFI_CHANNEL = 1;
constexpr uint8_t MAX_WIFI_CHANNEL = 13;
constexpr uint32_t DISCOVERY_PROBE_INTERVAL_MS = 120;
constexpr uint32_t LINK_LOSS_TIMEOUT_MS = 1500;
constexpr uint16_t CONSECUTIVE_SEND_FAILURE_LIMIT = 12;
constexpr uint32_t SEND_INFLIGHT_TIMEOUT_MS = 500;
constexpr uint32_t RADIO_SERVICE_INTERVAL_MS = 5;
constexpr uint32_t RADIO_RESET_RETRY_MS = 1000;

// ========================= Sampling and ICM20602 =======================
constexpr uint32_t SAMPLE_INTERVAL_MS = 20;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;
constexpr uint32_t IMU_RETRY_INTERVAL_MS = 2000;
constexpr uint32_t I2C_CLOCK_HZ = 100000;
constexpr uint32_t I2C_TIMEOUT_MS = 20;
constexpr uint16_t GYRO_CALIBRATION_SAMPLES = 100;

struct I2cPinPair {
  int sda;
  int scl;
  const char *name;
};

constexpr I2cPinPair I2C_CANDIDATES[] = {
    {12, 13, "project_12_13"},
    {8, 9, "esp32s3_default_8_9"},
};

constexpr uint8_t ICM20602_ADDRESS_LOW = 0x68;
constexpr uint8_t ICM20602_ADDRESS_HIGH = 0x69;
constexpr uint8_t ICM20602_WHO_AM_I = 0x12;
constexpr uint8_t IMU_SAMPLE_RATE_DIVIDER = 19;  // 1 kHz / 20 = 50 Hz
constexpr uint8_t IMU_GYRO_DLPF_CONFIG = 0x04;  // about 20 Hz
constexpr uint8_t IMU_ACCEL_DLPF_CONFIG = 0x04; // about 21.2 Hz
constexpr float ACCEL_LSB_PER_G = 16384.0f;      // +/-2 g
constexpr float GYRO_LSB_PER_DPS = 131.0f;       // +/-250 dps

#if CONFIG_FREERTOS_UNICORE
constexpr BaseType_t SAMPLE_TASK_CORE = 0;
constexpr BaseType_t RADIO_TASK_CORE = 0;
#else
constexpr BaseType_t SAMPLE_TASK_CORE = 1;
constexpr BaseType_t RADIO_TASK_CORE = 0;
#endif

// ========================= ESP-NOW protocol V2 =========================
constexpr uint16_t PACKET_MAGIC = 0x534B;
constexpr uint8_t PROTOCOL_VERSION = 2;

struct __attribute__((packed)) ImuPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t nodeId;
  uint32_t seq;
  uint32_t timestampMs;
  float ax;
  float ay;
  float az;
  float gx;
  float gy;
  float gz;
  float rollDeg;
  float pitchDeg;
  float yawRateDps;
};

static_assert(sizeof(ImuPacket) == 48, "ImuPacket layout mismatch");

struct NodeDiagnostics {
  bool imuReady;
  ImuPacket packet;
  uint32_t totalSamples;
  uint32_t queuedPackets;
  uint32_t queueErrors;
  uint32_t sendOk;
  uint32_t sendFail;
  uint32_t sendErr;
  uint32_t sendBusySkips;
  uint32_t inflightTimeoutCount;
  uint32_t sendStartMs;
  int32_t lastErr;
  bool sendInFlight;
  bool channelLocked;
  bool radioReady;
  bool radioResetRequested;
  uint8_t lockedChannel;
  uint8_t scanChannel;
  uint8_t probeChannel;
  uint16_t consecutiveSendFailures;
  uint32_t lastSendSuccessMs;
  uint32_t lastProbeMs;
  uint32_t lastRadioSendMs;
  uint32_t lastRadioResetAttemptMs;
  uint32_t scanRounds;
  uint32_t linkLossEvents;
  uint32_t radioResetCount;
  uint32_t imuReadErrors;
  uint32_t missedSamplePeriods;
  int sdaPin;
  int sclPin;
  uint8_t imuAddress;
};

NodeDiagnostics diagnostics = {};
portMUX_TYPE diagnosticsMux = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t samplingTaskHandle = nullptr;
TaskHandle_t radioTaskHandle = nullptr;

char nodeMac[18] = {};
uint8_t factoryStaMac[6] = {};
uint8_t imuAddress = 0;
int activeSdaPin = -1;
int activeSclPin = -1;
float gyroOffsetX = 0.0f;
float gyroOffsetY = 0.0f;
float gyroOffsetZ = 0.0f;
float rollDeg = 0.0f;
float pitchDeg = 0.0f;
bool attitudeInitialized = false;
uint32_t lastAttitudeUs = 0;
uint32_t sequence = 0;
uint32_t consecutiveImuErrors = 0;
uint32_t lastStatusMs = 0;
uint32_t lastStatusSamples = 0;
uint32_t lastStatusQueued = 0;
uint32_t lastStatusSendOk = 0;
uint32_t lastReportedInflightTimeoutCount = 0;
bool lastReportedChannelLocked = false;
uint8_t lastReportedLockedChannel = 0;

// ========================= Utilities ===================================
void formatMac(const uint8_t *mac, char *out, size_t outSize) {
  snprintf(out, outSize, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0],
           mac[1], mac[2], mac[3], mac[4], mac[5]);
}

bool loadFactoryMac() {
  uint8_t mac[6] = {};
  if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
    WiFi.macAddress(mac);
  }
  bool allZero = true;
  bool allFF = true;
  for (uint8_t i = 0; i < 6; ++i) {
    allZero = allZero && mac[i] == 0;
    allFF = allFF && mac[i] == 0xFF;
  }
  memcpy(factoryStaMac, mac, sizeof(factoryStaMac));
  formatMac(mac, nodeMac, sizeof(nodeMac));
  return !allZero && !allFF;
}

bool factoryMacMatchesNode() {
  return memcmp(factoryStaMac, ACTIVE_NODE.expectedStaMac,
                sizeof(factoryStaMac)) == 0;
}

uint8_t currentWifiChannel() {
  uint8_t primary = 0;
  wifi_second_chan_t secondary = WIFI_SECOND_CHAN_NONE;
  if (esp_wifi_get_channel(&primary, &secondary) != ESP_OK) {
    return 0;
  }
  return primary;
}

void copyDiagnostics(NodeDiagnostics &out) {
  portENTER_CRITICAL(&diagnosticsMux);
  out = diagnostics;
  portEXIT_CRITICAL(&diagnosticsMux);
}

void initializeDiscoveryPacket() {
  ImuPacket packet = {};
  packet.magic = PACKET_MAGIC;
  packet.version = PROTOCOL_VERSION;
  packet.nodeId = CONFIG_NODE_ID;
  packet.timestampMs = millis();
  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.packet = packet;
  portEXIT_CRITICAL(&diagnosticsMux);
}

// ========================= ICM20602 driver =============================
bool probeAddress(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission(true) == 0;
}

bool readRegisterAt(uint8_t address, uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  size_t received = Wire.requestFrom(address, static_cast<size_t>(1), true);
  if (received != 1 || Wire.available() < 1) {
    return false;
  }
  value = static_cast<uint8_t>(Wire.read());
  return true;
}

bool readRegister(uint8_t reg, uint8_t &value) {
  return readRegisterAt(imuAddress, reg, value);
}

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(imuAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

void printI2cAddresses() {
  Serial.println("[I2C] no ICM20602 at 0x69/0x68 on this pin pair");
}

bool selectIcm20602Bus() {
  for (const I2cPinPair &candidate : I2C_CANDIDATES) {
    Wire.end();
    vTaskDelay(pdMS_TO_TICKS(10));
    Serial.printf("[I2C] trying %s SDA=%d SCL=%d clock=%lu\n",
                  candidate.name, candidate.sda, candidate.scl,
                  static_cast<unsigned long>(I2C_CLOCK_HZ));
    if (!Wire.begin(candidate.sda, candidate.scl, I2C_CLOCK_HZ)) {
      continue;
    }
    Wire.setTimeOut(I2C_TIMEOUT_MS);
    vTaskDelay(pdMS_TO_TICKS(50));

    const uint8_t addresses[] = {ICM20602_ADDRESS_HIGH,
                                 ICM20602_ADDRESS_LOW};
    for (uint8_t address : addresses) {
      if (!probeAddress(address)) continue;
      uint8_t whoAmI = 0xFF;
      if (!readRegisterAt(address, 0x75, whoAmI)) continue;
      Serial.printf("[I2C] address=0x%02X WHO_AM_I=0x%02X\n", address,
                    whoAmI);
      if (whoAmI != ICM20602_WHO_AM_I) continue;
      imuAddress = address;
      activeSdaPin = candidate.sda;
      activeSclPin = candidate.scl;
      return true;
    }
    printI2cAddresses();
  }

  imuAddress = 0;
  activeSdaPin = -1;
  activeSclPin = -1;
  return false;
}

bool writeAndVerifyRegister(uint8_t reg, uint8_t expected,
                            const char *name) {
  for (uint8_t attempt = 0; attempt < 3; ++attempt) {
    uint8_t actual = 0xFF;
    if (writeRegister(reg, expected) && readRegister(reg, actual) &&
        actual == expected) {
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  uint8_t actual = 0xFF;
  readRegister(reg, actual);
  Serial.printf("[IMU] register %s expected=0x%02X actual=0x%02X\n", name,
                expected, actual);
  return false;
}

int16_t readInt16FromWire() {
  uint16_t high = static_cast<uint8_t>(Wire.read());
  uint16_t low = static_cast<uint8_t>(Wire.read());
  return static_cast<int16_t>((high << 8) | low);
}

bool initializeICM20602() {
  if (!selectIcm20602Bus()) {
    Serial.println(
        "[IMU] ICM20602 not found; check 3.3V/GND/SDA/SCL/pull-ups/CS");
    return false;
  }
  Serial.printf("[IMU] found SDA=%d SCL=%d address=0x%02X\n", activeSdaPin,
                activeSclPin, imuAddress);
  if (!writeRegister(0x6B, 0x80)) return false;
  vTaskDelay(pdMS_TO_TICKS(100));

  bool configured =
      writeAndVerifyRegister(0x6B, 0x01, "PWR_MGMT_1") &&
      writeAndVerifyRegister(0x6C, 0x00, "PWR_MGMT_2") &&
      writeAndVerifyRegister(0x19, IMU_SAMPLE_RATE_DIVIDER, "SMPLRT_DIV") &&
      writeAndVerifyRegister(0x1A, IMU_GYRO_DLPF_CONFIG, "CONFIG") &&
      writeAndVerifyRegister(0x1B, 0x00, "GYRO_CONFIG") &&
      writeAndVerifyRegister(0x1C, 0x00, "ACCEL_CONFIG") &&
      writeAndVerifyRegister(0x1D, IMU_ACCEL_DLPF_CONFIG, "ACCEL_CONFIG2");
  if (!configured) return false;
  vTaskDelay(pdMS_TO_TICKS(50));

  uint8_t whoAmI = 0;
  if (!readRegister(0x75, whoAmI) || whoAmI != ICM20602_WHO_AM_I) {
    Serial.printf("[IMU] WHO_AM_I verification failed: 0x%02X\n", whoAmI);
    return false;
  }
  Serial.println("[IMU] ready 50Hz gyro_DLPF=20Hz accel_DLPF=21.2Hz");
  return true;
}

bool readICM20602Raw(float &ax, float &ay, float &az, float &gx, float &gy,
                     float &gz) {
  Wire.beginTransmission(imuAddress);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  size_t received = Wire.requestFrom(imuAddress, static_cast<size_t>(14), true);
  if (received != 14 || Wire.available() < 14) return false;

  // Correct 14-byte order: accel XYZ, temperature, gyro XYZ.
  int16_t rawAx = readInt16FromWire();
  int16_t rawAy = readInt16FromWire();
  int16_t rawAz = readInt16FromWire();
  int16_t rawTemperature = readInt16FromWire();
  int16_t rawGx = readInt16FromWire();
  int16_t rawGy = readInt16FromWire();
  int16_t rawGz = readInt16FromWire();
  (void)rawTemperature;

  ax = rawAx / ACCEL_LSB_PER_G;
  ay = rawAy / ACCEL_LSB_PER_G;
  az = rawAz / ACCEL_LSB_PER_G;
  gx = rawGx / GYRO_LSB_PER_DPS;
  gy = rawGy / GYRO_LSB_PER_DPS;
  gz = rawGz / GYRO_LSB_PER_DPS;
  return true;
}

bool calibrateGyroscope() {
  Serial.println("[IMU] keep sensor still; calibrating gyroscope...");
  double sumX = 0.0;
  double sumY = 0.0;
  double sumZ = 0.0;
  uint16_t validSamples = 0;

  for (uint8_t i = 0; i < 20; ++i) {
    float ax, ay, az, gx, gy, gz;
    readICM20602Raw(ax, ay, az, gx, gy, gz);
    vTaskDelay(pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
  }
  for (uint16_t i = 0; i < GYRO_CALIBRATION_SAMPLES; ++i) {
    float ax, ay, az, gx, gy, gz;
    if (readICM20602Raw(ax, ay, az, gx, gy, gz)) {
      sumX += gx;
      sumY += gy;
      sumZ += gz;
      validSamples++;
    }
    vTaskDelay(pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
  }
  if (validSamples < GYRO_CALIBRATION_SAMPLES / 2) {
    Serial.printf("[IMU] calibration failed valid=%u/%u\n", validSamples,
                  GYRO_CALIBRATION_SAMPLES);
    return false;
  }
  gyroOffsetX = static_cast<float>(sumX / validSamples);
  gyroOffsetY = static_cast<float>(sumY / validSamples);
  gyroOffsetZ = static_cast<float>(sumZ / validSamples);
  attitudeInitialized = false;
  lastAttitudeUs = 0;
  Serial.printf("[IMU] offsets=(%.3f,%.3f,%.3f)\n", gyroOffsetX,
                gyroOffsetY, gyroOffsetZ);
  return true;
}

float wrap180(float angle) {
  while (angle > 180.0f) angle -= 360.0f;
  while (angle <= -180.0f) angle += 360.0f;
  return angle;
}

void updateAttitude(float ax, float ay, float az, float gx, float gy,
                    float dtSeconds) {
  constexpr float RAD_TO_DEG_F = 57.2957795131f;
  constexpr float GYRO_WEIGHT = 0.98f;
  float accelRoll = atan2f(ay, az) * RAD_TO_DEG_F;
  float accelPitch =
      atan2f(-ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG_F;
  if (!attitudeInitialized) {
    rollDeg = accelRoll;
    pitchDeg = accelPitch;
    attitudeInitialized = true;
    return;
  }
  float predictedRoll = wrap180(rollDeg + gx * dtSeconds);
  float predictedPitch = wrap180(pitchDeg + gy * dtSeconds);
  rollDeg = wrap180(predictedRoll +
                    (1.0f - GYRO_WEIGHT) *
                        wrap180(accelRoll - predictedRoll));
  pitchDeg = wrap180(predictedPitch +
                     (1.0f - GYRO_WEIGHT) *
                         wrap180(accelPitch - predictedPitch));
}

// ========================= ESP-NOW-only radio ==========================
bool configureEspNowOnlyRadio() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, true);
  delay(100);
  if (esp_wifi_set_ps(WIFI_PS_NONE) != ESP_OK) return false;
  if (esp_wifi_set_channel(MIN_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE) !=
      ESP_OK) {
    return false;
  }
  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.channelLocked = false;
  diagnostics.radioReady = false;
  diagnostics.radioResetRequested = false;
  diagnostics.scanChannel = MIN_WIFI_CHANNEL;
  diagnostics.lockedChannel = 0;
  portEXIT_CRITICAL(&diagnosticsMux);
  return currentWifiChannel() == MIN_WIFI_CHANNEL;
}

void advanceScanChannelLocked() {
  if (diagnostics.scanChannel >= MAX_WIFI_CHANNEL) {
    diagnostics.scanChannel = MIN_WIFI_CHANNEL;
    diagnostics.scanRounds++;
  } else {
    diagnostics.scanChannel++;
  }
}

void handleSendResult(esp_now_send_status_t status) {
  uint32_t now = millis();
  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.sendInFlight = false;
  if (diagnostics.radioResetRequested || !diagnostics.radioReady) {
    portEXIT_CRITICAL(&diagnosticsMux);
    return;
  }
  if (status == ESP_NOW_SEND_SUCCESS) {
    diagnostics.sendOk++;
    diagnostics.lastErr = 0;
    diagnostics.lastSendSuccessMs = now;
    diagnostics.consecutiveSendFailures = 0;
    if (!diagnostics.channelLocked) {
      diagnostics.channelLocked = true;
      diagnostics.lockedChannel = diagnostics.probeChannel;
      diagnostics.scanChannel = diagnostics.probeChannel;
    }
  } else {
    diagnostics.sendFail++;
    diagnostics.lastErr = static_cast<int32_t>(status);
    if (diagnostics.channelLocked) {
      diagnostics.consecutiveSendFailures++;
      if (diagnostics.consecutiveSendFailures >=
          CONSECUTIVE_SEND_FAILURE_LIMIT) {
        diagnostics.channelLocked = false;
        diagnostics.linkLossEvents++;
        diagnostics.scanChannel = diagnostics.lockedChannel;
        advanceScanChannelLocked();
        diagnostics.lockedChannel = 0;
        diagnostics.lastProbeMs = 0;
      }
    } else {
      advanceScanChannelLocked();
    }
  }
  portEXIT_CRITICAL(&diagnosticsMux);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onDataSent(const esp_now_send_info_t *info,
                esp_now_send_status_t status) {
  (void)info;
  handleSendResult(status);
}
#else
void onDataSent(const uint8_t *mac, esp_now_send_status_t status) {
  (void)mac;
  handleSendResult(status);
}
#endif

bool initializeEspNow() {
  if (esp_now_init() != ESP_OK) return false;
  if (esp_now_set_pmk(
          reinterpret_cast<const uint8_t *>(ESPNOW_PMK)) != ESP_OK) {
    esp_now_deinit();
    return false;
  }
  if (esp_now_register_send_cb(onDataSent) != ESP_OK) {
    esp_now_deinit();
    return false;
  }
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, MASTER_MAC, sizeof(MASTER_MAC));
  // Channel 0 means "use the station interface's current channel". This is
  // required because discovery retunes that interface across channels 1..13.
  peer.channel = 0;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = true;
  memcpy(peer.lmk, ESPNOW_LMK, ESP_NOW_KEY_LEN);
  esp_err_t result = esp_now_add_peer(&peer);
  if (result != ESP_OK && result != ESP_ERR_ESPNOW_EXIST) {
    esp_now_deinit();
    return false;
  }
  Serial.printf(
      "[ESP-NOW] encrypted tx ready scan=1..13 current_channel=%u "
      "packet_size=%u\n",
      currentWifiChannel(), static_cast<unsigned>(sizeof(ImuPacket)));
  return true;
}

void enterScanLocked(bool countLinkLoss) {
  if (countLinkLoss) diagnostics.linkLossEvents++;
  if (diagnostics.lockedChannel >= MIN_WIFI_CHANNEL) {
    diagnostics.scanChannel = diagnostics.lockedChannel;
  }
  advanceScanChannelLocked();
  diagnostics.channelLocked = false;
  diagnostics.lockedChannel = 0;
  diagnostics.lastProbeMs = 0;
}

void recordQueueError(esp_err_t result, bool lockedSend) {
  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.sendInFlight = false;
  diagnostics.queueErrors++;
  diagnostics.sendErr++;
  diagnostics.lastErr = static_cast<int32_t>(result);
  if (lockedSend && diagnostics.channelLocked) {
    diagnostics.consecutiveSendFailures++;
    if (diagnostics.consecutiveSendFailures >=
        CONSECUTIVE_SEND_FAILURE_LIMIT) {
      enterScanLocked(true);
    }
  } else {
    advanceScanChannelLocked();
  }
  portEXIT_CRITICAL(&diagnosticsMux);
}

void reportRadioStateTransitions() {
  NodeDiagnostics state;
  copyDiagnostics(state);
  if (state.channelLocked != lastReportedChannelLocked ||
      state.lockedChannel != lastReportedLockedChannel) {
    if (state.channelLocked) {
      Serial.printf("[RADIO] master discovered; locked channel=%u\n",
                    state.lockedChannel);
    } else if (lastReportedChannelLocked) {
      Serial.printf("[RADIO] master link lost; rescanning 1..13 event=%lu\n",
                    static_cast<unsigned long>(state.linkLossEvents));
    }
    lastReportedChannelLocked = state.channelLocked;
    lastReportedLockedChannel = state.lockedChannel;
  }
}

bool recoverEspNowRadio(uint32_t now) {
  NodeDiagnostics state;
  copyDiagnostics(state);
  if (!state.radioResetRequested ||
      static_cast<uint32_t>(now - state.lastRadioResetAttemptMs) <
          RADIO_RESET_RETRY_MS) {
    return false;
  }

  portENTER_CRITICAL(&diagnosticsMux);
  if (!diagnostics.radioResetRequested) {
    portEXIT_CRITICAL(&diagnosticsMux);
    return false;
  }
  diagnostics.lastRadioResetAttemptMs = now;
  uint8_t restartChannel = diagnostics.scanChannel;
  portEXIT_CRITICAL(&diagnosticsMux);

  esp_now_unregister_send_cb();
  esp_now_deinit();
  vTaskDelay(pdMS_TO_TICKS(20));
  bool ready =
      esp_wifi_set_channel(restartChannel, WIFI_SECOND_CHAN_NONE) == ESP_OK &&
      initializeEspNow();

  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.sendInFlight = false;
  diagnostics.radioReady = ready;
  if (ready) {
    diagnostics.radioResetRequested = false;
    diagnostics.channelLocked = false;
    diagnostics.lockedChannel = 0;
    diagnostics.lastProbeMs = 0;
    diagnostics.consecutiveSendFailures = 0;
    diagnostics.radioResetCount++;
  }
  portEXIT_CRITICAL(&diagnosticsMux);
  Serial.printf("[RADIO] ESP-NOW reset %s channel=%u\n",
                ready ? "OK" : "FAILED", restartChannel);
  return ready;
}

void serviceRadioDiscovery() {
  uint32_t now = millis();
  NodeDiagnostics state;
  copyDiagnostics(state);

  if (state.radioResetRequested) {
    recoverEspNowRadio(now);
    reportRadioStateTransitions();
    return;
  }
  if (!state.radioReady) return;

  if (state.sendInFlight &&
      static_cast<uint32_t>(now - state.sendStartMs) >=
          SEND_INFLIGHT_TIMEOUT_MS) {
    portENTER_CRITICAL(&diagnosticsMux);
    if (diagnostics.sendInFlight &&
        diagnostics.sendStartMs == state.sendStartMs) {
      // Do not reuse the send slot. Deinitializing ESP-NOW unregisters and
      // drains the outstanding callback before a new channel/send is used.
      diagnostics.inflightTimeoutCount++;
      diagnostics.lastErr = -1001;
      diagnostics.radioResetRequested = true;
      diagnostics.radioReady = false;
      enterScanLocked(state.channelLocked);
    }
    portEXIT_CRITICAL(&diagnosticsMux);
    reportRadioStateTransitions();
    return;
  }

  if (state.channelLocked && !state.sendInFlight &&
      state.lastSendSuccessMs != 0 &&
      static_cast<uint32_t>(now - state.lastSendSuccessMs) >=
          LINK_LOSS_TIMEOUT_MS) {
    portENTER_CRITICAL(&diagnosticsMux);
    if (diagnostics.channelLocked && !diagnostics.sendInFlight &&
        diagnostics.lastSendSuccessMs == state.lastSendSuccessMs) {
      enterScanLocked(true);
    }
    portEXIT_CRITICAL(&diagnosticsMux);
    copyDiagnostics(state);
  }

  reportRadioStateTransitions();
  if (state.sendInFlight || state.packet.magic != PACKET_MAGIC) return;

  bool lockedSend = state.channelLocked;
  uint8_t channel = lockedSend ? state.lockedChannel : state.scanChannel;
  if (lockedSend) {
    if (!state.imuReady ||
        static_cast<uint32_t>(now - state.lastRadioSendMs) <
            SAMPLE_INTERVAL_MS) {
      return;
    }
  } else {
    if (static_cast<uint32_t>(now - state.lastProbeMs) <
        DISCOVERY_PROBE_INTERVAL_MS) {
      return;
    }
    if (esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE) != ESP_OK ||
        currentWifiChannel() != channel) {
      portENTER_CRITICAL(&diagnosticsMux);
      diagnostics.lastErr = -2001;
      advanceScanChannelLocked();
      diagnostics.lastProbeMs = now;
      portEXIT_CRITICAL(&diagnosticsMux);
      return;
    }
  }

  ImuPacket probe = {};
  bool canProbe = false;
  portENTER_CRITICAL(&diagnosticsMux);
  bool stateStillMatches =
      lockedSend
          ? diagnostics.channelLocked &&
                diagnostics.lockedChannel == channel
          : !diagnostics.channelLocked &&
                diagnostics.scanChannel == channel;
  if (stateStillMatches && diagnostics.radioReady &&
      !diagnostics.radioResetRequested && !diagnostics.sendInFlight) {
    probe = diagnostics.packet;
    diagnostics.sendInFlight = true;
    diagnostics.sendStartMs = now;
    diagnostics.probeChannel = channel;
    if (lockedSend) {
      diagnostics.lastRadioSendMs = now;
    } else {
      diagnostics.lastProbeMs = now;
    }
    canProbe = true;
  }
  portEXIT_CRITICAL(&diagnosticsMux);
  if (!canProbe) return;

  esp_err_t result = esp_now_send(
      MASTER_MAC, reinterpret_cast<const uint8_t *>(&probe), sizeof(probe));
  if (result == ESP_OK) {
    portENTER_CRITICAL(&diagnosticsMux);
    diagnostics.queuedPackets++;
    portEXIT_CRITICAL(&diagnosticsMux);
  } else {
    recordQueueError(result, lockedSend);
  }
}

void radioManagerTask(void *parameter) {
  (void)parameter;
  for (;;) {
    serviceRadioDiscovery();
    vTaskDelay(pdMS_TO_TICKS(RADIO_SERVICE_INTERVAL_MS));
  }
}

void printWirelessStatus(bool espNowReady) {
  IPAddress ip = WiFi.localIP();
  char masterMac[18];
  formatMac(MASTER_MAC, masterMac, sizeof(masterMac));
  Serial.println("[WIRELESS]");
  Serial.printf("NODE_ID=%u\n", CONFIG_NODE_ID);
  Serial.printf("NODE_NAME=%s\n", ACTIVE_NODE.name);
  Serial.printf("STA_MAC=%s\n", nodeMac);
  Serial.printf("AP_CONNECTED=%s\n",
                WiFi.status() == WL_CONNECTED ? "YES" : "NO");
  Serial.printf("IP=%u.%u.%u.%u\n", ip[0], ip[1], ip[2], ip[3]);
  Serial.printf("CHANNEL=%u\n", currentWifiChannel());
  Serial.printf("ESP_NOW=%s\n", espNowReady ? "OK" : "FAIL");
  Serial.printf("MASTER_MAC=%s\n", masterMac);
}

// ========================= Fixed 20 ms sampling task ===================
bool sampleAndStore() {
  float ax, ay, az, gx, gy, gz;
  if (!readICM20602Raw(ax, ay, az, gx, gy, gz)) {
    consecutiveImuErrors++;
    portENTER_CRITICAL(&diagnosticsMux);
    diagnostics.imuReadErrors++;
    portEXIT_CRITICAL(&diagnosticsMux);
    return false;
  }
  consecutiveImuErrors = 0;
  gx -= gyroOffsetX;
  gy -= gyroOffsetY;
  gz -= gyroOffsetZ;

  uint32_t nowUs = micros();
  float dtSeconds = SAMPLE_INTERVAL_MS / 1000.0f;
  if (lastAttitudeUs != 0) {
    dtSeconds = static_cast<uint32_t>(nowUs - lastAttitudeUs) / 1000000.0f;
    if (dtSeconds < 0.005f || dtSeconds > 0.100f) {
      dtSeconds = SAMPLE_INTERVAL_MS / 1000.0f;
    }
  }
  lastAttitudeUs = nowUs;
  updateAttitude(ax, ay, az, gx, gy, dtSeconds);

  ImuPacket packet = {};
  packet.magic = PACKET_MAGIC;
  packet.version = PROTOCOL_VERSION;
  packet.nodeId = CONFIG_NODE_ID;
  packet.seq = ++sequence;
  packet.timestampMs = millis();
  packet.ax = ax;
  packet.ay = ay;
  packet.az = az;
  packet.gx = gx;
  packet.gy = gy;
  packet.gz = gz;
  packet.rollDeg = rollDeg;
  packet.pitchDeg = pitchDeg;
  packet.yawRateDps = gz;

  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.packet = packet;
  diagnostics.totalSamples++;
  portEXIT_CRITICAL(&diagnosticsMux);
  return true;
}

void samplingTask(void *parameter) {
  (void)parameter;
  const TickType_t period = pdMS_TO_TICKS(SAMPLE_INTERVAL_MS);
  TickType_t lastWake = xTaskGetTickCount();
  bool imuReady = false;

  for (;;) {
    if (!imuReady) {
      imuReady = initializeICM20602() && calibrateGyroscope();
      portENTER_CRITICAL(&diagnosticsMux);
      diagnostics.imuReady = imuReady;
      diagnostics.sdaPin = activeSdaPin;
      diagnostics.sclPin = activeSclPin;
      diagnostics.imuAddress = imuAddress;
      portEXIT_CRITICAL(&diagnosticsMux);
      if (!imuReady) {
        Wire.end();
        vTaskDelay(pdMS_TO_TICKS(IMU_RETRY_INTERVAL_MS));
        continue;
      }
      consecutiveImuErrors = 0;
      lastWake = xTaskGetTickCount();
      Serial.println("[IMU] fixed 50 Hz sampling task active");
    }

    TickType_t deadline = lastWake + period;
    bool sampleOk = sampleAndStore();
    if (!sampleOk) {
      vTaskDelay(pdMS_TO_TICKS(1));
    }
    TickType_t finished = xTaskGetTickCount();
    if (static_cast<int32_t>(finished - deadline) > 0) {
      uint32_t missed =
          static_cast<uint32_t>(finished - deadline) / period + 1;
      portENTER_CRITICAL(&diagnosticsMux);
      diagnostics.missedSamplePeriods += missed;
      portEXIT_CRITICAL(&diagnosticsMux);
    }

    if (consecutiveImuErrors >= 50) {
      Serial.println("[IMU] 50 consecutive read failures; rediscovering");
      imuReady = false;
      portENTER_CRITICAL(&diagnosticsMux);
      diagnostics.imuReady = false;
      portEXIT_CRITICAL(&diagnosticsMux);
      Wire.end();
      continue;
    }
    vTaskDelayUntil(&lastWake, period);
  }
}

// ========================= Diagnostics =================================
void printStatus() {
  NodeDiagnostics state;
  copyDiagnostics(state);
  uint32_t now = millis();
  uint32_t elapsed = lastStatusMs == 0 ? STATUS_INTERVAL_MS : now - lastStatusMs;
  if (elapsed == 0) elapsed = 1;
  float sampleHz =
      static_cast<float>(state.totalSamples - lastStatusSamples) * 1000.0f /
      elapsed;
  float txHz =
      static_cast<float>(state.queuedPackets - lastStatusQueued) * 1000.0f /
      elapsed;
  float deliveryHz =
      static_cast<float>(state.sendOk - lastStatusSendOk) * 1000.0f / elapsed;
  int32_t lastOkAgeMs =
      state.lastSendSuccessMs == 0
          ? -1
          : static_cast<int32_t>(now - state.lastSendSuccessMs);
  lastStatusSamples = state.totalSamples;
  lastStatusQueued = state.queuedPackets;
  lastStatusSendOk = state.sendOk;

  Serial.printf(
      "[NODE] fw=%s id=%u name=%s mac=%s imu=%s "
      "i2c=(SDA%d,SCL%d,0x%02X) ap_connected=%s ip=%u.%u.%u.%u "
      "channel=%u radio=%s locked_channel=%u scan_channel=%u "
      "scan_rounds=%lu link_loss=%lu radio_reset=%s reset_count=%lu "
      "last_ok_age_ms=%ld seq=%lu "
      "sample_hz=%.1f tx_hz=%.1f delivery_hz=%.1f "
      "inflight=%s sendOK=%lu sendFAIL=%lu sendErr=%lu lastErr=%ld "
      "timeout=%lu busy_skip=%lu queued=%lu queue_err=%lu imu_err=%lu "
      "missed=%lu free_heap=%lu\n",
      FIRMWARE_VERSION, CONFIG_NODE_ID, ACTIVE_NODE.name, nodeMac,
      state.imuReady ? "READY" : "SEARCH", state.sdaPin, state.sclPin,
      state.imuAddress, WiFi.status() == WL_CONNECTED ? "YES" : "NO",
      WiFi.localIP()[0], WiFi.localIP()[1], WiFi.localIP()[2],
      WiFi.localIP()[3], currentWifiChannel(),
      state.channelLocked ? "LOCKED" : "SCANNING", state.lockedChannel,
      state.scanChannel, static_cast<unsigned long>(state.scanRounds),
      static_cast<unsigned long>(state.linkLossEvents),
      state.radioResetRequested ? "PENDING" : "NO",
      static_cast<unsigned long>(state.radioResetCount),
      static_cast<long>(lastOkAgeMs),
      static_cast<unsigned long>(state.packet.seq), sampleHz, txHz, deliveryHz,
      state.sendInFlight ? "YES" : "NO",
      static_cast<unsigned long>(state.sendOk),
      static_cast<unsigned long>(state.sendFail),
      static_cast<unsigned long>(state.sendErr),
      static_cast<long>(state.lastErr),
      static_cast<unsigned long>(state.inflightTimeoutCount),
      static_cast<unsigned long>(state.sendBusySkips),
      static_cast<unsigned long>(state.queuedPackets),
      static_cast<unsigned long>(state.queueErrors),
      static_cast<unsigned long>(state.imuReadErrors),
      static_cast<unsigned long>(state.missedSamplePeriods),
      static_cast<unsigned long>(ESP.getFreeHeap()));

  if (state.inflightTimeoutCount != lastReportedInflightTimeoutCount) {
    Serial.printf("[ESP-NOW] inflight timeout total=%lu\n",
                  static_cast<unsigned long>(state.inflightTimeoutCount));
    lastReportedInflightTimeoutCount = state.inflightTimeoutCount;
  }
}

// ========================= Arduino entry points ========================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.printf("=== Roller Skating IMU Node v%s id=%u name=%s ===\n",
                FIRMWARE_VERSION, CONFIG_NODE_ID, ACTIVE_NODE.name);

  if (!configureEspNowOnlyRadio()) {
    Serial.println("[FATAL] ESP-NOW-only radio configuration failed");
    for (;;) delay(1000);
  }
  if (!loadFactoryMac()) {
    Serial.println("[FATAL] invalid factory STA MAC");
    for (;;) delay(1000);
  }
  if (!factoryMacMatchesNode()) {
    char expectedMac[18];
    formatMac(ACTIVE_NODE.expectedStaMac, expectedMac, sizeof(expectedMac));
    Serial.printf(
        "[FATAL] NODE_FIRMWARE_MAC_MISMATCH id=%u name=%s expected=%s "
        "actual=%s\n",
        CONFIG_NODE_ID, ACTIVE_NODE.name, expectedMac, nodeMac);
    for (;;) delay(1000);
  }
  Serial.printf("[NODE] factory STA MAC=%s protocol=%u\n", nodeMac,
                PROTOCOL_VERSION);
  // Radio discovery starts from this valid protocol V2 packet and therefore
  // does not wait for IMU discovery/calibration to finish.
  initializeDiscoveryPacket();
  bool espNowReady = initializeEspNow();
  portENTER_CRITICAL(&diagnosticsMux);
  diagnostics.radioReady = espNowReady;
  portEXIT_CRITICAL(&diagnosticsMux);
  printWirelessStatus(espNowReady);
  if (!espNowReady) {
    Serial.println("[FATAL] ESP-NOW initialization failed");
    delay(3000);
    ESP.restart();
  }

  if (xTaskCreatePinnedToCore(samplingTask, "node_imu_50hz", 6144, nullptr,
                              3, &samplingTaskHandle,
                              SAMPLE_TASK_CORE) != pdPASS) {
    Serial.println("[FATAL] sampling task creation failed");
    delay(3000);
    ESP.restart();
  }
  if (xTaskCreatePinnedToCore(radioManagerTask, "node_radio_manager", 6144,
                              nullptr, 2, &radioTaskHandle,
                              RADIO_TASK_CORE) != pdPASS) {
    Serial.println("[FATAL] radio manager task creation failed");
    delay(3000);
    ESP.restart();
  }
  Serial.println("[RADIO] scanning channels 1..13 for configured master MAC");
  lastStatusMs = millis();
}

void loop() {
  uint32_t now = millis();
  if (static_cast<uint32_t>(now - lastStatusMs) >= STATUS_INTERVAL_MS) {
    printStatus();
    lastStatusMs = now;
  }
  delay(10);
}
