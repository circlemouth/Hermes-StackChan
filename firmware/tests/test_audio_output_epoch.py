"""Run extracted production audio-service methods with deterministic host barriers.

Codec/Opus/RTOS interfaces are fixtures; admission/reset/dequeue/output methods
are copied verbatim from production, not reimplemented as a test algorithm.
This cannot prove physical DMA/FIFO or microphone continuity.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

FIRMWARE = Path(__file__).resolve().parents[1]
SERVICE = (FIRMWARE / "xiaozhi-esp32/main/audio/audio_service.cc").read_text(encoding="utf-8")
HEADER = (FIRMWARE / "xiaozhi-esp32/main/audio/audio_service.h").read_text(encoding="utf-8")
COMPILER = sys.argv.pop(1) if len(sys.argv) > 1 else "c++"


def body(text, signature):
    start = text.index("{", text.index(signature))
    level = 1
    end = start + 1
    while level:
        level += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start + 1:end - 1]


def method(signature):
    return signature + " {" + body(SERVICE, signature) + "}\n"


FIXTURE = r'''
#include "runtime_safety.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#define CONFIG_USE_SERVER_AEC 1
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
constexpr int AS_EVENT_AUDIO_TESTING_RUNNING=1, AS_EVENT_WAKE_WORD_RUNNING=2, AS_EVENT_AUDIO_PROCESSOR_RUNNING=4;
constexpr int AUDIO_POWER_CHECK_INTERVAL_MS=1000, MAX_PLAYBACK_TASKS_IN_QUEUE=2, MAX_DECODE_PACKETS_IN_QUEUE=2;
constexpr int ESP_AUDIO_ERR_OK=0, ESP_AUDIO_DEC_RECOVERY_NONE=0;
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int,int) {}
void xEventGroupSetBits(int,int) {}
void xEventGroupClearBits(int,int) {}
std::atomic<int> decoder_resets{0}, decoder_calls{0};
void esp_opus_dec_reset(void*) { ++decoder_resets; }
struct esp_audio_dec_in_raw_t { uint8_t* buffer; uint32_t len,consumed; int frame_recover; };
struct esp_audio_dec_out_frame_t { uint8_t* buffer; uint32_t len,decoded_size; };
struct esp_audio_dec_info_t {};
int esp_opus_dec_decode(void*,esp_audio_dec_in_raw_t*,esp_audio_dec_out_frame_t* out,esp_audio_dec_info_t*) {
    ++decoder_calls; out->decoded_size=out->len; return ESP_AUDIO_ERR_OK;
}
using esp_ae_sample_t=void*;
void esp_ae_rate_cvt_get_max_out_sample_num(void*,size_t n,uint32_t* out) { *out=n; }
void esp_ae_rate_cvt_process(void*,esp_ae_sample_t,size_t n,esp_ae_sample_t,uint32_t* out) { *out=n; }
struct AudioStreamPacket { uint32_t timestamp=7; int sample_rate=24000,frame_duration=60; std::vector<uint8_t> payload{1,2}; };
enum AudioTaskType { kAudioTaskTypeDecodeToPlaybackQueue };
__STRUCTS__
struct Codec {
    std::atomic<uint32_t> epoch{1};
    std::atomic<bool> enabled{false};
    std::atomic<int> writes{0},enables{0},rejected{0};
    std::mutex mutex;
    std::function<void()> before_begin;
    std::function<void()> before_output;
    uint32_t BeginOutputEpoch() {
        if (before_begin) before_begin();
        std::lock_guard<std::mutex> lock(mutex); return ++epoch;
    }
    bool output_enabled() { return enabled; }
    int output_sample_rate() { return 24000; }
    int OutputDataAtEpoch(std::vector<int16_t>& pcm,uint32_t expected) {
        if (before_output) before_output();
        std::lock_guard<std::mutex> lock(mutex);
        if (expected!=epoch) { ++rejected; return 0; }
        if (!enabled.exchange(true)) ++enables;
        ++writes; return static_cast<int>(pcm.size());
    }
};
struct AudioService {
    Codec* codec_;
    std::mutex audio_queue_mutex_,playback_transition_mutex_,decoder_mutex_;
    std::atomic<unsigned> playback_generation_{0};
    uint32_t playback_output_epoch_=1;
    bool playback_transitioning_=false;
    std::atomic<bool> service_stopped_{false};
    bool decode_in_flight_=false,playback_in_flight_=false;
    std::condition_variable audio_queue_cv_;
    std::deque<PlaybackPacket> audio_decode_queue_;
    std::deque<std::unique_ptr<AudioStreamPacket>> audio_testing_queue_;
    std::deque<std::unique_ptr<AudioTask>> audio_playback_queue_,audio_encode_queue_;
    std::deque<uint32_t> timestamp_queue_;
    int audio_power_timer_=0,event_group_=0,configures=0;
    void* opus_decoder_=reinterpret_cast<void*>(1);
    void* output_resampler_=nullptr;
    int decoder_frame_size_=16,decoder_sample_rate_=24000;
    std::chrono::steady_clock::time_point last_output_time_;
    struct { unsigned playback_count=0,decode_count=0; } debug_statistics_;
    struct { std::function<void()> on_playback_progress; } callbacks_;
    explicit AudioService(Codec& codec):codec_(&codec) {}
    void SetDecodeSampleRateLocked(int,int) { ++configures; }
    void ResetDecoder(); void Stop(); void AudioOutputTask(); void EnableAudioTesting(bool);
    bool PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket>,bool=false,unsigned=~0u);
    void DecodeOne() {
        std::unique_lock<std::mutex> lock(audio_queue_mutex_);
        if (!audio_decode_queue_.empty() && audio_playback_queue_.size()<MAX_PLAYBACK_TASKS_IN_QUEUE) {
__DECODE__
        }
    }
};
__METHODS__
std::unique_ptr<AudioStreamPacket> Packet() { return std::make_unique<AudioStreamPacket>(); }
void AssertQueueUnlocked(AudioService& service) {
    // Probe from another thread: try_lock by an owning thread would be undefined.
    assert(std::async(std::launch::async,[&] {
        if (!service.audio_queue_mutex_.try_lock()) return false;
        service.audio_queue_mutex_.unlock(); return true;
    }).get());
}
void RunOneOutput(AudioService& service) {
    service.callbacks_.on_playback_progress=[&] { service.service_stopped_=true; service.audio_queue_cv_.notify_all(); };
    std::thread output([&] { service.AudioOutputTask(); }); output.join();
    service.callbacks_.on_playback_progress={};
}
int main() {
    { // A codec-only retirement must not rebind queued Opus to a fresh epoch.
        Codec codec; AudioService service(codec);
        assert(service.PushPacketToDecodeQueue(Packet(),false,0));
        assert(service.audio_decode_queue_.front().output_epoch==1);
        codec.BeginOutputEpoch();
        service.DecodeOne();
        assert(service.audio_playback_queue_.front()->output_epoch==1);
        RunOneOutput(service);
        assert(codec.writes==0 && codec.enables==0 && codec.rejected==1);
        assert(service.debug_statistics_.playback_count==0 && service.timestamp_queue_.empty());
        service.service_stopped_=false;
        codec.before_begin=[&] { AssertQueueUnlocked(service); };
        service.ResetDecoder();
        assert(service.playback_generation_==1 && service.playback_output_epoch_==3);
        assert(!service.PushPacketToDecodeQueue(Packet(),false,0));
        assert(service.PushPacketToDecodeQueue(Packet(),false,1));
        service.DecodeOne(); RunOneOutput(service);
        assert(codec.writes==1 && codec.enables==1);
        assert(service.debug_statistics_.playback_count==1 && service.timestamp_queue_.size()==1);
    }
    { // Old decode parked before its mutex cannot mutate a reset decoder/config.
        Codec codec; AudioService service(codec);
        assert(service.PushPacketToDecodeQueue(Packet(),false,0));
        std::unique_lock<std::mutex> decoder(service.decoder_mutex_);
        std::thread decode([&] { service.DecodeOne(); });
        {
            std::unique_lock<std::mutex> queue(service.audio_queue_mutex_);
            service.audio_queue_cv_.wait(queue,[&] { return service.decode_in_flight_; });
        }
        std::promise<void> begin_entered,release_begin;
        auto released=release_begin.get_future().share();
        codec.before_begin=[&] { AssertQueueUnlocked(service); begin_entered.set_value(); released.wait(); };
        auto reset=std::async(std::launch::async,[&] { service.ResetDecoder(); });
        begin_entered.get_future().wait();
        assert(service.playback_generation_==1);
        assert(!service.PushPacketToDecodeQueue(Packet(),false,1));
        const int calls=decoder_calls;
        decoder.unlock(); decode.join();
        assert(decoder_calls==calls && service.configures==0 && service.audio_playback_queue_.empty());
        release_begin.set_value(); reset.get();
        assert(!service.playback_transitioning_ && service.playback_output_epoch_==2);
        assert(service.PushPacketToDecodeQueue(Packet(),false,1));
        service.DecodeOne(); RunOneOutput(service); assert(codec.writes==1);
    }
    { // PCM already past its CPU generation check is fenced by Stop at the codec.
        Codec codec; AudioService service(codec);
        assert(service.PushPacketToDecodeQueue(Packet(),false,0)); service.DecodeOne();
        std::promise<void> output_entered,release_output;
        auto released=release_output.get_future().share();
        codec.before_output=[&] { output_entered.set_value(); released.wait(); };
        codec.before_begin=[&] { AssertQueueUnlocked(service); };
        std::thread output([&] { service.AudioOutputTask(); });
        output_entered.get_future().wait(); service.Stop(); release_output.set_value(); output.join();
        assert(codec.writes==0 && codec.enables==0 && codec.rejected==1);
        assert(service.playback_generation_==1 && service.playback_output_epoch_==2);
        assert(service.timestamp_queue_.empty() && !service.playback_in_flight_);
        assert(!service.PushPacketToDecodeQueue(Packet(),false,1));
    }
    { // A full-queue waiting producer is retired and wakes on Stop.
        Codec codec; AudioService service(codec);
        assert(service.PushPacketToDecodeQueue(Packet())); assert(service.PushPacketToDecodeQueue(Packet()));
        std::promise<void> entered;
        auto producer=std::async(std::launch::async,[&] { entered.set_value(); return service.PushPacketToDecodeQueue(Packet(),true,0); });
        entered.get_future().wait();
        assert(producer.wait_for(std::chrono::milliseconds(10))==std::future_status::timeout);
        service.Stop(); assert(!producer.get()); assert(service.audio_decode_queue_.empty());
    }
    { // Audio-test playback uses the same epoch snapshot, not the current codec.
        Codec codec; AudioService service(codec);
        codec.BeginOutputEpoch(); service.audio_testing_queue_.push_back(Packet());
        service.EnableAudioTesting(false);
        assert(service.audio_testing_queue_.empty());
        assert(service.audio_decode_queue_.front().playback_generation==0);
        assert(service.audio_decode_queue_.front().output_epoch==1);
        service.DecodeOne(); RunOneOutput(service); assert(codec.writes==0);
    }
    assert(decoder_resets>=4);
}
'''


class AudioOutputEpochTest(unittest.TestCase):
    def test_production_admission_decode_reset_and_output(self):
        signatures = (
            "void AudioService::ResetDecoder()",
            "void AudioService::Stop()",
            "void AudioService::AudioOutputTask()",
            "void AudioService::EnableAudioTesting(bool enable)",
            "bool AudioService::PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket> packet, bool wait, unsigned expected_generation)",
        )
        structs = "\n".join("struct " + name + " {" + body(HEADER, "struct " + name) + "};"
                            for name in ("AudioTask", "PlaybackPacket"))
        decode = body(SERVICE, "if (!audio_decode_queue_.empty() && audio_playback_queue_.size() < MAX_PLAYBACK_TASKS_IN_QUEUE)")
        fixture = FIXTURE.replace("__STRUCTS__", structs).replace("__DECODE__", decode)
        fixture = fixture.replace("__METHODS__", "\n".join(method(signature) for signature in signatures))
        with tempfile.TemporaryDirectory(prefix="stackchan-audio-epoch-test-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("stackchan-audio-epoch-test-"))
            source = root / "audio_epoch.cpp"
            binary = root / "audio_epoch"
            source.write_text(fixture, encoding="utf-8")
            subprocess.run([COMPILER, "-std=c++17", "-UNDEBUG", "-pthread", "-Wall", "-Wextra",
                            "-I", str(FIRMWARE / "xiaozhi-esp32/main"), str(source), "-o", str(binary)],
                           check=True, timeout=20)
            subprocess.run([str(binary)], check=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
