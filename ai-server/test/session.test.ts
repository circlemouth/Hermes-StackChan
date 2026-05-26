import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { inferStackChanEmotion, readBargeInConfig, readEnvInt, readSpeechSegmentationConfig, readTurnControlConfig, Session, splitStackChanSpeechText } from '../src/session.ts'
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

function mcpMessages(ws: MockWebSocket): Array<Record<string, unknown>> {
    return jsonMessages(ws).filter((msg) => msg['type'] === 'mcp')
}

function mcpParams(msg: Record<string, unknown>): Record<string, unknown> {
    return ((msg['payload'] as Record<string, unknown>)['params'] as Record<string, unknown>)
}

function mcpId(msg: Record<string, unknown>): unknown {
    return (msg['payload'] as Record<string, unknown>)['id']
}

function ledMcpMessages(ws: MockWebSocket): Array<Record<string, unknown>> {
    return mcpMessages(ws).filter((msg) => mcpParams(msg)['name'] === 'self.robot.set_led_color')
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
    const llmMessages = messages.filter((msg) => msg['type'] === 'llm')
    assert.equal(llmMessages[0]?.['emotion'], 'doubtful')
    assert.equal(llmMessages.at(-1)?.['emotion'], 'neutral')
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

test('readBargeInConfig and readSpeechSegmentationConfig clamp environment values', () => {
    assert.deepEqual(readBargeInConfig({
        STACKCHAN_BARGE_IN_ENABLED: 'false',
        STACKCHAN_BARGE_IN_RMS_THRESHOLD: '9',
        STACKCHAN_BARGE_IN_START_SPEECH_MS: '1',
        STACKCHAN_BARGE_IN_MIN_SPEECH_MS: '99999',
        STACKCHAN_BARGE_IN_IGNORE_TTS_START_MS: '-10',
    }), {
        enabled: false,
        rmsThreshold: 0.3,
        startSpeechMs: 60,
        minSpeechMs: 3000,
        ignoreTtsStartMs: 0,
    })
    assert.deepEqual(readSpeechSegmentationConfig({
        STACKCHAN_MAX_SPEECH_CHARS: '20',
        STACKCHAN_TTS_SEGMENT_MAX_CHARS: '9999',
        STACKCHAN_TTS_MAX_SEGMENTS: '0',
    }), {
        maxSpeechChars: 40,
        segmentMaxChars: 800,
        maxSegments: 1,
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

    await waitFor(() => mcpMessages(ws).some((msg) => mcpParams(msg)['name'] === 'self.screen.preview_image_url'))
    const firstMcpMessage = mcpMessages(ws).find((msg) => mcpParams(msg)['name'] === 'self.screen.preview_image_url')
    assert.ok(firstMcpMessage)
    session.handleMessage(JSON.stringify({
        type: 'mcp',
        payload: {
            id: mcpId(firstMcpMessage),
            result: true,
        },
    }))

    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))

    const messages = jsonMessages(ws)
    const mcpMessage = mcpMessages(ws).find((msg) => mcpParams(msg)['name'] === 'self.screen.preview_image_url')
    assert.ok(mcpMessage)
    assert.deepEqual(
        mcpParams(mcpMessage),
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

test('splitStackChanSpeechText segments Japanese, strips media, bounds long text, and falls back for image-only replies', () => {
    assert.deepEqual(splitStackChanSpeechText('一つ目です。二つ目です！'), ['一つ目です。', '二つ目です！'])
    assert.deepEqual(splitStackChanSpeechText('MEDIA:https://example.com/a.png\nこちらです。'), ['こちらです。'])
    assert.deepEqual(splitStackChanSpeechText('MEDIA:https://example.com/a.png'), ['画像を表示しました。'])

    const long = 'あ'.repeat(45)
    assert.deepEqual(splitStackChanSpeechText(long, {
        maxSpeechChars: 100,
        segmentMaxChars: 20,
        maxSegments: 8,
    }), ['あ'.repeat(20), 'あ'.repeat(20), 'あ'.repeat(5)])
})

test('Session synthesizes and streams TTS one sentence segment at a time', async () => {
    const ws = new MockWebSocket()
    const synthesized: string[] = []
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        decodeOpusFrames: () => Buffer.alloc(320),
        transcribeWav: async () => '説明して',
        hermes: {
            submitPrompt: async () => '一つ目です。二つ目です！',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async (text) => {
            synthesized.push(text)
            return Buffer.from(text)
        },
        encodeWavToOpusFrames: (wav) => [Buffer.from([wav.toString('utf8').startsWith('一') ? 1 : 2])],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => jsonMessages(ws).filter((msg) => msg['type'] === 'tts' && msg['state'] === 'sentence_end').length === 2)
    await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))

    assert.deepEqual(synthesized, ['一つ目です。', '二つ目です！'])
    const ttsMessages = jsonMessages(ws).filter((msg) => msg['type'] === 'tts')
    assert.equal(ttsMessages.filter((msg) => msg['state'] === 'start').length, 1)
    assert.equal(ttsMessages.filter((msg) => msg['state'] === 'stop').length, 1)
    assert.deepEqual(
        ttsMessages.filter((msg) => msg['state'] === 'sentence_start').map((msg) => msg['text']),
        ['一つ目です。', '二つ目です！'],
    )
    assert.deepEqual(
        ttsMessages.filter((msg) => msg['state'] === 'sentence_end').map((msg) => msg['text']),
        ['一つ目です。', '二つ目です！'],
    )
    assert.deepEqual(ws.sent.filter(Buffer.isBuffer), [Buffer.from([1]), Buffer.from([2])])

    session.close()
})

test('Session barge-in interrupts TTS, sends one stop, and accepts the next turn', async () => {
    const ws = new MockWebSocket()
    let interruptCount = 0
    let transcribeCount = 0
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        localVadConfig: { ...testVadConfig, enabled: false },
        bargeInConfig: {
            enabled: true,
            rmsThreshold: 0.03,
            startSpeechMs: 180,
            minSpeechMs: 180,
            ignoreTtsStartMs: 0,
        },
        decodeOpusFrame: (frame) => frame[0] === 9 ? pcm60ms(3000) : pcm60ms(0),
        decodeOpusFrames: () => Buffer.alloc(320),
        transcribeWav: async () => `turn ${++transcribeCount}`,
        hermes: {
            submitPrompt: async (prompt) => prompt === 'turn 1' ? '長い返答です。続きがあります。' : '次の返答です。',
            interrupt: async () => { interruptCount += 1 },
            dispose: async () => undefined,
        },
        synthesizeText: async (text) => Buffer.from(text),
        encodeWavToOpusFrames: (wav) => wav.toString('utf8').startsWith('長い')
            ? [Buffer.from([1]), Buffer.from([2]), Buffer.from([3]), Buffer.from([4]), Buffer.from([5])]
            : [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))

    await waitFor(() => ws.sent.filter(Buffer.isBuffer).length >= 1)
    for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([9]))

    await waitFor(() => interruptCount === 1)
    const streamedBeforeSecondTurn = ws.sent.filter(Buffer.isBuffer).length
    assert.ok(streamedBeforeSecondTurn < 5)
    assert.equal(jsonMessages(ws).filter((msg) => msg['type'] === 'tts' && msg['state'] === 'stop').length, 1)

    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await waitFor(() => transcribeCount === 2)
    assert.ok(jsonMessages(ws).some((msg) => msg['type'] === 'stt' && msg['text'] === 'turn 2'))

    session.close()
})

test('Session does not barge in when disabled or inside the TTS ignore window', async () => {
    async function runCase(bargeInEnabled: boolean, ignoreTtsStartMs: number): Promise<{ ws: MockWebSocket; interrupts: number }> {
        const ws = new MockWebSocket()
        let interrupts = 0
        const session = new Session(ws as never, {
            registerDeviceSession: () => () => undefined,
            localVadConfig: { ...testVadConfig, enabled: false },
            bargeInConfig: {
                enabled: bargeInEnabled,
                rmsThreshold: 0.03,
                startSpeechMs: 180,
                minSpeechMs: 180,
                ignoreTtsStartMs,
            },
            decodeOpusFrame: (frame) => frame[0] === 9 ? pcm60ms(3000) : pcm60ms(0),
            decodeOpusFrames: () => Buffer.alloc(320),
            transcribeWav: async () => 'turn',
            hermes: {
                submitPrompt: async () => '長い返答です。',
                interrupt: async () => { interrupts += 1 },
                dispose: async () => undefined,
            },
            synthesizeText: async () => Buffer.from('wav'),
            encodeWavToOpusFrames: () => [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])],
        })

        session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
        session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
        for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
        session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
        await waitFor(() => ws.sent.filter(Buffer.isBuffer).length >= 1)
        for (let i = 0; i < 3; i++) session.handleMessage(Buffer.from([9]))
        await waitFor(() => jsonMessages(ws).some((msg) => msg['type'] === 'tts' && msg['state'] === 'stop'))
        session.close()
        return { ws, interrupts }
    }

    const disabled = await runCase(false, 0)
    assert.equal(disabled.interrupts, 0)
    assert.deepEqual(disabled.ws.sent.filter(Buffer.isBuffer), [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])])

    const ignored = await runCase(true, 10_000)
    assert.equal(ignored.interrupts, 0)
    assert.deepEqual(ignored.ws.sent.filter(Buffer.isBuffer), [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])])
})

test('Session auto LED follows listen and speaking states', async () => {
    const ws = new MockWebSocket()
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        decodeOpusFrames: () => Buffer.alloc(320),
        transcribeWav: async () => 'こんにちは',
        hermes: {
            submitPrompt: async () => '返答',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
        synthesizeText: async () => Buffer.from('wav'),
        encodeWavToOpusFrames: () => [],
    })

    session.handleMessage(JSON.stringify({ type: 'hello', version: 1 }))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    assert.deepEqual(mcpParams(ledMcpMessages(ws)[0])['arguments'], { red: 0, green: 32, blue: 0 })
    for (let i = 0; i < 10; i++) session.handleMessage(Buffer.from([i]))
    session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await waitFor(() => ledMcpMessages(ws).some((msg) => {
        const args = mcpParams(msg)['arguments'] as Record<string, unknown>
        return args['blue'] === 40
    }))

    session.close()
})

test('Session manual LED tool hold suppresses automatic LED updates', async () => {
    const ws = new MockWebSocket()
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        autoLedConfig: { enabled: true, manualHoldMs: 8000 },
        hermes: {
            submitPrompt: async () => 'unused',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
    })

    const ledPromise = session.callRobotTool('self.robot.set_led_color', { red: 10, green: 0, blue: 0 })
    const manualLedMessage = ledMcpMessages(ws)[0]
    assert.ok(manualLedMessage)
    session.handleMessage(JSON.stringify({ type: 'mcp', payload: { id: mcpId(manualLedMessage), result: true } }))
    await ledPromise

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    assert.equal(ledMcpMessages(ws).length, 1)

    session.close()
})

test('Session does not send automatic LED payloads when disabled', () => {
    const ws = new MockWebSocket()
    const session = new Session(ws as never, {
        registerDeviceSession: () => () => undefined,
        autoLedEnabled: false,
        hermes: {
            submitPrompt: async () => 'unused',
            interrupt: async () => undefined,
            dispose: async () => undefined,
        },
    })

    session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    assert.equal(ledMcpMessages(ws).length, 0)

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
