/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include <string>
#include <vector>
#include <functional>

namespace sd_config {

/**
 * @brief SDカードの config.json から読み込んだ結果
 */
struct LoadResult {
    bool success = false;
    std::string error;
    std::vector<std::string> imported_keys;
};

/**
 * @brief NVS ネームスペース名 (ai_config)
 */
static constexpr const char* NVS_NAMESPACE = "ai_config";

/**
 * @brief SDカード上の設定ファイルパス
 */
static constexpr const char* CONFIG_PATH = "/sdcard/config.json";

/**
 * @brief SDカードの config.json を読み込み、NVS に保存する
 *
 * config.json の例:
 * {
 *   "ota_url":         "https://your-server/ota/",
 *   "openai_api_key":  "local",
 *   "openai_base_url": "http://192.168.1.x:11434/v1",
 *   "openai_model":    "qwen2.5:7b",
 *   "websocket_url":   "ws://192.168.1.x:8765/ws",
 *   "websocket_version": 3
 * }
 *
 * @param on_log 進捗ログコールバック (nullptr可)
 * @return LoadResult 読み込み結果
 */
LoadResult load_and_apply(std::function<void(std::string_view)> on_log = nullptr);

}  // namespace sd_config
