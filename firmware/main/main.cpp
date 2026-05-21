/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include <smooth_ui_toolkit.hpp>
#include <uitk/short_namespace.hpp>
#include <mooncake_log.h>
#include <mooncake.h>
#include <apps/apps.h>
#include <apps/common/common.h>
#include <hal/hal.h>
#include <esp_log.h>
#include <lvgl.h>

using namespace mooncake;
using namespace smooth_ui_toolkit;

static const char* TAG = "MAIN";

static void clean_lvgl_for_hermes_handoff()
{
    GetHAL().bootLogo.reset();
    view::destroy_home_indicator();
    view::destroy_status_bar();

    lv_obj_t* top_layer = lv_layer_top();
    if (top_layer != nullptr) {
        lv_obj_clean(top_layer);
    }

    lv_obj_t* screen = lv_screen_active();
    if (screen != nullptr) {
        lv_obj_clean(screen);
        lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
        lv_obj_set_style_bg_color(screen, lv_color_black(), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_invalidate(screen);
    }

    lv_refr_now(nullptr);
    ESP_LOGI(TAG, "LVGL handoff screen cleaned");
}

extern "C" void app_main(void)
{
    // Setup logger
    mclog::set_level(mclog::level_info);
    mclog::set_time_format(mclog::time_format_unix_milliseconds);

    // HAL init
    GetHAL().init();

    // Setup ui hal
    ui_hal::on_delay([](uint32_t ms) { GetHAL().delay(ms); });
    ui_hal::on_get_tick([]() { return GetHAL().millis(); });

    // Install apps
    GetMooncake().installApp(std::make_unique<AppLauncher>());
    GetMooncake().installApp(std::make_unique<AppAiAgent>());
    GetMooncake().installApp(std::make_unique<AppAvatar>());
    GetMooncake().installApp(std::make_unique<AppEspnowControl>());
    GetMooncake().installApp(std::make_unique<AppDance>());
    GetMooncake().installApp(std::make_unique<AppSetup>());

    // Main loop
    while (1) {
        GetHAL().feedTheDog();
        GetHAL().updateHeapStatusLog();

        GetMooncake().update();

        if (GetHAL().isHermesStartRequested()) {
            break;
        }
    }

    // App destructors own LVGL objects, so tear Mooncake down while the LVGL
    // port is locked before handing the screen to Hermes.
    ESP_LOGI(TAG, "Mooncake teardown start");
    {
        LvglLockGuard lock;
        GetMooncake().uninstallAllApps();
        DestroyMooncake();
        clean_lvgl_for_hermes_handoff();
    }
    ESP_LOGI(TAG, "Mooncake teardown complete");

    GetHAL().prepareHermesDisplay();

    // Start Hermes bridge runtime, never returns
    GetHAL().startHermes();
}
