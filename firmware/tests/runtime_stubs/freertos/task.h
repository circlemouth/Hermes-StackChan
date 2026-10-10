#pragma once
using TaskHandle_t = void*;
extern thread_local TaskHandle_t fake_task;
inline TaskHandle_t xTaskGetCurrentTaskHandle() { return fake_task; }
