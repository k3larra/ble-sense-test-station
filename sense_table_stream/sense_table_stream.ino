#include <Arduino_APDS9960.h>
#include <Arduino_LPS22HB.h>
#include <PDM.h>

#if defined(BLE_SENSE_REV2)
  #include <Arduino_BMI270_BMM150.h>
  #include <Arduino_HS300x.h>
#else
  #include <Arduino_HTS221.h>
  #include <Arduino_LSM9DS1.h>
#endif

namespace {
const unsigned long kPublishIntervalMs = 1000;
const int kAudioBufferSamples = 256;

short audioBuffer[kAudioBufferSamples];
volatile int audioPeak = 0;
volatile bool audioSeen = false;

float lastTemperatureC = NAN;
float lastHumidity = NAN;
float lastPressureKPa = NAN;

float lastAccelX = NAN;
float lastAccelY = NAN;
float lastAccelZ = NAN;

float lastGyroX = NAN;
float lastGyroY = NAN;
float lastGyroZ = NAN;

float lastMagX = NAN;
float lastMagY = NAN;
float lastMagZ = NAN;

int lastColorR = -1;
int lastColorG = -1;
int lastColorB = -1;
int lastColorC = -1;
int lastProximity = -1;
const char* lastGesture = "none";

bool hasHTS = false;
bool hasBaro = false;
bool hasIMU = false;
bool hasAPDS = false;
bool hasMic = false;

unsigned long lastPublishAt = 0;
}

void onPDMdata() {
  int bytesAvailable = PDM.available();
  if (bytesAvailable <= 0) {
    return;
  }

  PDM.read(audioBuffer, bytesAvailable);

  int samplesRead = bytesAvailable / 2;
  int localPeak = 0;

  for (int i = 0; i < samplesRead; i++) {
    int sample = audioBuffer[i];
    if (sample < 0) {
      sample = -sample;
    }
    if (sample > localPeak) {
      localPeak = sample;
    }
  }

  if (localPeak > audioPeak) {
    audioPeak = localPeak;
  }

  audioSeen = true;
}

void printFloatOrNull(float value, int digits = 2) {
  if (isnan(value)) {
    Serial.print("null");
    return;
  }

  Serial.print(value, digits);
}

void printIntOrNull(int value) {
  if (value < 0) {
    Serial.print("null");
    return;
  }

  Serial.print(value);
}

void readClimateSensors() {
  if (hasHTS) {
#if defined(BLE_SENSE_REV2)
    lastTemperatureC = HS300x.readTemperature();
    lastHumidity = HS300x.readHumidity();
#else
    lastTemperatureC = HTS.readTemperature();
    lastHumidity = HTS.readHumidity();
#endif
  }

  if (hasBaro) {
    lastPressureKPa = BARO.readPressure();
  }
}

void readImuSensors() {
  if (!hasIMU) {
    return;
  }

  if (IMU.accelerationAvailable()) {
    IMU.readAcceleration(lastAccelX, lastAccelY, lastAccelZ);
  }

  if (IMU.gyroscopeAvailable()) {
    IMU.readGyroscope(lastGyroX, lastGyroY, lastGyroZ);
  }

  if (IMU.magneticFieldAvailable()) {
    IMU.readMagneticField(lastMagX, lastMagY, lastMagZ);
  }
}

void readApdsSensors() {
  if (!hasAPDS) {
    return;
  }

  if (APDS.colorAvailable()) {
    APDS.readColor(lastColorR, lastColorG, lastColorB, lastColorC);
  }

  if (APDS.proximityAvailable()) {
    lastProximity = APDS.readProximity();
  }

  if (APDS.gestureAvailable()) {
    switch (APDS.readGesture()) {
      case GESTURE_UP:
        lastGesture = "up";
        break;
      case GESTURE_DOWN:
        lastGesture = "down";
        break;
      case GESTURE_LEFT:
        lastGesture = "left";
        break;
      case GESTURE_RIGHT:
        lastGesture = "right";
        break;
      default:
        lastGesture = "none";
        break;
    }
  }
}

void publishSnapshot() {
  int localAudioPeak = audioPeak;
  bool localAudioSeen = audioSeen;

  audioPeak = 0;
  audioSeen = false;

  float audioPercent = NAN;
  if (hasMic && localAudioSeen) {
    audioPercent = (localAudioPeak * 100.0f) / 32767.0f;
  }

  Serial.print("{\"temp_c\":");
  printFloatOrNull(lastTemperatureC, 2);
  Serial.print(",\"humidity_pct\":");
  printFloatOrNull(lastHumidity, 2);
  Serial.print(",\"pressure_kpa\":");
  printFloatOrNull(lastPressureKPa, 2);
  Serial.print(",\"accel_g\":[");
  printFloatOrNull(lastAccelX, 3);
  Serial.print(",");
  printFloatOrNull(lastAccelY, 3);
  Serial.print(",");
  printFloatOrNull(lastAccelZ, 3);
  Serial.print("],\"gyro_dps\":[");
  printFloatOrNull(lastGyroX, 2);
  Serial.print(",");
  printFloatOrNull(lastGyroY, 2);
  Serial.print(",");
  printFloatOrNull(lastGyroZ, 2);
  Serial.print("],\"mag_ut\":[");
  printFloatOrNull(lastMagX, 2);
  Serial.print(",");
  printFloatOrNull(lastMagY, 2);
  Serial.print(",");
  printFloatOrNull(lastMagZ, 2);
  Serial.print("],\"color\":{\"r\":");
  printIntOrNull(lastColorR);
  Serial.print(",\"g\":");
  printIntOrNull(lastColorG);
  Serial.print(",\"b\":");
  printIntOrNull(lastColorB);
  Serial.print(",\"c\":");
  printIntOrNull(lastColorC);
  Serial.print("},\"proximity\":");
  printIntOrNull(lastProximity);
  Serial.print(",\"gesture\":\"");
  Serial.print(lastGesture);
  Serial.print("\",\"mic_peak_pct\":");
  printFloatOrNull(audioPercent, 1);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);

#if defined(BLE_SENSE_REV2)
  hasHTS = HS300x.begin();
#else
  hasHTS = HTS.begin();
#endif
  hasBaro = BARO.begin();
  hasIMU = IMU.begin();
  hasAPDS = APDS.begin();

  PDM.onReceive(onPDMdata);
  PDM.setGain(30);
  hasMic = PDM.begin(1, 16000);

  delay(250);
}

void loop() {
  readClimateSensors();
  readImuSensors();
  readApdsSensors();

  if (millis() - lastPublishAt >= kPublishIntervalMs) {
    lastPublishAt = millis();
    publishSnapshot();
  }
}
