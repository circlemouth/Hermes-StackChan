/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "common.h"
#include <smooth_lvgl.hpp>
#include <uitk/short_namespace.hpp>
#include <hal/hal.h>
#include <cstdint>
#include <functional>
#include <memory>
#include <string_view>

namespace setup_workers {

/**
 * @brief
 *
 */
class WorkerBase {
public:
    virtual ~WorkerBase() = default;

    virtual void update()
    {
    }

    bool isDone() const
    {
        return _is_done;
    }

protected:
    bool _is_done = false;
};

/**
 * @brief
 *
 */
class ZeroCalibrationWorker : public WorkerBase {
public:
    ZeroCalibrationWorker();
    void update() override;

private:
    std::unique_ptr<WorkerBase> _page_tips;
    std::unique_ptr<WorkerBase> _page_calibration;
};

/**
 * @brief
 *
 */
class ServoTestWorker : public WorkerBase {
public:
    ServoTestWorker();
    void update() override;
    bool wasSkipped() const
    {
        return _was_skipped;
    }

private:
    std::unique_ptr<WorkerBase> _page_tips;
    std::unique_ptr<WorkerBase> _page_test;
    std::unique_ptr<WorkerBase> _page_done;
    bool _was_skipped = false;
};

/**
 * @brief
 *
 */
class WifiSetupWorker : public WorkerBase {
public:
    WifiSetupWorker();
    ~WifiSetupWorker();
    void update() override;

private:
    enum class State {
        None,
        HermesSetup,
        WaitBleProvisioning,
        AppConnected,
        Done,
    };

    State _state      = State::HermesSetup;
    State _last_state = State::None;

    uint32_t _last_tick = 0;
    bool _is_first_in   = false;

    AppConfigEvent _last_app_config_event = AppConfigEvent::None;
    int _app_config_signal_id             = -1;

    struct StateHermesSetupData {
        std::unique_ptr<uitk::lvgl_cpp::Container> panel;
        std::unique_ptr<uitk::lvgl_cpp::Image> logo;
        std::unique_ptr<uitk::lvgl_cpp::Label> title;
        std::unique_ptr<uitk::lvgl_cpp::Label> device_id;
        std::unique_ptr<uitk::lvgl_cpp::Button> btn_next;
        std::unique_ptr<uitk::lvgl_cpp::Button> btn_quit;
        std::unique_ptr<uitk::lvgl_cpp::Label> info;
        lv_image_dsc_t logo_img;
        bool next_clicked = false;
        bool quit_clicked = false;

        void reset()
        {
            panel.reset();
            logo.reset();
            title.reset();
            device_id.reset();
            btn_next.reset();
            btn_quit.reset();
            info.reset();
            next_clicked = false;
            quit_clicked = false;
        }
    };
    StateHermesSetupData _state_hermes_setup_data;

    struct StateWaitBleProvisioningData {
        std::unique_ptr<uitk::lvgl_cpp::Container> panel;
        std::unique_ptr<uitk::lvgl_cpp::Label> title;
        std::unique_ptr<uitk::lvgl_cpp::Button> btn_id;
        std::unique_ptr<uitk::lvgl_cpp::Label> info;

        void reset()
        {
            panel.reset();
            title.reset();
            btn_id.reset();
            info.reset();
        }
    };
    StateWaitBleProvisioningData _state_wait_ble_provisioning_data;

    struct StateDoneData {
        int reboot_count = 0;
    };
    StateDoneData _state_done_data;

    void update_state();
    void cleanup_ui();
    void switch_state(State newState);
};

/**
 * @brief
 *
 */
class RgbTestWorker : public WorkerBase {
public:
    RgbTestWorker();
    ~RgbTestWorker();

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::vector<std::unique_ptr<uitk::lvgl_cpp::Button>> _buttons;
};

/**
 * @brief
 *
 */
class MicTestWorker : public WorkerBase {
public:
    MicTestWorker();
    ~MicTestWorker();
    void update() override;

private:
    void update_button_text();
    void update_button_state();
    void update_button_color();
    void update_waveform();

    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Chart> _chart_waveform;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_test;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_back;

    MicTestStatus _status        = MicTestStatus::Done;
    bool _test_flag              = false;
    bool _back_flag              = false;
    bool _is_testing             = false;
    int _waveform_series         = -1;
    uint8_t _original_volume     = 80;
    uint32_t _last_waveform_tick = 0;
    std::string _error_message;
    std::vector<int16_t> _waveform_frame;
};

/**
 * @brief
 *
 */
class StartupWorker : public WorkerBase {
public:
    class PageStartup {
    public:
        PageStartup();

        bool isSkipClicked() const
        {
            return _is_skip_clicked;
        }

        bool isStartClicked() const
        {
            return _is_start_clicked;
        }

    private:
        std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
        std::unique_ptr<uitk::lvgl_cpp::Label> _info;
        std::unique_ptr<uitk::lvgl_cpp::Button> _btn_skip;
        std::unique_ptr<uitk::lvgl_cpp::Button> _btn_start;

        bool _is_skip_clicked  = false;
        bool _is_start_clicked = false;
    };

    StartupWorker(bool needServoSetup = true, bool needAppSetup = true);
    ~StartupWorker();
    void update() override;

private:
    bool _need_servo_setup = true;
    bool _need_app_setup   = true;

    std::unique_ptr<PageStartup> _page_startup;
    std::unique_ptr<ServoTestWorker> _worker_servo_test;
    std::unique_ptr<WifiSetupWorker> _worker_wifi;
};

/**
 * @brief
 *
 */
class FwVersionWorker : public WorkerBase {
public:
    FwVersionWorker();
    ~FwVersionWorker();
    void update() override;

private:
    uint32_t _last_tick = 0;
};

/**
 * @brief
 *
 */
class BrightnessSetupWorker : public WorkerBase {
public:
    BrightnessSetupWorker();
    ~BrightnessSetupWorker();
    void update() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_brightness;
    std::unique_ptr<uitk::lvgl_cpp::Slider> _slider;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;
    uint8_t _original_brightness = 0;
    int32_t _target_brightness   = -1;
    bool _confirmed              = false;
};

/**
 * @brief
 *
 */
class VolumeSetupWorker : public WorkerBase {
public:
    VolumeSetupWorker();
    ~VolumeSetupWorker();
    void update() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_volume;
    std::unique_ptr<uitk::lvgl_cpp::Slider> _slider;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;
    std::vector<uint8_t> _volume_levels;
    uint8_t _original_volume = 0;
    int32_t _target_volume   = -1;
    bool _confirmed          = false;
};

/**
 * @brief
 *
 */
class HermesPowerSavingWorker : public WorkerBase {
public:
    HermesPowerSavingWorker();
    void update() override;

private:
    void update_idle_label();

    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel_idle_shutdown;
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel_charging;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_idle_title;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_idle_value;
    std::unique_ptr<uitk::lvgl_cpp::Slider> _slider_idle_shutdown;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_charging_title;
    std::unique_ptr<uitk::lvgl_cpp::Switch> _switch_charging;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;

    HermesBridgeConfig_t _config;
    std::vector<uint32_t> _idle_shutdown_levels;
    int32_t _pending_idle_index = -1;
    bool _confirm_flag          = false;
};

/**
 * @brief
 *
 */
class HermesGeneralWorker : public WorkerBase {
public:
    HermesGeneralWorker();
    void update() override;

private:
    void update_idle_motion_label();

    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel_general;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_idle_motion_title;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_idle_motion_value;
    std::unique_ptr<uitk::lvgl_cpp::Slider> _slider_idle_motion;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;

    HermesBridgeConfig_t _config;
    std::vector<uint8_t> _idle_motion_levels;
    int32_t _pending_idle_motion_index = -1;
    bool _confirm_flag                 = false;
};

/**
 * @brief
 *
 */
class TimezoneWorker : public WorkerBase {
public:
    TimezoneWorker();
    ~TimezoneWorker();
    void update() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Roller> _roller;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label;
    bool _confirm_flag = false;
};

/**
 * @brief
 *
 */
class FactoryResetWorker : public WorkerBase {
public:
    FactoryResetWorker(std::function<void()> beforeResetAction = {});
    ~FactoryResetWorker();
    void update() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_title;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_info;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_cancel;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_confirm;

    int _confirm_count = 0;
    bool _cancel_flag  = false;
    bool _confirm_flag = false;
    std::function<void()> _before_reset_action;

    void update_ui();
};

/**
 * @brief SDカードから Hermes bridge 設定を読み込むワーカー
 */
class SdConfigWorker : public WorkerBase {
public:
    SdConfigWorker();
    ~SdConfigWorker() = default;
    void update() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_title;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_status;
    std::unique_ptr<uitk::lvgl_cpp::Label> _label_detail;
    std::unique_ptr<uitk::lvgl_cpp::Button> _btn_ok;
    std::unique_ptr<uitk::lvgl_cpp::Container> _loading_panel;
    std::unique_ptr<uitk::lvgl_cpp::Label> _loading_label;
    bool _ok_clicked = false;
    bool _restart_required = false;

    void setup_result_ui(bool success, std::string_view status_msg, std::string_view detail_msg);
};

/**
 * @brief
 *
 */
}  // namespace setup_workers
