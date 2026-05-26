/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "workers.h"
#include <src/misc/lv_area.h>
#include <src/misc/lv_text.h>
#include <stackchan/stackchan.h>
#include <ArduinoJson.hpp>
#include <mooncake_log.h>
#include <hal/hal.h>
#include <assets/assets.h>
#include <settings.h>
#include <memory>

using namespace smooth_ui_toolkit::lvgl_cpp;
using namespace setup_workers;
using namespace stackchan;

static std::string _tag = "Setup-Connectivity";

WifiSetupWorker::WifiSetupWorker()
{
    _state       = State::HermesSetup;
    _last_state  = State::None;
    _is_first_in = true;

    // Create default avatar
    auto avatar = std::make_unique<avatar::DefaultAvatar>();
    avatar->init(lv_screen_active(), &lv_font_montserrat_24);
    avatar->leftEye().setVisible(false);
    avatar->rightEye().setVisible(false);
    avatar->mouth().setVisible(false);
    GetStackChan().attachAvatar(std::move(avatar));
}

WifiSetupWorker::~WifiSetupWorker()
{
    GetHAL().onAppConfigEvent.disconnect(_app_config_signal_id);
    GetStackChan().resetAvatar();
}

void WifiSetupWorker::update()
{
    cleanup_ui();
    update_state();
}

static std::string get_websocket_url()
{
    Settings ws_settings("websocket", false);
    std::string url = ws_settings.GetString("url_override", "");
    if (url.empty()) {
        url = ws_settings.GetString("url", "");
    }
    return url;
}

void WifiSetupWorker::update_state()
{
    switch (_state) {
        case State::HermesSetup: {
            if (_is_first_in) {
                _is_first_in = false;

                auto& data = _state_hermes_setup_data;

                data.panel = std::make_unique<Container>(lv_screen_active());
                data.panel->setBgColor(lv_color_hex(0xEDF4FF));
                data.panel->align(LV_ALIGN_CENTER, 0, 0);
                data.panel->setBorderWidth(0);
                data.panel->setSize(320, 240);
                data.panel->setRadius(0);

                data.title = std::make_unique<Label>(lv_screen_active());
                data.title->setTextFont(&lv_font_montserrat_20);
                data.title->setTextColor(lv_color_hex(0x7E7B9C));
                data.title->align(LV_ALIGN_TOP_MID, 0, 10);
                data.title->setText("HERMES SETUP");

                // Do not implicitly read SD config while constructing this screen.
                // CoreS3/StackChan shares LCD and SD on SPI/GPIO35; SD reads belong
                // to the explicit Load SD Config worker which pauses LVGL flushes.
                const bool is_bridge_configured = !get_websocket_url().empty();

                data.logo_img = assets::get_image("icon_hermes.bin");
                data.logo     = std::make_unique<Image>(lv_screen_active());
                data.logo->setSrc(&data.logo_img);
                lv_image_set_scale(data.logo->get(), 160);
                data.logo->align(LV_ALIGN_TOP_MID, 0, 22);

                data.device_id = std::make_unique<Label>(lv_screen_active());
                data.device_id->setTextFont(&lv_font_montserrat_14);
                data.device_id->setTextColor(lv_color_hex(0x26206A));
                data.device_id->align(LV_ALIGN_TOP_MID, 0, 104);
                data.device_id->setText(fmt::format("Device ID: {}", GetHAL().getFactoryMacString()).c_str());
                data.device_id->setTextAlign(LV_TEXT_ALIGN_CENTER);

                data.info = std::make_unique<Label>(lv_screen_active());
                data.info->setTextFont(&lv_font_montserrat_14);
                data.info->setTextColor(lv_color_hex(0x26206A));
                data.info->setWidth(292);
                data.info->align(LV_ALIGN_TOP_MID, 0, 130);
                data.info->setTextAlign(LV_TEXT_ALIGN_CENTER);
                if (!is_bridge_configured) {
                    data.info->setText("Bridge URL missing\nUse Load SD Config.");
                } else {
                    data.info->setText("Connect Wi-Fi, then use\nHermes bridge.");
                }

                data.btn_next = std::make_unique<Button>(lv_screen_active());
                apply_button_common_style(*data.btn_next);
                data.btn_next->align(LV_ALIGN_CENTER, 72, 91);
                data.btn_next->setSize(112, 42);
                data.btn_next->label().setText("Next");
                if (!is_bridge_configured) {
                    data.btn_next->addState(LV_STATE_DISABLED);
                    data.btn_next->setBgColor(lv_color_hex(0xD4D9E0));
                    data.btn_next->label().setTextColor(lv_color_hex(0x8A8994));
                }
                data.btn_next->onClick().connect([this, is_bridge_configured]() {
                    if (is_bridge_configured) {
                        _state_hermes_setup_data.next_clicked = true;
                    }
                });

                data.btn_quit = std::make_unique<Button>(lv_screen_active());
                apply_button_common_style(*data.btn_quit);
                data.btn_quit->align(LV_ALIGN_CENTER, -72, 91);
                data.btn_quit->setSize(112, 42);
                data.btn_quit->setBgColor(lv_color_hex(0xD4D9E0));
                data.btn_quit->label().setText("Back");
                data.btn_quit->label().setTextColor(lv_color_hex(0x525064));
                data.btn_quit->onClick().connect([this]() { _state_hermes_setup_data.quit_clicked = true; });

            }

            if (_state_hermes_setup_data.quit_clicked) {
                _is_done = true;
            }

            if (_state_hermes_setup_data.next_clicked && !get_websocket_url().empty()) {
                switch_state(State::WaitBleProvisioning);
            }

            // Check events
            if (_last_app_config_event != AppConfigEvent::None) {
                if (_last_app_config_event == AppConfigEvent::AppConnected) {
                    switch_state(State::AppConnected);
                }
                _last_app_config_event = AppConfigEvent::None;
            }

            break;
        }
        case State::WaitBleProvisioning: {
            if (_is_first_in) {
                _is_first_in = false;

                // Start app config server
                _app_config_signal_id =
                    GetHAL().onAppConfigEvent.connect([this](AppConfigEvent event) { _last_app_config_event = event; });

                GetHAL().startAppConfigServer();

                auto& data = _state_wait_ble_provisioning_data;

                data.panel = std::make_unique<Container>(lv_screen_active());
                data.panel->setBgColor(lv_color_hex(0xEDF4FF));
                data.panel->align(LV_ALIGN_CENTER, 0, 0);
                data.panel->setBorderWidth(0);
                data.panel->setSize(320, 240);
                data.panel->setRadius(0);

                data.title = std::make_unique<Label>(lv_screen_active());
                data.title->setTextFont(&lv_font_montserrat_20);
                data.title->setTextColor(lv_color_hex(0x7E7B9C));
                data.title->align(LV_ALIGN_TOP_MID, 0, 18);
                data.title->setText("BLE PROVISIONING");

                data.btn_id = std::make_unique<Button>(lv_screen_active());
                apply_button_common_style(*data.btn_id);
                data.btn_id->align(LV_ALIGN_CENTER, 0, -15);
                data.btn_id->setSize(262, 52);
                data.btn_id->onClick().connect([]() {
                    auto& avatar = GetStackChan().avatar();
                    avatar.clearDecorators();
                    avatar.addDecorator(std::make_unique<avatar::HeartDecorator>(lv_screen_active(), 3000));
                });
                data.btn_id->label().setText(fmt::format("Device ID: {}", GetHAL().getFactoryMacString()));
                data.btn_id->label().setTextFont(&lv_font_montserrat_20);

                data.info = std::make_unique<Label>(lv_screen_active());
                data.info->setTextFont(&lv_font_montserrat_16);
                data.info->setTextColor(lv_color_hex(0x26206A));
                data.info->align(LV_ALIGN_BOTTOM_MID, 0, -24);
                data.info->setTextAlign(LV_TEXT_ALIGN_CENTER);
                data.info->setText("BLE provisioning active\nSend Wi-Fi credentials\nfrom a provisioning client.");

                auto& avatar = GetStackChan().avatar();
                avatar.clearDecorators();
                avatar.addDecorator(std::make_unique<avatar::HeartDecorator>(lv_screen_active(), 3000));
            }

            // Check events
            if (_last_app_config_event != AppConfigEvent::None) {
                if (_last_app_config_event == AppConfigEvent::AppConnected) {
                    switch_state(State::AppConnected);
                }
                _last_app_config_event = AppConfigEvent::None;
            }

            break;
        }
        case State::AppConnected: {
            if (_is_first_in) {
                _is_first_in = false;

                auto& avatar = GetStackChan().avatar();
                avatar.leftEye().setVisible(true);
                avatar.rightEye().setVisible(true);
                avatar.mouth().setVisible(true);
                avatar.setSpeech("Ready to Configure ~");

                GetStackChan().addModifier(std::make_unique<TimedEmotionModifier>(avatar::Emotion::Happy, 4000));
                GetStackChan().addModifier(std::make_unique<BreathModifier>());
                GetStackChan().addModifier(std::make_unique<BlinkModifier>());
                GetStackChan().addModifier(std::make_unique<SpeakingModifier>(2000, 180, false));
            }

            // Check events
            if (_last_app_config_event != AppConfigEvent::None) {
                if (_last_app_config_event == AppConfigEvent::AppDisconnected) {
                    switch_state(State::WaitBleProvisioning);
                } else if (_last_app_config_event == AppConfigEvent::TryWifiConnect) {
                    auto& avatar = GetStackChan().avatar();
                    avatar.setSpeech("Verifying...");
                    GetStackChan().addModifier(std::make_unique<SpeakingModifier>(2000, 180, false));
                } else if (_last_app_config_event == AppConfigEvent::WifiConnectFailed) {
                    GetStackChan().addModifier(std::make_unique<TimedEmotionModifier>(avatar::Emotion::Sad, 4000));
                    GetStackChan().addModifier(
                        std::make_unique<TimedSpeechModifier>("Connect Failed. Try again?", 6000));
                    GetStackChan().addModifier(std::make_unique<SpeakingModifier>(3000, 180, false));
                } else if (_last_app_config_event == AppConfigEvent::WifiConnected) {
                    switch_state(State::Done);
                }
                _last_app_config_event = AppConfigEvent::None;
            }

            break;
        }
        case State::Done: {
            if (_is_first_in) {
                _is_first_in = false;

                auto& avatar = GetStackChan().avatar();
                avatar.leftEye().setVisible(true);
                avatar.rightEye().setVisible(true);
                avatar.mouth().setVisible(true);
                avatar.setEmotion(avatar::Emotion::Happy);

                GetStackChan().addModifier(std::make_unique<SpeakingModifier>(1500, 180, false));

                _state_done_data.reboot_count = 4;
            }

            if (GetHAL().millis() - _last_tick > 1000) {
                _last_tick = GetHAL().millis();
                if (_state_done_data.reboot_count > 0) {
                    _state_done_data.reboot_count--;
                    auto& avatar = GetStackChan().avatar();
                    avatar.setSpeech(fmt::format("Done!  Reboot in {}s.", _state_done_data.reboot_count));
                } else {
                    mclog::tagInfo(_tag, "rebooting...");
                    GetHAL().delay(100);
                    GetHAL().reboot();
                }
            }

            break;
        }
        default:
            break;
    }
}

void WifiSetupWorker::cleanup_ui()
{
    if (_last_state == State::None) {
        return;
    }

    switch (_last_state) {
        case State::HermesSetup: {
            _state_hermes_setup_data.reset();
            break;
        }
        case State::WaitBleProvisioning: {
            _state_wait_ble_provisioning_data.reset();
            break;
        }
        case State::AppConnected: {
            GetStackChan().avatar().setSpeech("");
            GetStackChan().clearModifiers();
            break;
        }
        case State::Done: {
            break;
        }
        default:
            break;
    }

    _last_state = State::None;
}

void WifiSetupWorker::switch_state(State newState)
{
    _last_state  = _state;
    _state       = newState;
    _is_first_in = true;
}
