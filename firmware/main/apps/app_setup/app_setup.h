/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include "view/view.h"
#include "workers/workers.h"
#include <mooncake.h>
#include <cstdint>
#include <memory>

/**
 * @brief 派生 App
 *
 */
class AppSetup : public mooncake::AppAbility {
public:
    AppSetup();

    // 重写生命周期回调
    void onCreate() override;
    void onOpen() override;
    void onRunning() override;
    void onClose() override;

    // Local diagnostics, called only by app_main; methods acquire the LVGL lock.
    bool isDiagnosticsOpen() const { return _diagnostics_open; }
    bool diagnosticsShowSdPrompt();
    bool diagnosticsRequestSdRead();
    void diagnosticsCancelSdRead();
    bool diagnosticsSdPromptActive() const;

private:
    std::vector<view::SelectMenuPage::MenuSection> _menu_sections;
    std::unique_ptr<view::SelectMenuPage> _menu_page;
    std::unique_ptr<setup_workers::WorkerBase> _worker;

    bool _diagnostics_open = false;
    setup_workers::SdConfigWorker* _sd_config_worker = nullptr; // Owned by _worker.
    bool _destroy_menu    = false;
    bool _need_warm_reset = false;
    int _magic_count      = 0;
};
