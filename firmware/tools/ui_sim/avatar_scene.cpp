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

void AvatarScene::update()
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    std::uint32_t now = GetHAL().millis();
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
