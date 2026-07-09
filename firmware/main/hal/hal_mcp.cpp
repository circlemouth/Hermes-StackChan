/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <algorithm>
#include <cJSON.h>
#include <cstring>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <vector>
#include <audio/audio_codec.h>
#include <board.h>
#include <esp_heap_caps.h>
#include <jpg/jpeg_to_image.h>
#include <mooncake_log.h>
#include <mcp_server.h>
#include <settings.h>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "sdkconfig.h"
#include "board/hal_bridge.h"
#include "board/config.h"
#include "board/stackchan_camera.h"
#include "board/stackchan_display.h"

using namespace stackchan;

static const std::string_view _tag = "HAL-MCP";

namespace {
constexpr size_t kMaxPreviewImageBytes = 2 * 1024 * 1024;

const char* wifi_status_to_string(WifiStatus status)
{
    switch (status) {
        case WifiStatus::None:
            return "none";
        case WifiStatus::Low:
            return "low";
        case WifiStatus::Medium:
            return "medium";
        case WifiStatus::High:
            return "high";
        default:
            return "unknown";
    }
}

std::string get_websocket_url()
{
    Settings ws_settings("websocket", false);
    std::string websocket_url = ws_settings.GetString("url_override", "");
    if (websocket_url.empty()) {
        websocket_url = ws_settings.GetString("url", "");
    }
    return websocket_url;
}

std::string websocket_scheme(std::string_view url)
{
    auto scheme_end = url.find("://");
    if (scheme_end == std::string_view::npos || scheme_end == 0) {
        return "";
    }
    return std::string(url.substr(0, scheme_end));
}

std::string websocket_host(std::string_view url)
{
    auto host_start = url.find("://");
    if (host_start == std::string_view::npos) {
        host_start = 0;
    } else {
        host_start += 3;
    }

    auto host_end = url.find_first_of(":/", host_start);
    if (host_end == std::string_view::npos) {
        host_end = url.length();
    }

    return std::string(url.substr(host_start, host_end - host_start));
}

bool is_jpeg(const uint8_t* data, size_t len)
{
    return len >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff;
}

bool is_png(const uint8_t* data, size_t len)
{
    static constexpr uint8_t kPngMagic[] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
    return len >= sizeof(kPngMagic) && std::memcmp(data, kPngMagic, sizeof(kPngMagic)) == 0;
}

std::unique_ptr<LvglImage> preview_image_from_bytes(const uint8_t* data, size_t len)
{
    if (is_jpeg(data, len)) {
#ifdef CONFIG_IDF_TARGET_ESP32
        throw std::runtime_error("JPEG preview decode is not available on this target");
#else
        uint8_t* out_data = nullptr;
        size_t out_len    = 0;
        size_t width      = 0;
        size_t height     = 0;
        size_t stride     = 0;
        esp_err_t ret     = jpeg_to_image(data, len, &out_data, &out_len, &width, &height, &stride);
        if (ret != ESP_OK || out_data == nullptr) {
            if (out_data) {
                heap_caps_free(out_data);
            }
            throw std::runtime_error("Failed to decode JPEG image");
        }
        return std::make_unique<LvglAllocatedImage>(out_data, out_len, width, height, stride, LV_COLOR_FORMAT_RGB565);
#endif  // CONFIG_IDF_TARGET_ESP32
    }

    if (is_png(data, len)) {
        auto* copy = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (copy == nullptr) {
            copy = heap_caps_malloc(len, MALLOC_CAP_8BIT);
        }
        if (copy == nullptr) {
            throw std::runtime_error("Failed to allocate memory for PNG image");
        }
        std::memcpy(copy, data, len);
        return std::make_unique<LvglAllocatedImage>(copy, len);
    }

    throw std::runtime_error("Unsupported image format; only JPEG and PNG are supported");
}

std::unique_ptr<LvglImage> download_preview_image(const std::string& url)
{
    auto http = Board::GetInstance().GetNetwork()->CreateHttp(3);
    if (!http->Open("GET", url)) {
        throw std::runtime_error("Failed to open URL: " + url);
    }

    int status_code = http->GetStatusCode();
    if (status_code != 200) {
        http->Close();
        throw std::runtime_error("Unexpected status code: " + std::to_string(status_code));
    }

    std::string body = http->ReadAll();
    http->Close();

    if (body.empty()) {
        throw std::runtime_error("Downloaded image is empty");
    }
    if (body.size() > kMaxPreviewImageBytes) {
        throw std::runtime_error("Downloaded image is too large");
    }

    return preview_image_from_bytes(reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

cJSON* play_test_tone(int frequency_hz, int duration_ms, int amplitude)
{
    frequency_hz = std::clamp(frequency_hz, 100, 2000);
    duration_ms  = std::clamp(duration_ms, 100, 3000);
    amplitude    = std::clamp(amplitude, 500, 16000);

    auto audio_codec = Board::GetInstance().GetAudioCodec();
    if (audio_codec == nullptr) {
        throw std::runtime_error("audio codec unavailable");
    }
    const bool was_output_enabled = audio_codec->output_enabled();
    const bool input_was_enabled  = audio_codec->input_enabled();

    constexpr int kSampleRate = AUDIO_OUTPUT_SAMPLE_RATE;
    constexpr double kPi      = 3.14159265358979323846;
    constexpr size_t kChunkFrames = 512;
    const size_t total_frames = static_cast<size_t>(kSampleRate) * static_cast<size_t>(duration_ms) / 1000;
    const size_t ramp_frames = std::min(total_frames / 2, static_cast<size_t>(kSampleRate / 100));
    std::vector<int16_t> chunk;
    chunk.reserve(kChunkFrames);

    audio_codec->EnableOutput(true);
    size_t written = 0;
    while (written < total_frames) {
        const size_t frames = std::min(kChunkFrames, total_frames - written);
        chunk.resize(frames);
        for (size_t i = 0; i < frames; ++i) {
            const size_t sample_index = written + i;
            double envelope = 1.0;
            if (ramp_frames > 0 && sample_index < ramp_frames) {
                envelope = static_cast<double>(sample_index) / static_cast<double>(ramp_frames);
            } else if (ramp_frames > 0 && total_frames - sample_index <= ramp_frames) {
                envelope = static_cast<double>(total_frames - sample_index) / static_cast<double>(ramp_frames);
            }
            const double phase = 2.0 * kPi * static_cast<double>(frequency_hz) *
                static_cast<double>(sample_index) / static_cast<double>(kSampleRate);
            chunk[i] = static_cast<int16_t>(std::sin(phase) * static_cast<double>(amplitude) * envelope);
        }
        audio_codec->OutputData(chunk);
        written += frames;
    }

    std::vector<int16_t> silence(kChunkFrames, 0);
    for (int i = 0; i < 3; ++i) {
        audio_codec->OutputData(silence);
    }
    vTaskDelay(pdMS_TO_TICKS(20));
    // Keep the speaker path open when the mic side is active. On CoreS3, closing
    // output while the duplex input channel is running can leave the next speech
    // playback raspy until the codec is reopened cleanly.
    const bool kept_output_enabled = was_output_enabled || input_was_enabled;
    if (!kept_output_enabled) {
        audio_codec->EnableOutput(false);
    }

    cJSON* result = cJSON_CreateObject();
    cJSON_AddNumberToObject(result, "frequency_hz", frequency_hz);
    cJSON_AddNumberToObject(result, "duration_ms", duration_ms);
    cJSON_AddNumberToObject(result, "amplitude", amplitude);
    cJSON_AddNumberToObject(result, "sample_rate", kSampleRate);
    cJSON_AddNumberToObject(result, "frames", static_cast<double>(total_frames));
    cJSON_AddBoolToObject(result, "output_was_enabled", was_output_enabled);
    cJSON_AddBoolToObject(result, "input_was_enabled", input_was_enabled);
    cJSON_AddBoolToObject(result, "kept_output_enabled", kept_output_enabled);
    return result;
}
}  // namespace

void Hal::robot_mcp_init()
{
    mclog::tagInfo(_tag, "init");

    // Firmware-side robot MCP tools used by the Hermes bridge.
    auto& mcp_server = McpServer::GetInstance();

    mclog::tagInfo(_tag, "add robot.get_status tool");
    mcp_server.AddTool("self.robot.get_status",
                       "Get local StackChan status without exposing secrets or the full bridge URL.",
                       std::vector<Property>{}, [this](const PropertyList& properties) -> ReturnValue {
                           const std::string websocket_url = get_websocket_url();
                           cJSON* result                   = cJSON_CreateObject();

                           cJSON_AddStringToObject(result, "device_id", GetHAL().getFactoryMacString().c_str());
                           cJSON_AddStringToObject(result, "firmware_version", common::FirmwareVersion.data());
                           cJSON_AddNumberToObject(result, "battery_level", GetHAL().getBatteryLevel());
                           cJSON_AddBoolToObject(result, "charging", GetHAL().isBatteryCharging());
                           cJSON_AddStringToObject(result, "wifi_status",
                                                   wifi_status_to_string(GetHAL().getWifiStatus()));
                           cJSON_AddBoolToObject(result, "wifi_configured", GetHAL().isAppConfiged());
                           cJSON_AddBoolToObject(result, "sd_config_error", GetHAL().hasSdConfigError());
                           if (GetHAL().hasSdConfigError()) {
                               cJSON_AddStringToObject(result, "sd_config_error_detail",
                                                       GetHAL().getLastSdConfigError().c_str());
                           }
                           cJSON_AddNumberToObject(result, "speaker_volume", GetHAL().getSpeakerVolume());
                           cJSON_AddNumberToObject(result, "backlight_brightness", GetHAL().getBackLightBrightness());
#if CONFIG_HERMES_AUTOSTART
                           cJSON_AddBoolToObject(result, "hermes_autostart", true);
#else
                           cJSON_AddBoolToObject(result, "hermes_autostart", false);
#endif
                           cJSON_AddBoolToObject(result, "websocket_configured", !websocket_url.empty());
                           cJSON_AddStringToObject(result, "websocket_scheme",
                                                   websocket_scheme(websocket_url).c_str());
                           cJSON_AddStringToObject(result, "websocket_host", websocket_host(websocket_url).c_str());

                           return result;
                       });

    mclog::tagInfo(_tag, "add robot.set_speaker_volume tool");
    mcp_server.AddTool("self.robot.set_speaker_volume",
                       "Set StackChan speaker volume. Use low values such as 25-45 when diagnosing distortion.",
                       PropertyList({Property("volume", kPropertyTypeInteger, 40, 0, 100),
                                     Property("permanent", kPropertyTypeBoolean, false)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int volume    = properties["volume"].value<int>();
                           bool permanent = properties["permanent"].value<bool>();
                           if (volume < 0) {
                               volume = 0;
                           } else if (volume > 100) {
                               volume = 100;
                           }

                           mclog::tagInfo(_tag, "set_speaker_volume: volume={}, permanent={}", volume, permanent);
                           GetHAL().setSpeakerVolume(static_cast<uint8_t>(volume), permanent);

                           cJSON* result = cJSON_CreateObject();
                           cJSON_AddNumberToObject(result, "speaker_volume", GetHAL().getSpeakerVolume());
                           cJSON_AddBoolToObject(result, "permanent", permanent);
                           return result;
                       });

    mclog::tagInfo(_tag, "add audio.play_test_tone tool");
    mcp_server.AddTool("self.audio.play_test_tone",
                       "Play a short diagnostic sine tone directly on StackChan speaker, bypassing Hermes/TTS/Opus.",
                       PropertyList({Property("frequency_hz", kPropertyTypeInteger, 440, 100, 2000),
                                     Property("duration_ms", kPropertyTypeInteger, 800, 100, 3000),
                                     Property("amplitude", kPropertyTypeInteger, 6000, 500, 16000)}),
                       [](const PropertyList& properties) -> ReturnValue {
                           int frequency_hz = properties["frequency_hz"].value<int>();
                           int duration_ms  = properties["duration_ms"].value<int>();
                           int amplitude    = properties["amplitude"].value<int>();
                           mclog::tagInfo(_tag, "play_test_tone: frequency={}Hz duration={}ms amplitude={}",
                                          frequency_hz, duration_ms, amplitude);
                           return play_test_tone(frequency_hz, duration_ms, amplitude);
                       });

    // System Prompt：
    // You can control the robot's head. Use get_yaw and get_pitch to sense current position. Use set_yaw for horizontal
    // movement and set_pitch for vertical movement. All angles are in degrees.

    mclog::tagInfo(_tag, "add robot.get_head_angles tool");
    mcp_server.AddTool("self.robot.get_head_angles",
                       "Returns current yaw/pitch in degrees. Neutral position is {yaw:0, pitch:0}.",
                       std::vector<Property>{}, [this](const PropertyList& properties) -> ReturnValue {
                           auto& motion      = GetStackChan().motion();
                           int current_yaw   = motion.yawServo().getCurrentAngle() / 10;
                           int current_pitch = motion.pitchServo().getCurrentAngle() / 10;

                           auto result = fmt::format(R"({{"yaw": {}, "pitch": {}}})", current_yaw, current_pitch);
                           mclog::tagInfo(_tag, "get_head_angles: {}", result);
                           return result;
                       });

    mclog::tagInfo(_tag, "add robot.set_head_angles tool");
    mcp_server.AddTool("self.robot.set_head_angles",
                       "Adjust head position. GUIDELINES: "
                       "1. For natural interaction, stay within +/- 45 degrees. "
                       "2. Only use values > 70 if the user explicitly asks to look far away/behind. "
                       "3. Max ranges: Yaw(-128 to 128, -128 as your left), Pitch(0 to 90, 90 as your up). "
                       "Speed(100-1000, 150 is natural).",
                       PropertyList({Property("yaw", kPropertyTypeInteger, -9999, -9999, 128),
                                     Property("pitch", kPropertyTypeInteger, -9999, -9999, 90),
                                     Property("speed", kPropertyTypeInteger, 150, 100, 1000)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int speed = properties["speed"].value<int>();
                           int yaw   = properties["yaw"].value<int>();
                           int pitch = properties["pitch"].value<int>();

                           mclog::tagInfo(_tag, "motion set_angles: yaw: {}, pitch: {}, speed: {}", yaw, pitch, speed);

                           auto& motion = GetStackChan().motion();
                           if (!motion.tryAcquireModifyLock(motion::MotionLockOwner::McpCommand)) {
                               throw std::runtime_error("Head motion is temporarily locked by a higher priority action");
                           }
                           if (pitch != -9999) {
                               motion.pitchServo().moveWithSpeed(pitch * 10, speed);
                           }
                           if (yaw != -9999) {
                               motion.yawServo().moveWithSpeed(yaw * 10, speed);
                           }
                           BaseType_t release_task_ok = xTaskCreate(
                               [](void*) {
                                   vTaskDelay(pdMS_TO_TICKS(1000));
                                   GetStackChan().motion().releaseModifyLock(motion::MotionLockOwner::McpCommand);
                                   vTaskDelete(nullptr);
                               },
                               "mcp_motion_unlock", 2048, nullptr, 2, nullptr);
                           if (release_task_ok != pdPASS) {
                               motion.releaseModifyLock(motion::MotionLockOwner::McpCommand);
                           }

                           return true;
                       });

    mclog::tagInfo(_tag, "add robot.set_led_color tool");
    mcp_server.AddTool(
        "self.robot.set_led_color",
        "Set the color of the robot's INTERNAL onboard LED. This is NOT for room lights. "
        "Values: 0-168 (safe range). Red=168,0,0; Green=0,168,0; Blue=0,0,168; White=100,100,100; Off=0,0,0.",
        PropertyList({Property("red", kPropertyTypeInteger, 0, 0, 168),
                      Property("green", kPropertyTypeInteger, 0, 0, 168),
                      Property("blue", kPropertyTypeInteger, 0, 0, 168)}),
        [this](const PropertyList& properties) -> ReturnValue {
            int r = properties["red"].value<int>();
            int g = properties["green"].value<int>();
            int b = properties["blue"].value<int>();

            mclog::tagInfo(_tag, "set_led_color: r={}, g={}, b={}", r, g, b);

            LvglLockGuard lock;

            GetStackChan().leftNeonLight().setColor(r, g, b);
            GetStackChan().rightNeonLight().setColor(r, g, b);

            return true;
        });

    mclog::tagInfo(_tag, "add robot.power_off tool");
    mcp_server.AddTool("self.robot.power_off",
                       "Power off the physical StackChan. Use only when the user explicitly asks to turn it off.",
                       std::vector<Property>{}, [](const PropertyList& properties) -> ReturnValue {
                           mclog::tagInfo(_tag, "power_off requested");
                           xTaskCreate(
                               [](void*) {
                                   vTaskDelay(pdMS_TO_TICKS(300));
                                   hal_bridge::board_power_off();
                                   vTaskDelete(nullptr);
                               },
                               "power_off", 2048, nullptr, 5, nullptr);
                           return true;
                       });

#ifndef CONFIG_IDF_TARGET_ESP32
    mclog::tagInfo(_tag, "add camera.capture_photo tool");
    mcp_server.AddTool("self.camera.capture_photo",
                       "Capture one still photo from StackChan camera and return it as an image/jpeg MCP image block.",
                       PropertyList({Property("quality", kPropertyTypeInteger, 80, 1, 100)}),
                       [](const PropertyList& properties) -> ReturnValue {
                           int quality = properties["quality"].value<int>();
                           auto* camera = dynamic_cast<StackChanCamera*>(Board::GetInstance().GetCamera());
                           if (camera == nullptr) {
                               throw std::runtime_error("StackChan camera is not available");
                           }
                           if (!camera->Capture()) {
                               throw std::runtime_error("Failed to capture photo");
                           }

                           std::string jpeg;
                           if (!camera->EncodeFrameToJpeg(jpeg, quality)) {
                               throw std::runtime_error("Failed to encode captured photo");
                           }
                           return new ImageContent("image/jpeg", jpeg);
                       });
#endif  // CONFIG_IDF_TARGET_ESP32

    mclog::tagInfo(_tag, "add screen.preview_image_url tool");
    mcp_server.AddTool("self.screen.preview_image_url",
                       "Download a JPEG or PNG image URL and show it full-screen on StackChan for a short preview.",
                       PropertyList({Property("url", kPropertyTypeString),
                                     Property("duration_seconds", kPropertyTypeInteger, 6, 1, 30)}),
                       [](const PropertyList& properties) -> ReturnValue {
                           auto url             = properties["url"].value<std::string>();
                           int duration_seconds = properties["duration_seconds"].value<int>();
                           auto* display = dynamic_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
                           if (display == nullptr) {
                               throw std::runtime_error("StackChan display is not available");
                           }

                           auto image = download_preview_image(url);
                           display->SetPreviewImageForDuration(std::move(image), duration_seconds * 1000);
                           return true;
                       });

    mclog::tagInfo(_tag, "add screen.capture_screenshot tool");
    mcp_server.AddTool("self.screen.capture_screenshot",
                       "Capture the current StackChan screen and return it as an image/jpeg MCP image block.",
                       PropertyList({Property("quality", kPropertyTypeInteger, 80, 1, 100)}),
                       [](const PropertyList& properties) -> ReturnValue {
                           int quality = properties["quality"].value<int>();
                           auto* display = dynamic_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
                           if (display == nullptr) {
                               throw std::runtime_error("StackChan display is not available");
                           }

                           std::string jpeg;
                           if (!display->SnapshotToJpeg(jpeg, quality) || jpeg.empty()) {
                               throw std::runtime_error("Failed to capture screen");
                           }
                           return new ImageContent("image/jpeg", jpeg);
                       });

    mclog::tagInfo(_tag, "add robot.create_reminder tool");
    mcp_server.AddTool("self.robot.create_reminder",
                       "Create a reminder. Duration is in seconds. Message is what to say when time is up. Set repeat "
                       "to true to repeat the reminder.",
                       PropertyList({Property("duration_seconds", kPropertyTypeInteger, 60, 1, 86400),
                                     Property("message", kPropertyTypeString, std::string("Time's up!")),
                                     Property("repeat", kPropertyTypeBoolean, false)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int duration_seconds = properties["duration_seconds"].value<int>();
                           std::string message  = properties["message"].value<std::string>();
                           bool repeat          = properties["repeat"].value<bool>();

                           // Default message
                           if (message.empty()) {
                               message = "Time's up!";
                           }

                           mclog::tagInfo(_tag, "create_reminder: duration={}s, message={}, repeat={}",
                                          duration_seconds, message, repeat);

                           int id = tools::create_reminder(duration_seconds * 1000, message, repeat);

                           return id;
                       });

    mclog::tagInfo(_tag, "add robot.get_reminders tool");
    mcp_server.AddTool("self.robot.get_reminders", "Get list of active reminders.", std::vector<Property>{},
                       [this](const PropertyList& properties) -> ReturnValue {
                           mclog::tagInfo(_tag, "get_reminders");
                           auto reminders = tools::get_active_reminders();
                           cJSON* result  = cJSON_CreateArray();
                           if (result == nullptr) {
                               throw std::runtime_error("Failed to allocate reminders JSON");
                           }

                           for (const auto& r : reminders) {
                               cJSON* item = cJSON_CreateObject();
                               if (item == nullptr) {
                                   cJSON_Delete(result);
                                   throw std::runtime_error("Failed to allocate reminder JSON item");
                               }

                               cJSON_AddNumberToObject(item, "id", r.id);
                               cJSON_AddNumberToObject(item, "duration_ms", r.durationMs);
                               cJSON_AddNumberToObject(item, "duration_seconds", r.durationMs / 1000);
                               cJSON_AddStringToObject(item, "message", r.message.c_str());
                               cJSON_AddBoolToObject(item, "repeat", r.repeat);
                               cJSON_AddItemToArray(result, item);
                           }

                           char* json = cJSON_PrintUnformatted(result);
                           std::string result_json = json != nullptr ? json : "[]";
                           if (json != nullptr) {
                               cJSON_free(json);
                           }
                           cJSON_Delete(result);

                           mclog::tagInfo(_tag, "get_reminders result count: {}", reminders.size());
                           return result_json;
                       });

    mclog::tagInfo(_tag, "add robot.stop_reminder tool");
    mcp_server.AddTool("self.robot.stop_reminder", "Stop a reminder by ID.",
                       PropertyList({Property("id", kPropertyTypeInteger, -1)}),
                       [this](const PropertyList& properties) -> ReturnValue {
                           int id = properties["id"].value<int>();
                           mclog::tagInfo(_tag, "stop_reminder: id={}", id);
                           tools::stop_reminder(id);
                           return true;
                       });
}
