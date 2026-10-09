// Standalone regression against the production NoAudioProcessor implementation.
// Fixture headers intentionally replace SDK-dependent codec/model/log interfaces.
#include "no_audio_processor.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <future>
#include <iostream>
#include <mutex>
#include <thread>

namespace {
void expect(bool value, const char* message) {
    if (!value) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}

std::vector<int16_t> mono(int16_t first, size_t count) {
    std::vector<int16_t> data;
    for (size_t i = 0; i < count; ++i) {
        data.push_back(first + static_cast<int16_t>(i));
    }
    return data;
}

std::vector<int16_t> stereo(int16_t first, size_t count) {
    std::vector<int16_t> data;
    for (size_t i = 0; i < count; ++i) {
        data.push_back(first + static_cast<int16_t>(i));
        data.push_back(10000 + static_cast<int16_t>(i));
    }
    return data;
}

void testFramesAndFirstMic() {
    AudioCodec codec(2);
    NoAudioProcessor processor;
    std::vector<std::vector<int16_t>> output;
    processor.OnOutput([&](std::vector<int16_t>&& frame) { output.push_back(std::move(frame)); });
    expect(!processor.IsRunning(), "processor must initially be stopped");
    expect(processor.GetFeedSize() == 0, "uninitialized feed size must be zero");
    processor.Start();
    processor.Feed(stereo(0, 16));
    expect(output.empty(), "uninitialized feed must not produce output");
    processor.Initialize(&codec, 1, nullptr); // 16 samples/frame at 16kHz.
    expect(processor.GetFeedSize() == 16, "frame duration must retain the 16kHz contract");
    processor.Feed(stereo(0, 10));
    expect(output.empty(), "partial frame must be buffered");
    processor.Feed(stereo(10, 30));
    expect(output.size() == 2, "oversized stereo feed must emit complete frames only");
    expect(output[0] == mono(0, 16), "stereo frame must select first mic, not reference");
    expect(output[1] == mono(16, 16), "second frame must preserve sample order");
    processor.Feed(stereo(40, 8));
    expect(output.size() == 3 && output[2] == mono(32, 16), "remainder must form exact frame");

    processor.Feed(stereo(90, 8));
    processor.Stop();
    expect(!processor.IsRunning(), "Stop must publish stopped state");
    processor.Feed(stereo(100, 16));
    expect(output.size() == 3, "stopped feed must be ignored");
    processor.Start();
    processor.Feed(stereo(200, 16));
    expect(output.size() == 4 && output.back() == mono(200, 16), "Stop must discard partial old frame");
}

void testStatefulCallbackAndEmptyRegistration() {
    AudioCodec codec(1);
    NoAudioProcessor processor;
    processor.Initialize(&codec, 1, nullptr);
    std::vector<int> counts;
    processor.OnOutput([next = 0, &counts](std::vector<int16_t>&&) mutable {
        counts.push_back(++next);
    });
    processor.Start();
    processor.Feed(mono(0, 16));
    processor.Feed(mono(16, 16));
    expect(counts == std::vector<int>({1, 2}), "callback's private state must survive separate feeds");
    processor.OnOutput({});
    processor.Feed(mono(32, 16));
    expect(counts.size() == 2, "empty callback registration must disable output safely");
}

void testInvalidFrameDuration() {
    AudioCodec codec(1);
    for (int duration : {0, -1}) {
        NoAudioProcessor processor;
        int calls = 0;
        processor.OnOutput([&](std::vector<int16_t>&&) { ++calls; });
        processor.Initialize(&codec, duration, nullptr);
        expect(processor.GetFeedSize() == 0, "invalid frame duration must not become an unsigned size");
        processor.Start();
        processor.Feed(mono(0, 16));
        expect(calls == 0, "zero-sized frame must not loop or emit output");
        processor.Stop();
    }
}

void testMonoAndReentrantCallback() {
    AudioCodec codec(1);
    NoAudioProcessor processor;
    processor.Initialize(&codec, 1, nullptr);
    int calls = 0;
    processor.OnOutput([&](std::vector<int16_t>&& frame) {
        expect(frame == mono(0, 16), "mono frame contents must be unchanged");
        ++calls;
        // Callback must be outside the buffer lock, including registration setters.
        processor.Stop();
        expect(!processor.IsRunning(), "callback can observe Stop");
        processor.OnVadStateChange([](bool) {});
        processor.Start();
    });
    processor.Start();
    processor.Feed(mono(0, 48));
    expect(calls == 1, "Stop/Start within callback must invalidate old pending frames");
    processor.Feed(mono(0, 16));
    expect(calls == 2, "new run must continue producing frames");
}

void testBlockedCallbackDoesNotBlockStop() {
    AudioCodec codec(1);
    NoAudioProcessor processor;
    processor.Initialize(&codec, 1, nullptr);
    std::mutex gate;
    std::condition_variable cv;
    bool entered = false;
    bool release = false;
    std::atomic<int> calls{0};
    processor.OnOutput([&](std::vector<int16_t>&& frame) {
        expect(frame.size() == 16, "blocked callback must receive a complete frame");
        if (calls.fetch_add(1) == 0) {
            std::unique_lock<std::mutex> lock(gate);
            entered = true;
            cv.notify_all();
            cv.wait(lock, [&] { return release; });
        }
    });
    processor.Start();
    std::thread feeder([&] { processor.Feed(mono(0, 48)); });
    {
        std::unique_lock<std::mutex> lock(gate);
        expect(cv.wait_for(lock, std::chrono::seconds(2), [&] { return entered; }),
               "output callback must start");
    }
    std::promise<void> stopped;
    auto done = stopped.get_future();
    std::thread controller([&] {
        processor.Stop();
        expect(!processor.IsRunning(), "Stop must finish while callback is blocked");
        processor.Start();
        stopped.set_value();
    });
    expect(done.wait_for(std::chrono::seconds(2)) == std::future_status::ready,
           "Stop/Start must not wait for a blocked output callback");
    {
        std::lock_guard<std::mutex> lock(gate);
        release = true;
    }
    cv.notify_all();
    controller.join();
    feeder.join();
    expect(calls.load() == 1, "pending old frames must not enter the restarted run");
    processor.Feed(mono(0, 16));
    expect(calls.load() == 2, "restarted run must accept new audio");
}

void testConcurrentFeedAndLifecycle() {
    AudioCodec codec(2);
    NoAudioProcessor processor;
    processor.Initialize(&codec, 1, nullptr);
    std::atomic<size_t> calls{0};
    auto callback = [&](std::vector<int16_t>&& frame) {
        expect(frame.size() == 16, "concurrent feed must produce exact frames");
        for (auto sample : frame) {
            expect(sample == 7, "concurrent feed must preserve first-mic samples");
        }
        calls.fetch_add(1);
    };
    processor.OnOutput(callback);
    processor.Start();
    std::atomic<bool> go{false};
    auto feed = [&] {
        while (!go.load()) { std::this_thread::yield(); }
        for (int i = 0; i < 15000; ++i) {
            std::vector<int16_t> input(82);
            for (size_t j = 0; j < input.size(); j += 2) {
                input[j] = 7;
                input[j + 1] = 99;
            }
            processor.Feed(std::move(input));
        }
    };
    std::thread feeder1(feed);
    std::thread feeder2(feed);
    std::thread controller([&] {
        while (!go.load()) { std::this_thread::yield(); }
        for (int i = 0; i < 15000; ++i) {
            processor.Stop();
            expect(!processor.IsRunning(), "single controller must publish Stop");
            processor.Start();
        }
    });
    std::thread observer([&] {
        while (!go.load()) { std::this_thread::yield(); }
        for (int i = 0; i < 15000; ++i) {
            (void)processor.IsRunning();
            expect(processor.GetFeedSize() == 16, "concurrent feed size must remain stable");
            processor.OnOutput(callback);
            processor.OnVadStateChange([](bool) {});
        }
    });
    go.store(true);
    feeder1.join();
    feeder2.join();
    controller.join();
    observer.join();
    processor.Stop();
    const auto stopped_calls = calls.load();
    processor.Feed(stereo(0, 32));
    expect(calls.load() == stopped_calls, "final stopped feed must not emit callbacks");
    processor.Start();
    processor.Feed(std::vector<int16_t>(32, 7));
    expect(calls.load() == stopped_calls + 1, "concurrent stress must leave a usable empty buffer");
}
} // namespace

int main() {
    testFramesAndFirstMic();
    testStatefulCallbackAndEmptyRegistration();
    testInvalidFrameDuration();
    testMonoAndReentrantCallback();
    testBlockedCallbackDoesNotBlockStop();
    testConcurrentFeedAndLifecycle();
    std::cout << "NoAudioProcessor regression tests passed\n";
}
