/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "stackchan_display.h"
#include <esp_log.h>
#include <esp_err.h>
#include <esp_lvgl_port.h>
#include <esp_psram.h>
#include <vector>
#include <cstring>
#include <src/misc/cache/lv_cache.h>
#include <settings.h>
#include <system_info.h>
#include <board.h>
#include <lvgl.h>
#include <lvgl_theme.h>
#include <stackchan/stackchan.h>
#include <assets/lang_config.h>
#include <hal/hal.h>
#include <apps/common/common.h>

using namespace stackchan;
using namespace stackchan::avatar;

#define TAG "StackChanAvatarDisplay"

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);
LV_FONT_DECLARE(BUILTIN_ICON_FONT);
LV_FONT_DECLARE(font_awesome_30_4);

static lv_obj_t* create_hermes_avatar_screen(lv_disp_t* display)
{
    if (display != nullptr) {
        lv_display_set_default(display);
    }

    lv_obj_t* previous_screen = display != nullptr ? lv_display_get_screen_active(display) : lv_screen_active();
    lv_obj_t* top_layer       = display != nullptr ? lv_display_get_layer_top(display) : lv_layer_top();
    if (top_layer != nullptr) {
        lv_obj_clean(top_layer);
    }
    if (display != nullptr) {
        lv_obj_t* sys_layer = lv_display_get_layer_sys(display);
        if (sys_layer != nullptr) {
            lv_obj_clean(sys_layer);
        }
        lv_obj_t* bottom_layer = lv_display_get_layer_bottom(display);
        if (bottom_layer != nullptr) {
            lv_obj_clean(bottom_layer);
        }
    }

    lv_obj_t* screen = lv_obj_create(nullptr);
    if (screen == nullptr) {
        ESP_LOGW(TAG, "Failed to create Hermes avatar screen; reusing active screen");
        screen = previous_screen;
    }
    if (screen == nullptr) {
        return nullptr;
    }

    lv_obj_clean(screen);
    lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(screen, lv_color_black(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);

    if (screen != previous_screen) {
        lv_screen_load(screen);
        if (previous_screen != nullptr) {
            lv_obj_delete(previous_screen);
        }
    }

    lv_obj_invalidate(screen);
    lv_refr_now(display);
    ESP_LOGI(TAG, "Hermes avatar screen loaded: display=%p previous=%p screen=%p", display, previous_screen, screen);
    return screen;
}

// Have to register themes, so the asset apply can update the text font
void StackChanAvatarDisplay::InitializeLcdThemes()
{
    auto text_font       = std::make_shared<LvglBuiltInFont>(&BUILTIN_TEXT_FONT);
    auto icon_font       = std::make_shared<LvglBuiltInFont>(&BUILTIN_ICON_FONT);
    auto large_icon_font = std::make_shared<LvglBuiltInFont>(&font_awesome_30_4);

    // light theme
    auto light_theme = new LvglTheme("light");
    light_theme->set_background_color(lv_color_hex(0xFFFFFF));        // rgb(255, 255, 255)
    light_theme->set_text_color(lv_color_hex(0x000000));              // rgb(0, 0, 0)
    light_theme->set_chat_background_color(lv_color_hex(0xE0E0E0));   // rgb(224, 224, 224)
    light_theme->set_user_bubble_color(lv_color_hex(0x00FF00));       // rgb(0, 128, 0)
    light_theme->set_assistant_bubble_color(lv_color_hex(0xDDDDDD));  // rgb(221, 221, 221)
    light_theme->set_system_bubble_color(lv_color_hex(0xFFFFFF));     // rgb(255, 255, 255)
    light_theme->set_system_text_color(lv_color_hex(0x000000));       // rgb(0, 0, 0)
    light_theme->set_border_color(lv_color_hex(0x000000));            // rgb(0, 0, 0)
    light_theme->set_low_battery_color(lv_color_hex(0x000000));       // rgb(0, 0, 0)
    light_theme->set_text_font(text_font);
    light_theme->set_icon_font(icon_font);
    light_theme->set_large_icon_font(large_icon_font);

    // dark theme
    auto dark_theme = new LvglTheme("dark");
    dark_theme->set_background_color(lv_color_hex(0x000000));        // rgb(0, 0, 0)
    dark_theme->set_text_color(lv_color_hex(0xFFFFFF));              // rgb(255, 255, 255)
    dark_theme->set_chat_background_color(lv_color_hex(0x1F1F1F));   // rgb(31, 31, 31)
    dark_theme->set_user_bubble_color(lv_color_hex(0x00FF00));       // rgb(0, 128, 0)
    dark_theme->set_assistant_bubble_color(lv_color_hex(0x222222));  // rgb(34, 34, 34)
    dark_theme->set_system_bubble_color(lv_color_hex(0x000000));     // rgb(0, 0, 0)
    dark_theme->set_system_text_color(lv_color_hex(0xFFFFFF));       // rgb(255, 255, 255)
    dark_theme->set_border_color(lv_color_hex(0xFFFFFF));            // rgb(255, 255, 255)
    dark_theme->set_low_battery_color(lv_color_hex(0xFF0000));       // rgb(255, 0, 0)
    dark_theme->set_text_font(text_font);
    dark_theme->set_icon_font(icon_font);
    dark_theme->set_large_icon_font(large_icon_font);

    auto& theme_manager = LvglThemeManager::GetInstance();
    theme_manager.RegisterTheme("light", light_theme);
    theme_manager.RegisterTheme("dark", dark_theme);
}

StackChanAvatarDisplay::StackChanAvatarDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                                               int width, int height, int offset_x, int offset_y, bool mirror_x,
                                               bool mirror_y, bool swap_xy)
    : LvglDisplay(), panel_io_(panel_io), panel_(panel)
{
    width_  = width;
    height_ = height;

    // Initialize LCD themes
    InitializeLcdThemes();

    // Load theme from settings
    Settings settings("display", false);
    std::string theme_name = settings.GetString("theme", "light");
    current_theme_         = LvglThemeManager::GetInstance().GetTheme(theme_name);

    // Draw white screen
    std::vector<uint16_t> buffer(width_, 0xFFFF);
    for (int y = 0; y < height_; y++) {
        esp_lcd_panel_draw_bitmap(panel_, 0, y, width_, y + 1, buffer.data());
    }

    // Set the display to on
    ESP_LOGI(TAG, "Turning display on");
    {
        esp_err_t __err = esp_lcd_panel_disp_on_off(panel_, true);
        if (__err == ESP_ERR_NOT_SUPPORTED) {
            ESP_LOGW(TAG, "Panel does not support disp_on_off; assuming ON");
        } else {
            ESP_ERROR_CHECK(__err);
        }
    }

    ESP_LOGI(TAG, "Initialize LVGL library");
    lv_init();

#if CONFIG_SPIRAM
    // lv image cache, currently only PNG is supported
    size_t psram_size_mb = esp_psram_get_size() / 1024 / 1024;
    if (psram_size_mb >= 8) {
        lv_image_cache_resize(2 * 1024 * 1024, true);
        ESP_LOGI(TAG, "Use 2MB of PSRAM for image cache");
    } else if (psram_size_mb >= 2) {
        lv_image_cache_resize(512 * 1024, true);
        ESP_LOGI(TAG, "Use 512KB of PSRAM for image cache");
    }
#endif

    ESP_LOGI(TAG, "Initialize LVGL port");
    lvgl_port_cfg_t port_cfg = ESP_LVGL_PORT_INIT_CONFIG();
    // port_cfg.task_priority   = 20;
    port_cfg.task_priority = 3;
#if CONFIG_SOC_CPU_CORES_NUM > 1
    port_cfg.task_affinity = 1;
#endif
    lvgl_port_init(&port_cfg);

    ESP_LOGI(TAG, "Adding LCD display");
    const lvgl_port_display_cfg_t display_cfg = {
        .io_handle      = panel_io_,
        .panel_handle   = panel_,
        .control_handle = nullptr,
        .buffer_size    = static_cast<uint32_t>(width_ * 20),
        .double_buffer  = false,
        .trans_size     = 0,
        .hres           = static_cast<uint32_t>(width_),
        .vres           = static_cast<uint32_t>(height_),
        .monochrome     = false,
        .rotation =
            {
                .swap_xy  = swap_xy,
                .mirror_x = mirror_x,
                .mirror_y = mirror_y,
            },
        .color_format = LV_COLOR_FORMAT_RGB565,
        .flags =
            {
                .buff_dma     = 1,
                .buff_spiram  = 0,
                .sw_rotate    = 0,
                .swap_bytes   = 1,
                .full_refresh = 0,
                .direct_mode  = 0,
            },
    };

    display_ = lvgl_port_add_disp(&display_cfg);
    if (display_ == nullptr) {
        ESP_LOGE(TAG, "Failed to add display");
        return;
    }

    if (offset_x != 0 || offset_y != 0) {
        lv_display_set_offset(display_, offset_x, offset_y);
    }

    // Create a timer to hide the preview image
    esp_timer_create_args_t preview_timer_args = {
        .callback =
            [](void* arg) {
                StackChanAvatarDisplay* display = static_cast<StackChanAvatarDisplay*>(arg);
                display->SetPreviewImage(nullptr);
            },
        .arg                   = this,
        .dispatch_method       = ESP_TIMER_TASK,
        .name                  = "preview_timer",
        .skip_unhandled_events = false,
    };
    esp_timer_create(&preview_timer_args, &preview_timer_);

    // Always show a boot surface. Warm reboot previously skipped this, which
    // could leave the display black until the launcher finished rebuilding.
    ESP_LOGI(TAG, "Create boot logo label");
    Lock();
    {
        uitk::lvgl_cpp::ScreenActive screen;
        screen.setBgColor(lv_color_hex(0x000000));
    }
    GetHAL().bootLogo = std::make_unique<BootLogo>();
    Unlock();

    // Robot will be created later in the Hermes runtime UI.
}

StackChanAvatarDisplay::~StackChanAvatarDisplay()
{
    ESP_LOGI(TAG, "Destroying StackChanAvatarDisplay");

    if (preview_timer_ != nullptr) {
        esp_timer_stop(preview_timer_);
        esp_timer_delete(preview_timer_);
    }

    if (preview_image_ != nullptr) {
        lv_obj_del(preview_image_);
    }

    auto& stackchan = GetStackChan();
    if (stackchan.hasAvatar()) {
        stackchan.resetAvatar();
    }
}

bool StackChanAvatarDisplay::Lock(int timeout_ms)
{
    return lvgl_port_lock(timeout_ms);
}

void StackChanAvatarDisplay::Unlock()
{
    lvgl_port_unlock();
}

lv_disp_t* StackChanAvatarDisplay::GetLvglDisplay()
{
    return display_;
}

void StackChanAvatarDisplay::ResetForHermesHandoffLocked()
{
    ESP_LOGI(TAG, "LVGL Hermes handoff reset start");
    if (display_ == nullptr) {
        ESP_LOGW(TAG, "Cannot reset Hermes handoff display: LVGL display is null");
        return;
    }

    lv_display_set_default(display_);

    lv_obj_t* top_layer = lv_display_get_layer_top(display_);
    if (top_layer != nullptr) {
        lv_obj_clean(top_layer);
    }
    lv_obj_t* sys_layer = lv_display_get_layer_sys(display_);
    if (sys_layer != nullptr) {
        lv_obj_clean(sys_layer);
    }
    lv_obj_t* bottom_layer = lv_display_get_layer_bottom(display_);
    if (bottom_layer != nullptr) {
        lv_obj_clean(bottom_layer);
    }

    lv_obj_t* active_screen = lv_display_get_screen_active(display_);
    if (active_screen != nullptr) {
        lv_obj_clean(active_screen);
        lv_obj_remove_flag(active_screen, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_scrollbar_mode(active_screen, LV_SCROLLBAR_MODE_OFF);
        lv_obj_set_style_bg_color(active_screen, lv_color_black(), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(active_screen, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_invalidate(active_screen);
    }

    // Do not bypass LVGL / esp_lvgl_port here. Once LVGL owns the
    // panel IO, direct esp_lcd_panel_draw_bitmap() calls can race with
    // queued LVGL flushes and may outlive their source buffer. That failure
    // mode leaves a mostly black screen with a corrupted colored stripe at
    // the bottom on CoreS3 / StackChan hardware. Let LVGL perform the actual
    // flush from the cleaned active screen instead.
    lv_refr_now(display_);
    ESP_LOGI(TAG, "LVGL Hermes handoff reset complete: display=%p active=%p", display_, active_screen);
}

void StackChanAvatarDisplay::ResetForHermesHandoff()
{
    DisplayLockGuard lock(this);
    ResetForHermesHandoffLocked();
}

#include <hal/board/hal_bridge.h>

void StackChanAvatarDisplay::SetupUI()
{
    ESP_LOGI(TAG, "Hermes avatar SetupUI start");

    auto& stackchan = GetStackChan();
    if (setup_ui_called_ && stackchan.hasAvatar()) {
        DisplayLockGuard lock(this);
        if (display_ != nullptr) {
            lv_display_set_default(display_);
            lv_obj_t* active_screen = lv_display_get_screen_active(display_);
            if (active_screen != nullptr) {
                lv_obj_invalidate(active_screen);
            }
            lv_refr_now(display_);
        } else {
            ESP_LOGW(TAG, "SetupUI() already complete but LVGL display is null; refreshing default display");
            lv_refr_now(nullptr);
        }
        ESP_LOGI(TAG, "SetupUI() already complete; refreshed existing avatar screen");
        return;
    }
    if (setup_ui_called_) {
        ESP_LOGW(TAG, "SetupUI() was marked called but avatar is missing; rebuilding");
    }

    DisplayLockGuard lock(this);

    auto& board = Board::GetInstance();
    if (auto* backlight = board.GetBacklight()) {
        backlight->RestoreBrightness();
    }
    esp_err_t err = esp_lcd_panel_disp_on_off(panel_, true);
    if (err == ESP_ERR_NOT_SUPPORTED) {
        ESP_LOGW(TAG, "Panel does not support disp_on_off; assuming ON");
    } else if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to turn display on during SetupUI: %s", esp_err_to_name(err));
    }

    ESP_LOGI(TAG, "SetupUI() rebuilding Hermes avatar screen");
    GetHAL().bootLogo.reset();
    view::destroy_home_indicator();
    view::destroy_status_bar();
    stackchan.resetAvatar();
    stackchan.clearModifiers();
    lv_obj_t* screen = create_hermes_avatar_screen(display_);
    if (screen == nullptr) {
        ESP_LOGE(TAG, "Cannot create Hermes avatar screen: active LVGL screen is null");
        return;
    }

    Display::SetupUI();  // Mark SetupUI as called after the Hermes screen exists.

    blink_modifier_id_           = -1;
    speaking_modifier_id_        = -1;
    idle_motion_modifier_id_     = -1;
    idle_expression_modifier_id_ = -1;
    preview_image_               = nullptr;
    is_sleeping_                 = false;

    ESP_LOGI(TAG, "Creating Stack-chan Avatar...");

    auto avatar = std::make_unique<DefaultAvatar>();
    avatar->init(screen);
    auto* avatar_panel = avatar->getPanel() != nullptr ? avatar->getPanel()->get() : nullptr;
    if (avatar_panel != nullptr) {
        lv_obj_move_foreground(avatar_panel);
    }
    avatar->getPanel()->onClick().connect([]() {
        if (hal_bridge::is_hermes_ready()) {
            hal_bridge::toggle_hermes_chat_state();
        }
    });

    stackchan.attachAvatar(std::move(avatar));
    stackchan.addModifier(std::make_unique<BreathModifier>());
    blink_modifier_id_ = stackchan.addModifier(std::make_unique<BlinkModifier>());
    stackchan.addModifier(std::make_unique<HeadPetModifier>());
    stackchan.addModifier(std::make_unique<ImuEventModifier>());
    stackchan.addModifier(std::make_unique<FaceTrackingModifier>());

    preview_image_ = lv_image_create(screen);
    lv_obj_set_size(preview_image_, 320, 240);
    lv_obj_align(preview_image_, LV_ALIGN_CENTER, 0, 0);
    lv_obj_add_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);

    // GetHAL().startStackChanAutoUpdate(24);

    auto config        = hal_bridge::get_hermes_config();
    idle_motion_level_ = config.idleRandomMovementLevel;

    stackchan.update();
    lv_obj_invalidate(screen);
    lv_refr_now(display_);

    auto* active_screen = display_ != nullptr ? lv_display_get_screen_active(display_) : nullptr;
    ESP_LOGI(TAG, "Hermes avatar diagnostics: screen=%p active=%p panel=%p child_count=%u hidden=%d", screen,
             active_screen, avatar_panel,
             avatar_panel != nullptr ? static_cast<unsigned>(lv_obj_get_child_count(avatar_panel)) : 0,
             avatar_panel != nullptr ? lv_obj_has_flag(avatar_panel, LV_OBJ_FLAG_HIDDEN) : -1);

    ESP_LOGI(TAG, "Hermes avatar SetupUI complete");
}

void StackChanAvatarDisplay::LvglLock()
{
    if (!Lock(30000)) {
        ESP_LOGE("Display", "Failed to lock display");
    }
}

void StackChanAvatarDisplay::LvglUnlock()
{
    Unlock();
}

void StackChanAvatarDisplay::CreateIdleMotionModifier()
{
    auto& stackchan = GetStackChan();

    switch (idle_motion_level_) {
        case 0:
            idle_motion_modifier_id_ = -1;
            return;
        case 1:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>(8000, 12000));
            return;
        case 3:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>(2000, 4000));
            return;
        case 2:
        default:
            idle_motion_modifier_id_ = stackchan.addModifier(std::make_unique<IdleMotionModifier>());
            return;
    }
}

void StackChanAvatarDisplay::SetEmotion(const char* emotion)
{
    auto& stackchan = GetStackChan();

    if (!stackchan.hasAvatar() || !emotion) {
        return;
    }

    DisplayLockGuard lock(this);

    // ESP_LOGE(TAG, "SetEmotion: %s", emotion);

    auto& avatar = stackchan.avatar();

    // Map emotion string to stackchan::Emotion
    if (strcmp(emotion, "neutral") == 0) {
        avatar.setEmotion(Emotion::Neutral);
    } else if (strcmp(emotion, "happy") == 0) {
        avatar.setEmotion(Emotion::Happy);
    } else if (strcmp(emotion, "laughing") == 0) {
        avatar.setEmotion(Emotion::Happy);
    } else if (strcmp(emotion, "angry") == 0) {
        avatar.setEmotion(Emotion::Angry);
    } else if (strcmp(emotion, "sad") == 0) {
        avatar.setEmotion(Emotion::Sad);
    } else if (strcmp(emotion, "crying") == 0) {
        avatar.setEmotion(Emotion::Sad);
    } else if (strcmp(emotion, "sleepy") == 0) {
        avatar.setEmotion(Emotion::Sleepy);
        avatar.setSpeech("Zzz…");
        is_sleeping_ = true;
        // avatar.mouth().setWeight(10);

        // Stop idle motion
        ESP_LOGW(TAG, "Stop idle motion");
        if (idle_motion_modifier_id_ >= 0) {
            stackchan.removeModifier(idle_motion_modifier_id_);
            idle_motion_modifier_id_ = -1;
            stackchan.removeModifier(idle_expression_modifier_id_);
            idle_expression_modifier_id_ = -1;
        }

        // Return to default pose
        auto& motion = GetStackChan().motion();
        motion.pitchServo().moveWithSpeed(0, 80);

    } else if (strcmp(emotion, "doubtful") == 0) {
        avatar.setEmotion(Emotion::Doubt);
    } else {
        ESP_LOGW(TAG, "Unknown emotion: %s, using NEUTRAL", emotion);
        avatar.setEmotion(Emotion::Neutral);
    }

    if (strcmp(emotion, "sleepy") != 0) {
        is_sleeping_ = false;
    }

    // Resync blink modifier base eye weights
    auto blink_modifier = static_cast<BlinkModifier*>(stackchan.getModifier(blink_modifier_id_));
    if (blink_modifier) {
        blink_modifier->resyncEyeWeights();
    }
}

void StackChanAvatarDisplay::SetChatMessage(const char* role, const char* content)
{
    if (!setup_ui_called_) {
        ESP_LOGW(TAG, "SetChatMessage('%s', '%s') called before SetupUI() - message will be lost!", role, content);
    }

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    // ESP_LOGE(TAG, "SetChatMessage: role=%s, content=%s", role ? role : "null", content ? content : "null");

    DisplayLockGuard lock(this);

    if (strcmp(role, "system") == 0) {
        if (content != nullptr && SystemInfo::GetUserAgent() == content) {
            stackchan.avatar().clearSpeech();
            return;
        }
        stackchan.avatar().setSpeech(content);
    } else if (strcmp(role, "assistant") == 0) {
        stackchan.avatar().setSpeech(content);
    }
}

void StackChanAvatarDisplay::ClearChatMessages()
{
    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        return;
    }

    DisplayLockGuard lock(this);

    stackchan.avatar().clearSpeech();

    ESP_LOGI(TAG, "Chat messages cleared");
}

void StackChanAvatarDisplay::SetPreviewImage(std::unique_ptr<LvglImage> image)
{
    SetPreviewImageForDuration(std::move(image), 6000);
}

void StackChanAvatarDisplay::SetPreviewImageForDuration(std::unique_ptr<LvglImage> image, int duration_ms)
{
    DisplayLockGuard lock(this);
    if (preview_image_ == nullptr) {
        return;
    }

    if (image == nullptr) {
        esp_timer_stop(preview_timer_);
        lv_obj_add_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);
        preview_image_cached_.reset();
        return;
    }

    preview_image_cached_ = std::move(image);
    auto img_dsc          = preview_image_cached_->image_dsc();
    // Set image source and show preview image
    lv_image_set_src(preview_image_, img_dsc);
    if (img_dsc->header.w > 0 && img_dsc->header.h > 0) {
        // Scale to fit width
        lv_image_set_scale(preview_image_, 256 * width_ / img_dsc->header.w);
    }

    lv_obj_remove_flag(preview_image_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(preview_image_);
    esp_timer_stop(preview_timer_);
    ESP_ERROR_CHECK(esp_timer_start_once(preview_timer_, duration_ms * 1000));
}

void StackChanAvatarDisplay::UpdateStatusBar(bool update_all)
{
}

void StackChanAvatarDisplay::SetTheme(Theme* theme)
{
    ESP_LOGI(TAG, "SetTheme: %s", theme->name().c_str());
    Display::SetTheme(theme);

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        ESP_LOGE(TAG, "Avatar is invalid");
        return;
    }

    DisplayLockGuard lock(this);

    auto lvgl_theme = static_cast<LvglTheme*>(theme);
    auto text_font  = lvgl_theme->text_font()->font();

    stackchan.avatar().setSpeechTextFont((void*)text_font);
}

#include <hal/board/hal_bridge.h>
static bool _is_hermes_ready = false;
static bool _is_hermes_idle  = false;
bool hal_bridge::is_hermes_ready()
{
    return _is_hermes_ready;
}
bool hal_bridge::is_hermes_idle()
{
    return _is_hermes_idle;
}

void StackChanAvatarDisplay::SetStatus(const char* status)
{
    ESP_LOGI(TAG, "SetStatus: %s", status);

    auto& stackchan = GetStackChan();
    if (!stackchan.hasAvatar()) {
        ESP_LOGW(TAG, "SetStatus called before avatar exists; attempting SetupUI()");
        SetupUI();
        if (!stackchan.hasAvatar()) {
            ESP_LOGE(TAG, "Avatar is invalid after SetupUI()");
            return;
        }
    }

    DisplayLockGuard lock(this);
    auto& avatar = stackchan.avatar();

    bool is_idle      = false;

    if (strcmp(status, Lang::Strings::LISTENING) == 0) {
        if (speaking_modifier_id_ >= 0) {
            // Start speaking
            stackchan.removeModifier(speaking_modifier_id_);
            avatar.mouth().setWeight(0);
            speaking_modifier_id_ = -1;
        }

        GetHAL().setRgbColor(0, 0, 50, 0);
        GetHAL().refreshRgb();

    } else if (strcmp(status, Lang::Strings::STANDBY) == 0) {
        _is_hermes_ready = true;

        if (speaking_modifier_id_ >= 0) {
            // Stop speaking
            stackchan.removeModifier(speaking_modifier_id_);
            avatar.mouth().setWeight(0);
            speaking_modifier_id_ = -1;
        }

        is_idle = true;

        GetHAL().setRgbColor(0, 0, 0, 0);
        GetHAL().refreshRgb();

    } else if (strcmp(status, Lang::Strings::SPEAKING) == 0) {
        if (speaking_modifier_id_ < 0) {
            const bool enable_light_speaking_motion = idle_motion_level_ > 0;
            speaking_modifier_id_ =
                stackchan.addModifier(std::make_unique<SpeakingModifier>(0, 180, enable_light_speaking_motion));
        }

        GetHAL().setRgbColor(0, 0, 0, 50);
        GetHAL().refreshRgb();
    } else {
        avatar.setSpeech(status);
    }

    if (is_idle) {
        // Start idle motion
        ESP_LOGW(TAG, "Start idle motion");
        if (idle_motion_modifier_id_ < 0) {
            if (idle_motion_level_ > 0) {
                CreateIdleMotionModifier();
            }
            idle_expression_modifier_id_ = stackchan.addModifier(std::make_unique<IdleExpressionModifier>());
        }

        _is_hermes_idle = true;
    } else {
        // Stop idle motion
        ESP_LOGW(TAG, "Stop idle motion");
        if (idle_motion_modifier_id_ >= 0) {
            stackchan.removeModifier(idle_motion_modifier_id_);
            idle_motion_modifier_id_ = -1;
            stackchan.removeModifier(idle_expression_modifier_id_);
            idle_expression_modifier_id_ = -1;
        }

        _is_hermes_idle = false;
    }

    // Clear sleep state
    if (is_sleeping_) {
        avatar.setSpeech("");
        avatar.setEmotion(Emotion::Neutral);
        is_sleeping_ = false;
    }

    stackchan.update();
    if (display_ != nullptr) {
        lv_obj_t* active_screen = lv_display_get_screen_active(display_);
        if (active_screen != nullptr) {
            lv_obj_invalidate(active_screen);
        }
        lv_refr_now(display_);
    } else {
        ESP_LOGW(TAG, "SetStatus refresh fallback: LVGL display is null");
        lv_refr_now(nullptr);
    }
}

void StackChanAvatarDisplay::ShowNotification(const char* notification, int duration_ms)
{
}
