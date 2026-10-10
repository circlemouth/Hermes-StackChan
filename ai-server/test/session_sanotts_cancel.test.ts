import { before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { wrapOpusPayload } from '../src/audio.ts'
import type { HermesPromptStreamEvent } from '../src/hermes.ts'
import type { SanoTtsOptions } from '../src/sanotts_audio.ts'
import type { Session as SessionType } from '../src/session.ts'

let Session: typeof SessionType
before(async () => {
    // Feature constants are captured at module initialization in this isolated
    // test process. Restore the environment before running any test body.
    const values = { STACKCHAN_FAST_ACK_ENABLED: 'true', STACKCHAN_FAST_ACK_TEXTS: 'Mock ack one.|Mock ack two.' }
    const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    try { ({ Session } = await import('../src/session.ts')) }
    finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

async function flush() {
    for (let index = 0; index < 100; index++) await Promise.resolve()
}

type Capture = {
    fastAckFailed: boolean
    fastAckEntries?: Array<{ text: string; wav: Buffer; frames: Buffer[] }>
    fastAckWarmup?: AbortController
    warmFastAck(): Promise<void>
    localTtsOutputConfig: { enabled: boolean }
    cooldownUntil: number
    activeTtsPlayback?: { controller: AbortController }
}

type SanoCall = ReturnType<typeof deferred<Buffer>> & { text: string; signal: AbortSignal }
function fixture(t: TestContext, streamPrompt?: (prompt: string) => AsyncIterable<HermesPromptStreamEvent>, bargeIn = false, enableTimers = true) {
    if (enableTimers) t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
    const forbidden = [
        t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected HTTP') }),
        t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected native process') }),
        t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected native process') }),
    ]
    const logs = t.mock.method(console, 'log', () => undefined)
    const errors = t.mock.method(console, 'error', () => undefined)
    const warnings = t.mock.method(console, 'warn', () => undefined)
    const sent: Array<string | Buffer> = []
    const calls: SanoCall[] = []
    const synthesizeSano = t.mock.fn(async (text: string, options: SanoTtsOptions = {}) => {
        assert.ok(options.signal, 'every Sano request owns an AbortSignal')
        const call = { ...deferred<Buffer>(), text, signal: options.signal }
        calls.push(call)
        return call.promise
    })
    const synthesizeHermes = t.mock.fn(async (_text: string) => Buffer.from('Hermes fixture WAV'))
    const encode = t.mock.fn((_wav: Buffer) => [] as Buffer[])
    const transcribe = t.mock.fn(async (_wav: Buffer) => 'Mock utterance')
    const submitPrompt = t.mock.fn(async (prompt: string) => `${prompt}。`)
    const interrupt = t.mock.fn(async () => undefined)
    const unregister = t.mock.fn(() => undefined)
    let registered = false
    const speechPcm = Buffer.alloc(1920)
    for (let index = 0; index < 960; index++) speechPcm.writeInt16LE(3000, index * 2)
    const session = new Session({ send: (data: string | Buffer) => { sent.push(data) } } as never, {
        registerDeviceSession: () => { registered = true; return unregister },
        createInputOpusDecoder: () => ({ decodeFrame: () => speechPcm, dispose: () => undefined }),
        decodeOpusFrames: () => speechPcm,
        transcribeWav: transcribe,
        hermes: { submitPrompt, streamPrompt, interrupt, dispose: async () => undefined },
        synthesizeSanoText: synthesizeSano, synthesizeHermesText: synthesizeHermes,
        encodeWavToOpusFrames: encode, autoLedEnabled: false,
        localVadConfig: { enabled: false, rmsThreshold: 0.012, startSpeechMs: 60, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
        bargeInConfig: { enabled: bargeIn, rmsThreshold: 0.03, startSpeechMs: 180, minSpeechMs: 180, ignoreTtsStartMs: 0 },
        postTtsCooldownMs: 500,
    })
    const capture = session as unknown as Capture
    capture.fastAckFailed = true // unrelated background warming is opt-in per test
    capture.localTtsOutputConfig.enabled = false
    t.after(() => {
        session.close()
        assert.equal(unregister.mock.callCount(), registered ? 1 : 0)
        for (const mock of forbidden) assert.equal(mock.mock.callCount(), 0)
    })
    const json = () => sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item) as Record<string, unknown>)
    return {
        session, capture, sent, calls, synthesizeSano, synthesizeHermes, encode, transcribe, submitPrompt, interrupt, logs, errors, warnings, json,
        abort() { session.handleMessage(JSON.stringify({ type: 'abort' })) },
        listen() { session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' })) },
        frame() { session.handleMessage(wrapOpusPayload(Buffer.from([1]), 3)) },
        stop() { session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' })) },
        hello(provider = 'sanotts') { session.handleMessage(JSON.stringify({ type: 'hello', tts_provider: provider })) },
        async followup(prompt = 'Mock greeting') { await session.enqueueFollowup(prompt); await flush() },
    }
}

type Fixture = ReturnType<typeof fixture>
function assertQuietCancellation(f: Fixture) {
    assert.equal(f.errors.mock.callCount(), 0)
    assert.equal(f.warnings.mock.callCount(), 0)
    assert.equal(f.synthesizeHermes.mock.callCount(), 0, 'cancellation never falls back to Hermes')
    assert.equal(f.json().filter(item => item['type'] === 'alert').length, 0)
    assert.equal(f.logs.mock.calls.some(call => call.arguments.some(value =>
        typeof value === 'string' && value.startsWith('[timing] error ') && value.includes('.synthesize'))), false)
}
function stops(f: Fixture) { return f.json().filter(item => item['type'] === 'tts' && item['state'] === 'stop').length }

for (const settlement of ['resolve', 'reject'] as const) {
    test(`abort cancels pending greeting Sano and suppresses its late ${settlement}`, async t => {
        const f = fixture(t)
        await f.followup()
        assert.equal(f.calls.length, 1)
        assert.equal(f.calls[0].signal.aborted, false)
        f.abort()
        assert.equal(f.calls[0].signal.aborted, true)
        const sentAtAbort = f.sent.length
        if (settlement === 'resolve') f.calls[0].resolve(Buffer.from('stale WAV'))
        else f.calls[0].reject(new Error('sanoTTS-jp synthesis aborted'))
        await flush()
        assert.equal(f.sent.length, sentAtAbort)
        assert.equal(f.encode.mock.callCount(), 0)
        assert.equal(f.calls.length, 1, 'no error speech after cancellation')
        assert.equal(f.session.getBridgeStatus().state, 'idle')
        assert.equal(stops(f), 1)
        assertQuietCancellation(f)
    })

    test(`old ${settlement}/finally cannot stop or clear a subsequent pending turn`, async t => {
        const f = fixture(t)
        await f.followup('Old greeting')
        f.abort()
        await f.followup('New greeting')
        assert.equal(f.calls.length, 2)
        const playback = f.capture.activeTtsPlayback
        const sentBeforeOldCompletion = f.sent.length
        if (settlement === 'resolve') f.calls[0].resolve(Buffer.from('stale WAV'))
        else f.calls[0].reject(new Error('ordinary abort error'))
        await flush()
        assert.equal(f.calls[1].signal.aborted, false)
        assert.equal(f.capture.activeTtsPlayback, playback)
        assert.equal(f.session.getBridgeStatus().state, 'processing')
        assert.equal(f.session.getBridgeStatus().ttsStreaming, true)
        assert.equal(f.capture.cooldownUntil, 0)
        assert.equal(f.sent.length, sentBeforeOldCompletion)
        assert.equal(f.encode.mock.callCount(), 0)
        f.calls[1].resolve(Buffer.from('current WAV'))
        await flush()
        assert.equal(f.session.getBridgeStatus().state, 'idle')
        assert.equal(f.encode.mock.callCount(), 1)
        assert.equal(stops(f), 2)
        assertQuietCancellation(f)
    })
}

test('close aborts pending synthesis and suppresses late output and subsequent input', async t => {
    const f = fixture(t)
    await f.followup()
    f.session.close()
    const sentAtClose = f.sent.length
    assert.equal(f.calls[0].signal.aborted, true)
    f.calls[0].resolve(Buffer.from('closed WAV'))
    f.listen()
    f.frame()
    f.stop()
    await assert.rejects(f.followup('closed followup'), /session is closed/)
    await flush()
    assert.equal(f.sent.length, sentAtClose)
    assert.equal(f.encode.mock.callCount(), 0)
    assert.equal(f.calls.length, 1)
    assert.equal(f.session.getBridgeStatus().connected, false)
    assertQuietCancellation(f)
})

test('explicit new listen turn cancels the previous pending playback without an abort message', async t => {
    const f = fixture(t)
    await f.followup('Old greeting')
    f.listen()
    assert.equal(f.calls[0].signal.aborted, true)
    f.frame()
    f.stop()
    await flush()
    assert.equal(f.calls.length, 2)
    f.calls[0].reject(new Error('sanoTTS-jp synthesis aborted'))
    await flush()
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    assert.equal(f.calls[1].signal.aborted, false)
    f.calls[1].resolve(Buffer.from('current WAV'))
    await flush()
    assert.equal(f.encode.mock.callCount(), 1)
    assertQuietCancellation(f)
})

test('late ASR after abort cannot start fast ack, Hermes or Sano for the old turn', async t => {
    const f = fixture(t)
    const asr = deferred<string>()
    f.transcribe.mock.mockImplementation(async () => asr.promise)
    f.listen(); f.frame(); f.stop()
    await flush()
    f.abort()
    await f.followup('Current greeting')
    const count = f.sent.length
    asr.resolve('Stale transcript')
    await flush()
    assert.equal(f.sent.length, count)
    assert.equal(f.submitPrompt.mock.callCount(), 1)
    assert.equal(f.calls.length, 1)
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    assert.equal(f.session.getBridgeStatus().ttsStreaming, true)
    assert.equal(f.calls[0].signal.aborted, false)
    f.calls[0].resolve(Buffer.from('current WAV'))
    await flush()
    assertQuietCancellation(f)
})

test('late buffered Hermes reply and keepalive are suppressed after abort', async t => {
    const f = fixture(t)
    const reply = deferred<string>()
    f.submitPrompt.mock.mockImplementation(async () => reply.promise)
    await f.followup()
    f.abort()
    const count = f.sent.length
    t.mock.timers.tick(20_000)
    reply.resolve('Stale reply。')
    await flush()
    assert.equal(f.sent.length, count)
    assert.equal(f.calls.length, 0)
    assertQuietCancellation(f)
})

test('streaming queue abort suppresses pending Sano and does not synthesize later deltas', async t => {
    let continued = false
    const f = fixture(t, async function* () {
        yield { type: 'delta', text: '一つ目です。' }
        continued = true
        yield { type: 'delta', text: '二つ目です！' }
        yield { type: 'complete' }
    })
    await f.followup()
    assert.equal(f.calls.length, 1)
    f.abort()
    f.calls[0].reject(new Error('sanoTTS-jp synthesis aborted'))
    await flush()
    assert.equal(continued, false)
    assert.equal(f.calls.length, 1)
    assert.equal(f.encode.mock.callCount(), 0)
    assert.equal(stops(f), 1)
    assertQuietCancellation(f)
})

test('late stream event cannot create playback in a newer processing turn', async t => {
    const gate = deferred<void>()
    const f = fixture(t, async function* (prompt) {
        if (prompt.includes('Old')) await gate.promise
        yield { type: 'delta', text: prompt.includes('Old') ? '古い返答です。' : '新しい返答です。' }
        yield { type: 'complete' }
    })
    await f.followup('Old greeting')
    f.abort()
    await f.followup('New greeting')
    assert.equal(f.calls.length, 1)
    const playback = f.capture.activeTtsPlayback
    gate.resolve()
    await flush()
    assert.equal(f.calls.length, 1)
    assert.equal(f.capture.activeTtsPlayback, playback)
    assert.equal(f.calls[0].signal.aborted, false)
    f.calls[0].resolve(Buffer.from('current WAV'))
    await flush()
    assertQuietCancellation(f)
})

test('abort cancels the prefetched Sano segment and sends only one TTS stop', async t => {
    const f = fixture(t)
    f.encode.mock.mockImplementation(() => [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])])
    await f.followup('一つ目です。二つ目です！')
    f.calls[0].resolve(Buffer.from('first WAV'))
    await flush()
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[0].signal, f.calls[1].signal)
    assert.equal(f.sent.filter(Buffer.isBuffer).length, 1)
    f.abort()
    assert.equal(f.calls[1].signal.aborted, true)
    f.calls[1].resolve(Buffer.from('stale prefetch WAV'))
    t.mock.timers.tick(60)
    await flush()
    assert.equal(f.encode.mock.callCount(), 1)
    assert.equal(f.sent.filter(Buffer.isBuffer).length, 1)
    assert.equal(stops(f), 1)
    assertQuietCancellation(f)
})

test('enabled barge-in cancels pending synthesis and preserves the next captured turn', async t => {
    const f = fixture(t, undefined, true)
    await f.followup()
    f.frame(); f.frame(); f.frame()
    await flush()
    assert.equal(f.interrupt.mock.callCount(), 1)
    assert.equal(f.calls[0].signal.aborted, true)
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    f.calls[0].resolve(Buffer.from('stale WAV'))
    await flush()
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    assert.equal(f.encode.mock.callCount(), 0)
    assert.equal(stops(f), 1)
    f.stop()
    await flush()
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].signal.aborted, false)
    f.calls[1].resolve(Buffer.from('current WAV'))
    await flush()
    assertQuietCancellation(f)
})

test('real Sano failure still alerts and speaks the existing error fallback', async t => {
    const f = fixture(t)
    await f.followup()
    f.calls[0].reject(new Error('mock synthesis failure'))
    await flush()
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].signal.aborted, false)
    assert.notEqual(f.calls[1].text, f.calls[0].text)
    assert.ok(f.json().some(item => item['type'] === 'alert'))
    assert.equal(f.errors.mock.callCount(), 1)
    f.calls[1].resolve(Buffer.from('fallback WAV'))
    await flush()
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    assert.equal(f.encode.mock.callCount(), 1)
    assert.equal(f.synthesizeHermes.mock.callCount(), 0)
})

test('successful Sano and explicit Hermes retain normal completion and pass cancellation options', async t => {
    const f = fixture(t)
    await f.followup()
    f.calls[0].resolve(Buffer.from('normal WAV'))
    await flush()
    assert.equal(f.encode.mock.callCount(), 1)
    assert.equal(stops(f), 1)
    assert.equal(f.capture.cooldownUntil, 500)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    f.hello('hermes')
    await flush() // explicitly selected Hermes also fills its own ack cache
    const callsBeforeReply = f.synthesizeHermes.mock.callCount()
    await f.followup('Hermes greeting')
    assert.equal(f.calls.length, 1)
    assert.equal(f.synthesizeHermes.mock.callCount(), callsBeforeReply + 1)
    for (const call of f.synthesizeHermes.mock.calls) {
        assert.equal(call.arguments.length, 2)
        assert.ok((call.arguments[1] as { signal: AbortSignal }).signal)
    }
    assert.equal(stops(f), 2)
    assert.equal(f.errors.mock.callCount(), 0)
})

for (const action of ['abort', 'close'] as const) {
    test(`${action} cancels fast-ack warmup without poisoning or publishing a partial cache`, async t => {
        const f = fixture(t)
        f.capture.fastAckFailed = false
        const warm = f.capture.warmFastAck()
        await flush()
        if (action === 'abort') f.abort()
        else f.session.close()
        assert.equal(f.calls[0].signal.aborted, true)
        f.calls[0].reject(new Error('sanoTTS-jp synthesis aborted'))
        await warm
        assert.equal(f.capture.fastAckEntries, undefined)
        assert.equal(f.capture.fastAckFailed, false)
        assert.equal(f.encode.mock.callCount(), 0)
        assertQuietCancellation(f)
    })
}

test('old hello warmup cannot poison, publish into or clear a newer warmup', async t => {
    const f = fixture(t)
    f.hello()
    await flush()
    assert.equal(f.calls.length, 1)
    f.hello()
    await flush()
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[0].signal.aborted, true)
    const currentWarmup = f.capture.fastAckWarmup
    f.calls[0].resolve(Buffer.from('stale ack WAV'))
    await flush()
    assert.equal(f.capture.fastAckWarmup, currentWarmup)
    assert.equal(f.capture.fastAckFailed, false)
    assert.equal(f.capture.fastAckEntries, undefined)
    assert.equal(f.calls[1].signal.aborted, false)
    f.calls[1].resolve(Buffer.from('current ack one WAV'))
    await flush()
    assert.equal(f.calls.length, 3)
    assert.equal(f.calls[1].signal, f.calls[2].signal)
    assert.equal(f.capture.fastAckEntries, undefined)
    f.calls[2].resolve(Buffer.from('current ack two WAV'))
    await flush()
    const entries = (f.capture as Capture).fastAckEntries
    assert.ok(entries)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].wav.toString(), 'current ack one WAV')
    assert.equal(f.capture.fastAckWarmup, undefined)
    assert.equal(f.encode.mock.callCount(), 2)
    assertQuietCancellation(f)
})

test('abort during cached fast ack does not submit an old-turn Hermes prompt afterward', async t => {
    const f = fixture(t)
    f.capture.fastAckFailed = false
    f.synthesizeSano.mock.mockImplementation(async text => Buffer.from(text))
    f.encode.mock.mockImplementation(() => [Buffer.from([1]), Buffer.from([2])])
    await f.capture.warmFastAck()
    f.listen(); f.frame(); f.stop()
    await flush()
    assert.equal(f.sent.filter(Buffer.isBuffer).length, 1)
    const playback = f.capture.activeTtsPlayback
    assert.ok(playback)
    f.abort()
    assert.equal(playback.controller.signal.aborted, true)
    t.mock.timers.tick(60)
    await flush()
    assert.equal(f.submitPrompt.mock.callCount(), 0)
    assert.equal(f.sent.filter(Buffer.isBuffer).length, 1)
    assert.equal(stops(f), 1)
    assertQuietCancellation(f)
})

test('separate Sessions never share playback or warmup cancellation signals', async t => {
    const first = fixture(t)
    const second = fixture(t, undefined, false, false)
    await first.followup('First greeting')
    await second.followup('Second greeting')
    assert.notEqual(first.calls[0].signal, second.calls[0].signal)
    first.abort()
    assert.equal(first.calls[0].signal.aborted, true)
    assert.equal(second.calls[0].signal.aborted, false)
    first.calls[0].reject(new Error('sanoTTS-jp synthesis aborted'))
    second.calls[0].resolve(Buffer.from('second WAV'))
    await flush()
    assert.equal(second.encode.mock.callCount(), 1)
    first.capture.fastAckFailed = false
    second.capture.fastAckFailed = false
    const firstWarm = first.capture.warmFastAck()
    const secondWarm = second.capture.warmFastAck()
    await flush()
    assert.notEqual(first.calls[1].signal, second.calls[1].signal)
    first.abort()
    assert.equal(first.calls[1].signal.aborted, true)
    assert.equal(second.calls[1].signal.aborted, false)
    first.calls[1].reject(new Error('sanoTTS-jp synthesis aborted'))
    second.calls[1].resolve(Buffer.from('second ack one WAV'))
    await flush()
    assert.equal(second.calls.length, 3)
    second.calls[2].resolve(Buffer.from('second ack two WAV'))
    await Promise.all([firstWarm, secondWarm])
    assert.equal(first.capture.fastAckEntries, undefined)
    assert.equal(second.capture.fastAckEntries?.length, 2)
    assertQuietCancellation(first)
    assertQuietCancellation(second)
})
