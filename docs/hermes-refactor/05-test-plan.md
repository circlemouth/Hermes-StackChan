# 05. Test plan

## 目的

Hermes 自動起動停止、画面引き渡し、MCP tool 公開、自然対話化が壊れていないことを確認します。

## 1. ai-server static / unit tests

### コマンド

```bash
cd ai-server
npm install
npm run build
npm test
```

### 確認項目

- TypeScript compile が通る。
- 既存 tests が通る。
- `stackchan_mcp_server.test.ts` に追加した tests が通る。
- `session.test.ts` に追加した emotion / env tests が通る。

### 追加すべき tests

#### tools/list

- `stackchan_create_reminder` が tools list に含まれる。
- `stackchan_get_reminders` が tools list に含まれる。
- `stackchan_stop_reminder` が tools list に含まれる。
- `stackchan_power_off` が tools list に含まれる。
- `stackchan_create_reminder` の required が `duration_seconds`, `message`。
- `stackchan_stop_reminder` の required が `id`。

#### MCP content normalization

- firmware image block が MCP image content へ変換される既存 test を維持。
- array/object result が text JSON として返る。
- stringified JSON result が壊れない。

#### emotion inference

- `ありがとう` → `happy`
- `ごめん` → `sad`
- `うーん、確認します` → `doubtful`
- `おやすみ` → `sleepy`
- neutral sentence → `neutral`

#### env integer parser

- env 未設定 → fallback。
- 数値文字列 → number。
- 不正値 → fallback。
- 範囲外 → clamp。

## 2. firmware build

### コマンド

```bash
cd firmware
python3 ./fetch_repos.py
idf.py build
```

### 確認項目

- `main.cpp` の追加 include が compile する。
- `Hal::prepareHermesDisplay()` declaration / definition が一致する。
- `Board::GetInstance().GetDisplay()->SetupUI()` の virtual call が compile する。
- `hal_mcp.cpp` の cJSON 使用が compile する。
- `sdkconfig.defaults` の `CONFIG_HERMES_AUTOSTART=n` が有効。

## 3. 実機起動 tests

### 3.1 設定済み device の電源投入

前提:

- Wi-Fi credential 保存済み。
- WebSocket URL 保存済み。
- ai-server は起動していても、起動していなくてもよい。

期待:

```text
電源 ON
  ↓
STACKCHAN boot logo
  ↓
Launcher
```

確認:

- HERMES が勝手に開かない。
- Launcher の icons が正常表示される。
- screen saver が通常通り動く。

### 3.2 HERMES 手動起動

手順:

1. Launcher で HERMES を選ぶ。
2. WebSocket URL と Wi-Fi readiness が揃っている状態で起動する。

期待:

- `Hermes start requested by explicit HERMES app open` が log に出る。
- Mooncake teardown log が出る。
- LVGL clean log が出る。
- StackChan avatar SetupUI log が出る。
- 顔が表示される。
- 画面下端に `HERMES` 文字や icon fragment が残らない。

### 3.3 設定不足: WebSocket URL なし

期待:

- Hermes runtime は起動しない。
- HERMES status 画面に `Bridge URL missing` が表示される。
- `Hermes autostart disabled` は表示されない。

### 3.4 設定不足: Wi-Fi credential なし

期待:

- Hermes runtime は起動しない。
- HERMES status 画面に `Wi-Fi not connected` または setup 案内が表示される。
- BLE provisioning / SETUP への導線が分かる。

## 4. ai-server / WebSocket integration tests

### 起動

```bash
cd ai-server
npm run build
npm start
```

または開発時:

```bash
npm run dev
```

### 確認項目

- StackChan firmware が `ws://<server-ip>:8765/ws` に接続できる。
- hello handshake が成功する。
- STT → LLM → TTS の音声 turn が成立する。
- post-TTS cooldown 中に TTS 自身を拾いにくい。
- emotion が返答内容に応じて変わる。

## 5. MCP tool tests

### tools/list

Hermes MCP client または直接 stdio で確認します。

```bash
cd ai-server
npm run build
node dist/stackchan_mcp_server.js
```

JSON-RPC example:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

期待:

- reminder 系 3 tool が出る。
- `stackchan_power_off` が出る。

### reminder create/get/stop

実機接続中に確認します。

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stackchan_create_reminder","arguments":{"duration_seconds":10,"message":"お茶を飲む","repeat":false}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"stackchan_get_reminders","arguments":{}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"stackchan_stop_reminder","arguments":{"id":1}}}
```

期待:

- create が成功する。
- get が JSON として壊れない。
- message に日本語、quote、改行を含めても壊れない。
- stop が成功する。

## 6. README / docs verification

確認:

```bash
rg "stackchan_create_reminder|stackchan_get_reminders|stackchan_stop_reminder|stackchan_power_off" README.md README.ja.md ai-server/src
rg "Hermes autostart disabled" firmware/main README.md README.ja.md
```

期待:

- README と README.ja.md に tool list が反映されている。
- 不適切な `Hermes autostart disabled` 表示が残っていない。
- 起動手順が「電源投入後に Launcher、HERMES 選択で開始」に更新されている。

## 7. 回帰確認 checklist

- [ ] 設定済み device で電源投入しても HERMES が自動起動しない。
- [ ] HERMES 手動起動で Hermes runtime が開始する。
- [ ] 顔が表示される。
- [ ] HERMES 文字や icon fragment が下端に残らない。
- [ ] Bridge URL missing のとき status 画面が分かりやすい。
- [ ] Wi-Fi 未設定のとき status 画面が分かりやすい。
- [ ] ai-server build/test が通る。
- [ ] firmware build が通る。
- [ ] tools/list が期待通り。
- [ ] reminder create/get/stop が動く。
- [ ] `stackchan_power_off` が README に載っている。
- [ ] emotion が neutral 固定ではない。
- [ ] VAD / cooldown env が README に載っている。
