#pragma once
#include <esp_err.h>
#include <cstdint>
#include <cstddef>
using i2c_master_bus_handle_t = void*;
using i2c_master_dev_handle_t = void*;
constexpr int I2C_ADDR_BIT_LEN_7=7;
struct i2c_device_config_t {
    int dev_addr_length; uint16_t device_address; uint32_t scl_speed_hz;
    uint32_t scl_wait_us; struct { unsigned disable_ack_check; } flags;
};
int i2c_master_bus_add_device(void*, const i2c_device_config_t*, void**);
int i2c_master_transmit(void*, const uint8_t*, size_t, int);
int i2c_master_transmit_receive(void*, const uint8_t*, size_t, uint8_t*, size_t, int);
