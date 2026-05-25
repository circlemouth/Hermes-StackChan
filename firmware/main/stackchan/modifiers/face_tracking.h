#pragma once

#include "../modifiable.h"
#include <hal/hal.h>
#include <sdkconfig.h>

#if CONFIG_IDF_TARGET_ESP32S3
#include <hal/board/hal_bridge.h>
#include <hal/vision/face_tracker_service.h>
#include <cmath>
#include <esp_log.h>
#include <smooth_ui_toolkit.hpp>
#endif

namespace stackchan {

class FaceTrackingModifier : public Modifier {
public:
    void _update(Modifiable& stackchan) override
    {
#if CONFIG_IDF_TARGET_ESP32S3
        if (!stackchan.hasAvatar()) {
            return;
        }

        auto& motion = stackchan.motion();
        uint32_t now = GetHAL().millis();

        if (!hal_bridge::is_hermes_idle()) {
            release_lock(motion, "not standby");
            return;
        }

        hal::vision::FaceDetection face;
        bool has_face = hal::vision::FaceTrackerService::GetInstance().GetLatestFace(face);
        if (!has_face || !face.has_face || face.frame_w == 0 || face.frame_h == 0 ||
            now - static_cast<uint32_t>(face.timestamp_ms) > kLatestFaceTtlMs) {
            if (_has_lock && now - _last_face_seen_ms >= kLostTimeoutMs) {
                release_lock(motion, "face lost");
            }
            return;
        }

        _last_face_seen_ms = now;

        if (!motion.tryAcquireModifyLock(motion::MotionLockOwner::FaceTracking)) {
            if (_has_lock) {
                ESP_LOGI(TAG, "FaceTrackingModifier lock preempted by owner=%u",
                         static_cast<unsigned>(motion.getModifyLockOwner()));
            }
            _has_lock = false;
            return;
        }
        if (!_has_lock) {
            ESP_LOGI(TAG, "FaceTrackingModifier lock acquired");
            _has_lock = true;
        }

        if (now - _last_move_ms < kUpdateIntervalMs) {
            return;
        }

        float face_cx = static_cast<float>(face.x) + static_cast<float>(face.w) * 0.5f;
        float face_cy = static_cast<float>(face.y) + static_cast<float>(face.h) * 0.5f;
        float err_x   = (face_cx - static_cast<float>(face.frame_w) * 0.5f) /
                      (static_cast<float>(face.frame_w) * 0.5f);
        float err_y = (face_cy - static_cast<float>(face.frame_h) * 0.5f) /
                      (static_cast<float>(face.frame_h) * 0.5f);

        err_x = clamp_error(err_x);
        err_y = clamp_error(err_y);
        if (std::fabs(err_x) < kDeadband) {
            err_x = 0.0f;
        }
        if (std::fabs(err_y) < kDeadband) {
            err_y = 0.0f;
        }

        if (err_x == 0.0f && err_y == 0.0f) {
            _last_move_ms = now;
            return;
        }

        auto current = motion.getCurrentAngles();
        int target_yaw =
            current.x + static_cast<int>(err_x * kYawGain * static_cast<float>(kYawDirection));
        int target_pitch =
            current.y + static_cast<int>(err_y * kPitchGain * static_cast<float>(kPitchDirection));

        auto yaw_limit   = motion.yawServo().getAngleLimit();
        auto pitch_limit = motion.pitchServo().getAngleLimit();
        target_yaw       = uitk::clamp(target_yaw, yaw_limit.x, yaw_limit.y);
        target_pitch     = uitk::clamp(target_pitch, pitch_limit.x, pitch_limit.y);

        ESP_LOGD(TAG, "face tracking move target yaw=%d pitch=%d err=(%.2f,%.2f)", target_yaw, target_pitch, err_x,
                 err_y);
        motion.moveWithSpeed(target_yaw, target_pitch, kMoveSpeed);
        _last_move_ms = now;
#endif
    }

private:
#if CONFIG_IDF_TARGET_ESP32S3
    static constexpr const char* TAG = "FaceTrackingModifier";
    static constexpr uint32_t kLatestFaceTtlMs = 1000;
    static constexpr uint32_t kLostTimeoutMs   = 1200;
    static constexpr uint32_t kUpdateIntervalMs = 200;
    static constexpr float kDeadband           = 0.10f;
    static constexpr float kYawGain            = 80.0f;
    static constexpr float kPitchGain          = 50.0f;
    static constexpr int kMoveSpeed            = 150;
    static constexpr int kYawDirection         = 1;
    static constexpr int kPitchDirection       = -1;

    static float clamp_error(float value)
    {
        if (value > 1.0f) {
            return 1.0f;
        }
        if (value < -1.0f) {
            return -1.0f;
        }
        return value;
    }

    void release_lock(motion::Motion& motion, const char* reason)
    {
        if (_has_lock || motion.isModifyLockedBy(motion::MotionLockOwner::FaceTracking)) {
            motion.releaseModifyLock(motion::MotionLockOwner::FaceTracking);
            ESP_LOGI(TAG, "FaceTrackingModifier lock released: %s", reason);
        }
        _has_lock = false;
    }

    bool _has_lock              = false;
    uint32_t _last_face_seen_ms = 0;
    uint32_t _last_move_ms      = 0;
#endif
};

}  // namespace stackchan
