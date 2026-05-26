/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "workers.h"
#include <hal/hal.h>
#include <mooncake_log.h>
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

// ─────────────────────────────────────────────────────────────
//  コンストラクタ: ローディング画面表示 → SD 読込 → 結果表示
// ─────────────────────────────────────────────────────────────
SdConfigWorker::SdConfigWorker()
{
    // 1. ローディング画面を作成（LVGL ロックは呼び出し元が保持中）
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
    _loading_label->setText("Reading SD card...");

    // 2. LVGL を一瞬アンロックしてローディング画面をレンダリングさせる
    //    SD アクセス中は LVGL をロックしたままにして SPI3 (GPIO35) の競合を防ぐ
    {
        LvglUnlockGuard brief_unlock;
        GetHAL().delay(80);
    }

    // 3. LVGL ロック保持のまま SD カード読み込みを実行
    //    (ディスプレイ DC = GPIO35 がアクティブにならないよう LVGL を止める)
    //    mount/unmount も含めて HAL 経由で呼び出す
    auto load_result = GetHAL().loadConfigFromSdCard(nullptr);
    GetHAL().delay(200);

    // 3. ローディング UI を破棄
    _loading_label.reset();
    _loading_panel.reset();

    // 4. 結果に応じた UI を構築
    if (load_result.success) {
        _restart_required = true;
        std::string detail;
        for (const auto& key : load_result.imported_keys) {
            detail += "  " + key + "\n";
        }
        if (!detail.empty()) {
            detail.pop_back();
        }
        if (!detail.empty()) {
            detail += "\n\n";
        }
        detail += "Restart is required before using HERMES.";
        mclog::tagInfo("SD Config", "SD Config Loaded; Restart required before using HERMES");
        setup_result_ui(true,
                        fmt::format("Loaded {} key(s)", load_result.imported_keys.size()),
                        detail);
    } else {
        setup_result_ui(false, "Load Failed", load_result.error);
    }
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

    // OK / Restart ボタン
    _btn_ok = std::make_unique<Button>(_panel->get());
    apply_button_common_style(*_btn_ok);
    _btn_ok->align(LV_ALIGN_BOTTOM_MID, 0, -18);
    _btn_ok->setSize(150, 48);
    _btn_ok->label().setText(_restart_required ? "Restart" : "OK");
    _btn_ok->onClick().connect([this]() { _ok_clicked = true; });
}

// ─────────────────────────────────────────────────────────────
//  毎フレーム更新: OK ボタン待ち
// ─────────────────────────────────────────────────────────────
void SdConfigWorker::update()
{
    if (_ok_clicked) {
        if (_restart_required) {
            mclog::tagInfo("SD Config", "restarting after SD config import");
            GetHAL().delay(100);
            esp_restart();
        }
        _is_done = true;
    }
}
