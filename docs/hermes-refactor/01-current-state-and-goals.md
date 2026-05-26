# 01. Current state and goals

## 現状

このリポジトリの firmware は、起動後に Mooncake アプリ群を登録し、Launcher を開きます。設定済みかつ `CONFIG_HERMES_AUTOSTART` が有効な場合、Launcher は HERMES アプリを自動で開き、HERMES アプリから Hermes runtime へ移行します。

現在の問題は大きく 3 つです。

### 1. Hermes が自動起動する

電源投入後、設定済みであれば HERMES が自動的に開かれます。今回の要求では、この自動起動をやめ、ユーザーが HERMES アプリを選んだときだけ Hermes runtime を起動するようにします。

重要なのは、**自動起動停止は手動起動停止ではない**という点です。

望ましい挙動:

```text
電源 ON
  ↓
Launcher 表示
  ↓
ユーザーが HERMES を選ぶ
  ↓
条件が揃っていれば Hermes runtime 起動
```

避けるべき挙動:

```text
CONFIG_HERMES_AUTOSTART=n
  ↓
HERMES アプリを手動で開いても runtime が起動しない
```

### 2. HERMES 起動時に顔が表示されない

現在、Hermes を起動したときに StackChan の顔が表示されず、画面下端に `HERMES` 文字やアプリアイコンの上端だけが切れたように表示され続ける症状があります。

推定原因:

- Launcher / HERMES アプリの Mooncake LVGL object が Hermes runtime へ移行する瞬間に残っている。
- Launcher の起動アニメーション中または HERMES status UI 作成前後で runtime start request が入り、画面の ownership が曖昧になっている。
- Mooncake teardown 後、Hermes avatar UI を作るまでの間に古い active screen が残っている。

対策方針:

- Mooncake アプリ破棄後、LVGL active screen と top layer を明示的に clean する。
- Hermes runtime を開始する前に、StackChan avatar screen を明示的に構築して refresh する。
- `StackChanAvatarDisplay::SetupUI()` を複数回呼び出しても破綻しない状態にする。

### 3. firmware 実装済みだが public MCP tool として未公開の機能がある

firmware 側には reminder 系 tool が実装されていますが、ai-server 側の public MCP tool list には出ていません。

未公開の代表:

- `self.robot.create_reminder`
- `self.robot.get_reminders`
- `self.robot.stop_reminder`

また、`stackchan_power_off` は ai-server 側には実装済みですが、README の tool list から漏れているため、docs と実装の整合性も直します。

## 目標状態

### 起動

```text
電源 ON
  ↓
HAL 初期化
  ↓
Mooncake apps 登録
  ↓
Launcher 表示
  ↓
HERMES は自動では開かない
```

### HERMES 手動起動

```text
ユーザーが Launcher で HERMES を選ぶ
  ↓
WebSocket URL と Wi-Fi readiness を確認
  ├─ 不足あり → HERMES status / setup guide を表示
  └─ OK → Hermes runtime start request
          ↓
        Mooncake teardown
          ↓
        LVGL screen / layer clean
          ↓
        StackChan avatar screen 作成
          ↓
        Hermes runtime 開始
```

### 画面

- Hermes runtime 起動時に StackChan の顔が表示される。
- 画面下端に `HERMES` 文字、アイコン断片、Launcher panel の残骸が残らない。
- status bar / home indicator / boot logo の残骸も残らない。

### MCP tool

`tools/list` で以下が公開される。

- `stackchan_get_status`
- `stackchan_get_head_angles`
- `stackchan_set_head_angles`
- `stackchan_set_led_color`
- `stackchan_power_off`
- `stackchan_take_photo`
- `stackchan_display_image`
- `stackchan_capture_screen`
- `stackchan_create_reminder`
- `stackchan_get_reminders`
- `stackchan_stop_reminder`

### 自然対話

最低限、以下を改善する。

- LLM emotion が常に `neutral` ではなく、返答文に応じて `happy` / `sad` / `sleepy` / `doubtful` / `neutral` などを使う。
- `stackchan_set_head_angles` などの tool description が、自然な対話中の使い方を誘導する。
- listen / processing / speaking / idle の状態が画面と LED から分かりやすい。
- VAD / post-TTS cooldown などの音声ターン制御値を環境変数で調整できる。

## 非目標

この作業でやらないこと:

- M5Stack firmware 単体で STT / LLM / TTS を完結させる。
- HermesAgent 本体の大規模改修を行う。
- WebSocket protocol を大きく変更する。
- 既存の Xiaozhi / Hermes runtime を置き換える。
- カメラの動画ストリーミングや常時監視を追加する。

## 完了条件

- `CONFIG_HERMES_AUTOSTART` default off で、電源投入後に Launcher に留まる。
- HERMES アプリを手動で開くと、設定が揃っている場合 runtime が起動する。
- Hermes 起動時に StackChan の顔が表示される。
- HERMES 文字やアプリアイコン断片が画面下端に残らない。
- 未公開 reminder 系 tool が public MCP tool として公開される。
- README / README.ja.md の tool list が実装と一致する。
- `ai-server` の build/test が通る。
- `firmware` の build が通る、または未実行の場合は理由と実機確認手順が明記される。
