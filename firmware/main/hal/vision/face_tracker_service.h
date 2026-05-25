#pragma once

#include <cstdint>

namespace hal::vision {

struct FaceDetection {
    bool has_face       = false;
    int x               = 0;
    int y               = 0;
    int w               = 0;
    int h               = 0;
    float score         = 0.0f;
    uint16_t frame_w    = 0;
    uint16_t frame_h    = 0;
    int64_t timestamp_ms = 0;
};

class FaceTrackerService {
public:
    static FaceTrackerService& GetInstance();

    void Start();
    void Stop();
    bool IsRunning() const;
    bool GetLatestFace(FaceDetection& out);

private:
    FaceTrackerService() = default;
    FaceTrackerService(const FaceTrackerService&) = delete;
    FaceTrackerService& operator=(const FaceTrackerService&) = delete;

    static void TaskEntry(void* arg);
    void TaskLoop();
};

}  // namespace hal::vision
