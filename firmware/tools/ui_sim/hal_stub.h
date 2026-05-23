#pragma once

#include <cstdint>
#include <functional>
#include <thread>
#include <chrono>

enum class HeadPetGesture { None, Press, Release, SwipeForward, SwipeBackward };
enum class ImuMotionEvent { None = 0, Shake, PickUp };

template <typename... Args>
class StubSignal {
public:
    int connect(std::function<void(Args...)>)
    {
        return ++last_id_;
    }

    void disconnect(int)
    {
    }

    void emit(Args...)
    {
    }

private:
    int last_id_ = 0;
};

class Hal {
public:
    void delay(std::uint32_t ms);
    std::uint32_t millis();

    void lvglLock();
    void lvglUnlock();

    void setRgbColor(std::uint8_t index, std::uint8_t r, std::uint8_t g, std::uint8_t b);
    void refreshRgb();

    StubSignal<HeadPetGesture> onHeadPetGesture;
    StubSignal<ImuMotionEvent> onImuMotionEvent;
};

Hal& GetHAL();
