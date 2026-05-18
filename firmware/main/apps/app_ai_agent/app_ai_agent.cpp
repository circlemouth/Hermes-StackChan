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

using namespace mooncake;
using namespace smooth_ui_toolkit::lvgl_cpp;

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

    Settings ws_settings("websocket", false);
    std::string websocket_url = ws_settings.GetString("url_override", "");
    if (websocket_url.empty()) {
        websocket_url = ws_settings.GetString("url", "");
    }

    const char* status_text = "Connecting to Hermes bridge";
    if (websocket_url.empty()) {
        status_text = "Bridge URL missing";
    } else if (GetHAL().getWifiStatus() == WifiStatus::None) {
        status_text = "Wi-Fi not connected";
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
        _logo     = std::make_unique<Image>(lv_screen_active());
        _logo->setSrc(&_logo_img);
        _logo->align(LV_ALIGN_TOP_MID, 0, 35);

        _title = std::make_unique<Label>(lv_screen_active());
        _title->setTextFont(&lv_font_montserrat_20);
        _title->setTextColor(lv_color_hex(0x7E7B9C));
        _title->align(LV_ALIGN_TOP_MID, 0, 11);
        _title->setText("HERMES");

        _status = std::make_unique<Label>(lv_screen_active());
        _status->setTextFont(&lv_font_montserrat_20);
        _status->setTextColor(lv_color_hex(0x26206A));
        _status->align(LV_ALIGN_TOP_MID, 0, 105);
        _status->setTextAlign(LV_TEXT_ALIGN_CENTER);
        _status->setText(status_text);

        _device_id = std::make_unique<Label>(lv_screen_active());
        _device_id->setTextFont(&lv_font_montserrat_14);
        _device_id->setTextColor(lv_color_hex(0x525064));
        _device_id->align(LV_ALIGN_TOP_MID, 0, 145);
        _device_id->setText(fmt::format("Device ID: {}", GetHAL().getFactoryMacString()).c_str());
        _device_id->setTextAlign(LV_TEXT_ALIGN_CENTER);
    }

    // Request to start Hermes bridge service
    // Mooncake apps are stopped before the Hermes bridge runtime starts.
    GetHAL().requestHermesStart();
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
