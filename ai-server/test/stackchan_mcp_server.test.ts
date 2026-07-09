import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSubagentFollowupPrompt, normalizeBridgeResultToMcpContent, tools } from '../src/stackchan_mcp_server.ts'

test('tools list includes public StackChan reminder and power tools', () => {
    const toolNames = tools.map(tool => tool.name)

    assert.deepEqual(toolNames, [
        'stackchan_get_status',
        'stackchan_set_speaker_volume',
        'stackchan_play_test_tone',
        'stackchan_get_head_angles',
        'stackchan_set_head_angles',
        'stackchan_set_led_color',
        'stackchan_power_off',
        'stackchan_take_photo',
        'stackchan_display_image',
        'stackchan_capture_screen',
        'stackchan_ask_hermes_subagent',
        'stackchan_create_reminder',
        'stackchan_get_reminders',
        'stackchan_stop_reminder',
    ])
})

test('audio diagnostic tone schema uses bounded safe defaults', () => {
    const tone = tools.find(tool => tool.name === 'stackchan_play_test_tone')

    assert.ok(tone)
    assert.equal(tone.inputSchema['additionalProperties'], false)
    assert.deepEqual(
        Object.keys((tone.inputSchema['properties'] as Record<string, unknown>)),
        ['frequency_hz', 'duration_ms', 'amplitude'],
    )
})

test('reminder tool schemas require the expected arguments', () => {
    const createReminder = tools.find(tool => tool.name === 'stackchan_create_reminder')
    const stopReminder = tools.find(tool => tool.name === 'stackchan_stop_reminder')

    assert.ok(createReminder)
    assert.deepEqual(createReminder.inputSchema['required'], ['duration_seconds', 'message'])
    assert.deepEqual(
        Object.keys((createReminder.inputSchema['properties'] as Record<string, unknown>)),
        ['duration_seconds', 'message', 'repeat'],
    )

    assert.ok(stopReminder)
    assert.deepEqual(stopReminder.inputSchema['required'], ['id'])
})

test('normalizeBridgeResultToMcpContent converts firmware image blocks to standard MCP image content', () => {
    const content = normalizeBridgeResultToMcpContent({
        content: [
            {
                type: 'image',
                image: JSON.stringify({
                    type: 'image',
                    mimeType: 'image/jpeg',
                    data: 'abc123',
                }),
            },
        ],
        isError: false,
    })

    assert.deepEqual(content, [
        {
            type: 'image',
            mimeType: 'image/jpeg',
            data: 'abc123',
        },
    ])
})


test('sub-agent tool schema requires a delegated query', () => {
    const subagent = tools.find(tool => tool.name === 'stackchan_ask_hermes_subagent')

    assert.ok(subagent)
    assert.deepEqual(subagent.inputSchema['required'], ['query'])
    assert.deepEqual(
        Object.keys((subagent.inputSchema['properties'] as Record<string, unknown>)),
        ['query', 'guidance'],
    )
})

test('sub-agent follow-up prompt carries the original request and answer', () => {
    const prompt = buildSubagentFollowupPrompt('LEDの制御方法を調べて', 'set_led_colorを使います。')

    assert.match(prompt, /サブエージェント/)
    assert.match(prompt, /LEDの制御方法/)
    assert.match(prompt, /set_led_color/)
    assert.match(prompt, /stackchan_ask_hermes_subagent を使わず/)
})
