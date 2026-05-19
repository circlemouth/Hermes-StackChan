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
#include <esp_log.h>
#include "sdkconfig.h"

using namespace mooncake;
using namespace smooth_ui_toolkit::lvgl_cpp;

static const char* TAG = "AppAiAgent";

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

static bool hermes_autostart_enabled()
{
#if CONFIG_HERMES_AUTOSTART
    return true;
#else
    return false;
#endif
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

static std::string load_websocket_url_from_sd_if_missing()
{
    std::string websocket_url = get_websocket_url();
    if (!websocket_url.empty()) {
        return websocket_url;
    }

    ESP_LOGI(TAG, "websocket URL missing, trying SD config import");
    {
        LvglLockGuard lock;
        auto result = GetHAL().loadConfigFromSdCard(nullptr);
        if (!result.success) {
            ESP_LOGW(TAG, "SD config import failed: %s", result.error.c_str());
        } else {
            ESP_LOGI(TAG, "SD config imported %u key(s)", static_cast<unsigned>(result.imported_keys.size()));
        }
    }

    return get_websocket_url();
}

AppAiAgent::AppAiAgent()
{
    // Configure App name
    setAppInfo().name = "HERMES";
    // Configure App icon
    static auto icon  = assets::get_image("icon_hermes.png");
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

    std::string websocket_url = load_websocket_url_from_sd_if_missing();

    const WifiStatus wifi_status      = GetHAL().getWifiStatus();
    const bool has_websocket_url      = !websocket_url.empty();
    const bool is_wifi_connected      = wifi_status != WifiStatus::None;
    const bool has_wifi_config        = GetHAL().isAppConfiged();
    const bool wifi_ready_for_runtime = is_wifi_connected || has_wifi_config;
    const bool is_hermes_start_ready  = has_websocket_url && wifi_ready_for_runtime;
    const bool is_hermes_autostart_enabled = hermes_autostart_enabled();
    const std::string scheme          = websocket_scheme(websocket_url);

    ESP_LOGI(TAG, "websocket_url configured=%d, length=%u, scheme=%s", has_websocket_url,
             static_cast<unsigned>(websocket_url.length()), scheme.c_str());
    ESP_LOGI(TAG, "Wi-Fi status=%s, wifi_configured=%d", wifi_status_to_string(wifi_status), has_wifi_config);

    if (is_hermes_autostart_enabled && is_hermes_start_ready) {
        // Mooncake apps are stopped before the Hermes bridge runtime starts, so
        // avoid creating a temporary LVGL screen that would be torn down at once.
        ESP_LOGI(TAG, "Hermes start requested");
        GetHAL().requestHermesStart();
        return;
    }

    const char* status_text = "Connecting to Hermes bridge";
    if (websocket_url.empty()) {
        status_text = "Bridge URL missing";
    } else if (!wifi_ready_for_runtime) {
        status_text = "Wi-Fi not connected";
    } else if (!is_hermes_autostart_enabled) {
        status_text = "Hermes autostart disabled";
    }

    {
        LvglLockGuard lock;

        _panel = std::make_unique<Container>(lv_screen_active());
        _panel->setBgColor(lv_color_hex(0xEDF4FF));
        _panel->align(LV_ALIGN_CENTER, 0, 0);
        _panel->setBorderWidth(0);
        _panel->setSize(320, 240);
        _panel->setRadius(0);

        _logo_img = assets::get_image("icon_hermes.png");
        _logo     = std::make_unique<Image>(_panel->get());
        _logo->setSrc(&_logo_img);
        lv_image_set_scale(_logo->get(), 160);
        _logo->align(LV_ALIGN_TOP_MID, 0, 32);

        _title = std::make_unique<Label>(_panel->get());
        _title->setTextFont(&lv_font_montserrat_20);
        _title->setTextColor(lv_color_hex(0x7E7B9C));
        _title->align(LV_ALIGN_TOP_MID, 0, 11);
        _title->setText("HERMES");

        _status = std::make_unique<Label>(_panel->get());
        _status->setTextFont(&lv_font_montserrat_16);
        _status->setTextColor(lv_color_hex(0x26206A));
        _status->setWidth(292);
        lv_label_set_long_mode(_status->get(), LV_LABEL_LONG_WRAP);
        _status->align(LV_ALIGN_TOP_MID, 0, 118);
        _status->setTextAlign(LV_TEXT_ALIGN_CENTER);
        _status->setText(status_text);

        _device_id = std::make_unique<Label>(_panel->get());
        _device_id->setTextFont(&lv_font_montserrat_14);
        _device_id->setTextColor(lv_color_hex(0x525064));
        _device_id->setWidth(292);
        lv_label_set_long_mode(_device_id->get(), LV_LABEL_LONG_WRAP);
        _device_id->align(LV_ALIGN_TOP_MID, 0, 156);
        _device_id->setText(fmt::format("Device ID: {}", GetHAL().getFactoryMacString()).c_str());
        _device_id->setTextAlign(LV_TEXT_ALIGN_CENTER);
    }

    if (!is_hermes_autostart_enabled) {
        ESP_LOGW(TAG, "Hermes start deferred: autostart disabled by CONFIG_HERMES_AUTOSTART");
        return;
    }

    if (!is_hermes_start_ready) {
        ESP_LOGW(TAG, "Hermes start deferred: websocket_url_configured=%d, wifi_status=%s, wifi_configured=%d",
                 has_websocket_url, wifi_status_to_string(wifi_status), has_wifi_config);
        return;
    }
}

// Called repeatedly while the App is running
void AppAiAgent::onRunning()
{
}

// Called when the App is closed
// You can destroy UI, release resources, etc. here
void AppAiAgent::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");
    LvglLockGuard lock;
    _device_id.reset();
    _status.reset();
    _title.reset();
    _logo.reset();
    _panel.reset();
}
