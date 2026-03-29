#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>

// --- PIN DEFINITIONS ---
#define DHTPIN 4
#define DHTTYPE DHT22
#define DALLAS_PIN 5
#define MQ135_PIN 36      
#define BUZZER_PIN 13
#define WIFI_RESET_PIN 12
#define RELAY_HEATER 32
#define RELAY_TRAY 26
#define RELAY_FOGGER 25
#define WIFI_LED 2         

#define OLED_SDA 22
#define OLED_SCL 21

// --- OBJECTS ---
DHT dht(DHTPIN, DHTTYPE);
OneWire oneWire(DALLAS_PIN);
DallasTemperature sensors(&oneWire);
Adafruit_SSD1306 display(128, 64, &Wire, -1);
WiFiManager wm;

// --- GLOBAL VARIABLES ---
float targetTemp = 37.5;
float targetHum = 65.0;
unsigned long trayIntervalMs = 14400000; // Default 4 hours
unsigned long trayDurationMs = 600000;   // Default 10 mins
unsigned long lastSensorRead = 0;
unsigned long lastTrayAction = 0;
unsigned long lastLEDToggle = 0; 
bool trayActive = false;
bool ledState = LOW;

int overrideHeater = -1;
int overrideFogger = -1;
int overrideTray = -1;
int overrideBuzzer = -1;

// --- IMPORTANT: CHECK THIS IP ADDRESS ---
// Ensure this is the IP of the computer running your Node.js server
const char* FIRMWARE_SERVER_API = "http://192.168.0.2:3000/api/update";

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- Incubator System Starting ---");
  
  Wire.begin(OLED_SDA, OLED_SCL);
  
  pinMode(RELAY_HEATER, OUTPUT);
  pinMode(RELAY_TRAY, OUTPUT);
  pinMode(RELAY_FOGGER, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(WIFI_LED, OUTPUT);        
  pinMode(WIFI_RESET_PIN, INPUT_PULLUP);
  pinMode(MQ135_PIN, INPUT);
  
  digitalWrite(RELAY_HEATER, LOW);
  digitalWrite(RELAY_TRAY, LOW);
  digitalWrite(RELAY_FOGGER, LOW);

  dht.begin();
  sensors.begin();
  
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("OLED Failed");
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);
  display.setCursor(0,10);
  display.println("Connecting WiFi...");
  display.display();

  // WiFiManager will handle connection
  bool res = wm.autoConnect("Incubator-Config"); 

  if(!res) {
    Serial.println("Failed to connect, restarting...");
    ESP.restart();
  } else {
    Serial.println("WiFi Connected!");
    Serial.print("Local IP: ");
    Serial.println(WiFi.localIP());
    
    display.clearDisplay();
    display.setCursor(0,10);
    display.println("Connected!");
    display.println(WiFi.localIP());
    display.display();
    digitalWrite(WIFI_LED, HIGH); 
    delay(2000);
  }
}

void loop() {
  checkWiFiReset();
  handleWiFiLED(); 
  
  unsigned long currentMillis = millis();

  if (currentMillis - lastSensorRead >= 2000) {
    lastSensorRead = currentMillis;
    handleIncubationLogic();
  }

  if (overrideTray == 1) {
    if (!trayActive) startTray();
  } else if (overrideTray == 0) {
    if (trayActive) stopTray();
  } else {
    if (!trayActive && (currentMillis - lastTrayAction >= trayIntervalMs)) startTray();
    else if (trayActive && (currentMillis - lastTrayAction >= trayDurationMs)) stopTray();
  }
}

void handleWiFiLED() {
  unsigned long currentMillis = millis();
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(WIFI_LED, HIGH); 
  } else {
    if (currentMillis - lastLEDToggle >= 500) {
      lastLEDToggle = currentMillis;
      ledState = !ledState;
      digitalWrite(WIFI_LED, ledState);
    }
  }
}

void handleIncubationLogic() {
  float h = dht.readHumidity();
  float dhtTemp = dht.readTemperature();
  sensors.requestTemperatures();
  
  float t1 = sensors.getTempCByIndex(0);
  float t2 = sensors.getTempCByIndex(1);
  float t3 = sensors.getTempCByIndex(2);
  float avgTemp = (t1 + t2 + t3) / 3.0;

  int sensorValue = analogRead(MQ135_PIN);
  float voltage = (sensorValue / 4095.0) * 5.0;

  float rs = ((5.0 - voltage) / voltage) * 10.0; 
  float ratio = rs / 10.0; 

  float co2 = 110.47 * pow(ratio, -2.862);
  float nh3 = 102.2 * pow(ratio, -2.473);
  float nox = 44.22 * pow(ratio, -3.401);
  float alc = 77.25 * pow(ratio, -3.18);
  float totalPpm = co2 + nh3 + nox + alc;
  float aqi = (sensorValue / 4095.0) * 100.0;

  if (overrideHeater == 1) digitalWrite(RELAY_HEATER, HIGH);
  else if (overrideHeater == 0) digitalWrite(RELAY_HEATER, LOW);
  else {
    if (avgTemp < (targetTemp - 0.2)) digitalWrite(RELAY_HEATER, HIGH);
    else if (avgTemp > targetTemp) digitalWrite(RELAY_HEATER, LOW);
  }

  if (overrideFogger == 1) digitalWrite(RELAY_FOGGER, HIGH);
  else if (overrideFogger == 0) digitalWrite(RELAY_FOGGER, LOW);
  else {
    if (h < (targetHum - 5)) digitalWrite(RELAY_FOGGER, HIGH);
    else if (h > targetHum) digitalWrite(RELAY_FOGGER, LOW);
  }

  if (overrideBuzzer == 1) {
    tone(BUZZER_PIN, 1000, 200);
  } else if (overrideBuzzer == 0) {
    noTone(BUZZER_PIN);
  } else {
    // Auto beeping disabled so it doesn't beep all the time
    noTone(BUZZER_PIN);
  }

  updateDisplay(avgTemp, h, aqi);
  sendToServer(avgTemp, h, dhtTemp, aqi, co2, nh3, nox, alc, totalPpm, t1, t2, t3);
}

void startTray() { digitalWrite(RELAY_TRAY, HIGH); trayActive = true; lastTrayAction = millis(); }
void stopTray() { digitalWrite(RELAY_TRAY, LOW); trayActive = false; lastTrayAction = millis(); }

void updateDisplay(float t, float h, float a) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0,0);
  display.print("T:"); display.print(t, 1); display.print(" H:"); display.print(h, 0); 
  display.setCursor(0, 15);
  display.print("AQI: "); display.print(a, 0); display.println("%");
  display.setCursor(0, 50);
  display.print(trayActive ? "TRAY: ROLLING" : "TRAY: IDLE");
  display.display();
}

void sendToServer(float avg, float hum, float dhtTemp, float air, float co2, float nh3, float nox, float alc, float ppm, float p1, float p2, float p3) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(FIRMWARE_SERVER_API);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<768> doc;
    doc["ssid"] = WiFi.SSID();
    doc["rssi"] = WiFi.RSSI();
    doc["ip"] = WiFi.localIP().toString();
    doc["temp"] = avg;
    doc["hum"] = hum;
    doc["dhtTemp"] = dhtTemp;
    doc["air"] = air;
    doc["co2"] = co2;
    doc["nh3"] = nh3;
    doc["nox"] = nox;
    doc["alcohol"] = alc;
    doc["totalPpm"] = ppm;
    JsonArray probes = doc.createNestedArray("probes");
    probes.add(p1); probes.add(p2); probes.add(p3);
    JsonObject relays = doc.createNestedObject("relays");
    relays["heater"] = digitalRead(RELAY_HEATER);
    relays["fogger"] = digitalRead(RELAY_FOGGER);
    relays["tray"] = digitalRead(RELAY_TRAY);

    String body;
    serializeJson(doc, body);
    
    int httpResponseCode = http.POST(body);
    
    Serial.print("Data sent to server. Response Code: ");
    Serial.println(httpResponseCode);
    
    if (httpResponseCode > 0) {
      String payload = http.getString();
      StaticJsonDocument<256> respDoc;
      if (deserializeJson(respDoc, payload) == DeserializationError::Ok) {
        if (respDoc.containsKey("heater")) overrideHeater = respDoc["heater"];
        if (respDoc.containsKey("fogger")) overrideFogger = respDoc["fogger"];
        if (respDoc.containsKey("tray")) overrideTray = respDoc["tray"];
        if (respDoc.containsKey("buzzer")) overrideBuzzer = respDoc["buzzer"];
        
        if (respDoc.containsKey("targetTemp")) targetTemp = respDoc["targetTemp"];
        if (respDoc.containsKey("targetHum")) targetHum = respDoc["targetHum"];
        if (respDoc.containsKey("trayInterval")) trayIntervalMs = respDoc["trayInterval"];
        if (respDoc.containsKey("trayDuration")) trayDurationMs = respDoc["trayDuration"];
      }
    } else {
      Serial.println("Error: Failed to reach server. Check Server IP and Port.");
    }
    
    http.end();
  } else {
    Serial.println("WiFi Disconnected. Cannot send data.");
  }
}

void checkWiFiReset() {
  static unsigned long resetPressTime = 0;
  static bool isPressing = false;

  if (digitalRead(WIFI_RESET_PIN) == LOW) {
    if (!isPressing) {
      resetPressTime = millis();
      isPressing = true;
    } else if (millis() - resetPressTime > 5000) {
      Serial.println("Wiping WiFi Settings...");
      tone(BUZZER_PIN, 1000, 1000); // Beep to indicate reset
      wm.resetSettings();
      delay(1000);
      ESP.restart();
    }
  } else {
    isPressing = false;
  }
}