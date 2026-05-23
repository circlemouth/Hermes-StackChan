#include "avatar_scene.h"
#include "hal_stub.h"
#include "scenario_runner.h"

#include <lvgl.h>

#if UI_SIM_USE_SDL
#include <src/drivers/sdl/lv_sdl_keyboard.h>
#include <src/drivers/sdl/lv_sdl_mouse.h>
#include <src/drivers/sdl/lv_sdl_window.h>
#endif

#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr int kWidth  = 320;
constexpr int kHeight = 240;
constexpr std::uint32_t kFrameMs = 16;

struct Options {
    std::string scenario_path;
    std::string screenshot_path;
    std::uint32_t duration_ms = 0;
    bool headless = false;
};

std::vector<std::uint8_t> g_framebuffer;

void print_usage(const char* argv0)
{
    std::cerr << "Usage: " << argv0
              << " [--headless] [--scenario path] [--screenshot path] [--duration-ms ms]\n";
}

bool parse_options(int argc, char** argv, Options& options)
{
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--headless") {
            options.headless = true;
        } else if (arg == "--scenario" && i + 1 < argc) {
            options.scenario_path = argv[++i];
        } else if (arg == "--screenshot" && i + 1 < argc) {
            options.screenshot_path = argv[++i];
        } else if (arg == "--duration-ms" && i + 1 < argc) {
            options.duration_ms = static_cast<std::uint32_t>(std::stoul(argv[++i]));
        } else if (arg == "--help" || arg == "-h") {
            print_usage(argv[0]);
            std::exit(0);
        } else {
            std::cerr << "Unknown or incomplete argument: " << arg << "\n";
            print_usage(argv[0]);
            return false;
        }
    }
    return true;
}

void headless_flush_cb(lv_display_t* display, const lv_area_t* area, std::uint8_t* px_map)
{
    const int32_t area_width  = lv_area_get_width(area);
    const int32_t area_height = lv_area_get_height(area);
    const uint32_t src_stride = lv_draw_buf_width_to_stride(area_width, LV_COLOR_FORMAT_RGB888);

    for (int32_t row = 0; row < area_height; ++row) {
        const auto* src = px_map + row * src_stride;
        auto* dst = g_framebuffer.data() + ((area->y1 + row) * kWidth + area->x1) * 3;
        std::memcpy(dst, src, area_width * 3);
    }

    lv_display_flush_ready(display);
}

lv_display_t* create_headless_display()
{
    auto* display = lv_display_create(kWidth, kHeight);
    if (display == nullptr) {
        return nullptr;
    }

    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB888);
    const uint32_t stride = lv_draw_buf_width_to_stride(kWidth, LV_COLOR_FORMAT_RGB888);

    static std::vector<std::uint8_t> draw_buffer;
    draw_buffer.assign(stride * kHeight, 0);
    g_framebuffer.assign(kWidth * kHeight * 3, 0);

    lv_display_set_flush_cb(display, headless_flush_cb);
    lv_display_set_buffers(display, draw_buffer.data(), nullptr, draw_buffer.size(), LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_default(display);
    return display;
}

bool write_ppm(const std::string& path)
{
    std::ofstream output(path, std::ios::binary);
    if (!output) {
        std::cerr << "Failed to open screenshot output: " << path << "\n";
        return false;
    }

    output << "P6\n" << kWidth << " " << kHeight << "\n255\n";
    output.write(reinterpret_cast<const char*>(g_framebuffer.data()), static_cast<std::streamsize>(g_framebuffer.size()));
    return static_cast<bool>(output);
}

}  // namespace

int main(int argc, char** argv)
{
    Options options;
    if (!parse_options(argc, argv, options)) {
        return 2;
    }

#if !UI_SIM_USE_SDL
    if (!options.headless) {
        std::cerr << "This binary was built without SDL. Re-run with --headless or use scripts/run-ui-sim.sh.\n";
        return 2;
    }
#endif

    lv_init();

    lv_display_t* display = nullptr;
#if UI_SIM_USE_SDL
    if (!options.headless) {
        display = lv_sdl_window_create(kWidth, kHeight);
        if (display != nullptr) {
            lv_sdl_window_set_title(display, "StackChan UI Simulator");
            lv_sdl_window_set_resizeable(display, false);
            lv_sdl_mouse_create();
            lv_sdl_keyboard_create();
        }
    } else
#endif
    {
        display = create_headless_display();
    }

    if (display == nullptr) {
        std::cerr << "Failed to create LVGL display\n";
        return 1;
    }

    AvatarScene scene;
    if (!scene.setup(lv_screen_active(), display)) {
        std::cerr << "Failed to set up avatar scene\n";
        return 1;
    }

    ScenarioRunner scenario;
    if (!options.scenario_path.empty()) {
        std::string error;
        if (!scenario.load(options.scenario_path, error)) {
            std::cerr << error << "\n";
            return 1;
        }
    }

    if (options.headless && options.duration_ms == 0) {
        options.duration_ms = scenario.empty() ? 3000 : scenario.endTimeMs() + 1000;
    }

    const std::uint32_t start_ms = GetHAL().millis();
    std::uint32_t last_tick_ms = start_ms;

    while (true) {
        std::uint32_t now = GetHAL().millis();
        std::uint32_t elapsed = now - start_ms;
        std::uint32_t delta = now - last_tick_ms;
        last_tick_ms = now;

#if !UI_SIM_USE_SDL
        lv_tick_inc(delta == 0 ? kFrameMs : delta);
#else
        if (options.headless) {
            lv_tick_inc(delta == 0 ? kFrameMs : delta);
        }
#endif

        scenario.update(elapsed, scene);
        scene.update();
        lv_timer_handler();
        lv_refr_now(display);

        if (options.headless) {
            std::string assertion_error;
            if (!scenario.verifyDueAssertions(elapsed, g_framebuffer, kWidth, kHeight, assertion_error)) {
                std::cerr << assertion_error << "\n";
                return 1;
            }
        }

        if (options.duration_ms > 0 && elapsed >= options.duration_ms) {
            break;
        }

        GetHAL().delay(kFrameMs);
    }

    if (options.headless && !options.screenshot_path.empty()) {
        if (!write_ppm(options.screenshot_path)) {
            return 1;
        }
        std::cout << "Wrote screenshot: " << options.screenshot_path << "\n";
    }

    return 0;
}
