#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>
#include "audio_codec.h"

struct srmodel_list_t;

// Host-only interface fixture; no ESP-IDF, FreeRTOS or model partition access.
class AudioProcessor {
public:
    virtual ~AudioProcessor() = default;
    virtual void Initialize(AudioCodec*, int, srmodel_list_t*) = 0;
    virtual void Feed(std::vector<int16_t>&&) = 0;
    virtual void Start() = 0;
    virtual void Stop() = 0;
    virtual bool IsRunning() = 0;
    virtual void OnOutput(std::function<void(std::vector<int16_t>&&)>) = 0;
    virtual void OnVadStateChange(std::function<void(bool)>) = 0;
    virtual size_t GetFeedSize() = 0;
    virtual void EnableDeviceAec(bool) = 0;
};
