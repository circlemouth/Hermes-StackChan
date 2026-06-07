/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "sd_config.h"
#include <cJSON.h>
#include <settings.h>
#include <ssid_manager.h>
#include <mooncake_log.h>
#include <nvs.h>
#include <esp_err.h>
#include <algorithm>
#include <initializer_list>
#include <cstdio>
#include <dirent.h>
#include <cstring>
#include <cctype>

static constexpr const char* TAG = "SdConfig";

// SDカードのファイルサイズ上限 (bytes)
static constexpr long kMaxConfigFileSize = 8192;

// NVS 値の長さ上限 (bytes)
static constexpr size_t kMaxNvsValueLen = 1024;
static constexpr size_t kMaxWifiProfiles = 5;

static constexpr const char* kConfigPathCandidates[] = {
    "/sdcard/config.json",
    "/sdcard/CONFIG.JSON",
    "/sdcard/config.JSON",
    "/sdcard/hermes-config.json",
    "/sdcard/hermes/config.json",
    "/sdcard/stackchan/config.json",
};

struct WifiProfile {
    std::string name;
    std::string ssid;
    std::string password;
};

struct ConfigSnapshot {
    bool has_websocket_url = false;
    std::string websocket_url;
    int websocket_version = 3;

    std::vector<WifiProfile> wifi_profiles;

    bool has_timezone = false;
    std::string timezone;

    bool has_speaker_volume = false;
    int speaker_volume = 80;

    bool has_display_brightness = false;
    int display_brightness = 64;

    std::vector<std::string> imported_keys;
    std::vector<std::string> warnings;
};

static std::string list_sdcard_root_entries()
{
    DIR* dir = opendir("/sdcard");
    if (!dir) {
        return "Cannot list /sdcard";
    }

    std::string entries;
    while (auto* entry = readdir(dir)) {
        if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        if (!entries.empty()) {
            entries += ", ";
        }
        entries += entry->d_name;
    }
    closedir(dir);

    if (entries.empty()) {
        return "/sdcard is empty";
    }
    return "Files in /sdcard: " + entries;
}

static bool ends_with(std::string_view value, std::string_view suffix)
{
    return value.size() >= suffix.size() &&
           value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static bool looks_like_config_short_name(const char* name)
{
    std::string upper;
    for (const char* p = name; p && *p; ++p) {
        upper.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(*p))));
    }

    if (!(ends_with(upper, ".JSO") || ends_with(upper, ".JSON"))) {
        return false;
    }
    return upper.rfind("CONFIG", 0) == 0 || upper.rfind("CONFI~", 0) == 0;
}

static std::string find_config_short_path()
{
    DIR* dir = opendir("/sdcard");
    if (!dir) {
        return "";
    }

    std::string found;
    while (auto* entry = readdir(dir)) {
        if (!looks_like_config_short_name(entry->d_name)) {
            continue;
        }
        found = std::string("/sdcard/") + entry->d_name;
        break;
    }
    closedir(dir);
    return found;
}

// FILE* の RAII ラッパー
struct FileGuard {
    FILE* f = nullptr;
    std::string path;
    FileGuard() = default;
    ~FileGuard() { if (f) fclose(f); }
    bool is_open() const { return f != nullptr; }
    bool open(const char* open_path)
    {
        if (f) {
            fclose(f);
            f = nullptr;
        }
        path = open_path;
        f = fopen(open_path, "r");
        return f != nullptr;
    }
    FileGuard(const FileGuard&) = delete;
    FileGuard& operator=(const FileGuard&) = delete;
};

// cJSON* の RAII ラッパー
struct CJsonGuard {
    cJSON* root = nullptr;
    explicit CJsonGuard(const char* s) : root(cJSON_Parse(s)) {}
    ~CJsonGuard() { if (root) cJSON_Delete(root); }
    bool is_valid() const { return root != nullptr; }
    CJsonGuard(const CJsonGuard&) = delete;
    CJsonGuard& operator=(const CJsonGuard&) = delete;
};

static void add_warning(ConfigSnapshot& snapshot, const std::string& warning)
{
    snapshot.warnings.push_back(warning);
    mclog::tagWarn(TAG, "{}", warning);
}

static std::string get_string(cJSON* object, const char* key, const char* fallback = "")
{
    if (!object || !cJSON_IsObject(object)) {
        return fallback ? fallback : "";
    }
    cJSON* item = cJSON_GetObjectItem(object, key);
    if (item && cJSON_IsString(item) && item->valuestring) {
        return item->valuestring;
    }
    return fallback ? fallback : "";
}

static bool get_int(cJSON* object, const char* key, int& out)
{
    if (!object || !cJSON_IsObject(object)) {
        return false;
    }
    cJSON* item = cJSON_GetObjectItem(object, key);
    if (item && cJSON_IsNumber(item)) {
        out = item->valueint;
        return true;
    }
    return false;
}

static std::string get_first_string(cJSON* object, std::initializer_list<const char*> keys)
{
    for (const auto* key : keys) {
        const auto value = get_string(object, key);
        if (!value.empty()) {
            return value;
        }
    }
    return "";
}

static std::string get_nested_wifi_string(cJSON* root, std::initializer_list<const char*> flat_keys,
                                          std::initializer_list<const char*> nested_keys)
{
    auto value = get_first_string(root, flat_keys);
    if (!value.empty()) {
        return value;
    }

    cJSON* wifi = cJSON_GetObjectItem(root, "wifi");
    if (wifi && cJSON_IsObject(wifi)) {
        value = get_first_string(wifi, nested_keys);
        if (!value.empty()) {
            return value;
        }
    }
    return "";
}

static bool is_valid_websocket_url(std::string_view value)
{
    return value.rfind("ws://", 0) == 0 || value.rfind("wss://", 0) == 0;
}

static std::string url_scheme(std::string_view url)
{
    auto scheme_end = url.find("://");
    if (scheme_end == std::string_view::npos || scheme_end == 0) {
        return "none";
    }
    return std::string(url.substr(0, scheme_end));
}

static std::string normalize_ws_path(std::string path)
{
    if (path.empty()) {
        return "/ws";
    }
    if (path[0] != '/') {
        path.insert(path.begin(), '/');
    }
    return path;
}

static bool append_wifi_profile(ConfigSnapshot& snapshot, const WifiProfile& profile, const char* source)
{
    if (profile.ssid.empty()) {
        return false;
    }
    if (profile.ssid.length() > 32) {
        add_warning(snapshot, fmt::format("skip {}: ssid too long ({} bytes)", source, profile.ssid.length()));
        return false;
    }
    if (profile.password.length() > 64) {
        add_warning(snapshot, fmt::format("skip {}: password too long ({} bytes)", source, profile.password.length()));
        return false;
    }
    if (snapshot.wifi_profiles.size() >= kMaxWifiProfiles) {
        add_warning(snapshot, fmt::format("skip {}: too many Wi-Fi profiles (max {})", source, kMaxWifiProfiles));
        return false;
    }
    snapshot.wifi_profiles.push_back(profile);
    return true;
}

static std::string build_websocket_url_from_aiavatar_keys(cJSON* root, ConfigSnapshot& snapshot)
{
    const std::string host = get_string(root, "ws_host");
    if (host.empty()) {
        return "";
    }

    if (host.find("://") != std::string::npos) {
        if (is_valid_websocket_url(host)) {
            return host;
        }
        add_warning(snapshot, "skip ws_host: invalid websocket URL scheme");
        return "";
    }

    int port = 443;
    get_int(root, "ws_port", port);
    if (port <= 0 || port > 65535) {
        add_warning(snapshot, fmt::format("skip ws_port: invalid port {}", port));
        return "";
    }

    std::string scheme = get_string(root, "ws_scheme");
    if (scheme.empty()) {
        scheme = (port == 443) ? "wss" : "ws";
    }
    if (scheme != "ws" && scheme != "wss") {
        add_warning(snapshot, "skip ws_scheme: use ws or wss");
        return "";
    }

    const std::string path = normalize_ws_path(get_string(root, "ws_path", "/ws"));
    return fmt::format("{}://{}:{}{}", scheme, host, port, path);
}

static void parse_websocket_config(cJSON* root, ConfigSnapshot& snapshot)
{
    std::string websocket_url = get_first_string(root, {"websocket_url", "bridge_url", "ws_url"});
    cJSON* websocket = cJSON_GetObjectItem(root, "websocket");
    if (websocket_url.empty() && websocket && cJSON_IsObject(websocket)) {
        websocket_url = get_first_string(websocket, {"url", "websocket_url", "bridge_url"});
    }
    if (websocket_url.empty()) {
        websocket_url = build_websocket_url_from_aiavatar_keys(root, snapshot);
    }

    if (!websocket_url.empty()) {
        if (!is_valid_websocket_url(websocket_url)) {
            add_warning(snapshot, "skip websocket_url: URL must start with ws:// or wss://");
        } else if (websocket_url.length() > kMaxNvsValueLen) {
            add_warning(snapshot, fmt::format("skip websocket_url: value too long ({} bytes)", websocket_url.length()));
        } else {
            snapshot.has_websocket_url = true;
            snapshot.websocket_url = websocket_url;
            snapshot.imported_keys.push_back("websocket_url");
        }
    }

    int version = 3;
    bool has_version = get_int(root, "websocket_version", version);
    if (!has_version && websocket && cJSON_IsObject(websocket)) {
        has_version = get_int(websocket, "version", version);
    }
    if (has_version) {
        if (version < 1 || version > 3) {
            add_warning(snapshot, fmt::format("skip websocket_version: unsupported version {}", version));
        } else {
            snapshot.websocket_version = version;
            snapshot.imported_keys.push_back("websocket_version");
        }
    }
}

static void parse_wifi_config(cJSON* root, ConfigSnapshot& snapshot)
{
    const std::string flat_ssid = get_nested_wifi_string(root, {"wifi_ssid"}, {"ssid"});
    const std::string flat_pass = get_nested_wifi_string(root, {"wifi_password", "wifi_pass"}, {"password", "pass"});

    cJSON* networks = cJSON_GetObjectItem(root, "wifi_networks");
    if (networks && cJSON_IsArray(networks)) {
        int index = 0;
        cJSON* item = nullptr;
        cJSON_ArrayForEach(item, networks) {
            if (!cJSON_IsObject(item)) {
                ++index;
                continue;
            }

            WifiProfile profile;
            profile.name = get_string(item, "name");
            profile.ssid = get_string(item, "ssid");
            profile.password = get_first_string(item, {"pass", "password"});

            if (!profile.ssid.empty()) {
                if (append_wifi_profile(snapshot, profile, fmt::format("wifi_networks[{}]", index).c_str())) {
                    if (snapshot.imported_keys.empty() ||
                        std::find(snapshot.imported_keys.begin(), snapshot.imported_keys.end(), "wifi_networks") == snapshot.imported_keys.end()) {
                        snapshot.imported_keys.push_back("wifi_networks");
                    }
                }
            }
            ++index;
        }
    }

    // AIAvatarStackChan と同様に、配列が空/無効で flat Wi-Fi がある場合はそれを1件目にする。
    if (snapshot.wifi_profiles.empty() && !flat_ssid.empty()) {
        WifiProfile profile;
        profile.ssid = flat_ssid;
        profile.password = flat_pass;
        if (append_wifi_profile(snapshot, profile, "wifi_ssid")) {
            snapshot.imported_keys.push_back("wifi_ssid");
            snapshot.imported_keys.push_back(flat_pass.empty() ? "wifi_pass(empty)" : "wifi_password");
        }
    } else if (flat_ssid.empty() && !flat_pass.empty()) {
        add_warning(snapshot, "skip Wi-Fi credentials: ssid is empty");
    }
}

static void parse_optional_device_config(cJSON* root, ConfigSnapshot& snapshot)
{
    const std::string timezone = get_string(root, "timezone");
    if (!timezone.empty()) {
        if (timezone.length() > 47) {
            add_warning(snapshot, fmt::format("skip timezone: value too long ({} bytes)", timezone.length()));
        } else {
            snapshot.has_timezone = true;
            snapshot.timezone = timezone;
            snapshot.imported_keys.push_back("timezone");
        }
    }

    int speaker_volume = 0;
    if (get_int(root, "speaker_volume", speaker_volume)) {
        snapshot.has_speaker_volume = true;
        snapshot.speaker_volume = std::max(0, std::min(100, speaker_volume));
        snapshot.imported_keys.push_back("speaker_volume");
    }

    int display_brightness = 0;
    if (get_int(root, "display_brightness", display_brightness)) {
        snapshot.has_display_brightness = true;
        snapshot.display_brightness = std::max(0, std::min(100, display_brightness));
        snapshot.imported_keys.push_back("display_brightness");
    }
}

static ConfigSnapshot parse_snapshot(cJSON* root)
{
    ConfigSnapshot snapshot;
    parse_websocket_config(root, snapshot);
    parse_wifi_config(root, snapshot);
    parse_optional_device_config(root, snapshot);
    return snapshot;
}

static void erase_nvs_key(const char* ns, const char* key)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        mclog::tagWarn(TAG, "nvs_open({}) failed while erasing {}: {}", ns, key, esp_err_to_name(err));
        return;
    }

    err = nvs_erase_key(handle, key);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        mclog::tagWarn(TAG, "nvs_erase_key({}/{}) failed: {}", ns, key, esp_err_to_name(err));
    }
    nvs_commit(handle);
    nvs_close(handle);
}

static void apply_websocket_to_nvs(const ConfigSnapshot& snapshot)
{
    if (snapshot.has_websocket_url) {
        Settings ws_settings("websocket", true);
        ws_settings.SetString("url", snapshot.websocket_url);
        ws_settings.SetString("url_override", snapshot.websocket_url);
        ws_settings.SetInt("version", snapshot.websocket_version);

        mclog::tagInfo(TAG, "applied websocket_url: length={}, scheme={}",
                       snapshot.websocket_url.length(), url_scheme(snapshot.websocket_url));
        mclog::tagInfo(TAG, "applied websocket_version: {}", snapshot.websocket_version);
        return;
    }

    // SD を正本にするため、有効な config.json に WebSocket 設定が無い場合は古い値を残さない。
    erase_nvs_key("websocket", "url");
    erase_nvs_key("websocket", "url_override");
    erase_nvs_key("websocket", "version");
    mclog::tagInfo(TAG, "cleared websocket settings because config.json has no websocket endpoint");
}

static void apply_wifi_to_nvs(const ConfigSnapshot& snapshot)
{
    // esp-wifi-connect は wifi namespace に ssid/password, ssid1/password1 ... を保存する。
    // SD を正本にするため、最初に保存済みSSIDリストを消してから config.json の順に再登録する。
    auto& ssid_manager = SsidManager::GetInstance();
    ssid_manager.Clear();

    if (snapshot.wifi_profiles.empty()) {
        Settings app_config("app_config", true);
        app_config.SetBool("is_configed", false);
        mclog::tagInfo(TAG, "cleared Wi-Fi credentials because config.json has no Wi-Fi profiles");
        return;
    }

    // SsidManager::AddSsid() は新しいSSIDを先頭候補に入れる実装なので、
    // JSONの先頭を優先候補にするため逆順で追加する。
    for (auto it = snapshot.wifi_profiles.rbegin(); it != snapshot.wifi_profiles.rend(); ++it) {
        ssid_manager.AddSsid(it->ssid, it->password);
        mclog::tagInfo(TAG, "applied Wi-Fi profile: ssid length={}, password configured={}",
                       it->ssid.length(), !it->password.empty());
    }

    Settings app_config("app_config", true);
    app_config.SetBool("is_configed", true);
}

static void apply_optional_device_config_to_nvs(const ConfigSnapshot& snapshot)
{
    if (snapshot.has_timezone) {
        Settings system_settings("system", true);
        system_settings.SetString("tz", snapshot.timezone);
        mclog::tagInfo(TAG, "applied timezone: {}", snapshot.timezone);
    }

    if (snapshot.has_speaker_volume) {
        Settings audio_settings("audio", true);
        audio_settings.SetInt("output_volume", snapshot.speaker_volume);
        mclog::tagInfo(TAG, "applied speaker_volume: {}", snapshot.speaker_volume);
    }

    if (snapshot.has_display_brightness) {
        Settings display_settings("display", true);
        display_settings.SetInt("brightness", snapshot.display_brightness);
        mclog::tagInfo(TAG, "applied display_brightness: {}", snapshot.display_brightness);
    }
}

static void apply_snapshot_to_nvs(const ConfigSnapshot& snapshot)
{
    apply_websocket_to_nvs(snapshot);
    apply_wifi_to_nvs(snapshot);
    apply_optional_device_config_to_nvs(snapshot);
}

namespace sd_config {

LoadResult load_and_apply(std::function<void(std::string_view)> on_log)
{
    LoadResult result;

    auto log = [&](std::string_view msg) {
        mclog::tagInfo(TAG, "{}", msg);
        if (on_log) {
            on_log(msg);
        }
    };

    log("Opening SD config file ...");

    // 1. ファイルを開く
    FileGuard file;
    for (const auto* path : kConfigPathCandidates) {
        if (file.open(path)) {
            break;
        }
    }
    if (!file.is_open()) {
        const auto short_path = find_config_short_path();
        if (!short_path.empty()) {
            file.open(short_path.c_str());
        }
    }

    if (!file.is_open()) {
        const auto entries = list_sdcard_root_entries();
        mclog::tagWarn(TAG, "{}", entries);
        result.error = "Cannot open config.json on SD card\nPlace config.json at the SD card root";
        log(result.error);
        return result;
    }
    result.config_file_found = true;
    log(fmt::format("Using {}", file.path));

    // 2. ファイルサイズを取得
    if (fseek(file.f, 0, SEEK_END) != 0) {
        result.error = "fseek failed on config file";
        log(result.error);
        return result;
    }

    long file_size = ftell(file.f);
    if (file_size < 0) {
        result.error = "ftell failed on config file";
        log(result.error);
        return result;
    }

    if (file_size == 0 || file_size > kMaxConfigFileSize) {
        result.error = fmt::format("File size invalid ({} bytes, max {})",
                                   file_size, kMaxConfigFileSize);
        log(result.error);
        return result;
    }

    fseek(file.f, 0, SEEK_SET);

    // 3. ファイルを読み込む
    std::string content(static_cast<size_t>(file_size), '\0');
    size_t read_size = fread(content.data(), 1, static_cast<size_t>(file_size), file.f);

    if (ferror(file.f)) {
        result.error = "Read error on /sdcard/config.json";
        log(result.error);
        return result;
    }

    content.resize(read_size);

    log("Parsing JSON...");

    // 4. JSON をパース (RAII で自動解放)
    CJsonGuard json(content.c_str());
    if (!json.is_valid() || !cJSON_IsObject(json.root)) {
        result.error = "Invalid JSON format";
        log(result.error);
        return result;
    }

    ConfigSnapshot snapshot = parse_snapshot(json.root);

    log("Applying SD config snapshot to NVS...");
    apply_snapshot_to_nvs(snapshot);

    result.applied = true;
    result.success = true;
    result.imported_wifi_credentials = !snapshot.wifi_profiles.empty();
    result.imported_websocket_url = snapshot.has_websocket_url;
    result.imported_keys = snapshot.imported_keys;
    result.warnings = snapshot.warnings;

    if (result.imported_keys.empty()) {
        result.warnings.push_back("No recognized keys found; cleared WebSocket and Wi-Fi settings");
        mclog::tagWarn(TAG, "No recognized keys found; SD snapshot was still applied to clear stale settings");
    }

    log(fmt::format("Done: config applied, {} key(s), {} warning(s)",
                    result.imported_keys.size(), result.warnings.size()));
    return result;
}

}  // namespace sd_config
