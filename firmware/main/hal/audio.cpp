/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <algorithm>
#include <array>
#include <esp_heap_caps.h>
#include <mooncake_log.h>
#include <memory>
#include <vector>
#include <board.h>
#include <audio/audio_codec.h>
#include <hal/board/config.h>

static const std::string_view _tag = "HAL-Audio";

namespace {

constexpr size_t _mic_test_duration_seconds      = 3;
constexpr size_t _mic_test_playback_chunk_frames = 512;
constexpr size_t _mic_waveform_point_count       = 128;
constexpr size_t _mic_waveform_samples_per_point = 6;
constexpr size_t _mic_waveform_capture_frames    = _mic_waveform_point_count * _mic_waveform_samples_per_point;

struct MicTestFrame {
    int16_t mic;
    int16_t reference;
};

}  // namespace

std::string Hal::startMicTest(std::function<void(MicTestStatus)> onStatusUpdate)
{
    mclog::tagInfo(_tag, "start mic test");
    onStatusUpdate(MicTestStatus::Starting);

    auto& board      = Board::GetInstance();
    auto audio_codec = board.GetAudioCodec();
    if (!audio_codec) {
        mclog::tagError(_tag, "audio codec unavailable");
        clearupMicTest();
        onStatusUpdate(MicTestStatus::Failed);
        return "audio codec unavailable";
    }

    const size_t total_frames   = AUDIO_INPUT_SAMPLE_RATE * _mic_test_duration_seconds;
    const size_t input_channels = std::max(audio_codec->input_channels(), 1);
    auto* recorded_frames       = static_cast<MicTestFrame*>(
        heap_caps_malloc(total_frames * sizeof(MicTestFrame), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!recorded_frames) {
        mclog::tagError(_tag, "failed to allocate %u bytes for mic test buffer",
                        static_cast<unsigned>(total_frames * sizeof(MicTestFrame)));
        clearupMicTest();
        onStatusUpdate(MicTestStatus::Failed);
        return "failed to allocate mic test buffer";
    }

    audio_codec->EnableInput(true);
    onStatusUpdate(MicTestStatus::Recording);

    size_t recorded_frame_count = 0;
    std::vector<int16_t> input_chunk;

    while (recorded_frame_count < total_frames) {
        const size_t frames_to_read = std::min(total_frames - recorded_frame_count, _mic_test_playback_chunk_frames);
        input_chunk.resize(frames_to_read * input_channels);
        if (!audio_codec->InputData(input_chunk)) {
            mclog::tagError(_tag, "mic read failed after %u frames", static_cast<unsigned>(recorded_frame_count));
            break;
        }

        for (size_t frame_index = 0; frame_index < frames_to_read; ++frame_index) {
            const size_t sample_index                               = frame_index * input_channels;
            recorded_frames[recorded_frame_count + frame_index].mic = input_chunk[sample_index];
            recorded_frames[recorded_frame_count + frame_index].reference =
                input_channels > 1 ? input_chunk[sample_index + 1] : input_chunk[sample_index];
        }
        recorded_frame_count += frames_to_read;
    }

    audio_codec->EnableInput(false);

    if (recorded_frame_count == 0) {
        mclog::tagError(_tag, "mic test captured no audio");
        heap_caps_free(recorded_frames);
        clearupMicTest();
        onStatusUpdate(MicTestStatus::Failed);
        return "mic test captured no audio";
    }

    audio_codec->EnableOutput(true);
    onStatusUpdate(MicTestStatus::Playing);

    std::array<int16_t, _mic_test_playback_chunk_frames> playback_chunk{};
    std::vector<int16_t> output_chunk;
    output_chunk.reserve(_mic_test_playback_chunk_frames);
    size_t played_frames = 0;
    while (played_frames < recorded_frame_count) {
        const size_t frames_to_write = std::min(recorded_frame_count - played_frames, playback_chunk.size());
        for (size_t i = 0; i < frames_to_write; ++i) {
            playback_chunk[i] = recorded_frames[played_frames + i].mic;
        }

        output_chunk.assign(playback_chunk.begin(), playback_chunk.begin() + frames_to_write);
        audio_codec->OutputData(output_chunk);
        played_frames += frames_to_write;
    }

    heap_caps_free(recorded_frames);
    clearupMicTest();
    onStatusUpdate(MicTestStatus::Done);
    return {};
}

void Hal::getMicWaveformFrame(std::vector<int16_t>& data)
{
    data.assign(_mic_waveform_point_count, 0);

    auto& board      = Board::GetInstance();
    auto audio_codec = board.GetAudioCodec();
    if (!audio_codec) {
        mclog::tagError(_tag, "audio codec unavailable for waveform capture");
        return;
    }

    const size_t input_channels = std::max(audio_codec->input_channels(), 1);
    std::vector<int16_t> input_chunk(_mic_waveform_capture_frames * input_channels);
    if (!audio_codec->input_enabled()) {
        audio_codec->EnableInput(true);
    }

    const bool read_ok = audio_codec->InputData(input_chunk);

    if (!read_ok) {
        mclog::tagError(_tag, "mic waveform capture failed");
        return;
    }

    for (size_t point_index = 0; point_index < _mic_waveform_point_count; ++point_index) {
        int16_t selected_sample = 0;
        int32_t peak_magnitude  = -1;

        for (size_t sample_offset = 0; sample_offset < _mic_waveform_samples_per_point; ++sample_offset) {
            const size_t frame_index = point_index * _mic_waveform_samples_per_point + sample_offset;
            const int16_t sample     = input_chunk[frame_index * input_channels];
            const int32_t magnitude  = std::abs(static_cast<int32_t>(sample));
            if (magnitude > peak_magnitude) {
                peak_magnitude  = magnitude;
                selected_sample = sample;
            }
        }

        data[point_index] = selected_sample;
    }
}

void Hal::clearupMicTest()
{
    auto& board      = Board::GetInstance();
    auto audio_codec = board.GetAudioCodec();
    if (!audio_codec) {
        return;
    }

    if (audio_codec->output_enabled()) {
        audio_codec->EnableOutput(false);
    }

    if (audio_codec->input_enabled()) {
        audio_codec->EnableInput(false);
    }
}
