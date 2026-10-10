/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <audio_codec.h>
#include <memory>
#include <atomic>
#include <utility>
#include <esp_system.h>
#include <mooncake_log.h>
#include <esp_log.h>
#include <nvs_flash.h>
#include <settings.h>
#include <driver/gpio.h>
#include "sdkconfig.h"

static std::unique_ptr<Hal> _hal_instance;
static const std::string_view _tag = "HAL";
static constexpr const char* _boot_logo_default_message         = "Starting up ...";
static constexpr const char* _boot_logo_launcher_return_message = "Returning to Launcher...";
static constexpr const char* _launcher_return_nvs_ns            = "launcher_ret";
static constexpr const char* _launcher_return_pending_key       = "pending";
static std::atomic_bool _launcher_return_reboot_requested{false};

static void prepareSharedSpiPinsBeforeBoardInit()
{
#if CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN || CONFIG_BOARD_TYPE_M5STACK_CORE_S3
    constexpr gpio_num_t lcd_cs = GPIO_NUM_3;
    constexpr gpio_num_t sd_cs  = GPIO_NUM_4;

    gpio_config_t io_conf = {};
    io_conf.pin_bit_mask = (1ULL << lcd_cs) | (1ULL << sd_cs);
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;

    ESP_ERROR_CHECK(gpio_config(&io_conf));
    ESP_ERROR_CHECK(gpio_set_level(lcd_cs, 1));
    ESP_ERROR_CHECK(gpio_set_level(sd_cs, 1));
#endif
}

Hal& GetHAL()
{
    if (!_hal_instance) {
        mclog::tagInfo(_tag, "creating hal instance");
        _hal_instance = std::make_unique<Hal>();
    }
    return *_hal_instance.get();
}

void Hal::init()
{
    mclog::tagInfo(_tag, "init");
    ESP_LOGI(_tag.data(), "boot_hal_enter; reset_reason=%d", static_cast<int>(esp_reset_reason()));

    prepareSharedSpiPinsBeforeBoardInit();

    // Initialize NVS
    esp_err_t ret = nvs_flash_init();
    if (ret != ESP_OK) {
        // Boot/recovery must not silently erase Wi-Fi and bridge configuration.
        // A deliberate factory reset remains a separate, explicit operation.
        ESP_LOGE(_tag.data(), "NVS init failed (%s); preserving stored settings", esp_err_to_name(ret));
    }
    ESP_ERROR_CHECK(ret);

    consumeLauncherReturnRebootMarker();
    handleBootSdConfigAutoload();

    hermes_board_init();
    ESP_LOGI(_tag.data(), "boot_board_ready");
    robot_mcp_init();
    head_touch_init();
    io_expander_init();
    rtc_init();
    imu_init();
    servo_init();
    lvgl_init();
    ESP_LOGI(_tag.data(), "boot_hal_ready");
}

/* -------------------------------------------------------------------------- */
/*                                   System                                   */
/* -------------------------------------------------------------------------- */
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <system_info.h>
#include <esp_ota_ops.h>
#include <esp_timer.h>
#include <esp_mac.h>

void Hal::delay(std::uint32_t ms)
{
    vTaskDelay(pdMS_TO_TICKS(ms));
}

std::uint32_t Hal::millis()
{
    return esp_timer_get_time() / 1000;
}

void Hal::feedTheDog()
{
    vTaskDelay(1);
}

std::array<uint8_t, 6> Hal::getFactoryMac()
{
    std::array<uint8_t, 6> mac;
    esp_efuse_mac_get_default(mac.data());
    return mac;
}

std::string Hal::getFactoryMacString(std::string divider)
{
    auto mac = getFactoryMac();
    return fmt::format("{:02X}{}{:02X}{}{:02X}{}{:02X}{}{:02X}{}{:02X}", mac[0], divider, mac[1], divider, mac[2],
                       divider, mac[3], divider, mac[4], divider, mac[5]);
}

void Hal::reboot()
{
    esp_restart();
}

void Hal::consumeLauncherReturnRebootMarker()
{
    Settings settings(_launcher_return_nvs_ns, true);
    _launcher_return_boot_marker = settings.GetInt(_launcher_return_pending_key, 0) == 1;
    if (_launcher_return_boot_marker) {
        mclog::tagInfo(_tag, "Launcher return boot marker consumed");
        settings.SetInt(_launcher_return_pending_key, 0);
    }
}

const char* Hal::getBootLogoMessage() const
{
    return _launcher_return_boot_marker ? _boot_logo_launcher_return_message : _boot_logo_default_message;
}

static void mark_launcher_return_reboot_marker()
{
    Settings settings(_launcher_return_nvs_ns, true);
    settings.SetInt(_launcher_return_pending_key, 1);
}

static void _confirm_ota_image_if_stable()
{
    constexpr uint32_t ota_confirm_delay_ms = 20000;
    static bool ota_confirm_checked         = false;
    if (ota_confirm_checked || GetHAL().millis() < ota_confirm_delay_ms) {
        return;
    }
    ota_confirm_checked = true;

    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running == nullptr) {
        mclog::tagError(_tag, "failed to get running partition for ota confirmation");
        return;
    }

    esp_ota_img_states_t ota_state;
    if (esp_ota_get_state_partition(running, &ota_state) != ESP_OK) {
        mclog::tagError(_tag, "failed to get ota state for partition: {}", running->label);
        return;
    }

    mclog::tagInfo(_tag, "ota confirm check: partition={}, state={}", running->label, static_cast<int>(ota_state));
    if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
        mclog::tagInfo(_tag, "ota image is stable, marking current app valid");
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

void Hal::updateHeapStatusLog()
{
    _confirm_ota_image_if_stable();

    static uint32_t last_log_tick = 0;
    if (millis() - last_log_tick < 10000) {
        return;
    }
    last_log_tick = millis();
    SystemInfo::PrintHeapStats();
}

/* -------------------------------------------------------------------------- */
/*                                Hermes Bridge                              */
/* -------------------------------------------------------------------------- */
#include "board/hal_bridge.h"
#include "board/stackchan_display.h"
#include <board.h>
#include <display.h>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include <assets/assets.h>
#include <esp_log.h>

void Hal::hermes_board_init()
{
    mclog::tagInfo(_tag, "hermes bridge board init");

    hal_bridge::hermes_board_init();
}

static void _stackchan_update_task(void* param)
{
    bool is_setup_done = false;
    bool sntp_started = false;
    std::atomic<bool> launcher_reboot_requested{false};

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(20));

        if (auto* codec = Board::GetInstance().GetAudioCodec()) codec->PollVolumeLease();
        tools::update_reminders();

        if (!hal_bridge::is_hermes_idle()) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }

        {
            LvglLockGuard lock(100);
            if (lock) {

            if (GetStackChan().hasAvatar()) {
                GetStackChan().update();
            }

            if (!is_setup_done) {
                // Home must exist even while network/audio initialization stalls.
                view::create_home_indicator([&launcher_reboot_requested]() { launcher_reboot_requested = true; },
                                            0x81DBBD, 0x134233);
                view::create_status_bar(0x81DBBD, 0x134233);
                is_setup_done = true;
            }

            view::update_home_indicator();
            view::update_status_bar();
            }
        }

        if (!sntp_started && hal_bridge::is_hermes_ready()) {
            GetHAL().startSntp();
            sntp_started = true;
        }

        if (launcher_reboot_requested.exchange(false)) {
            ESP_LOGI("HAL", "HERMES home indicator requested Launcher return reboot");
            GetHAL().requestLauncherReturnReboot();
        }
    }
}

void Hal::requestLauncherReturnReboot()
{
    if (_launcher_return_reboot_requested.exchange(true)) {
        ESP_LOGW(_tag.data(), "Launcher return reboot already requested; ignoring duplicate request");
        return;
    }

    ESP_LOGI(_tag.data(), "Launcher return requested; source_core=%d", xPortGetCoreID());

    auto prepare_return = [this]() {
        ESP_LOGI(_tag.data(), "Launcher return prepare; core=%d; stack_low_water_bytes=%u",
                 xPortGetCoreID(), static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
        mark_launcher_return_reboot_marker();
        // Persist markers only: never touch SD while the shared-SPI LCD is live.
        requestSkipNextBootSdConfigAutoload();
        ESP_LOGI(_tag.data(), "Launcher return markers committed");
    };

    // Commit the boot escape markers here, not behind a blocked app queue.
    prepare_return();
    const auto created = xTaskCreate([](void*) {
        vTaskDelay(pdMS_TO_TICKS(150));
        esp_restart();
    }, "launcher_escape", 3072, nullptr, 10, nullptr);
    if (created != pdPASS) esp_restart();
}

void Hal::startHermes()
{
    mclog::tagInfo(_tag, "start Hermes bridge");
    ESP_LOGI(_tag.data(), "Hal::startHermes entered");

    auto& board = Board::GetInstance();
    board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
    if (auto* backlight = board.GetBacklight()) {
        backlight->RestoreBrightness();
    }

    auto& motion = GetStackChan().motion();
    motion.setAutoAngleSyncEnabled(true);
    motion.setAutoTorqueReleaseEnabled(true);

    // Setup reminder handler
    tools::on_reminder_triggered().clear();
    tools::on_reminder_triggered().connect([](int id, std::string_view msg) {
        mclog::tagInfo(_tag, "reminder triggered: id: {}, msg: {}", id, msg);
        {
            LvglLockGuard lock;
            if (!lock) return;
            auto& avatar = GetStackChan().avatar();
            avatar.addDecorator(std::make_unique<view::ReminderView>(lv_screen_active(), msg));
        }
        hal_bridge::app_play_sound(OGG_NEW_NOTIFICATION);
    });

    // Start stackchan update task
    BaseType_t task_created = xTaskCreatePinnedToCore(_stackchan_update_task, "stackchan", 8192, NULL, 3, NULL, 1);
    ESP_ERROR_CHECK(task_created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);

    ESP_LOGI(_tag.data(), "Calling hal_bridge::start_hermes_app; this is expected not to return");
    hal_bridge::start_hermes_app();

    ESP_LOGE(_tag.data(), "hal_bridge::start_hermes_app returned unexpectedly");
}

HermesBridgeConfig_t Hal::getHermesBridgeConfig()
{
    auto bridge_config = hal_bridge::get_hermes_config();
    return HermesBridgeConfig_t{
        .idleShutdownTimeSeconds   = bridge_config.idleShutdownTimeSeconds,
        .allowShutdownWhenCharging = bridge_config.allowShutdownWhenCharging,
        .idleRandomMovementLevel   = bridge_config.idleRandomMovementLevel,
        .useHermesTts              = bridge_config.useHermesTts,
    };
}

void Hal::setHermesBridgeConfig(HermesBridgeConfig_t config)
{
    hal_bridge::set_hermes_config({
        .idleShutdownTimeSeconds   = config.idleShutdownTimeSeconds,
        .allowShutdownWhenCharging = config.allowShutdownWhenCharging,
        .idleRandomMovementLevel   = config.idleRandomMovementLevel,
        .useHermesTts              = config.useHermesTts,
    });
}

void Hal::prepareHermesDisplay()
{
    ESP_LOGI(_tag.data(), "Preparing Hermes display");
    auto* display = Board::GetInstance().GetDisplay();
    if (display == nullptr) {
        ESP_LOGW(_tag.data(), "No display available while preparing Hermes display");
        return;
    }

    auto* stackchan_display = static_cast<StackChanAvatarDisplay*>(display);
    lv_disp_t* lvgl_display = stackchan_display->GetLvglDisplay();
    ESP_LOGI(_tag.data(), "Preparing Hermes display: SetupUI start display=%p active=%p", lvgl_display,
             lvgl_display != nullptr ? lv_display_get_screen_active(lvgl_display) : nullptr);
    display->SetupUI();
    ESP_LOGI(_tag.data(), "Preparing Hermes display: SetupUI done display=%p active=%p", lvgl_display,
             lvgl_display != nullptr ? lv_display_get_screen_active(lvgl_display) : nullptr);
}

void Hal::resetHermesHandoffDisplayLocked()
{
    auto* display = Board::GetInstance().GetDisplay();
    if (display == nullptr) {
        ESP_LOGW(_tag.data(), "No display available while resetting Hermes handoff display");
        return;
    }

    auto* stackchan_display = static_cast<StackChanAvatarDisplay*>(display);
    stackchan_display->ResetForHermesHandoffLocked();
}

uint8_t Hal::getBatteryLevel()
{
    return hal_bridge::board_get_battery_level();
}

bool Hal::isBatteryCharging()
{
    return hal_bridge::board_is_battery_charging();
}

void Hal::factoryReset()
{
    mclog::tagInfo(_tag, "start factory reset");
    ESP_ERROR_CHECK(nvs_flash_erase());
    reboot();
}

/* -------------------------------------------------------------------------- */
/*                                   Display                                  */
/* -------------------------------------------------------------------------- */
#include "board/hal_bridge.h"

bool Hal::lvglLock(int timeout_ms)
{
    return hal_bridge::disply_lvgl_lock(timeout_ms);
}

void Hal::lvglUnlock()
{
    hal_bridge::disply_lvgl_unlock();
}

void Hal::setBackLightBrightness(uint8_t brightness, bool permanent)
{
    hal_bridge::board_set_backlight_brightness(brightness, permanent);
}

uint8_t Hal::getBackLightBrightness()
{
    return hal_bridge::board_get_backlight_brightness();
}

void Hal::setSpeakerVolume(uint8_t volume, bool permanent)
{
    hal_bridge::board_set_speaker_volume(volume, permanent);
}

uint8_t Hal::getSpeakerVolume()
{
    return hal_bridge::board_get_speaker_volume();
}

/* -------------------------------------------------------------------------- */
/*                                    Lvgl                                    */
/* -------------------------------------------------------------------------- */
#include "board/hal_bridge.h"
#include <stackchan/stackchan.h>

static void lvgl_read_cb(lv_indev_t* indev, lv_indev_data_t* data)
{
    hal_bridge::lock();
    auto& bridge_data = hal_bridge::get_data();

    // mclog::tagInfo(_tag, "touchpoint: {}, x: {}, y: {}", bridge_data.touchPoint.num, bridge_data.touchPoint.x,
    //                bridge_data.touchPoint.y);

    if (bridge_data.touchPoint.num == 0) {
        data->state = LV_INDEV_STATE_RELEASED;
    } else {
        data->state   = LV_INDEV_STATE_PRESSED;
        data->point.x = bridge_data.touchPoint.x;
        data->point.y = bridge_data.touchPoint.y;
    }

    hal_bridge::unlock();
}

void Hal::lvgl_init()
{
    mclog::tagInfo(_tag, "lvgl init");

    LvglLockGuard lock;
    if (!lock) return;

    mclog::tagInfo(_tag, "create lvgl touchpad indev");
    lvTouchpad = lv_indev_create();
    lv_indev_set_type(lvTouchpad, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(lvTouchpad, lvgl_read_cb);
    lv_indev_set_group(lvTouchpad, lv_group_get_default());
    lv_indev_set_display(lvTouchpad, hal_bridge::display_get_lvgl_display());
}

/* -------------------------------------------------------------------------- */
/*                                 Warm Reboot                                */
/* -------------------------------------------------------------------------- */
#include <string_view>

static std::string_view _warm_boot_nvs_ns  = "warm_boot";
static std::string_view _warm_boot_nvs_key = "app_index";

void Hal::requestWarmReboot(int appIndex)
{
    mclog::tagInfo(_tag, "warm reboot request to app index: {}", appIndex);

    {
        Settings settings(_warm_boot_nvs_ns.data(), true);
        settings.SetInt(_warm_boot_nvs_key.data(), appIndex);
    }

    delay(100);
    esp_restart();
}

int Hal::getWarmRebootTarget()
{
    Settings settings(_warm_boot_nvs_ns.data(), false);
    return settings.GetInt(_warm_boot_nvs_key.data(), -1);
}

void Hal::clearWarmRebootRequest()
{
    mclog::tagInfo(_tag, "clear warm reboot request");

    Settings settings(_warm_boot_nvs_ns.data(), true);
    settings.SetInt(_warm_boot_nvs_key.data(), -1);
}
