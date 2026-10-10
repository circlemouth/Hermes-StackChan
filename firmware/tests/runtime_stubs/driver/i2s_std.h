#pragma once
#include <cstdint>
#include <esp_err.h>
#include <codec_dma_fixture_wait.h>
using i2s_chan_handle_t = void*;
using gpio_num_t = int;
struct i2s_event_data_t {};
using i2s_isr_callback_t = bool (*)(i2s_chan_handle_t, i2s_event_data_t*, void*);
struct i2s_event_callbacks_t {
    i2s_isr_callback_t on_recv = nullptr;
    i2s_isr_callback_t on_recv_q_ovf = nullptr;
    i2s_isr_callback_t on_sent = nullptr;
    i2s_isr_callback_t on_send_q_ovf = nullptr;
};
int i2s_channel_register_event_callback(i2s_chan_handle_t, const i2s_event_callbacks_t*, void*);
