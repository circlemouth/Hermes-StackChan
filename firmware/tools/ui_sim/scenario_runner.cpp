#include "scenario_runner.h"

#include <algorithm>
#include <fstream>
#include <sstream>

#include <ArduinoJson.h>
#include <lvgl.h>

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
        if (obj["chat"].is<JsonObject>()) {
            JsonObject chat = obj["chat"].as<JsonObject>();
            event.chat_role = chat["role"] | "assistant";
            event.chat_text = chat["text"] | "";
            event.has_chat = true;
        }

        events_.push_back(std::move(event));
    }

    std::sort(events_.begin(), events_.end(), [](const ScenarioEvent& a, const ScenarioEvent& b) {
        return a.t < b.t;
    });
    next_event_ = 0;
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
        next_event_++;
    }
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
