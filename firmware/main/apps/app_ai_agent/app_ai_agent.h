/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include <mooncake.h>
#include <smooth_lvgl.hpp>
#include <uitk/short_namespace.hpp>
#include <lvgl_image.h>
#include <memory>

/**
 * @brief Derived App
 *
 */
class AppAiAgent : public mooncake::AppAbility {
public:
    AppAiAgent();

    // Override lifecycle callbacks
    void onCreate() override;
    void onOpen() override;
    void onRunning() override;
    void onClose() override;

private:
    std::unique_ptr<uitk::lvgl_cpp::Container> _panel;
    std::unique_ptr<uitk::lvgl_cpp::Image> _logo;
    std::unique_ptr<uitk::lvgl_cpp::Label> _title;
    std::unique_ptr<uitk::lvgl_cpp::Label> _status;
    std::unique_ptr<uitk::lvgl_cpp::Label> _device_id;
    lv_image_dsc_t _logo_img;
};
