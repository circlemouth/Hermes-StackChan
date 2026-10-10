#pragma once
#include <cstdint>
using esp_codec_dev_handle_t = void*;
constexpr int ESP_CODEC_DEV_OK = 0;
#define ESP_CODEC_DEV_MAKE_CHANNEL_MASK(n) (1u << (n))
struct esp_codec_dev_sample_info_t {
    int bits_per_sample; int channel; uint32_t channel_mask;
    uint32_t sample_rate; int mclk_multiple;
};
int esp_codec_dev_open(void*, esp_codec_dev_sample_info_t*);
int esp_codec_dev_close(void*);
int esp_codec_dev_set_out_vol(void*, int);
int esp_codec_dev_set_in_channel_gain(void*, unsigned, float);
int esp_codec_dev_read(void*, void*, int);
int esp_codec_dev_write(void*, void*, int);
