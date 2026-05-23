#pragma once

#include "avatar_scene.h"

#include <cstdint>
#include <string>
#include <vector>

struct ScenarioEvent {
    std::uint32_t t = 0;
    std::string emotion;
    std::string status;
    std::string chat_role;
    std::string chat_text;
    bool clear_chat = false;
    bool has_chat = false;
    bool reset_scene = false;
    bool fake_launcher_screen = false;
    bool launch_hermes_app = false;
};

class ScenarioRunner {
public:
    bool load(const std::string& path, std::string& error);
    void update(std::uint32_t elapsed_ms, AvatarScene& scene);
    std::uint32_t endTimeMs() const;
    bool empty() const;

private:
    std::vector<ScenarioEvent> events_;
    std::size_t next_event_ = 0;
};
