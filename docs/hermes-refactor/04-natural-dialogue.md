# 04. Natural dialogue brush-up plan

## 目的

Hermes と M5-stackchan の対話を、単なる音声入出力ではなく、顔、状態表示、LED、首振り、tool 使用を含む自然なロボット対話に近づけます。

この作業は段階的に行います。最初の PR では小さな改善を優先し、大きな motion planner や prompt architecture の全面変更は避けます。

## 対象ファイル

- `ai-server/src/session.ts`
- `ai-server/src/stackchan_mcp_server.ts`
- `ai-server/test/session.test.ts`
- `ai-server/test/stackchan_mcp_server.test.ts`
- 必要に応じて `README.md` / `README.ja.md`

## 優先度 A: emotion を `neutral` 固定から改善する

### 現状

`ai-server/src/session.ts` では LLM 返答後に以下のような message を送っています。

```ts
this.sendJson({ type: 'llm', emotion: 'neutral' })
```

これにより、返答内容に関係なく表情が neutral になりがちです。

### 修正方針

最小実装として heuristic を入れます。

```ts
type StackChanEmotion = 'neutral' | 'happy' | 'laughing' | 'angry' | 'sad' | 'crying' | 'sleepy' | 'doubtful'

export function inferStackChanEmotion(text: string): StackChanEmotion {
    const normalized = text.toLowerCase()

    if (/ありがとう|嬉しい|うれしい|よかった|できた|楽しい|いいね|great|nice|happy/.test(normalized)) {
        return 'happy'
    }
    if (/笑|www|haha|lol/.test(normalized)) {
        return 'laughing'
    }
    if (/ごめん|すみません|残念|悲しい|申し訳|sorry/.test(normalized)) {
        return 'sad'
    }
    if (/眠い|おやすみ|sleepy|good night/.test(normalized)) {
        return 'sleepy'
    }
    if (/うーん|確認|わからない|不明|たぶん|maybe|not sure/.test(normalized)) {
        return 'doubtful'
    }
    return 'neutral'
}
```

使用箇所:

```ts
this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) })
```

テスト:

```text
- 「ありがとう」→ happy
- 「ごめん」→ sad
- 「うーん、確認します」→ doubtful
- 通常文 → neutral
```

## 優先度 A: VAD / cooldown を環境変数で調整可能にする

### 現状

`session.ts` の音声ターン制御値は固定です。

```ts
const SILENCE_TIMEOUT_MS = 1500
const MAX_RECORDING_MS = 15000
const MIN_FRAMES_FOR_STT = 10
const POST_TTS_COOLDOWN_MS = 2000
```

### 修正方針

環境変数から読めるようにします。

```ts
function readEnvInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
}

const SILENCE_TIMEOUT_MS = readEnvInt('STACKCHAN_SILENCE_TIMEOUT_MS', 1200, 300, 5000)
const MAX_RECORDING_MS = readEnvInt('STACKCHAN_MAX_RECORDING_MS', 15000, 3000, 60000)
const MIN_FRAMES_FOR_STT = readEnvInt('STACKCHAN_MIN_FRAMES_FOR_STT', 10, 1, 100)
const POST_TTS_COOLDOWN_MS = readEnvInt('STACKCHAN_POST_TTS_COOLDOWN_MS', 1500, 0, 10000)
```

README `.env` 例にも追記します。

```env
STACKCHAN_SILENCE_TIMEOUT_MS=1200
STACKCHAN_MAX_RECORDING_MS=15000
STACKCHAN_MIN_FRAMES_FOR_STT=10
STACKCHAN_POST_TTS_COOLDOWN_MS=1500
```

## 優先度 A: tool description を自然対話向けに改善する

### `stackchan_set_head_angles`

現状の説明は角度指定に留まっています。Hermes が自然に使えるよう、使い方のガイドを入れます。

改善例:

```text
Move StackChan's head to a yaw and/or pitch angle. Use small, infrequent movements during conversation so the robot feels alive without being distracting. For a natural nod, briefly lower pitch and return to center. For attention, return yaw near 0 and pitch slightly upward. Do not narrate the motion unless the user asks what you are doing.
```

### `stackchan_set_led_color`

改善例:

```text
Set StackChan RGB LED color. Use this sparingly as a nonverbal cue, for example soft green while listening, soft blue while speaking, or off when idle. Values are intentionally limited to 0..168 for safety and brightness.
```

### `stackchan_take_photo`

既にかなり良い説明があります。必要なら「撮影前に短くユーザーに許可を求める」など privacy guidance を追加します。ただし、ユーザーが明示的に「見て」「これは何？」と言った場合はそのまま使ってよいです。

## 優先度 B: display text と speech text を分ける

### 背景

小さい画面に長文を出すと読みづらく、音声では自然でも表示には不向きです。

### 方針

最初の実装では大きな protocol change を避け、以下の関数を追加する程度に留めます。

```ts
export function summarizeForStackChanBubble(text: string, maxChars = 48): string {
    const stripped = stripMediaForSpeech(text).replace(/\s+/g, ' ').trim()
    if (stripped.length <= maxChars) return stripped
    return `${stripped.slice(0, maxChars - 1)}…`
}
```

使用:

```ts
const displayText = summarizeForStackChanBubble(reply)
this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply), text: displayText })
```

注意: firmware 側の Xiaozhi protocol が `llm.text` をどう扱うか確認してください。未知の場合は、既存の `tts.sentence_start` text を引き続き表示に使わせ、protocol change は避けます。

## 優先度 B: listening / processing / speaking の状態を分かりやすくする

### 方針

既存 protocol message を活かします。

- listen start: firmware 側が listening 状態に入ることを確認。
- STT 完了: `this.sendJson({ type: 'stt', text })` は維持。
- LLM 処理中: 可能なら `type: 'llm', emotion: 'doubtful'` などを処理開始時に送る。
- TTS start / sentence_start / sentence_end / stop は維持。

大きく変えるより、まず log と status 表示が意図通りか実機で確認します。

## 優先度 B: macro tool の検討

角度指定 tool だけでは Hermes が自然な motion を作るのが難しいため、将来的に ai-server 側で macro tool を追加できます。

候補:

- `stackchan_nod`
- `stackchan_shake_head`
- `stackchan_look_at_user`
- `stackchan_react`

ただし今回の必須範囲ではありません。まずは既存 `stackchan_set_head_angles` の description 改善で十分です。

## 実装時の注意

- tool call を増やしすぎると会話の latency が増えます。
- 首振りを毎 turn 必ず入れると不自然です。
- LED を強く光らせ続けないでください。
- 発話中にマイクが TTS を拾わないよう、post-TTS cooldown を維持してください。
- camera tool はユーザー意図があるときに使うよう description で誘導してください。

## 完了条件

- `inferStackChanEmotion()` が実装され、unit test がある。
- `session.ts` の LLM emotion が `neutral` 固定ではなくなる。
- 音声ターン制御値が env で調整可能になる。
- tool descriptions が自然対話向けに改善される。
- `npm run build` と `npm test` が通る。
