#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <sys/time.h>
#include <time.h>

// ============================================================
// Right Ankle ICM20602 standalone test
// - 50 Hz acquisition
// - ICM20602 hardware DLPF only
// - startup gyroscope bias calibration
// - raw six-axis + die temperature + timestamp over Serial
// - MQTT batch upload; no ESP-NOW or software attitude/filter algorithm
// ============================================================

constexpr char WIFI_SSID[] = "星野与我";
constexpr char WIFI_PASSWORD[] = "hoshino521";
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 10000;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 5000;
constexpr uint32_t MQTT_RECONNECT_INTERVAL_MS = 3000;
constexpr char MQTT_HOST[] = "82.156.18.205";
constexpr uint16_t MQTT_PORT = 1883;
constexpr char MQTT_TOPIC[] = "sensor/imu/frames";
constexpr char MQTT_COMMAND_TOPIC[] = "sensor/imu/commands/right_ankle";
// Factory STA MAC of the right ankle ESP32-S3, compact lowercase form.
constexpr char DEVICE_ID[] = "d40592_49ada4";
constexpr char NODE_NAME[] = "right_ankle";
constexpr char FIRMWARE_BUILD[] = "right_ankle-static-v7-cal-guard-20260720";
constexpr bool SERIAL_RAW_DEBUG = false;
constexpr bool SERIAL_STATUS_DEBUG = false;
constexpr uint8_t MQTT_BATCH_FRAMES = 25;
constexpr size_t MQTT_PACKET_BUFFER_SIZE = 12288;

constexpr uint32_t SAMPLE_RATE_HZ = 50;
constexpr uint32_t SAMPLE_PERIOD_US = 1000000UL / SAMPLE_RATE_HZ;
constexpr uint32_t STATUS_PERIOD_MS = 5000;

constexpr uint8_t ICM20602_ADDRESS_LOW = 0x68;
constexpr uint8_t ICM20602_ADDRESS_HIGH = 0x69;
constexpr uint8_t ICM20602_WHO_AM_I_VALUE = 0x12;
constexpr uint32_t I2C_CLOCK_HZ = 100000;
constexpr uint32_t I2C_TIMEOUT_MS = 20;

constexpr uint8_t SAMPLE_RATE_DIVIDER = 19;
constexpr uint8_t GYRO_DLPF_CONFIG = 0x04;
constexpr uint8_t ACCEL_DLPF_CONFIG = 0x04;
constexpr float ACCEL_LSB_PER_G = 16384.0f;
constexpr float GYRO_LSB_PER_DPS = 131.0f;
constexpr uint16_t GYRO_CALIBRATION_SAMPLES = 150;
constexpr uint32_t GYRO_CALIBRATION_SETTLE_MS = 1000;
constexpr float CAL_MAX_GYRO_NORM_DPS = 3.0f;
constexpr float CAL_MAX_GYRO_STD_DPS = 0.15f;
constexpr float CAL_MIN_ACCEL_NORM_G = 0.92f;
constexpr float CAL_MAX_ACCEL_NORM_G = 1.08f;
constexpr float CAL_MAX_ACCEL_NORM_STD_G = 0.02f;

struct I2cCandidate {
  int sda;
  int scl;
  const char *name;
};

constexpr I2cCandidate I2C_CANDIDATES[] = {
    {12, 13, "project_12_13"},
    {8, 9, "esp32s3_default_8_9"},
};

struct ImuSample {
  float ax;
  float ay;
  float az;
  float gx;
  float gy;
  float gz;
  float temperatureC;
};

struct MqttFrame {
  uint32_t sequence;
  uint32_t uptimeMs;
  uint64_t unixTimestampMs;
  bool timeSynced;
  ImuSample sample;
};

struct MqttBatch {
  uint8_t count;
  MqttFrame frames[MQTT_BATCH_FRAMES];
};

uint8_t imuAddress = 0;
int activeSda = -1;
int activeScl = -1;
float gyroOffsetX = 0.0f;
float gyroOffsetY = 0.0f;
float gyroOffsetZ = 0.0f;
bool gyroCalibrationValid = false;
float calibrationGyroStdMax = 0.0f;
float calibrationAccelNormMean = 0.0f;
float calibrationAccelNormStd = 0.0f;
float calibrationTemperatureC = 0.0f;
uint32_t sequenceNumber = 0;
uint32_t nextSampleUs = 0;
uint32_t statusStartedMs = 0;
uint32_t statusFrameCount = 0;
uint32_t readErrorCount = 0;
uint32_t missedDeadlineCount = 0;
uint32_t mqttDroppedBatchCount = 0;
uint32_t mqttPublishedBatchCount = 0;
uint32_t mqttPublishFailureCount = 0;
QueueHandle_t mqttQueue = nullptr;
MqttBatch pendingBatch{};
WiFiClient mqttTransport;
PubSubClient mqttClient(mqttTransport);
uint32_t lastWifiReconnectAttemptMs = 0;
uint32_t lastMqttReconnectAttemptMs = 0;
uint32_t lastMqttFailureLogMs = 0;
bool ntpStarted = false;
volatile bool gyroCalibrationRequested = false;
volatile bool gyroCalibrationClearRequested = false;

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(imuAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

bool readRegisterAt(uint8_t address, uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, static_cast<uint8_t>(1), true) != 1) return false;
  value = static_cast<uint8_t>(Wire.read());
  return true;
}

bool readRegister(uint8_t reg, uint8_t &value) {
  return readRegisterAt(imuAddress, reg, value);
}

bool probeAddress(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission(true) == 0;
}

bool selectImuBus() {
  for (const I2cCandidate &candidate : I2C_CANDIDATES) {
    Wire.end();
    delay(10);
    Serial.printf("[I2C] trying %s SDA=%d SCL=%d\n", candidate.name,
                  candidate.sda, candidate.scl);
    if (!Wire.begin(candidate.sda, candidate.scl, I2C_CLOCK_HZ)) continue;
    Wire.setTimeOut(I2C_TIMEOUT_MS);
    delay(50);

    const uint8_t addresses[] = {ICM20602_ADDRESS_HIGH,
                                 ICM20602_ADDRESS_LOW};
    for (uint8_t address : addresses) {
      if (!probeAddress(address)) continue;
      uint8_t whoAmI = 0xFF;
      if (!readRegisterAt(address, 0x75, whoAmI)) continue;
      Serial.printf("[I2C] address=0x%02X WHO_AM_I=0x%02X\n", address,
                    whoAmI);
      if (whoAmI == ICM20602_WHO_AM_I_VALUE) {
        imuAddress = address;
        activeSda = candidate.sda;
        activeScl = candidate.scl;
        return true;
      }
    }
  }
  return false;
}

bool writeAndVerify(uint8_t reg, uint8_t expected, const char *name) {
  for (uint8_t attempt = 0; attempt < 3; ++attempt) {
    uint8_t actual = 0xFF;
    if (writeRegister(reg, expected) && readRegister(reg, actual) &&
        actual == expected) {
      Serial.printf("[IMU] %s(0x%02X)=0x%02X verified\n", name, reg, actual);
      return true;
    }
    delay(5);
  }
  uint8_t actual = 0xFF;
  readRegister(reg, actual);
  Serial.printf("[IMU] %s verify FAILED expected=0x%02X actual=0x%02X\n",
                name, expected, actual);
  return false;
}

bool initializeImu() {
  if (!selectImuBus()) {
    Serial.println("[FATAL] ICM20602 not found at 0x69/0x68 on 12/13 or 8/9");
    return false;
  }
  Serial.printf("[IMU] found SDA=%d SCL=%d address=0x%02X\n", activeSda,
                activeScl, imuAddress);

  if (!writeRegister(0x6B, 0x80)) return false;
  delay(100);
  bool ok =
      writeAndVerify(0x6B, 0x01, "PWR_MGMT_1") &&
      writeAndVerify(0x6C, 0x00, "PWR_MGMT_2") &&
      writeAndVerify(0x19, SAMPLE_RATE_DIVIDER, "SMPLRT_DIV") &&
      writeAndVerify(0x1A, GYRO_DLPF_CONFIG, "CONFIG") &&
      writeAndVerify(0x1B, 0x00, "GYRO_CONFIG") &&
      writeAndVerify(0x1C, 0x00, "ACCEL_CONFIG") &&
      writeAndVerify(0x1D, ACCEL_DLPF_CONFIG, "ACCEL_CONFIG2");
  if (ok) {
    Serial.println("[IMU] hardware DLPF enabled: gyro~20Hz accel~21.2Hz");
  }
  return ok;
}

int16_t readInt16() {
  uint16_t high = static_cast<uint8_t>(Wire.read());
  uint16_t low = static_cast<uint8_t>(Wire.read());
  return static_cast<int16_t>((high << 8) | low);
}

bool readImu(ImuSample &sample) {
  Wire.beginTransmission(imuAddress);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(imuAddress, static_cast<uint8_t>(14), true) != 14)
    return false;

  int16_t rawAx = readInt16();
  int16_t rawAy = readInt16();
  int16_t rawAz = readInt16();
  int16_t rawTemperature = readInt16();
  int16_t rawGx = readInt16();
  int16_t rawGy = readInt16();
  int16_t rawGz = readInt16();

  sample.ax = rawAx / ACCEL_LSB_PER_G;
  sample.ay = rawAy / ACCEL_LSB_PER_G;
  sample.az = rawAz / ACCEL_LSB_PER_G;
  sample.gx = rawGx / GYRO_LSB_PER_DPS;
  sample.gy = rawGy / GYRO_LSB_PER_DPS;
  sample.gz = rawGz / GYRO_LSB_PER_DPS;
  sample.temperatureC = rawTemperature / 326.8f + 25.0f;
  return true;
}

bool calibrateGyroscope() {
  Serial.println("[CAL] checking stationary state before applying gyro bias");
  delay(GYRO_CALIBRATION_SETTLE_MS);
  double sumX = 0.0, sumY = 0.0, sumZ = 0.0;
  double sumSqX = 0.0, sumSqY = 0.0, sumSqZ = 0.0;
  double sumAccNorm = 0.0, sumSqAccNorm = 0.0;
  double sumTemperature = 0.0;
  uint16_t valid = 0;
  for (uint16_t i = 0; i < GYRO_CALIBRATION_SAMPLES; ++i) {
    ImuSample sample;
    if (readImu(sample)) {
      sumX += sample.gx;
      sumY += sample.gy;
      sumZ += sample.gz;
      sumSqX += sample.gx * sample.gx;
      sumSqY += sample.gy * sample.gy;
      sumSqZ += sample.gz * sample.gz;
      const float accNorm =
          sqrtf(sample.ax * sample.ax + sample.ay * sample.ay +
                sample.az * sample.az);
      sumAccNorm += accNorm;
      sumSqAccNorm += accNorm * accNorm;
      sumTemperature += sample.temperatureC;
      valid++;
    }
    delay(20);
  }
  if (valid < GYRO_CALIBRATION_SAMPLES * 9 / 10) return false;
  const float meanX = static_cast<float>(sumX / valid);
  const float meanY = static_cast<float>(sumY / valid);
  const float meanZ = static_cast<float>(sumZ / valid);
  const float stdX = sqrtf(
      fmaxf(0.0f, static_cast<float>(sumSqX / valid) - meanX * meanX));
  const float stdY = sqrtf(
      fmaxf(0.0f, static_cast<float>(sumSqY / valid) - meanY * meanY));
  const float stdZ = sqrtf(
      fmaxf(0.0f, static_cast<float>(sumSqZ / valid) - meanZ * meanZ));
  calibrationGyroStdMax = fmaxf(stdX, fmaxf(stdY, stdZ));
  calibrationAccelNormMean = static_cast<float>(sumAccNorm / valid);
  calibrationAccelNormStd = sqrtf(fmaxf(
      0.0f, static_cast<float>(sumSqAccNorm / valid) -
                calibrationAccelNormMean * calibrationAccelNormMean));
  calibrationTemperatureC = static_cast<float>(sumTemperature / valid);
  const float gyroNorm =
      sqrtf(meanX * meanX + meanY * meanY + meanZ * meanZ);
  gyroCalibrationValid =
      gyroNorm <= CAL_MAX_GYRO_NORM_DPS &&
      calibrationGyroStdMax <= CAL_MAX_GYRO_STD_DPS &&
      calibrationAccelNormMean >= CAL_MIN_ACCEL_NORM_G &&
      calibrationAccelNormMean <= CAL_MAX_ACCEL_NORM_G &&
      calibrationAccelNormStd <= CAL_MAX_ACCEL_NORM_STD_G;
  if (!gyroCalibrationValid) {
    gyroOffsetX = gyroOffsetY = gyroOffsetZ = 0.0f;
    Serial.printf(
        "[CAL] rejected: gyro_norm=%.3f gyro_std_max=%.3f "
        "acc_norm=%.3f acc_std=%.4f\n",
        gyroNorm, calibrationGyroStdMax, calibrationAccelNormMean,
        calibrationAccelNormStd);
    return false;
  }
  gyroOffsetX = meanX;
  gyroOffsetY = meanY;
  gyroOffsetZ = meanZ;
  Serial.printf(
      "[CAL] accepted offsets=(%.6f,%.6f,%.6f) gyro_std_max=%.4f "
      "acc_norm=%.4f temp=%.2fC\n",
      gyroOffsetX, gyroOffsetY, gyroOffsetZ, calibrationGyroStdMax,
      calibrationAccelNormMean, calibrationTemperatureC);
  return true;
}

void onMqttMessage(char *topic, byte *payload, unsigned int length) {
  if (strcmp(topic, MQTT_COMMAND_TOPIC) != 0 || length == 0) return;
  String command;
  command.reserve(length);
  for (unsigned int i = 0; i < length; ++i) command += static_cast<char>(payload[i]);
  if (command.indexOf("\"command\":\"calibrate_gyro\"") >= 0) {
    gyroCalibrationRequested = true;
    Serial.println("[CAL] user-triggered calibration requested");
  } else if (command.indexOf("\"command\":\"clear_gyro_calibration\"") >= 0) {
    gyroCalibrationClearRequested = true;
  }
}

void startTimeSynchronization() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(100);
  }
  if (WiFi.status() == WL_CONNECTED) {
    configTime(0, 0, "ntp.aliyun.com", "ntp1.aliyun.com", "pool.ntp.org");
    ntpStarted = true;
    Serial.printf("[TIME] WiFi connected IP=%s; NTP started\n",
                  WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("[TIME] WiFi unavailable after %lu ms; status=%d; "
                  "background reconnect enabled\n",
                  static_cast<unsigned long>(WIFI_CONNECT_TIMEOUT_MS),
                  static_cast<int>(WiFi.status()));
  }
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!ntpStarted) {
      configTime(0, 0, "ntp.aliyun.com", "ntp1.aliyun.com", "pool.ntp.org");
      ntpStarted = true;
      Serial.printf("[WIFI] connected IP=%s; NTP started\n",
                    WiFi.localIP().toString().c_str());
    }
    return;
  }
  uint32_t now = millis();
  if (now - lastWifiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) return;
  lastWifiReconnectAttemptMs = now;
  Serial.printf("[WIFI] reconnecting to SSID=%s status=%d\n", WIFI_SSID,
                static_cast<int>(WiFi.status()));
  WiFi.disconnect(false, false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

uint64_t unixTimestampMs(bool &synced) {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  synced = tv.tv_sec >= 1704067200;
  if (!synced) return 0;
  return static_cast<uint64_t>(tv.tv_sec) * 1000ULL + tv.tv_usec / 1000ULL;
}

bool connectMqtt() {
  if (mqttClient.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;
  uint32_t now = millis();
  if (now - lastMqttReconnectAttemptMs < MQTT_RECONNECT_INTERVAL_MS)
    return false;
  lastMqttReconnectAttemptMs = now;
  String clientId = "right_ankle_test_" + WiFi.macAddress();
  clientId.replace(":", "");
  bool connected = mqttClient.connect(clientId.c_str());
  if (connected) {
    mqttClient.subscribe(MQTT_COMMAND_TOPIC, 1);
    Serial.printf("[MQTT] connected broker=%s:%u topic=%s\n", MQTT_HOST,
                  MQTT_PORT, MQTT_TOPIC);
  } else {
    Serial.printf("[MQTT] connect failed state=%d\n", mqttClient.state());
  }
  return connected;
}

bool publishMqttBatch(const MqttBatch &batch) {
  if (batch.count == 0 || !connectMqtt()) return false;
  char payload[MQTT_PACKET_BUFFER_SIZE];
  size_t used = 0;
  int written = snprintf(
      payload, sizeof(payload),
      "{\"source\":\"right_ankle_imu_test\",\"device_id\":\"%s\","
      "\"sample_rate_hz\":50,"
      "\"filter_status\":\"%s\","
      "\"calibration\":{\"status\":\"%s\",\"sample_count\":%u,"
      "\"gyro_offset\":[%.6f,%.6f,%.6f],\"gyro_std_max\":%.6f,"
      "\"acc_norm_mean\":%.6f,\"acc_norm_std\":%.6f,"
      "\"temperature_c\":%.2f},\"frames\":[",
      DEVICE_ID,
      gyroCalibrationValid ? "hardware_dlpf_startup_bias"
                           : "hardware_dlpf_uncalibrated",
      gyroCalibrationValid ? "ready" : "invalid",
      GYRO_CALIBRATION_SAMPLES, gyroOffsetX, gyroOffsetY, gyroOffsetZ,
      calibrationGyroStdMax, calibrationAccelNormMean,
      calibrationAccelNormStd, calibrationTemperatureC);
  if (written < 0 || static_cast<size_t>(written) >= sizeof(payload))
    return false;
  used = static_cast<size_t>(written);

  for (uint8_t i = 0; i < batch.count; ++i) {
    const MqttFrame &f = batch.frames[i];
    written = snprintf(
        payload + used, sizeof(payload) - used,
        "%s[%lu,%llu,%s,%lu,%.2f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f]",
        i == 0 ? "" : ",",
        static_cast<unsigned long>(f.uptimeMs),
        static_cast<unsigned long long>(f.unixTimestampMs),
        f.timeSynced ? "true" : "false",
        static_cast<unsigned long>(f.sequence), f.sample.temperatureC,
        f.sample.ax, f.sample.ay, f.sample.az, f.sample.gx, f.sample.gy,
        f.sample.gz);
    if (written < 0 ||
        static_cast<size_t>(written) >= sizeof(payload) - used)
      return false;
    used += static_cast<size_t>(written);
  }
  if (used + 3 >= sizeof(payload)) return false;
  payload[used++] = ']';
  payload[used++] = '}';
  payload[used] = '\0';
  return mqttClient.publish(MQTT_TOPIC,
                            reinterpret_cast<const uint8_t *>(payload),
                            static_cast<unsigned int>(used), false);
}

void mqttPublishTask(void *) {
  MqttBatch batch;
  for (;;) {
    maintainWiFi();
    if (mqttClient.connected()) mqttClient.loop();
    if (xQueueReceive(mqttQueue, &batch, pdMS_TO_TICKS(100)) == pdTRUE) {
      bool published = false;
      for (uint8_t attempt = 0; attempt < 3 && !published; ++attempt) {
        published = publishMqttBatch(batch);
        if (!published) {
          mqttPublishFailureCount++;
          if (mqttClient.connected()) mqttClient.disconnect();
          vTaskDelay(pdMS_TO_TICKS(150 * (attempt + 1)));
          maintainWiFi();
        }
      }
      if (!published) {
        uint32_t now = millis();
        if (now - lastMqttFailureLogMs >= 5000) {
          lastMqttFailureLogMs = now;
          Serial.printf("[MQTT] publish pending: wifi_status=%d mqtt_state=%d\n",
                        static_cast<int>(WiFi.status()), mqttClient.state());
        }
      } else {
        mqttPublishedBatchCount++;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== RIGHT ANKLE ICM20602 STANDALONE TEST ===");
  Serial.printf("[BUILD] %s device_id=%s\n", FIRMWARE_BUILD, DEVICE_ID);
  Serial.println("[MODE] 50Hz, hardware DLPF only, no software filter");

  if (!initializeImu()) {
    Serial.println("[FATAL] IMU initialization failed");
    while (true) delay(1000);
  }
  Serial.println("[CAL] startup calibration disabled; waiting for UI command");
  startTimeSynchronization();
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(MQTT_PACKET_BUFFER_SIZE);
  mqttQueue = xQueueCreate(20, sizeof(MqttBatch));
  if (mqttQueue == nullptr ||
      xTaskCreatePinnedToCore(mqttPublishTask, "mqtt_publish", 24576, nullptr,
                              1, nullptr, 0) != pdPASS) {
    Serial.println("[FATAL] MQTT queue/task creation failed");
    while (true) delay(1000);
  }
  nextSampleUs = micros() + SAMPLE_PERIOD_US;
  statusStartedMs = millis();
  Serial.println("[READY] open Serial Monitor at 115200 baud");
}

void loop() {
  if (gyroCalibrationClearRequested) {
    gyroCalibrationClearRequested = false;
    gyroOffsetX = gyroOffsetY = gyroOffsetZ = 0.0f;
    gyroCalibrationValid = false;
    Serial.println("[CAL] volatile calibration cleared for new UI session");
  }
  if (gyroCalibrationRequested) {
    gyroCalibrationRequested = false;
    Serial.println("[CAL] starting user-triggered calibration; keep still");
    const float previousX = gyroOffsetX, previousY = gyroOffsetY,
                previousZ = gyroOffsetZ;
    const bool previousValid = gyroCalibrationValid;
    const bool accepted = calibrateGyroscope();
    if (!accepted && previousValid) {
      gyroOffsetX = previousX; gyroOffsetY = previousY; gyroOffsetZ = previousZ;
      gyroCalibrationValid = true;
      Serial.println("[CAL] rejected; previous valid offset restored");
    }
    Serial.printf("[CAL] user-triggered calibration %s\n",
                  accepted ? "accepted" : "rejected");
    nextSampleUs = micros() + SAMPLE_PERIOD_US;
  }
  uint32_t nowUs = micros();
  if (static_cast<int32_t>(nowUs - nextSampleUs) >= 0) {
    nextSampleUs += SAMPLE_PERIOD_US;
    if (static_cast<int32_t>(nowUs - nextSampleUs) >= 0) {
      missedDeadlineCount++;
      nextSampleUs = nowUs + SAMPLE_PERIOD_US;
    }

    ImuSample sample;
    if (readImu(sample)) {
      sample.gx -= gyroOffsetX;
      sample.gy -= gyroOffsetY;
      sample.gz -= gyroOffsetZ;
      bool synced = false;
      uint64_t unixTs = unixTimestampMs(synced);
      uint32_t uptimeMs = millis();
      sequenceNumber++;
      statusFrameCount++;
      MqttFrame &mqttFrame = pendingBatch.frames[pendingBatch.count++];
      mqttFrame.sequence = sequenceNumber;
      mqttFrame.uptimeMs = uptimeMs;
      mqttFrame.unixTimestampMs = unixTs;
      mqttFrame.timeSynced = synced;
      mqttFrame.sample = sample;
      if (pendingBatch.count >= MQTT_BATCH_FRAMES) {
        if (xQueueSend(mqttQueue, &pendingBatch, 0) != pdTRUE) {
          mqttDroppedBatchCount++;
        }
        pendingBatch.count = 0;
      }
      if (SERIAL_RAW_DEBUG) {
        Serial.printf(
            "[RIGHT_ANKLE_RAW] uptime_ms=%lu unix_ts_ms=%llu time_synced=%s seq=%lu "
            "ax=%.6f ay=%.6f az=%.6f gx=%.6f gy=%.6f gz=%.6f temp_c=%.2f\n",
            static_cast<unsigned long>(uptimeMs),
            static_cast<unsigned long long>(unixTs), synced ? "YES" : "NO",
            static_cast<unsigned long>(sequenceNumber), sample.ax, sample.ay,
            sample.az, sample.gx, sample.gy, sample.gz, sample.temperatureC);
      }
    } else {
      readErrorCount++;
    }
  }

  uint32_t nowMs = millis();
  if (nowMs - statusStartedMs >= STATUS_PERIOD_MS) {
    if (SERIAL_STATUS_DEBUG) {
      float actualHz = statusFrameCount * 1000.0f / (nowMs - statusStartedMs);
      Serial.printf("[STATUS] actual_hz=%.2f frames=%lu read_errors=%lu "
                  "missed=%lu mqtt_published_batches=%lu "
                  "mqtt_publish_failures=%lu mqtt_dropped_batches=%lu "
                  "mqtt_queue_waiting=%lu mqtt=%s\n",
                  actualHz, static_cast<unsigned long>(statusFrameCount),
                  static_cast<unsigned long>(readErrorCount),
                  static_cast<unsigned long>(missedDeadlineCount),
                  static_cast<unsigned long>(mqttPublishedBatchCount),
                  static_cast<unsigned long>(mqttPublishFailureCount),
                  static_cast<unsigned long>(mqttDroppedBatchCount),
                  static_cast<unsigned long>(
                      mqttQueue ? uxQueueMessagesWaiting(mqttQueue) : 0),
                    mqttClient.connected() ? "CONNECTED" : "DISCONNECTED");
    }
    statusStartedMs = nowMs;
    statusFrameCount = 0;
  }
  delay(1);
}
