#pragma once
#include <cassert>
using esp_err_t = int;
constexpr int ESP_OK=0, ESP_FAIL=-1;
inline const char* esp_err_to_name(int) { return "fake fault"; }
#define ESP_ERROR_CHECK(v) assert((v) == ESP_OK)
