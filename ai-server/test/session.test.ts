import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { inferStackChanEmotion, readEnvInt, readTurnControlConfig, Session } from '../src/session.ts'
import type { LocalRmsVadConfig } from '../src/local_vad.ts'

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

const testVadConfig: LocalRmsVadConfig = {
    enabled: true,
    rmsThreshold: 0.012,
    startSpeechMs: 60,
    endSilenceMs: 120,
    minSpeechMs: 120,
    preRollMs: 120,
}

function pcm60ms(amplitude: number): Buffer {
    const frame = Buffer.alloc(960 * 2)
    for (let i = 0; i < 960; i++) frame.writeInt16LE(amplitude, i * 2)
    return frame
}

function dataBytesFromWav(wav: Buffer): number {
    return wav.length - 44
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

test('inferStackChanEmotion maps reply text to StackChan expressions', () => {
    assert.equal(inferStackChanEmotion('ありがとう、うまくできたよ'), 'happy')
    assert.equal(inferStackChanEmotion('ごめん、少し失敗しました'), 'sad')
    assert.equal(inferStackChanEmotion('うーん、確認します'), 'doubtful')
    assert.equal(inferStackChanEmotion('おやすみ、また明日'), 'sleepy')
    assert.equal(inferStackChanEmotion('了解しました。'), 'neutral')
})

test('readEnvInt uses fallback, parsed values, and clamping', () => {
    assert.equal(readEnvInt('MISSING', 10, 1, 20, {}), 10)
    assert.equal(readEnvInt('VALUE', 10, 1, 20, { VALUE: '12.6' }), 13)
    assert.equal(readEnvInt('VALUE', 10, 1, 20, { VALUE: 'nope' }), 10)
    assert.equal(readEnvInt('VALUE', 10, 1, 20, { VALUE: '-5' }), 1)
    assert.equal(readEnvInt('VALUE', 10, 1, 20, { VALUE: '99' }), 20)
})

test('readTurnControlConfig reads StackChan voice turn environment values', () => {
    assert.deepEqual(readTurnControlConfig({
        STACKCHAN_SILENCE_TIMEOUT_MS: '800',
        STACKCHAN_MAX_RECORDING_MS: '90000',
        STACKCHAN_MIN_FRAMES_FOR_STT: '0',
        STACKCHAN_POST_TTS_COOLDOWN_MS: '1750',
    }), {
        silenceTimeoutMs: 800,
        maxRecordingMs: 60000,
        minFramesForStt: 1,
        postTtsCooldownMs: 1750,
    })
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

test('Session accepts wake word detect during post-TTS cooldown', async () => {
    const ws = new MockWebSocket()
    let transcribeCount = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        decodeOpusFrames: () => Buffer.alloc(320),
        transcribeWav: async () => `turn ${++transcribeCount}`,
        hermes: {
            submitPrompt: async (prompt) => `reply to ${prompt}`,
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))
    await delay(10)

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'detect', text: 'Hi StackChan' }))
    for (let i = 0; i < 5; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 5; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => jsonMessages(ws).filter((msg) => msg['type'] === 'stt').length === 2)
    assert.equal(transcribeCount, 2)

    session.close()
})

test('Session delays auto listen start during post-TTS cooldown and drops cooldown audio', async () => {
    const ws = new MockWebSocket()
    const decodedFrameCounts: number[] = []
    let transcribeCount = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        postTtsCooldownMs: 40,
        decodeOpusFrames: (frames) => {
            decodedFrameCounts.push(frames.length)
            return Buffer.alloc(320)
        },
        transcribeWav: async () => `turn ${++transcribeCount}`,
        hermes: {
            submitPrompt: async (prompt) => `reply to ${prompt}`,
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([i]))
    await delay(60)
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => jsonMessages(ws).filter((msg) => msg['type'] === 'stt').length === 2)
    assert.deepEqual(decodedFrameCounts, [10, 10])
    assert.equal(transcribeCount, 2)

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

test('Session local VAD processes a turn without listen stop', async () => {
    const ws = new MockWebSocket()
    let transcribedBytes = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: testVadConfig,
        decodeOpusFrame: (frame) => frame[0] === 1 ? pcm60ms(1600) : pcm60ms(0),
        transcribeWav: async (wav) => {
            transcribedBytes = dataBytesFromWav(wav)
            return '発話'
        },
        hermes: {
            submitPrompt: async () => '返答',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([1]))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([0]))

    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'stt' && msg['text'] === '発話'))
    assert.ok(transcribedBytes > 0)
    assert.ok(jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))
    session.close()
})

test('Session local VAD ends speech from silent PCM even while frames continue arriving', async () => {
    const ws = new MockWebSocket()
    let transcribeCount = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: testVadConfig,
        decodeOpusFrame: (frame) => frame[0] === 1 ? pcm60ms(1600) : pcm60ms(0),
        transcribeWav: async () => {
            transcribeCount += 1
            return '終わった'
        },
        hermes: {
            submitPrompt: async () => 'はい',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([1]))
    for (let i = 0; i < 8; i++) session.handleMessage(Buffer.from([0]))

    await waitFor(() => transcribeCount === 1)
    session.close()
})

test('Session local VAD keeps only pre-roll silence before speech', async () => {
    const ws = new MockWebSocket()
    let transcribedBytes = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: testVadConfig,
        decodeOpusFrame: (frame) => frame[0] === 1 ? pcm60ms(1600) : pcm60ms(0),
        transcribeWav: async (wav) => {
            transcribedBytes = dataBytesFromWav(wav)
            return 'プリロール'
        },
        hermes: {
            submitPrompt: async () => 'ok',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([0]))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([1]))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([0]))

    await waitFor(() => transcribedBytes > 0)
    const oneFrameBytes = 960 * 2
    assert.ok(transcribedBytes <= oneFrameBytes * 8)
    assert.ok(transcribedBytes >= oneFrameBytes * 5)
    session.close()
})

test('Session abort clears local VAD buffers before the next turn', async () => {
    const ws = new MockWebSocket()
    const transcribedBytes: number[] = []
    let interrupted = false
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: testVadConfig,
        decodeOpusFrame: (frame) => frame[0] === 1 ? pcm60ms(1600) : pcm60ms(0),
        transcribeWav: async (wav) => {
            transcribedBytes.push(dataBytesFromWav(wav))
            return '次'
        },
        hermes: {
            submitPrompt: async () => 'ok',
            interrupt: async () => { interrupted = true },
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    session.handleMessage(Buffer.from([1]))
    session.handleMessage(JSON.stringify({ type: 'abort' }))
    await waitFor(() => interrupted)

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 2; i++) session.handleMessage(Buffer.from([1]))
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([0]))

    await waitFor(() => transcribedBytes.length === 1)
    assert.ok(transcribedBytes[0] <= 960 * 2 * 6)
    session.close()
})

test('Session falls back to arrival-gap silence timer when local VAD is disabled', async () => {
    const ws = new MockWebSocket()
    let transcribeCount = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: { ...testVadConfig, enabled: false },
        decodeOpusFrames: (frames) => {
            assert.equal(frames.length, 10)
            return Buffer.alloc(320)
        },
        transcribeWav: async () => {
            transcribeCount += 1
            return 'fallback'
        },
        hermes: {
            submitPrompt: async () => 'ok',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('fake wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))

    await delay(1350)
    await waitFor(() => transcribeCount === 1)
    session.close()
})
