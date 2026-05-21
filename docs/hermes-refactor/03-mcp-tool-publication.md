# 03. MCP tool publication plan

## 目的

firmware 側に実装済みだが ai-server / public MCP server 側で未公開の機能を公開し、README と tests を実装に一致させます。

## 現状の tool inventory

### ai-server 側で公開済み

`ai-server/src/device_control.ts` と `ai-server/src/stackchan_mcp_server.ts` では、以下が public tool として扱われています。

- `stackchan_get_status`
- `stackchan_get_head_angles`
- `stackchan_set_head_angles`
- `stackchan_set_led_color`
- `stackchan_power_off`
- `stackchan_take_photo`
- `stackchan_display_image`
- `stackchan_capture_screen`

### firmware 側に実装済みで未公開

`firmware/main/hal/hal_mcp.cpp` には reminder 系 tool が実装されています。

- `self.robot.create_reminder`
- `self.robot.get_reminders`
- `self.robot.stop_reminder`

これらを public MCP tool として公開します。

## 対象ファイル

- `ai-server/src/device_control.ts`
- `ai-server/src/stackchan_mcp_server.ts`
- `ai-server/test/stackchan_mcp_server.test.ts`
- `firmware/main/hal/hal_mcp.cpp`
- `README.md`
- `README.ja.md`

## 1. `device_control.ts` に tool 名を追加

### 1.1 `StackChanToolName` に追加

```ts
export type StackChanToolName =
    | 'stackchan_get_status'
    | 'stackchan_get_head_angles'
    | 'stackchan_set_head_angles'
    | 'stackchan_set_led_color'
    | 'stackchan_power_off'
    | 'stackchan_take_photo'
    | 'stackchan_display_image'
    | 'stackchan_capture_screen'
    | 'stackchan_create_reminder'
    | 'stackchan_get_reminders'
    | 'stackchan_stop_reminder'
```

### 1.2 `TOOL_MAP` に追加

```ts
const TOOL_MAP: Record<StackChanToolName, string> = {
    stackchan_get_status: 'self.robot.get_status',
    stackchan_get_head_angles: 'self.robot.get_head_angles',
    stackchan_set_head_angles: 'self.robot.set_head_angles',
    stackchan_set_led_color: 'self.robot.set_led_color',
    stackchan_power_off: 'self.robot.power_off',
    stackchan_take_photo: 'self.camera.capture_photo',
    stackchan_display_image: 'self.screen.preview_image_url',
    stackchan_capture_screen: 'self.screen.capture_screenshot',
    stackchan_create_reminder: 'self.robot.create_reminder',
    stackchan_get_reminders: 'self.robot.get_reminders',
    stackchan_stop_reminder: 'self.robot.stop_reminder',
}
```

## 2. reminder args を正規化する

firmware 側が受け取る key を確認し、public tool schema と一致させます。

推奨 public schema:

```ts
stackchan_create_reminder: {
  duration_seconds: integer, 1..86400,
  message: string,
  repeat: boolean default false
}

stackchan_get_reminders: {}

stackchan_stop_reminder: {
  id: integer
}
```

`device_control.ts` で必要なら normalize します。

例:

```ts
function clampReminderDurationSeconds(value: unknown): number {
    const duration = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(duration)) throw new Error('duration_seconds must be a finite number')
    return Math.max(1, Math.min(86400, Math.round(duration)))
}

function readReminderMessage(value: unknown): string {
    const message = typeof value === 'string' ? value.trim() : ''
    if (!message) throw new Error('message is required')
    return message.slice(0, 120)
}
```

そして `callStackChanTool()` に追加します。

```ts
if (name === 'stackchan_create_reminder') {
    return await activeSession.callRobotTool(TOOL_MAP[name], {
        duration_seconds: clampReminderDurationSeconds(args['duration_seconds']),
        message: readReminderMessage(args['message']),
        repeat: Boolean(args['repeat'] ?? false),
    })
}

if (name === 'stackchan_stop_reminder') {
    const id = Number(args['id'])
    if (!Number.isInteger(id)) throw new Error('id must be an integer')
    return await activeSession.callRobotTool(TOOL_MAP[name], { id })
}
```

注意: firmware 側が `duration_ms` を期待している場合は、ここで `duration_seconds * 1000` に変換します。実装前に `hal_mcp.cpp` の schema を確認してください。

## 3. `stackchan_mcp_server.ts` に tool definition を追加

### 3.1 `stackchan_create_reminder`

```ts
{
    name: 'stackchan_create_reminder',
    description: [
        'Create a local reminder on the physical StackChan.',
        'Use this when the user asks StackChan to remind them after a duration, such as "remind me in 10 minutes".',
        'The device will display and play a local notification when the reminder fires.',
        'Do not use this for calendar scheduling at an absolute date unless you can convert it to a relative duration.',
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            duration_seconds: {
                type: 'integer',
                minimum: 1,
                maximum: 86400,
                description: 'Relative reminder delay in seconds.',
            },
            message: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
                description: 'Short message to show when the reminder fires.',
            },
            repeat: {
                type: 'boolean',
                default: false,
                description: 'Whether the reminder repeats using the same duration.',
            },
        },
        required: ['duration_seconds', 'message'],
        additionalProperties: false,
    },
}
```

### 3.2 `stackchan_get_reminders`

```ts
{
    name: 'stackchan_get_reminders',
    description: 'Get active local StackChan reminders.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
}
```

### 3.3 `stackchan_stop_reminder`

```ts
{
    name: 'stackchan_stop_reminder',
    description: 'Stop a local StackChan reminder by ID. Use stackchan_get_reminders first if the ID is unknown.',
    inputSchema: {
        type: 'object',
        properties: {
            id: { type: 'integer', description: 'Reminder ID returned by stackchan_create_reminder or stackchan_get_reminders.' },
        },
        required: ['id'],
        additionalProperties: false,
    },
}
```

## 4. firmware reminder JSON を安全化する

### 問題

`self.robot.get_reminders` が文字列連結で JSON を作っている場合、message に `"`、改行、日本語、backslash などが含まれると JSON が壊れる可能性があります。

### 修正方針

`cJSON` で構築します。

概念コード:

```cpp
cJSON* arr = cJSON_CreateArray();
for (const auto& r : reminders) {
    cJSON* item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "id", r.id);
    cJSON_AddNumberToObject(item, "duration_ms", r.durationMs);
    cJSON_AddNumberToObject(item, "duration_seconds", r.durationMs / 1000);
    cJSON_AddStringToObject(item, "message", r.message.c_str());
    cJSON_AddBoolToObject(item, "repeat", r.repeat);
    cJSON_AddItemToArray(arr, item);
}

char* json = cJSON_PrintUnformatted(arr);
std::string result = json ? json : "[]";
if (json) cJSON_free(json);
cJSON_Delete(arr);
return result;
```

確認ポイント:

- message に `"` が含まれても JSON が壊れない。
- message に日本語が含まれても JSON が壊れない。
- 空配列は `[]`。
- `duration_ms` と `duration_seconds` の両方を返すと client 側が扱いやすい。

## 5. `stackchan_power_off` の README 反映

`stackchan_power_off` は ai-server 側に実装済みですが、README の v1 tool list に漏れている場合があります。以下に追加します。

```text
- stackchan_power_off
```

## 6. README / README.ja.md の tool list を同期

日本語 README と英語 README の tool list を同じ内容にします。

最終 list:

```text
- stackchan_get_status
- stackchan_get_head_angles
- stackchan_set_head_angles
- stackchan_set_led_color
- stackchan_power_off
- stackchan_take_photo
- stackchan_display_image
- stackchan_capture_screen
- stackchan_create_reminder
- stackchan_get_reminders
- stackchan_stop_reminder
```

各 tool の短い説明も足してください。

## 7. tests

### 7.1 tools/list に reminder tools が出ること

`stackchan_mcp_server.ts` の `tools` が export されていない場合、以下のどちらかを選びます。

- `tools` を `export const tools` に変更して unit test する。
- `handleRequest()` に対して fake stdout capture を使い、`tools/list` response を検証する。

最小なら `export const tools` が簡単です。

テスト観点:

```text
- stackchan_create_reminder が含まれる
- stackchan_get_reminders が含まれる
- stackchan_stop_reminder が含まれる
- stackchan_power_off が含まれる
- create_reminder schema で duration_seconds と message が required
- stop_reminder schema で id が required
```

### 7.2 normalizeBridgeResultToMcpContent

既存 image block test は維持します。

reminder result が array/object/stringified JSON のどれでも text content として壊れないことを確認します。

例:

```ts
test('normalizeBridgeResultToMcpContent renders reminder arrays as text JSON', () => {
    const content = normalizeBridgeResultToMcpContent([
        { id: 1, message: 'お茶', duration_seconds: 300, repeat: false },
    ])
    assert.equal(content[0].type, 'text')
    assert.match(String(content[0].text), /お茶/)
})
```

## 8. 完了条件

- `tools/list` に reminder 系 3 tool が出る。
- `device_control.ts` の `TOOL_MAP` に reminder 系 mapping がある。
- `stackchan_create_reminder` は duration/message/repeat を firmware に渡す。
- `stackchan_get_reminders` は active reminders を取得できる。
- `stackchan_stop_reminder` は id で停止できる。
- `README.md` と `README.ja.md` の tool list が実装と一致している。
- `npm run build` と `npm test` が通る。
