#pragma once
// AW88298's checked hardware mute is necessary before reopening a closed
// esp_codec_dev handle: open() re-enables hardware before updating its volume.
#include <esp_codec_dev_defaults.h>
