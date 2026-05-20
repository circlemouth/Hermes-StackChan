/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "app_avatar.h"
#include <apps/common/common.h>
#include <assets/assets.h>
#include <hal/hal.h>
#include <mooncake_log.h>
#include <smooth_lvgl.hpp>
#include <stackchan/stackchan.h>

using namespace stackchan;

AppAvatar::AppAvatar()
{
    setAppInfo().name = "AVATAR";
    static auto icon  = assets::get_image("icon_hermes.bin");
    setAppInfo().icon = (void*)&icon;
    static uint32_t theme_color = 0xFF6699;
    setAppInfo().userData       = (void*)&theme_color;
}

void AppAvatar::onCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");
}

void AppAvatar::onOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");

    LvglLockGuard lock;

    GetHAL().bootLogo.reset();

    auto& stackchan = GetStackChan();
    stackchan.resetAvatar();
    stackchan.clearModifiers();

    auto avatar = std::make_unique<avatar::DefaultAvatar>();
    avatar->init(lv_screen_active());
    stackchan.attachAvatar(std::move(avatar));

    stackchan.addModifier(std::make_unique<BreathModifier>());
    stackchan.addModifier(std::make_unique<BlinkModifier>());
    stackchan.addModifier(std::make_unique<HeadPetModifier>());
    stackchan.addModifier(std::make_unique<ImuEventModifier>());

    view::create_home_indicator([&]() { close(); }, 0xFF9ABC, 0x431525);
    view::create_status_bar(0xFF9ABC, 0x431525);
}

void AppAvatar::onRunning()
{
    LvglLockGuard lock;

    GetStackChan().update();
    view::update_home_indicator();
    view::update_status_bar();
}

void AppAvatar::onClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");

    LvglLockGuard lock;

    GetStackChan().resetAvatar();
    GetStackChan().clearModifiers();
    view::destroy_home_indicator();
    view::destroy_status_bar();
}
