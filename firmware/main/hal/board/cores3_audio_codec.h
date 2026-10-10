#ifndef _BOX_AUDIO_CODEC_H
#define _BOX_AUDIO_CODEC_H

#include "audio_codec.h"
#include <esp_codec_dev.h>
#include <mutex>
#include <atomic>
#include <array>
#include <runtime_safety.h>
#include <hal/board/codec_dma_interfaces.h>

class CoreS3AudioCodec : public AudioCodec {
private:
    std::recursive_mutex codec_mutex_;
    runtime_safety::VolumeLease volume_lease_;
    std::atomic<bool> lease_release_requested_{false};
    uint32_t output_epoch_ = 0; // compared and advanced under codec_mutex_
    std::atomic<uint32_t>* tx_eof_count_ = nullptr; // internal RAM, ISR never touches this object
    std::array<std::string, 16> retired_lease_ids_{};
    size_t retired_lease_cursor_ = 0;
    bool drain_fenced_ = false;
    bool drain_hw_muted_ = false;
    bool drain_cache_muted_ = false;
    bool drain_attempt_running_ = false;
    bool drain_complete_ = false;
    bool drain_restore_enabled_ = false;
    uint32_t drain_start_eof_ = 0;
    int64_t drain_deadline_us_ = 0;
    int64_t drain_retry_after_us_ = 0;
    bool output_close_failed_ = false;
    bool input_close_failed_ = false;
    bool pending_permanent_ = false;
    int pending_permanent_volume_ = 0;

    bool ApplyVolumeLocked(int volume, bool permanent);
    bool RestoreLeaseLocked(bool wait);
    bool DrainLeaseLocked(bool wait);
    bool HardwareMuteLocked(bool muted);
    bool EnableOutputLocked(bool enable, bool for_drain = false);
    bool CloseOutputLocked();
    bool RegisterTxCompletionTracking();
    static bool OnTxSent(i2s_chan_handle_t, i2s_event_data_t*, void* context);
    bool IsRetiredLeaseLocked(const std::string& owner) const;
    void RetireLeaseLocked();
    void DeferDrainRetryLocked();

    const audio_codec_data_if_t* data_if_ = nullptr;
    const audio_codec_ctrl_if_t* out_ctrl_if_ = nullptr;
    const audio_codec_if_t* out_codec_if_ = nullptr;
    const audio_codec_ctrl_if_t* in_ctrl_if_ = nullptr;
    const audio_codec_if_t* in_codec_if_ = nullptr;
    const audio_codec_gpio_if_t* gpio_if_ = nullptr;
    esp_codec_dev_handle_t output_dev_ = nullptr;
    esp_codec_dev_handle_t input_dev_ = nullptr;
    void CreateDuplexChannels(gpio_num_t mclk, gpio_num_t bclk, gpio_num_t ws, gpio_num_t dout, gpio_num_t din);
    int Read(int16_t* dest, int samples) override;
    int Write(const int16_t* data, int samples) override;

public:
    CoreS3AudioCodec(void* i2c_master_handle, int input_sample_rate, int output_sample_rate,
        gpio_num_t mclk, gpio_num_t bclk, gpio_num_t ws, gpio_num_t dout, gpio_num_t din,
        uint8_t aw88298_addr, uint8_t es7210_addr, bool input_reference);
    ~CoreS3AudioCodec() override;
    uint32_t BeginOutputEpoch() override;
    uint32_t OutputEpoch() override;
    int OutputDataAtEpoch(std::vector<int16_t>& data, uint32_t epoch) override;
    int OutputData(std::vector<int16_t>& data) override;
    void SetOutputVolume(int volume) override;
    bool SetOutputVolumeTemporary(int volume) override;
    bool BeginDiagnosticOutput() override;
    void EndDiagnosticOutput() override;
    void RequestVolumeLeaseRelease() override { lease_release_requested_ = true; }
    void PollVolumeLease() override;
    bool SetVolumeLease(int volume, bool permanent, const std::string& owner, int lease_ms);
    runtime_safety::VolumeLease GetVolumeLease();
    void EnableInput(bool enable) override;
    void EnableOutput(bool enable) override;
};

#endif // _BOX_AUDIO_CODEC_H
