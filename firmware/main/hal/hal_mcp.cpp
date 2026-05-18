/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include <algorithm>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <board.h>
#include <esp_heap_caps.h>
#include <jpg/jpeg_to_image.h>
#include <mooncake_log.h>
#include <mcp_server.h>
#include <stackchan/stackchan.h>
#include <apps/common/common.h>
#include "board/stackchan_camera.h"
#include "board/stackchan_display.h"

using namespace stackchan;

static const std::string_view _tag = "HAL-MCP";

namespace {
constexpr size_t kMaxPreviewImageBytes = 2 * 1024 * 1024;

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
}  // namespace

void Hal::robot_mcp_init()
{
    mclog::tagInfo(_tag, "init");

    // Firmware-side robot MCP tools used by the Hermes bridge.
    auto& mcp_server = McpServer::GetInstance();

    // System Prompt：
    // You can control the robot's head. Use get_yaw and get_pitch to sense current position. Use set_yaw for horizontal
    // movement and set_pitch for vertical movement. All angles are in degrees.

    mclog::tagInfo(_tag, "add robot.get_head_angles tool");
    mcp_server.AddTool("self.robot.get_head_angles",
                       "Returns current yaw/pitch in degrees. Neutral position is {yaw:0, pitch:0}.",
                       std::vector<Property>{}, [this](const PropertyList& properties) -> ReturnValue {
                           LvglLockGuard lock;  // StackChan motion update is under the lvgl lock

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

                           LvglLockGuard lock;

                           auto& motion = GetStackChan().motion();
                           if (pitch != -9999) {
                               motion.pitchServo().moveWithSpeed(pitch * 10, speed);
                           }
                           if (yaw != -9999) {
                               motion.yawServo().moveWithSpeed(yaw * 10, speed);
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

#ifndef CONFIG_IDF_TARGET_ESP32
    mclog::tagInfo(_tag, "add camera.capture_photo tool");
    mcp_server.AddTool("self.camera.capture_photo",
                       "Capture one still photo from StackChan camera and return it as an image/jpeg MCP image block.",
                       PropertyList({Property("quality", kPropertyTypeInteger, 80, 1, 100)}),
                       [](const PropertyList& properties) -> ReturnValue {
                           int quality = properties["quality"].value<int>();
                           auto* camera =
                               dynamic_cast<StackChanCamera*>(Board::GetInstance().GetCamera());
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
                           auto* display =
                               dynamic_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay());
                           if (display == nullptr) {
                               throw std::runtime_error("StackChan display is not available");
                           }

                           auto image = download_preview_image(url);
                           display->SetPreviewImageForDuration(std::move(image), duration_seconds * 1000);
                           return true;
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
                           auto reminders          = tools::get_active_reminders();
                           std::string result_json = "[";
                           for (size_t i = 0; i < reminders.size(); ++i) {
                               const auto& r = reminders[i];
                               result_json +=
                                   fmt::format(R"({{"id": {}, "duration_ms": {}, "message": "{}", "repeat": {}}})",
                                               r.id, r.durationMs, r.message, r.repeat ? "true" : "false");
                               if (i < reminders.size() - 1) {
                                   result_json += ", ";
                               }
                           }
                           result_json += "]";
                           mclog::tagInfo(_tag, "get_reminders result: {}", result_json);
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
