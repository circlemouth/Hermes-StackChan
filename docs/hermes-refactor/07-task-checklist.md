# 07. Task checklist

この checklist は実装中の進捗管理用です。

## Phase 1: Hermes 自動起動停止

- [ ] `firmware/sdkconfig.defaults` で `CONFIG_HERMES_AUTOSTART=n` にする。
- [ ] `firmware/main/Kconfig.projbuild` の説明を「Launcher auto open」用途に修正する。
- [ ] `AppLauncher::try_auto_open_hermes()` が `CONFIG_HERMES_AUTOSTART=y` のときだけ動くことを確認する。
- [ ] `AppAiAgent::onOpen()` から runtime start 条件としての `hermes_autostart_enabled()` を外す。
- [ ] HERMES 手動 open で readiness が OK なら `GetHAL().requestHermesStart()` を呼ぶ。
- [ ] `Hermes autostart disabled` という status 表示をなくす。

## Phase 2: Hermes display handoff 修正

- [ ] `main.cpp` の Mooncake teardown 前後に log を追加する。
- [ ] Mooncake teardown 後、boot logo / home indicator / status bar を破棄する。
- [ ] LVGL top layer を clean する。
- [ ] LVGL active screen を clean し、黒背景、scrollbar off、scrollable flag 削除を行う。
- [ ] `Hal::prepareHermesDisplay()` を `hal.h` / `hal.cpp` に追加する。
- [ ] `prepareHermesDisplay()` で display の `SetupUI()` を呼ぶ。
- [ ] `main.cpp` で `prepareHermesDisplay()` を `startHermes()` より前に呼ぶ。
- [ ] `StackChanAvatarDisplay::SetupUI()` の duplicate call が安全であることを確認する。
- [ ] Hermes 起動時に顔が表示され、画面断片が残らないことを実機で確認する。

## Phase 3: MCP tool 公開

- [ ] `ai-server/src/device_control.ts` の `StackChanToolName` に reminder 系 3 tool を追加する。
- [ ] `TOOL_MAP` に reminder 系 3 mapping を追加する。
- [ ] `stackchan_create_reminder` の args を validate / normalize する。
- [ ] `stackchan_stop_reminder` の `id` を validate する。
- [ ] `ai-server/src/stackchan_mcp_server.ts` に reminder 系 tool definitions を追加する。
- [ ] `stackchan_power_off` が `tools/list` にあることを確認する。
- [ ] `firmware/main/hal/hal_mcp.cpp` の `get_reminders` JSON を cJSON 等で安全化する。
- [ ] README.md の tool list を更新する。
- [ ] README.ja.md の tool list を更新する。
- [ ] MCP server tests を追加する。

## Phase 4: 自然対話化

- [ ] `inferStackChanEmotion()` を追加する。
- [ ] LLM 返答後の emotion を `neutral` 固定から inference に変更する。
- [ ] emotion inference tests を追加する。
- [ ] env int parser を追加する。
- [ ] `STACKCHAN_SILENCE_TIMEOUT_MS` を追加する。
- [ ] `STACKCHAN_MAX_RECORDING_MS` を追加する。
- [ ] `STACKCHAN_MIN_FRAMES_FOR_STT` を追加する。
- [ ] `STACKCHAN_POST_TTS_COOLDOWN_MS` を追加する。
- [ ] env parser tests を追加する。
- [ ] `stackchan_set_head_angles` description を自然対話向けに改善する。
- [ ] `stackchan_set_led_color` description を自然対話向けに改善する。
- [ ] README の `.env` 例を更新する。

## Phase 5: build / tests

- [ ] `cd ai-server && npm install` を実行する。
- [ ] `cd ai-server && npm run build` が通る。
- [ ] `cd ai-server && npm test` が通る。
- [ ] `cd firmware && python3 ./fetch_repos.py` を必要に応じて実行する。
- [ ] `cd firmware && idf.py build` が通る。

## Phase 6: 実機確認

- [ ] 設定済み device の電源投入後、Launcher に留まる。
- [ ] HERMES が自動起動しない。
- [ ] HERMES 手動起動で Hermes runtime が始まる。
- [ ] 顔が表示される。
- [ ] 画面下端に HERMES 文字や icon fragment が残らない。
- [ ] WebSocket URL なしで `Bridge URL missing` が出る。
- [ ] Wi-Fi 未設定で Wi-Fi setup 案内が出る。
- [ ] 音声会話が成立する。
- [ ] emotion が neutral 固定ではない。
- [ ] `stackchan_create_reminder` が動く。
- [ ] `stackchan_get_reminders` が JSON として壊れない。
- [ ] `stackchan_stop_reminder` が動く。
- [ ] `stackchan_power_off` はユーザーが明示した場合だけ使われる。

## Phase 7: 完了報告

- [ ] 変更ファイル一覧を書く。
- [ ] 仕様変更を要約する。
- [ ] 実行した command と結果を書く。
- [ ] 実行できなかった test があれば理由を書く。
- [ ] 実機確認結果を書く。
- [ ] 残課題があれば明記する。
