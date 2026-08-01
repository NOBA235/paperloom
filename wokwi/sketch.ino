#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "mbedtls/sha256.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDRESS 0x3C

const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASSWORD = "";
const char *INGEST_ENDPOINT = "https://your-app.vercel.app/api/ingest";
const char *DEVICE_ID = "paperloom-esp32-wokwi-001";

const int SDA_PIN = 21;
const int SCL_PIN = 22;
const int BUTTON_PIN = 18;

const unsigned long SCAN_INTERVAL_MS = 30000;
const unsigned long DEBOUNCE_MS = 250;

unsigned long lastScanAt = 0;
unsigned long lastButtonAt = 0;
uint32_t scanCounter = 0;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

const uint16_t mockFiberSensorData[] = {
  413, 418, 421, 439, 447, 451, 462, 467,
  472, 488, 491, 506, 512, 527, 533, 548,
  551, 557, 563, 579, 587, 590, 604, 611,
  616, 622, 637, 641, 655, 662, 676, 681,
  689, 701, 717, 722, 735, 741, 759, 764,
  778, 783, 791, 806, 814, 829, 837, 844,
  851, 867, 872, 886, 893, 907, 913, 929,
  936, 941, 958, 963, 977, 982, 996, 1007,
  1013, 999, 986, 971, 966, 952, 947, 931,
  924, 910, 903, 887, 881, 866, 859, 842,
  837, 821, 816, 799, 794, 779, 773, 756,
  749, 734, 727, 711, 704, 688, 683, 666
};

const char rawText[] = R"RAW_TEXT(PaperLoom Chapter Scan: Foundations of Electromagnetism and Learning Gaps

Electric charge is a conserved property of matter. Opposite charges attract, like charges repel, and the force between two point charges is proportional to the product of their charges and inversely proportional to the square of the distance between them. This relationship is described by Coulomb's law.

An electric field represents the force that a positive test charge would experience at a point in space. Field lines begin on positive charges and terminate on negative charges. The density of field lines indicates the relative strength of the electric field.

Electric potential energy changes when a charge moves through an electric field. Electric potential, measured in volts, is potential energy per unit charge. A battery creates a potential difference that can drive current through a closed circuit.

Current is the rate of flow of electric charge. Resistance measures how strongly a material opposes current. Ohm's law states that voltage equals current multiplied by resistance. In series circuits, resistances add directly. In parallel circuits, the reciprocal of the equivalent resistance equals the sum of the reciprocals of each branch resistance.

Magnetic fields are produced by moving charges and by changing electric fields. A current-carrying wire generates circular magnetic field lines around the wire. The right-hand rule gives the direction of the magnetic field. A charged particle moving through a magnetic field experiences a force perpendicular to both its velocity and the field.

Electromagnetic induction occurs when a changing magnetic flux produces an electromotive force. Faraday's law relates induced voltage to the rate of change of magnetic flux. Lenz's law states that the induced current opposes the change that created it.

Key formulas:
Coulomb force: F = k q1 q2 / r^2
Ohm's law: V = I R
Electric power: P = I V
Magnetic force on a moving charge: F = q v B sin(theta)
Faraday induction: emf = -N dPhi/dt

Likely student gaps:
1. Distinguishing electric field from electric potential.
2. Understanding why equivalent resistance decreases in parallel circuits.
3. Applying the right-hand rule consistently.
4. Connecting magnetic flux changes to induced current direction.
5. Translating word problems into variables before using formulas.)RAW_TEXT";

void drawCenteredText(const String &text, int y) {
  int16_t x1;
  int16_t y1;
  uint16_t w;
  uint16_t h;
  display.getTextBounds(text, 0, y, &x1, &y1, &w, &h);
  int x = (SCREEN_WIDTH - w) / 2;
  if (x < 0) {
    x = 0;
  }
  display.setCursor(x, y);
  display.print(text);
}

void showStatus(const String &message, const String &detail, int progressPercent, uint16_t durationMs) {
  unsigned long start = millis();
  int textWidth = message.length() * 6;
  int x = SCREEN_WIDTH;

  while (millis() - start < durationMs) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);

    drawCenteredText("PaperLoom Node", 0);
    display.drawLine(0, 11, SCREEN_WIDTH, 11, SSD1306_WHITE);

    if (textWidth <= SCREEN_WIDTH) {
      drawCenteredText(message, 22);
    } else {
      display.setCursor(x, 22);
      display.print(message);
      x -= 2;
      if (x < -textWidth) {
        x = SCREEN_WIDTH;
      }
    }

    display.setCursor(0, 40);
    display.print(detail);

    int barWidth = map(progressPercent, 0, 100, 0, SCREEN_WIDTH - 4);
    display.drawRect(0, 56, SCREEN_WIDTH, 8, SSD1306_WHITE);
    display.fillRect(2, 58, barWidth, 4, SSD1306_WHITE);

    display.display();
    delay(35);
  }
}

String bytesToHex(const uint8_t *bytes, size_t length) {
  const char hexChars[] = "0123456789abcdef";
  String hex = "";
  hex.reserve(length * 2);

  for (size_t i = 0; i < length; i++) {
    hex += hexChars[(bytes[i] >> 4) & 0x0F];
    hex += hexChars[bytes[i] & 0x0F];
  }

  return hex;
}

String generateFingerprintHash() {
  uint8_t sensorBytes[sizeof(mockFiberSensorData) * 2];

  for (size_t i = 0; i < sizeof(mockFiberSensorData) / sizeof(mockFiberSensorData[0]); i++) {
    uint16_t value = mockFiberSensorData[i];
    sensorBytes[i * 2] = highByte(value);
    sensorBytes[i * 2 + 1] = lowByte(value);
  }

  uint8_t shaResult[32];
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts(&context, 0);
  mbedtls_sha256_update(&context, sensorBytes, sizeof(sensorBytes));
  mbedtls_sha256_finish(&context, shaResult);
  mbedtls_sha256_free(&context);

  return bytesToHex(shaResult, sizeof(shaResult));
}

String escapeJson(const char *input) {
  String output = "";

  for (size_t i = 0; input[i] != '\0'; i++) {
    char c = input[i];

    if (c == '"') {
      output += "\\\"";
    } else if (c == '\\') {
      output += "\\\\";
    } else if (c == '\n') {
      output += "\\n";
    } else if (c == '\r') {
      output += "\\r";
    } else if (c == '\t') {
      output += "\\t";
    } else if ((uint8_t)c < 0x20) {
      char encoded[7];
      snprintf(encoded, sizeof(encoded), "\\u%04x", c);
      output += encoded;
    } else {
      output += c;
    }
  }

  return output;
}

void connectToWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();

  while (WiFi.status() != WL_CONNECTED) {
    showStatus("Connecting to Wokwi WiFi...", "SSID: Wokwi-GUEST", 12, 350);

    if (millis() - startAttempt > 20000) {
      WiFi.disconnect();
      delay(500);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      startAttempt = millis();
    }
  }

  showStatus("WiFi Connected", WiFi.localIP().toString(), 25, 1200);
}

String buildPayload(const String &fingerprintHash) {
  String payload = "{";
  payload += "\"device_id\":\"";
  payload += DEVICE_ID;
  payload += "\",\"fingerprint_hash\":\"";
  payload += fingerprintHash;
  payload += "\",\"raw_text\":\"";
  payload += escapeJson(rawText);
  payload += "\"}";
  return payload;
}

void uploadToCloudNode(const String &payload) {
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(15000);

  showStatus("Uploading to Cloud Node...", "POST /api/ingest", 78, 1800);

  bool started = http.begin(client, INGEST_ENDPOINT);

  if (!started) {
    showStatus("Upload Failed", "HTTP init error", 100, 2200);
    Serial.println("HTTP initialization failed");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-PaperLoom-Device", DEVICE_ID);

  int statusCode = http.POST(payload);
  String response = http.getString();

  Serial.print("POST status: ");
  Serial.println(statusCode);
  Serial.print("Response: ");
  Serial.println(response);

  http.end();

  if (statusCode >= 200 && statusCode < 300) {
    showStatus("Cloud Node Synced", "Secure space ready", 100, 2500);
  } else {
    String detail = "HTTP " + String(statusCode);
    showStatus("Upload Failed", detail, 100, 2500);
  }
}

void performScan() {
  scanCounter++;

  Serial.println();
  Serial.print("Starting PaperLoom scan #");
  Serial.println(scanCounter);

  showStatus("Scanning Page...", "Fiber map sampling", 20, 1800);
  showStatus("Reading stroke texture...", "Optical variance pass", 38, 1800);
  showStatus("Generating Key...", "SHA-256 digest", 56, 1800);

  String fingerprintHash = generateFingerprintHash();

  Serial.print("Fingerprint hash: ");
  Serial.println(fingerprintHash);

  showStatus("Fingerprint Generated", fingerprintHash.substring(0, 18) + "...", 68, 1800);

  String payload = buildPayload(fingerprintHash);

  Serial.print("Payload bytes: ");
  Serial.println(payload.length());

  uploadToCloudNode(payload);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Wire.begin(SDA_PIN, SCL_PIN);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    Serial.println("SSD1306 allocation failed");
    while (true) {
      delay(1000);
    }
  }

  display.clearDisplay();
  display.display();

  showStatus("Booting PaperLoom...", "ESP32 secure scanner", 5, 1500);
  connectToWiFi();

  lastScanAt = millis();
  showStatus("Ready to Scan", "Button or timer", 0, 1500);
}

void loop() {
  bool buttonPressed = digitalRead(BUTTON_PIN) == LOW;
  bool buttonReady = millis() - lastButtonAt > DEBOUNCE_MS;
  bool timedScanReady = millis() - lastScanAt > SCAN_INTERVAL_MS;

  if ((buttonPressed && buttonReady) || timedScanReady) {
    lastButtonAt = millis();
    lastScanAt = millis();
    performScan();
    showStatus("Ready to Scan", "Next scan armed", 0, 1200);
  }

  showStatus("Idle: Awaiting Scan", "Press button or wait", 0, 450);
}
