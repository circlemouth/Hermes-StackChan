#pragma once

#include "avatar_scene.h"

#include <cstdint>
#include <string>
#include <vector>

struct ScenarioAssertion {
    std::string type;
    std::string target;
    int min_pixels = -1;
    int max_pixels = -1;
    int x_min = 0;
    int y_min = 0;
    int x_max = 319;
    int y_max = 239;
};

struct ScenarioEvent {
    std::uint32_t t = 0;
    std::string emotion;
    std::string status;
    std::string chat_role;
    std::string chat_text;
    std::string notification_text;
    std::string app_ready_state;
    std::uint32_t preview_duration_ms = 0;
    std::uint32_t notification_duration_ms = 0;
    bool clear_chat = false;
    bool has_chat = false;
    bool reset_scene = false;
    bool fake_launcher_screen = false;
    bool launch_hermes_app = false;
    bool preview_image = false;
    bool clear_preview = false;
    bool notification = false;
    bool clear_notification = false;
    std::vector<ScenarioAssertion> assertions;
};

class ScenarioRunner {
public:
    bool load(const std::string& path, std::string& error);
    void update(std::uint32_t elapsed_ms, AvatarScene& scene);
    bool verifyDueAssertions(std::uint32_t elapsed_ms, const std::vector<std::uint8_t>& framebuffer, int width,
                             int height, std::string& error);
    std::uint32_t endTimeMs() const;
    bool empty() const;

private:
    std::vector<ScenarioEvent> events_;
    std::size_t next_event_ = 0;
    std::size_t next_assertion_event_ = 0;
};
