# 08. HERMES 起動時 LCD 顔表示失敗の調査記録

## 問題の概要

HERMES の自動起動は停止できていた。Launcher から HERMES アプリを手動起動すると、ログ上は正常に進行していた。

確認できていた代表的なログ:

```text
Hermes avatar SetupUI complete
Application::Run start
SetStatus: Standby
Start idle motion
```

サーボの idle motion も開始していたため、Hermes runtime、サーボ、アプリロジック自体は動作していた。

しかし実機 LCD には StackChan の顔が表示されなかった。画面は黒っぽく、場合によっては下端に緑からシアン系の帯が出ていた。つまり、LVGL 側では avatar screen が構築され、Hermes runtime も Standby まで到達しているのに、物理 LCD への描画だけが失敗している状態だった。

## 最終的な原因

CoreS3 / StackChan 環境では、SD card と LCD が同じ SPI 系統を共有しており、GPIO35 が LCD の DC 信号と SD の MISO を兼ねる構成になっている。

HERMES アプリ起動時に毎回 SD card の `config.json` を読みに行っていたため、HERMES runtime / avatar screen へ handoff する直前に SPI / GPIO35 が SD card 用へ切り替わっていた。

SD config import 自体は成功していたが、その後 LCD 用に戻したつもりでも、LCD panel IO / DC pin / SPI bus の状態が完全には復帰していなかった。その結果、LVGL 上では avatar screen が作られているのに、物理 LCD へ正しく flush されない状態になっていた。

短くまとめると、HERMES 起動直前の SD config import が、LCD と共有している SPI / GPIO35 の状態を乱し、LVGL の描画内容が物理 LCD に正しく届かなくなっていた。

## 発生していた処理の流れ

```text
Launcher 表示
  ↓
HERMES アプリを手動起動
  ↓
AppAiAgent::onOpen()
  ↓
SD card から config.json を import
  ↓
SD card 用に共有 SPI / GPIO35 を切り替え
  ↓
設定 import は成功
  ↓
LCD 用に復帰したつもり
  ↓
Mooncake teardown
  ↓
Hermes avatar SetupUI complete
  ↓
Application::Run start
  ↓
SetStatus: Standby
  ↓
Start idle motion
  ↓
しかし物理 LCD には顔が表示されない
```

## 調査で切り分けたこと

- `Hermes avatar SetupUI complete` まで到達していたため、avatar screen の生成処理そのものは実行されていた。
- `Application::Run start` と `SetStatus: Standby` まで到達していたため、Hermes runtime の起動失敗ではなかった。
- `Start idle motion` とサーボ動作が確認できたため、runtime task や motion 系の停止ではなかった。
- LCD だけが黒っぽい表示または下端の色帯になるため、Mooncake 画面残骸だけでなく、LCD panel IO / SPI / flush 経路の破綻を疑うべき状況だった。
- SD config import を HERMES 起動直前に実行しない状態へ戻すと、avatar screen が物理 LCD に表示されるようになった。

## 修正方針

HERMES アプリ起動時に毎回 SD card の `config.json` を import しない。

既に WebSocket URL と Wi-Fi 設定が存在する場合、`AppAiAgent::onOpen()` では SD config import を skip する。これにより、Hermes runtime / avatar screen への handoff 直前に共有 SPI / GPIO35 を SD 用へ切り替えない。

SD card からの初期設定 import は、Setup アプリや明示的な設定導入フローなど、LCD handoff と競合しない場面に限定する。HERMES 起動直前の便利な再読込として扱わない。

## 再発防止事項

- HERMES 起動直前、Mooncake teardown 直前、`StackChanAvatarDisplay::SetupUI()` 直前では SD card へアクセスしない。
- CoreS3 / StackChan では、SD card と LCD が SPI / GPIO35 を共有していることを前提に設計する。
- SD card を読む処理を追加する場合は、LCD panel IO / DC pin / SPI bus の状態復帰まで含めて実機 LCD で検証する。
- ログ上の `SetupUI complete` や `SetStatus: Standby` だけを顔表示成功とみなさない。実機 LCD に StackChan の顔が表示されることを確認する。
- HERMES 起動経路では、設定変更の即時反映よりも LCD handoff の安定性を優先する。
- 顔追従など HERMES runtime 設定の既定値変更は、SD card の `config.json` 再読込に依存させず、ファームウェア側の default または専用設定 UI / MCP tool で扱う。

