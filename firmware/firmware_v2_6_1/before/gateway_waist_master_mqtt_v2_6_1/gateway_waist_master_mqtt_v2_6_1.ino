#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_mac.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ========================= Fixed deployment configuration =============
constexpr char WIFI_SSID[] = "HONOR 200";
constexpr char WIFI_PASSWORD[] = "hoshino521";
constexpr char MQTT_HOST[] = "82.156.18.205";
constexpr uint16_t MQTT_PORT = 1883;
constexpr char MQTT_USERNAME[] = "";
constexpr char MQTT_PASSWORD[] = "";
constexpr char MQTT_TOPIC_ROOT[] = "roller_skating/devices";
constexpr char FIRMWARE_VERSION[] = "2.6.1";

constexpr uint32_t WIFI_INITIAL_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 5000;
constexpr uint8_t EXPECTED_GATEWAY_STA_MAC[6] = {0xA0, 0xF2, 0x62,
                                                 0xF0, 0x55, 0x08};
// Replace both keys before a production deployment. They must match all four
// child firmwares and must remain exactly 16 bytes (excluding the terminator).
constexpr char ESPNOW_PMK[] = "SkatePMK-v261!!!";
constexpr char ESPNOW_LMK[] = "SkateLMK-v261!!!";
static_assert(sizeof(ESPNOW_PMK) - 1 == ESP_NOW_KEY_LEN,
              "ESP-NOW PMK must be 16 bytes");
static_assert(sizeof(ESPNOW_LMK) - 1 == ESP_NOW_KEY_LEN,
              "ESP-NOW LMK must be 16 bytes");

// ========================= Timing and task configuration ===============
constexpr uint32_t SENSOR_SAMPLE_HZ = 50;
constexpr uint32_t SENSOR_SAMPLE_INTERVAL_MS = 20;
constexpr uint32_t SNAPSHOT_INTERVAL_MS = 20;
constexpr uint32_t UPLOAD_INTERVAL_MS = 50;
constexpr uint32_t STATUS_INTERVAL_MS = 1000;
constexpr bool PRINT_WAIST_RAW_FRAMES = true;
constexpr uint32_t NODE_OFFLINE_TIMEOUT_MS = 500;
constexpr uint32_t HOST_IMU_RETRY_INTERVAL_MS = 3000;
constexpr uint32_t I2C_TIMEOUT_MS = 20;
constexpr uint16_t MQTT_KEEPALIVE_SECONDS = 15;
constexpr uint16_t MQTT_SOCKET_TIMEOUT_SECONDS = 1;
constexpr uint16_t MQTT_PACKET_BUFFER_SIZE = 6144;
constexpr uint32_t MQTT_BACKOFF_MS[] = {250, 500, 1000, 2000, 5000};

#if CONFIG_FREERTOS_UNICORE
constexpr BaseType_t SENSOR_TASK_CORE = 0;
constexpr BaseType_t SNAPSHOT_TASK_CORE = 0;
constexpr BaseType_t MQTT_TASK_CORE = 0;
#else
constexpr BaseType_t SENSOR_TASK_CORE = 1;
constexpr BaseType_t SNAPSHOT_TASK_CORE = 1;
constexpr BaseType_t MQTT_TASK_CORE = 0;
#endif

// ========================= ICM20602 configuration ======================
constexpr uint8_t ICM20602_ADDRESS_LOW = 0x68;
constexpr uint8_t ICM20602_ADDRESS_HIGH = 0x69;
constexpr uint8_t ICM20602_WHO_AM_I = 0x12;
constexpr uint32_t I2C_CLOCK_HZ = 100000;
constexpr uint16_t GYRO_CALIBRATION_SAMPLES = 100;
constexpr uint8_t IMU_SAMPLE_RATE_DIVIDER = 19;  // 1 kHz / 20 = 50 Hz
constexpr uint8_t IMU_GYRO_DLPF_CONFIG = 0x04;  // about 20 Hz
constexpr uint8_t IMU_ACCEL_DLPF_CONFIG = 0x04; // about 21.2 Hz
constexpr float ACCEL_LSB_PER_G = 16384.0f;      // +/-2 g
constexpr float GYRO_LSB_PER_DPS = 131.0f;       // +/-250 dps

struct I2cPinPair {
  int sda;
  int scl;
  const char *name;
};

constexpr I2cPinPair I2C_CANDIDATES[] = {
    {12, 13, "project_12_13"},
    {8, 9, "esp32s3_default_8_9"},
};

// ========================= ESP-NOW protocol V2 =========================
constexpr uint16_t PACKET_MAGIC = 0x534B; // "SK"
constexpr uint8_t PROTOCOL_VERSION = 2;
constexpr uint8_t NODE_COUNT = 4;

enum NodeId : uint8_t {
  NODE_LEFT_ANKLE = 1,
  NODE_RIGHT_ANKLE = 2,
  NODE_LEFT_KNEE = 3,
  NODE_RIGHT_KNEE = 4,
};

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
static_assert(NODE_LEFT_ANKLE == 1 && NODE_RIGHT_ANKLE == 2 &&
                  NODE_LEFT_KNEE == 3 && NODE_RIGHT_KNEE == 4,
              "Node IDs must remain fixed");

constexpr const char *NODE_NAMES[NODE_COUNT] = {
    "left_ankle", "right_ankle", "left_knee", "right_knee"};

constexpr uint8_t EXPECTED_NODE_MACS[NODE_COUNT][6] = {
    {0xD4, 0x05, 0x92, 0x49, 0xC3, 0x94},
    {0xD4, 0x05, 0x92, 0x49, 0xAD, 0xA4},
    {0xD4, 0x05, 0x92, 0x48, 0xF5, 0x94},
    {0xD4, 0x05, 0x92, 0x48, 0x7D, 0x58},
};

// The ESP-NOW callback writes only these compact receive slots.
struct RxSlot {
  bool seen;
  ImuPacket packet;
  uint8_t senderMac[6];
  uint32_t lastReceiveMs;
  uint32_t receivedPackets;
};

struct HostState {
  bool imuReady;
  bool seen;
  ImuPacket packet;
  uint32_t lastSampleMs;
  uint32_t readErrors;
  uint32_t totalSamples;
  int sdaPin;
  int sclPin;
  uint8_t imuAddress;
  float temperatureC;
  uint64_t unixTimestampMs;
  bool unixTimeValid;
};

struct NodeState {
  bool seen;
  ImuPacket packet;
  uint8_t senderMac[6];
  uint32_t lastReceiveMs;
  uint32_t droppedPackets;
  uint32_t receivedPackets;
  uint32_t ageMs;
  float rxHz;
};

struct LatestFrame {
  uint32_t frameSeq;
  uint32_t generatedMs;
  HostState host;
  NodeState nodes[NODE_COUNT];
};

struct MqttMetrics {
  bool connected;
  uint32_t publishAttempts;
  uint32_t publishSuccesses;
  uint32_t publishFailures;
  uint32_t publishOverrun;
  uint32_t latestFrameOverwriteCount;
  uint32_t jsonOverflowCount;
  uint32_t connectAttempts;
  uint32_t connectSuccesses;
  uint32_t lastPublishDurationMs;
  uint32_t lastPublishSuccessMs;
  uint32_t consecutiveFailures;
  int lastMqttState;
};

// ========================= Shared runtime state ========================
RxSlot rxSlots[NODE_COUNT] = {};
HostState hostState = {};
portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE hostMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE metricsMux = portMUX_INITIALIZER_UNLOCKED;

uint32_t invalidLengthCount = 0;
uint32_t invalidProtocolCount = 0;
uint32_t invalidNodeCount = 0;
uint32_t invalidSenderMacCount = 0;

QueueHandle_t latestFrameQueue = nullptr;
SemaphoreHandle_t diagnosticFrameMutex = nullptr;
LatestFrame diagnosticFrame = {};
bool diagnosticFrameValid = false;
MqttMetrics mqttMetrics = {};

TaskHandle_t hostSamplingTaskHandle = nullptr;
TaskHandle_t snapshotTaskHandle = nullptr;
TaskHandle_t mqttPublishTaskHandle = nullptr;

char gatewayMac[18] = {};
bool gatewayMacValid = false;

constexpr size_t JSON_BUFFER_SIZE = 4096;
char jsonBuffer[JSON_BUFFER_SIZE] = {};
WiFiClient cloudTransport;
PubSubClient mqttClient(cloudTransport);
char mqttClientId[48] = {};
char mqttDataTopic[128] = {};
char mqttStatusTopic[128] = {};

uint8_t hostImuAddress = 0;
int hostActiveSdaPin = -1;
int hostActiveSclPin = -1;
float hostGyroOffsetX = 0.0f;
float hostGyroOffsetY = 0.0f;
float hostGyroOffsetZ = 0.0f;
float hostRollDeg = 0.0f;
float hostPitchDeg = 0.0f;
bool hostAttitudeInitialized = false;
uint32_t hostSequence = 0;
uint32_t hostLastAttitudeUs = 0;
uint32_t hostConsecutiveReadErrors = 0;

bool previousWifiConnected = false;
uint8_t lastKnownWifiChannel = 0;
uint32_t lastWifiReconnectAttemptMs = 0;
uint32_t lastStatusMs = 0;
uint32_t lastStatusHostSamples = 0;
uint32_t lastStatusPublishSuccesses = 0;
uint32_t lastPrintedHostSequence = 0;

uint64_t currentUnixTimestampMs(bool &valid) {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  // 2024-01-01；低于此值说明 NTP 尚未同步。
  valid = tv.tv_sec >= 1704067200;
  if (!valid) return static_cast<uint64_t>(millis());
  return static_cast<uint64_t>(tv.tv_sec) * 1000ULL +
         static_cast<uint64_t>(tv.tv_usec / 1000);
}

// ========================= Small utilities =============================
void formatMac(const uint8_t *mac, char *out, size_t outSize) {
  if (mac == nullptr) {
    snprintf(out, outSize, "00:00:00:00:00:00");
    return;
  }
  snprintf(out, outSize, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0],
           mac[1], mac[2], mac[3], mac[4], mac[5]);
}

bool isUsableMac(const uint8_t *mac) {
  bool allZero = true;
  bool allFF = true;
  for (uint8_t i = 0; i < 6; ++i) {
    allZero = allZero && mac[i] == 0x00;
    allFF = allFF && mac[i] == 0xFF;
  }
  return !allZero && !allFF;
}

bool loadGatewayMac() {
  uint8_t mac[6] = {};
  if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK || !isUsableMac(mac)) {
    WiFi.macAddress(mac);
  }
  formatMac(mac, gatewayMac, sizeof(gatewayMac));
  return isUsableMac(mac);
}

bool gatewayMacMatchesDeployment() {
  uint8_t actual[6] = {};
  if (esp_read_mac(actual, ESP_MAC_WIFI_STA) != ESP_OK) {
    WiFi.macAddress(actual);
  }
  return memcmp(actual, EXPECTED_GATEWAY_STA_MAC, sizeof(actual)) == 0;
}

void buildMqttIdentity() {
  char compactMac[13] = {};
  size_t used = 0;
  for (size_t i = 0; gatewayMac[i] != '\0' && used < sizeof(compactMac) - 1;
       ++i) {
    if (gatewayMac[i] != ':') {
      compactMac[used++] = gatewayMac[i];
    }
  }
  compactMac[used] = '\0';

  snprintf(mqttClientId, sizeof(mqttClientId), "skate-gw-%s", compactMac);
  snprintf(mqttDataTopic, sizeof(mqttDataTopic), "%s/%s/frames",
           MQTT_TOPIC_ROOT, compactMac);
  snprintf(mqttStatusTopic, sizeof(mqttStatusTopic), "%s/%s/status",
           MQTT_TOPIC_ROOT, compactMac);
}

uint8_t currentWifiChannel() {
  uint8_t primary = 0;
  wifi_second_chan_t secondary = WIFI_SECOND_CHAN_NONE;
  if (esp_wifi_get_channel(&primary, &secondary) != ESP_OK) {
    return 0;
  }
  return primary;
}

bool appendJson(char *buffer, size_t capacity, size_t &used,
                const char *format, ...) {
  if (used >= capacity) {
    return false;
  }
  va_list args;
  va_start(args, format);
  int written = vsnprintf(buffer + used, capacity - used, format, args);
  va_end(args);
  if (written < 0 || static_cast<size_t>(written) >= capacity - used) {
    buffer[capacity - 1] = '\0';
    return false;
  }
  used += static_cast<size_t>(written);
  return true;
}

void copyHostState(HostState &out) {
  portENTER_CRITICAL(&hostMux);
  out = hostState;
  portEXIT_CRITICAL(&hostMux);
}

void copyMqttMetrics(MqttMetrics &out) {
  portENTER_CRITICAL(&metricsMux);
  out = mqttMetrics;
  portEXIT_CRITICAL(&metricsMux);
}

// ========================= Local waist ICM20602 ========================
bool writeImuRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(hostImuAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

bool readImuRegisterAt(uint8_t address, uint8_t reg, uint8_t &value) {
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

bool readImuRegister(uint8_t reg, uint8_t &value) {
  return readImuRegisterAt(hostImuAddress, reg, value);
}

bool probeImuAddress(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission(true) == 0;
}

void printHostI2cAddresses() {
  // Do not scan all 126 addresses here. With a stuck bus and a 20 ms I2C
  // timeout that could monopolize the high-priority sensor task for seconds.
  Serial.println("[HOST I2C] no ICM20602 at 0x69/0x68 on this pin pair");
}

bool selectHostImuBus() {
  for (const I2cPinPair &candidate : I2C_CANDIDATES) {
    Wire.end();
    vTaskDelay(pdMS_TO_TICKS(10));
    Serial.printf("[HOST I2C] trying %s SDA=%d SCL=%d clock=%lu\n",
                  candidate.name, candidate.sda, candidate.scl,
                  static_cast<unsigned long>(I2C_CLOCK_HZ));
    if (!Wire.begin(candidate.sda, candidate.scl, I2C_CLOCK_HZ)) {
      Serial.println("[HOST I2C] Wire.begin failed");
      continue;
    }
    Wire.setTimeOut(I2C_TIMEOUT_MS);
    vTaskDelay(pdMS_TO_TICKS(50));

    const uint8_t addresses[] = {ICM20602_ADDRESS_HIGH,
                                 ICM20602_ADDRESS_LOW};
    for (uint8_t address : addresses) {
      if (!probeImuAddress(address)) {
        continue;
      }
      uint8_t whoAmI = 0xFF;
      if (!readImuRegisterAt(address, 0x75, whoAmI)) {
        Serial.printf(
            "[HOST I2C] address 0x%02X ACK but WHO_AM_I read failed\n",
            address);
        continue;
      }
      Serial.printf("[HOST I2C] address=0x%02X WHO_AM_I=0x%02X\n", address,
                    whoAmI);
      if (whoAmI != ICM20602_WHO_AM_I) {
        continue;
      }
      hostImuAddress = address;
      hostActiveSdaPin = candidate.sda;
      hostActiveSclPin = candidate.scl;
      return true;
    }
    printHostI2cAddresses();
  }

  hostImuAddress = 0;
  hostActiveSdaPin = -1;
  hostActiveSclPin = -1;
  return false;
}

bool writeAndVerifyImuRegister(uint8_t reg, uint8_t expected,
                               const char *name) {
  for (uint8_t attempt = 0; attempt < 3; ++attempt) {
    uint8_t actual = 0xFF;
    if (writeImuRegister(reg, expected) && readImuRegister(reg, actual) &&
        actual == expected) {
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  uint8_t actual = 0xFF;
  readImuRegister(reg, actual);
  Serial.printf("[HOST IMU] register %s(0x%02X) expected=0x%02X actual=0x%02X\n",
                name, reg, expected, actual);
  return false;
}

int16_t readImuInt16() {
  uint16_t high = static_cast<uint8_t>(Wire.read());
  uint16_t low = static_cast<uint8_t>(Wire.read());
  return static_cast<int16_t>((high << 8) | low);
}

bool initializeLocalImu() {
  if (!selectHostImuBus()) {
    Serial.println(
        "[HOST IMU] ICM20602 not found on SDA/SCL 12/13 or 8/9 at 0x69/0x68");
    return false;
  }
  Serial.printf("[HOST IMU] found SDA=%d SCL=%d address=0x%02X\n",
                hostActiveSdaPin, hostActiveSclPin, hostImuAddress);

  if (!writeImuRegister(0x6B, 0x80)) {
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(100));

  bool configured =
      writeAndVerifyImuRegister(0x6B, 0x01, "PWR_MGMT_1") &&
      writeAndVerifyImuRegister(0x6C, 0x00, "PWR_MGMT_2") &&
      writeAndVerifyImuRegister(0x19, IMU_SAMPLE_RATE_DIVIDER,
                                "SMPLRT_DIV") &&
      writeAndVerifyImuRegister(0x1A, IMU_GYRO_DLPF_CONFIG, "CONFIG") &&
      writeAndVerifyImuRegister(0x1B, 0x00, "GYRO_CONFIG") &&
      writeAndVerifyImuRegister(0x1C, 0x00, "ACCEL_CONFIG") &&
      writeAndVerifyImuRegister(0x1D, IMU_ACCEL_DLPF_CONFIG,
                                "ACCEL_CONFIG2");
  if (!configured) {
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(50));

  uint8_t whoAmI = 0;
  if (!readImuRegister(0x75, whoAmI) || whoAmI != ICM20602_WHO_AM_I) {
    Serial.printf("[HOST IMU] WHO_AM_I verification failed: 0x%02X\n",
                  whoAmI);
    return false;
  }
  Serial.println(
      "[HOST IMU] verified 50Hz gyro_DLPF=20Hz accel_DLPF=21.2Hz");
  return true;
}

bool readLocalImuRaw(float &ax, float &ay, float &az, float &gx, float &gy,
                     float &gz, float &temperatureC) {
  Wire.beginTransmission(hostImuAddress);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  size_t received =
      Wire.requestFrom(hostImuAddress, static_cast<size_t>(14), true);
  if (received != 14 || Wire.available() < 14) {
    return false;
  }

  // ICM20602 order: accel XYZ, temperature, gyro XYZ.
  int16_t rawAx = readImuInt16();
  int16_t rawAy = readImuInt16();
  int16_t rawAz = readImuInt16();
  int16_t rawTemperature = readImuInt16();
  int16_t rawGx = readImuInt16();
  int16_t rawGy = readImuInt16();
  int16_t rawGz = readImuInt16();
  // ICM20602 datasheet: Temperature = TEMP_OUT / 326.8 + 25 degC.
  temperatureC = static_cast<float>(rawTemperature) / 326.8f + 25.0f;

  ax = rawAx / ACCEL_LSB_PER_G;
  ay = rawAy / ACCEL_LSB_PER_G;
  az = rawAz / ACCEL_LSB_PER_G;
  gx = rawGx / GYRO_LSB_PER_DPS;
  gy = rawGy / GYRO_LSB_PER_DPS;
  gz = rawGz / GYRO_LSB_PER_DPS;
  return true;
}

bool calibrateLocalGyroscope() {
  Serial.println("[HOST IMU] keep gateway still; calibrating...");
  double sumX = 0.0;
  double sumY = 0.0;
  double sumZ = 0.0;
  uint16_t validSamples = 0;

  for (uint8_t i = 0; i < 20; ++i) {
    float ax, ay, az, gx, gy, gz, temperatureC;
    readLocalImuRaw(ax, ay, az, gx, gy, gz, temperatureC);
    vTaskDelay(pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS));
  }
  for (uint16_t i = 0; i < GYRO_CALIBRATION_SAMPLES; ++i) {
    float ax, ay, az, gx, gy, gz, temperatureC;
    if (readLocalImuRaw(ax, ay, az, gx, gy, gz, temperatureC)) {
      sumX += gx;
      sumY += gy;
      sumZ += gz;
      validSamples++;
    }
    vTaskDelay(pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS));
  }
  if (validSamples < GYRO_CALIBRATION_SAMPLES / 2) {
    Serial.printf("[HOST IMU] calibration failed valid=%u/%u\n", validSamples,
                  GYRO_CALIBRATION_SAMPLES);
    return false;
  }

  hostGyroOffsetX = static_cast<float>(sumX / validSamples);
  hostGyroOffsetY = static_cast<float>(sumY / validSamples);
  hostGyroOffsetZ = static_cast<float>(sumZ / validSamples);
  hostAttitudeInitialized = false;
  hostLastAttitudeUs = 0;
  Serial.printf("[HOST IMU] offsets=(%.3f,%.3f,%.3f)\n", hostGyroOffsetX,
                hostGyroOffsetY, hostGyroOffsetZ);
  return true;
}

float wrap180(float angle) {
  while (angle > 180.0f) angle -= 360.0f;
  while (angle <= -180.0f) angle += 360.0f;
  return angle;
}

void updateHostAttitude(float ax, float ay, float az, float gx, float gy,
                        float dtSeconds) {
  constexpr float RAD_TO_DEG_F = 57.2957795131f;
  constexpr float GYRO_WEIGHT = 0.98f;
  float accelRoll = atan2f(ay, az) * RAD_TO_DEG_F;
  float accelPitch =
      atan2f(-ax, sqrtf(ay * ay + az * az)) * RAD_TO_DEG_F;
  if (!hostAttitudeInitialized) {
    hostRollDeg = accelRoll;
    hostPitchDeg = accelPitch;
    hostAttitudeInitialized = true;
    return;
  }
  float predictedRoll = wrap180(hostRollDeg + gx * dtSeconds);
  float predictedPitch = wrap180(hostPitchDeg + gy * dtSeconds);
  hostRollDeg = wrap180(predictedRoll +
                        (1.0f - GYRO_WEIGHT) *
                            wrap180(accelRoll - predictedRoll));
  hostPitchDeg = wrap180(predictedPitch +
                         (1.0f - GYRO_WEIGHT) *
                             wrap180(accelPitch - predictedPitch));
}

bool sampleLocalWaist() {
  float ax, ay, az, gx, gy, gz, temperatureC;
  if (!readLocalImuRaw(ax, ay, az, gx, gy, gz, temperatureC)) {
    hostConsecutiveReadErrors++;
    portENTER_CRITICAL(&hostMux);
    hostState.readErrors++;
    portEXIT_CRITICAL(&hostMux);
    return false;
  }
  hostConsecutiveReadErrors = 0;
  gx -= hostGyroOffsetX;
  gy -= hostGyroOffsetY;
  gz -= hostGyroOffsetZ;

  // 不在固件端进行互补滤波或姿态融合；软件滤波统一放到 Python。
  hostRollDeg = 0.0f;
  hostPitchDeg = 0.0f;

  ImuPacket packet = {};
  packet.magic = PACKET_MAGIC;
  packet.version = PROTOCOL_VERSION;
  packet.nodeId = 0;
  packet.seq = ++hostSequence;
  packet.timestampMs = millis();
  packet.ax = ax;
  packet.ay = ay;
  packet.az = az;
  packet.gx = gx;
  packet.gy = gy;
  packet.gz = gz;
  packet.rollDeg = hostRollDeg;
  packet.pitchDeg = hostPitchDeg;
  packet.yawRateDps = gz;

  bool unixTimeValid = false;
  uint64_t unixTimestampMs = currentUnixTimestampMs(unixTimeValid);

  portENTER_CRITICAL(&hostMux);
  hostState.seen = true;
  hostState.packet = packet;
  hostState.lastSampleMs = packet.timestampMs;
  hostState.totalSamples++;
  hostState.temperatureC = temperatureC;
  hostState.unixTimestampMs = unixTimestampMs;
  hostState.unixTimeValid = unixTimeValid;
  portEXIT_CRITICAL(&hostMux);
  return true;
}

void hostSamplingTask(void *parameter) {
  (void)parameter;
  const TickType_t period = pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS);
  bool imuReady = false;
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    if (!imuReady) {
      imuReady = initializeLocalImu() && calibrateLocalGyroscope();
      portENTER_CRITICAL(&hostMux);
      hostState.imuReady = imuReady;
      hostState.seen = false;
      hostState.sdaPin = hostActiveSdaPin;
      hostState.sclPin = hostActiveSclPin;
      hostState.imuAddress = hostImuAddress;
      portEXIT_CRITICAL(&hostMux);

      if (!imuReady) {
        Wire.end();
        vTaskDelay(pdMS_TO_TICKS(HOST_IMU_RETRY_INTERVAL_MS));
        continue;
      }
      hostConsecutiveReadErrors = 0;
      lastWake = xTaskGetTickCount();
      Serial.println("[HOST IMU] fixed 50 Hz task active");
    }

    bool sampleOk = sampleLocalWaist();
    if (!sampleOk) {
      // A timed-out I2C transaction can consume the complete 20 ms period.
      // Explicitly unblock lower-priority snapshot/diagnostic work.
      vTaskDelay(pdMS_TO_TICKS(1));
    }
    if (hostConsecutiveReadErrors >= 50) {
      Serial.println(
          "[HOST IMU] 50 consecutive read failures; rediscovering");
      imuReady = false;
      portENTER_CRITICAL(&hostMux);
      hostState.imuReady = false;
      hostState.seen = false;
      portEXIT_CRITICAL(&hostMux);
      Wire.end();
      continue;
    }
    vTaskDelayUntil(&lastWake, period);
  }
}

// ========================= ESP-NOW receive path ========================
void handleReceivedPacket(const uint8_t *senderMac, const uint8_t *data,
                          int len) {
  if (len != static_cast<int>(sizeof(ImuPacket))) {
    portENTER_CRITICAL(&rxMux);
    invalidLengthCount++;
    portEXIT_CRITICAL(&rxMux);
    return;
  }

  ImuPacket packet;
  memcpy(&packet, data, sizeof(packet));
  if (packet.magic != PACKET_MAGIC || packet.version != PROTOCOL_VERSION) {
    portENTER_CRITICAL(&rxMux);
    invalidProtocolCount++;
    portEXIT_CRITICAL(&rxMux);
    return;
  }
  if (packet.nodeId < 1 || packet.nodeId > NODE_COUNT) {
    portENTER_CRITICAL(&rxMux);
    invalidNodeCount++;
    portEXIT_CRITICAL(&rxMux);
    return;
  }

  const uint8_t index = packet.nodeId - 1;
  if (senderMac == nullptr ||
      memcmp(senderMac, EXPECTED_NODE_MACS[index], 6) != 0) {
    portENTER_CRITICAL(&rxMux);
    invalidSenderMacCount++;
    portEXIT_CRITICAL(&rxMux);
    return;
  }
  const uint32_t receiveMs = millis();
  portENTER_CRITICAL(&rxMux);
  RxSlot &slot = rxSlots[index];
  slot.seen = true;
  slot.packet = packet;
  slot.lastReceiveMs = receiveMs;
  slot.receivedPackets++;
  if (senderMac != nullptr) {
    memcpy(slot.senderMac, senderMac, sizeof(slot.senderMac));
  }
  portEXIT_CRITICAL(&rxMux);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onDataReceive(const esp_now_recv_info_t *info, const uint8_t *data,
                   int len) {
  handleReceivedPacket(info == nullptr ? nullptr : info->src_addr, data, len);
}
#else
void onDataReceive(const uint8_t *mac, const uint8_t *data, int len) {
  handleReceivedPacket(mac, data, len);
}
#endif

bool initializeEspNow() {
  if (esp_now_init() != ESP_OK) {
    return false;
  }
  if (esp_now_set_pmk(
          reinterpret_cast<const uint8_t *>(ESPNOW_PMK)) != ESP_OK) {
    esp_now_deinit();
    return false;
  }
  for (uint8_t i = 0; i < NODE_COUNT; ++i) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, EXPECTED_NODE_MACS[i], sizeof(peer.peer_addr));
    peer.channel = 0; // Follow the hotspot/STA interface channel.
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = true;
    memcpy(peer.lmk, ESPNOW_LMK, ESP_NOW_KEY_LEN);
    esp_err_t addResult = esp_now_add_peer(&peer);
    if (addResult != ESP_OK && addResult != ESP_ERR_ESPNOW_EXIST) {
      esp_now_deinit();
      return false;
    }
  }
  if (esp_now_register_recv_cb(onDataReceive) != ESP_OK) {
    esp_now_deinit();
    return false;
  }
  Serial.printf(
      "[ESP-NOW] encrypted receiver ready peers=%u channel=%u "
      "packet_size=%u\n",
      NODE_COUNT, currentWifiChannel(), static_cast<unsigned>(sizeof(ImuPacket)));
  return true;
}

// ========================= 50 Hz latest-frame producer =================
void snapshotTask(void *parameter) {
  (void)parameter;
  const TickType_t period = pdMS_TO_TICKS(SNAPSHOT_INTERVAL_MS);
  TickType_t lastWake = xTaskGetTickCount();
  RxSlot slots[NODE_COUNT] = {};
  NodeState runtimeNodes[NODE_COUNT] = {};
  uint32_t rateBasePackets[NODE_COUNT] = {};
  uint32_t rateWindowStartMs = millis();
  uint32_t frameSequence = 0;

  for (;;) {
    vTaskDelayUntil(&lastWake, period);
    const uint32_t now = millis();

    portENTER_CRITICAL(&rxMux);
    memcpy(slots, rxSlots, sizeof(slots));
    portEXIT_CRITICAL(&rxMux);

    for (uint8_t i = 0; i < NODE_COUNT; ++i) {
      const RxSlot &slot = slots[i];
      NodeState &state = runtimeNodes[i];
      if (!slot.seen) {
        continue;
      }

      bool sameSender = state.seen &&
                        memcmp(state.senderMac, slot.senderMac,
                               sizeof(state.senderMac)) == 0;
      uint32_t receivedDelta = slot.receivedPackets - state.receivedPackets;
      if (sameSender && receivedDelta > 0) {
        uint32_t seqDelta = slot.packet.seq - state.packet.seq;
        if (seqDelta < 0x80000000UL && seqDelta > receivedDelta) {
          state.droppedPackets += seqDelta - receivedDelta;
        }
      }

      state.seen = true;
      state.packet = slot.packet;
      memcpy(state.senderMac, slot.senderMac, sizeof(state.senderMac));
      state.lastReceiveMs = slot.lastReceiveMs;
      state.receivedPackets = slot.receivedPackets;
    }

    for (uint8_t i = 0; i < NODE_COUNT; ++i) {
      runtimeNodes[i].ageMs = runtimeNodes[i].seen
                                  ? now - runtimeNodes[i].lastReceiveMs
                                  : 0;
    }

    uint32_t rateElapsedMs = now - rateWindowStartMs;
    if (rateElapsedMs >= 1000) {
      for (uint8_t i = 0; i < NODE_COUNT; ++i) {
        uint32_t delta =
            runtimeNodes[i].receivedPackets - rateBasePackets[i];
        runtimeNodes[i].rxHz =
            static_cast<float>(delta) * 1000.0f / rateElapsedMs;
        rateBasePackets[i] = runtimeNodes[i].receivedPackets;
      }
      rateWindowStartMs = now;
    }

    LatestFrame frame = {};
    frame.frameSeq = ++frameSequence;
    frame.generatedMs = now;
    copyHostState(frame.host);
    memcpy(frame.nodes, runtimeNodes, sizeof(runtimeNodes));

    if (uxQueueMessagesWaiting(latestFrameQueue) > 0) {
      portENTER_CRITICAL(&metricsMux);
      mqttMetrics.latestFrameOverwriteCount++;
      portEXIT_CRITICAL(&metricsMux);
    }
    xQueueOverwrite(latestFrameQueue, &frame);

    if (xSemaphoreTake(diagnosticFrameMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
      diagnosticFrame = frame;
      diagnosticFrameValid = true;
      xSemaphoreGive(diagnosticFrameMutex);
    }
  }
}

// ========================= Fixed-buffer MQTT JSON =======================
bool buildMqttPayload(const LatestFrame &frame, uint32_t publishSeq,
                      size_t &length) {
  const uint32_t now = millis();
  length = 0;
  const HostState &host = frame.host;
  bool hostOnline = host.seen &&
                    static_cast<uint32_t>(now - host.lastSampleMs) <=
                        NODE_OFFLINE_TIMEOUT_MS;

  if (!appendJson(
          jsonBuffer, sizeof(jsonBuffer), length,
          "{\"schema_version\":2,\"transport\":\"mqtt\","
          "\"firmware_version\":\"%s\"," 
          "\"protocol_version\":%u,\"device_mac\":\"%s\"," 
          "\"upload_seq\":%lu,\"publish_seq\":%lu,"
          "\"gateway_ts_ms\":%lu," 
          "\"snapshot_ts_ms\":%lu,\"frame_seq\":%lu," 
          "\"sample_hz\":%lu,\"upload_interval_ms\":%lu," 
          "\"host\":{\"name\":\"gateway_waist\",\"online\":%s," 
          "\"seq\":%lu,\"timestamp_ms\":%llu,\"uptime_ms\":%lu,"
          "\"time_synced\":%s,\"temperature_c\":%.2f,\"read_errors\":%lu," 
          "\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f," 
          "\"gx\":%.4f,\"gy\":%.4f,\"gz\":%.4f," 
          "\"roll_deg\":%.3f,\"pitch_deg\":%.3f," 
          "\"yaw_rate_dps\":%.3f},\"nodes\":[",
          FIRMWARE_VERSION, PROTOCOL_VERSION, gatewayMac,
          static_cast<unsigned long>(publishSeq),
          static_cast<unsigned long>(publishSeq),
          static_cast<unsigned long>(now),
          static_cast<unsigned long>(frame.generatedMs),
          static_cast<unsigned long>(frame.frameSeq),
          static_cast<unsigned long>(SENSOR_SAMPLE_HZ),
          static_cast<unsigned long>(UPLOAD_INTERVAL_MS),
          hostOnline ? "true" : "false",
          static_cast<unsigned long>(host.packet.seq),
          static_cast<unsigned long long>(host.unixTimestampMs),
          static_cast<unsigned long>(host.packet.timestampMs),
          host.unixTimeValid ? "true" : "false", host.temperatureC,
          static_cast<unsigned long>(host.readErrors), host.packet.ax,
          host.packet.ay, host.packet.az, host.packet.gx, host.packet.gy,
          host.packet.gz, host.packet.rollDeg, host.packet.pitchDeg,
          host.packet.yawRateDps)) {
    return false;
  }

  for (uint8_t i = 0; i < NODE_COUNT; ++i) {
    const NodeState &state = frame.nodes[i];
    bool online = state.seen &&
                  static_cast<uint32_t>(now - state.lastReceiveMs) <=
                      NODE_OFFLINE_TIMEOUT_MS;
    uint32_t ageMs = state.ageMs;
    char senderMac[18];
    formatMac(state.senderMac, senderMac, sizeof(senderMac));
    if (!appendJson(
            jsonBuffer, sizeof(jsonBuffer), length,
            "%s{\"id\":%u,\"name\":\"%s\",\"online\":%s," 
            "\"sender_mac\":\"%s\",\"seq\":%lu," 
            "\"source_ts_ms\":%lu,\"received_ts_ms\":%lu," 
            "\"age_ms\":%lu,\"dropped_packets\":%lu,\"rx_hz\":%.2f," 
            "\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f," 
            "\"gx\":%.4f,\"gy\":%.4f,\"gz\":%.4f," 
            "\"roll_deg\":%.3f,\"pitch_deg\":%.3f," 
            "\"yaw_rate_dps\":%.3f}",
            i == 0 ? "" : ",", i + 1, NODE_NAMES[i],
            online ? "true" : "false", senderMac,
            static_cast<unsigned long>(state.packet.seq),
            static_cast<unsigned long>(state.packet.timestampMs),
            static_cast<unsigned long>(state.lastReceiveMs),
            static_cast<unsigned long>(ageMs),
            static_cast<unsigned long>(state.droppedPackets), state.rxHz,
            state.packet.ax, state.packet.ay, state.packet.az, state.packet.gx,
            state.packet.gy, state.packet.gz, state.packet.rollDeg,
            state.packet.pitchDeg, state.packet.yawRateDps)) {
      return false;
    }
  }
  return appendJson(jsonBuffer, sizeof(jsonBuffer), length, "]}");
}

bool connectMqttBroker() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }
  if (mqttClient.connected()) {
    return true;
  }

  portENTER_CRITICAL(&metricsMux);
  mqttMetrics.connectAttempts++;
  portEXIT_CRITICAL(&metricsMux);

  char offlinePayload[128];
  snprintf(offlinePayload, sizeof(offlinePayload),
           "{\"online\":false,\"device_mac\":\"%s\"}", gatewayMac);
  bool connected = false;
  if (MQTT_USERNAME[0] != '\0') {
    connected = mqttClient.connect(
        mqttClientId, MQTT_USERNAME, MQTT_PASSWORD, mqttStatusTopic, 1, true,
        offlinePayload);
  } else {
    connected = mqttClient.connect(mqttClientId, mqttStatusTopic, 1, true,
                                   offlinePayload);
  }

  int state = mqttClient.state();
  portENTER_CRITICAL(&metricsMux);
  mqttMetrics.lastMqttState = state;
  mqttMetrics.connected = connected;
  if (connected) {
    mqttMetrics.connectSuccesses++;
  }
  portEXIT_CRITICAL(&metricsMux);

  if (!connected) {
    Serial.printf("[MQTT] connect failed state=%d\n", state);
    cloudTransport.stop();
    return false;
  }

  char onlinePayload[192];
  snprintf(onlinePayload, sizeof(onlinePayload),
           "{\"online\":true,\"device_mac\":\"%s\","
           "\"firmware_version\":\"%s\",\"protocol_version\":%u}",
           gatewayMac, FIRMWARE_VERSION, PROTOCOL_VERSION);
  if (!mqttClient.publish(mqttStatusTopic, onlinePayload, true)) {
    Serial.println("[MQTT] retained online status publish failed");
    // Drop TCP without MQTT DISCONNECT so the broker can apply the LWT.
    cloudTransport.stop();
    mqttClient.connected();
    portENTER_CRITICAL(&metricsMux);
    mqttMetrics.connected = false;
    mqttMetrics.lastMqttState = mqttClient.state();
    portEXIT_CRITICAL(&metricsMux);
    return false;
  }
  Serial.printf("[MQTT] connected broker=%s:%u data_topic=%s\n", MQTT_HOST,
                MQTT_PORT, mqttDataTopic);
  return true;
}

// ========================= Independent MQTT task =======================
void mqttPublishTask(void *parameter) {
  (void)parameter;
  uint32_t publishSequence = 0;
  TickType_t nextStart = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(UPLOAD_INTERVAL_MS);

  for (;;) {
    TickType_t nowTick = xTaskGetTickCount();
    if (static_cast<int32_t>(nowTick - nextStart) < 0) {
      vTaskDelay(nextStart - nowTick);
      nowTick = xTaskGetTickCount();
    } else if (static_cast<TickType_t>(nowTick - nextStart) >= period) {
      nextStart = nowTick;
    }
    nextStart += period;

    if (mqttClient.connected()) {
      mqttClient.loop();
    }

    LatestFrame frame;
    if (xQueueReceive(latestFrameQueue, &frame, 0) != pdTRUE) {
      continue;
    }

    bool success = false;
    int mqttState = -1000; // Local code: Wi-Fi unavailable.
    uint32_t durationMs = 0;

    portENTER_CRITICAL(&metricsMux);
    mqttMetrics.publishAttempts++;
    portEXIT_CRITICAL(&metricsMux);

    size_t jsonLength = 0;
    if (!gatewayMacValid ||
        !buildMqttPayload(frame, ++publishSequence, jsonLength)) {
      mqttState = gatewayMacValid ? -1001 : -1003;
      portENTER_CRITICAL(&metricsMux);
      if (mqttState == -1001) mqttMetrics.jsonOverflowCount++;
      portEXIT_CRITICAL(&metricsMux);
    } else if (WiFi.status() == WL_CONNECTED) {
      uint32_t started = millis();
      if (connectMqttBroker()) {
        success = mqttClient.publish(
            mqttDataTopic, reinterpret_cast<const uint8_t *>(jsonBuffer),
            static_cast<unsigned int>(jsonLength), false);
        mqttState = mqttClient.state();
        mqttClient.loop();
      } else {
        mqttState = mqttClient.state();
      }
      durationMs = millis() - started;
    }

    if (!success && mqttClient.connected()) {
      // An MQTT DISCONNECT suppresses the LWT. Closing TCP lets the broker
      // publish the retained offline status instead.
      cloudTransport.stop();
    }

    uint32_t backoffMs = 0;
    bool mqttConnectedNow = mqttClient.connected();
    if (mqttState > -1000) {
      mqttState = mqttClient.state();
    }
    portENTER_CRITICAL(&metricsMux);
    mqttMetrics.lastMqttState = mqttState;
    mqttMetrics.connected = mqttConnectedNow;
    mqttMetrics.lastPublishDurationMs = durationMs;
    if (durationMs > UPLOAD_INTERVAL_MS) {
      mqttMetrics.publishOverrun++;
    }
    if (success) {
      mqttMetrics.publishSuccesses++;
      mqttMetrics.consecutiveFailures = 0;
      mqttMetrics.lastPublishSuccessMs = millis();
    } else {
      mqttMetrics.publishFailures++;
      mqttMetrics.consecutiveFailures++;
      uint32_t index = mqttMetrics.consecutiveFailures - 1;
      if (index >= sizeof(MQTT_BACKOFF_MS) / sizeof(MQTT_BACKOFF_MS[0])) {
        index = sizeof(MQTT_BACKOFF_MS) / sizeof(MQTT_BACKOFF_MS[0]) - 1;
      }
      backoffMs = MQTT_BACKOFF_MS[index];
    }
    portEXIT_CRITICAL(&metricsMux);

    if (!success) {
      vTaskDelay(pdMS_TO_TICKS(backoffMs));
      nextStart = xTaskGetTickCount();
    }
  }
}

// ========================= Wi-Fi and diagnostics =======================
void printWifiStatusAndChannelCheck() {
  bool connected = WiFi.status() == WL_CONNECTED;
  IPAddress ip = WiFi.localIP();
  uint8_t actualChannel = currentWifiChannel();
  Serial.println("[WIFI]");
  Serial.printf("CONNECTED=%s\n", connected ? "YES" : "NO");
  Serial.printf("IP=%u.%u.%u.%u\n", ip[0], ip[1], ip[2], ip[3]);
  Serial.printf("RSSI=%d\n", connected ? WiFi.RSSI() : 0);
  Serial.printf("CHANNEL=%u\n", actualChannel);
  Serial.printf("ESP_NOW_CHANNEL=%u (follows STA/hotspot)\n", actualChannel);
}

void startWifiNonBlocking() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // 同步 UTC Unix 时间；不改变采样任务，未同步时帧会明确标记。
  configTime(0, 0, "ntp.aliyun.com", "ntp1.aliyun.com", "pool.ntp.org");
  previousWifiConnected = false;
  lastKnownWifiChannel = 0;
  lastWifiReconnectAttemptMs = millis();
}

bool waitForInitialWifiConnection() {
  uint32_t startedMs = millis();
  while (WiFi.status() != WL_CONNECTED &&
         static_cast<uint32_t>(millis() - startedMs) <
             WIFI_INITIAL_CONNECT_TIMEOUT_MS) {
    delay(50);
  }
  bool connected = WiFi.status() == WL_CONNECTED;
  if (!connected) {
    Serial.printf(
        "[WIFI] initial hotspot timeout after %lu ms; background reconnect "
        "will continue and ESP-NOW will follow the STA channel\n",
        static_cast<unsigned long>(WIFI_INITIAL_CONNECT_TIMEOUT_MS));
  }
  previousWifiConnected = connected;
  lastKnownWifiChannel = connected ? currentWifiChannel() : 0;
  printWifiStatusAndChannelCheck();
  return connected;
}

void maintainWifiNonBlocking() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected) {
    uint8_t actualChannel = currentWifiChannel();
    if (!previousWifiConnected || actualChannel != lastKnownWifiChannel) {
      previousWifiConnected = true;
      lastKnownWifiChannel = actualChannel;
      Serial.printf(
          "[WIFI] hotspot active; STA, ESP-NOW and MQTT share channel=%u\n",
          actualChannel);
      printWifiStatusAndChannelCheck();
    }
    return;
  }

  if (previousWifiConnected) {
    Serial.printf("[WIFI] hotspot lost (previous channel=%u); reconnecting\n",
                  lastKnownWifiChannel);
    previousWifiConnected = false;
    lastKnownWifiChannel = 0;
  }

  uint32_t now = millis();
  if (static_cast<uint32_t>(now - lastWifiReconnectAttemptMs) >=
      WIFI_RECONNECT_INTERVAL_MS) {
    lastWifiReconnectAttemptMs = now;
    wl_status_t status = WiFi.status();
    bool started = WiFi.reconnect();
    Serial.printf("[WIFI] reconnect attempt status=%d started=%s\n",
                  static_cast<int>(status), started ? "YES" : "NO");
  }
}

bool copyDiagnosticFrame(LatestFrame &out) {
  if (xSemaphoreTake(diagnosticFrameMutex, pdMS_TO_TICKS(5)) != pdTRUE) {
    return false;
  }
  bool valid = diagnosticFrameValid;
  if (valid) out = diagnosticFrame;
  xSemaphoreGive(diagnosticFrameMutex);
  return valid;
}

void printStatus() {
  LatestFrame frame = {};
  if (!copyDiagnosticFrame(frame)) {
    Serial.println("[STATUS] latest frame not ready");
    return;
  }
  MqttMetrics metrics;
  copyMqttMetrics(metrics);

  uint32_t now = millis();
  uint32_t elapsed = lastStatusMs == 0 ? STATUS_INTERVAL_MS : now - lastStatusMs;
  if (elapsed == 0) elapsed = 1;
  float hostSampleHz =
      static_cast<float>(frame.host.totalSamples - lastStatusHostSamples) *
      1000.0f / elapsed;
  float actualPublishHz =
      static_cast<float>(metrics.publishSuccesses -
                         lastStatusPublishSuccesses) *
      1000.0f / elapsed;
  lastStatusHostSamples = frame.host.totalSamples;
  lastStatusPublishSuccesses = metrics.publishSuccesses;

  int32_t successAge = metrics.publishSuccesses == 0
                           ? -1
                           : static_cast<int32_t>(now -
                                                  metrics.lastPublishSuccessMs);
  int32_t rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  uint32_t invalidLength;
  uint32_t invalidProtocol;
  uint32_t invalidNode;
  uint32_t invalidSenderMac;
  portENTER_CRITICAL(&rxMux);
  invalidLength = invalidLengthCount;
  invalidProtocol = invalidProtocolCount;
  invalidNode = invalidNodeCount;
  invalidSenderMac = invalidSenderMacCount;
  portEXIT_CRITICAL(&rxMux);

  Serial.printf(
      "[STATUS] fw=%s mac=%s host_sample_hz=%.1f actual_publish_hz=%.1f "
      "mqtt=%s mqtt_state=%d publish_duration_ms=%lu "
      "last_publish_success_age_ms=%ld publish_overrun=%lu "
      "latest_frame_overwrite_count=%lu "
      "wifi=%s rssi=%ld channel=%u free_heap=%lu invalid_len=%lu "
      "invalid_proto=%lu invalid_id=%lu invalid_mac=%lu\n",
      FIRMWARE_VERSION, gatewayMac, hostSampleHz, actualPublishHz,
      metrics.connected ? "CONNECTED" : "DISCONNECTED",
      metrics.lastMqttState,
      static_cast<unsigned long>(metrics.lastPublishDurationMs),
      static_cast<long>(successAge),
      static_cast<unsigned long>(metrics.publishOverrun),
      static_cast<unsigned long>(metrics.latestFrameOverwriteCount),
      WiFi.status() == WL_CONNECTED ? "OK" : "NO", static_cast<long>(rssi),
      currentWifiChannel(), static_cast<unsigned long>(ESP.getFreeHeap()),
      static_cast<unsigned long>(invalidLength),
      static_cast<unsigned long>(invalidProtocol),
      static_cast<unsigned long>(invalidNode),
      static_cast<unsigned long>(invalidSenderMac));

  bool hostOnline = frame.host.seen &&
                    static_cast<uint32_t>(now - frame.host.lastSampleMs) <=
                        NODE_OFFLINE_TIMEOUT_MS;
  Serial.printf(
      "  HOST name=gateway_waist online=%s seq=%lu age_ms=%lu imu=%s "
      "i2c=(SDA%d,SCL%d,0x%02X) read_err=%lu\n",
      hostOnline ? "YES" : "NO",
      static_cast<unsigned long>(frame.host.packet.seq),
      static_cast<unsigned long>(frame.host.seen
                                     ? now - frame.host.lastSampleMs
                                     : 0),
      frame.host.imuReady ? "READY" : "SEARCH", frame.host.sdaPin,
      frame.host.sclPin, frame.host.imuAddress,
      static_cast<unsigned long>(frame.host.readErrors));

  for (uint8_t i = 0; i < NODE_COUNT; ++i) {
    const NodeState &state = frame.nodes[i];
    bool online = state.seen &&
                  static_cast<uint32_t>(now - state.lastReceiveMs) <=
                      NODE_OFFLINE_TIMEOUT_MS;
    uint32_t ageMs = state.ageMs;
    char senderMac[18];
    formatMac(state.senderMac, senderMac, sizeof(senderMac));
    Serial.printf(
        "  node=%u name=%s online=%s sender=%s seq=%lu rx_hz=%.1f "
        "age_ms=%lu lost=%lu\n",
        i + 1, NODE_NAMES[i], online ? "YES" : "NO", senderMac,
        static_cast<unsigned long>(state.packet.seq), state.rxHz,
        static_cast<unsigned long>(ageMs),
        static_cast<unsigned long>(state.droppedPackets));
  }
}

bool createTasks() {
  latestFrameQueue = xQueueCreate(1, sizeof(LatestFrame));
  diagnosticFrameMutex = xSemaphoreCreateMutex();
  if (latestFrameQueue == nullptr || diagnosticFrameMutex == nullptr) {
    return false;
  }
  if (xTaskCreatePinnedToCore(hostSamplingTask, "waist_imu_50hz", 6144,
                              nullptr, 4, &hostSamplingTaskHandle,
                              SENSOR_TASK_CORE) != pdPASS) {
    return false;
  }
  if (xTaskCreatePinnedToCore(snapshotTask, "snapshot_50hz", 6144, nullptr,
                              3, &snapshotTaskHandle,
                              SNAPSHOT_TASK_CORE) != pdPASS) {
    return false;
  }
  if (xTaskCreatePinnedToCore(mqttPublishTask, "mqtt_latest_20hz", 10240,
                              nullptr, 1, &mqttPublishTaskHandle,
                              MQTT_TASK_CORE) != pdPASS) {
    return false;
  }
  return true;
}

// ========================= Arduino entry points ========================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.printf("=== Roller Skating IMU Gateway v%s ===\n", FIRMWARE_VERSION);

  WiFi.mode(WIFI_STA);
  gatewayMacValid = loadGatewayMac() && gatewayMacMatchesDeployment();
  Serial.printf("[Gateway] factory STA MAC=%s valid=%s protocol=%u\n",
                gatewayMac, gatewayMacValid ? "YES" : "NO",
                PROTOCOL_VERSION);
  if (!gatewayMacValid) {
    char expectedMac[18];
    formatMac(EXPECTED_GATEWAY_STA_MAC, expectedMac, sizeof(expectedMac));
    Serial.printf("[FATAL] GATEWAY_FIRMWARE_MAC_MISMATCH expected=%s "
                  "actual=%s\n",
                  expectedMac, gatewayMac);
    for (;;) delay(1000);
  }

  buildMqttIdentity();
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(MQTT_KEEPALIVE_SECONDS);
  mqttClient.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SECONDS);
  if (!mqttClient.setBufferSize(MQTT_PACKET_BUFFER_SIZE)) {
    Serial.println("[FATAL] cannot allocate MQTT packet buffer");
    for (;;) delay(1000);
  }

  startWifiNonBlocking();
  if (!initializeEspNow()) {
    Serial.println("[FATAL] ESP-NOW initialization failed");
    delay(3000);
    ESP.restart();
  }
  if (!createTasks()) {
    Serial.println("[FATAL] FreeRTOS task/queue creation failed");
    delay(3000);
    ESP.restart();
  }
  // Sampling and snapshot tasks are already active while this bounded initial
  // hotspot wait runs, so a missing hotspot no longer delays the 50 Hz IMU.
  waitForInitialWifiConnection();

  Serial.printf(
      "[Cloud] MQTT broker=%s:%u data_topic=%s status_topic=%s "
      "target_period_ms=%lu\n",
      MQTT_HOST, MQTT_PORT, mqttDataTopic, mqttStatusTopic,
      static_cast<unsigned long>(UPLOAD_INTERVAL_MS));
  lastStatusMs = millis();
}

void loop() {
  maintainWifiNonBlocking();
  uint32_t now = millis();
  if (PRINT_WAIST_RAW_FRAMES) {
    HostState host;
    copyHostState(host);
    if (host.seen && host.packet.seq != lastPrintedHostSequence) {
      lastPrintedHostSequence = host.packet.seq;
      Serial.printf(
          "[WAIST_RAW] ts_ms=%llu time_synced=%s seq=%lu "
          "ax=%.6f ay=%.6f az=%.6f gx=%.6f gy=%.6f gz=%.6f temp_c=%.2f\n",
          static_cast<unsigned long long>(host.unixTimestampMs),
          host.unixTimeValid ? "YES" : "NO",
          static_cast<unsigned long>(host.packet.seq), host.packet.ax,
          host.packet.ay, host.packet.az, host.packet.gx, host.packet.gy,
          host.packet.gz, host.temperatureC);
    }
  }
  if (static_cast<uint32_t>(now - lastStatusMs) >= STATUS_INTERVAL_MS) {
    printStatus();
    lastStatusMs = now;
  }
  delay(10);
}
