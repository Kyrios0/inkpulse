#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <PNGdec.h>
#include <Preferences.h>
#include "driver.h"
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_heap_caps.h>
#include <mbedtls/sha256.h>
#include <time.h>

#include "ca_cert.h"
#include "config.h"

namespace {

constexpr int kDisplayWidth = 800;
constexpr int kDisplayHeight = 480;
constexpr int kPageCountMax = 2;
constexpr int kLegacyCachePageCountMax = 3;
constexpr size_t kPackedFrameBytes = (kDisplayWidth * kDisplayHeight) / 2;
constexpr size_t kManifestBytesMax = 16 * 1024;
// The 8 MB board partition gives LittleFS 1.5 MB. Keep space for the previous
// previous page set while the next images are being downloaded.
constexpr size_t kPngBytesMax = 192 * 1024;
constexpr uint32_t kWifiTimeoutMs = 20000;
constexpr uint32_t kClockTimeoutMs = 20000;
constexpr uint32_t kButtonDebounceMs = 45;
constexpr uint32_t kMinimumRefreshSeconds = 30;
constexpr uint32_t kMaximumRefreshSeconds = 86400;
// A button press marks someone as present at the device for this long, which
// overrides the server's away hold.
constexpr uint32_t kLocalPresenceMs = 5UL * 60UL * 1000UL;
// Shortest accepted away redraw interval; 0 from the manifest means fully held.
constexpr uint32_t kMinimumAwayRedrawSeconds = 600;

constexpr int kPinDebugRx = 44;
constexpr int kPinDebugTx = 43;
constexpr int kPinRefresh = 3;  // KEY0
constexpr int kPinLeft = 4;     // KEY1
constexpr int kPinRight = 5;    // KEY2

constexpr char kManifestPath[] = "/api/v1/display/manifest";
constexpr char kStatePath[] = "/state.json";
constexpr char kStateNextPath[] = "/state.next";
constexpr char kStatePreviousPath[] = "/state.prev";
constexpr char kCacheDirectory[] = "/cache";

#define LOG Serial1

struct PageRecord {
  String id;
  String title;
  String version;
  String imageUrl;
  String cachePath;
};

struct PageSet {
  PageRecord pages[kPageCountMax];
  size_t pageCount = 0;
  String defaultPage;
  uint32_t refreshAfterSeconds = 60;
  // From the manifest only; never persisted with the cached page set.
  bool holdRedraws = false;
  uint32_t awayRedrawSeconds = 0;
};

// Why the physical panel was refreshed. Logged with every refresh.
enum class RedrawReason {
  kBoot,            // cached page drawn at boot; panel content was unknown
  kFirstBootClear,  // white clear on a device with no cached pages
  kDiagnostic,      // first-boot gray-band diagnostic
  kStatus,          // error/configuration status screen
  kVersion,         // selected page's version changed
  kPresenceReturn,  // first draw after an away hold released
  kAwayInterval,    // periodic draw of a changed page while still away
  kButton,          // Left/Right navigation
};

const char *reasonName(RedrawReason reason) {
  switch (reason) {
    case RedrawReason::kBoot: return "boot";
    case RedrawReason::kFirstBootClear: return "first-boot-clear";
    case RedrawReason::kDiagnostic: return "diagnostic";
    case RedrawReason::kStatus: return "status";
    case RedrawReason::kVersion: return "version";
    case RedrawReason::kPresenceReturn: return "presence-return";
    case RedrawReason::kAwayInterval: return "away-interval";
    case RedrawReason::kButton: return "button";
  }
  return "unknown";
}

struct ButtonState {
  explicit ButtonState(int gpio) : pin(gpio) {}
  int pin;
  bool stable = HIGH;
  bool observed = HIGH;
  uint32_t changedAt = 0;
};

EPaper display;
PNG png;
PageSet cachedPages;
Preferences preferences;

uint8_t *packedFrame = nullptr;
uint16_t pngLine[kDisplayWidth];
bool pngDecodeValid = true;
String selectedPageId;
String displayedPageId;
String displayedVersion;
uint32_t nextRefreshAt = 0;
bool clockReady = false;
bool noCacheErrorShown = false;
bool storageReady = false;
uint32_t localPresenceUntil = 0;
bool localPresenceActive = false;
bool redrawHeld = false;
// Lifetime counters persist in NVS; session counters reset at boot.
uint32_t fullRedraws = 0;
uint32_t partialRedraws = 0;  // reserved: this firmware refreshes full-screen only
uint32_t sessionFullRedraws = 0;
uint32_t sessionHeldPolls = 0;
// millis() of the last physical refresh. Boot counts as one, since the panel's
// real last refresh time is unknown after a restart.
uint32_t lastPanelRefreshAt = 0;

ButtonState refreshButton{kPinRefresh};
ButtonState leftButton{kPinLeft};
ButtonState rightButton{kPinRight};

bool deadlineReached(uint32_t deadline) {
  return static_cast<int32_t>(millis() - deadline) >= 0;
}

bool isAllowedPageId(const String &id) {
  return id == "overview" || id == "stocks";
}

bool isValidVersion(const String &version) {
  if (version.length() != 71 || !version.startsWith("sha256:")) {
    return false;
  }
  for (size_t index = 7; index < version.length(); ++index) {
    const char value = version[index];
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) {
      return false;
    }
  }
  return true;
}

bool isValidBaseUrl(const String &url) {
  if (!url.startsWith("https://") || url.length() <= 8 || url.endsWith("/")) {
    return false;
  }
  return url.indexOf('/', 8) < 0 && url.indexOf('?', 8) < 0 &&
         url.indexOf('#', 8) < 0;
}

String baseUrl() {
  String url = INKPULSE_BASE_URL;
  while (url.endsWith("/")) url.remove(url.length() - 1);
  return url;
}

bool isValidImageUrl(const String &pageId, const String &url) {
  const String expected = "/api/v1/display/pages/" + pageId + ".png";
  return url == expected || url.startsWith(expected + "?");
}

bool isValidCachePath(const String &path) {
  return path.startsWith(String(kCacheDirectory) + "/") &&
         path.endsWith(".png") && path.indexOf("..") < 0;
}

bool firmwareConfigured() {
  return strlen(INKPULSE_WIFI_SSID) > 0 && strlen(INKPULSE_BASE_URL) > 0 &&
         strlen(INKPULSE_DEVICE_TOKEN) > 0 &&
         strcmp(INKPULSE_WIFI_SSID, "your-2.4-ghz-wifi") != 0 &&
         strcmp(INKPULSE_BASE_URL, "https://ink.example.com") != 0 &&
         strcmp(INKPULSE_DEVICE_TOKEN, "replace-with-display-token") != 0 &&
         isValidBaseUrl(baseUrl());
}

void *allocatePreferPsram(size_t bytes) {
  void *memory = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return memory != nullptr ? memory : malloc(bytes);
}

void putStringIfChanged(const char *key, const String &value) {
  if (preferences.getString(key, "") != value) preferences.putString(key, value);
}

// Every physical refresh goes through here so it is counted and explained.
void refreshPanel(RedrawReason reason, const String &detail = "") {
  const uint32_t started = millis();
  display.update();
  lastPanelRefreshAt = millis();
  ++fullRedraws;
  ++sessionFullRedraws;
  preferences.putULong("rdFull", fullRedraws);
  LOG.printf("[panel] full refresh #%lu reason=%s%s%s (%lu ms, %lu this boot)\n",
             static_cast<unsigned long>(fullRedraws), reasonName(reason),
             detail.length() ? " page=" : "", detail.c_str(),
             static_cast<unsigned long>(millis() - started),
             static_cast<unsigned long>(sessionFullRedraws));
}

// Records what the panel shows so a reboot can skip redrawing the same page.
// An empty page ID means a non-page screen (status or diagnostic).
void rememberShown(const String &pageId, const String &version) {
  putStringIfChanged("shownPage", pageId);
  putStringIfChanged("shownVer", version);
}

bool localPresence() {
  if (localPresenceActive && deadlineReached(localPresenceUntil)) localPresenceActive = false;
  return localPresenceActive;
}

void markLocalPresence() {
  localPresenceActive = true;
  localPresenceUntil = millis() + kLocalPresenceMs;
}

void showStatus(const String &title, const String &detail) {
  display.fillSprite(TFT_GRAY_3);
  display.drawRect(18, 18, kDisplayWidth - 36, kDisplayHeight - 36, TFT_GRAY_0);
  display.fillRect(18, 18, 18, kDisplayHeight - 36, TFT_GRAY_0);
  display.setTextColor(TFT_GRAY_0, TFT_GRAY_3);
  display.drawString("INKPULSE", 68, 72, 4);
  display.drawString(title, 68, 172, 4);
  display.drawString(detail, 68, 242, 2);
  display.drawString("Refresh / Left / Right", 68, 352, 2);
  refreshPanel(RedrawReason::kStatus, title);
  rememberShown("", "");
  displayedPageId = "";
  displayedVersion = "";
}

void showFirstBootDiagnostic() {
  display.fillRect(0, 0, kDisplayWidth, 120, TFT_GRAY_0);
  display.fillRect(0, 120, kDisplayWidth, 120, TFT_GRAY_1);
  display.fillRect(0, 240, kDisplayWidth, 120, TFT_GRAY_2);
  display.fillRect(0, 360, kDisplayWidth, 120, TFT_GRAY_3);
  display.setTextColor(TFT_GRAY_3, TFT_GRAY_0);
  display.drawString("INKPULSE", 32, 34, 4);
  display.setTextColor(TFT_GRAY_0, TFT_GRAY_2);
  display.drawString("E1001 DISPLAY OK", 32, 270, 4);
  display.setTextColor(TFT_GRAY_0, TFT_GRAY_3);
  display.drawString("Connecting and downloading pages...", 32, 402, 2);
  refreshPanel(RedrawReason::kDiagnostic);
  rememberShown("", "");
}

bool validatePngSignature(const String &path) {
  File file = LittleFS.open(path, "r");
  if (!file || file.size() < 24 || file.size() > kPngBytesMax) {
    if (file) file.close();
    return false;
  }

  uint8_t header[24]{};
  const size_t bytesRead = file.read(header, sizeof(header));
  file.close();
  static constexpr uint8_t signature[] = {0x89, 0x50, 0x4e, 0x47,
                                          0x0d, 0x0a, 0x1a, 0x0a};
  if (bytesRead != sizeof(header) || memcmp(header, signature, sizeof(signature)) != 0) {
    return false;
  }

  const uint32_t width = (static_cast<uint32_t>(header[16]) << 24) |
                         (static_cast<uint32_t>(header[17]) << 16) |
                         (static_cast<uint32_t>(header[18]) << 8) | header[19];
  const uint32_t height = (static_cast<uint32_t>(header[20]) << 24) |
                          (static_cast<uint32_t>(header[21]) << 16) |
                          (static_cast<uint32_t>(header[22]) << 8) | header[23];
  return width == kDisplayWidth && height == kDisplayHeight;
}

bool fileMatchesVersion(const String &path, const String &version) {
  if (!isValidVersion(version) || !validatePngSignature(path)) return false;
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  bool valid = mbedtls_sha256_starts_ret(&context, 0) == 0;
  uint8_t buffer[1024];
  while (valid && file.available()) {
    const size_t bytes = file.read(buffer, sizeof(buffer));
    valid = bytes > 0 && mbedtls_sha256_update_ret(&context, buffer, bytes) == 0;
  }
  file.close();

  uint8_t digest[32]{};
  valid = valid && mbedtls_sha256_finish_ret(&context, digest) == 0;
  mbedtls_sha256_free(&context);
  if (!valid) return false;

  static constexpr char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); ++index) {
    if (version[7 + index * 2] != hex[digest[index] >> 4] ||
        version[8 + index * 2] != hex[digest[index] & 0x0f]) {
      return false;
    }
  }
  return true;
}

int pngDrawLine(PNGDRAW *draw) {
  if (draw->y < 0 || draw->y >= kDisplayHeight || draw->iWidth != kDisplayWidth) {
    pngDecodeValid = false;
    return 0;
  }

  png.getLineAsRGB565(draw, pngLine, PNG_RGB565_LITTLE_ENDIAN, 0xffffffff);
  const size_t rowOffset = static_cast<size_t>(draw->y) * (kDisplayWidth / 2);

  for (int x = 0; x < kDisplayWidth; ++x) {
    const uint16_t pixel = pngLine[x];
    const uint16_t red = ((pixel >> 11) & 0x1f) * 255 / 31;
    const uint16_t green = ((pixel >> 5) & 0x3f) * 255 / 63;
    const uint16_t blue = (pixel & 0x1f) * 255 / 31;
    const uint16_t luminance = (red * 30 + green * 59 + blue * 11) / 100;
    const uint8_t gray = luminance < 43 ? 0 : luminance < 128 ? 1 : luminance < 213 ? 2 : 3;
    const size_t byteIndex = rowOffset + static_cast<size_t>(x / 2);
    if ((x & 1) == 0) {
      packedFrame[byteIndex] = (packedFrame[byteIndex] & 0x0f) | (gray << 4);
    } else {
      packedFrame[byteIndex] = (packedFrame[byteIndex] & 0xf0) | gray;
    }
  }
  return 1;
}

bool renderPage(const PageRecord &page, RedrawReason reason) {
  if (!fileMatchesVersion(page.cachePath, page.version)) {
    LOG.printf("[display] invalid cached PNG for %s\n", page.id.c_str());
    return false;
  }

  File file = LittleFS.open(page.cachePath, "r");
  const size_t pngBytes = file.size();
  uint8_t *encoded = static_cast<uint8_t *>(allocatePreferPsram(pngBytes));
  if (encoded == nullptr) {
    file.close();
    LOG.println("[display] PNG allocation failed");
    return false;
  }
  const bool readComplete = file.read(encoded, pngBytes) == pngBytes;
  file.close();
  if (!readComplete) {
    free(encoded);
    LOG.println("[display] PNG read failed");
    return false;
  }

  if (packedFrame == nullptr) {
    packedFrame = static_cast<uint8_t *>(allocatePreferPsram(kPackedFrameBytes));
  }
  if (packedFrame == nullptr) {
    free(encoded);
    LOG.println("[display] frame allocation failed");
    return false;
  }

  memset(packedFrame, 0x33, kPackedFrameBytes);
  pngDecodeValid = true;
  const int opened = png.openRAM(encoded, static_cast<int>(pngBytes), pngDrawLine);
  bool decoded = false;
  if (opened == PNG_SUCCESS && png.getWidth() == kDisplayWidth &&
      png.getHeight() == kDisplayHeight) {
    decoded = png.decode(nullptr, 0) == PNG_SUCCESS && pngDecodeValid;
  }
  if (opened == PNG_SUCCESS) png.close();
  free(encoded);

  if (!decoded) {
    LOG.printf("[display] PNG decode failed for %s\n", page.id.c_str());
    return false;
  }

  display.fillSprite(TFT_GRAY_3);
  display.pushImage(0, 0, kDisplayWidth, kDisplayHeight,
                    reinterpret_cast<uint16_t *>(packedFrame));
  refreshPanel(reason, page.id);
  displayedPageId = page.id;
  displayedVersion = page.version;
  rememberShown(page.id, page.version);
  noCacheErrorShown = false;
  return true;
}

int findPage(const PageSet &set, const String &id) {
  for (size_t index = 0; index < set.pageCount; ++index) {
    if (set.pages[index].id == id) return static_cast<int>(index);
  }
  return -1;
}

bool parseStateFile(const char *path, PageSet &state) {
  File file = LittleFS.open(path, "r");
  if (!file || file.size() == 0 || file.size() > kManifestBytesMax) {
    if (file) file.close();
    return false;
  }

  JsonDocument document;
  const DeserializationError error = deserializeJson(document, file);
  file.close();
  if (error || document["schemaVersion"].as<int>() != 1) return false;

  JsonArrayConst pages = document["pages"].as<JsonArrayConst>();
  if (pages.isNull() || pages.size() == 0 || pages.size() > kLegacyCachePageCountMax) return false;

  PageSet parsed;
  parsed.refreshAfterSeconds = constrain(
      document["refreshAfterSeconds"] | 60U, kMinimumRefreshSeconds,
      kMaximumRefreshSeconds);
  for (JsonObjectConst source : pages) {
    PageRecord page;
    page.id = source["id"] | "";
    page.title = source["title"] | "";
    page.version = source["version"] | "";
    page.cachePath = source["cachePath"] | "";
    // Retain useful offline pages when upgrading a three-page cache.
    if (page.id == "codex") continue;
    if (parsed.pageCount >= kPageCountMax) return false;
    if (!isAllowedPageId(page.id) || !isValidVersion(page.version) ||
        !isValidCachePath(page.cachePath) || !fileMatchesVersion(page.cachePath, page.version) ||
        findPage(parsed, page.id) >= 0) {
      return false;
    }
    parsed.pages[parsed.pageCount++] = page;
  }

  if (parsed.pageCount == 0) return false;
  parsed.defaultPage = document["defaultPage"] | "";
  if (findPage(parsed, parsed.defaultPage) < 0) parsed.defaultPage = parsed.pages[0].id;
  state = parsed;
  return true;
}

bool loadState(PageSet &state) {
  if (parseStateFile(kStatePath, state)) return true;
  return parseStateFile(kStatePreviousPath, state);
}

bool saveState(const PageSet &state) {
  JsonDocument document;
  document["schemaVersion"] = 1;
  document["defaultPage"] = state.defaultPage;
  document["refreshAfterSeconds"] = state.refreshAfterSeconds;
  JsonArray pages = document["pages"].to<JsonArray>();
  for (size_t index = 0; index < state.pageCount; ++index) {
    const PageRecord &page = state.pages[index];
    JsonObject target = pages.add<JsonObject>();
    target["id"] = page.id;
    target["title"] = page.title;
    target["version"] = page.version;
    target["cachePath"] = page.cachePath;
  }

  LittleFS.remove(kStateNextPath);
  File file = LittleFS.open(kStateNextPath, "w");
  const size_t expectedBytes = measureJson(document);
  if (!file || serializeJson(document, file) != expectedBytes) {
    if (file) file.close();
    LittleFS.remove(kStateNextPath);
    return false;
  }
  file.flush();
  file.close();
  PageSet verified;
  if (!parseStateFile(kStateNextPath, verified)) {
    LittleFS.remove(kStateNextPath);
    return false;
  }

  LittleFS.remove(kStatePreviousPath);
  const bool hadCurrent = LittleFS.exists(kStatePath);
  if (hadCurrent && !LittleFS.rename(kStatePath, kStatePreviousPath)) {
    LittleFS.remove(kStateNextPath);
    return false;
  }
  if (!LittleFS.rename(kStateNextPath, kStatePath)) {
    if (hadCurrent) LittleFS.rename(kStatePreviousPath, kStatePath);
    return false;
  }
  LittleFS.remove(kStatePreviousPath);
  return true;
}

void cleanUnreferencedImages(const PageSet &state) {
  File directory = LittleFS.open(kCacheDirectory);
  if (!directory || !directory.isDirectory()) return;

  File entry = directory.openNextFile();
  while (entry) {
    String path = entry.path();
    const bool isDirectory = entry.isDirectory();
    entry.close();
    bool referenced = false;
    for (size_t index = 0; index < state.pageCount; ++index) {
      if (state.pages[index].cachePath == path) referenced = true;
    }
    if (!isDirectory && !referenced) LittleFS.remove(path);
    entry = directory.openNextFile();
  }
  directory.close();
}

bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  LOG.printf("[wifi] connecting to %s\n", INKPULSE_WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(INKPULSE_WIFI_SSID, INKPULSE_WIFI_PASSWORD);

  const uint32_t deadline = millis() + kWifiTimeoutMs;
  while (WiFi.status() != WL_CONNECTED && !deadlineReached(deadline)) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    LOG.println("[wifi] connection timed out");
    return false;
  }
  LOG.printf("[wifi] connected, RSSI %d dBm\n", WiFi.RSSI());
  return true;
}

bool synchronizeClock() {
  if (clockReady && time(nullptr) > 1700000000) return true;
  configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
  const uint32_t deadline = millis() + kClockTimeoutMs;
  while (time(nullptr) <= 1700000000 && !deadlineReached(deadline)) {
    delay(250);
  }
  clockReady = time(nullptr) > 1700000000;
  LOG.println(clockReady ? "[time] synchronized" : "[time] synchronization timed out");
  return clockReady;
}

bool beginSecureRequest(HTTPClient &http, WiFiClientSecure &client,
                        const String &url) {
  client.setCACert(INKPULSE_ROOT_CA);
  http.setConnectTimeout(10000);
  http.setTimeout(15000);
  http.useHTTP10(true);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(client, url)) return false;
  http.setUserAgent(String("InkPulse-E1001/") + INKPULSE_FIRMWARE_VERSION);
  http.addHeader("Authorization", String("Bearer ") + INKPULSE_DEVICE_TOKEN);
  return true;
}

bool fetchManifest(PageSet &manifest) {
  WiFiClientSecure client;
  HTTPClient http;
  const String url = baseUrl() + kManifestPath;
  if (!beginSecureRequest(http, client, url)) return false;

  const int status = http.GET();
  const int contentLength = http.getSize();
  if (status != HTTP_CODE_OK || contentLength <= 0 ||
      contentLength > static_cast<int>(kManifestBytesMax)) {
    LOG.printf("[sync] manifest HTTP %d, length %d\n", status, contentLength);
    http.end();
    return false;
  }

  const String body = http.getString();
  http.end();
  if (body.length() != static_cast<size_t>(contentLength)) return false;

  JsonDocument document;
  const DeserializationError error = deserializeJson(document, body);
  if (error || document["schemaVersion"].as<int>() != 1) {
    LOG.println("[sync] invalid manifest JSON or schema");
    return false;
  }

  JsonArrayConst pages = document["pages"].as<JsonArrayConst>();
  if (pages.isNull() || pages.size() == 0 || pages.size() > kPageCountMax) {
    LOG.println("[sync] invalid page count");
    return false;
  }

  PageSet parsed;
  const uint32_t refresh = document["refreshAfterSeconds"] | 60U;
  parsed.refreshAfterSeconds = constrain(refresh, kMinimumRefreshSeconds,
                                          kMaximumRefreshSeconds);
  for (JsonObjectConst source : pages) {
    PageRecord page;
    page.id = source["id"] | "";
    page.title = source["title"] | "";
    page.version = source["version"] | "";
    page.imageUrl = source["imageUrl"] | "";
    const int width = source["width"] | 0;
    const int height = source["height"] | 0;
    const String format = source["format"] | "";
    if (!isAllowedPageId(page.id) || findPage(parsed, page.id) >= 0 ||
        page.title.length() == 0 || page.title.length() > 48 ||
        !isValidVersion(page.version) || !isValidImageUrl(page.id, page.imageUrl) ||
        width != kDisplayWidth || height != kDisplayHeight || format != "png") {
      LOG.println("[sync] rejected page descriptor");
      return false;
    }
    parsed.pages[parsed.pageCount++] = page;
  }

  parsed.defaultPage = document["defaultPage"] | "";
  if (findPage(parsed, parsed.defaultPage) < 0) {
    LOG.println("[sync] invalid default page");
    return false;
  }
  // Absent on older servers: never hold.
  parsed.holdRedraws = document["holdRedraws"] | false;
  const uint32_t awayRedraw = document["awayRedrawSeconds"] | 0U;
  parsed.awayRedrawSeconds = awayRedraw == 0 ? 0 : constrain(awayRedraw, kMinimumAwayRedrawSeconds,
                                                             kMaximumRefreshSeconds);
  manifest = parsed;
  return true;
}

String cachePathFor(const PageRecord &page) {
  return String(kCacheDirectory) + "/" + page.id + "-" +
         page.version.substring(7) + ".png";
}

bool downloadPage(const PageRecord &page, const String &path) {
  WiFiClientSecure client;
  HTTPClient http;
  const String url = baseUrl() + page.imageUrl;
  if (!beginSecureRequest(http, client, url)) return false;

  const int status = http.GET();
  const int contentLength = http.getSize();
  if (status != HTTP_CODE_OK || contentLength < 24 ||
      contentLength > static_cast<int>(kPngBytesMax)) {
    LOG.printf("[sync] %s HTTP %d, length %d\n", page.id.c_str(), status,
               contentLength);
    http.end();
    return false;
  }

  LittleFS.remove(path);
  File target = LittleFS.open(path, "w");
  if (!target) {
    http.end();
    return false;
  }
  const int written = http.writeToStream(&target);
  target.flush();
  target.close();
  http.end();
  if (written != contentLength || !fileMatchesVersion(path, page.version)) {
    LittleFS.remove(path);
    LOG.printf("[sync] invalid download for %s\n", page.id.c_str());
    return false;
  }
  LOG.printf("[sync] cached %s (%d bytes)\n", page.id.c_str(), written);
  return true;
}

bool refreshPageSet() {
  if (!storageReady) {
    LOG.println("[fs] storage unavailable; preserving flash contents");
    if (!noCacheErrorShown) {
      showStatus("STORAGE UNAVAILABLE", "Restart or inspect LittleFS over serial.");
      noCacheErrorShown = true;
    }
    return false;
  }
  if (!firmwareConfigured()) {
    LOG.println("[config] copy secrets.example.h to secrets.h and set device values");
    if (cachedPages.pageCount == 0 && !noCacheErrorShown) {
      showStatus("CONFIGURATION NEEDED", "Create include/secrets.h, then flash again.");
      noCacheErrorShown = true;
    }
    return false;
  }
  if (!connectWifi() || !synchronizeClock()) {
    if (cachedPages.pageCount == 0 && !noCacheErrorShown) {
      showStatus("NETWORK UNAVAILABLE", "Check 2.4 GHz Wi-Fi and try Refresh.");
      noCacheErrorShown = true;
    }
    return false;
  }

  PageSet remote;
  if (!fetchManifest(remote)) {
    if (cachedPages.pageCount == 0 && !noCacheErrorShown) {
      showStatus("SERVER UNAVAILABLE", "TLS/API check failed; press Refresh to retry.");
      noCacheErrorShown = true;
    }
    return false;
  }

  PageSet next = remote;
  for (size_t index = 0; index < remote.pageCount; ++index) {
    PageRecord &target = next.pages[index];
    const int cachedIndex = findPage(cachedPages, target.id);
    if (cachedIndex >= 0 && cachedPages.pages[cachedIndex].version == target.version &&
        fileMatchesVersion(cachedPages.pages[cachedIndex].cachePath, target.version)) {
      target.cachePath = cachedPages.pages[cachedIndex].cachePath;
      continue;
    }

    target.cachePath = cachePathFor(target);
    if (!fileMatchesVersion(target.cachePath, target.version) &&
        !downloadPage(target, target.cachePath)) {
      LOG.printf("[sync] keeping previous page set after %s failed\n",
                 target.id.c_str());
      return false;
    }
  }

  if (!saveState(next)) {
    LOG.println("[sync] cache state commit failed");
    return false;
  }
  cachedPages = next;
  cleanUnreferencedImages(cachedPages);

  if (findPage(cachedPages, selectedPageId) < 0) {
    selectedPageId = cachedPages.defaultPage;
  }
  putStringIfChanged("page", selectedPageId);
  const int selectedIndex = findPage(cachedPages, selectedPageId);
  if (selectedIndex >= 0) {
    const PageRecord &selected = cachedPages.pages[selectedIndex];
    if (displayedPageId != selected.id || displayedVersion != selected.version) {
      // While the server reports nobody at the PC, keep caching but leave the
      // panel alone. A page must already be on screen: never hold a status or
      // diagnostic screen, and never hold for someone at the device.
      // A changed page may still be shown once per away interval.
      const bool awayIntervalDue =
          remote.awayRedrawSeconds > 0 &&
          millis() - lastPanelRefreshAt >= remote.awayRedrawSeconds * 1000UL;
      if (remote.holdRedraws && !localPresence() && displayedPageId.length() > 0) {
        if (awayIntervalDue) {
          redrawHeld = false;
          return renderPage(selected, RedrawReason::kAwayInterval);
        }
        ++sessionHeldPolls;
        if (!redrawHeld) LOG.println("[display] away: holding redraws; pages stay cached");
        redrawHeld = true;
        noCacheErrorShown = false;
        return true;
      }
      const RedrawReason reason =
          redrawHeld ? RedrawReason::kPresenceReturn : RedrawReason::kVersion;
      if (redrawHeld) {
        LOG.printf("[display] hold released (%lu held polls this boot)\n",
                   static_cast<unsigned long>(sessionHeldPolls));
      }
      redrawHeld = false;
      return renderPage(selected, reason);
    }
  }
  redrawHeld = false;
  noCacheErrorShown = false;
  LOG.println("[sync] page set already current");
  return true;
}

void scheduleNextRefresh() {
  const uint32_t seconds = constrain(cachedPages.refreshAfterSeconds,
                                     kMinimumRefreshSeconds,
                                     kMaximumRefreshSeconds);
  nextRefreshAt = millis() + seconds * 1000UL;
  LOG.printf("[sync] next check in %lu seconds\n", static_cast<unsigned long>(seconds));
}

void changePage(int direction) {
  if (cachedPages.pageCount < 2) return;
  int current = findPage(cachedPages, selectedPageId);
  if (current < 0) current = 0;
  const int count = static_cast<int>(cachedPages.pageCount);
  const int target = (current + direction + count) % count;
  if (renderPage(cachedPages.pages[target], RedrawReason::kButton)) {
    selectedPageId = cachedPages.pages[target].id;
    putStringIfChanged("page", selectedPageId);
  }
}

bool pressed(ButtonState &button) {
  const bool reading = digitalRead(button.pin);
  const uint32_t now = millis();
  if (reading != button.observed) {
    button.observed = reading;
    button.changedAt = now;
  }
  if (reading != button.stable && now - button.changedAt >= kButtonDebounceMs) {
    button.stable = reading;
    return button.stable == LOW;
  }
  return false;
}

void initializeButton(ButtonState &button) {
  pinMode(button.pin, INPUT);
  button.stable = digitalRead(button.pin);
  button.observed = button.stable;
  button.changedAt = millis();
}

}  // namespace

void setup() {
  LOG.begin(115200, SERIAL_8N1, kPinDebugRx, kPinDebugTx);
  delay(300);
  LOG.printf("\n[boot] InkPulse E1001 %s\n", INKPULSE_FIRMWARE_VERSION);
  LOG.printf("[boot] heap=%lu kB, PSRAM=%lu kB\n",
             static_cast<unsigned long>(ESP.getFreeHeap() / 1024),
             static_cast<unsigned long>(ESP.getPsramSize() / 1024));

  lastPanelRefreshAt = millis();
  initializeButton(refreshButton);
  initializeButton(leftButton);
  initializeButton(rightButton);
  preferences.begin("inkpulse", false);
  selectedPageId = preferences.getString("page", "");
  fullRedraws = preferences.getULong("rdFull", 0);
  partialRedraws = preferences.getULong("rdPart", 0);
  const uint32_t boots = preferences.getULong("boots", 0) + 1;
  preferences.putULong("boots", boots);
  LOG.printf("[stats] boot #%lu, lifetime panel refreshes: full=%lu partial=%lu\n",
             static_cast<unsigned long>(boots), static_cast<unsigned long>(fullRedraws),
             static_cast<unsigned long>(partialRedraws));

  // Format only on the first boot of a fresh partition. A later mount failure
  // must not erase potentially recoverable cached pages.
  const bool wasInitialized = preferences.getBool("fsReady", false);
  storageReady = LittleFS.begin(!wasInitialized);
  if (!storageReady) {
    LOG.println("[fs] LittleFS mount failed; refusing to format used storage");
  } else {
    if (!wasInitialized) preferences.putBool("fsReady", true);
    LittleFS.mkdir(kCacheDirectory);
    loadState(cachedPages);
  }

  display.begin();
  if (cachedPages.pageCount == 0) {
    display.fillScreen(TFT_WHITE);
    refreshPanel(RedrawReason::kFirstBootClear);
  }
  display.initGrayMode(GRAY_LEVEL4);
  display.fillSprite(TFT_GRAY_3);

  if (cachedPages.pageCount > 0) {
    if (findPage(cachedPages, selectedPageId) < 0) {
      selectedPageId = cachedPages.defaultPage;
    }
    const int selectedIndex = findPage(cachedPages, selectedPageId);
    if (selectedIndex >= 0) {
      const PageRecord &selected = cachedPages.pages[selectedIndex];
      // E-paper keeps its image without power. If NVS says this exact page
      // version is already on the panel, adopt it instead of redrawing.
      if (preferences.getString("shownPage", "") == selected.id &&
          preferences.getString("shownVer", "") == selected.version) {
        displayedPageId = selected.id;
        displayedVersion = selected.version;
        LOG.printf("[display] %s already on panel; boot redraw skipped\n",
                   selected.id.c_str());
      } else {
        renderPage(selected, RedrawReason::kBoot);
      }
    }
  } else {
    showFirstBootDiagnostic();
  }

  refreshPageSet();
  scheduleNextRefresh();
}

void loop() {
  if (pressed(leftButton)) {
    markLocalPresence();
    changePage(-1);
  }
  if (pressed(rightButton)) {
    markLocalPresence();
    changePage(1);
  }
  if (pressed(refreshButton)) {
    markLocalPresence();
    refreshPageSet();
    scheduleNextRefresh();
  }
  if (deadlineReached(nextRefreshAt)) {
    refreshPageSet();
    scheduleNextRefresh();
  }
  delay(10);
}
