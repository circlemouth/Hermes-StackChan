import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBridgeResultToMcpContent, tools } from '../src/stackchan_mcp_server.ts'

test('tools list includes public StackChan reminder and power tools', () => {
    const toolNames = tools.map(tool => tool.name)

    assert.deepEqual(toolNames, [
        'stackchan_get_status',
        'stackchan_get_head_angles',
        'stackchan_set_head_angles',
        'stackchan_set_led_color',
        'stackchan_power_off',
        'stackchan_take_photo',
        'stackchan_display_image',
        'stackchan_capture_screen',
        'stackchan_create_reminder',
        'stackchan_get_reminders',
        'stackchan_stop_reminder',
    ])
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
