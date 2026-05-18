import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Session } from '../src/session.ts'

class MockWebSocket {
    sent: Array<string | Buffer> = []

    send(data: string | Buffer): void {
        this.sent.push(data)
    }
}

function jsonMessages(ws: MockWebSocket): Array<Record<string, unknown>> {
    return ws.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item) as Record<string, unknown>)
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return
        await delay(10)
    }
    assert.fail('condition was not reached')
}

test('Session bridges audio turn through Hermes STT, LLM, TTS, and streams Opus back', async () => {
    const ws = new MockWebSocket()
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        decodeOpusFrames: (frames) => {
            assert.equal(frames.length, 10)
            return Buffer.alloc(320)
        },
        transcribeWav: async (wav) => {
            assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF')
            return 'こんにちは'
        },
        hermes: {
            submitPrompt: async (prompt) => {
                assert.equal(prompt, 'こんにちは')
                return 'やあ'
            },
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async (text) => {
            assert.equal(text, 'やあ')
            return Buffer.from('fake wav')
        },
        encodeWavToOpusFrames: (wav) => {
            assert.equal(wav.toString('utf8'), 'fake wav')
            return [Buffer.from([1]), Buffer.from([2])]
        },
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) {
        session.handleMessage(Buffer.from([i]))
    }
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))

    const messages = jsonMessages(ws)
    assert.equal(messages.find((msg) => msg['type'] === 'stt')?.['text'], 'こんにちは')
    assert.equal(messages.find((msg) => msg['type'] === 'llm')?.['emotion'], 'neutral')
    assert.ok(messages.some((msg) => msg['type'] === 'tts' && msg['state'] === 'sentence_start' && msg['text'] === 'やあ'))
    assert.deepEqual(ws.sent.filter(Buffer.isBuffer), [Buffer.from([1]), Buffer.from([2])])

    session.close()
})

test('Session forwards abort to Hermes interrupt and stops local capture state', async () => {
    const ws = new MockWebSocket()
    let interrupted = false
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        hermes: {
            submitPrompt: async () => 'unused',
            interrupt: async () => {
                interrupted = true
            },
            dispose: async () => undefined,
        },
    })

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    session.handleMessage(Buffer.from([1]))
    session.handleMessage(JSON.stringify({ type: 'abort' }))

    await waitFor(() => interrupted)
    session.handleMessage(Buffer.from([2]))
    assert.equal(ws.sent.filter(Buffer.isBuffer).length, 0)

    session.close()
})

test('Session displays Hermes image media and strips image tags before TTS', async () => {
    const ws = new MockWebSocket()
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        decodeOpusFrames: () => Buffer.alloc(320),
        transcribeWav: async () => '画像を見せて',
        hermes: {
            submitPrompt: async () => 'MEDIA:https://example.com/result.png\nこちらです',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async (text) => {
            assert.equal(text, 'こちらです')
            return Buffer.from('fake wav')
        },
        encodeWavToOpusFrames: () => [Buffer.from([3])],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) {
        session.handleMessage(Buffer.from([i]))
    }
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'mcp'))
    const firstMcpMessage = jsonMessages(ws).find((msg) => msg['type'] === 'mcp')
    assert.ok(firstMcpMessage)
    session.handleMessage(JSON.stringify({
        type: 'mcp',
        payload: {
            id: (firstMcpMessage['payload'] as Record<string, unknown>)['id'],
            result: true,
        },
    }))

    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))

    const messages = jsonMessages(ws)
    const mcpMessage = messages.find((msg) => msg['type'] === 'mcp')
    assert.ok(mcpMessage)
    assert.deepEqual(
        ((mcpMessage['payload'] as Record<string, unknown>)['params'] as Record<string, unknown>),
        {
            name: 'self.screen.preview_image_url',
            arguments: {
                url: 'https://example.com/result.png',
                duration_seconds: 6,
            },
        },
    )
    assert.ok(messages.some((msg) => msg['type'] === 'tts' && msg['state'] === 'sentence_start' && msg['text'] === 'こちらです'))

    session.close()
})
