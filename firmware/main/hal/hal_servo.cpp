/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "hal.h"
#include "drivers/FTServo_Arduino/src/SCSCL.h"
#include <stackchan/stackchan.h>
#include <smooth_ui_toolkit.hpp>
#include <mooncake_log.h>
#include <settings.h>

using namespace smooth_ui_toolkit;
using namespace stackchan::motion;

static SCSCL _scs_bus;
static constexpr const char* _hal_servo_tag = "HAL-Servo";

struct ServoConfig_t {
    int id             = -1;
    int defaultZeroPos = 0;
    Vector2i angleLimit;
    Vector2i rawPosLimit;
    std::string settingNs;
    std::string settingZeroPositionKey;
    bool enablePwmMode = false;
};

class NullServo : public Servo {
public:
    explicit NullServo(Vector2i angleLimit)
    {
        set_angle_limit(angleLimit);
    }

    int getCurrentAngle() override
    {
        return 0;
    }

    void setTorqueEnabled(bool enabled) override
    {
    }

    bool getTorqueEnabled() override
    {
        return false;
    }

protected:
    void set_angle_impl(int angle) override
    {
    }

    bool is_moving_impl() override
    {
        return false;
    }
};

class ScsServo : public Servo {
public:
    static inline const std::string _tag = "ScsServo";

    ScsServo(const ServoConfig_t& config) : _config(config)
    {
    }

    void init() override
    {
        set_angle_limit(_config.angleLimit);
        if (!restore_position_mode()) {
            _available = false;
            mclog::tagError(_tag, "id: {} disabled because position mode recovery failed", _config.id);
        }
        get_zero_pos_from_nvs();
        Servo::init();
    }

    void get_zero_pos_from_nvs()
    {
        _zero_pos     = _config.defaultZeroPos;
        bool is_valid = false;

        {
            Settings settings(_config.settingNs, false);
            int nvs_zero_pos = settings.GetInt(_config.settingZeroPositionKey, -1);

            // Limit check
            if (nvs_zero_pos >= _config.rawPosLimit.x && nvs_zero_pos <= _config.rawPosLimit.y) {
                _zero_pos = nvs_zero_pos;
                is_valid  = true;
                mclog::tagInfo(_tag, "id: {} get zero pos: {} from settings", _config.id, _zero_pos);
            } else {
                is_valid = false;
                mclog::tagWarn(_tag, "id: {} get invalid zero pos: {} from settings", _config.id, nvs_zero_pos);
            }
        }

        if (!is_valid) {
            _zero_pos = _config.defaultZeroPos;
            mclog::tagInfo(_tag, "id: {} override zero pos to default: {}", _config.id, _zero_pos);

            Settings settings(_config.settingNs, true);
            settings.SetInt(_config.settingZeroPositionKey, _zero_pos);
        }
    }

    void set_angle_impl(int angle) override
    {
        if (!_available) {
            return;
        }

        int mapped_angle = _zero_pos + angle * 16 / 5 / 10;  // 一步对应 0.3125度, 0.3125 = 5/16
        mapped_angle     = uitk::clamp(mapped_angle, _config.rawPosLimit.x, _config.rawPosLimit.y);

        // mclog::tagInfo(_tag, "id: {} mapped angle: {}", _id, mapped_angle);

        if (!check_mode(Mode::Position)) {
            return;
        }

        const int ret = _scs_bus.WritePos(_config.id, mapped_angle, 20, 0);
        if (ret != 1) {
            mclog::tagWarn(_tag, "id: {} WritePos failed, ret: {}", _config.id, ret);
        }
    }

    int getCurrentAngle() override
    {
        if (!_available) {
            return Servo::getCurrentAngle();
        }

        int current_pos = _scs_bus.ReadPos(_config.id);
        if (current_pos < 0) {
            mclog::tagWarn(_tag, "id: {} ReadPos failed", _config.id);
            return Servo::getCurrentAngle();
        }

        int angle       = (current_pos - _zero_pos) * 5 * 10 / 16;
        angle           = uitk::clamp(angle, getAngleLimit().x, getAngleLimit().y);
        // mclog::tagInfo(_tag, "id: {} current pos: {} angle: {}", _id, current_pos, angle);
        return angle;
    }

    bool is_moving_impl() override
    {
        if (!_available) {
            return false;
        }

        int moving = _scs_bus.ReadMove(_config.id);
        if (moving < 0) {
            mclog::tagWarn(_tag, "id: {} ReadMove failed", _config.id);
            return false;
        }
        // mclog::tagInfo(_tag, "id: {} moving: {}", _id, moving);
        return moving != 0;
    }

    void setTorqueEnabled(bool enabled) override
    {
        if (!_available) {
            return;
        }

        Servo::setTorqueEnabled(enabled);
        const int ret = _scs_bus.EnableTorque(_config.id, enabled ? 1 : 0);
        if (ret != 1) {
            mclog::tagWarn(_tag, "id: {} EnableTorque({}) failed, ret: {}", _config.id, enabled, ret);
        }
        // mclog::tagInfo(_tag, "id: {} set torque: {}", _id, enabled);
    }

    bool getTorqueEnabled() override
    {
        if (!_available) {
            return false;
        }

        int torque_enable = _scs_bus.ReadToqueEnable(_config.id);
        if (torque_enable < 0) {
            mclog::tagWarn(_tag, "id: {} ReadTorqueEnable failed", _config.id);
            return false;
        }
        // mclog::tagInfo(_tag, "id: {} torque enable: {}", _id, torque_enable);
        return torque_enable > 0;
    }

    void setCurrentAngleAsZero() override
    {
        if (!_available) {
            mclog::tagWarn(_tag, "id: {} skip zero calibration because servo is unavailable", _config.id);
            return;
        }

        const int current_pos = _scs_bus.ReadPos(_config.id);
        if (current_pos < 0) {
            mclog::tagWarn(_tag, "id: {} ReadPos failed, zero calibration not saved", _config.id);
            return;
        }

        _zero_pos = current_pos;

        Settings settings(_config.settingNs, true);
        settings.SetInt(_config.settingZeroPositionKey, _zero_pos);

        mclog::tagInfo(_tag, "id: {} set zero pos: {} to settings", _config.id, _zero_pos);
    }

    void resetZeroCalibration() override
    {
        _zero_pos = _config.defaultZeroPos;

        Settings settings(_config.settingNs, true);
        settings.SetInt(_config.settingZeroPositionKey, _zero_pos);

        mclog::tagInfo(_tag, "id: {} set zero pos: {} to settings", _config.id, _zero_pos);
    }

    void rotate(int velocity) override
    {
        if (!_available) {
            return;
        }

        velocity = uitk::clamp(velocity, -1000, 1000);

        if (!_config.enablePwmMode) {
            return;
        }

        int mapped_velocity = map_range(velocity, 0, 1000, 0, 1023);

        if (!check_mode(Mode::PWM)) {
            return;
        }

        const int ret = _scs_bus.WritePWM(_config.id, mapped_velocity);
        if (ret != 1) {
            mclog::tagWarn(_tag, "id: {} WritePWM failed, ret: {}", _config.id, ret);
        }
    }

private:
    enum class Mode { Position = 0, PWM = 1 };

    ServoConfig_t _config;
    int _zero_pos      = 0;
    Mode _current_mode = Mode::Position;
    bool _available    = true;

    bool restore_position_mode()
    {
        const int current_min = _scs_bus.readWord(_config.id, SCSCL_MIN_ANGLE_LIMIT_L);
        const int current_max = _scs_bus.readWord(_config.id, SCSCL_MAX_ANGLE_LIMIT_L);
        if (current_min < 0 || current_max < 0) {
            mclog::tagWarn(_tag, "id: {} failed to read angle limit, min: {}, max: {}", _config.id, current_min, current_max);
            return false;
        }

        const int expected_min = _config.rawPosLimit.x;
        const int expected_max = _config.rawPosLimit.y;
        if (current_min == expected_min && current_max == expected_max) {
            _current_mode = Mode::Position;
            return true;
        }

        mclog::tagWarn(
            _tag,
            "id: {} restoring angle limit from ({}, {}) to ({}, {})",
            _config.id,
            current_min,
            current_max,
            expected_min,
            expected_max);

        const int min_ret = _scs_bus.writeWord(_config.id, SCSCL_MIN_ANGLE_LIMIT_L, static_cast<u16>(expected_min));
        if (min_ret != 1) {
            mclog::tagError(_tag, "id: {} failed to restore min angle limit, ret: {}", _config.id, min_ret);
            return false;
        }

        const int max_ret = _scs_bus.writeWord(_config.id, SCSCL_MAX_ANGLE_LIMIT_L, static_cast<u16>(expected_max));
        if (max_ret != 1) {
            mclog::tagError(_tag, "id: {} failed to restore max angle limit, ret: {}", _config.id, max_ret);
            return false;
        }

        _current_mode = Mode::Position;
        return true;
    }

    bool check_mode(Mode targetMode)
    {
        if (!_available) {
            return false;
        }

        if (targetMode == _current_mode) {
            return true;
        }

        const int ret = _scs_bus.SwitchMode(_config.id, static_cast<uint8_t>(targetMode));
        if (ret != 1 && !(targetMode == Mode::Position && ret == 0)) {
            mclog::tagWarn(
                _tag, "id: {} SwitchMode({}) failed, ret: {}", _config.id, static_cast<int>(targetMode), ret);
            return false;
        }
        _current_mode = targetMode;
        return true;
    }
};

static bool servo_responds(const ServoConfig_t& config)
{
    const int ping_id = _scs_bus.Ping(static_cast<u8>(config.id));
    if (ping_id == config.id) {
        return true;
    }

    const int current_pos = _scs_bus.ReadPos(config.id);
    return current_pos >= 0;
}

void Hal::servo_init()
{
    mclog::tagInfo(_hal_servo_tag, "init");

    ServoConfig_t yaw_servo_config;
    yaw_servo_config.id                     = 1;
    yaw_servo_config.defaultZeroPos         = 460;
    yaw_servo_config.angleLimit             = Vector2i(-1280, 1280);
    yaw_servo_config.rawPosLimit            = Vector2i(0, 1000);
    yaw_servo_config.settingNs              = "servo";
    yaw_servo_config.settingZeroPositionKey = "zero_pos_1";
    yaw_servo_config.enablePwmMode          = true;

    ServoConfig_t pitch_servo_config;
    pitch_servo_config.id                     = 2;
    pitch_servo_config.defaultZeroPos         = 620;
    pitch_servo_config.angleLimit             = Vector2i(30, 870);
    pitch_servo_config.rawPosLimit            = Vector2i(0, 1000);
    pitch_servo_config.settingNs              = "servo";
    pitch_servo_config.settingZeroPositionKey = "zero_pos_2";

    std::unique_ptr<Servo> yaw_servo;
    std::unique_ptr<Servo> pitch_servo;

    if (!_scs_bus.begin(UART_NUM_1, 1000000, 6, 7)) {
        mclog::tagError(_hal_servo_tag, "SCS UART bus init failed");
        yaw_servo   = std::make_unique<NullServo>(yaw_servo_config.angleLimit);
        pitch_servo = std::make_unique<NullServo>(pitch_servo_config.angleLimit);
    } else {
        if (servo_responds(yaw_servo_config)) {
            yaw_servo = std::make_unique<ScsServo>(yaw_servo_config);
        } else {
            mclog::tagWarn(_hal_servo_tag, "yaw servo id {} not responding", yaw_servo_config.id);
            yaw_servo = std::make_unique<NullServo>(yaw_servo_config.angleLimit);
        }

        if (servo_responds(pitch_servo_config)) {
            pitch_servo = std::make_unique<ScsServo>(pitch_servo_config);
        } else {
            mclog::tagWarn(_hal_servo_tag, "pitch servo id {} not responding", pitch_servo_config.id);
            pitch_servo = std::make_unique<NullServo>(pitch_servo_config.angleLimit);
        }
    }

    auto motion      = std::make_unique<Motion>(std::move(yaw_servo), std::move(pitch_servo));
    motion->init();

    GetStackChan().attachMotion(std::move(motion));
}

bool Hal::isServoSetupDone()
{
    Settings settings("servo", false);
    return settings.GetBool("setup_done", false);
}

void Hal::setServoSetupDone(bool done)
{
    Settings settings("servo", true);
    settings.SetBool("setup_done", done);
}

bool Hal::isServoTestCompleted()
{
    Settings settings("servo", false);
    return settings.GetBool("test_completed", false);
}

void Hal::setServoTestCompleted(bool completed)
{
    Settings settings("servo", true);
    settings.SetBool("test_completed", completed);
}
