/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "sd_config.h"
#include <cJSON.h>
#include <settings.h>
#include <mooncake_log.h>
#include <cstdio>
#include <cstring>

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

// FILE* の RAII ラッパー
struct FileGuard {
    FILE* f = nullptr;
    explicit FileGuard(const char* path) : f(fopen(path, "r")) {}
    ~FileGuard() { if (f) fclose(f); }
    bool is_open() const { return f != nullptr; }
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
            std::strstr(key_name, "token") != nullptr);
}

static bool is_valid_url_value(const char* key_name, const char* value)
{
    if (std::strcmp(key_name, "websocket_url") == 0) {
        return (std::strncmp(value, "ws://", 5) == 0 ||
                std::strncmp(value, "wss://", 6) == 0);
    }
    return std::strncmp(value, "https://", 8) == 0;
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

    log("Opening /sdcard/config.json ...");

    // 1. ファイルを開く
    FileGuard file(CONFIG_PATH);
    if (!file.is_open()) {
        result.error = "Cannot open /sdcard/config.json\nCheck SD card is inserted";
        log(result.error);
        return result;
    }

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
        if (is_secret_key(json_key)) {
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
