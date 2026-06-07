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
    bool config_file_found = false;
    bool applied = false;
    bool imported_wifi_credentials = false;
    bool imported_websocket_url = false;
    std::string error;
    std::vector<std::string> imported_keys;
    std::vector<std::string> warnings;
};

/**
 * @brief SDカード上の標準設定ファイルパス
 */
static constexpr const char* CONFIG_PATH = "/sdcard/config.json";

/**
 * @brief SDカードの config.json を読み込み、起動時キャッシュとして NVS に反映する。
 *
 * AIAvatarStackChan と同じく、SD の config.json を起動時の正本として扱う。
 * 有効な config.json がある場合、WebSocket と Wi-Fi の関連NVSは
 * 差分上書きではなく config.json の内容に合わせて再構築される。
 *
 * 対応例:
 * {
 *   "wifi_networks": [
 *     {"name": "Home", "ssid": "YOUR_2_4GHZ_WIFI_SSID", "pass": "YOUR_WIFI_PASSWORD"}
 *   ],
 *   "websocket_url": "ws://192.168.1.x:8765/ws",
 *   "websocket_version": 3,
 *   "timezone": "JST-9",
 *   "speaker_volume": 80,
 *   "display_brightness": 64
 * }
 *
 * AIAvatarStackChan 互換の ws_host/ws_port/ws_path も受け付ける。
 *
 * @param on_log 進捗ログコールバック (nullptr可)
 * @return LoadResult 読み込み結果
 */
LoadResult load_and_apply(std::function<void(std::string_view)> on_log = nullptr);

}  // namespace sd_config
