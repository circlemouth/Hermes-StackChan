/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "app_ai_agent.h"
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include <assets/assets.h>
#include <smooth_lvgl.hpp>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include <settings.h>
#include <board.h>
#include <display.h>
#include <esp_log.h>
#include <string>
#include <string_view>
#include "sdkconfig.h"

using namespace mooncake;
using namespace smooth_ui_toolkit::lvgl_cpp;

static const char* TAG = "AppAiAgent";

namespace {

constexpr size_t kBubbleMessageMaxLen = 260;

static const char* wifi_status_to_string(WifiStatus status)
{
    switch (status) {
        case WifiStatus::None:
            return "None";
        case WifiStatus::Low:
            return "Low";
        case WifiStatus::Medium:
            return "Medium";
        case WifiStatus::High:
            return "High";
        default:
            return "Unknown";
    }
}

static std::string websocket_scheme(std::string_view url)
{
    auto scheme_end = url.find("://");
    if (scheme_end == std::string_view::npos || scheme_end == 0) {
        return "none";
    }
    return std::string(url.substr(0, scheme_end));
}

static bool has_supported_websocket_scheme(std::string_view url)
{
    return url.rfind("ws://", 0) == 0 || url.rfind("wss://", 0) == 0;
}

static std::string get_websocket_url()
{
    Settings ws_settings("websocket", false);
    std::string websocket_url = ws_settings.GetString("url_override", "");
    if (websocket_url.empty()) {
        websocket_url = ws_settings.GetString("url", "");
    }
    return websocket_url;
}

static std::string sanitize_for_bubble(std::string message)
{
    for (char& c : message) {
        if (c == '\r' || c == '\n' || c == '\t') {
            c = ' ';
        }
    }

    while (message.find("  ") != std::string::npos) {
        auto pos = message.find("  ");
        message.replace(pos, 2, " ");
    }

    if (message.length() > kBubbleMessageMaxLen) {
        message.resize(kBubbleMessageMaxLen - 3);
        message += "...";
    }
    return message;
}

static std::string build_connectivity_error_message(bool has_sd_config_error, const std::string& sd_error_detail,
                                                    const std::string& websocket_url,
                                                    bool websocket_scheme_ready, bool wifi_ready_for_runtime)
{
    if (has_sd_config_error) {
        std::string message = "HERMES config error";
        if (!sd_error_detail.empty()) {
            message += ": ";
            message += sd_error_detail;
        }
        message += ". Check SD /config.json.";
        return sanitize_for_bubble(message);
    }

    if (websocket_url.empty()) {
        return "HERMES endpoint error: websocket_url is missing or invalid. Check SD /config.json.";
    }

    if (!websocket_scheme_ready) {
        return "HERMES endpoint error: websocket_url must start with ws:// or wss://. Check SD /config.json.";
    }

    if (!wifi_ready_for_runtime) {
        return "HERMES Wi-Fi error: wifi_networks is missing or empty. Check SD /config.json.";
    }

    return "HERMES connection error: check Wi-Fi and websocket_url in SD /config.json.";
}

}  // namespace

AppAiAgent::AppAiAgent()
{
    // Configure App name
    setAppInfo().name = "HERMES";
    // Configure App icon
    static auto icon  = assets::get_image("icon_hermes.bin");
    setAppInfo().icon = (void*)&icon;
    // Configure App theme color
    static uint32_t theme_color = 0x33CC99;
    setAppInfo().userData       = (void*)&theme_color;
}

// Called when the App is installed
void AppAiAgent::onCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");
}

// Called when the App is opened
// You can construct UI, initialize operations, etc. here
void AppAiAgent::onOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");
    ESP_LOGI(TAG, "AppAiAgent::onOpen entered");
    ESP_LOGI(TAG, "HERMES explicit open");

    std::string websocket_url = get_websocket_url();

    // HERMES handoff is display-sensitive on CoreS3/StackChan: SD and LCD share
    // SPI/GPIO35. SD config is always loaded during HAL boot before LCD init,
    // so keep SD access out of this path.
    const bool has_sd_config_error = GetHAL().hasSdConfigError();
    const WifiStatus wifi_status   = GetHAL().getWifiStatus();
    const bool has_wifi_config     = GetHAL().hasSavedWifiCredentials();

    const bool has_websocket_url        = !websocket_url.empty();
    const bool websocket_scheme_ready   = has_websocket_url && has_supported_websocket_scheme(websocket_url);
    const bool is_wifi_connected        = wifi_status != WifiStatus::None;
    const bool wifi_ready_for_runtime   = is_wifi_connected || has_wifi_config;
    const bool is_hermes_start_ready    = !has_sd_config_error && websocket_scheme_ready && wifi_ready_for_runtime;
    const std::string scheme            = websocket_scheme(websocket_url);
    const std::string sd_error_detail   = has_sd_config_error ? GetHAL().getLastSdConfigError() : std::string();

    ESP_LOGI(TAG, "SD config autoload result: error=%d", has_sd_config_error);
    ESP_LOGI(TAG, "websocket_url configured=%d, length=%u, scheme=%s, scheme_ready=%d", has_websocket_url,
             static_cast<unsigned>(websocket_url.length()), scheme.c_str(), websocket_scheme_ready);
    ESP_LOGI(TAG, "Wi-Fi status=%s, wifi_configured=%d", wifi_status_to_string(wifi_status), has_wifi_config);
    ESP_LOGI(TAG,
             "Hermes start readiness: sd_error=%d, websocket_url_configured=%d, websocket_scheme_ready=%d, "
             "wifi_status=%s, wifi_configured=%d",
             has_sd_config_error, has_websocket_url, websocket_scheme_ready, wifi_status_to_string(wifi_status),
             has_wifi_config);

    if (is_hermes_start_ready) {
        // Mooncake apps are stopped before the Hermes bridge runtime starts, so
        // avoid creating a temporary LVGL screen that would be torn down at once.
        ESP_LOGI(TAG, "Starting Hermes...");
        ESP_LOGI(TAG, "Hermes start requested by explicit HERMES app open");
        GetHAL().requestHermesStart();
        return;
    }

    if (!sd_error_detail.empty()) {
        ESP_LOGW(TAG, "SD config error detail: %s", sd_error_detail.c_str());
    }

    const std::string bubble_message = build_connectivity_error_message(
        has_sd_config_error, sd_error_detail, websocket_url, websocket_scheme_ready, wifi_ready_for_runtime);

    ESP_LOGW(TAG,
             "Hermes start deferred: sd_error=%d, websocket_url_configured=%d, websocket_scheme_ready=%d, "
             "wifi_status=%s, wifi_configured=%d, message=%s",
             has_sd_config_error, has_websocket_url, websocket_scheme_ready, wifi_status_to_string(wifi_status),
             has_wifi_config, bubble_message.c_str());

    showConnectivityErrorBubble(bubble_message);
}

void AppAiAgent::showConnectivityErrorBubble(const std::string& message)
{
    auto* display = Board::GetInstance().GetDisplay();
    if (display == nullptr) {
        ESP_LOGW(TAG, "Cannot show HERMES connectivity error: display is null; message=%s", message.c_str());
        return;
    }

    // Reuse the actual Hermes avatar surface even when the runtime cannot be
    // started yet. This keeps config / connection failures in the same speech
    // bubble that users see after Hermes starts.
    display->SetupUI();
    display->SetEmotion("sad");
    display->SetChatMessage("system", message.c_str());

    LvglLockGuard lock;
    view::create_home_indicator([this]() { close(); }, 0x81DBBD, 0x134233);
    if (GetStackChan().hasAvatar()) {
        GetStackChan().update();
    }
}

// Called repeatedly while the App is running
void AppAiAgent::onRunning()
{
    LvglLockGuard lock;
    view::update_home_indicator();
    if (GetStackChan().hasAvatar()) {
        GetStackChan().update();
    }
}

// Called when the App is closed
// You can destroy UI, release resources, etc. here
void AppAiAgent::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");
    LvglLockGuard lock;
    view::destroy_home_indicator();
    GetStackChan().resetAvatar();
    GetStackChan().clearModifiers();
}
