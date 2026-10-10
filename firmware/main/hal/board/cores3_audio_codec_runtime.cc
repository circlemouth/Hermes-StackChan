#include "cores3_audio_codec.h"
#include <esp_log.h>
#include <esp_timer.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <freertos/task.h>
#include <settings.h>
#include <algorithm>
#include <new>
#ifdef ESP_PLATFORM
#include <xtensa/config/core-isa.h>
#endif
#define TAG "CoreS3AudioCodec"

namespace {
constexpr int64_t kDrainAttemptUs = 500000;
constexpr int64_t kDrainRetryUs = 1000000;
constexpr uint32_t kDrainEofs = AUDIO_CODEC_DMA_DESC_NUM + 1;
static_assert(sizeof(std::atomic<uint32_t>) == 4 && alignof(std::atomic<uint32_t>) >= 4,
    "EOF ISR requires an aligned four-byte counter");
#ifdef ESP_PLATFORM
// ESP-IDF's PSRAM workaround makes GCC report is_always_lock_free=false.
// Its IRAM stdatomic dispatch sends INTERNAL-RAM 32-bit operations directly to
// S32C1I, before the external-RAM spinlock fallback. This context is INTERNAL.
static_assert(XCHAL_HAVE_S32C1I == 1, "EOF ISR requires native 32-bit atomics");
#else
static_assert(std::atomic<uint32_t>::is_always_lock_free, "Host EOF counter must be lock-free");
#endif
}

bool IRAM_ATTR CoreS3AudioCodec::OnTxSent(i2s_chan_handle_t, i2s_event_data_t*, void* context) {
    // Context is four bytes of internal RAM. No codec object, mutex, allocation,
    // FreeRTOS API, or audio write is accessed from this ISR.
    static_cast<std::atomic<uint32_t>*>(context)->fetch_add(1, std::memory_order_relaxed);
    return false;
}

bool CoreS3AudioCodec::RegisterTxCompletionTracking() {
    auto* storage = heap_caps_malloc(sizeof(std::atomic<uint32_t>), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!storage) { ESP_LOGW(TAG, "EOF context allocation failed; speaker leases unavailable"); return false; }
    tx_eof_count_ = new (storage) std::atomic<uint32_t>(0);
    i2s_event_callbacks_t callbacks{};
    callbacks.on_sent = &CoreS3AudioCodec::OnTxSent;
    if (i2s_channel_register_event_callback(tx_handle_, &callbacks, tx_eof_count_) != ESP_OK) {
        heap_caps_free(tx_eof_count_);
        tx_eof_count_ = nullptr;
        ESP_LOGW(TAG, "EOF registration failed; speaker leases unavailable");
        return false;
    }
    return true;
}

uint32_t CoreS3AudioCodec::BeginOutputEpoch() {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    return ++output_epoch_;
}
uint32_t CoreS3AudioCodec::OutputEpoch() {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    return output_epoch_;
}
int CoreS3AudioCodec::OutputDataAtEpoch(std::vector<int16_t>& data, uint32_t epoch) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    // Reject BEFORE automatic re-enable. A task parked after a queue generation
    // check cannot reopen or write after restoration retired its hardware epoch.
    if (epoch != output_epoch_ || drain_fenced_) return 0;
    if (!output_enabled_ && !EnableOutputLocked(true)) return 0;
    return AudioCodec::OutputData(data);
}
int CoreS3AudioCodec::OutputData(std::vector<int16_t>& data) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (drain_fenced_) return 0;
    return AudioCodec::OutputData(data);
}

bool CoreS3AudioCodec::ApplyVolumeLocked(int volume, bool permanent) {
    volume = std::clamp(volume, 0, 100);
    if (output_enabled_ && esp_codec_dev_set_out_vol(output_dev_, volume) != ESP_CODEC_DEV_OK) {
        ESP_LOGW(TAG, "Volume change failed; retaining previous value");
        return false;
    }
    output_volume_ = volume;
    if (permanent) {
        Settings settings("audio", true);
        settings.SetInt("output_volume", volume);
    }
    return true;
}

bool CoreS3AudioCodec::HardwareMuteLocked(bool muted) {
    return out_codec_if_ && out_codec_if_->mute &&
        out_codec_if_->mute(out_codec_if_, muted) == ESP_CODEC_DEV_OK;
}
bool CoreS3AudioCodec::IsRetiredLeaseLocked(const std::string& owner) const {
    return std::find(retired_lease_ids_.begin(), retired_lease_ids_.end(), owner) != retired_lease_ids_.end();
}
void CoreS3AudioCodec::RetireLeaseLocked() {
    // Reset/admission may run while a staged drain is pending. Retire those
    // draining epochs too; only a fresh post-ACK admission may write afterward.
    ++output_epoch_;
    retired_lease_ids_[retired_lease_cursor_++ % retired_lease_ids_.size()] = volume_lease_.owner;
    volume_lease_.clear();
    lease_release_requested_ = false;
    drain_fenced_ = drain_hw_muted_ = drain_cache_muted_ = drain_attempt_running_ = drain_complete_ = false;
    drain_retry_after_us_ = 0;
    pending_permanent_ = false;
}
void CoreS3AudioCodec::DeferDrainRetryLocked() {
    drain_attempt_running_ = false;
    drain_retry_after_us_ = esp_timer_get_time() + kDrainRetryUs;
}

bool CoreS3AudioCodec::DrainLeaseLocked(bool wait) {
    if (!volume_lease_.active()) return true;
    if (esp_timer_get_time() < drain_retry_after_us_) return false;
    if (!drain_attempt_running_ && !drain_complete_) {
        // One absolute deadline includes preparation/reopen, not 500 ms per
        // descriptor or per Poll call. Existing device I/O has its own timeout.
        drain_deadline_us_ = esp_timer_get_time() + kDrainAttemptUs;
    }
    if (!drain_fenced_) {
        drain_restore_enabled_ = output_enabled_.load();
        // Try checked hardware mute FIRST, then fence under the very same mutex
        // as epoch+enable+write. Even a mute fault must retire parked PCM writes.
        drain_hw_muted_ = HardwareMuteLocked(true);
        ++output_epoch_;
        drain_fenced_ = true;
    }
    if (!drain_hw_muted_) drain_hw_muted_ = HardwareMuteLocked(true);
    if (!drain_hw_muted_ || !tx_eof_count_) { DeferDrainRetryLocked(); return false; }
    if (!drain_cache_muted_) {
        if (esp_codec_dev_set_out_mute(output_dev_, true) != ESP_CODEC_DEV_OK) { DeferDrainRetryLocked(); return false; }
        drain_cache_muted_ = true;
    }
    if (output_volume() != 0 && !ApplyVolumeLocked(0, false)) { DeferDrainRetryLocked(); return false; }
    if (drain_complete_) return true;
    if (!drain_attempt_running_) {
        // A failed write/close can leave nonzero DMA behind. Reopen while
        // hardware/cache mute remains set, never disable TX to fake a purge.
        if (!output_enabled_ && !EnableOutputLocked(true, true)) { DeferDrainRetryLocked(); return false; }
        drain_start_eof_ = tx_eof_count_->load(std::memory_order_relaxed);
        drain_attempt_running_ = true;
    }
    for (;;) {
        if (esp_timer_get_time() >= drain_deadline_us_) { DeferDrainRetryLocked(); return false; }
        // Unsigned subtraction also handles ISR-counter wraparound.
        if (uint32_t(tx_eof_count_->load(std::memory_order_relaxed) - drain_start_eof_) >= kDrainEofs) {
            drain_attempt_running_ = false;
            drain_complete_ = true;
            return true;
        }
        if (!wait) return false; // independent UI poll is staged, not a 500 ms wait
        vTaskDelay(1);
    }
}

bool CoreS3AudioCodec::RestoreLeaseLocked(bool wait) {
    if (!volume_lease_.active()) { lease_release_requested_ = false; return true; }
    if (!DrainLeaseLocked(wait)) return false;
    const int target = pending_permanent_ ? pending_permanent_volume_ : volume_lease_.saved_volume;
    // Preserve a disabled output. Close while MUTED before changing its cached
    // volume; future freshly admitted output opens at that volume, not old PCM.
    if (!drain_restore_enabled_ && !CloseOutputLocked()) { DeferDrainRetryLocked(); return false; }
    if (!ApplyVolumeLocked(target, pending_permanent_)) { DeferDrainRetryLocked(); return false; }
    if (drain_restore_enabled_) {
        // The descriptor ring is silent and every old CPU write is fenced.
        if (esp_codec_dev_set_out_mute(output_dev_, false) != ESP_CODEC_DEV_OK || !HardwareMuteLocked(false)) {
            HardwareMuteLocked(true);
            esp_codec_dev_set_out_mute(output_dev_, true);
            ApplyVolumeLocked(0, false);
            drain_hw_muted_ = false; // reverify hardware on bounded retry
            DeferDrainRetryLocked();
            return false;
        }
    }
    RetireLeaseLocked(); // only after verified drain and volume/mute operations
    return true;
}

void CoreS3AudioCodec::SetOutputVolume(int volume) {
    (void)SetVolumeLease(volume, true, "", 0);
}
bool CoreS3AudioCodec::SetOutputVolumeTemporary(int volume) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (volume_lease_.active() || drain_fenced_) return false;
    return ApplyVolumeLocked(volume, false);
}
bool CoreS3AudioCodec::SetVolumeLease(int volume, bool permanent, const std::string& owner, int lease_ms) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (permanent) {
        // Ordinary volume changes must NOT discard normal TTS. Only an active
        // lease override runs the mute/fence/drain transition.
        if (!volume_lease_.active()) return ApplyVolumeLocked(volume, true);
        pending_permanent_ = true;
        pending_permanent_volume_ = std::clamp(volume, 0, 100);
        lease_release_requested_ = true;
        return RestoreLeaseLocked(true);
    }
    if (owner.empty() || owner.size() > 96 || !runtime_safety::ValidCredential(owner) || IsRetiredLeaseLocked(owner)) return false;
    if (lease_ms == 0) {
        if (!volume_lease_.active() || volume_lease_.owner != owner || pending_permanent_) return false;
        lease_release_requested_ = true;
        return RestoreLeaseLocked(true);
    }
    if (lease_ms < 1 || lease_ms > 120000 || !tx_eof_count_ || !out_codec_if_ || !out_codec_if_->mute) return false;
    if (lease_release_requested_ || volume_lease_.expired(esp_timer_get_time() / 1000) || drain_fenced_) {
        if (!RestoreLeaseLocked(true)) return false;
        // Restore may have retired this very owner. Its delayed renewal must
        // not recapture a permanent setting or the next generation's lease.
        if (IsRetiredLeaseLocked(owner)) return false;
    }
    if (!volume_lease_.accepts(owner)) return false;
    const int previous = output_volume();
    if (!ApplyVolumeLocked(volume, false)) return false;
    volume_lease_.acquire(owner, previous, lease_ms, esp_timer_get_time() / 1000);
    return true; // same-owner renewal does not advance the output epoch
}
runtime_safety::VolumeLease CoreS3AudioCodec::GetVolumeLease() {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    return volume_lease_;
}
void CoreS3AudioCodec::PollVolumeLease() {
    std::unique_lock<std::recursive_mutex> lock(codec_mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return;
    if (lease_release_requested_ || drain_fenced_ || volume_lease_.expired(esp_timer_get_time() / 1000)) {
        (void)RestoreLeaseLocked(false);
    }
}

bool CoreS3AudioCodec::BeginDiagnosticOutput() {
    if (!codec_mutex_.try_lock()) return false;
    if (input_enabled_ || output_enabled_ || volume_lease_.active() || drain_fenced_) {
        codec_mutex_.unlock(); return false;
    }
    return true;
}
void CoreS3AudioCodec::EndDiagnosticOutput() { codec_mutex_.unlock(); }

void CoreS3AudioCodec::EnableInput(bool enable) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (enable == input_enabled_ && !input_close_failed_) return;
    if (enable) {
        if (input_close_failed_) {
            input_close_failed_ = esp_codec_dev_close(input_dev_) != ESP_CODEC_DEV_OK;
            if (input_close_failed_) return;
        }
        esp_codec_dev_sample_info_t fs = {
            .bits_per_sample = 16, .channel = 2,
            .channel_mask = ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0),
            .sample_rate = (uint32_t)output_sample_rate_, .mclk_multiple = 0,
        };
        if (input_reference_) fs.channel_mask |= ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1);
        if (esp_codec_dev_open(input_dev_, &fs) != ESP_CODEC_DEV_OK ||
            esp_codec_dev_set_in_channel_gain(input_dev_, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0), input_gain_) != ESP_CODEC_DEV_OK) {
            input_close_failed_ = esp_codec_dev_close(input_dev_) != ESP_CODEC_DEV_OK; input_enabled_ = false;
            ESP_LOGW(TAG, "Input open/gain failed; microphone degraded, retry on next enable"); return;
        }
    } else {
        const int ret = esp_codec_dev_close(input_dev_);
        input_close_failed_ = ret != ESP_CODEC_DEV_OK;
        if (ret != ESP_CODEC_DEV_OK) ESP_LOGW(TAG, "Input close failed (%d)", ret);
    }
    AudioCodec::EnableInput(enable);
}

bool CoreS3AudioCodec::CloseOutputLocked() {
    // Preserve the wrapper's cached mute BEFORE close, so a later open cannot
    // briefly replay retained DMA at the previous amplifier volume.
    const bool muted = HardwareMuteLocked(true);
    const bool cached = esp_codec_dev_set_out_mute(output_dev_, true) == ESP_CODEC_DEV_OK;
    const int ret = esp_codec_dev_close(output_dev_);
    output_close_failed_ = ret != ESP_CODEC_DEV_OK;
    output_enabled_ = false;
    if (ret != ESP_CODEC_DEV_OK) ESP_LOGW(TAG, "Output close failed (%d)", ret);
    return muted && cached && ret == ESP_CODEC_DEV_OK;
}
bool CoreS3AudioCodec::EnableOutputLocked(bool enable, bool for_drain) {
    if (enable == output_enabled_ && !output_close_failed_) return true;
    if (!enable) return CloseOutputLocked();
    // A failed partial close may leave wrapper flags open. Finish its cleanup
    // before open() can mistake that stale state for an already-open device.
    if (output_close_failed_ && !CloseOutputLocked()) return false;
    // AW88298 remains configured after wrapper close. Stage BOTH hardware and
    // wrapper cache before open: esp_codec_dev_open reapplies cached mute and
    // otherwise could undo a direct HMUTE while retained DMA is still nonzero.
    if (!HardwareMuteLocked(true) ||
        esp_codec_dev_set_out_mute(output_dev_, true) != ESP_CODEC_DEV_OK) return false;
    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = 16, .channel = 1, .channel_mask = 0,
        .sample_rate = (uint32_t)output_sample_rate_, .mclk_multiple = 0,
    };
    if (esp_codec_dev_open(output_dev_, &fs) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_set_out_vol(output_dev_, output_volume()) != ESP_CODEC_DEV_OK ||
        esp_codec_dev_set_out_mute(output_dev_, for_drain) != ESP_CODEC_DEV_OK ||
        !HardwareMuteLocked(for_drain)) {
        // Even partially successful open stays muted on failure.
        HardwareMuteLocked(true);
        esp_codec_dev_set_out_mute(output_dev_, true);
        output_close_failed_ = esp_codec_dev_close(output_dev_) != ESP_CODEC_DEV_OK;
        output_enabled_ = false;
        ESP_LOGW(TAG, "Output open/volume/mute failed; retry on next enable");
        return false;
    }
    AudioCodec::EnableOutput(true);
    if (for_drain) drain_cache_muted_ = true;
    return true;
}
void CoreS3AudioCodec::EnableOutput(bool enable) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (drain_fenced_) {
        if (!enable) drain_restore_enabled_ = false;
        return; // stale automatic enable/close must not interrupt physical drain
    }
    (void)EnableOutputLocked(enable);
}

int CoreS3AudioCodec::Read(int16_t* dest, int samples) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (!input_enabled_ || samples <= 0) return 0;
    const int ret = esp_codec_dev_read(input_dev_, dest, samples * sizeof(int16_t));
    if (ret != ESP_CODEC_DEV_OK) {
        std::fill(dest, dest + samples, 0); input_enabled_ = false;
        input_close_failed_ = esp_codec_dev_close(input_dev_) != ESP_CODEC_DEV_OK;
        ESP_LOGW(TAG, "PCM read failed (%d); discarding buffer", ret); return 0;
    }
    return samples;
}
int CoreS3AudioCodec::Write(const int16_t* data, int samples) {
    std::lock_guard<std::recursive_mutex> lock(codec_mutex_);
    if (!output_enabled_ || drain_fenced_ || samples <= 0) return 0;
    const int ret = esp_codec_dev_write(output_dev_, const_cast<int16_t*>(data), samples * sizeof(int16_t));
    if (ret != ESP_CODEC_DEV_OK) {
        CloseOutputLocked();
        ESP_LOGW(TAG, "PCM write failed (%d); not counted as playback", ret); return 0;
    }
    return samples;
}
