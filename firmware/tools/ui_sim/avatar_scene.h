#pragma once

#include <lvgl.h>
#include <memory>
#include <string>

#include <stackchan/stackchan.h>
#include <stackchan/avatar/skins/default/default.h>

class AvatarScene {
public:
    bool setup(lv_obj_t* root, lv_display_t* display = nullptr);
    bool launchHermesApp();
    void update();

    void showFakeLauncherScreen();
    void showAppReadyState(const char* state);
    void showPreviewImage(std::uint32_t duration_ms);
    void clearPreviewImage();
    void showNotification(const char* text, std::uint32_t duration_ms);
    void clearNotification();
    void setEmotion(const char* emotion);
    void setChatMessage(const char* role, const char* content);
    void clearChatMessages();
    void setStatus(const char* status);

private:
    stackchan::avatar::Emotion parseEmotion(const char* emotion) const;
    void setSpeaking(bool speaking);
    void resetOverlayPointers();

    lv_display_t* display_ = nullptr;
    lv_obj_t* root_        = nullptr;
    lv_obj_t* status_dot_  = nullptr;
    lv_obj_t* preview_overlay_ = nullptr;
    lv_obj_t* notification_    = nullptr;
    lv_obj_t* notification_text_ = nullptr;

    int breath_modifier_id_ = -1;
    int blink_modifier_id_  = -1;

    bool speaking_                = false;
    bool mouth_open_              = false;
    std::uint32_t next_mouth_ms_  = 0;
    std::uint32_t preview_hide_ms_ = 0;
    std::uint32_t notification_hide_ms_ = 0;
    std::string current_status_   = "standby";
};
