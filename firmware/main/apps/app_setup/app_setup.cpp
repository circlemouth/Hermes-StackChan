/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "app_setup.h"
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include <assets/assets.h>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include <settings.h>

using namespace mooncake;
using namespace view;
using namespace setup_workers;

AppSetup::AppSetup()
{
    // 配置 App 名
    setAppInfo().name = "SETUP";
    // 配置 App 图标
    static auto icon  = assets::get_image("icon_setup.bin");
    setAppInfo().icon = (void*)&icon;
    // 配置 App 主题颜色
    static uint32_t theme_color = 0xB3B3B3;
    setAppInfo().userData       = (void*)&theme_color;
}

void AppSetup::onCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");
    // open();
}

void AppSetup::onOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");

    // Reset state
    _destroy_menu    = false;
    _need_warm_reset = false;
    _magic_count     = 0;

    // ── ステータス表示用の値を収集 ──────────────────────────────
    // Volume
    std::string vol_label = fmt::format("Volume   {}%", (int)GetHAL().getSpeakerVolume());

    // AI model (NVS から取得)
    std::string model = GetHAL().getAiConfig().openaiModel;
    if (model.empty()) model = "(not set)";
    else if (model.length() > 12) model = model.substr(0, 10) + "..";
    std::string model_label = fmt::format("Model   {}", model);

    // WebSocket URL — ホスト部分のみ表示
    std::string ws_url = Settings("websocket", false).GetString("url", "");
    std::string server_disp;
    if (ws_url.empty()) {
        server_disp = "(not set)";
    } else {
        size_t s = ws_url.find("://");
        std::string host = (s != std::string::npos) ? ws_url.substr(s + 3) : ws_url;
        size_t e = host.find_first_of(":/");
        if (e != std::string::npos) host = host.substr(0, e);
        if (host.length() > 15) host = host.substr(0, 13) + "..";
        server_disp = host;
    }
    std::string server_label = fmt::format("Server  {}", server_disp);
    // ────────────────────────────────────────────────────────────

    _menu_sections = {
        {
            "Wi-Fi",
            {{"Change Wi-Fi",
              [&]() {
                  _destroy_menu    = true;
                  _need_warm_reset = true;
                  _worker          = std::make_unique<WifiSetupWorker>();
              }}},
        },
        {
            "Device",
            {{"Brightness",
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<BrightnessSetupWorker>();
              }},
             {vol_label,
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<VolumeSetupWorker>();
              }},
             {"Timezone",
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<TimezoneWorker>();
              }}},
        },
        {
            "AI.Agent",
            {{"Power Saving",
              [&]() {
                  _destroy_menu    = true;
                  _need_warm_reset = true;
                  _worker          = std::make_unique<XiaozhiPowerSavingWorker>();
              }},
             {"Load SD Config",
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<SdConfigWorker>();
              }},
             {model_label, nullptr},
             {server_label, nullptr}},
        },
        {
            "Hardware Test",
            {{"Servo",
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<ZeroCalibrationWorker>();
              }},
             {"RGB Strip",
              [&]() {
                  _destroy_menu = true;
                  _worker       = std::make_unique<RgbTestWorker>();
              }}},
        },
        {
            "Account",
            {{"Unbind & Reset",
              [&]() {
                  _destroy_menu    = true;
                  _need_warm_reset = true;
                  _worker          = std::make_unique<AccountWorker>();
              }}},
        },
        {
            "Firmware",
            {
                {fmt::format("Version:  {}", common::FirmwareVersion),
                 [&]() {
                     _magic_count++;
                     if (_magic_count >= 10) {
                         _magic_count  = 0;
                         _destroy_menu = true;
                         _worker       = std::make_unique<FwVersionWorker>();
                     }
                 }},
                {"Check for Updates",
                 [&]() {
                     _destroy_menu    = true;
                     _need_warm_reset = true;
                     _worker          = std::make_unique<SystemUpdateWorker>();
                 }},
                //  {"Factory Reset",
                //   [&]() {
                //       _destroy_menu = true;
                //       _worker       = std::make_unique<FactoryResetWorker>();
                //   }}
            },
        },
    };

    LvglLockGuard lock;

    _menu_page = std::make_unique<view::SelectMenuPage>(_menu_sections);

    view::create_home_indicator([&]() { close(); });
    view::create_status_bar();
}

void AppSetup::onRunning()
{
    LvglLockGuard lock;

    if (_menu_page) {
        _menu_page->update();
    }

    if (_destroy_menu) {
        _menu_page.reset();
        _destroy_menu = false;
    }

    if (_worker) {
        _worker->update();
        if (_worker->isDone()) {
            _worker.reset();
            _menu_page = std::make_unique<view::SelectMenuPage>(_menu_sections);
        }
    }

    GetStackChan().update();

    view::update_home_indicator();
    view::update_status_bar();
}

void AppSetup::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");

    LvglLockGuard lock;

    _menu_sections.clear();
    _menu_page.reset();
    _worker.reset();

    view::destroy_home_indicator();
    view::destroy_status_bar();

    if (_need_warm_reset) {
        GetHAL().requestWarmReboot(6);
    }
}
