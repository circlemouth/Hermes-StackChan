# 02. Firmware autostart and display handoff plan

## 目的

1. 電源投入時に HERMES を自動起動しない。
2. HERMES アプリを手動で開いたときは Hermes runtime を開始できる。
3. Hermes runtime 開始時に StackChan の顔が確実に表示される。
4. 画面下端に HERMES 文字やアイコン断片が残る問題をなくす。

## 対象ファイル

- `firmware/sdkconfig.defaults`
- `firmware/main/Kconfig.projbuild`
- `firmware/main/apps/app_launcher/app_launcher.cpp`
- `firmware/main/apps/app_ai_agent/app_ai_agent.cpp`
- `firmware/main/main.cpp`
- `firmware/main/hal/hal.h`
- `firmware/main/hal/hal.cpp`
- `firmware/main/hal/board/stackchan_display.h`
- `firmware/main/hal/board/stackchan_display.cc`

## 1. Hermes 自動起動を default off にする

### 1.1 `sdkconfig.defaults`

変更方針:

```ini
CONFIG_HERMES_AUTOSTART=n
```

または、当該行が `y` になっている場合は `n` に変更します。

この設定は **Launcher が HERMES を勝手に開くかどうか** だけに使います。

### 1.2 `Kconfig.projbuild`

説明文を修正します。現在の説明が「Hermes runtime を自動起動する」ニュアンスなら、次の意味に寄せてください。

```text
Enable automatic opening of the HERMES app from Launcher when the device is configured.
This does not disable manual HERMES startup when the user explicitly opens the HERMES app.
```

可能なら config 名を `CONFIG_HERMES_LAUNCHER_AUTOSTART` に rename した方が意味は明確ですが、既存コードへの影響を抑えるため、今回の最小改修では既存名 `CONFIG_HERMES_AUTOSTART` のままでも構いません。

## 2. Launcher からの自動 HERMES open を止める

`firmware/main/apps/app_launcher/app_launcher.cpp` の `try_auto_open_hermes()` は既に `#if CONFIG_HERMES_AUTOSTART` で guard されています。default off にすれば原則止まります。

確認ポイント:

- `_startup_worker` 完了後も HERMES が勝手に開かない。
- `_view->update()` 後も HERMES が勝手に開かない。
- `CONFIG_HERMES_AUTOSTART=y` にした場合だけ従来の auto open が動く。

## 3. HERMES 手動起動は有効にする

### 現状の問題

`firmware/main/apps/app_ai_agent/app_ai_agent.cpp` では、Hermes runtime start 条件に `hermes_autostart_enabled()` が含まれています。

そのため `CONFIG_HERMES_AUTOSTART=n` にすると、HERMES アプリを手動で開いても runtime start が抑制され、`Hermes autostart disabled` のような status が出る可能性があります。

### 修正方針

`AppAiAgent::onOpen()` では、ユーザーが HERMES アプリを明示的に開いたとみなします。したがって、ここでは `CONFIG_HERMES_AUTOSTART` を見ずに、WebSocket URL と Wi-Fi readiness が揃っていれば runtime start request を出します。

概念的な修正:

```cpp
if (is_hermes_start_ready) {
    ESP_LOGI(TAG, "Hermes start requested by explicit HERMES app open");
    GetHAL().requestHermesStart();
    return;
}
```

削除または無効化する考え方:

```cpp
const bool is_hermes_autostart_enabled = hermes_autostart_enabled();

if (is_hermes_autostart_enabled && is_hermes_start_ready) {
    ...
}

else if (!is_hermes_autostart_enabled) {
    status_text = "Hermes autostart disabled";
}
```

採用する status 文言:

```text
Bridge URL missing
Wi-Fi not connected
Connecting to Hermes bridge
Starting Hermes...
```

避ける status 文言:

```text
Hermes autostart disabled
```

理由: HERMES アプリを手動で開いたユーザーにとって、autostart disabled は runtime 起動不可の理由ではありません。

## 4. Mooncake teardown 後の LVGL クリア

### 現状

`firmware/main/main.cpp` は Hermes start request を検知すると loop を抜け、Mooncake apps を uninstall / destroy してから `GetHAL().startHermes()` を呼びます。

現状の概念:

```cpp
{
    LvglLockGuard lock;
    GetMooncake().uninstallAllApps();
    DestroyMooncake();
}

GetHAL().startHermes();
```

### 修正方針

Mooncake teardown 直後に、active screen と top layer を完全に clean します。

注意:

- LVGL 操作は lock 内で行う。
- `StackChanAvatarDisplay::SetupUI()` は内部で display lock を取るため、後述の `prepareHermesDisplay()` を呼ぶ場合は lock を握ったまま呼ばない。

概念コード:

```cpp
{
    LvglLockGuard lock;
    GetMooncake().uninstallAllApps();
    DestroyMooncake();

    GetHAL().bootLogo.reset();
    view::destroy_home_indicator();
    view::destroy_status_bar();

    lv_obj_t* top_layer = lv_layer_top();
    if (top_layer) {
        lv_obj_clean(top_layer);
    }

    lv_obj_t* screen = lv_screen_active();
    if (screen) {
        lv_obj_clean(screen);
        lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_scrollbar_mode(screen, LV_SCROLLBAR_MODE_OFF);
        lv_obj_set_style_bg_color(screen, lv_color_black(), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_invalidate(screen);
        lv_refr_now(nullptr);
    }
}

GetHAL().prepareHermesDisplay();
GetHAL().startHermes();
```

必要な include:

```cpp
#include <lvgl.h>
#include <apps/common/common.h>
```

既に indirect include されていても、依存を明確にするため追加して構いません。

## 5. Hermes runtime 前に avatar screen を作る

### 5.1 `Hal::prepareHermesDisplay()` を追加

`firmware/main/hal/hal.h` に追加:

```cpp
void prepareHermesDisplay();
```

`firmware/main/hal/hal.cpp` に追加:

```cpp
void Hal::prepareHermesDisplay()
{
    ESP_LOGI(_tag.data(), "Preparing Hermes display");
    auto* display = Board::GetInstance().GetDisplay();
    if (!display) {
        ESP_LOGW(_tag.data(), "No display available while preparing Hermes display");
        return;
    }
    display->SetupUI();
}
```

より型を限定したい場合:

```cpp
if (auto* display = dynamic_cast<StackChanAvatarDisplay*>(Board::GetInstance().GetDisplay())) {
    display->SetupUI();
}
```

この場合は `stackchan_display.h` include が必要になります。循環や compile dependency が重くなるなら、base `Display::SetupUI()` の virtual 呼び出しで十分です。

### 5.2 呼び出し位置

`main.cpp` で Mooncake teardown / LVGL clean の後、`startHermes()` の前に呼びます。

```cpp
GetHAL().prepareHermesDisplay();
GetHAL().startHermes();
```

`Hal::startHermes()` の冒頭で呼ぶ案もありますが、`main.cpp` の handoff 点に置いた方が「Mooncake UI を消す → Hermes UI を作る → runtime を始める」という順序が読みやすくなります。

## 6. `StackChanAvatarDisplay::SetupUI()` を安全にする

現在の `SetupUI()` は `setup_ui_called_` が true のとき duplicate call を skip します。Hermes runtime 側の `Application::Initialize()` からも `SetupUI()` が呼ばれる可能性があるため、この挙動は重要です。

受け入れ条件:

```text
1回目:
  - avatar screen を作る
  - StackChan avatar を attach する
  - modifiers を登録する
  - screen を refresh する

2回目以降:
  - 既存 avatar を壊さない
  - modifier を重複登録しない
  - preview timer / preview object を壊さない
  - harmless に return する
```

ただし、初回 `SetupUI()` が途中失敗した場合に `setup_ui_called_` が true のままになると復旧できません。現在の実装で `Display::SetupUI()` が最初に呼ばれている場合、失敗時の挙動を確認してください。

改善案:

- screen 作成に失敗した場合は setup 完了扱いにしない。
- 既存 base class の制約で難しい場合は、失敗時の log を明確にする。

## 7. `create_hermes_avatar_screen()` の責務

`firmware/main/hal/board/stackchan_display.cc` の `create_hermes_avatar_screen()` は、Hermes avatar 用 screen を作る中心関数として扱います。

期待する責務:

- display default 設定。
- top layer clean。
- 新規 screen 作成、または fallback として active screen 再利用。
- screen clean。
- 黒背景設定。
- scrollable flag 削除。
- scrollbar off。
- screen load。
- previous screen の async delete。
- invalidate。

追加検討:

```cpp
lv_refr_now(display);
```

`SetupUI()` 末尾でも refresh しているため必須ではありませんが、画面残骸対策として効果がある場合があります。

## 8. 追加ログ

デバッグしやすくするため、以下の log を入れてください。

```text
Launcher started
HERMES explicit open
Hermes start readiness: websocket_url_configured=..., wifi_status=..., wifi_configured=...
Hermes start requested by explicit HERMES app open
Mooncake teardown start
Mooncake teardown complete
LVGL handoff screen cleaned
Preparing Hermes display
Hermes avatar SetupUI start
Hermes avatar SetupUI complete
Hal::startHermes entered
Application::Initialize start
Application::Run start
```

## 9. 期待される実機挙動

### 電源投入後

```text
STACKCHAN boot logo
  ↓
Launcher
```

設定済みでも HERMES は勝手に開きません。

### HERMES を選択

```text
HERMES app onOpen
  ↓
条件 OK
  ↓
画面が黒/顔画面へ切り替わる
  ↓
StackChan face 表示
  ↓
Hermes runtime / WebSocket 接続
```

下端に HERMES 文字や icon fragment が残ってはいけません。
