#pragma once
#include <cstdint>
void vTaskDelay(uint32_t ticks);
int esp_codec_dev_set_out_mute(void* handle, bool muted);
