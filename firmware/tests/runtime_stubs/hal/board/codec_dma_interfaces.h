#pragma once
// Only interfaces consumed by the real Core runtime; constructor is substituted.
struct audio_codec_data_if_t {};
struct audio_codec_ctrl_if_t {};
struct audio_codec_if_t { int (*mute)(const audio_codec_if_t*, bool); };
struct audio_codec_gpio_if_t {};
