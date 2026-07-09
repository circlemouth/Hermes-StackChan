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

    ScsServo(const ServoConfig_t& config, bool readback_available = true)
        : _config(config), _readback_available(readback_available)
    {
    }

    void init() override
    {
        set_angle_limit(_config.angleLimit);
        if (!_readback_available) {
            mclog::tagWarn(
                _tag,
                "id: {} readback unavailable; keeping servo write-only so motion commands can still be delivered",
                _config.id);
        } else if (!restore_position_mode()) {
            mclog::tagWarn(
                _tag,
                "id: {} position mode recovery is unverified; keeping servo write-only instead of disabling it",
                _config.id);
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

        if (!_torque_enabled_cache) {
            setTorqueEnabled(true);
        }

        const int ret = _scs_bus.WritePos(_config.id, mapped_angle, 20, 0);
        if (ret != 1) {
            _write_failure_count++;
            if (_write_failure_count == 1 || (_write_failure_count % 64) == 0) {
                mclog::tagWarn(
                    _tag,
                    "id: {} WritePos ACK/readback failed {} times, latest ret: {}; command may still have been delivered",
                    _config.id,
                    _write_failure_count,
                    ret);
            }
            if (_write_failure_count >= 8) {
                _available = false;
                mclog::tagWarn(
                    _tag,
                    "id: {} disabling servo writes after {} consecutive failures",
                    _config.id,
                    _write_failure_count);
            }
        } else {
            _write_failure_count = 0;
        }
    }

    int getCurrentAngle() override
    {
        if (!_available || !_readback_available) {
            return Servo::getCurrentAngle();
        }

        int current_pos = _scs_bus.ReadPos(_config.id);
        if (!is_raw_pos_valid(current_pos)) {
            const int fallback_angle = uitk::clamp(Servo::getCurrentAngle(), getAngleLimit().x, getAngleLimit().y);
            mclog::tagWarn(
                _tag,
                "id: {} ignore invalid current pos: {}, fallback angle: {}",
                _config.id,
                current_pos,
                fallback_angle);
            return fallback_angle;
        }

        int angle       = raw_pos_to_angle(current_pos);
        angle           = uitk::clamp(angle, getAngleLimit().x, getAngleLimit().y);
        // mclog::tagInfo(_tag, "id: {} current pos: {} angle: {}", _id, current_pos, angle);
        return angle;
    }

    bool is_moving_impl() override
    {
        if (!_available || !_readback_available) {
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
        _torque_enabled_cache = enabled;
        mclog::tagInfo(_tag, "id: {} EnableTorque({}) ret: {}", _config.id, enabled, ret);
        if (ret != 1) {
            mclog::tagWarn(
                _tag,
                "id: {} EnableTorque({}) ACK/readback failed, ret: {}; cache updated optimistically",
                _config.id,
                enabled,
                ret);
        }
        // mclog::tagInfo(_tag, "id: {} set torque: {}", _id, enabled);
    }

    bool getTorqueEnabled() override
    {
        if (!_available || !_readback_available) {
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
        if (!_available || !_readback_available) {
            mclog::tagWarn(_tag, "id: {} skip zero calibration because servo readback is unavailable", _config.id);
            return;
        }

        const int current_pos = _scs_bus.ReadPos(_config.id);
        if (!is_raw_pos_valid(current_pos)) {
            mclog::tagWarn(
                _tag,
                "id: {} ignore invalid zero calibration pos: {}, keep zero pos: {}",
                _config.id,
                current_pos,
                _zero_pos);
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

        if (!_torque_enabled_cache) {
            setTorqueEnabled(true);
        }

        const int ret = _scs_bus.WritePWM(_config.id, mapped_velocity);
        mclog::tagInfo(_tag, "id: {} WritePWM({}) ret: {}", _config.id, mapped_velocity, ret);
        if (ret != 1) {
            mclog::tagWarn(
                _tag,
                "id: {} WritePWM ACK/readback failed, ret: {}; command may still have been delivered",
                _config.id,
                ret);
        }
    }

private:
    enum class Mode { Position = 0, PWM = 1 };

    ServoConfig_t _config;
    int _zero_pos      = 0;
    Mode _current_mode = Mode::Position;
    bool _available    = true;
    bool _readback_available = true;
    bool _torque_enabled_cache = false;
    int _write_failure_count = 0;

    bool is_raw_pos_valid(int raw_pos) const
    {
        return raw_pos >= _config.rawPosLimit.x && raw_pos <= _config.rawPosLimit.y;
    }

    int raw_pos_to_angle(int raw_pos) const
    {
        return (raw_pos - _zero_pos) * 5 * 10 / 16;
    }

    bool restore_position_mode()
    {
        const int current_min = _scs_bus.readWord(_config.id, SCSCL_MIN_ANGLE_LIMIT_L);
        const int current_max = _scs_bus.readWord(_config.id, SCSCL_MAX_ANGLE_LIMIT_L);
        if (current_min < 0 || current_max < 0) {
            mclog::tagWarn(
                _tag,
                "id: {} failed to read angle limit, min: {}, max: {}; keeping write-only degraded mode",
                _config.id,
                current_min,
                current_max);
            _current_mode = Mode::Position;
            return true;
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
            mclog::tagWarn(
                _tag,
                "id: {} failed to restore min angle limit, ret: {}; keeping servo write-only",
                _config.id,
                min_ret);
        }

        const int max_ret = _scs_bus.writeWord(_config.id, SCSCL_MAX_ANGLE_LIMIT_L, static_cast<u16>(expected_max));
        if (max_ret != 1) {
            mclog::tagWarn(
                _tag,
                "id: {} failed to restore max angle limit, ret: {}; keeping servo write-only",
                _config.id,
                max_ret);
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
                _tag,
                "id: {} SwitchMode({}) ACK/readback failed, ret: {}; continuing in requested mode optimistically",
                _config.id,
                static_cast<int>(targetMode),
                ret);
        }
        _current_mode = targetMode;
        return true;
    }
};

static bool probe_servo_readback_status(const ServoConfig_t& config, const char* axis)
{
    const int ping_id = _scs_bus.Ping(static_cast<u8>(config.id));
    const bool ping_ok = ping_id == config.id;
    if (ping_ok) {
        mclog::tagInfo(_hal_servo_tag, "{} servo id {} Ping OK", axis, config.id);
    } else {
        mclog::tagWarn(
            _hal_servo_tag,
            "{} servo id {} Ping failed, ret: {}",
            axis,
            config.id,
            ping_id);
    }

    const int current_pos = _scs_bus.ReadPos(config.id);
    const bool read_pos_ok = current_pos >= 0;
    if (read_pos_ok) {
        mclog::tagInfo(_hal_servo_tag, "{} servo id {} ReadPos OK: {}", axis, config.id, current_pos);
    } else {
        mclog::tagWarn(
            _hal_servo_tag,
            "{} servo id {} ReadPos failed, ret: {}",
            axis,
            config.id,
            current_pos);
    }

    if (!ping_ok && !read_pos_ok) {
        mclog::tagWarn(
            _hal_servo_tag,
            "{} servo id {} readback unavailable; using write-only SCS servo",
            axis,
            config.id);
        return false;
    }
    return true;
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
        yaw_servo = std::make_unique<ScsServo>(
            yaw_servo_config,
            probe_servo_readback_status(yaw_servo_config, "yaw"));
        pitch_servo = std::make_unique<ScsServo>(
            pitch_servo_config,
            probe_servo_readback_status(pitch_servo_config, "pitch"));
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
