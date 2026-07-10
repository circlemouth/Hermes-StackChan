/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/sd_config/sd_config.h"
#include <settings.h>
#include <mooncake_log.h>
#include <driver/sdspi_host.h>
#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <esp_vfs_fat.h>
#include <sdmmc_cmd.h>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_rom_gpio.h>
#include <soc/spi_periph.h>
#include "sdkconfig.h"

static constexpr const char* TAG = "HAL-SdConfig";

// CoreS3: SD card uses SPI3 (shared with display).
// GPIO35 is display DC (output) AND SD MISO (input) on the same physical pin.
// Callers hold the LVGL lock during SD access so display transactions are stopped.
static constexpr gpio_num_t SD_CS_PIN   = GPIO_NUM_4;
static constexpr gpio_num_t LCD_CS_PIN  = GPIO_NUM_3;
static constexpr gpio_num_t SD_MISO_PIN = GPIO_NUM_35;
static constexpr gpio_num_t SD_MOSI_PIN = GPIO_NUM_37;
static constexpr gpio_num_t SD_SCLK_PIN = GPIO_NUM_36;
static constexpr int SD_COMMAND_TIMEOUT_MS = 100;
static constexpr int SD_WAIT_FOR_MISO_MS   = -1;
static constexpr const char* SD_BOOT_IMPORT_NS = "sd_config";
static constexpr const char* SD_BOOT_IMPORT_PENDING_KEY = "boot_import";
static constexpr const char* SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY = "skip_next";

static sdmmc_card_t* s_sd_card = nullptr;
static bool s_boot_sd_bus_initialized = false;

static void prepare_shared_spi_for_sd()
{
    gpio_set_direction(LCD_CS_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(LCD_CS_PIN, 1);
    gpio_set_direction(SD_CS_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_CS_PIN, 1);

    gpio_config_t io_conf = {};
    io_conf.pin_bit_mask = (1ULL << SD_MISO_PIN);
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&io_conf);

    esp_rom_gpio_connect_in_signal(SD_MISO_PIN,
                                   spi_periph_signal[SPI3_HOST].spiq_in, false);
}

static void restore_shared_spi_for_display()
{
    // Best-effort restore only. This cannot guarantee the LCD panel IO, SPI bus,
    // and GPIO35/DC state are fully healthy after SD access. Do not use this as
    // justification for SD reads during Launcher startup, HERMES open, or display
    // handoff. Successful SD config import must still require a restart before
    // continuing into HERMES.
    ESP_LOGI(TAG, "restoring shared SPI pins for LCD");

    gpio_set_level(SD_CS_PIN, 1);
    gpio_set_level(LCD_CS_PIN, 1);

    gpio_reset_pin(SD_MISO_PIN);

    gpio_config_t io_conf = {};
    io_conf.pin_bit_mask = (1ULL << SD_MISO_PIN);
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pull_up_en = GPIO_PULLUP_DISABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;

    esp_err_t err = gpio_config(&io_conf);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to restore LCD DC GPIO config: %s", esp_err_to_name(err));
    }

    gpio_set_level(SD_MISO_PIN, 1);
    gpio_set_level(SD_CS_PIN, 1);
    gpio_set_level(LCD_CS_PIN, 1);

    ESP_LOGI(TAG, "shared SPI pins restored for LCD");
}

static esp_err_t init_shared_spi_for_boot_sd()
{
    if (s_boot_sd_bus_initialized) {
        return ESP_OK;
    }

    gpio_set_direction(LCD_CS_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(LCD_CS_PIN, 1);
    gpio_set_direction(SD_CS_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_CS_PIN, 1);

    spi_bus_config_t buscfg = {};
    buscfg.mosi_io_num = SD_MOSI_PIN;
    buscfg.miso_io_num = SD_MISO_PIN;
    buscfg.sclk_io_num = SD_SCLK_PIN;
    buscfg.quadwp_io_num = GPIO_NUM_NC;
    buscfg.quadhd_io_num = GPIO_NUM_NC;
    buscfg.max_transfer_sz = 4096;

    esp_err_t err = spi_bus_initialize(SPI3_HOST, &buscfg, SPI_DMA_CH_AUTO);
    if (err == ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "SPI3 already initialized before boot SD import");
        return err;
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to initialize SPI3 for boot SD import: %s", esp_err_to_name(err));
        return err;
    }

    s_boot_sd_bus_initialized = true;
    return ESP_OK;
}

static void deinit_boot_sd_bus()
{
    if (!s_boot_sd_bus_initialized) {
        return;
    }

    esp_err_t err = spi_bus_free(SPI3_HOST);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to free boot SD SPI bus: %s", esp_err_to_name(err));
    }
    s_boot_sd_bus_initialized = false;
}

static esp_err_t probe_sd_card_present(uint8_t* response_out)
{
    if (response_out) {
        *response_out = 0xff;
    }

    spi_device_interface_config_t probe_cfg = {};
    probe_cfg.clock_speed_hz = 400 * 1000;
    probe_cfg.mode = 0;
    probe_cfg.spics_io_num = GPIO_NUM_NC;
    probe_cfg.queue_size = 1;

    spi_device_handle_t probe_dev = nullptr;
    esp_err_t err = spi_bus_add_device(SPI3_HOST, &probe_cfg, &probe_dev);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD probe could not add temporary SPI device: %s", esp_err_to_name(err));
        return err;
    }

    auto cleanup = [&]() {
        gpio_set_level(SD_CS_PIN, 1);
        spi_bus_remove_device(probe_dev);
    };

    auto transfer_byte = [&](uint8_t tx, uint8_t* rx) -> esp_err_t {
        spi_transaction_t trans = {};
        trans.flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA;
        trans.length = 8;
        trans.tx_data[0] = tx;

        esp_err_t tx_err = spi_device_polling_transmit(probe_dev, &trans);
        if (tx_err == ESP_OK && rx) {
            *rx = trans.rx_data[0];
        }
        return tx_err;
    };

    gpio_set_level(SD_CS_PIN, 1);
    for (int i = 0; i < 10; ++i) {
        err = transfer_byte(0xff, nullptr);
        if (err != ESP_OK) {
            cleanup();
            return err;
        }
    }

    const uint8_t cmd0[] = {0x40, 0x00, 0x00, 0x00, 0x00, 0x95};
    gpio_set_level(SD_CS_PIN, 0);
    for (uint8_t b : cmd0) {
        err = transfer_byte(b, nullptr);
        if (err != ESP_OK) {
            cleanup();
            return err;
        }
    }

    uint8_t response = 0xff;
    for (int i = 0; i < 32; ++i) {
        err = transfer_byte(0xff, &response);
        if (err != ESP_OK) {
            cleanup();
            return err;
        }
        if (response != 0xff) {
            break;
        }
    }

    gpio_set_level(SD_CS_PIN, 1);
    transfer_byte(0xff, nullptr);
    spi_bus_remove_device(probe_dev);

    if (response_out) {
        *response_out = response;
    }

    return response == 0xff ? ESP_ERR_NOT_FOUND : ESP_OK;
}

static esp_err_t mount_sd_card()
{
    if (s_sd_card) return ESP_OK;

    prepare_shared_spi_for_sd();

    ESP_LOGI(TAG, "probing SD card before mount");
    uint8_t probe_response = 0xff;
    esp_err_t probe_ret = probe_sd_card_present(&probe_response);
    ESP_LOGI(TAG, "SD probe result: %s response=0x%02x",
             esp_err_to_name(probe_ret), probe_response);
    if (probe_ret != ESP_OK) {
        restore_shared_spi_for_display();
        return probe_ret;
    }

    // Add SD card as a new device on the already-initialized SPI3 bus
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI3_HOST;
    host.max_freq_khz = SDMMC_FREQ_PROBING;
    host.command_timeout_ms = SD_COMMAND_TIMEOUT_MS;

    sdspi_device_config_t dev_cfg = SDSPI_DEVICE_CONFIG_DEFAULT();
    dev_cfg.gpio_cs  = SD_CS_PIN;
    dev_cfg.host_id  = SPI3_HOST;
    dev_cfg.wait_for_miso = SD_WAIT_FOR_MISO_MS;

    esp_vfs_fat_sdmmc_mount_config_t mount_cfg = {
        .format_if_mount_failed = false,
        .max_files = 4,
        .allocation_unit_size = 16 * 1024,
    };

    ESP_LOGI(TAG, "mounting SD filesystem");
    esp_err_t ret = esp_vfs_fat_sdspi_mount("/sdcard", &host, &dev_cfg, &mount_cfg, &s_sd_card);
    if (ret != ESP_OK) {
        restore_shared_spi_for_display();
    }
    return ret;
}

static void unmount_sd_card()
{
    if (!s_sd_card) return;
    esp_vfs_fat_sdcard_unmount("/sdcard", s_sd_card);
    s_sd_card = nullptr;
    restore_shared_spi_for_display();
}

sd_config::LoadResult Hal::loadConfigFromSdCard(std::function<void(std::string_view)> onLog)
{
    // WARNING: CoreS3 / StackChan shares SPI3 and GPIO35 between LCD and SD.
    // Do not call this during Launcher startup, HERMES app open, display handoff,
    // or any active LCD UI flow. Setup > Load SD Config schedules boot-time
    // import so this runs before LCD initialization.
    // Calling this while LCD/LVGL is active can leave the physical LCD bus in a bad state
    // even if LVGL objects are created successfully.
    mclog::tagInfo(TAG, "mounting SD card");

    esp_err_t err = mount_sd_card();
    if (err != ESP_OK) {
        mclog::tagError(TAG, "SD mount failed: {}", esp_err_to_name(err));
        sd_config::LoadResult fail;
        if (err == ESP_ERR_NOT_FOUND) {
            fail.error = "SD card not detected";
        } else {
            fail.error = std::string("Mount failed: ") + esp_err_to_name(err);
        }
        if (onLog) onLog(fail.error);
        return fail;
    }

    mclog::tagInfo(TAG, "loading config from SD card");
    auto result = sd_config::load_and_apply(onLog);

    unmount_sd_card();
    return result;
}

static std::string join_imported_keys(const std::vector<std::string>& keys)
{
    std::string joined;
    for (const auto& key : keys) {
        if (!joined.empty()) {
            joined += ",";
        }
        joined += key;
        if (joined.size() > 900) {
            joined += ",...";
            break;
        }
    }
    return joined;
}

static bool is_missing_sd_or_config(const sd_config::LoadResult& result)
{
    if (result.config_file_found) {
        return false;
    }
    return result.error == "SD card not detected" ||
           result.error.find("Cannot open config.json") != std::string::npos;
}

static void persist_sd_config_boot_result(const sd_config::LoadResult& result)
{
    Settings settings(SD_BOOT_IMPORT_NS, true);
    settings.SetBool("last_success", result.success);
    settings.SetBool("last_found", result.config_file_found);
    settings.SetInt("last_count", static_cast<int>(result.imported_keys.size()));
    settings.SetString("last_keys", join_imported_keys(result.imported_keys));

    if (result.success) {
        settings.SetString("last_status", "applied");
        settings.SetString("last_error", "");
        return;
    }

    // SD未挿入、またはSDにconfig.jsonが無い場合はNVS fallbackを許可する。
    // HERMESアプリでブロックすべきエラーとしては扱わない。
    if (is_missing_sd_or_config(result)) {
        settings.SetString("last_status", result.error == "SD card not detected" ? "no_sd" : "no_config");
        settings.SetString("last_error", "");
        return;
    }

    settings.SetString("last_status", "error");
    settings.SetString("last_error", result.error);
}

static bool sd_config_access_requires_clean_reboot(const sd_config::LoadResult& result)
{
    // SD未挿入なら probe だけで終了しているので通常起動を継続する。
    // SDがmountされた、config.jsonを開いた、またはSD上のconfig探索まで進んだ場合は、
    // LCD/SPI3をクリーンな状態に戻すため一度だけ再起動する。
    return result.error != "SD card not detected";
}

void Hal::requestSdConfigBootImport()
{
    mclog::tagInfo(TAG, "requesting immediate SD config reload on next boot");
    Settings settings(SD_BOOT_IMPORT_NS, true);
    settings.SetInt(SD_BOOT_IMPORT_PENDING_KEY, 1);
    settings.SetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 0);
    delay(100);
    esp_restart();
}

void Hal::requestSkipNextBootSdConfigAutoload()
{
#if CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN || CONFIG_BOARD_TYPE_M5STACK_CORE_S3
    // HERMES home return is a UX/safety reboot, not a configuration import.
    // The next boot must avoid SD probing because CoreS3 / StackChan share
    // SPI3 and GPIO35 between LCD and SD. Keep this helper NVS-only; do not
    // touch SD or LCD pins here.
    mclog::tagInfo(TAG, "requesting skip of next boot-time SD config autoload");
    Settings settings(SD_BOOT_IMPORT_NS, true);
    settings.SetInt(SD_BOOT_IMPORT_PENDING_KEY, 0);
    settings.SetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 1);
#else
    mclog::tagInfo(TAG, "skip next boot-time SD config autoload request ignored on non shared-SPI board");
#endif
}

void Hal::handleBootSdConfigAutoload()
{
#if CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN || CONFIG_BOARD_TYPE_M5STACK_CORE_S3
    {
        // Setup > Load SD Config の手動要求がある場合だけ SD に触る。
        // 通常起動で pending/skip のどちらも無い場合は、共有SPI保護のため
        // probe すら行わず NVS の既存設定をそのまま使う。
        Settings settings(SD_BOOT_IMPORT_NS, true);
        if (settings.GetInt(SD_BOOT_IMPORT_PENDING_KEY, 0) == 1) {
            mclog::tagInfo(TAG, "manual SD config reload flag consumed");
            settings.SetInt(SD_BOOT_IMPORT_PENDING_KEY, 0);
            settings.SetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 0);
        } else if (settings.GetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 0) == 1) {
            // HERMES home return、またはSD/LCD保護のためのclean reboot直後。
            // このbootではSDを再度触らず通常起動へ進む。
            mclog::tagInfo(TAG, "skip SD config autoload once due to protected boot marker");
            settings.SetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 0);
            return;
        } else {
            mclog::tagInfo(TAG, "skip SD config autoload: no manual request");
            return;
        }
    }

    mclog::tagInfo(TAG, "boot-time SD config autoload start before LCD init");

    sd_config::LoadResult result;
    esp_err_t err = init_shared_spi_for_boot_sd();
    if (err == ESP_OK) {
        result = loadConfigFromSdCard(nullptr);
        deinit_boot_sd_bus();
    } else {
        result.error = std::string("SPI init failed: ") + esp_err_to_name(err);
    }

    persist_sd_config_boot_result(result);

    if (result.success) {
        mclog::tagInfo(TAG, "boot-time SD config autoload applied; imported_keys={}, warnings={}",
                       result.imported_keys.size(), result.warnings.size());
    } else if (is_missing_sd_or_config(result)) {
        mclog::tagInfo(TAG, "boot-time SD config autoload skipped; {}", result.error);
    } else {
        mclog::tagWarn(TAG, "boot-time SD config autoload failed; error={}", result.error);
    }

    if (!sd_config_access_requires_clean_reboot(result)) {
        return;
    }

    // The display has not been initialized yet, but SD used the same physical
    // pins. Reboot once more so normal startup owns SPI3 from a clean state.
    {
        Settings settings(SD_BOOT_IMPORT_NS, true);
        settings.SetInt(SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY, 1);
    }
    delay(250);
    esp_restart();
#else
    Settings settings(SD_BOOT_IMPORT_NS, true);
    settings.SetInt(SD_BOOT_IMPORT_PENDING_KEY, 0);
#endif
}
