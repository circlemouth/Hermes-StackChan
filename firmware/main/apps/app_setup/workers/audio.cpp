/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "workers.h"
#include <hal/hal.h>
#include <mooncake_log.h>

using namespace smooth_ui_toolkit::lvgl_cpp;
using namespace setup_workers;

static std::string _tag = "Setup-Audio";

static constexpr uint32_t _btn_test_color_default_bg   = 0xFFDF9A;
static constexpr uint32_t _btn_test_color_default_txt  = 0x47330A;
static constexpr uint32_t _btn_test_color_done_bg      = 0xCBEFC9;
static constexpr uint32_t _btn_test_color_done_txt     = 0x184A20;
static constexpr uint32_t _btn_test_color_failed_bg    = 0xF4B7B2;
static constexpr uint32_t _btn_test_color_failed_txt   = 0x6A1D18;
static constexpr uint32_t _waveform_point_count        = 128;
static constexpr uint32_t _waveform_update_interval_ms = 1000 / 24;

MicTestWorker::MicTestWorker()
{
    _original_volume = GetHAL().getSpeakerVolume();
    GetHAL().setSpeakerVolume(100, false);
    _waveform_frame.resize(_waveform_point_count, 0);

    _panel = std::make_unique<Container>(lv_screen_active());
    _panel->setBgColor(lv_color_hex(0xEDF4FF));
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setBorderWidth(0);
    _panel->setSize(320, 240);
    _panel->setRadius(0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _chart_waveform = std::make_unique<Chart>(_panel->get());
    _chart_waveform->align(LV_ALIGN_CENTER, 0, -68);
    _chart_waveform->setSize(260, 76);
    _chart_waveform->setPointCount(_waveform_point_count);
    _chart_waveform->setStyleSize(0, 0, LV_PART_INDICATOR);
    _chart_waveform->setRange(LV_CHART_AXIS_PRIMARY_Y, INT16_MIN, INT16_MAX);
    _chart_waveform->setDivLineCount(2, 6);
    _chart_waveform->setBorderWidth(0);
    _chart_waveform->setRadius(12);
    _chart_waveform->setBgColor(lv_color_hex(0xDDE8FF));
    // _chart_waveform->setBgOpa(LV_OPA_100);
    _waveform_series = _chart_waveform->addSeries(lv_color_hex(0x4A79E8), LV_CHART_AXIS_PRIMARY_Y);
    update_waveform();

    _btn_test = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_test);
    _btn_test->align(LV_ALIGN_CENTER, 0, 13);
    _btn_test->setSize(260, 60);
    _btn_test->onClick().connect([this]() { _test_flag = true; });

    _btn_back = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_back);
    _btn_back->align(LV_ALIGN_CENTER, 0, 81);
    _btn_back->setSize(180, 50);
    _btn_back->label().setText("Back");
    _btn_back->onClick().connect([this]() { _back_flag = true; });

    update_button_text();
    update_button_state();
    update_button_color();
}

MicTestWorker::~MicTestWorker()
{
    GetHAL().clearupMicTest();
    GetHAL().setSpeakerVolume(_original_volume, false);
}

void MicTestWorker::update()
{
    update_waveform();

    if (_back_flag) {
        _back_flag = false;

        if (_is_testing) {
            return;
        }

        _is_done = true;
        return;
    }

    if (!_test_flag) {
        return;
    }

    _test_flag = false;

    if (_is_testing) {
        return;
    }

    _is_testing = true;
    _status     = MicTestStatus::Starting;
    _error_message.clear();
    mclog::tagInfo(_tag, "start mic test");
    update_button_text();
    update_button_state();
    update_button_color();

    GetHAL().lvglUnlock();
    auto error_message = GetHAL().startMicTest([this](MicTestStatus status) {
        LvglLockGuard lock;
        _status = status;
        update_button_text();
        update_button_state();
        update_button_color();
    });
    GetHAL().lvglLock();

    _is_testing = false;

    if (!error_message.empty()) {
        _status        = MicTestStatus::Failed;
        _error_message = std::move(error_message);
        mclog::tagError(_tag, "mic test failed: {}", _error_message);
    }

    if (_status == MicTestStatus::Failed && _error_message.empty()) {
        _error_message = "Mic test failed";
    }

    update_button_text();
    update_button_state();
    update_button_color();
}

void MicTestWorker::update_button_text()
{
    switch (_status) {
        case MicTestStatus::Starting:
            _btn_test->label().setText("Starting...");
            break;
        case MicTestStatus::Recording:
            _btn_test->label().setText("Recording...");
            break;
        case MicTestStatus::Playing:
            _btn_test->label().setText("Playing back...");
            break;
        case MicTestStatus::Failed:
            _btn_test->label().setText(_error_message.empty() ? "Mic test failed" : _error_message);
            break;
        case MicTestStatus::Done:
            _btn_test->label().setText("Record Test");
            break;
        default:
            _btn_test->label().setText("Record Test");
            break;
    }
}

void MicTestWorker::update_button_state()
{
    if (_is_testing) {
        _btn_test->addState(LV_STATE_DISABLED);
        _btn_back->addState(LV_STATE_DISABLED);
        return;
    }

    _btn_test->removeState(LV_STATE_DISABLED);
    _btn_back->removeState(LV_STATE_DISABLED);
}

void MicTestWorker::update_button_color()
{
    uint32_t bg_color  = _btn_test_color_default_bg;
    uint32_t txt_color = _btn_test_color_default_txt;

    if (_status == MicTestStatus::Done) {
        bg_color  = _btn_test_color_done_bg;
        txt_color = _btn_test_color_done_txt;
    } else if (_status == MicTestStatus::Failed) {
        bg_color  = _btn_test_color_failed_bg;
        txt_color = _btn_test_color_failed_txt;
    }

    _btn_test->setBgColor(lv_color_hex(bg_color));
    _btn_test->label().setTextColor(lv_color_hex(txt_color));
}

void MicTestWorker::update_waveform()
{
    if (!_chart_waveform || _waveform_series < 0) {
        return;
    }

    uint32_t tick = lv_tick_get();
    if (tick - _last_waveform_tick < _waveform_update_interval_ms) {
        return;
    }
    _last_waveform_tick = tick;

    GetHAL().getMicWaveformFrame(_waveform_frame);

    auto* series = _chart_waveform->getSeries(_waveform_series);
    if (!series) {
        return;
    }

    for (size_t i = 0; i < _waveform_frame.size(); i++) {
        lv_chart_set_series_value_by_id(_chart_waveform->get(), series, i, _waveform_frame[i]);
    }
    lv_chart_refresh(_chart_waveform->get());
}
