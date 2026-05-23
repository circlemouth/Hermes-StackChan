#include "avatar_scene.h"

#include <cstring>

#include <stackchan/modifiers/blink.h>
#include <stackchan/modifiers/breath.h>

using namespace stackchan;
using namespace stackchan::avatar;

bool AvatarScene::setup(lv_obj_t* root, lv_display_t* display)
{
    if (root == nullptr) {
        return false;
    }

    display_ = display;
    root_    = root;
    resetOverlayPointers();

    lv_obj_clean(root_);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(root_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(root_, lv_color_black(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, LV_PART_MAIN);

    auto& stackchan = GetStackChan();
    stackchan.resetAvatar();
    stackchan.clearModifiers();

    auto avatar = std::make_unique<DefaultAvatar>();
    avatar->init(root_);
    lv_obj_move_foreground(avatar->getPanel()->get());

    stackchan.attachAvatar(std::move(avatar));
    breath_modifier_id_ = stackchan.addModifier(std::make_unique<BreathModifier>());
    blink_modifier_id_  = stackchan.addModifier(std::make_unique<BlinkModifier>());

    status_dot_ = lv_obj_create(root_);
    lv_obj_set_size(status_dot_, 10, 10);
    lv_obj_set_style_radius(status_dot_, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_border_width(status_dot_, 0, LV_PART_MAIN);
    lv_obj_align(status_dot_, LV_ALIGN_TOP_RIGHT, -8, 8);

    setStatus("standby");
    update();

    lv_obj_invalidate(root_);
    if (display_ != nullptr) {
        lv_refr_now(display_);
    }

    return true;
}

bool AvatarScene::launchHermesApp()
{
    if (display_ != nullptr) {
        lv_display_set_default(display_);
    }

    lv_obj_t* previous_screen = lv_screen_active();
    lv_obj_t* top_layer       = lv_layer_top();
    if (top_layer != nullptr) {
        lv_obj_clean(top_layer);
    }

    lv_obj_t* screen = lv_obj_create(nullptr);
    if (screen == nullptr) {
        return setup(previous_screen, display_);
    }

    lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(screen, lv_color_black(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
    lv_screen_load(screen);

    if (previous_screen != nullptr && previous_screen != screen) {
        lv_obj_delete_async(previous_screen);
    }

    return setup(screen, display_);
}

void AvatarScene::showFakeLauncherScreen()
{
    lv_obj_t* screen = lv_screen_active();
    if (screen == nullptr) {
        return;
    }

    auto& stackchan = GetStackChan();
    stackchan.resetAvatar();
    stackchan.clearModifiers();
    root_ = screen;
    resetOverlayPointers();

    lv_obj_clean(screen);
    lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x20242A), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);

    lv_obj_t* title = lv_label_create(screen);
    lv_label_set_text(title, "Launcher");
    lv_obj_set_style_text_color(title, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 10);

    lv_obj_t* icon = lv_obj_create(screen);
    lv_obj_set_size(icon, 48, 48);
    lv_obj_set_style_radius(icon, 8, LV_PART_MAIN);
    lv_obj_set_style_border_width(icon, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(icon, lv_color_hex(0x4F8CFF), LV_PART_MAIN);
    lv_obj_align(icon, LV_ALIGN_BOTTOM_MID, 0, -30);

    lv_obj_t* label = lv_label_create(screen);
    lv_label_set_text(label, "HERMES");
    lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(label, LV_ALIGN_BOTTOM_MID, 0, -6);

    if (display_ != nullptr) {
        lv_refr_now(display_);
    }
}

void AvatarScene::showAppReadyState(const char* state)
{
    lv_obj_t* screen = lv_screen_active();
    if (screen == nullptr || state == nullptr) {
        return;
    }

    if (std::strcmp(state, "ready") == 0) {
        launchHermesApp();
        return;
    }

    auto& stackchan = GetStackChan();
    stackchan.resetAvatar();
    stackchan.clearModifiers();
    root_ = screen;
    resetOverlayPointers();

    lv_obj_clean(screen);
    lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xEDF4FF), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);

    lv_obj_t* title = lv_label_create(screen);
    lv_label_set_text(title, "HERMES");
    lv_obj_set_style_text_color(title, lv_color_hex(0x7E7B9C), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 12);

    lv_obj_t* logo = lv_obj_create(screen);
    lv_obj_set_size(logo, 54, 54);
    lv_obj_set_style_radius(logo, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_border_width(logo, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(logo, lv_color_hex(0x33CC99), LV_PART_MAIN);
    lv_obj_align(logo, LV_ALIGN_TOP_MID, 0, 40);

    const char* status_text = "Connecting to Hermes bridge";
    if (std::strcmp(state, "missing_url") == 0) {
        status_text = "Bridge URL missing";
    } else if (std::strcmp(state, "wifi_missing") == 0) {
        status_text = "Wi-Fi not connected";
    }

    lv_obj_t* status = lv_label_create(screen);
    lv_label_set_text(status, status_text);
    lv_obj_set_width(status, 292);
    lv_label_set_long_mode(status, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(status, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_color(status, lv_color_hex(0x26206A), LV_PART_MAIN);
    lv_obj_align(status, LV_ALIGN_TOP_MID, 0, 118);

    lv_obj_t* device_id = lv_label_create(screen);
    lv_label_set_text(device_id, "Device ID: simulator");
    lv_obj_set_width(device_id, 292);
    lv_label_set_long_mode(device_id, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(device_id, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_color(device_id, lv_color_hex(0x525064), LV_PART_MAIN);
    lv_obj_align(device_id, LV_ALIGN_TOP_MID, 0, 158);

    if (display_ != nullptr) {
        lv_refr_now(display_);
    }
}

void AvatarScene::showPreviewImage(std::uint32_t duration_ms)
{
    if (root_ == nullptr) {
        return;
    }

    clearPreviewImage();

    preview_overlay_ = lv_obj_create(root_);
    lv_obj_set_size(preview_overlay_, 320, 240);
    lv_obj_align(preview_overlay_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_border_width(preview_overlay_, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(preview_overlay_, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(preview_overlay_, lv_color_hex(0x7A1FFF), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(preview_overlay_, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_remove_flag(preview_overlay_, LV_OBJ_FLAG_SCROLLABLE);

    const lv_color_t colors[] = {
        lv_color_hex(0xFF3355),
        lv_color_hex(0x33D17A),
        lv_color_hex(0x3584E4),
        lv_color_hex(0xF6D32D),
    };
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            lv_obj_t* tile = lv_obj_create(preview_overlay_);
            lv_obj_set_size(tile, 80, 60);
            lv_obj_set_pos(tile, x * 80, y * 60);
            lv_obj_set_style_border_width(tile, 0, LV_PART_MAIN);
            lv_obj_set_style_radius(tile, 0, LV_PART_MAIN);
            lv_obj_set_style_bg_color(tile, colors[(x + y) % 4], LV_PART_MAIN);
            lv_obj_remove_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
        }
    }

    lv_obj_t* label = lv_label_create(preview_overlay_);
    lv_label_set_text(label, "PREVIEW");
    lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_bg_color(label, lv_color_black(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(label, LV_OPA_70, LV_PART_MAIN);
    lv_obj_set_style_pad_all(label, 6, LV_PART_MAIN);
    lv_obj_align(label, LV_ALIGN_BOTTOM_MID, 0, -12);

    lv_obj_move_foreground(preview_overlay_);
    preview_hide_ms_ = duration_ms == 0 ? 0 : GetHAL().millis() + duration_ms;
}

void AvatarScene::clearPreviewImage()
{
    if (preview_overlay_ != nullptr) {
        lv_obj_delete(preview_overlay_);
        preview_overlay_ = nullptr;
    }
    preview_hide_ms_ = 0;
}

void AvatarScene::showNotification(const char* text, std::uint32_t duration_ms)
{
    if (root_ == nullptr) {
        return;
    }

    clearNotification();

    notification_ = lv_obj_create(root_);
    lv_obj_set_size(notification_, 292, 50);
    lv_obj_align(notification_, LV_ALIGN_TOP_MID, 0, 26);
    lv_obj_set_style_radius(notification_, 8, LV_PART_MAIN);
    lv_obj_set_style_border_width(notification_, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(notification_, lv_color_hex(0xFFD166), LV_PART_MAIN);
    lv_obj_set_style_bg_color(notification_, lv_color_hex(0x2B2D42), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(notification_, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_remove_flag(notification_, LV_OBJ_FLAG_SCROLLABLE);

    notification_text_ = lv_label_create(notification_);
    lv_label_set_text(notification_text_, text == nullptr ? "" : text);
    lv_obj_set_width(notification_text_, 260);
    lv_label_set_long_mode(notification_text_, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(notification_text_, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_color(notification_text_, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(notification_text_, LV_ALIGN_CENTER, 0, 0);

    lv_obj_move_foreground(notification_);
    notification_hide_ms_ = duration_ms == 0 ? 0 : GetHAL().millis() + duration_ms;
}

void AvatarScene::clearNotification()
{
    if (notification_ != nullptr) {
        lv_obj_delete(notification_);
        notification_ = nullptr;
        notification_text_ = nullptr;
    }
    notification_hide_ms_ = 0;
}

void AvatarScene::update()
{
    auto& stackchan = GetStackChan();

    std::uint32_t now = GetHAL().millis();
    if (preview_overlay_ != nullptr && preview_hide_ms_ > 0 && now >= preview_hide_ms_) {
        clearPreviewImage();
    }
    if (notification_ != nullptr && notification_hide_ms_ > 0 && now >= notification_hide_ms_) {
        clearNotification();
    }

    if (!stackchan.hasAvatar()) {
        return;
    }

    if (speaking_ && now >= next_mouth_ms_) {
        mouth_open_     = !mouth_open_;
        next_mouth_ms_  = now + 180;
        auto weight     = mouth_open_ ? 70 : 8;
        stackchan.avatar().mouth().setWeight(weight);
    }

    stackchan.update();
}

void AvatarScene::setEmotion(const char* emotion)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar() || emotion == nullptr) {
        return;
    }

    auto parsed = parseEmotion(emotion);
    stackchan.avatar().setEmotion(parsed);

    if (parsed == Emotion::Sleepy) {
        setSpeaking(false);
        stackchan.avatar().setSpeech("Zzz...");
    }

    auto blink = static_cast<BlinkModifier*>(stackchan.getModifier(blink_modifier_id_));
    if (blink != nullptr) {
        blink->resyncEyeWeights();
    }
}

void AvatarScene::resetOverlayPointers()
{
    status_dot_             = nullptr;
    preview_overlay_        = nullptr;
    notification_           = nullptr;
    notification_text_      = nullptr;
    preview_hide_ms_        = 0;
    notification_hide_ms_   = 0;
    speaking_               = false;
    mouth_open_             = false;
    next_mouth_ms_          = 0;
}

void AvatarScene::setChatMessage(const char* role, const char* content)
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar() || role == nullptr || content == nullptr) {
        return;
    }

    if (std::strcmp(role, "assistant") == 0 || std::strcmp(role, "system") == 0) {
        stackchan.avatar().setSpeech(content);
    }
}

void AvatarScene::clearChatMessages()
{
    auto& stackchan = GetStackChan();
    if (stackchan.hasAvatar()) {
        stackchan.avatar().clearSpeech();
    }
}

void AvatarScene::setStatus(const char* status)
{
    if (status == nullptr) {
        return;
    }

    current_status_ = status;

    if (std::strcmp(status, "speaking") == 0 || std::strcmp(status, "SPEAKING") == 0) {
        setSpeaking(true);
        if (status_dot_ != nullptr) {
            lv_obj_set_style_bg_color(status_dot_, lv_color_hex(0x35D07F), LV_PART_MAIN);
        }
    } else if (std::strcmp(status, "listening") == 0 || std::strcmp(status, "LISTENING") == 0) {
        setSpeaking(false);
        if (status_dot_ != nullptr) {
            lv_obj_set_style_bg_color(status_dot_, lv_color_hex(0x3D8BFF), LV_PART_MAIN);
        }
    } else if (std::strcmp(status, "standby") == 0 || std::strcmp(status, "STANDBY") == 0) {
        setSpeaking(false);
        if (status_dot_ != nullptr) {
            lv_obj_set_style_bg_color(status_dot_, lv_color_hex(0x666666), LV_PART_MAIN);
        }
    } else {
        setSpeaking(false);
        setChatMessage("system", status);
        if (status_dot_ != nullptr) {
            lv_obj_set_style_bg_color(status_dot_, lv_color_hex(0xF5C542), LV_PART_MAIN);
        }
    }
}

Emotion AvatarScene::parseEmotion(const char* emotion) const
{
    if (emotion == nullptr) {
        return Emotion::Neutral;
    }
    if (std::strcmp(emotion, "neutral") == 0) {
        return Emotion::Neutral;
    }
    if (std::strcmp(emotion, "happy") == 0 || std::strcmp(emotion, "laughing") == 0) {
        return Emotion::Happy;
    }
    if (std::strcmp(emotion, "angry") == 0) {
        return Emotion::Angry;
    }
    if (std::strcmp(emotion, "sad") == 0 || std::strcmp(emotion, "crying") == 0) {
        return Emotion::Sad;
    }
    if (std::strcmp(emotion, "sleepy") == 0) {
        return Emotion::Sleepy;
    }
    if (std::strcmp(emotion, "doubtful") == 0) {
        return Emotion::Doubt;
    }
    return Emotion::Neutral;
}

void AvatarScene::setSpeaking(bool speaking)
{
    speaking_ = speaking;
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    if (!speaking_) {
        mouth_open_ = false;
        stackchan.avatar().mouth().setWeight(0);
    } else if (next_mouth_ms_ == 0) {
        next_mouth_ms_ = GetHAL().millis();
    }
}
