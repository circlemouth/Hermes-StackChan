# 10. Runtime audit resolution / 実行時監査対応

対象は commit `0b7138a8a191c6df28f1fab1ff742f907b95a14b` に対する添付監査の **確定指摘 R01–R26** と、確定指摘に加算しない **実機検証候補 V01–V06** です。実装の統合、host 回帰試験、実機・外部 backend の合格は別々に記録します。

## Validation status / 検証状況

**実装・host 回帰・cross build 合格 / Implementation, host regressions and cross build passed.** Bridge build と全 362 tests、Firmware host 12 targets と ESP-IDF v5.5.4 build が合格しました。managed/Xiaozhi patch の再現性、codec strict build・ASan/UBSan、EOF ISR/atomic の ELF IRAM 配置も確認済みです。表は実装修正と検証条件の対応表であり、実機・外部 backend の合格宣言ではありません。

| 検証 | 状態 | 証拠として必要なもの |
|---|---|---|
| Bridge 全体 TypeScript build / Node tests | **PASS** | `npm run build` / `npm test` exit 0、362 tests / 362 pass / 0 fail・skip・cancel。runtime audit test 4 files と local audio cancel test の strict `tsc --noEmit --allowImportingTsExtensions` も exit 0 |
| Firmware host regressions / ESP-IDF v5.5.4 build | **PASS** | Debug CTest 12/12、pinned patch forward/reverse と production source 一致、codec strict build・ASan/UBSan（leak detection 有効）、`idf.py build` exit 0。EOF ISR と 32-bit atomic の IRAM 配置・S32C1I 命令を ELF で確認 |
| M5Stack CoreS3 / StackChan 実機・flash | 未実施 | 本文の故障注入・LCD 目視・音声・連続運転 matrix |
| 外部 Hermes / EVO の実推論、実 STT/TTS provider | 未実施 | 許可済み環境での実際の推論・音声 turn、停止・遅着・再接続 |
| PipeWire / Bluetooth の物理可聴性 | 未実施 | M5 消音、player 終了、復元・文再送を耳とログで確認 |

Host の fake transport、local fixture HTTP server、プロセス fixture、policy assertion、cross build はそれぞれ有用ですが、実推論・ESP32 driver 動作・物理 LCD・可聴性を証明しません。監査に同梱された不具合再現 assertion の成功も、修正後の合格数として転用しません。

## Recovery contract / 復旧契約

- `STACKCHAN_TURN_TIMEOUT_MS=180000` が既定の turn 全体期限です（設定範囲 1000–600000 ms）。録音終了後の STT、Hermes transport 起動・session 作成・回答、TTS を同じ絶対時刻で覆います。個別 helper timeout は残り期限を延長せず、短い方を採用します。HTTP body のキャンセルと Python/ffmpeg/player の終了回収を行い、遅着結果は turn 所有権で排除します。TERM→KILL/reap、Children 旧 ID の close、driver cleanup は期限後も上限付きで完了を待つ場合があり、期限を物理的な強制停止時刻とはみなしません。
- RPC の中断・失敗・期限切れは旧 transport/session generation を隔離します。次の producer を旧 session に入れてから遅い interrupt ACK で破壊してはいけません。成功 turn は履歴を継続します。Children は毎 turn status/profile/voice 権限を再確認し、heartbeat/cancel failure・session expiry・owner 変更後は旧 session を隔離して再作成、権限失効時は fail closed です。成功 cancel ACK 後は既存 session を継続できます。TTS 待ちで iterator が停止していても中断完了時に active 所有権を解放し、旧 finally が新 turn を cancel しないよう同じ cancellation を共有します。Children の session 作成中も caller は期限・キャンセルで即時に戻り、独立した上限付き cleanup が遅い ID を旧認可で close します。遅い ID を新 turn に設置しません。中断済みの認可 request がまだ回収中なら、新 caller 自身の期限内で drain して再認可し、旧 caller の abort を次 turn に継承しません。既に実行済みの外部 tool の副作用はローカル中断では取り消せません。
- 短い肯定・否定を既定で拒否しません。明示 `listen.start` は cooldown を解除し、暗黙の cooldown 音声は上限付き buffer から次の capture に渡します。通知は FIFO、ユーザー capture は優先です。VAD 開始未確定の有声語頭や barge-in 検出 ring も、通知のために消去しません。無音だけの capture は通知を永久に足止めしません。
- Robot control は最初の hello 完了端末が所有し、所有者切断時に最も古い残存 hello 完了端末へ移ります。後続端末・hello のない確認接続が所有者を奪いません。
- 外部再生は `permanent:false`、30 秒の `lease_ms`、turn ごとの `lease_id` で M5 を一時消音し、10 秒ごとに更新します。firmware は最初の消音直前の runtime 音量を保存し、解放・期限切れ・切断で復元します。一時 mute/更新/復元は NVS を書きません。永久音量変更は lease を無効化し、旧 ID の復元要求は新設定を上書きしません。
- lease ID と整数音量を含む厳密な ACK がなければ外部再生しません。復元成功を boolean や不正 content だけで判断しません。復元 ACK が失われた場合も、厳密な status で lease 解放済みを確認できない限り責任を捨てません。物理的に既に期限切れで復元されている場合の再照合は、次の TTS を永久に閉塞させないために必要です。
- Local player の位置は推測しません。途中失敗時は元の avatar frame 送信を止め、player の終了回収を待ち、消音状態で端末 queue/decoder を reset、復元 ACK を確認し、**ACK 後の新しい decoder/admission reset** を経てから **文全体を 1 回** M5 に再送します。既に外部で聞こえた prefix の重複はあり得ますが、suffix を先に聞かせてから全文を再送しません。live 合成と cached fast-ack の両方が対象です。

<a id="integration-status"></a>
## Integration status / 対になる protocol の統合状況

Lease 対応 bridge と firmware は対で配布してください。旧 firmware は `lease_ms`/`lease_id` と切断・期限切れ復元を保証できず、旧 ACK では外部再生を許可しません。

文再送用の bridge message は `{"type":"tts","state":"start","reset":true}` です。現行 [Application](<../../firmware/xiaozhi-esp32/main/application.cc>) はすべての `tts.start` で decoder を同期 reset してから音声を許可します。`reset` flag 専用の分岐に依存する契約ではありません。[Session](<../../ai-server/src/session.ts>) は消音中の queue 破棄に加え、復元 ACK 後にも新しい reset を要求します。lease 解放は admission を dirty にし、次 segment は streaming 所有権を speaker await より先に予約します。合成中・復元中・cancel 後の遅い ACK でも、旧 epoch の継続や suffix-first 再生を許可しません。live/cached/更新失敗経路、全文 1 回の再送、初回・次回合成の通常/cancel 競合は [local audio regressions](<../../ai-server/test/session_local_audio_cancel.test.ts>) で合格しました。古い firmware へ reset message だけを送っても保証にはなりません。

[Codec runtime](<../../firmware/main/hal/board/cores3_audio_codec_runtime.cc>) と [AudioService](<../../firmware/xiaozhi-esp32/main/audio/audio_service.cc>) の復元契約は以下です。

- packet を最初に受理した output epoch を decode → PCM まで保持し、stale/draining PCM は hardware enable/write より前に拒否します。queue lock を保持したまま codec mutex を取得しません。
- retirement は出力を fence し、直接 hardware mute と wrapper の cached mute を両方更新します。出力が未 open/既に disabled でも、次の open が cached unmute を再適用しないことが必要です。fence/reopen 後の TX EOF を 7 回（6 DMA descriptors + guard）観測してから保存音量を復元し、ACK 時点でも epoch を無効化します。固定 sleep を成功根拠にしません。
- lease poll は try-lock で待機せず、drain は絶対期限 500 ms、失敗後は 1 秒 backoff で再試行します。失敗時も lease/mute/fence の責任を保持します。ISR counter は別の 4-byte internal-RAM allocation に置きます。PSRAM workaround 下の C++ lock-free trait ではなく、target S32C1I と ELF の IRAM 配置を確認しました。
- managed codec は control/format/enable/close error と最初の directional error を保持します。codec/data/software close がすべて成功するまで opened ownership を消さず、再 open 前にも cleanup を検証します。I2S の正規化後に同一の format は clock を再構成せず、pending peer の失敗を成功扱いしません。

これらは [Firmware regressions](<../../firmware/tests/README.md>) と cross build で検証済みですが、実 DMA/FIFO/analog tail、無音、duplex clock 継続は実機で判定します。

URL は [共通 policy](<../../firmware/xiaozhi-esp32/main/websocket_endpoint_policy.h>) と [resolver](<../../firmware/xiaozhi-esp32/main/websocket_endpoint.h>) を UI/readiness/status/SD/Application/transport/migration で共有します。小文字 `ws`/`wss`、ASCII DNS/IPv4/bracket IPv6、port 1–65535、path/query の percent encoding を検証し、空 host、userinfo、fragment、raw 空白/制御文字、backslash、不正 escape を拒否します。有効な URL の byte 列は trim せず保持します。空でない無効 override は legacy に逃がさず fail closed、有効な legacy だけ一度移行します。[resolver tests](<../../firmware/tests/websocket_endpoint_test.cpp>) と [policy tests](<../../firmware/tests/runtime_safety_test.cpp>) は現行 source で合格しています。

## R01–R26 修正・検証対応表

以下の「修正」は実装方針・統合先です。**Bridge/Firmware host regressions と ESP-IDF build は合格、実機手順は未実施**です。リンク先に test が存在しても、その名前だけで全 interleaving を網羅したとはしません。

| ID | 修正方針・実装先 | 回帰試験 / 手動合格条件 |
|---|---|---|
| R01 | [Hermes RPC](<../../ai-server/src/hermes.ts>) で stdio child の `error`/即時 exit を捕捉し、開始失敗を reject、後続 retry を許可。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>): executable/cwd 不在、即時 exit、設定訂正後 retry。 |
| R02 | [Session](<../../ai-server/src/session.ts>) が非同期 dispose rejection を回収。[Children](<../../ai-server/src/children_hermes.ts>) の dispose を上限付き・冪等化。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>) / [Children audit tests](<../../ai-server/test/children_runtime_audit.test.ts>): close を重ねても unhandled rejection なし。 |
| R03 | [RPC](<../../ai-server/src/hermes.ts>) の transport startup、HTML/body/WS handshake、`session.create` も turn 絶対期限・cancel 対象。startup/create を single-flight 化。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>) / [Children audit tests](<../../ai-server/test/children_runtime_audit.test.ts>): 各段の無応答、遅い setup 完了、既に expired/aborted の入力、次 turn の recovery。helper と turn の同期限 timer 競合や timer callback 前の遅い RPC error も turn の期限切れとして返し、timer の丸めで絶対期限前に expire しない。Children create 中の abort/deadline/interrupt は未完了 response を待たずに戻り、遅い ID は旧 owner で close、新 session を汚染しない。 |
| R04 | [Session](<../../ai-server/src/session.ts>) → [Hermes audio](<../../ai-server/src/hermes_audio.ts>) / [audio](<../../ai-server/src/audio.ts>) / [Children](<../../ai-server/src/children_hermes.ts>) に共通 signal/deadline を渡す。body/process を終了回収。 | [audio audit tests](<../../ai-server/test/audio_runtime_audit.test.ts>), [Children audit tests](<../../ai-server/test/children_runtime_audit.test.ts>), [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>): 停止 body/Python/ffmpeg、STT/TTS expiry と retry。LLM 完了後の TTS timeout → 次の queued producer は retirement 完了を待ち、旧 deadline が新しい human capture を reset しない。 |
| R05 | [Children](<../../ai-server/src/children_hermes.ts>) は heartbeat/cancel failure・expiry・owner 変更時の session を隔離、再認可後に recreate。成功 cancel ACK 後も次 turn の権限を再確認。permission revoke は recovery で迂回しない。 | [Children audit tests](<../../ai-server/test/children_runtime_audit.test.ts>): heartbeat/cancel failure、session expiry、owner rotation、voice revoke/re-enable。認可 HTTP の abort cleanup が未完了でも次 turn は旧失敗を継承せず再認可し、その drain 待ちにも新 turn の絶対期限を適用。 |
| R06 | [HERMES app](<../../firmware/main/apps/app_ai_agent/app_ai_agent.cpp>) の Wi-Fi readiness を期限付き非ブロッキング確認にし、失敗理由を表示、Home を維持。 | 実機: AP 不在・誤 password・DHCP 不成立・bridge 不在で Home 可用。復旧後の明示起動成功。自動 boot は off。 |
| R07 | [MCP server](<../../firmware/xiaozhi-esp32/main/mcp_server.cc>) は bounded worker/queue と generation/deadline で tool を main event loop から分離。 | 実機: preview/camera/診断音の遅延・停止中も Home/state 遷移可能。queue 過負荷と切断後の遅着結果を明示拒否。 |
| R08 | driver の fatal abort を返却可能な失敗へ変更し、read 失敗後に fabricated value を使った register write を禁止。共通 [runtime policy](<../../firmware/xiaozhi-esp32/main/runtime_safety.h>) で失敗所有権を保持。 | Firmware host fault-policy regression と実機の単発/連続 I2C 失敗: reboot/panic ではなく明確な失敗、制御された recovery。 |
| R09 | [Session transcript filters](<../../ai-server/src/session.ts>) は意味のある短い返答を標準で受理。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>) / [Session tests](<../../ai-server/test/session.test.ts>): はい/うん/了解/なるほど/わかった/OK/いいえが Hermes に到達。実 STT 認識は別途。 |
| R10 | [Session](<../../ai-server/src/session.ts>) は明示 listen で cooldown bypass、暗黙入力は bounded buffer に保持して replay。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>) / [Session tests](<../../ai-server/test/session.test.ts>): explicit/implicit ingress。実機: TTS 後 0/300/1000/1600 ms の語頭が残る。 |
| R11 | [RPC](<../../ai-server/src/hermes.ts>) は generation/session identity と transport retirement で旧回答を隔離、成功時のみ履歴継続。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>): A timeout → B 開始 → A delta/completion 遅着でも B 汚染なし。重複 public turn を明示拒否。 |
| R12 | [RPC](<../../ai-server/src/hermes.ts>) の interrupt は remote ACK/event を待たず local waiter/iterator を起床させ、旧 producer を隔離。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>) / [Children audit tests](<../../ai-server/test/children_runtime_audit.test.ts>): ACK のみ、event なし、連続 interrupt、setup 中 interrupt、completion/token 上で consumer が TTS 待ち中の interrupt/abort/dispose。旧 iterator は queued event を出さず、新 turn の所有権・cancellation を破壊しない。 |
| R13 | [Session](<../../ai-server/src/session.ts>) の finish/idle 遷移で通知 FIFO を drain。active capture と [VAD](<../../ai-server/src/local_vad.ts>) の candidate voiced onset を保護。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>): idle/quiet listen/FIFO/capture、有声 candidate → notice、無音・拒否 VAD による FIFO 解放、cooldown buffer と notice、barge-in prefix と queued notice の競合。 |
| R14 | [codec lease](<../../firmware/main/hal/board/cores3_audio_codec_runtime.cc>) と [MCP ACK](<../../firmware/main/hal/hal_mcp.cpp>)、[Session](<../../ai-server/src/session.ts>) が 30 s/10 s lease、expiry/disconnect/永久設定解除、厳密 ACK・status 再照合を連携。 | [local audio tests](<../../ai-server/test/session_local_audio_cancel.test.ts>): mute/restore ACK failure、更新 failure、ownership。実機: mute 直後 bridge kill、restore ACK 消失、lease expiry、永久音量変更後の stale restore。旧 firmware は保証対象外。 |
| R15 | [Session](<../../ai-server/src/session.ts>) が local failure の元送信を停止し、reap → muted decoder reset → verified restore → post-ACK decoder/admission reset → 全文 replay。live/cached 両方。 | [local audio tests](<../../ai-server/test/session_local_audio_cancel.test.ts>): 先頭/途中/renew failure で suffix-first を禁止し、全文を 1 回送信。実機は外部音声が部分重複しても欠落しないことを確認。 |
| R16 | [audio RIFF parser](<../../ai-server/src/audio.ts>) は chunk/padding/宣言境界を検証。PCM 8/16/24/32、float 32/64、extensible format、stereo downmix に対応。 | [audio audit tests](<../../ai-server/test/audio_runtime_audit.test.ts>): LIST/JUNK、奇数 chunk、stereo duration、不完全 header/data、形式・alignment 異常。 |
| R17 | [CoreS3 codec](<../../firmware/main/hal/board/cores3_audio_codec_runtime.cc>) は read/write 戻り値・実転送量を検証し、失敗を正常扱いしない。診断 tool もエラーを返す。 | [Codec/control/I2S production regressions](<../../firmware/tests/README.md>): read/write/format/enable/control/close failure、部分転送、first-error/ownership 保持、未 cleanup の再 open 拒否。実機: 同じ故障注入と診断音で false success がない。 |
| R18 | [FT6336 / PollTouchpad](<../../firmware/main/hal/board/stackchan.cc>) は read failure 時にも HAL bridge に release を公開し、LVGL の pressed 残留を防ぐ。 | Firmware host regression と実機: press → 単発/連続 read failure で bridge/LVGL へ release が伝わり、復旧後の再タップが正常。 |
| R19 | [base AudioCodec](<../../firmware/xiaozhi-esp32/main/audio/audio_codec.cc>) は保存済み音量 `0` を有効値として維持。 | Firmware host volume-policy regression。実機: mute 0 を保存して cold boot/USB reset 後も 0、lease restore と整合。 |
| R20 | [power Setup worker](<../../firmware/main/apps/app_setup/workers/ai_agent.cpp>) は `Save (Restart Required)`、[status](<../../firmware/main/hal/hal_mcp.cpp>) は `power_settings_apply:"next_restart"`。古い live timer を新設定と偽らない。 | 実機: auto-OFF → Off、充電中設定変更を保存し、再起動前の反映要求がないことと再起動後の新 policy を確認。 |
| R21 | [SD config](<../../firmware/main/hal/utils/sd_config/sd_config.cpp>) / [credential policy](<../../firmware/xiaozhi-esp32/main/runtime_safety.h>) は Wi-Fi credential の前後空白を保存、制御文字/NUL を拒否。URL の byte 保持・妥当性検証と分離。 | Firmware host policy regression。実機: 空白を含む SSID/password で接続、制御文字は秘密値を表示せず error。 |
| R22 | [device control](<../../ai-server/src/device_control.ts>) は negotiated Session 集合と first-owner/promotion を管理し、[Session](<../../ai-server/src/session.ts>) は hello 後だけ登録。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>): A/B 接続、非 owner B close、owner A close、hello 未実施確認接続。 |
| R23 | [RPC](<../../ai-server/src/hermes.ts>) の transport/session setup は shared promise と generation gate で single-flight 化。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>): simultaneous setup で startup/create は 1 回、failure/dispose/late setup の retry。 |
| R24 | [Session](<../../ai-server/src/session.ts>) は barge-in の copied ring を次の capture 開始時に通知 drain より先に移す。 | [Session audit tests](<../../ai-server/test/session_runtime_audit.test.ts>): 全 detection frame が STT に渡り、先頭が無音でも queued notice に奪われない。実機では単音節・短い否定・名前呼びかけを確認。 |
| R25 | [endpoint resolver](<../../firmware/xiaozhi-esp32/main/websocket_endpoint.h>) と [共通 URL policy](<../../firmware/xiaozhi-esp32/main/websocket_endpoint_policy.h>) に override-first 選択・validation・legacy 移行を集約し、UI/SD/status/Application/transport を統一。無効 override は fail closed。 | [resolver](<../../firmware/tests/websocket_endpoint_test.cpp>) / [URL policy](<../../firmware/tests/runtime_safety_test.cpp>) host regression。実機: `url=A/override=B`、空値、不正 scheme/host の各組合せで事前表示と実接続が一致。秘密の full URL は記録しない。 |
| R26 | [RPC JSON validation](<../../ai-server/src/hermes.ts>) は null/array/欠落必須 field を protocol error とし、受信 callback の TypeError を防ぐ。 | [RPC audit tests](<../../ai-server/test/hermes_runtime_audit.test.ts>): null/array/空 object/不完全 event/正常 response、異常後の新 session recovery。 |

## V01–V06 hardening / 実機で判定する候補

これらは監査で実際の故障が確定していない候補です。対策を追加しても、host assertion/build だけで実機解消としません。

| ID | Hardening / 確認先 | 未実施の実機合格条件 |
|---|---|---|
| V01 | [preview download/decode](<../../firmware/main/hal/hal_mcp.cpp>) は受信中の byte 上限、cancel/deadline、decode 前の dimension/pixel 上限、失敗時解放を設ける。[policy](<../../firmware/xiaozhi-esp32/main/runtime_safety.h>) を host 検証。 | Content-Length なし・oversized/高解像度 JPEG/PNG、truncated payload、低 PSRAM を与え、heap 回復・UI 応答・OOM/panic の有無を測定。 |
| V02 | [Application](<../../firmware/xiaozhi-esp32/main/application.cc>) は TTS transport admission を generation で保護し、decoder reset 後に受信許可。UI Speaking の scheduled 遷移と先頭 PCM の race を分離。 | zero-preroll/cached 音声で start/first-frame/state 時刻を照合し、語頭欠落なし。stop/abort/start が重なって旧音声の再開なし。 |
| V03 | [Session barge-in](<../../ai-server/src/session.ts>) は既定 off。RMS/VAD 閾値は AEC の代替ではない。 | M5 単体・外部スピーカー、距離・音量・AEC/listening mode 別に自己割込みが起きず、意図した割込みの語頭が残る。 |
| V04 | [display](<../../firmware/main/hal/board/stackchan_display.cc>) と [owned lock policy](<../../firmware/xiaozhi-esp32/main/runtime_safety.h>) は lock 未取得時に LVGL を更新しない。 | 故意の長時間 lock 保持、低 memory、image 表示を重ね、未取得更新・二重 lock・servo I/O を lock 内で行わず復旧。 |
| V05 | [camera](<../../firmware/xiaozhi-esp32/main/boards/common/esp32_camera.cc>) の有限 DQBUF wait、QBUF failure の明確な failure と buffer validation を upstream/driver patch に揃える。再現可能な patch 適用・ESP-IDF build は合格、driver の実動作は未実施。 | frame 停止・DQBUF/QBUF failure・単一 buffer 返却失敗でも期限内に戻り、後続 capture・Home・再接続が成立。driver ioctl の実動作は device 上で確認。 |
| V06 | [codec](<../../firmware/main/hal/board/cores3_audio_codec_runtime.cc>) の I/O/volume 切替を同期し、[diagnostic tone](<../../firmware/main/hal/hal_mcp.cpp>) は microphone/speaker busy 時に明示拒否。 | TTS と診断音、音量変更、input/output 切替、disconnect を重ね、競合・音切れ・driver 破綻・恒久 mute がない。R17 の戻り値修正だけで合格としない。 |

## Physical acceptance matrix / 実機の最小合格 matrix

1. **起動/UI:** AP 不在、誤 credential、DHCP 不成立、bridge/hello 無応答。理由表示・Home 可用・復旧後の明示 HERMES 起動。cold boot/USB reset/flash 後に Launcher へ留まる。
2. **会話/通知:** 短い肯定・否定、TTS 後の早い返答、barge-in、最初の有声 frame と通知の競合。PCM と STT の語頭、FIFO 順、capture 保存を照合。
3. **期限/再接続:** 停止 STT/TTS endpoint・Python・ffmpeg、LLM 期限切れ、interrupt ACK のみ、A 遅着 → B 開始。pending RPC/task/child が増え続けず次 turn が成立。
4. **外部出力:** mute 直後切断/bridge kill、player 途中失敗、renew/restore ACK 消失、期限切れ、永久音量変更。元音量復元、stale restore 拒否、reap/flush/restore/全文 replay の順序。
5. **I/O/設定:** I2C/codec/touch fault、音量 0、power policy restart、空白 credential、旧 NVS URL 不一致。false success・押下残留・設定の黙った変形なし。
6. **連続負荷:** 会話・preview・camera・diagnostic・切断を反復し、最低 heap、task 数、queue、pending RPC、子プロセス数が収束。
7. **LCD/SD:** [共有 SPI 規約](<09-cores3-shared-spi-safety.md>) を厳守。20 MHz / queue depth 2 / RGB565 `.swap_bytes=1` と専用転送 buffer、`esp_lcd_panel_reset` → `aw9523_->ResetIli9342` → `esp_lcd_panel_init` を維持。SD は明示 Setup 操作のみ、LCD 初期化前 import と成功・失敗後の restart。Launcher/HERMES/handoff で probe/mount/direct draw をしない。ログ成功だけでなく物理 LCD の顔・色・残像なしを確認。

診断結果には credential/token/音声本文/個人 path/完全な私的 URL を含めず、scheme/host と非機密の状態・時刻・件数だけを残してください。一般の [test plan](<05-test-plan.md>) と [English README](<../../README.md>) / [日本語 README](<../../README.ja.md>) の起動・Setup 手順も合わせて確認します。
