import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { Session, readTurnControlConfig, readEnvInt } from '../src/session.ts'
import { wrapOpusPayload, type InputOpusDecoder } from '../src/audio.ts'
import type { LocalRmsVad, LocalRmsVadConfig } from '../src/local_vad.ts'

const vadConfig: LocalRmsVadConfig = {
    enabled: true, rmsThreshold: 0.012, startSpeechMs: 60,
    endSilenceMs: 120, minSpeechMs: 120, preRollMs: 120,
}

function pcm(amplitude: number): Buffer {
    const data = Buffer.alloc(960 * 2)
    for (let i = 0; i < 960; i++) data.writeInt16LE(amplitude, i * 2)
    return data
}

// Read-only capture inspection, except disabling unrelated optional fast-ack and
// local-speaker output. No test touches services, profiles, real audio or USB.
type Capture = {
    opusFrames: Buffer[]
    pcmChunks: Buffer[]
    preRollPcmChunks: Buffer[]
    currentSpeechMs: number
    streamingDecodeFailed: boolean
    streamingDecodeFailures: number
    streamingDecoder: InputOpusDecoder
    localVad: LocalRmsVad
    silenceTimer?: ReturnType<typeof setTimeout>
    maxDurationTimer?: ReturnType<typeof setTimeout>
    delayedListenTimer?: ReturnType<typeof setTimeout>
    processingSource: string
    localTtsOutputConfig: { enabled: boolean }
    fastAckFailed: boolean
}

function fixture(t: TestContext, config = vadConfig) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected HTTP') })
    const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected native process') })
    const execFile = t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected native process') })
    const sent: Array<Record<string, unknown>> = []
    const ws = { send(data: string | Buffer) {
        assert.equal(typeof data, 'string', 'mock TTS produces no output frames')
        sent.push(JSON.parse(data as string) as Record<string, unknown>)
    } }
    const decodeStream = t.mock.fn((frame: Buffer) => {
        if (frame[0] === 9) throw new Error('mock invalid Opus')
        if (frame[0] === 2) return Buffer.alloc(0)
        return pcm(frame[0] === 1 ? 1600 : 0)
    })
    const createDecoder = t.mock.fn(() => ({ decodeFrame: decodeStream, dispose: t.mock.fn(() => undefined) }))
    const decodeBatch = t.mock.fn((_frames: Buffer[]) => pcm(1600))
    const transcribe = t.mock.fn(async (_wav: Buffer) => 'mock utterance')
    const submitPrompt = t.mock.fn(async (_text: string) => 'Mock reply.')
    const interrupt = t.mock.fn(async () => undefined)
    const synthesizeSano = t.mock.fn(async (_text: string) => Buffer.from('mock wav'))
    const synthesizeHermes = t.mock.fn(async (_text: string) => Buffer.from('mock wav'))
    const encode = t.mock.fn((_wav: Buffer) => [] as Buffer[])
    const unregister = t.mock.fn(() => undefined)
    const session = new Session(ws as never, {
        registerDeviceSession: () => unregister,
        createInputOpusDecoder: createDecoder,
        decodeOpusFrames: decodeBatch,
        transcribeWav: transcribe,
        hermes: { submitPrompt, interrupt, dispose: async () => undefined },
        synthesizeSanoText: synthesizeSano,
        synthesizeHermesText: synthesizeHermes,
        encodeWavToOpusFrames: encode,
        localVadConfig: { ...config }, postTtsCooldownMs: 0, bargeInEnabled: false,
    })
    const capture = session as unknown as Capture
    capture.localTtsOutputConfig.enabled = false
    capture.fastAckFailed = true
    t.after(() => {
        session.close()
        assert.equal(unregister.mock.callCount(), 0, 'pre-hello fixtures are not device owners')
        for (const forbidden of [fetch, spawn, execFile]) assert.equal(forbidden.mock.callCount(), 0)
    })
    return {
        session, capture, sent, decodeStream, createDecoder, decodeBatch, transcribe,
        submitPrompt, interrupt, synthesizeSano, synthesizeHermes, encode,
        start(mode = 'manual') { session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode })) },
        stop() { session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' })) },
        frame(value: number) { session.handleMessage(wrapOpusPayload(Buffer.from([value]), 3)) },
    }
}

type Fixture = ReturnType<typeof fixture>

async function flushPromises(): Promise<void> {
    // Pipeline mocks resolve synchronously; no wall-clock waits or provider I/O.
    for (let i = 0; i < 100; i++) await Promise.resolve()
}

function assertNoPipeline(f: Fixture): void {
    for (const call of [f.decodeBatch, f.transcribe, f.submitPrompt, f.interrupt,
        f.synthesizeSano, f.synthesizeHermes, f.encode]) assert.equal(call.mock.callCount(), 0)
    assert.equal(f.sent.some(msg => ['stt', 'llm', 'tts', 'alert'].includes(String(msg['type']))), false)
}

function assertStopped(f: Fixture): void {
    const status = f.session.getBridgeStatus()
    assert.equal(status.state, 'idle')
    assert.equal(status.readyForPrompt, false)
    assert.equal(status.reason, 'state_idle')
    assert.equal(status.connected, true)
    assert.equal(status.ttsStreaming, false)
    assert.equal(status.pendingMcp, 0)
    for (const buffer of [f.capture.opusFrames, f.capture.pcmChunks, f.capture.preRollPcmChunks]) assert.deepEqual(buffer, [])
    assert.equal(f.capture.currentSpeechMs, 0)
    assert.equal(f.capture.streamingDecodeFailed, false)
    assert.equal(f.capture.streamingDecodeFailures, 0)
    for (const timer of [f.capture.silenceTimer, f.capture.maxDurationTimer, f.capture.delayedListenTimer]) assert.equal(timer, undefined)
    const vad = f.capture.localVad.processPcm(Buffer.alloc(0))
    assert.equal(vad.inSpeech, false)
    assert.equal(vad.speechMs, 0)
    assert.equal(vad.silenceMs, 0)
    const leds = f.sent.filter(msg => msg['type'] === 'mcp').map(msg =>
        ((msg['payload'] as Record<string, unknown>)['params'] as Record<string, unknown>)['arguments'])
    assert.deepEqual(leds.at(-1), { red: 0, green: 0, blue: 0 })
    assertNoPipeline(f)
}

async function assertTurn(f: Fixture, source: string, batchFrames?: number): Promise<void> {
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    assert.equal(f.session.getBridgeStatus().readyForPrompt, false)
    assert.equal(f.session.getBridgeStatus().reason, 'state_processing')
    assert.equal(f.capture.processingSource, source)
    assert.equal(f.capture.silenceTimer, undefined)
    assert.equal(f.capture.maxDurationTimer, undefined)
    await flushPromises()
    assert.equal(f.transcribe.mock.callCount(), 1)
    assert.equal(f.transcribe.mock.calls[0].arguments[0].subarray(0, 4).toString(), 'RIFF')
    assert.equal(f.submitPrompt.mock.callCount(), 1)
    const promptArgs = f.submitPrompt.mock.calls[0].arguments as unknown as [string, { signal: AbortSignal; deadline: number }]
    assert.equal(promptArgs[0], 'mock utterance')
    assert.ok(promptArgs[1].signal instanceof AbortSignal)
    assert.ok(Number.isFinite(promptArgs[1].deadline))
    assert.equal(f.synthesizeSano.mock.callCount(), 1)
    assert.equal(f.synthesizeHermes.mock.callCount(), 0)
    assert.equal(f.encode.mock.callCount(), 1)
    assert.equal(f.decodeBatch.mock.callCount(), batchFrames === undefined ? 0 : 1)
    if (batchFrames !== undefined) assert.equal(f.decodeBatch.mock.calls[0].arguments[0].length, batchFrames)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    assert.equal(f.session.getBridgeStatus().ttsStreaming, false)
    assert.equal(f.sent.filter(msg => msg['type'] === 'tts' && msg['state'] === 'stop').length, 1)
}

for (const mode of ['manual', 'auto', 'realtime']) {
    test(`explicit ${mode} stop discards healthy-VAD silence and cannot restart from stale timers`, async t => {
        const f = fixture(t)
        f.start(mode)
        for (let i = 0; i < 30; i++) f.frame(0)
        assert.equal(f.capture.opusFrames.length, 30)
        assert.ok(f.capture.preRollPcmChunks.length > 0)
        assert.equal(f.capture.pcmChunks.length, 0)
        assert.equal(f.capture.currentSpeechMs, 0)
        assert.ok(f.capture.maxDurationTimer !== undefined)
        const decoder = f.capture.streamingDecoder
        f.stop()
        assertStopped(f)
        assert.notEqual(f.capture.streamingDecoder, decoder)
        f.stop()
        f.frame(1) // Late audio after native stop is ignored while bridge is idle.
        assert.equal(f.decodeStream.mock.callCount(), 30)
        t.mock.timers.tick(120_000)
        await flushPromises()
        assertStopped(f)
        f.start(mode)
        assert.equal(f.session.getBridgeStatus().readyForPrompt, true)
        assert.equal(f.session.getBridgeStatus().reason, 'ready')
        assert.deepEqual(f.capture.opusFrames, [])
        f.stop()
        assertStopped(f)
    })
}

test('explicit stop with no audio frames stays idle rather than resuming empty capture', async t => {
    const f = fixture(t)
    f.start('auto')
    f.stop()
    await flushPromises()
    assertStopped(f)
})

test('explicit stop discards PCM below the VAD speech-onset threshold', async t => {
    const f = fixture(t, { ...vadConfig, startSpeechMs: 120 })
    f.start()
    f.frame(1)
    assert.equal(f.capture.currentSpeechMs, 0)
    assert.equal(f.capture.pcmChunks.length, 0)
    f.stop()
    await flushPromises()
    assertStopped(f)
})

test('explicit stop after ignored-short reset drops old Opus and pre-roll without ASR', async t => {
    const f = fixture(t)
    f.start('realtime')
    f.frame(1) // Speech starts, but 60ms is below the 120ms minimum.
    assert.equal(f.capture.currentSpeechMs, 60)
    assert.ok(f.capture.pcmChunks.length > 0)
    f.frame(0)
    f.frame(0)
    assert.equal(f.capture.opusFrames.length, 3)
    assert.equal(f.capture.currentSpeechMs, 0)
    assert.equal(f.capture.pcmChunks.length, 0)
    assert.ok(f.capture.preRollPcmChunks.length > 0)
    f.stop()
    t.mock.timers.tick(120_000)
    await flushPromises()
    assertStopped(f)
})

test('explicit stop after a recovered decode error and subsequent silent PCM is still a silent stop', async t => {
    if (readEnvInt('STACKCHAN_STREAMING_DECODE_FAILURE_LIMIT', 3, 1, 20) === 1) {
        t.skip('configured one-error limit makes transient recovery unavailable')
        return
    }
    const f = fixture(t)
    f.start()
    f.frame(9)
    f.frame(0)
    assert.equal(f.capture.streamingDecodeFailures, 0)
    assert.equal(f.capture.streamingDecodeFailed, false)
    assert.ok(f.capture.silenceTimer !== undefined)
    f.stop()
    await flushPromises()
    assertStopped(f)
})

test('explicit stop with successfully decoded empty PCM does not batch-decode Opus into a turn', async t => {
    const f = fixture(t)
    f.start()
    f.frame(2)
    assert.equal(f.capture.opusFrames.length, 1)
    f.stop()
    await flushPromises()
    assertStopped(f)
})

for (const speechFrames of [1, 2]) {
    test(`manual stop still forces detected speech (${speechFrames * 60}ms) without changing minimum rules`, async t => {
        const f = fixture(t)
        f.start()
        for (let i = 0; i < speechFrames; i++) f.frame(1)
        assert.equal(f.capture.currentSpeechMs, speechFrames * 60)
        f.stop()
        await assertTurn(f, 'listen-stop')
    })
}

test('manual stop preserves detected speech even when zero pre-roll leaves no selected PCM yet', async t => {
    const f = fixture(t, { ...vadConfig, preRollMs: 0 })
    f.start()
    f.frame(1)
    assert.equal(f.capture.currentSpeechMs, 60)
    assert.deepEqual(f.capture.pcmChunks, [])
    f.stop()
    await assertTurn(f, 'listen-stop', 1)
})

test('healthy VAD maximum duration with no speech still resets and resumes listening', async t => {
    const f = fixture(t)
    f.start()
    f.frame(0)
    t.mock.timers.tick(readTurnControlConfig().maxRecordingMs)
    await flushPromises()
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    assert.equal(f.session.getBridgeStatus().readyForPrompt, true)
    assert.deepEqual(f.capture.opusFrames, [])
    assert.ok(f.capture.maxDurationTimer !== undefined)
    assertNoPipeline(f)
})

test('max-duration force still processes detected speech below the minimum', async t => {
    const f = fixture(t)
    f.start()
    f.frame(1)
    t.mock.timers.tick(readTurnControlConfig().maxRecordingMs)
    await assertTurn(f, 'max-duration')
})

test('normal local VAD still ends a turn at the configured 650ms pause without explicit stop', async t => {
    const f = fixture(t, { ...vadConfig, endSilenceMs: 650 })
    f.start()
    f.frame(1)
    f.frame(1)
    for (let i = 0; i < 10; i++) f.frame(0)
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    assertNoPipeline(f)
    f.frame(0) // 660ms silent PCM crosses the 650ms threshold.
    await assertTurn(f, 'local-vad')
})

test('VAD-disabled explicit stop preserves forced batch decode below the frame minimum', async t => {
    const f = fixture(t, { ...vadConfig, enabled: false })
    f.start()
    f.frame(0)
    assert.equal(f.decodeStream.mock.callCount(), 0)
    f.stop()
    await assertTurn(f, 'listen-stop', 1)
})

test('decode-fallback explicit stop preserves forced batch decode and cancels arrival-gap timers', async t => {
    const f = fixture(t)
    f.start()
    const limit = readEnvInt('STACKCHAN_STREAMING_DECODE_FAILURE_LIMIT', 3, 1, 20)
    for (let i = 0; i < limit; i++) f.frame(9)
    assert.equal(f.capture.streamingDecodeFailed, true)
    f.frame(0)
    assert.ok(f.capture.silenceTimer !== undefined)
    assertNoPipeline(f)
    f.stop()
    await assertTurn(f, 'listen-stop', limit + 1)
})

test('a transient undecodable frame remains eligible for existing forced decode on stop', async t => {
    const f = fixture(t)
    f.start()
    f.frame(9)
    assert.equal(f.capture.streamingDecodeFailures, 1)
    f.stop()
    await assertTurn(f, 'listen-stop', 1)
})
