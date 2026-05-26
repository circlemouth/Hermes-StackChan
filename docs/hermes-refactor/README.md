# Hermes startup / display / MCP tool / natural dialogue refactor

このドキュメントセットは、以下の改修を実装者または Codex などの実装エージェントに渡して完遂させるための作業指示です。

## 改修テーマ

1. Hermes の自動起動をやめる。
2. HERMES 起動時に顔が表示されず、画面下端に `HERMES` 文字とアプリアイコンの上端だけが残る問題を解決する。
3. firmware 側で実装済みだが ai-server / MCP server 側で未公開の機能を公開する。
4. Hermes と M5-stackchan がより自然に対話できるように brush-up する。

## ドキュメント構成

| ファイル | 内容 |
|---|---|
| `01-current-state-and-goals.md` | 現状、目標、非目標、完了条件 |
| `02-firmware-autostart-display.md` | firmware 側の自動起動停止と画面崩れ修正手順 |
| `03-mcp-tool-publication.md` | 未公開 tool の公開、schema、mapping、README/tests 更新 |
| `04-natural-dialogue.md` | 自然対話化の改善項目、優先度、実装案 |
| `05-test-plan.md` | firmware / ai-server / 実機確認のテスト計画 |
| `06-implementation-prompt.md` | 実装エージェントにそのまま渡す完遂プロンプト |
| `08-lcd-sd-spi-incident.md` | HERMES 起動時の LCD 顔表示失敗と SD / SPI / GPIO35 競合の調査記録 |

## 作業対象の主要ファイル

### firmware

- `firmware/sdkconfig.defaults`
- `firmware/main/Kconfig.projbuild`
- `firmware/main/main.cpp`
- `firmware/main/apps/app_launcher/app_launcher.cpp`
- `firmware/main/apps/app_ai_agent/app_ai_agent.cpp`
- `firmware/main/hal/hal.h`
- `firmware/main/hal/hal.cpp`
- `firmware/main/hal/board/stackchan_display.h`
- `firmware/main/hal/board/stackchan_display.cc`
- `firmware/main/hal/hal_mcp.cpp`

### ai-server

- `ai-server/src/device_control.ts`
- `ai-server/src/stackchan_mcp_server.ts`
- `ai-server/src/session.ts`
- `ai-server/test/stackchan_mcp_server.test.ts`
- 必要に応じて `ai-server/test/session.test.ts`

### docs

- `README.md`
- `README.ja.md`
- `firmware/README.md` は必要に応じて補足

## 推奨作業順序

1. **Firmware 起動挙動修正**
   - `CONFIG_HERMES_AUTOSTART` の default を off にする。
   - Launcher から HERMES を勝手に開かないようにする。
   - HERMES アプリを手動で開いた場合は Hermes runtime を起動できるようにする。

2. **Hermes display handoff 修正**
   - Mooncake teardown 後に LVGL screen / layer を完全に clean する。
   - Hermes runtime 起動前に StackChan avatar screen を明示構築する。
   - `StackChanAvatarDisplay::SetupUI()` を重複呼び出しに対して安全に保つ。

3. **MCP tool 公開**
   - reminder 系 tool を ai-server / MCP server に追加する。
   - `stackchan_power_off` を README の tool list に反映する。
   - firmware 側の reminder JSON を安全化する。

4. **自然対話化**
   - tool descriptions を「対話中の身体性」を意識した説明にする。
   - emotion inference を `neutral` 固定から改善する。
   - listen / thinking / speaking / idle の表示状態を分かりやすくする。
   - VAD / cooldown を環境変数で調整可能にする。

5. **検証**
   - `ai-server`: `npm run build && npm test`
   - `firmware`: `idf.py build`
   - 実機: Launcher 停止、HERMES 手動起動、顔表示、tool call、音声対話

## 優先度

最優先は **Hermes 自動起動停止** と **顔が表示されない画面崩れの修正**です。これらが壊れていると実機確認が不安定になり、MCP tool や自然対話の検証も進めにくくなります。

未公開 tool 公開は第 2 優先です。自然対話化は第 3 優先ですが、tool description と emotion heuristic は小さな変更で効果が大きいため、同じ PR に含めても構いません。
