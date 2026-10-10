#include "cores3_audio_codec.h"
#include "settings.h"
#include <esp_heap_caps.h>
#include <algorithm>
#include <cassert>
#include <atomic>
#include <chrono>
#include <future>
#include <thread>
#include <iostream>

int64_t fake_now_us = 1000000;
bool fail_eof_allocation = false;
int registration_error = 0;
int open_error = 0, volume_error = 0, mute_error = 0, gain_error = 0, read_error = 0, write_error = 0, close_error = 0;
int closes = 0, opens = 0, writes = 0, actual_volume = 70, cached_volume = 0;
bool hardware_muted = false, cached_muted = false, output_open = false, fail_unmute = false;
uint32_t sent_eofs = 0, guarded_start_eof = 0;
bool guard_drain = false, auto_eof = true;
int delay_calls = 0, eof_period_ticks = 10;
std::function<void()> delay_hook;
i2s_isr_callback_t sent_callback = nullptr;
void* sent_context = nullptr;
i2s_chan_handle_t sent_channel = nullptr;

int hardware_mute(const audio_codec_if_t*, bool muted) {
    if (mute_error) return mute_error;
    if (!muted && fail_unmute) return -1;
    if (!muted && guard_drain) assert(uint32_t(sent_eofs - guarded_start_eof) >= 7 || actual_volume == 0);
    hardware_muted = muted;
    return 0;
}
const audio_codec_if_t fake_output_if{hardware_mute};

// Only hardware construction is substituted: all codec runtime methods and the
// actual ISR callback, registration, epoch and drain logic are production code.
CoreS3AudioCodec::CoreS3AudioCodec(void*, int input, int output, gpio_num_t, gpio_num_t, gpio_num_t, gpio_num_t, gpio_num_t, uint8_t, uint8_t, bool reference) {
    input_sample_rate_ = input; output_sample_rate_ = output; input_reference_ = reference;
    input_dev_ = reinterpret_cast<void*>(1); output_dev_ = reinterpret_cast<void*>(2);
    out_codec_if_ = &fake_output_if;
    tx_handle_ = this;
    RegisterTxCompletionTracking();
}
CoreS3AudioCodec::~CoreS3AudioCodec() {
    if (sent_context == tx_eof_count_) { sent_callback = nullptr; sent_context = nullptr; }
    heap_caps_free(tx_eof_count_);
}
int i2s_channel_register_event_callback(i2s_chan_handle_t channel, const i2s_event_callbacks_t* callbacks, void* context) {
    if (registration_error) return registration_error;
    assert(callbacks->on_sent && context);
    sent_callback = callbacks->on_sent; sent_context = context; sent_channel = channel;
    return 0;
}
void emit_eofs(unsigned count = 1) {
    while (count--) {
        ++sent_eofs;
        assert(sent_callback && sent_context);
        assert(!sent_callback(sent_channel, nullptr, sent_context));
    }
}
void vTaskDelay(uint32_t ticks) {
    fake_now_us += int64_t(ticks) * 1000;
    ++delay_calls;
    if (auto_eof && delay_calls % eof_period_ticks == 0) emit_eofs();
    if (delay_hook) delay_hook();
}
int esp_codec_dev_open(void* dev, esp_codec_dev_sample_info_t*) {
    ++opens;
    if (open_error) return open_error;
    if (dev == reinterpret_cast<void*>(2)) {
        output_open = true;
        // The real wrapper restores its previously cached volume AND mute.
        // Catch audible stale DMA during a supposedly muted reopen.
        const int ret = hardware_mute(nullptr, cached_muted);
        if (ret) { output_open = false; return ret; }
        actual_volume = cached_volume;
        if (guard_drain && uint32_t(sent_eofs - guarded_start_eof) < 7) assert(hardware_muted || actual_volume == 0);
    }
    return 0;
}
int esp_codec_dev_close(void* dev) {
    ++closes;
    if (!close_error && dev == reinterpret_cast<void*>(2)) output_open = false;
    return close_error;
}
int esp_codec_dev_set_out_vol(void*, int volume) {
    if (!volume_error) {
        if (guard_drain && volume > 0) assert(uint32_t(sent_eofs - guarded_start_eof) >= 7);
        actual_volume = cached_volume = volume;
    }
    return volume_error;
}
int esp_codec_dev_set_out_mute(void*, bool muted) {
    // The AW interface remains ready even with wrapper output disabled. The
    // managed control patch propagates errors and only caches successful mute.
    const int ret = hardware_mute(nullptr, muted);
    if (!ret) cached_muted = muted;
    return ret;
}
int esp_codec_dev_set_in_channel_gain(void*, unsigned, float) { return gain_error; }
int esp_codec_dev_read(void*, void* dest, int bytes) { std::fill_n(static_cast<int16_t*>(dest), bytes / 2, 123); return read_error; }
std::atomic<bool> block_write{false};
std::promise<void> write_entered, release_write;
auto release_future = release_write.get_future().share();
int esp_codec_dev_write(void*, void*, int) {
    ++writes;
    if (block_write.exchange(false)) { write_entered.set_value(); release_future.wait(); }
    return write_error;
}

struct PartialCodec : AudioCodec {
    int read_count = 0, write_count = 0;
    int Read(int16_t* dest, int samples) override { std::fill_n(dest, samples, 99); return read_count; }
    int Write(const int16_t*, int) override { return write_count; }
};
void arm_drain() {
    guarded_start_eof = sent_eofs; guard_drain = true;
    delay_calls = 0; eof_period_ticks = 10; auto_eof = true;
}
void disarm_drain() { guard_drain = false; delay_hook = {}; }

int main() {
    PartialCodec partial;
    std::vector<int16_t> pcm(16, 99);
    for (int count : {-1, 0, 8}) { partial.read_count = count; assert(!partial.InputData(pcm)); assert(std::all_of(pcm.begin(), pcm.end(), [](auto v) { return !v; })); }
    partial.read_count = 16; assert(partial.InputData(pcm));
    partial.write_count = 8; assert(partial.OutputData(pcm) == 8);
    partial.write_count = 0; assert(partial.OutputData(pcm) == 0);
    assert(partial.BeginOutputEpoch() == 0 && partial.OutputEpoch() == 0);
    partial.write_count = 16;
    assert(partial.OutputDataAtEpoch(pcm, 1) == 0 && !partial.output_enabled());
    assert(partial.OutputDataAtEpoch(pcm, 0) == 16 && partial.output_enabled());

    {
        // A lease can be acquired before output ever opens. Its wrapper cache
        // may still contain audible volume and mute=false; direct HMUTE alone
        // must not be undone by open before seven physical completions.
        cached_volume = actual_volume = 70;
        cached_muted = hardware_muted = output_open = false;
        CoreS3AudioCodec unopened(nullptr, 16000, 24000, 0, 0, 0, 0, 0, 0, 0, false);
        unopened.Start();
        assert(unopened.SetVolumeLease(0, false, "before-open", 1000));
        arm_drain();
        assert(unopened.SetVolumeLease(0, false, "before-open", 0));
        assert(sent_eofs - guarded_start_eof == 7 && hardware_muted && cached_muted && !output_open);
        assert(unopened.output_volume() == 70 && !unopened.output_enabled());
        disarm_drain();
    }

    CoreS3AudioCodec codec(nullptr, 16000, 24000, 0, 0, 0, 0, 0, 0, 0, false);
    Settings::persisted_volume = 0; codec.Start(); assert(codec.output_volume() == 0);
    Settings::persisted_volume = -1; codec.Start(); assert(codec.output_volume() == 70);
    Settings::persisted_volume = 110; codec.Start(); assert(codec.output_volume() == 70);
    open_error = -1; codec.EnableInput(true); assert(!codec.input_enabled());
    open_error = 0; gain_error = -1; codec.EnableInput(true); assert(!codec.input_enabled());
    gain_error = 0; codec.EnableInput(true); assert(codec.input_enabled());
    read_error = -1; assert(!codec.InputData(pcm)); assert(!codec.input_enabled()); assert(std::all_of(pcm.begin(), pcm.end(), [](auto v) { return !v; }));
    read_error = 0; codec.EnableInput(true); assert(codec.InputData(pcm)); codec.EnableInput(false);
    volume_error = -1; codec.EnableOutput(true); assert(!codec.output_enabled());
    volume_error = 0; codec.EnableOutput(true); assert(codec.output_enabled());
    write_error = -1; assert(codec.OutputData(pcm) == 0); assert(!codec.output_enabled() && hardware_muted && cached_muted);
    write_error = 0; codec.EnableOutput(true); assert(codec.OutputData(pcm) == 16);
    volume_error = -1; codec.SetOutputVolume(12); assert(codec.output_volume() == 70);
    volume_error = 0; codec.SetOutputVolume(60); assert(codec.output_volume() == 60);
    const int persistent_writes = Settings::writes;
    auto admitted = codec.BeginOutputEpoch();
    assert(!codec.SetVolumeLease(20, false, "", 100));
    assert(!codec.SetVolumeLease(20, false, std::string(97, 'a'), 100));
    assert(!codec.SetVolumeLease(20, false, "owner", 120001));
    assert(codec.SetVolumeLease(20, false, "owner", 100));
    assert(codec.output_volume() == 20 && codec.GetVolumeLease().saved_volume == 60);
    assert(!codec.SetVolumeLease(30, false, "different", 100));
    assert(!codec.SetVolumeLease(99, false, "different", 0));
    assert(codec.SetVolumeLease(25, false, "owner", 100));
    assert(codec.GetVolumeLease().saved_volume == 60 && codec.OutputEpoch() == admitted);

    // Explicit restore waits for delayed EOFs, not a successful write or sleep.
    arm_drain();
    delay_hook = [&] {
        assert(codec.GetVolumeLease().owner == "owner" && codec.output_volume() == 0 && hardware_muted);
        const int before = writes;
        assert(codec.OutputDataAtEpoch(pcm, admitted) == 0 && writes == before);
    };
    const int64_t restore_started = fake_now_us;
    assert(codec.SetVolumeLease(0, false, "owner", 0));
    assert(fake_now_us - restore_started == 70000 && sent_eofs - guarded_start_eof == 7);
    disarm_drain();
    assert(codec.output_volume() == 60 && actual_volume == 60 && !hardware_muted && !codec.GetVolumeLease().active());
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0);
    assert(!codec.SetVolumeLease(0, false, "owner", 0));
    assert(!codec.SetVolumeLease(20, false, "owner", 100)); // retired renewal cannot reacquire
    assert(Settings::writes == persistent_writes);

    // Expiry runs in nonwaiting stages. Six completions are NOT enough.
    assert(codec.SetVolumeLease(0, false, "expiry", 100));
    admitted = codec.BeginOutputEpoch(); fake_now_us += 100000;
    arm_drain(); auto_eof = false;
    const int64_t poll_started = fake_now_us;
    codec.PollVolumeLease();
    assert(fake_now_us == poll_started && delay_calls == 0);
    const auto draining_epoch = codec.BeginOutputEpoch();
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0);
    assert(codec.OutputDataAtEpoch(pcm, draining_epoch) == 0);
    emit_eofs(6); codec.PollVolumeLease(); assert(codec.GetVolumeLease().active() && codec.output_volume() == 0 && hardware_muted);
    emit_eofs(); codec.PollVolumeLease(); disarm_drain();
    assert(!codec.GetVolumeLease().active() && codec.output_volume() == 60);
    assert(codec.OutputDataAtEpoch(pcm, draining_epoch) == 0); // stays retired after ACK
    assert(!codec.SetVolumeLease(20, false, "expiry", 100));
    auto fresh = codec.BeginOutputEpoch(); assert(codec.OutputDataAtEpoch(pcm, fresh) == 16);

    // A stalled explicit drain is bounded; keep owner/saved volume/mute. Poll
    // retries use backoff and never repeat a 500 ms wait on the UI task.
    assert(codec.SetVolumeLease(0, false, "stall", 1000));
    admitted = codec.BeginOutputEpoch(); arm_drain(); auto_eof = false;
    const auto stalled_start = fake_now_us;
    assert(!codec.SetVolumeLease(0, false, "stall", 0));
    assert(fake_now_us - stalled_start == 500000 && delay_calls == 500);
    assert(codec.GetVolumeLease().owner == "stall" && codec.GetVolumeLease().saved_volume == 60);
    assert(codec.output_volume() == 0 && actual_volume == 0 && hardware_muted);
    const int delays_before = delay_calls, opens_before = opens, writes_before = writes;
    for (int i = 0; i < 20; ++i) { fake_now_us += 20000; codec.PollVolumeLease(); }
    assert(delay_calls == delays_before && opens == opens_before && writes == writes_before);
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0);
    fake_now_us += 600000; codec.PollVolumeLease(); // start a new bounded attempt
    const uint32_t retry_start = sent_eofs;
    emit_eofs(6); codec.PollVolumeLease(); assert(codec.GetVolumeLease().active());
    emit_eofs(); codec.PollVolumeLease(); disarm_drain();
    assert(sent_eofs - retry_start == 7 && codec.output_volume() == 60 && !codec.GetVolumeLease().active());

    // Late EOFs cannot retroactively satisfy an expired attempt. A retry
    // requires seven NEW completions, including across uint32 counter wrap.
    assert(codec.SetVolumeLease(0, false, "late-eof", 1000)); arm_drain(); auto_eof = false;
    codec.RequestVolumeLeaseRelease(); codec.PollVolumeLease();
    fake_now_us += 500000; emit_eofs(7); codec.PollVolumeLease();
    assert(codec.GetVolumeLease().active() && hardware_muted);
    fake_now_us += 1000000;
    static_cast<std::atomic<uint32_t>*>(sent_context)->store(UINT32_MAX - 3);
    sent_eofs = UINT32_MAX - 3; guarded_start_eof = sent_eofs;
    codec.PollVolumeLease(); emit_eofs(6); codec.PollVolumeLease(); assert(codec.GetVolumeLease().active());
    emit_eofs(); codec.PollVolumeLease(); disarm_drain();
    assert(!codec.GetVolumeLease().active() && codec.output_volume() == 60);

    // Permanent override fences an active lease, but plain user volume changes
    // leave the normal TTS epoch and PCM admission intact.
    assert(codec.SetVolumeLease(0, false, "permanent", 1000)); admitted = codec.BeginOutputEpoch(); arm_drain();
    assert(codec.SetVolumeLease(41, true, "", 0)); disarm_drain();
    assert(codec.output_volume() == 41 && Settings::persisted_volume == 41);
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0);
    assert(!codec.SetVolumeLease(0, false, "permanent", 0));
    assert(!codec.SetVolumeLease(0, false, "permanent", 100));
    fresh = codec.BeginOutputEpoch(); codec.SetOutputVolume(55);
    assert(codec.OutputEpoch() == fresh && codec.OutputDataAtEpoch(pcm, fresh) == 16);

    // Failed permanent drain remains pending/muted/owned; Poll can complete it
    // once real EOFs resume, never restore the saved volume over the user value.
    assert(codec.SetVolumeLease(0, false, "pending-user", 1000)); arm_drain(); auto_eof = false;
    assert(!codec.SetVolumeLease(44, true, "", 0)); assert(codec.GetVolumeLease().active() && codec.output_volume() == 0);
    fake_now_us += 1000000; codec.PollVolumeLease(); emit_eofs(7); codec.PollVolumeLease(); disarm_drain();
    assert(codec.output_volume() == 44 && Settings::persisted_volume == 44 && !codec.GetVolumeLease().active());
    assert(!codec.SetVolumeLease(0, false, "pending-user", 100));

    // Disconnect retirement/new owner isolation and a release with no lease.
    assert(codec.SetVolumeLease(0, false, "disconnect", 1000)); codec.RequestVolumeLeaseRelease(); arm_drain();
    assert(codec.SetVolumeLease(0, false, "new-owner", 1000)); disarm_drain();
    assert(codec.GetVolumeLease().owner == "new-owner" && codec.GetVolumeLease().saved_volume == 44);
    assert(!codec.SetVolumeLease(0, false, "disconnect", 100));
    assert(!codec.SetVolumeLease(0, false, "disconnect", 0));
    arm_drain(); assert(codec.SetVolumeLease(0, false, "new-owner", 0)); disarm_drain();
    codec.RequestVolumeLeaseRelease(); codec.PollVolumeLease();
    assert(codec.SetVolumeLease(0, false, "after-empty-release", 1000)); codec.PollVolumeLease();
    assert(codec.GetVolumeLease().owner == "after-empty-release");
    arm_drain(); assert(codec.SetVolumeLease(0, false, "after-empty-release", 0)); disarm_drain();

    // Failed volume apply after seven EOFs retains owner and checked hardware
    // mute. Retrying does not need new EOFs because no output could write.
    assert(codec.SetVolumeLease(0, false, "volume-failure", 1000)); arm_drain();
    volume_error = -1; assert(!codec.SetVolumeLease(0, false, "volume-failure", 0));
    assert(codec.GetVolumeLease().active() && codec.GetVolumeLease().saved_volume == 44 && hardware_muted && codec.output_volume() == 0);
    volume_error = 0; fake_now_us += 1000000;
    assert(codec.SetVolumeLease(0, false, "volume-failure", 0)); disarm_drain(); assert(codec.output_volume() == 44);

    // A checked unmute failure after drain is also fail-closed. The wrapper
    // swallowing mute errors must not cause an ACK or owner retirement.
    assert(codec.SetVolumeLease(0, false, "unmute-failure", 1000)); arm_drain(); fail_unmute = true;
    assert(!codec.SetVolumeLease(0, false, "unmute-failure", 0));
    assert(codec.GetVolumeLease().active() && hardware_muted && codec.output_volume() == 0);
    fail_unmute = false; fake_now_us += 1000000;
    assert(codec.SetVolumeLease(0, false, "unmute-failure", 0)); disarm_drain();

    // Failed hardware mute fences CPU writes and cannot report a restore ACK.
    assert(codec.SetVolumeLease(0, false, "mute-failure", 1000)); admitted = codec.BeginOutputEpoch();
    mute_error = -1; assert(!codec.SetVolumeLease(0, false, "mute-failure", 0));
    assert(codec.GetVolumeLease().active() && codec.OutputDataAtEpoch(pcm, admitted) == 0);
    mute_error = 0; fake_now_us += 1000000; arm_drain();
    assert(codec.SetVolumeLease(0, false, "mute-failure", 0)); disarm_drain();

    // A closed output can still retain DMA. Reopen MUTED, observe EOF, then
    // close MUTED and preserve disabled state. Stale PCM must not reopen it.
    assert(codec.SetVolumeLease(20, false, "disabled", 1000)); admitted = codec.BeginOutputEpoch();
    codec.EnableOutput(false); assert(!codec.output_enabled() && cached_muted && hardware_muted);
    arm_drain(); assert(codec.SetVolumeLease(0, false, "disabled", 0)); disarm_drain();
    assert(!codec.output_enabled() && codec.output_volume() == 44 && hardware_muted);
    const int disabled_opens = opens;
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0 && opens == disabled_opens && !codec.output_enabled());
    fresh = codec.BeginOutputEpoch(); assert(codec.OutputDataAtEpoch(pcm, fresh) == 16 && actual_volume == 44 && !hardware_muted);

    // A close fault after a verified drain cannot acknowledge restoration or
    // lose the saved volume; bounded retry preserves the disabled state.
    assert(codec.SetVolumeLease(0, false, "close-failure", 1000)); codec.EnableOutput(false); arm_drain();
    close_error = -1; assert(!codec.SetVolumeLease(0, false, "close-failure", 0));
    assert(codec.GetVolumeLease().active() && hardware_muted && codec.output_volume() == 0);
    close_error = 0; fake_now_us += 1000000;
    assert(codec.SetVolumeLease(0, false, "close-failure", 0)); disarm_drain(); assert(!codec.output_enabled());
    fresh = codec.BeginOutputEpoch(); assert(codec.OutputDataAtEpoch(pcm, fresh) == 16);

    // The same disabled reopen guarantee after a failed write/close.
    assert(codec.SetVolumeLease(0, false, "write-failure", 1000)); admitted = codec.BeginOutputEpoch();
    write_error = -1; assert(codec.OutputDataAtEpoch(pcm, admitted) == 0); write_error = 0;
    assert(!codec.output_enabled() && cached_muted); arm_drain();
    assert(codec.SetVolumeLease(0, false, "write-failure", 0)); disarm_drain(); assert(!codec.output_enabled());
    fresh = codec.BeginOutputEpoch(); assert(codec.OutputDataAtEpoch(pcm, fresh) == 16);

    assert(!codec.BeginDiagnosticOutput()); codec.EnableOutput(false); assert(codec.BeginDiagnosticOutput()); codec.EndDiagnosticOutput();
    close_error = -1; codec.EnableOutput(true); codec.EnableOutput(false); assert(!codec.output_enabled()); assert(closes > 0);
    const int failed_close_opens = opens;
    codec.EnableOutput(true); assert(!codec.output_enabled() && opens == failed_close_opens && hardware_muted);
    close_error = 0; codec.EnableOutput(true); assert(codec.output_enabled() && opens == failed_close_opens + 1);
    codec.EnableInput(true); read_error = close_error = -1;
    assert(!codec.InputData(pcm) && !codec.input_enabled());
    const int failed_input_close_opens = opens;
    codec.EnableInput(true); assert(!codec.input_enabled() && opens == failed_input_close_opens);
    read_error = close_error = 0; codec.EnableInput(true); assert(codec.input_enabled() && opens == failed_input_close_opens + 1);
    codec.EnableInput(false);
    block_write = true;
    std::thread io([&] { assert(codec.OutputDataAtEpoch(pcm, fresh) == 16); });
    write_entered.get_future().wait();
    assert(!codec.BeginDiagnosticOutput());
    const auto nonblocking_poll_start = std::chrono::steady_clock::now(); codec.PollVolumeLease();
    assert(std::chrono::steady_clock::now() - nonblocking_poll_start < std::chrono::milliseconds(50));
    std::promise<void> attempted;
    auto setting = std::async(std::launch::async, [&] { attempted.set_value(); codec.SetOutputVolume(55); });
    attempted.get_future().wait();
    assert(setting.wait_for(std::chrono::milliseconds(10)) == std::future_status::timeout);
    release_write.set_value(); io.join(); setting.get(); assert(codec.output_volume() == 55);

    // Real in-flight PCM holds the same mutex as the restoration fence. The
    // restore must wait for that write, drain it, and reject a parked old task.
    assert(codec.SetVolumeLease(0, false, "in-flight", 1000)); admitted = codec.BeginOutputEpoch();
    write_entered = std::promise<void>{}; release_write = std::promise<void>{}; release_future = release_write.get_future().share();
    block_write = true;
    std::thread leased_io([&] { assert(codec.OutputDataAtEpoch(pcm, admitted) == 16); });
    write_entered.get_future().wait(); arm_drain();
    std::promise<void> restoring;
    auto restore = std::async(std::launch::async, [&] { restoring.set_value(); return codec.SetVolumeLease(0, false, "in-flight", 0); });
    restoring.get_future().wait();
    assert(restore.wait_for(std::chrono::milliseconds(10)) == std::future_status::timeout);
    codec.PollVolumeLease(); // try-lock returns even while restore/write contend
    release_write.set_value(); leased_io.join(); assert(restore.get()); disarm_drain();
    const int after_restore_writes = writes, after_restore_opens = opens;
    assert(codec.OutputDataAtEpoch(pcm, admitted) == 0 && writes == after_restore_writes && opens == after_restore_opens);
    fresh = codec.BeginOutputEpoch(); assert(codec.OutputDataAtEpoch(pcm, fresh) == 16);

    // Without a verified callback/context acquisition cannot create a lease.
    registration_error = -1;
    { CoreS3AudioCodec failed(nullptr, 16000, 24000, 0, 0, 0, 0, 0, 0, 0, false); assert(!failed.SetVolumeLease(0, false, "untracked", 100)); }
    registration_error = 0; fail_eof_allocation = true;
    { CoreS3AudioCodec failed(nullptr, 16000, 24000, 0, 0, 0, 0, 0, 0, 0, false); assert(!failed.SetVolumeLease(0, false, "unallocated", 100)); }
    fail_eof_allocation = false;
    std::cout << "codec runtime: epoch, EOF drain, lease ownership, I/O and concurrency regressions passed\n";
}
