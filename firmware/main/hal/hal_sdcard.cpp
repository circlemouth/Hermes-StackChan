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
#include <esp_vfs_fat.h>
#include <sdmmc_cmd.h>
#include <esp_rom_gpio.h>
#include <soc/spi_periph.h>

static constexpr const char* TAG = "HAL-SdConfig";

// CoreS3: SD card uses SPI3 (shared with display).
// GPIO35 is display DC (output) AND SD MISO (input) — same physical pin.
// Safe to share because we hold the LVGL lock during SD access,
// which stops all display SPI3 transactions.
static constexpr gpio_num_t SD_CS_PIN   = GPIO_NUM_4;
static constexpr gpio_num_t SD_MISO_PIN = GPIO_NUM_35;

static sdmmc_card_t* s_sd_card = nullptr;

static esp_err_t mount_sd_card()
{
    if (s_sd_card) return ESP_OK;

    // Reconfigure GPIO35 as input for SD MISO (temporarily overrides display DC output)
    gpio_config_t io_conf = {};
    io_conf.pin_bit_mask = (1ULL << SD_MISO_PIN);
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&io_conf);

    // Route GPIO35 to SPI3 MISO via GPIO matrix
    esp_rom_gpio_connect_in_signal(SD_MISO_PIN,
                                   spi_periph_signal[SPI3_HOST].spiq_in, false);

    // Add SD card as a new device on the already-initialized SPI3 bus
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI3_HOST;

    sdspi_device_config_t dev_cfg = SDSPI_DEVICE_CONFIG_DEFAULT();
    dev_cfg.gpio_cs  = SD_CS_PIN;
    dev_cfg.host_id  = SPI3_HOST;

    esp_vfs_fat_sdmmc_mount_config_t mount_cfg = {
        .format_if_mount_failed = false,
        .max_files = 4,
        .allocation_unit_size = 16 * 1024,
    };

    esp_err_t ret = esp_vfs_fat_sdspi_mount("/sdcard", &host, &dev_cfg, &mount_cfg, &s_sd_card);
    if (ret != ESP_OK) {
        // Restore GPIO35 as output for display DC on failure
        gpio_set_direction(SD_MISO_PIN, GPIO_MODE_OUTPUT);
    }
    return ret;
}

static void unmount_sd_card()
{
    if (!s_sd_card) return;
    esp_vfs_fat_sdcard_unmount("/sdcard", s_sd_card);
    s_sd_card = nullptr;
    // Restore GPIO35 as output for display DC
    gpio_set_direction(SD_MISO_PIN, GPIO_MODE_OUTPUT);
}

sd_config::LoadResult Hal::loadConfigFromSdCard(std::function<void(std::string_view)> onLog)
{
    mclog::tagInfo(TAG, "mounting SD card");

    esp_err_t err = mount_sd_card();
    if (err != ESP_OK) {
        mclog::tagError(TAG, "SD mount failed: %s", esp_err_to_name(err));
        sd_config::LoadResult fail;
        fail.error = std::string("Mount failed: ") + esp_err_to_name(err);
        if (onLog) onLog(fail.error);
        return fail;
    }

    mclog::tagInfo(TAG, "loading config from SD card");
    auto result = sd_config::load_and_apply(onLog);

    unmount_sd_card();
    return result;
}

AiConfig_t Hal::getAiConfig()
{
    Settings settings(sd_config::NVS_NAMESPACE, false);
    return AiConfig_t{
        .otaUrl        = settings.GetString("ota_url", ""),
        .openaiApiKey  = settings.GetString("openai_key", ""),
        .openaiBaseUrl = settings.GetString("openai_url", ""),
        .openaiModel   = settings.GetString("openai_model", ""),
    };
}
