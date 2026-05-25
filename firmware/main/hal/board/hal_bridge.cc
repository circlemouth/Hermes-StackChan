/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal_bridge.h"
#include "stackchan_display.h"
#include <esp_log.h>
#include <esp_err.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <driver/gpio.h>
#include <esp_event.h>
#include <application.h>
#include <board.h>
#include <display.h>
#include <mutex>
#include <assets.h>
#include <settings.h>

static const char* _tag = "HAL_BRIDGE";

static constexpr std::string_view _hermes_config_nvs_ns                           = "hermes";
static constexpr std::string_view _hermes_config_idle_shutdown_time_key           = "idle_sec";
static constexpr std::string_view _hermes_config_allow_shutdown_when_charging_key = "ext_pwr";
static constexpr std::string_view _hermes_config_idle_random_movement_key         = "idle_lv";
static constexpr std::string_view _hermes_config_face_tracking_enabled_key        = "face_en";
static constexpr std::string_view _hermes_config_face_tracking_hz_key             = "face_hz";
static constexpr std::string_view _hermes_config_face_tracking_mode_key           = "face_mode";

static uint8_t clamp_u8(int value, int min_value, int max_value)
{
    if (value < min_value) {
        return static_cast<uint8_t>(min_value);
    }
    if (value > max_value) {
        return static_cast<uint8_t>(max_value);
    }
    return static_cast<uint8_t>(value);
}

namespace hal_bridge {

/* -------------------------------------------------------------------------- */
/*                            State and touch point                           */
/* -------------------------------------------------------------------------- */

static std::mutex _mutex;
static Data_t _data;

void lock()
{
    _mutex.lock();
}

void unlock()
{
    _mutex.unlock();
}

Data_t& get_data()
{
    return _data;
}

void set_touch_point(int num, int x, int y)
{
    std::lock_guard<std::mutex> lock(_mutex);
    _data.touchPoint.num = num;
    _data.touchPoint.x   = x;
    _data.touchPoint.y   = y;
}

TouchPoint_t get_touch_point()
{
    std::lock_guard<std::mutex> lock(_mutex);
    return _data.touchPoint;
}

bool is_hermes_mode()
{
    std::lock_guard<std::mutex> lock(_mutex);
    return _data.isHermesMode;
}

void set_hermes_mode(bool mode)
{
    std::lock_guard<std::mutex> lock(_mutex);
    _data.isHermesMode = mode;
}

/* -------------------------------------------------------------------------- */
/*                                   Display                                  */
/* -------------------------------------------------------------------------- */
#define DISPLAY_TYPE StackChanAvatarDisplay

static DISPLAY_TYPE* get_stackchan_display()
{
    auto* display = Board::GetInstance().GetDisplay();
    if (display == nullptr) {
        ESP_LOGW(_tag, "Board display is null");
        return nullptr;
    }
    return static_cast<DISPLAY_TYPE*>(display);
}

lv_disp_t* display_get_lvgl_display()
{
    auto* display = get_stackchan_display();
    if (display == nullptr) {
        return nullptr;
    }
    return display->GetLvglDisplay();
}

void disply_lvgl_lock()
{
    auto* display = get_stackchan_display();
    if (display == nullptr) {
        return;
    }
    display->LvglLock();
}

void disply_lvgl_unlock()
{
    auto* display = get_stackchan_display();
    if (display == nullptr) {
        return;
    }
    display->LvglUnlock();
}

/* -------------------------------------------------------------------------- */
/*                                 Application                                */
/* -------------------------------------------------------------------------- */

void hermes_board_init()
{
    // Init board
    (void)Board::GetInstance();
}

void start_hermes_app()
{
    ESP_LOGI(_tag, "hal_bridge::start_hermes_app entered");
    set_hermes_mode(true);

    // Initialize and run the application
    auto& app = Application::GetInstance();
    ESP_LOGI(_tag, "Application::Initialize start");
    app.Initialize();
    ESP_LOGI(_tag, "Application::Run start");
    app.Run();  // This function runs the main event loop and never returns
    ESP_LOGE(_tag, "Application::Run returned unexpectedly");
}

HermesRuntimeConfig_t get_hermes_config()
{
    HermesRuntimeConfig_t config;

    Settings settings(_hermes_config_nvs_ns.data(), false);
    config.idleShutdownTimeSeconds = settings.GetInt(_hermes_config_idle_shutdown_time_key.data(),
                                                     static_cast<int>(config.idleShutdownTimeSeconds));
    config.allowShutdownWhenCharging =
        settings.GetBool(_hermes_config_allow_shutdown_when_charging_key.data(), config.allowShutdownWhenCharging);
    config.idleRandomMovementLevel =
        settings.GetInt(_hermes_config_idle_random_movement_key.data(), config.idleRandomMovementLevel);
    config.faceTrackingEnabled =
        settings.GetBool(_hermes_config_face_tracking_enabled_key.data(), config.faceTrackingEnabled);
    config.faceTrackingHz =
        clamp_u8(settings.GetInt(_hermes_config_face_tracking_hz_key.data(), config.faceTrackingHz), 1, 10);
    config.faceTrackingMode =
        clamp_u8(settings.GetInt(_hermes_config_face_tracking_mode_key.data(), config.faceTrackingMode), 0, 3);

    return config;
}

void set_hermes_config(const HermesRuntimeConfig_t& config)
{
    Settings settings(_hermes_config_nvs_ns.data(), true);
    settings.SetInt(_hermes_config_idle_shutdown_time_key.data(), config.idleShutdownTimeSeconds);
    settings.SetBool(_hermes_config_allow_shutdown_when_charging_key.data(), config.allowShutdownWhenCharging);
    settings.SetInt(_hermes_config_idle_random_movement_key.data(), config.idleRandomMovementLevel);
    settings.SetBool(_hermes_config_face_tracking_enabled_key.data(), config.faceTrackingEnabled);
    settings.SetInt(_hermes_config_face_tracking_hz_key.data(), config.faceTrackingHz);
    settings.SetInt(_hermes_config_face_tracking_mode_key.data(), config.faceTrackingMode);
}

void app_play_sound(const std::string_view& sound)
{
    auto& app = Application::GetInstance();
    app.PlaySound(sound);
}

}  // namespace hal_bridge
