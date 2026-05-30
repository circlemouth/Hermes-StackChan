# AGENTS.md

このファイルは、このリポジトリ全体で作業する実装エージェント向けの作業規約です。`hermes-agent/` 配下には既存の `hermes-agent/AGENTS.md` があるため、その配下を編集する場合はそちらを優先してください。

## プロジェクト概要

Hermes-StackChan は、M5Stack CoreS3 / M5-stackchan を HermesAgent の物理インターフェースとして動かすための複合リポジトリです。

- `firmware/`: ESP32-S3 / M5Stack CoreS3 用ファームウェア。画面、音声、サーボ、LED、タッチ、IMU、カメラ、WebSocket 接続を担当します。
- `ai-server/`: StackChan ファームウェアと HermesAgent を接続する TypeScript WebSocket bridge。音声変換、STT/TTS helper 呼び出し、robot control HTTP、StackChan MCP server を担当します。
- `app/`: セットアップ用 Flutter アプリ。
- `remote/`: ESP-NOW リモコン側コード。
- `hermes-agent/`: HermesAgent 本体。基本的には外部プロジェクトとして扱い、今回の StackChan 連携作業では必要がない限り編集しません。

## 重要な作業方針

1. **M5Stack 単体で AI を完結させようとしない。** STT、LLM、TTS、記憶、スキル実行は `ai-server/` と HermesAgent 側で行います。ファームウェアは物理 I/O と表示、ロボット制御を担当します。
2. **Hermes 自動起動と Hermes 手動起動を混同しない。** 電源投入後に Launcher から勝手に HERMES を開く動作は default off にします。一方で、ユーザーが HERMES アプリを明示的に開いた場合は、条件が揃っていれば Hermes runtime を起動します。
3. **LVGL オブジェクト操作は必ずロック下で行う。** `LvglLockGuard`、`DisplayLockGuard`、既存 display lock API を使い、ロックを二重取得しないよう注意してください。
4. **Mooncake UI から Hermes runtime への画面引き渡しを明確にする。** Mooncake アプリ破棄後、古い Launcher / HERMES 画面断片を残さず、Hermes avatar screen を明示的に構築してから runtime を開始します。
5. **公開 MCP tool と firmware tool mapping を同期させる。** firmware 側に実装済みの tool を `ai-server/src/device_control.ts` と `ai-server/src/stackchan_mcp_server.ts` で公開する場合、README と tests も更新してください。
6. **機密情報を露出しない。** Wi-Fi password、完全な WebSocket URL、token、credential は log、status、tool result、README 例に出さないでください。status では scheme/host 程度に留めます。

## 今回の改修ドキュメント

Hermes 自動起動停止、画面崩れ修正、未公開 tool 公開、自然対話化の作業では、まず以下を読んでください。

- `docs/hermes-refactor/README.md`
- `docs/hermes-refactor/01-current-state-and-goals.md`
- `docs/hermes-refactor/02-firmware-autostart-display.md`
- `docs/hermes-refactor/03-mcp-tool-publication.md`
- `docs/hermes-refactor/04-natural-dialogue.md`
- `docs/hermes-refactor/05-test-plan.md`
- `docs/hermes-refactor/06-implementation-prompt.md`

## ai-server 作業規約

- 言語: TypeScript。
- テスト: Node.js built-in test runner。Jest ではありません。
- 主なコマンド:

```bash
cd ai-server
npm install
npm run build
npm test
```

- `ai-server/src/stackchan_mcp_server.ts` は stdio MCP server です。`tools/list` と `tools/call` の JSON-RPC 形を壊さないでください。
- `ai-server/src/device_control.ts` は local robot control HTTP server です。StackChan 実機が未接続の場合は会話全体を落とさず、明確な error を返す設計を維持してください。
- firmware tool result は stringified JSON の場合があります。`normalizeFirmwareResult` / `normalizeBridgeResultToMcpContent` の互換性を保ってください。
- image path / URL の扱いは `ai-server/src/media.ts` に寄せ、MCP server で直接 path 変換を増やしすぎないでください。

## firmware 作業規約

- Toolchain: ESP-IDF v5.5.4 系。
- 主なコマンド:

```bash
cd firmware
python3 ./fetch_repos.py
idf.py build
idf.py flash
idf.py monitor
```

- `firmware/main/main.cpp` は Mooncake アプリ群から Hermes runtime への移行点です。ここで UI teardown と Hermes start request を扱います。
- `firmware/main/apps/app_launcher/` は Launcher と自動起動制御を担当します。
- `firmware/main/apps/app_ai_agent/` は HERMES アプリを開いたときの設定確認と Hermes runtime start request を担当します。
- `firmware/main/hal/hal.cpp` / `hal.h` は Hermes runtime 開始前後の HAL 制御を担当します。
- `firmware/main/hal/board/stackchan_display.*` は Hermes avatar 表示、顔、感情、status、chat bubble、preview image を担当します。
- `firmware/main/hal/hal_mcp.cpp` は firmware-side MCP tools を登録します。JSON は手書き文字列連結ではなく `cJSON` など安全な方法で作ってください。
- LVGL screen / layer / object の clean / delete は race を起こしやすいため、必ず lock と ownership を確認してください。
- `StackChanAvatarDisplay::SetupUI()` は複数回呼ばれても壊れない、または duplicate call を安全に skip できる状態を保ってください。
- CoreS3 / StackChan の LCD と SD card は共有 SPI / GPIO35 を使うため、SD access と LCD update は強く干渉します。SD card access は Setup の明示操作に限定し、成功後は restart required としてください。
- LVGL 管理下の LCD を application code から `esp_lcd_panel_draw_bitmap()` で直接描画しないでください。

## CoreS3 / StackChan LCD・SD 共有 SPI の安全規約

M5Stack CoreS3 / StackChan では LCD と SD card が SPI3 を共有し、GPIO35 が LCD DC と SD MISO を兼ねる。このため、表示中・起動直後・HERMES handoff 直前に SD card を触る実装は LCD 黒画面や描画崩れの原因になります。

### 禁止事項

- Launcher 起動時に SD config を自動 import しない。
- HERMES app open / Hermes runtime handoff 直前に SD card を読まない。
- LVGL / esp_lvgl_port 管理下の LCD に対して、application code から `esp_lcd_panel_draw_bitmap()` を直接呼ばない。
- boot clear / handoff clear のために一時 `std::vector<uint16_t>` を LCD DMA 転送元にしない。
- SD config import 成功後に、そのまま HERMES runtime を起動しない。
- `restore_shared_spi_for_display()` があるから安全、という前提で SD access を追加しない。
- SD card 未挿入確認のために、表示中の画面から SD SPI probe / mount を直接実行しない。短い CMD0 probe だけでも GPIO35 を LCD DC から SD MISO に切り替えるため、処理は戻っても物理 LCD だけが更新不能になることがあります。
- SD access 後に同じ LVGL 画面へ戻って error UI / Retry / Back を描画しようとしない。ログ上は task が生きていても LCD flush だけ死ぬ既知故障につながります。

### 必須事項

- SPI3 初期化前に SD_CS(GPIO4) と LCD_CS(GPIO3) を inactive high に固定する。
- SD config import は明示的な Setup UI 操作に限定する。
- SD config import は、SD card 挿入確認画面を表示してから実行する。確認画面では SD に一切触らない。
- SD config import 実行後は、成功・失敗に関係なく restart する。SD 未挿入、mount 失敗、parse 失敗でも LCD 復帰のため再起動する。
- 設定値は NVS に保存し、通常起動時・HERMES 起動時は NVS から読む。
- 表示系の成功判定はログだけでなく、実機 LCD 目視または screenshot/capture で確認する。

### デバッグ指針

以下のログが出ていても、物理 LCD 表示が成功したとは限りません。

- `Hermes avatar SetupUI complete`
- `Application::Run start`
- `SetStatus: Standby`
- `Start idle motion`

これらは runtime と LVGL object 構築の進行を示すだけで、LCD panel IO / SPI / GPIO35 が正常であることは保証しません。

SD config import でも同じです。`SD probe result: ESP_ERR_NOT_FOUND`、`SD mount failed`、`HAL SD config loader returned` が出ていても、物理 LCD が復帰したとは限りません。SD に触った後に画面だけ `Reading SD card...` のまま固まり、serial log と task は動き続ける場合があります。この場合、原因は SD 処理のハングではなく LCD/SPI/GPIO35 の復帰失敗として扱い、SD access 後の再描画ではなく restart 前提の flow にしてください。

## README / docs 更新規約

- public tool を追加・削除・rename した場合は、`README.md` と `README.ja.md` の tool list と設定手順を更新してください。
- 起動挙動を変えた場合は、`README.md` / `README.ja.md` の起動手順と troubleshooting を更新してください。
- 日本語 README と英語 README の意味がずれないようにしてください。

## 推奨実装順序

1. 起動挙動と画面引き渡しを直す。
2. firmware build が通る状態にする。
3. ai-server の tool mapping と MCP tool definitions を更新する。
4. ai-server tests を追加して build/test を通す。
5. README / docs を更新する。
6. 実機で起動、HERMES 手動起動、音声対話、tool call を確認する。

## 禁止・注意事項

- `hermes-agent/` 本体を今回の StackChan firmware / ai-server 改修のために安易に編集しないでください。
- Wi-Fi password、token、個人の absolute path を commit しないでください。
- 画面更新を複数 task から lock なしで行わないでください。
- Hermes 自動起動を無効にした結果、HERMES アプリの手動起動まで無効化しないでください。
- README だけ直してコードを直さない、またはコードだけ直して README/tests を更新しない状態で完了扱いにしないでください。

## 完了条件

最低限、以下を満たすこと。

- 電源投入後、設定済みでも Launcher に留まり、HERMES が勝手に起動しない。
- HERMES アプリを明示的に開くと、条件が揃っている場合 Hermes runtime が起動する。
- Hermes 起動時に StackChan の顔が表示され、画面下端に `HERMES` 文字やアプリアイコン断片が残らない。
- firmware に実装済みで ai-server 側未公開だった reminder 系 tool が public MCP tool として公開される。
- `stackchan_power_off` を含む実装済み public tool が README に反映される。
- ai-server の `npm run build` と `npm test` が通る。
- firmware の `idf.py build` が通る、または実行できない環境では未実行理由と想定確認手順を明記する。
