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
#include <esp_rom_gpio.h>
#include <soc/spi_periph.h>

static constexpr const char* TAG = "HAL-SdConfig";

// CoreS3: SD card uses SPI3 (shared with display).
// GPIO35 is display DC (output) AND SD MISO (input) on the same physical pin.
// Callers hold the LVGL lock during SD access so display transactions are stopped.
static constexpr gpio_num_t SD_CS_PIN   = GPIO_NUM_4;
static constexpr gpio_num_t LCD_CS_PIN  = GPIO_NUM_3;
static constexpr gpio_num_t SD_MISO_PIN = GPIO_NUM_35;
static constexpr int SD_COMMAND_TIMEOUT_MS = 100;
static constexpr int SD_WAIT_FOR_MISO_MS   = -1;

static sdmmc_card_t* s_sd_card = nullptr;

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
    // Do not call this during Launcher startup, HERMES app open, or display handoff.
    // Prefer explicit Setup > Load SD Config only, and require restart after success.
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
