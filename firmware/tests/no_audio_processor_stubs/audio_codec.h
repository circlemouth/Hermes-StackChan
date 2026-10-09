#pragma once

#include <cstdint>

// Host-only codec shape: the processor only reads its input channel count.
class AudioCodec {
public:
    explicit AudioCodec(int channels) : channels_(channels) {}
    int input_channels() const { return channels_; }
private:
    const int channels_;
};
