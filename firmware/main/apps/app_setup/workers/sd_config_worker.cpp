/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "workers.h"
#include <hal/hal.h>
#include <mooncake_log.h>
#include <esp_lvgl_port.h>
#include <esp_system.h>

using namespace uitk::lvgl_cpp;
using namespace setup_workers;

// LVGL をアンロックして RAII で確実に再ロックするガード
// GetHAL().lvglUnlock() / lvglLock() を手動で対にすると例外で対が崩れるため使用する
class LvglUnlockGuard {
public:
    LvglUnlockGuard() { GetHAL().lvglUnlock(); }
    ~LvglUnlockGuard() { GetHAL().lvglLock(); }
    LvglUnlockGuard(const LvglUnlockGuard&) = delete;
    LvglUnlockGuard& operator=(const LvglUnlockGuard&) = delete;
};

class SdAccessDisplayGuard {
public:
    SdAccessDisplayGuard()
    {
        // AppSetup::onRunning() holds the LVGL mutex when workers are updated.
        // Stop LVGL ticks and release the mutex before touching the shared SPI3 SD device,
        // otherwise LCD panel IO can keep the bus busy while SD init waits indefinitely.
        lvgl_port_stop();
        GetHAL().delay(20);
        GetHAL().lvglUnlock();
    }

    ~SdAccessDisplayGuard()
    {
        GetHAL().lvglLock();
        lvgl_port_resume();
        GetHAL().delay(20);
    }

    SdAccessDisplayGuard(const SdAccessDisplayGuard&) = delete;
    SdAccessDisplayGuard& operator=(const SdAccessDisplayGuard&) = delete;
};

// ─────────────────────────────────────────────────────────────
//  コンストラクタ: ローディング画面表示 → SD 読込 → 結果表示
// ─────────────────────────────────────────────────────────────
SdConfigWorker::SdConfigWorker()
{
    setup_start_ui();
}

void SdConfigWorker::reset_result_ui()
{
    _btn_back.reset();
    _btn_retry.reset();
    _btn_ok.reset();
    _label_detail.reset();
    _label_status.reset();
    _label_title.reset();
    _panel.reset();

    _ok_clicked = false;
    _retry_clicked = false;
    _back_clicked = false;
    _restart_required = false;
}

void SdConfigWorker::setup_start_ui()
{
    reset_result_ui();

    _panel = std::make_unique<Container>(lv_screen_active());
    _panel->setBgColor(lv_color_hex(0xEDF4FF));
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setBorderWidth(0);
    _panel->setSize(320, 240);
    _panel->setRadius(0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    _label_title = std::make_unique<Label>(_panel->get());
    _label_title->setTextFont(&lv_font_montserrat_20);
    _label_title->setTextColor(lv_color_hex(0x26206A));
    _label_title->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _label_title->align(LV_ALIGN_TOP_MID, 0, 22);
    _label_title->setText("Load SD Config");

    _label_status = std::make_unique<Label>(_panel->get());
    _label_status->setTextFont(&lv_font_montserrat_16);
    _label_status->setTextColor(lv_color_hex(0x26206A));
    _label_status->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _label_status->setWidth(290);
    _label_status->align(LV_ALIGN_TOP_MID, 0, 62);
    _label_status->setText("Insert SD card first");

    _label_detail = std::make_unique<Label>(_panel->get());
    _label_detail->setTextFont(&lv_font_montserrat_14);
    _label_detail->setTextColor(lv_color_hex(0x555555));
    _label_detail->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _label_detail->setWidth(280);
    _label_detail->align(LV_ALIGN_TOP_MID, 0, 100);
    _label_detail->setText("Reading SD uses shared LCD pins.\nDevice restarts after reading.");

    _btn_back = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_back);
    _btn_back->align(LV_ALIGN_BOTTOM_MID, -72, -18);
    _btn_back->setSize(120, 48);
    _btn_back->setBgColor(lv_color_hex(0xD4D9E0));
    _btn_back->label().setText("Back");
    _btn_back->label().setTextFont(&lv_font_montserrat_20);
    _btn_back->label().setTextColor(lv_color_hex(0x525064));
    _btn_back->onClick().connect([this]() { _back_clicked = true; });

    _btn_retry = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_retry);
    _btn_retry->align(LV_ALIGN_BOTTOM_MID, 72, -18);
    _btn_retry->setSize(120, 48);
    _btn_retry->label().setText("Read");
    _btn_retry->label().setTextFont(&lv_font_montserrat_20);
    _btn_retry->onClick().connect([this]() { _retry_clicked = true; });
}

void SdConfigWorker::load_config()
{
    mclog::tagInfo("SD Config", "load_config start");

    // 1. ローディング画面を作成（LVGL ロックは呼び出し元が保持中）
    reset_result_ui();

    _loading_panel = std::make_unique<Container>(lv_screen_active());
    _loading_panel->setBgColor(lv_color_hex(0xEDF4FF));
    _loading_panel->align(LV_ALIGN_CENTER, 0, 0);
    _loading_panel->setSize(320, 240);
    _loading_panel->setBorderWidth(0);
    _loading_panel->setRadius(0);

    _loading_label = std::make_unique<Label>(_loading_panel->get());
    _loading_label->setTextFont(&lv_font_montserrat_20);
    _loading_label->setTextColor(lv_color_hex(0x26206A));
    _loading_label->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _loading_label->align(LV_ALIGN_CENTER, 0, 0);
    _loading_label->setWidth(280);
    _loading_label->setText("Reading SD card...\nDevice will restart.");

    // 2. LVGL を一瞬アンロックしてローディング画面をレンダリングさせる
    //    SD アクセス中は LVGL をロックしたままにして SPI3 (GPIO35) の競合を防ぐ
    {
        LvglUnlockGuard brief_unlock;
        GetHAL().delay(80);
    }

    // 3. LVGL tick を止めてから SD カード読み込みを実行
    //    LCD と SD は SPI3/GPIO35 を共有するため、LVGL を動かしたまま mount しない。
    sd_config::LoadResult load_result;
    {
        SdAccessDisplayGuard display_guard;
        mclog::tagInfo("SD Config", "calling HAL SD config loader");
        load_result = GetHAL().loadConfigFromSdCard(nullptr);
        mclog::tagInfo("SD Config", "HAL SD config loader returned: success={} error={}",
                       load_result.success, load_result.error);
    }
    if (load_result.success) {
        mclog::tagInfo("SD Config", "SD Config Loaded; restarting before using HERMES");
    } else {
        mclog::tagWarn("SD Config", "SD Config load failed; restarting to recover LCD: {}",
                       load_result.error);
    }

    // CoreS3 / StackChan shares LCD DC and SD MISO on GPIO35. Once SD access
    // has happened, do not rely on post-access LVGL redraw. Reboot is the
    // reliable recovery path for both success and failure.
    GetHAL().delay(250);
    esp_restart();
}

// ─────────────────────────────────────────────────────────────
//  結果 UI の構築
// ─────────────────────────────────────────────────────────────
void SdConfigWorker::setup_result_ui(bool success, std::string_view status_msg,
                                     std::string_view detail_msg)
{
    _panel = std::make_unique<Container>(lv_screen_active());
    _panel->setBgColor(lv_color_hex(0xEDF4FF));
    _panel->align(LV_ALIGN_CENTER, 0, 0);
    _panel->setBorderWidth(0);
    _panel->setSize(320, 240);
    _panel->setRadius(0);
    _panel->removeFlag(LV_OBJ_FLAG_SCROLLABLE);

    // タイトル
    _label_title = std::make_unique<Label>(_panel->get());
    _label_title->setTextFont(&lv_font_montserrat_20);
    _label_title->setTextColor(lv_color_hex(success ? 0x1A7A4A : 0xAA2222));
    _label_title->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _label_title->align(LV_ALIGN_TOP_MID, 0, 18);
    _label_title->setText(success ? "SD Config Loaded" : "SD Config Error");

    // ステータス (インポート数 or エラー種別)
    _label_status = std::make_unique<Label>(_panel->get());
    _label_status->setTextFont(&lv_font_montserrat_16);
    _label_status->setTextColor(lv_color_hex(0x26206A));
    _label_status->setTextAlign(LV_TEXT_ALIGN_CENTER);
    _label_status->setWidth(290);
    _label_status->align(LV_ALIGN_TOP_MID, 0, 54);
    _label_status->setText(status_msg);

    // 詳細 (インポートされたキー名 or エラー詳細)
    _label_detail = std::make_unique<Label>(_panel->get());
    _label_detail->setTextFont(&lv_font_montserrat_14);
    _label_detail->setTextColor(lv_color_hex(0x555555));
    _label_detail->setTextAlign(LV_TEXT_ALIGN_LEFT);
    _label_detail->setWidth(280);
    _label_detail->align(LV_ALIGN_TOP_MID, 0, 88);
    _label_detail->setText(detail_msg);

    if (success) {
        _btn_ok = std::make_unique<Button>(_panel->get());
        apply_button_common_style(*_btn_ok);
        _btn_ok->align(LV_ALIGN_BOTTOM_MID, 0, -18);
        _btn_ok->setSize(150, 48);
        _btn_ok->label().setText(_restart_required ? "Restart" : "OK");
        _btn_ok->onClick().connect([this]() { _ok_clicked = true; });
        return;
    }

    _btn_back = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_back);
    _btn_back->align(LV_ALIGN_BOTTOM_MID, -72, -18);
    _btn_back->setSize(120, 48);
    _btn_back->setBgColor(lv_color_hex(0xD4D9E0));
    _btn_back->label().setText("Back");
    _btn_back->label().setTextFont(&lv_font_montserrat_20);
    _btn_back->label().setTextColor(lv_color_hex(0x525064));
    _btn_back->onClick().connect([this]() { _back_clicked = true; });

    _btn_retry = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_retry);
    _btn_retry->align(LV_ALIGN_BOTTOM_MID, 72, -18);
    _btn_retry->setSize(120, 48);
    _btn_retry->label().setText("Retry");
    _btn_retry->label().setTextFont(&lv_font_montserrat_20);
    _btn_retry->onClick().connect([this]() { _retry_clicked = true; });
}

// ─────────────────────────────────────────────────────────────
//  毎フレーム更新: OK ボタン待ち
// ─────────────────────────────────────────────────────────────
void SdConfigWorker::update()
{
    if (_retry_clicked) {
        load_config();
        return;
    }

    if (_back_clicked) {
        _is_done = true;
        return;
    }

    if (_ok_clicked) {
        if (_restart_required) {
            mclog::tagInfo("SD Config", "restarting after SD config import");
            GetHAL().delay(100);
            esp_restart();
        }
        _is_done = true;
    }
}
