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
#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <cstring>
#include <cctype>

static constexpr const char* TAG = "SdConfig";

// SDカードのファイルサイズ上限 (bytes)
static constexpr long kMaxConfigFileSize = 4096;

// NVS 値の長さ上限 (bytes)
static constexpr size_t kMaxNvsValueLen = 1024;

// JSON キー → NVS ネームスペース + NVS キー のマッピング (NVS キーは最大 15 文字)
struct KeyMap {
    const char* json_key;
    const char* nvs_namespace;
    const char* nvs_key;
};

static constexpr KeyMap kKeyMap[] = {
    {"websocket_url",   "websocket",              "url"},
};

static constexpr const char* kConfigPathCandidates[] = {
    "/sdcard/config.json",
    "/sdcard/CONFIG.JSON",
    "/sdcard/config.JSON",
    "/sdcard/hermes-config.json",
    "/sdcard/hermes/config.json",
    "/sdcard/stackchan/config.json",
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

// キー名が秘密情報かどうか判定
static bool is_secret_key(const char* key_name)
{
    return (std::strstr(key_name, "key") != nullptr ||
            std::strstr(key_name, "token") != nullptr ||
            std::strstr(key_name, "pass") != nullptr ||
            std::strstr(key_name, "password") != nullptr);
}

static bool is_valid_url_value(const char* key_name, const char* value)
{
    if (std::strcmp(key_name, "websocket_url") == 0) {
        return (std::strncmp(value, "ws://", 5) == 0 ||
                std::strncmp(value, "wss://", 6) == 0);
    }
    return std::strncmp(value, "https://", 8) == 0;
}

static std::string url_scheme(std::string_view url)
{
    auto scheme_end = url.find("://");
    if (scheme_end == std::string_view::npos || scheme_end == 0) {
        return "none";
    }
    return std::string(url.substr(0, scheme_end));
}

static cJSON* get_object_string(cJSON* root, const char* key)
{
    cJSON* item = cJSON_GetObjectItem(root, key);
    if (item && cJSON_IsString(item)) {
        return item;
    }
    return nullptr;
}

static std::string get_wifi_string(cJSON* root, const char* flat_key, const char* nested_key)
{
    if (auto* item = get_object_string(root, flat_key)) {
        return item->valuestring ? item->valuestring : "";
    }

    cJSON* wifi = cJSON_GetObjectItem(root, "wifi");
    if (wifi && cJSON_IsObject(wifi)) {
        if (auto* item = get_object_string(wifi, nested_key)) {
            return item->valuestring ? item->valuestring : "";
        }
    }

    return "";
}

static bool get_json_bool(cJSON* root, const char* key, bool& out)
{
    cJSON* item = cJSON_GetObjectItem(root, key);
    if (!item) {
        return false;
    }
    if (cJSON_IsBool(item)) {
        out = cJSON_IsTrue(item);
        return true;
    }
    if (cJSON_IsNumber(item)) {
        out = item->valueint != 0;
        return true;
    }
    if (cJSON_IsString(item) && item->valuestring) {
        std::string value;
        for (const char* p = item->valuestring; *p; ++p) {
            value.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*p))));
        }
        if (value == "true" || value == "yes" || value == "on" || value == "1") {
            out = true;
            return true;
        }
        if (value == "false" || value == "no" || value == "off" || value == "0") {
            out = false;
            return true;
        }
    }
    return false;
}

static bool get_json_int(cJSON* root, const char* key, int min_value, int max_value, int& out)
{
    cJSON* item = cJSON_GetObjectItem(root, key);
    if (!item) {
        return false;
    }

    int value = 0;
    if (cJSON_IsNumber(item)) {
        value = item->valueint;
    } else if (cJSON_IsString(item) && item->valuestring) {
        char* end = nullptr;
        long parsed = std::strtol(item->valuestring, &end, 10);
        if (end == item->valuestring || *end != '\0') {
            return false;
        }
        value = static_cast<int>(parsed);
    } else {
        return false;
    }

    if (value < min_value || value > max_value) {
        return false;
    }
    out = value;
    return true;
}

static bool get_face_tracking_mode(cJSON* root, int& out)
{
    cJSON* item = cJSON_GetObjectItem(root, "face_tracking_mode");
    if (!item) {
        return false;
    }
    if (cJSON_IsNumber(item)) {
        int value = item->valueint;
        if (value < 0 || value > 3) {
            return false;
        }
        out = value;
        return true;
    }
    if (!cJSON_IsString(item) || item->valuestring == nullptr) {
        return false;
    }

    std::string value;
    for (const char* p = item->valuestring; *p; ++p) {
        const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(*p)));
        value.push_back(c == '-' ? '_' : c);
    }

    if (value == "off" || value == "disabled" || value == "0") {
        out = 0;
    } else if (value == "standby" || value == "standby_only" || value == "1") {
        out = 1;
    } else if (value == "standby_speaking" || value == "standby+speaking" || value == "2") {
        out = 2;
    } else if (value == "standby_listening_speaking" || value == "all" || value == "3") {
        out = 3;
    } else {
        return false;
    }
    return true;
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
    if (!json.is_valid()) {
        result.error = "Invalid JSON format";
        log(result.error);
        return result;
    }

    log("Saving to NVS...");

    bool imported_websocket_url = false;
    bool imported_websocket_version = false;

    // 5. マッピングされたキーを NVS に保存
    for (const auto& [json_key, nvs_ns, nvs_key] : kKeyMap) {
        cJSON* item = cJSON_GetObjectItem(json.root, json_key);
        if (!item || !cJSON_IsString(item)) {
            continue;
        }

        const char* value = item->valuestring;
        if (!value || value[0] == '\0') {
            continue;
        }

        // 値の長さ検証
        const size_t value_len = std::strlen(value);
        if (value_len > kMaxNvsValueLen) {
            mclog::tagWarn(TAG, "skip {}: value too long ({} bytes)", json_key, value_len);
            continue;
        }

        // URL スキーム検証
        if (std::strstr(json_key, "url") != nullptr) {
            if (!is_valid_url_value(json_key, value)) {
                mclog::tagWarn(TAG, "skip {}: invalid URL scheme", json_key);
                continue;
            }
        }

        Settings ns_settings(nvs_ns, true);
        ns_settings.SetString(nvs_key, value);

        if (std::strcmp(json_key, "websocket_url") == 0) {
            ns_settings.SetString("url_override", value);
            imported_websocket_url = true;
        }

        result.imported_keys.push_back(json_key);

        // APIキー類はキー名と長さのみログ出力 (値は出力しない)
        if (std::strcmp(json_key, "websocket_url") == 0) {
            mclog::tagInfo(TAG, "imported: {} configured, length={}, scheme={}", json_key, value_len,
                           url_scheme(value));
        } else if (is_secret_key(json_key)) {
            mclog::tagInfo(TAG, "imported secret: {} (length={})", json_key, value_len);
        } else {
            mclog::tagInfo(TAG, "imported: {} = {}", json_key, value);
        }
    }

    cJSON* websocket_version = cJSON_GetObjectItem(json.root, "websocket_version");
    if (websocket_version && cJSON_IsNumber(websocket_version)) {
        int version = websocket_version->valueint;
        if (version < 1 || version > 3) {
            mclog::tagWarn(TAG, "skip websocket_version: unsupported version {}", version);
        } else {
            Settings ws_settings("websocket", true);
            ws_settings.SetInt("version", version);
            result.imported_keys.push_back("websocket_version");
            imported_websocket_version = true;
            mclog::tagInfo(TAG, "imported: websocket_version = {}", version);
        }
    }

    if (imported_websocket_url && !imported_websocket_version) {
        Settings ws_settings("websocket", true);
        ws_settings.SetInt("version", 3);
        mclog::tagInfo(TAG, "defaulted: websocket_version = 3");
    }

    {
        Settings hermes_settings("hermes", true);

        bool face_enabled = false;
        if (get_json_bool(json.root, "face_tracking_enabled", face_enabled)) {
            hermes_settings.SetBool("face_en", face_enabled);
            result.imported_keys.push_back("face_tracking_enabled");
            mclog::tagInfo(TAG, "imported: face_tracking_enabled = {}", face_enabled);
        } else if (cJSON_GetObjectItem(json.root, "face_tracking_enabled")) {
            mclog::tagWarn(TAG, "skip face_tracking_enabled: expected boolean");
        }

        int face_hz = 0;
        if (get_json_int(json.root, "face_tracking_hz", 1, 10, face_hz)) {
            hermes_settings.SetInt("face_hz", face_hz);
            result.imported_keys.push_back("face_tracking_hz");
            mclog::tagInfo(TAG, "imported: face_tracking_hz = {}", face_hz);
        } else if (cJSON_GetObjectItem(json.root, "face_tracking_hz")) {
            mclog::tagWarn(TAG, "skip face_tracking_hz: expected integer 1..10");
        }

        int face_mode = 0;
        if (get_face_tracking_mode(json.root, face_mode)) {
            hermes_settings.SetInt("face_mode", face_mode);
            result.imported_keys.push_back("face_tracking_mode");
            mclog::tagInfo(TAG, "imported: face_tracking_mode = {}", face_mode);
        } else if (cJSON_GetObjectItem(json.root, "face_tracking_mode")) {
            mclog::tagWarn(TAG, "skip face_tracking_mode: expected off/standby/standby_speaking/all");
        }
    }

    const std::string wifi_ssid     = get_wifi_string(json.root, "wifi_ssid", "ssid");
    const std::string wifi_password = get_wifi_string(json.root, "wifi_password", "password");
    if (!wifi_ssid.empty() || !wifi_password.empty()) {
        if (wifi_ssid.empty()) {
            mclog::tagWarn(TAG, "skip wifi credentials: wifi_ssid is empty");
        } else if (wifi_ssid.length() > 32) {
            mclog::tagWarn(TAG, "skip wifi credentials: wifi_ssid too long ({} bytes)", wifi_ssid.length());
        } else if (wifi_password.length() > 64) {
            mclog::tagWarn(TAG, "skip wifi credentials: wifi_password too long ({} bytes)", wifi_password.length());
        } else {
            SsidManager::GetInstance().AddSsid(wifi_ssid, wifi_password);
            result.imported_keys.push_back("wifi_ssid");
            result.imported_keys.push_back("wifi_password");
            result.imported_wifi_credentials = true;

            Settings app_config("app_config", true);
            app_config.SetBool("is_configed", true);

            mclog::tagInfo(TAG, "imported Wi-Fi credentials: ssid length={}, password configured={}",
                           wifi_ssid.length(), !wifi_password.empty());
        }
    }

    if (result.imported_keys.empty()) {
        result.error = "No valid keys found\nCheck key names in config.json";
        log(result.error);
        return result;
    }

    result.success = true;
    log(fmt::format("Done: {} key(s) imported", result.imported_keys.size()));
    return result;
}

}  // namespace sd_config
