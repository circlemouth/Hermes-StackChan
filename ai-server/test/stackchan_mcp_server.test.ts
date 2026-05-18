import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBridgeResultToMcpContent } from '../src/stackchan_mcp_server.ts'

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
