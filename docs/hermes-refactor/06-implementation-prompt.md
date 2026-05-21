# 06. Implementation prompt

以下は、Codex などの実装エージェントにそのまま渡すためのプロンプトです。

---

あなたは Hermes-StackChan リポジトリの実装エージェントです。リポジトリ直下の `AGENTS.md` と、`docs/hermes-refactor/` 以下のドキュメントを必ず読んでから作業してください。`hermes-agent/` 配下を編集する必要が出た場合は、`hermes-agent/AGENTS.md` を優先してください。

## 目的

以下の改修を完遂してください。

1. Hermes の自動起動をやめる。
2. HERMES を手動起動したときに StackChan の顔が表示されず、画面下端に `HERMES` 文字とアプリアイコン断片が残る問題を解決する。
3. firmware に実装済みだが ai-server / public MCP server に未公開の機能を公開する。
4. Hermes と M5-stackchan がより自然に対話できるように brush-up する。

## 最重要方針

- `CONFIG_HERMES_AUTOSTART=n` にした結果、HERMES アプリの手動起動まで無効化してはいけません。
- `CONFIG_HERMES_AUTOSTART` は「Launcher から HERMES を勝手に開くか」だけの意味として扱ってください。
- ユーザーが Launcher で HERMES アプリを明示的に開いた場合は、WebSocket URL と Wi-Fi readiness が揃っていれば Hermes runtime を開始してください。
- Hermes runtime へ移行する前に Mooncake UI を破棄し、LVGL active screen / top layer を clean し、StackChan avatar screen を明示的に作ってください。
- LVGL object 操作は lock 下で行い、二重 lock を避けてください。
- firmware-side tool と ai-server public tool list と README の整合性を保ってください。

## 実装タスク

### Task 1: Hermes 自動起動停止

対象:

- `firmware/sdkconfig.defaults`
- `firmware/main/Kconfig.projbuild`
- `firmware/main/apps/app_launcher/app_launcher.cpp`
- `firmware/main/apps/app_ai_agent/app_ai_agent.cpp`

作業:

1. `CONFIG_HERMES_AUTOSTART` の default を off にしてください。
2. Launcher からの HERMES auto open は `CONFIG_HERMES_AUTOSTART=y` のときだけ動くよう維持してください。
3. `AppAiAgent::onOpen()` では `CONFIG_HERMES_AUTOSTART` を runtime start 条件に使わないでください。
4. HERMES アプリを開いたとき、WebSocket URL と Wi-Fi readiness が揃っていれば `GetHAL().requestHermesStart()` を呼んでください。
5. status 表示から `Hermes autostart disabled` をなくし、`Bridge URL missing`、`Wi-Fi not connected`、`Starting Hermes...` などユーザーに分かる文言にしてください。

### Task 2: Hermes 起動時の画面崩れ修正

対象:

- `firmware/main/main.cpp`
- `firmware/main/hal/hal.h`
- `firmware/main/hal/hal.cpp`
- `firmware/main/hal/board/stackchan_display.h`
- `firmware/main/hal/board/stackchan_display.cc`

作業:

1. Mooncake teardown 後に LVGL top layer と active screen を clean してください。
2. boot logo、home indicator、status bar の残骸を消してください。
3. screen 背景を黒にし、scrollbar / scrollable flag を消してください。
4. Hermes runtime 開始前に `StackChanAvatarDisplay::SetupUI()` を明示的に呼ぶため、`Hal::prepareHermesDisplay()` のようなメソッドを追加してください。
5. `StackChanAvatarDisplay::SetupUI()` は重複呼び出しで壊れないように維持してください。Hermes runtime 側から再度呼ばれても avatar / modifier が二重登録されないことを確認してください。
6. 起動順序が分かる log を追加してください。

期待される順序:

```text
HERMES explicit open
  -> Hermes start requested
  -> Mooncake teardown
  -> LVGL clean
  -> prepareHermesDisplay / SetupUI
  -> startHermes
  -> Application::Initialize
  -> Application::Run
```

### Task 3: 未公開 MCP tool の公開

対象:

- `ai-server/src/device_control.ts`
- `ai-server/src/stackchan_mcp_server.ts`
- `ai-server/test/stackchan_mcp_server.test.ts`
- `firmware/main/hal/hal_mcp.cpp`
- `README.md`
- `README.ja.md`

作業:

1. 以下の public tools を追加してください。
   - `stackchan_create_reminder`
   - `stackchan_get_reminders`
   - `stackchan_stop_reminder`
2. `device_control.ts` の `StackChanToolName` と `TOOL_MAP` に mapping を追加してください。
   - `stackchan_create_reminder` → `self.robot.create_reminder`
   - `stackchan_get_reminders` → `self.robot.get_reminders`
   - `stackchan_stop_reminder` → `self.robot.stop_reminder`
3. `stackchan_mcp_server.ts` の `tools/list` に tool definitions を追加してください。
4. `stackchan_create_reminder` schema は `duration_seconds`, `message`, `repeat` を扱ってください。
5. `stackchan_stop_reminder` schema は `id` を required にしてください。
6. firmware 側の `get_reminders` が文字列連結で JSON を作っている場合は、`cJSON` などで安全に JSON を構築してください。
7. `stackchan_power_off` が README の tool list から漏れている場合は追加してください。
8. `README.md` と `README.ja.md` の tool list を実装と一致させてください。
9. tests を追加してください。

最終 public tool list:

```text
stackchan_get_status
stackchan_get_head_angles
stackchan_set_head_angles
stackchan_set_led_color
stackchan_power_off
stackchan_take_photo
stackchan_display_image
stackchan_capture_screen
stackchan_create_reminder
stackchan_get_reminders
stackchan_stop_reminder
```

### Task 4: 自然対話化

対象:

- `ai-server/src/session.ts`
- `ai-server/src/stackchan_mcp_server.ts`
- `ai-server/test/session.test.ts`
- `ai-server/test/stackchan_mcp_server.test.ts`
- `README.md`
- `README.ja.md`

作業:

1. `session.ts` の LLM emotion を `neutral` 固定から改善してください。
2. `inferStackChanEmotion()` のような関数を追加し、返答文から `happy` / `sad` / `sleepy` / `doubtful` / `neutral` などを推定してください。
3. emotion inference の unit test を追加してください。
4. `SILENCE_TIMEOUT_MS`、`MAX_RECORDING_MS`、`MIN_FRAMES_FOR_STT`、`POST_TTS_COOLDOWN_MS` を環境変数で調整可能にしてください。
5. env parser の test を追加してください。
6. `stackchan_set_head_angles` と `stackchan_set_led_color` の tool descriptions を自然対話向けに改善してください。
7. 必要に応じて README の `.env` 例に音声ターン制御 env を追記してください。

## 検証

最低限、以下を実行してください。

```bash
cd ai-server
npm install
npm run build
npm test
```

可能なら以下も実行してください。

```bash
cd firmware
python3 ./fetch_repos.py
idf.py build
```

実機が使える場合は以下を確認してください。

1. 設定済み device の電源投入後、HERMES が自動起動せず Launcher に留まる。
2. Launcher で HERMES を選ぶと Hermes runtime が開始する。
3. Hermes 起動時に StackChan の顔が表示される。
4. 画面下端に `HERMES` 文字やアイコン断片が残らない。
5. `tools/list` に reminder 系 3 tool と `stackchan_power_off` が出る。
6. reminder create/get/stop が動く。
7. 音声会話で emotion が neutral 固定ではない。

## 完了報告に含めること

- 変更したファイル一覧。
- 起動挙動の変更点。
- 画面崩れ修正の要点。
- 追加した public MCP tools。
- 自然対話化の変更点。
- 実行した tests / build コマンドと結果。
- 実行できなかった検証があれば、その理由と代替確認手順。

## 注意

- `hermes-agent/` 本体は原則編集しないでください。
- Wi-Fi password、token、完全な WebSocket URL などの秘密情報を log や status に出さないでください。
- README と実装の tool list をずらさないでください。
- 画面操作は LVGL lock なしで行わないでください。
- HERMES 手動起動を autostart 設定で止めないでください。

---
