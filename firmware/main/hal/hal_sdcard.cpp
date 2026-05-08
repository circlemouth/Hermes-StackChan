/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "utils/sd_config/sd_config.h"
#include <settings.h>
#include <mooncake_log.h>

static constexpr const char* TAG = "HAL-SdConfig";

bool Hal::loadConfigFromSdCard(std::function<void(std::string_view)> onLog)
{
    mclog::tagInfo(TAG, "loading config from SD card");
    auto result = sd_config::load_and_apply(onLog);
    return result.success;
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
