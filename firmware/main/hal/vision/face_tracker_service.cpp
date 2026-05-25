#include "face_tracker_service.h"
#include "sdkconfig.h"

#include <mutex>

#if CONFIG_IDF_TARGET_ESP32S3
#include "hal/board/hal_bridge.h"
#include "human_face_detect.hpp"
#include "linux/videodev2.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <list>
#include <memory>

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#endif

namespace hal::vision {

namespace {

#if CONFIG_IDF_TARGET_ESP32S3
constexpr const char* TAG             = "FaceTrackerService";
constexpr uint16_t kModelWidth        = 160;
constexpr uint16_t kModelHeight       = 120;
constexpr size_t kModelInputBytes     = static_cast<size_t>(kModelWidth) * kModelHeight * 3;
constexpr size_t kCaptureBufferBytes  = 320 * 240 * 3;
constexpr TickType_t kDisabledDelay   = pdMS_TO_TICKS(1000);
constexpr TickType_t kUnavailableDelay = pdMS_TO_TICKS(2000);

// Keep these constants explicit so camera orientation can be tuned after real-device validation.
constexpr bool kInvertX = false;
constexpr bool kInvertY = false;
constexpr bool kSwapXY  = false;

std::mutex g_mutex;
TaskHandle_t g_task_handle = nullptr;
bool g_stop_requested      = false;
FaceDetection g_latest_face;

uint8_t* allocate_vision_buffer(size_t len)
{
    auto* ptr = static_cast<uint8_t*>(heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (ptr == nullptr) {
        ptr = static_cast<uint8_t*>(heap_caps_malloc(len, MALLOC_CAP_8BIT));
    }
    return ptr;
}

uint8_t clamp_u8(int value)
{
    return static_cast<uint8_t>(std::max(0, std::min(255, value)));
}

void yuv_to_rgb(uint8_t y, uint8_t u, uint8_t v, uint8_t& r, uint8_t& g, uint8_t& b)
{
    int c = static_cast<int>(y) - 16;
    int d = static_cast<int>(u) - 128;
    int e = static_cast<int>(v) - 128;
    c     = std::max(0, c);

    r = clamp_u8((298 * c + 409 * e + 128) >> 8);
    g = clamp_u8((298 * c - 100 * d - 208 * e + 128) >> 8);
    b = clamp_u8((298 * c + 516 * d + 128) >> 8);
}

void map_output_pixel(int out_x, int out_y, int& mapped_x, int& mapped_y)
{
    if (kSwapXY) {
        mapped_x = out_y * kModelWidth / kModelHeight;
        mapped_y = out_x * kModelHeight / kModelWidth;
    } else {
        mapped_x = out_x;
        mapped_y = out_y;
    }

    if (kInvertX) {
        mapped_x = kModelWidth - 1 - mapped_x;
    }
    if (kInvertY) {
        mapped_y = kModelHeight - 1 - mapped_y;
    }

    mapped_x = std::max(0, std::min<int>(kModelWidth - 1, mapped_x));
    mapped_y = std::max(0, std::min<int>(kModelHeight - 1, mapped_y));
}

bool convert_frame_to_rgb888_160x120(const uint8_t* src, const VisionFrameInfo& info, uint8_t* dst)
{
    if (src == nullptr || dst == nullptr || info.width == 0 || info.height == 0) {
        return false;
    }

    for (int y = 0; y < kModelHeight; y++) {
        for (int x = 0; x < kModelWidth; x++) {
            int mapped_x = 0;
            int mapped_y = 0;
            map_output_pixel(x, y, mapped_x, mapped_y);

            const uint32_t src_x = static_cast<uint32_t>(mapped_x) * info.width / kModelWidth;
            const uint32_t src_y = static_cast<uint32_t>(mapped_y) * info.height / kModelHeight;
            const size_t src_pixel = static_cast<size_t>(src_y) * info.width + src_x;
            uint8_t* out = dst + (static_cast<size_t>(y) * kModelWidth + x) * 3;

            switch (info.format) {
                case V4L2_PIX_FMT_YUYV: {
                    const size_t pair_pixel = src_pixel & ~static_cast<size_t>(1);
                    const size_t offset     = pair_pixel * 2;
                    if (offset + 3 >= info.bytes_used) {
                        return false;
                    }
                    const bool odd = (src_pixel & 1) != 0;
                    uint8_t yv     = src[offset + (odd ? 2 : 0)];
                    uint8_t u      = src[offset + 1];
                    uint8_t v      = src[offset + 3];
                    yuv_to_rgb(yv, u, v, out[0], out[1], out[2]);
                    break;
                }
                case V4L2_PIX_FMT_RGB565: {
                    const size_t offset = src_pixel * 2;
                    if (offset + 1 >= info.bytes_used) {
                        return false;
                    }
                    const uint16_t pixel = static_cast<uint16_t>(src[offset]) |
                                           (static_cast<uint16_t>(src[offset + 1]) << 8);
                    out[0] = static_cast<uint8_t>(((pixel >> 11) & 0x1F) * 255 / 31);
                    out[1] = static_cast<uint8_t>(((pixel >> 5) & 0x3F) * 255 / 63);
                    out[2] = static_cast<uint8_t>((pixel & 0x1F) * 255 / 31);
                    break;
                }
                case V4L2_PIX_FMT_RGB24: {
                    const size_t offset = src_pixel * 3;
                    if (offset + 2 >= info.bytes_used) {
                        return false;
                    }
                    out[0] = src[offset];
                    out[1] = src[offset + 1];
                    out[2] = src[offset + 2];
                    break;
                }
                case V4L2_PIX_FMT_GREY: {
                    if (src_pixel >= info.bytes_used) {
                        return false;
                    }
                    out[0] = src[src_pixel];
                    out[1] = src[src_pixel];
                    out[2] = src[src_pixel];
                    break;
                }
                default:
                    ESP_LOGW(TAG, "unsupported vision frame format: 0x%08lx", info.format);
                    return false;
            }
        }
    }

    return true;
}

void clear_latest_face()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    g_latest_face = FaceDetection{};
}

void release_vision_resources(uint8_t*& capture_buffer,
                              uint8_t*& model_input,
                              std::unique_ptr<HumanFaceDetect>& detector)
{
    detector.reset();
    if (capture_buffer != nullptr) {
        heap_caps_free(capture_buffer);
        capture_buffer = nullptr;
    }
    if (model_input != nullptr) {
        heap_caps_free(model_input);
        model_input = nullptr;
    }
}

#endif  // CONFIG_IDF_TARGET_ESP32S3

}  // namespace

FaceTrackerService& FaceTrackerService::GetInstance()
{
    static FaceTrackerService instance;
    return instance;
}

void FaceTrackerService::Start()
{
#if CONFIG_IDF_TARGET_ESP32S3
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_task_handle != nullptr) {
        return;
    }

    g_stop_requested = false;
    BaseType_t ok = xTaskCreatePinnedToCore(FaceTrackerService::TaskEntry, "face_tracker", 8192, this, 1,
                                            &g_task_handle, 0);
    if (ok != pdPASS) {
        g_task_handle = nullptr;
        ESP_LOGE(TAG, "failed to start FaceTrackerService task");
    }
#endif
}

void FaceTrackerService::Stop()
{
#if CONFIG_IDF_TARGET_ESP32S3
    std::lock_guard<std::mutex> lock(g_mutex);
    g_stop_requested = true;
#endif
}

bool FaceTrackerService::IsRunning() const
{
#if CONFIG_IDF_TARGET_ESP32S3
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_task_handle != nullptr;
#else
    return false;
#endif
}

bool FaceTrackerService::GetLatestFace(FaceDetection& out)
{
#if CONFIG_IDF_TARGET_ESP32S3
    std::lock_guard<std::mutex> lock(g_mutex);
    out = g_latest_face;
    return g_latest_face.has_face;
#else
    out = FaceDetection{};
    return false;
#endif
}

void FaceTrackerService::TaskEntry(void* arg)
{
#if CONFIG_IDF_TARGET_ESP32S3
    static_cast<FaceTrackerService*>(arg)->TaskLoop();
#endif
}

void FaceTrackerService::TaskLoop()
{
#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "FaceTrackerService started");

    uint8_t* capture_buffer = nullptr;
    uint8_t* model_input    = nullptr;
    std::unique_ptr<HumanFaceDetect> detector;

    bool previous_has_face      = false;
    uint32_t last_mode_log_ms   = 0;
    uint32_t last_camera_log_ms = 0;

    while (true) {
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            if (g_stop_requested) {
                break;
            }
        }

        auto config = hal_bridge::get_hermes_config();
        uint8_t hz  = std::max<uint8_t>(1, std::min<uint8_t>(10, config.faceTrackingHz));
        TickType_t interval = pdMS_TO_TICKS(1000 / hz);
        if (interval == 0) {
            interval = 1;
        }

        if (!config.faceTrackingEnabled || config.faceTrackingMode == 0) {
            clear_latest_face();
            release_vision_resources(capture_buffer, model_input, detector);
            previous_has_face = false;
            vTaskDelay(kDisabledDelay);
            continue;
        }

        if (config.faceTrackingMode != 1) {
            uint32_t now_ms = esp_timer_get_time() / 1000;
            if (now_ms - last_mode_log_ms > 10000) {
                ESP_LOGI(TAG, "face tracking mode=%u requested; MVP runs in STANDBY only",
                         static_cast<unsigned>(config.faceTrackingMode));
                last_mode_log_ms = now_ms;
            }
        }

        if (!hal_bridge::is_hermes_ready() || !hal_bridge::is_hermes_idle()) {
            vTaskDelay(interval);
            continue;
        }

        StackChanCamera* camera = hal_bridge::board_get_camera();
        if (camera == nullptr) {
            uint32_t now_ms = esp_timer_get_time() / 1000;
            if (now_ms - last_camera_log_ms > 5000) {
                ESP_LOGW(TAG, "camera unavailable");
                last_camera_log_ms = now_ms;
            }
            vTaskDelay(kUnavailableDelay);
            continue;
        }

        if (capture_buffer == nullptr || model_input == nullptr) {
            release_vision_resources(capture_buffer, model_input, detector);
            capture_buffer = allocate_vision_buffer(kCaptureBufferBytes);
            model_input    = allocate_vision_buffer(kModelInputBytes);
            if (capture_buffer == nullptr || model_input == nullptr) {
                ESP_LOGE(TAG, "failed to allocate vision buffers: capture=%p model=%p heap=%u psram=%u",
                         capture_buffer, model_input,
                         static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_8BIT)),
                         static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
                release_vision_resources(capture_buffer, model_input, detector);
                vTaskDelay(kUnavailableDelay);
                continue;
            }
        }

        VisionFrameInfo frame_info;
        if (!camera->CaptureFrameForVision(capture_buffer, kCaptureBufferBytes, frame_info)) {
            vTaskDelay(interval);
            continue;
        }

        if (!convert_frame_to_rgb888_160x120(capture_buffer, frame_info, model_input)) {
            vTaskDelay(interval);
            continue;
        }

        if (!detector) {
            detector = std::make_unique<HumanFaceDetect>();
        }

        dl::image::img_t img = {
            .data     = model_input,
            .width    = kModelWidth,
            .height   = kModelHeight,
            .pix_type = dl::image::DL_IMAGE_PIX_TYPE_RGB888,
        };

        int64_t infer_start_us = esp_timer_get_time();
        auto& results          = detector->run(img);
        int64_t infer_time_ms  = (esp_timer_get_time() - infer_start_us) / 1000;

        const dl::detect::result_t* best = nullptr;
        int best_area = 0;
        for (const auto& result : results) {
            if (result.box.size() < 4) {
                continue;
            }
            int area = std::max(0, result.box[2] - result.box[0]) * std::max(0, result.box[3] - result.box[1]);
            if (area > best_area) {
                best      = &result;
                best_area = area;
            }
        }

        ESP_LOGD(TAG, "face detect inference=%lldms results=%u heap=%u psram=%u", infer_time_ms,
                 static_cast<unsigned>(results.size()),
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));

        FaceDetection next;
        next.frame_w      = kModelWidth;
        next.frame_h      = kModelHeight;
        next.timestamp_ms = esp_timer_get_time() / 1000;

        if (best != nullptr) {
            next.has_face = true;
            next.x        = std::max(0, best->box[0]);
            next.y        = std::max(0, best->box[1]);
            next.w        = std::max(0, best->box[2] - best->box[0]);
            next.h        = std::max(0, best->box[3] - best->box[1]);
            next.score    = best->score;

            ESP_LOGI(TAG, "face found: score=%.2f bbox=%d,%d,%d,%d inference=%lldms", next.score, next.x, next.y,
                     next.w, next.h, infer_time_ms);
        } else if (previous_has_face) {
            ESP_LOGI(TAG, "face lost");
        }

        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_latest_face = next;
        }
        previous_has_face = next.has_face;

        vTaskDelay(interval);
    }

    clear_latest_face();
    release_vision_resources(capture_buffer, model_input, detector);

    ESP_LOGI(TAG, "FaceTrackerService stopped");
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_task_handle    = nullptr;
        g_stop_requested = false;
    }
    vTaskDelete(nullptr);
#endif
}

}  // namespace hal::vision
