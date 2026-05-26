/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "app_launcher.h"
#include <hal/hal.h>
#include <mooncake.h>
#include <mooncake_log.h>
#include <stackchan/stackchan.h>
#include <cstdint>
#include <string>
#include "sdkconfig.h"

using namespace mooncake;

void AppLauncher::onLauncherCreate()
{
    mclog::tagInfo(getAppInfo().name, "on create");

    // 打开自己
    open();
}

void AppLauncher::onLauncherOpen()
{
    mclog::tagInfo(getAppInfo().name, "on open");
    mclog::tagInfo(getAppInfo().name, "Launcher started");

    LvglLockGuard lock;

    if (!_startup_checked && !GetHAL().isAppConfiged()) {
        mclog::tagInfo(getAppInfo().name,
                       "app config missing; skipping implicit SD config import to keep LCD SPI stable");
    }

    const bool need_app_setup   = !GetHAL().isAppConfiged();
    const bool need_servo_setup = !GetHAL().isServoSetupDone();

    if (!_startup_checked && (need_app_setup || need_servo_setup)) {
        mclog::tagInfo(
            getAppInfo().name,
            "start startup worker, need app setup: {}, need servo setup: {}",
            need_app_setup,
            need_servo_setup);
        _startup_worker = std::make_unique<setup_workers::StartupWorker>(need_servo_setup, need_app_setup);
    } else {
        create_launcher_view();
    }
}

void AppLauncher::onLauncherRunning()
{
    LvglLockGuard lock;

    if (_startup_worker) {
        _startup_worker->update();
        if (_startup_worker->isDone()) {
            _startup_worker.reset();
            _startup_checked = true;
            create_launcher_view();
            if (try_auto_open_hermes()) {
                return;
            }
        }
    } else {
        if (_view) {
            _view->update();
        }
        if (try_auto_open_hermes()) {
            return;
        }
        screensaver_update();
    }

    GetStackChan().update();
}

void AppLauncher::onLauncherClose()
{
    mclog::tagInfo(getAppInfo().name, "on close");

    LvglLockGuard lock;

    _view.reset();
}

void AppLauncher::onLauncherDestroy()
{
    mclog::tagInfo(getAppInfo().name, "on close");
}

void AppLauncher::create_launcher_view()
{
    _view = std::make_unique<view::LauncherView>();
    _view->init(getAppProps());
    _view->onAppClicked = [&](int appID) {
        mclog::tagInfo(getAppInfo().name, "handle open app, app id: {}", appID);
        openApp(appID);
    };
}

void AppLauncher::screensaver_update()
{
    const uint32_t SCREENSAVER_TIMEOUT_MS = 30000;

    uint32_t idle_time = lv_display_get_inactive_time(NULL);
    if (idle_time >= SCREENSAVER_TIMEOUT_MS) {
        if (!_screensaver) {
            _screensaver = std::make_unique<view::Screensaver>();
            _screensaver->init();
        }
    } else if (_screensaver) {
        _screensaver.reset();
    }

    // Update in 30ms interval
    if (_screensaver && GetHAL().millis() - _screensaver_timecount > 30) {
        _screensaver_timecount = GetHAL().millis();
        _screensaver->update();
    }
}

bool AppLauncher::try_auto_open_hermes()
{
#if CONFIG_HERMES_AUTOSTART
    if (!_view || _hermes_auto_open_attempted || !GetHAL().isAppConfiged()) {
        return false;
    }

    _hermes_auto_open_attempted = true;

    for (const auto& app : getAppProps()) {
        if (app.info.name == "HERMES") {
            mclog::tagInfo(getAppInfo().name, "auto opening HERMES app, app id: {}", app.appID);
            openApp(app.appID);
            return true;
        }
    }

    mclog::tagWarn(getAppInfo().name, "HERMES app not found for autostart");
#endif
    return false;
}
