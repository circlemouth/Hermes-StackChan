#include "scenario_runner.h"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include <ArduinoJson.h>
#include <lvgl.h>

namespace {

constexpr int kDefaultPreviewDurationMs = 1000;
constexpr int kDefaultNotificationDurationMs = 1000;

bool color_close(std::uint8_t r, std::uint8_t g, std::uint8_t b, int tr, int tg, int tb, int tolerance = 10)
{
    return std::abs(static_cast<int>(r) - tr) <= tolerance && std::abs(static_cast<int>(g) - tg) <= tolerance &&
           std::abs(static_cast<int>(b) - tb) <= tolerance;
}

bool color_close_rgb_or_bgr(std::uint8_t r, std::uint8_t g, std::uint8_t b, int tr, int tg, int tb,
                            int tolerance = 10)
{
    return color_close(r, g, b, tr, tg, tb, tolerance) || color_close(r, g, b, tb, tg, tr, tolerance);
}

int count_non_black(const std::vector<std::uint8_t>& framebuffer)
{
    int count = 0;
    for (std::size_t i = 0; i + 2 < framebuffer.size(); i += 3) {
        if (framebuffer[i] != 0 || framebuffer[i + 1] != 0 || framebuffer[i + 2] != 0) {
            count++;
        }
    }
    return count;
}

int count_preview_pixels(const std::vector<std::uint8_t>& framebuffer)
{
    int count = 0;
    for (std::size_t i = 0; i + 2 < framebuffer.size(); i += 3) {
        const auto r = framebuffer[i];
        const auto g = framebuffer[i + 1];
        const auto b = framebuffer[i + 2];
        if (color_close_rgb_or_bgr(r, g, b, 0xFF, 0x33, 0x55, 24) ||
            color_close_rgb_or_bgr(r, g, b, 0x33, 0xD1, 0x7A, 24) ||
            color_close_rgb_or_bgr(r, g, b, 0x35, 0x84, 0xE4, 24) ||
            color_close_rgb_or_bgr(r, g, b, 0xF6, 0xD3, 0x2D, 24) ||
            color_close_rgb_or_bgr(r, g, b, 0x7A, 0x1F, 0xFF, 24)) {
            count++;
        }
    }
    return count;
}

int count_notification_pixels(const std::vector<std::uint8_t>& framebuffer)
{
    int count = 0;
    for (std::size_t i = 0; i + 2 < framebuffer.size(); i += 3) {
        if (color_close_rgb_or_bgr(framebuffer[i], framebuffer[i + 1], framebuffer[i + 2], 0x2B, 0x2D, 0x42, 16) ||
            color_close_rgb_or_bgr(framebuffer[i], framebuffer[i + 1], framebuffer[i + 2], 0xFF, 0xD1, 0x66, 24)) {
            count++;
        }
    }
    return count;
}

int count_launcher_fragment_pixels(const std::vector<std::uint8_t>& framebuffer)
{
    int count = 0;
    for (std::size_t i = 0; i + 2 < framebuffer.size(); i += 3) {
        if (color_close_rgb_or_bgr(framebuffer[i], framebuffer[i + 1], framebuffer[i + 2], 0x20, 0x24, 0x2A, 8) ||
            color_close_rgb_or_bgr(framebuffer[i], framebuffer[i + 1], framebuffer[i + 2], 0x4F, 0x8C, 0xFF, 16)) {
            count++;
        }
    }
    return count;
}

int count_bottom_white_pixels(const std::vector<std::uint8_t>& framebuffer, int width, int height)
{
    int count = 0;
    const int start_y = height * 3 / 4;
    for (int y = start_y; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const std::size_t i = static_cast<std::size_t>((y * width + x) * 3);
            if (i + 2 < framebuffer.size() && framebuffer[i] > 220 && framebuffer[i + 1] > 220 &&
                framebuffer[i + 2] > 220) {
                count++;
            }
        }
    }
    return count;
}

int count_face_pixels(const std::vector<std::uint8_t>& framebuffer, int width, int height)
{
    int count = 0;
    const int x_start = std::max(0, width / 6);
    const int x_end = std::min(width, width * 5 / 6);
    const int y_start = std::max(0, height / 4);
    const int y_end = std::min(height, height * 3 / 4);
    for (int y = y_start; y < y_end; ++y) {
        for (int x = x_start; x < x_end; ++x) {
            const std::size_t i = static_cast<std::size_t>((y * width + x) * 3);
            if (i + 2 < framebuffer.size() && framebuffer[i] > 220 && framebuffer[i + 1] > 220 &&
                framebuffer[i + 2] > 220) {
                count++;
            }
        }
    }
    return count;
}

bool bbox_for_target(const std::vector<std::uint8_t>& framebuffer, int width, int height, const std::string& target,
                     int& x_min, int& y_min, int& x_max, int& y_max, int& pixels)
{
    x_min = width;
    y_min = height;
    x_max = -1;
    y_max = -1;
    pixels = 0;

    auto matches = [&target](std::uint8_t r, std::uint8_t g, std::uint8_t b) {
        if (target == "preview") {
            return color_close_rgb_or_bgr(r, g, b, 0xFF, 0x33, 0x55, 24) ||
                   color_close_rgb_or_bgr(r, g, b, 0x33, 0xD1, 0x7A, 24) ||
                   color_close_rgb_or_bgr(r, g, b, 0x35, 0x84, 0xE4, 24) ||
                   color_close_rgb_or_bgr(r, g, b, 0xF6, 0xD3, 0x2D, 24) ||
                   color_close_rgb_or_bgr(r, g, b, 0x7A, 0x1F, 0xFF, 24);
        }
        if (target == "notification") {
            return color_close_rgb_or_bgr(r, g, b, 0x2B, 0x2D, 0x42, 16) ||
                   color_close_rgb_or_bgr(r, g, b, 0xFF, 0xD1, 0x66, 24);
        }
        if (target == "status_dot") {
            return color_close_rgb_or_bgr(r, g, b, 0x66, 0x66, 0x66, 16) ||
                   color_close_rgb_or_bgr(r, g, b, 0x35, 0xD0, 0x7F, 24) ||
                   color_close_rgb_or_bgr(r, g, b, 0x3D, 0x8B, 0xFF, 24);
        }
        if (target == "launcher_fragment") {
            return color_close_rgb_or_bgr(r, g, b, 0x20, 0x24, 0x2A, 8) ||
                   color_close_rgb_or_bgr(r, g, b, 0x4F, 0x8C, 0xFF, 16);
        }
        if (target == "white" || target == "bubble") {
            return r > 220 && g > 220 && b > 220;
        }
        if (target == "face") {
            return r > 220 && g > 220 && b > 220;
        }
        return r != 0 || g != 0 || b != 0;
    };

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            if (target == "face" && (x < width / 6 || x >= width * 5 / 6 || y < height / 4 || y >= height * 3 / 4)) {
                continue;
            }
            const std::size_t i = static_cast<std::size_t>((y * width + x) * 3);
            if (i + 2 >= framebuffer.size()) {
                continue;
            }
            if (matches(framebuffer[i], framebuffer[i + 1], framebuffer[i + 2])) {
                x_min = std::min(x_min, x);
                y_min = std::min(y_min, y);
                x_max = std::max(x_max, x);
                y_max = std::max(y_max, y);
                pixels++;
            }
        }
    }

    return pixels > 0;
}

void parse_assertion(JsonVariant value, std::vector<ScenarioAssertion>& assertions)
{
    if (value.is<const char*>()) {
        ScenarioAssertion assertion;
        assertion.type = value.as<const char*>();
        assertions.push_back(std::move(assertion));
        return;
    }

    if (!value.is<JsonObject>()) {
        return;
    }

    JsonObject obj = value.as<JsonObject>();
    ScenarioAssertion assertion;
    assertion.type = obj["type"] | "";
    assertion.target = obj["target"] | "";
    assertion.min_pixels = obj["min_pixels"] | -1;
    assertion.max_pixels = obj["max_pixels"] | -1;
    assertion.x_min = obj["x_min"] | 0;
    assertion.y_min = obj["y_min"] | 0;
    assertion.x_max = obj["x_max"] | 319;
    assertion.y_max = obj["y_max"] | 239;
    if (!assertion.type.empty()) {
        assertions.push_back(std::move(assertion));
    }
}

}  // namespace

bool ScenarioRunner::load(const std::string& path, std::string& error)
{
    std::ifstream input(path);
    if (!input) {
        error = "failed to open scenario: " + path;
        return false;
    }

    std::stringstream buffer;
    buffer << input.rdbuf();

    JsonDocument doc;
    auto result = deserializeJson(doc, buffer.str());
    if (result) {
        error = std::string("failed to parse scenario JSON: ") + result.c_str();
        return false;
    }

    if (!doc.is<JsonArray>()) {
        error = "scenario root must be a JSON array";
        return false;
    }

    events_.clear();
    for (JsonObject obj : doc.as<JsonArray>()) {
        ScenarioEvent event;
        event.t = obj["t"] | 0;

        if (obj["emotion"].is<const char*>()) {
            event.emotion = obj["emotion"].as<const char*>();
        }
        if (obj["status"].is<const char*>()) {
            event.status = obj["status"].as<const char*>();
        }
        if (obj["clear_chat"] | false) {
            event.clear_chat = true;
        }
        if (obj["reset_scene"] | false) {
            event.reset_scene = true;
        }
        if (obj["fake_launcher_screen"] | false) {
            event.fake_launcher_screen = true;
        }
        if (obj["launch_hermes_app"] | false) {
            event.launch_hermes_app = true;
        }
        if (obj["preview_image"].is<JsonObject>()) {
            JsonObject preview = obj["preview_image"].as<JsonObject>();
            event.preview_image = true;
            event.preview_duration_ms = preview["duration_ms"] | kDefaultPreviewDurationMs;
        } else if (obj["preview_image"] | false) {
            event.preview_image = true;
            event.preview_duration_ms = kDefaultPreviewDurationMs;
        }
        if (obj["clear_preview"] | false) {
            event.clear_preview = true;
        }
        if (obj["notification"].is<JsonObject>()) {
            JsonObject notification = obj["notification"].as<JsonObject>();
            event.notification = true;
            event.notification_text = notification["text"] | "";
            event.notification_duration_ms = notification["duration_ms"] | kDefaultNotificationDurationMs;
        }
        if (obj["clear_notification"] | false) {
            event.clear_notification = true;
        }
        if (obj["app_ready_state"].is<const char*>()) {
            event.app_ready_state = obj["app_ready_state"].as<const char*>();
        }
        if (obj["chat"].is<JsonObject>()) {
            JsonObject chat = obj["chat"].as<JsonObject>();
            event.chat_role = chat["role"] | "assistant";
            event.chat_text = chat["text"] | "";
            event.has_chat = true;
        }
        if (obj["assert"].is<JsonArray>()) {
            for (JsonVariant assertion : obj["assert"].as<JsonArray>()) {
                parse_assertion(assertion, event.assertions);
            }
        } else if (!obj["assert"].isNull()) {
            parse_assertion(obj["assert"], event.assertions);
        }

        events_.push_back(std::move(event));
    }

    std::sort(events_.begin(), events_.end(), [](const ScenarioEvent& a, const ScenarioEvent& b) {
        return a.t < b.t;
    });
    next_event_ = 0;
    next_assertion_event_ = 0;
    return true;
}

void ScenarioRunner::update(std::uint32_t elapsed_ms, AvatarScene& scene)
{
    while (next_event_ < events_.size() && events_[next_event_].t <= elapsed_ms) {
        const auto& event = events_[next_event_];
        if (event.fake_launcher_screen) {
            scene.showFakeLauncherScreen();
        }
        if (event.launch_hermes_app) {
            scene.launchHermesApp();
        }
        if (!event.app_ready_state.empty()) {
            scene.showAppReadyState(event.app_ready_state.c_str());
        }
        if (event.reset_scene) {
            scene.setup(lv_screen_active(), lv_display_get_default());
        }
        if (!event.emotion.empty()) {
            scene.setEmotion(event.emotion.c_str());
        }
        if (!event.status.empty()) {
            scene.setStatus(event.status.c_str());
        }
        if (event.clear_chat) {
            scene.clearChatMessages();
        }
        if (event.has_chat) {
            const char* role = event.chat_role.empty() ? "assistant" : event.chat_role.c_str();
            scene.setChatMessage(role, event.chat_text.c_str());
        }
        if (event.clear_preview) {
            scene.clearPreviewImage();
        }
        if (event.preview_image) {
            scene.showPreviewImage(event.preview_duration_ms);
        }
        if (event.clear_notification) {
            scene.clearNotification();
        }
        if (event.notification) {
            scene.showNotification(event.notification_text.c_str(), event.notification_duration_ms);
        }
        next_event_++;
    }
}

bool ScenarioRunner::verifyDueAssertions(std::uint32_t elapsed_ms, const std::vector<std::uint8_t>& framebuffer,
                                         int width, int height, std::string& error)
{
    while (next_assertion_event_ < events_.size() && events_[next_assertion_event_].t <= elapsed_ms) {
        const auto& event = events_[next_assertion_event_];
        for (const auto& assertion : event.assertions) {
            if (assertion.type == "non_black") {
                const int min_pixels = assertion.min_pixels >= 0 ? assertion.min_pixels : 500;
                const int pixels = count_non_black(framebuffer);
                if (pixels < min_pixels) {
                    error = "assertion non_black failed at t=" + std::to_string(event.t) +
                            ": pixels=" + std::to_string(pixels);
                    return false;
                }
            } else if (assertion.type == "no_text_fragment" || assertion.type == "no_launcher_fragment") {
                const int max_pixels = assertion.max_pixels >= 0 ? assertion.max_pixels : 0;
                const int pixels = count_launcher_fragment_pixels(framebuffer);
                if (pixels > max_pixels) {
                    error = "assertion " + assertion.type + " failed at t=" + std::to_string(event.t) +
                            ": pixels=" + std::to_string(pixels);
                    return false;
                }
            } else if (assertion.type == "bubble_hidden") {
                const int max_pixels = assertion.max_pixels >= 0 ? assertion.max_pixels : 80;
                const int pixels = count_bottom_white_pixels(framebuffer, width, height);
                if (pixels > max_pixels) {
                    error = "assertion bubble_hidden failed at t=" + std::to_string(event.t) +
                            ": bottom white pixels=" + std::to_string(pixels);
                    return false;
                }
            } else if (assertion.type == "face_visible") {
                const int min_pixels = assertion.min_pixels >= 0 ? assertion.min_pixels : 500;
                const int pixels = count_face_pixels(framebuffer, width, height);
                if (pixels < min_pixels) {
                    error = "assertion face_visible failed at t=" + std::to_string(event.t) +
                            ": pixels=" + std::to_string(pixels);
                    return false;
                }
            } else if (assertion.type == "preview_visible" || assertion.type == "preview_hidden") {
                const int pixels = count_preview_pixels(framebuffer);
                if (assertion.type == "preview_visible") {
                    const int min_pixels = assertion.min_pixels >= 0 ? assertion.min_pixels : 10000;
                    if (pixels < min_pixels) {
                        error = "assertion preview_visible failed at t=" + std::to_string(event.t) +
                                ": pixels=" + std::to_string(pixels);
                        return false;
                    }
                } else {
                    const int max_pixels = assertion.max_pixels >= 0 ? assertion.max_pixels : 120;
                    if (pixels > max_pixels) {
                        error = "assertion preview_hidden failed at t=" + std::to_string(event.t) +
                                ": pixels=" + std::to_string(pixels);
                        return false;
                    }
                }
            } else if (assertion.type == "notification_visible" || assertion.type == "notification_hidden") {
                const int pixels = count_notification_pixels(framebuffer);
                if (assertion.type == "notification_visible") {
                    const int min_pixels = assertion.min_pixels >= 0 ? assertion.min_pixels : 800;
                    if (pixels < min_pixels) {
                        error = "assertion notification_visible failed at t=" + std::to_string(event.t) +
                                ": pixels=" + std::to_string(pixels);
                        return false;
                    }
                } else {
                    const int max_pixels = assertion.max_pixels >= 0 ? assertion.max_pixels : 20;
                    if (pixels > max_pixels) {
                        error = "assertion notification_hidden failed at t=" + std::to_string(event.t) +
                                ": pixels=" + std::to_string(pixels);
                        return false;
                    }
                }
            } else if (assertion.type == "bbox_within") {
                const std::string target = assertion.target.empty() ? "non_black" : assertion.target;
                int x_min = 0;
                int y_min = 0;
                int x_max = 0;
                int y_max = 0;
                int pixels = 0;
                if (!bbox_for_target(framebuffer, width, height, target, x_min, y_min, x_max, y_max, pixels)) {
                    error = "assertion bbox_within failed at t=" + std::to_string(event.t) + ": target has no pixels";
                    return false;
                }
                if (x_min < assertion.x_min || y_min < assertion.y_min || x_max > assertion.x_max ||
                    y_max > assertion.y_max) {
                    error = "assertion bbox_within failed at t=" + std::to_string(event.t) + ": target=" + target +
                            " bbox=(" + std::to_string(x_min) + "," + std::to_string(y_min) + ")-(" +
                            std::to_string(x_max) + "," + std::to_string(y_max) + ")";
                    return false;
                }
            } else {
                error = "unknown assertion type at t=" + std::to_string(event.t) + ": " + assertion.type;
                return false;
            }
        }
        next_assertion_event_++;
    }

    return true;
}

std::uint32_t ScenarioRunner::endTimeMs() const
{
    std::uint32_t end_time = 0;
    for (const auto& event : events_) {
        end_time = std::max(end_time, event.t);
    }
    return end_time;
}

bool ScenarioRunner::empty() const
{
    return events_.empty();
}
