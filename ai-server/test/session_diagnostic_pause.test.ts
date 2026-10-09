import { before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { wrapOpusPayload } from '../src/audio.ts'
import { registerDeviceSession, startDeviceControlServer } from '../src/device_control.ts'
import { startWebSocketKeepalive } from '../src/websocket_keepalive.ts'
import type { Session as SessionType } from '../src/session.ts'

let Session: typeof SessionType
before(async () => {
    // Exercise hello with fast-ack enabled, without reading any environment file.
    const previous = process.env.STACKCHAN_FAST_ACK_ENABLED
    process.env.STACKCHAN_FAST_ACK_ENABLED = 'true'
    try { ({ Session } = await import('../src/session.ts')) }
    finally {
        if (previous === undefined) delete process.env.STACKCHAN_FAST_ACK_ENABLED
        else process.env.STACKCHAN_FAST_ACK_ENABLED = previous
    }
})

type Capture = {
    opusFrames: Buffer[]
    pcmChunks: Buffer[]
    preRollPcmChunks: Buffer[]
    silenceTimer?: ReturnType<typeof setTimeout>
    maxDurationTimer?: ReturnType<typeof setTimeout>
    delayedListenTimer?: ReturnType<typeof setTimeout>
    processingTurn?: AbortController
    fastAckWarmup?: AbortController
    followupQueue: string[]
    localTtsOutputConfig: { enabled: boolean }
    fastAckFailed: boolean
    state: 'idle' | 'listening' | 'processing'
    ttsStreaming: boolean
}

function fixture(t: TestContext, paused?: string, vad = true) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
    const timeout = t.mock.method(globalThis, 'setTimeout')
    const interval = t.mock.method(globalThis, 'setInterval')
    const forbidden = [
        t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected HTTP') }),
        t.mock.method(http, 'request', () => { throw new Error('unexpected HTTP') }),
        t.mock.method(http, 'get', () => { throw new Error('unexpected HTTP') }),
        t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected native process') }),
        t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected native process') }),
    ]
    const logs = t.mock.method(console, 'log', () => undefined)
    const errors = t.mock.method(console, 'error', () => undefined)
    const warnings = t.mock.method(console, 'warn', () => undefined)
    const sent: Array<Record<string, unknown>> = []
    const ws = Object.assign(new EventEmitter(), {
        readyState: 1,
        send(data: string | Buffer) {
            assert.equal(typeof data, 'string', 'mock encoder emits no audio')
            sent.push(JSON.parse(data as string) as Record<string, unknown>)
        },
        ping: t.mock.fn((_data?: unknown, _mask?: unknown, callback?: (error?: Error) => void) => {
            callback?.()
            ws.emit('pong')
        }),
        terminate: t.mock.fn(() => ws.emit('close')),
    })
    const pcm = Buffer.alloc(1920)
    for (let i = 0; i < 960; i++) pcm.writeInt16LE(1600, i * 2)
    const decodeFrame = t.mock.fn((_frame: Buffer) => pcm)
    const createDecoder = t.mock.fn(() => ({ decodeFrame, dispose: t.mock.fn(() => undefined) }))
    const decodeBatch = t.mock.fn((_frames: Buffer[]) => pcm)
    const transcribe = t.mock.fn(async (_wav: Buffer) => 'Mock utterance')
    const submitPrompt = t.mock.fn(async (_prompt: string) => 'Mock reply.')
    const streamPrompt = t.mock.fn(async function* (_prompt: string) {
        yield { type: 'complete' as const, text: 'Mock reply.' }
    })
    const interrupt = t.mock.fn(async () => undefined)
    const dispose = t.mock.fn(async () => undefined)
    const synthesize = t.mock.fn(async (_text: string) => Buffer.from('mock wav'))
    const encode = t.mock.fn((_wav: Buffer) => [] as Buffer[])
    const unregister = t.mock.fn(() => undefined)
    const previous = process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED
    if (paused === undefined) delete process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED
    else process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED = paused
    let session: SessionType
    try {
        session = new Session(ws as never, {
            registerDeviceSession: bridge => {
                const remove = registerDeviceSession(bridge)
                return () => { remove(); unregister() }
            },
            hermes: { submitPrompt, streamPrompt, interrupt, dispose },
            createInputOpusDecoder: createDecoder, decodeOpusFrames: decodeBatch,
            transcribeWav: transcribe, synthesizeSanoText: synthesize,
            synthesizeHermesText: synthesize, encodeWavToOpusFrames: encode,
            autoLedEnabled: false, bargeInEnabled: true, postTtsCooldownMs: 0,
            localVadConfig: {
                enabled: vad, rmsThreshold: 0.012, startSpeechMs: 60,
                endSilenceMs: 120, minSpeechMs: 120, preRollMs: 120,
            },
        })
    } finally {
        if (previous === undefined) delete process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED
        else process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED = previous
    }
    const capture = session as unknown as Capture
    capture.localTtsOutputConfig.enabled = false
    capture.fastAckFailed = true // hello resets this, so paused hello tests still exercise warmup gating
    t.after(() => {
        session.close()
        assert.equal(unregister.mock.callCount(), 1)
        assert.equal(dispose.mock.callCount(), 1)
        for (const mock of forbidden) assert.equal(mock.mock.callCount(), 0)
    })
    const json = (message: Record<string, unknown>) => session.handleMessage(JSON.stringify(message))
    return {
        session, capture, sent, ws, timeout, interval, logs, errors, warnings,
        createDecoder, decodeFrame, decodeBatch, transcribe, submitPrompt, streamPrompt,
        synthesize, encode, interrupt,
        json,
        hello() { json({ type: 'hello', version: 3, features: { mcp: true } }) },
        frame() { session.handleMessage(wrapOpusPayload(Buffer.from([1]), 3)) },
    }
}

type Fixture = ReturnType<typeof fixture>
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve() }

function assertNoTurn(f: Fixture) {
    for (const mock of [f.decodeFrame, f.decodeBatch, f.transcribe, f.submitPrompt,
        f.streamPrompt, f.synthesize, f.encode]) assert.equal(mock.mock.callCount(), 0)
    assert.equal(f.capture.processingTurn, undefined)
    assert.equal(f.capture.fastAckWarmup, undefined)
    for (const buffer of [f.capture.opusFrames, f.capture.pcmChunks, f.capture.preRollPcmChunks,
        f.capture.followupQueue]) assert.deepEqual(buffer, [])
    for (const timer of [f.capture.silenceTimer, f.capture.maxDurationTimer,
        f.capture.delayedListenTimer]) assert.equal(timer, undefined)
    assert.equal(f.sent.some(msg => ['stt', 'llm', 'tts', 'alert'].includes(String(msg['type']))), false)
    assert.equal(f.errors.mock.callCount(), 0)
    assert.equal(f.warnings.mock.callCount(), 0)
}

for (const paused of [undefined, 'false']) {
    test(`voice pause defaults off (${paused ?? 'unset'}): ordinary capture and STT/LLM remain usable`, async t => {
        const f = fixture(t, paused)
        assert.equal(f.session.getBridgeStatus().diagnosticVoicePaused, false)
        assert.equal(f.session.getBridgeStatus().reason, 'state_idle')
        f.json({ type: 'listen', state: 'start', mode: 'manual' })
        assert.equal(f.session.getBridgeStatus().readyForPrompt, true)
        assert.equal(f.session.getBridgeStatus().reason, 'ready')
        f.frame()
        f.frame()
        assert.equal(f.capture.opusFrames.length, 2)
        assert.equal(f.decodeFrame.mock.callCount(), 2)
        assert.ok(f.capture.maxDurationTimer)
        f.json({ type: 'listen', state: 'stop' })
        await flush()
        assert.equal(f.transcribe.mock.callCount(), 1)
        assert.equal(f.streamPrompt.mock.callCount(), 1)
        assert.equal(f.synthesize.mock.callCount(), 1)
        assert.equal(f.session.getBridgeStatus().state, 'idle')
        await f.session.enqueueFollowup('Mock followup')
        await flush()
        assert.equal(f.streamPrompt.mock.callCount(), 2)
    })
}

for (const vad of [true, false]) {
    test(`paused voice discards audio and every listen control without capture or timers (VAD=${vad})`, async t => {
        const f = fixture(t, 'true', vad)
        // Keep the pre-hello readiness reason, but expose the pause bit immediately.
        assert.equal(f.session.getBridgeStatus().reason, 'state_idle')
        assert.equal(f.session.getBridgeStatus().diagnosticVoicePaused, true)
        f.frame()
        f.hello()
        for (const mode of ['manual', 'auto', 'realtime']) {
            for (const state of ['start', 'detect', 'stop']) {
                f.json({ type: 'listen', state, mode, text: 'private fixture marker' })
                for (let i = 0; i < 20; i++) f.frame()
            }
        }
        // Firmware text controls can also arrive in Buffer-framed WS messages.
        f.session.handleMessage(Buffer.from(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' })))
        f.session.handleMessage(Buffer.from([0, 1, 2])) // malformed audio must also be discarded
        t.mock.timers.tick(120_000)
        await flush()
        const status = f.session.getBridgeStatus()
        assert.equal(status.connected, true)
        assert.equal(status.state, 'idle')
        assert.equal(status.readyForPrompt, false)
        assert.equal(status.reason, 'diagnostic_voice_paused')
        assert.equal(status.lastListenMode, '')
        assert.equal(f.createDecoder.mock.callCount(), 2, 'listen never recreates capture decoders')
        assert.equal(f.timeout.mock.callCount(), 0)
        assert.equal(f.interval.mock.callCount(), 0)
        assert.equal(f.logs.mock.calls.some(call => call.arguments.some(value =>
            typeof value === 'string' && value.includes('private fixture marker'))), false)
        assertNoTurn(f)
        f.session.close()
        assert.equal(f.session.getBridgeStatus().reason, 'closed')
    })
}

test('pause is evaluated for each new session, never dynamically unpausing an existing connection', async t => {
    const f = fixture(t, ' ON ')
    // fixture already restored the environment after construction.
    f.hello()
    f.json({ type: 'listen', state: 'start' })
    f.frame()
    await assert.rejects(f.session.enqueueFollowup('private prompt marker'), {
        message: 'StackChan diagnostic voice pause is enabled',
    })
    assert.equal(f.session.getBridgeStatus().diagnosticVoicePaused, true)
    assertNoTurn(f)
    const previous = process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED
    delete process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED
    let next: SessionType
    try {
        next = new Session({ send() {} } as never, {
            hermes: { submitPrompt: async () => '', interrupt: async () => undefined, dispose: async () => undefined },
            registerDeviceSession: () => () => undefined,
            createInputOpusDecoder: () => ({ decodeFrame: () => Buffer.alloc(0), dispose() {} }),
        })
    } finally {
        if (previous !== undefined) process.env.STACKCHAN_DIAGNOSTIC_VOICE_PAUSED = previous
    }
    try { assert.equal(next.getBridgeStatus().diagnosticVoicePaused, false) }
    finally { next.close() }
})

test('pause blocks barge-in decoding even if audio arrives in a processing state', t => {
    const f = fixture(t, 'yes')
    // Defensive ingress check: cannot rely solely on idle/listening state.
    f.capture.state = 'processing'
    f.capture.ttsStreaming = true
    f.frame()
    f.capture.state = 'idle'
    f.capture.ttsStreaming = false
    assertNoTurn(f)
    assert.equal(f.timeout.mock.callCount(), 0)
})

test('paused hello, robot MCP results, abort control and transport heartbeat remain usable', async t => {
    const f = fixture(t, '1')
    f.hello()
    assert.equal(f.sent[0]['type'], 'hello')
    assert.equal(f.sent[0]['transport'], 'websocket')
    assert.equal(f.capture.fastAckWarmup, undefined)
    for (const name of ['self.robot.get_status', 'self.robot.set_head_angles']) {
        const result = f.session.callRobotTool(name, name.endsWith('set_head_angles') ? { yaw: 0, pitch: 0 } : {})
        const payload = f.sent.at(-1)!['payload'] as Record<string, unknown>
        assert.equal(payload['method'], 'tools/call')
        assert.equal((payload['params'] as Record<string, unknown>)['name'], name)
        assert.equal(f.session.getBridgeStatus().pendingMcp, 1)
        f.json({ type: 'mcp', payload: { jsonrpc: '2.0', id: payload['id'], result: { ok: true } } })
        assert.deepEqual(await result, { ok: true })
        assert.equal(f.session.getBridgeStatus().pendingMcp, 0)
    }
    f.json({ type: 'abort' })
    await flush()
    assert.equal(f.interrupt.mock.callCount(), 1)
    assert.equal(f.session.getBridgeStatus().reason, 'diagnostic_voice_paused')
    const stop = startWebSocketKeepalive(f.ws as never, 3000)
    t.after(stop)
    t.mock.timers.tick(30_000)
    assert.ok(f.ws.ping.mock.callCount() > 0)
    assert.equal(f.ws.terminate.mock.callCount(), 0)
    assert.equal(f.session.getBridgeStatus().connected, true)
    assertNoTurn(f)
})

test('existing control HTTP API reports the bit and rejects paused prompts instead of acknowledging queueing', async t => {
    const f = fixture(t, 'true')
    f.hello()
    let handler!: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
    t.mock.method(http, 'createServer', (listener: typeof handler) => {
        handler = listener
        return { listen(_port: number, _host: string, callback: () => void) { callback() } } as never
    })
    startDeviceControlServer(0)
    async function request(method: string, url: string, body?: unknown) {
        const req = Object.assign(new EventEmitter(), { method, url })
        let code = 0
        let result: Record<string, unknown> = {}
        const res = {
            writeHead(status: number) { code = status },
            end(data: string) { result = JSON.parse(data) as Record<string, unknown> },
        }
        const done = handler(req as never, res as never)
        if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
        await done
        return { code, result }
    }
    const status = await request('GET', '/internal/status')
    assert.equal(status.code, 200)
    assert.equal((status.result['result'] as Record<string, unknown>)['diagnosticVoicePaused'], true)
    const rejection = await request('POST', '/internal/followup', { prompt: 'private prompt marker' })
    assert.equal(rejection.code, 500, 'preserve the existing Promise-rejection HTTP contract')
    assert.deepEqual(rejection.result, { success: false, error: 'StackChan diagnostic voice pause is enabled' })
    await assert.rejects(f.session.enqueueFollowup(''), /diagnostic voice pause is enabled/)
    assert.equal(JSON.stringify(f.session.getBridgeStatus()).includes('private prompt marker'), false)
    assert.equal(f.timeout.mock.callCount(), 0)
    assert.equal(f.interval.mock.callCount(), 0)
    assertNoTurn(f)
})
