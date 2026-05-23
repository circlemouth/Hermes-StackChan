#include "hal_stub.h"

namespace {
const auto kStartTime = std::chrono::steady_clock::now();
}

void Hal::delay(std::uint32_t ms)
{
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

std::uint32_t Hal::millis()
{
    auto elapsed = std::chrono::steady_clock::now() - kStartTime;
    return static_cast<std::uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
}

void Hal::lvglLock()
{
}

void Hal::lvglUnlock()
{
}

void Hal::setRgbColor(std::uint8_t, std::uint8_t, std::uint8_t, std::uint8_t)
{
}

void Hal::refreshRgb()
{
}

Hal& GetHAL()
{
    static Hal hal;
    return hal;
}
