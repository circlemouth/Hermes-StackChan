import { before, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { OUTPUT_FRAME_DURATION_MS, wrapOpusPayload } from '../src/audio.ts'
import type { Session as SessionType } from '../src/session.ts'
import type { SanoTtsOptions } from '../src/sanotts_audio.ts'

let Session: typeof SessionType
before(async () => {
    // These feature constants are read at import time in this isolated test process.
    // Restore the environment immediately; never load configuration or real voice.
    const values = { STACKCHAN_AUTO_RESUME_LISTENING: 'true', STACKCHAN_FAST_ACK_ENABLED: 'true', STACKCHAN_TTS_PREROLL_MS: '600' }
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
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
}
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve() }
function mockWav(sample = 0) {
    const wav = Buffer.alloc(46)
    wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8)
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28)
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(sample, 44)
    return wav
}
class FakeChild extends EventEmitter {
    stdin = null
    stderr = new EventEmitter()
    closed = false
    kill = (_signal: string) => true
    override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'close') this.closed = true
        return super.emit(event, ...args)
    }
}
function fakeChild(t: TestContext) {
    const child = new FakeChild()
    const kill = t.mock.method(child, 'kill')
    return { child, kill }
}
type LocalPlayback = { controller: AbortController; generation: number; m5SpeakerMutedForLocalOutput: boolean; localOutputTarget?: string }
type Capture = {
    fastAckFailed: boolean
    fastAckEntries?: Array<{ text: string; wav: Buffer; frames: Buffer[]; localFrames?: Buffer[] }>
    fastAckWarmup?: AbortController
    warmFastAck(): Promise<void>
    localTtsOutputConfig: { enabled: boolean; targetName: string; volume: number; fallbackM5Volume: number }
    activeTtsPlayback?: LocalPlayback
    localSpeakerOwner?: LocalPlayback
    finishTtsPlayback(playback: LocalPlayback): Promise<void>
}
type ToolMessage = { payload: { id: number; params: { name: string; arguments: { volume: number } } } }
const status = 'Audio\n ├─ Sinks:\n │ 72. Mock speaker [vol: 0.35]\n ├─ Sources:\n'
function mockFrames(sample: number) { return [Buffer.from([sample, 0x11]), Buffer.from([sample, 0x22])] }
function fixture(t: TestContext, options: { nonemptyFrames?: boolean; reply?: string; bargeIn?: boolean } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 })
    const execCalls: Array<{ args: string[]; callback: (error: Error | null, stdout: string, stderr: string) => void; process: ReturnType<typeof fakeChild> }> = []
    const playCalls: ReturnType<typeof fakeChild>[] = []
    const playedWavs: Buffer[] = []
    const files = new Map<string, { wav: Buffer; process?: ReturnType<typeof fakeChild> }>()
    const directories: string[] = []
    const fileSetup = {
        beforeWrite: async (_filename: string) => undefined as void,
        beforeRemove: async (_directory: string) => undefined as void,
    }
    t.mock.method(os, 'tmpdir', () => '/tmp/session-local-mock')
    t.mock.method(fs, 'mkdtemp', async (prefix: unknown) => {
        assert.equal(prefix, '/tmp/session-local-mock/stackchan-local-tts-')
        const directory = `${prefix}${String(directories.length + 1).padStart(6, '0')}`
        directories.push(directory)
        return directory
    })
    t.mock.method(fs, 'chmod', async (name: unknown, mode: unknown) => {
        assert.equal(typeof name, 'string')
        assert.ok(directories.some(directory => name === directory || name === `${directory}/speech.wav`))
        assert.equal(mode, String(name).endsWith('/speech.wav') ? 0o600 : 0o700)
    })
    t.mock.method(fs, 'writeFile', async (name: unknown, data: unknown, options: Record<string, unknown>) => {
        assert.equal(typeof name, 'string')
        assert.ok(directories.some(directory => name === `${directory}/speech.wav`))
        assert.ok(Buffer.isBuffer(data))
        assert.deepEqual(data, mockWav(data.readInt16LE(44)))
        assert.equal(options['flag'], 'wx')
        assert.equal(options['mode'], 0o600)
        assert.ok(options['signal'] instanceof AbortSignal)
        files.set(String(name), { wav: Buffer.from(data) })
        await fileSetup.beforeWrite(String(name))
    })
    t.mock.method(fs, 'rm', async (name: unknown, options: unknown) => {
        assert.ok(directories.includes(String(name)))
        assert.deepEqual(options, { recursive: true, force: true })
        const entry = files.get(`${name}/speech.wav`)
        if (entry?.process) assert.equal(entry.process.child.closed, true, 'Session cancellation reaps before file removal')
        await fileSetup.beforeRemove(String(name))
        files.delete(`${name}/speech.wav`)
    })
    t.mock.method(childProcess, 'execFile', (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        assert.equal(command, 'wpctl')
        const process = fakeChild(t)
        execCalls.push({ args, callback, process })
        return process.child as unknown as ReturnType<typeof childProcess.execFile>
    })
    t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: unknown) => {
        assert.equal(command, 'pw-play')
        assert.deepEqual(args.slice(0, 2), ['--target', '72'])
        assert.equal(args.length, 3)
        assert.ok(directories.some(directory => args[2] === `${directory}/speech.wav`))
        assert.deepEqual(options, { stdio: ['ignore', 'ignore', 'pipe'] })
        const entry = files.get(args[2])
        assert.ok(entry, 'complete WAV file exists before spawn')
        const process = fakeChild(t)
        entry.process = process
        playCalls.push(process)
        playedWavs.push(Buffer.from(entry.wav))
        return process.child as unknown as ReturnType<typeof childProcess.spawn>
    })
    const forbiddenHttp = t.mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP forbidden') })
    const logs = t.mock.method(console, 'log', () => undefined)
    const errors = t.mock.method(console, 'error', () => undefined)
    const warnings = t.mock.method(console, 'warn', () => undefined)
    const sent: Array<string | Buffer> = []
    let synthesizedSamples = 0
    const sano = t.mock.fn(async (_text: string, synthesisOptions: SanoTtsOptions = {}): Promise<Buffer> => {
        assert.ok(synthesisOptions.signal)
        return mockWav(options.nonemptyFrames ? ++synthesizedSamples : 0)
    })
    const encode = t.mock.fn((wav: Buffer, _leadSilenceMs = 0) => options.nonemptyFrames ? mockFrames(wav.readInt16LE(44)) : [])
    const decodeFrame = t.mock.fn((_opus: Buffer) => Buffer.alloc(1920))
    const hermesTts = t.mock.fn(async (_text: string) => mockWav())
    const session = new Session({ send: (data: string | Buffer) => { sent.push(data) } } as never, {
        registerDeviceSession: () => () => undefined,
        createInputOpusDecoder: () => ({ decodeFrame: () => Buffer.alloc(1920), dispose: () => undefined }),
        decodeOpusFrames: () => Buffer.alloc(1920),
        decodeOpusFrame: decodeFrame,
        transcribeWav: async () => 'Mock text',
        hermes: { submitPrompt: async (prompt: string) => options.reply ?? `${prompt}。`, interrupt: async () => undefined, dispose: async () => undefined },
        synthesizeSanoText: sano, synthesizeHermesText: hermesTts,
        encodeWavToOpusFrames: encode, autoLedEnabled: false,
        localVadConfig: { enabled: false, rmsThreshold: 0.012, startSpeechMs: 60, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
        bargeInConfig: { enabled: options.bargeIn ?? false, rmsThreshold: 0.03, startSpeechMs: 180, minSpeechMs: 180, ignoreTtsStartMs: 0 },
        ...(options.nonemptyFrames ? {
            postTtsCooldownMs: 300,
            speechSegmentationConfig: { maxSpeechChars: 800, segmentMaxChars: 160, maxSegments: 8 },
        } : {}),
    })
    const capture = session as unknown as Capture
    capture.fastAckFailed = true
    capture.localTtsOutputConfig = { enabled: true, targetName: 'Mock speaker', volume: 0.35, fallbackM5Volume: 62 }
    const json = () => sent.filter((value): value is string => typeof value === 'string').map(value => JSON.parse(value) as Record<string, unknown>)
    const volumes = () => json().filter(value => value['type'] === 'mcp').map(value => value as unknown as ToolMessage)
        .filter(value => value.payload.params.name === 'self.robot.set_speaker_volume')
        .map(value => ({ id: value.payload.id, volume: value.payload.params.arguments.volume }))
    const ackResult = async (index: number, result: unknown) => {
        const tool = volumes()[index]
        assert.ok(tool, `volume request ${index} must exist`)
        session.handleMessage(JSON.stringify({ type: 'mcp', payload: { id: tool.id, result } }))
        await flush()
    }
    const ack = async (index: number, error?: string) => {
        const tool = volumes()[index]
        assert.ok(tool, `volume request ${index} must exist`)
        if (error) {
            session.handleMessage(JSON.stringify({ type: 'mcp', payload: { id: tool.id, error: { message: error } } }))
            await flush()
        } else {
            await ackResult(index, {
                content: [{ type: 'text', text: JSON.stringify({ speaker_volume: tool.volume, permanent: false }) }],
                isError: false,
            })
        }
    }
    const resolveTarget = async (start = execCalls.length - 1, found = true) => {
        for (let stage = 0; stage < (found ? 3 : 1); stage++) {
            const call = execCalls[start + stage]
            assert.ok(call)
            assert.deepEqual(call.args, stage === 0 ? ['status'] : stage === 1 ? ['set-volume', '72', '0.35'] : ['set-mute', '72', '0'])
            call.callback(null, stage === 0 && found ? status : '', 'private stderr ignored')
            call.process.child.emit('close', 0)
            await flush()
        }
    }
    const start = async (prompt = 'Mock greeting') => { await session.enqueueFollowup(prompt); await flush() }
    const abort = () => session.handleMessage(JSON.stringify({ type: 'abort' }))
    const quiet = () => {
        assert.equal(errors.mock.callCount(), 0)
        assert.equal(warnings.mock.callCount(), 0)
        assert.equal(hermesTts.mock.callCount(), 0)
        assert.equal(json().some(value => value['type'] === 'alert'), false)
        assert.equal(logs.mock.calls.some(call => call.arguments.some(value => typeof value === 'string' && value.includes('private'))), false)
    }
    t.after(async () => {
        session.close()
        for (const call of execCalls) call.process.child.emit('close', null)
        for (const call of playCalls) call.child.emit('close', null)
        await flush()
        assert.equal(forbiddenHttp.mock.callCount(), 0)
        assert.equal(files.size, 0, 'all created mock WAVs cleaned up after reap')
    })
    return { session, capture, sent, json, volumes, ack, ackResult, resolveTarget, start, abort, quiet, execCalls, playCalls, playedWavs, sano, hermesTts, encode, decodeFrame, warnings, errors, logs, files, fileSetup }
}

type Fixture = ReturnType<typeof fixture>
function outputOrder(f: Fixture): string[] {
    return f.sent.flatMap(value => {
        if (Buffer.isBuffer(value)) {
            assert.deepEqual(value.subarray(0, 2), Buffer.from([0, 0]))
            assert.equal(value.readUInt16BE(2), value.length - 4)
            return [`frame:${value.subarray(4).toString('hex')}`]
        }
        const message = JSON.parse(value) as Record<string, unknown>
        return message['type'] === 'tts' ? [`${message['state']}:${message['index'] ?? ''}`] : []
    })
}
async function sendAllAvatarFrames(t: TestContext) {
    // Tick each frame separately: mocked timer callbacks resume async streaming
    // only after microtasks flush, so one large tick would miss later timers.
    for (let index = 0; index < 2; index++) {
        t.mock.timers.tick(OUTPUT_FRAME_DURATION_MS)
        await flush()
    }
}
function assertLocalPending(f: Fixture, playback: LocalPlayback, nativeCount: number, expectedOrder: string[], expectedVolumes = [0]) {
    assert.deepEqual(outputOrder(f), expectedOrder, 'no sentence boundary/tts.stop before helper completion')
    assert.equal(f.playCalls.length, nativeCount, 'next native segment cannot overlap the pending helper')
    assert.deepEqual(f.volumes().map(value => value.volume), expectedVolumes, 'M5 stays muted while local helper owns playback')
    assert.equal(f.capture.activeTtsPlayback, playback)
    assert.equal(f.capture.localSpeakerOwner, playback)
    assert.equal(playback.m5SpeakerMutedForLocalOutput, true)
    assert.equal(playback.controller.signal.aborted, false, 'normal playback is not cancelled after avatar frames drain')
    assert.equal(f.session.getBridgeStatus().state, 'processing', 'no auto-resume while native playback/cleanup is pending')
    assert.equal(f.session.getBridgeStatus().ttsStreaming, true)
    assert.equal(f.session.getBridgeStatus().readyForPrompt, false)
    assert.equal(f.session.getBridgeStatus().cooldownRemainingMs, 0)
    for (const process of f.playCalls) assert.equal(process.kill.mock.callCount(), 0)
}
async function assertNormalAutoResume(t: TestContext, f: Fixture, restoreIndex = 1) {
    assert.deepEqual(f.volumes().map(value => value.volume), Array.from({ length: restoreIndex + 1 }, (_, index) => index % 2 === 0 ? 0 : 62))
    assert.equal(f.files.size, 0)
    assert.equal(f.session.getBridgeStatus().state, 'processing', 'restore ACK still gates completion')
    await f.ack(restoreIndex)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    assert.equal(f.session.getBridgeStatus().ttsStreaming, false)
    assert.equal(f.session.getBridgeStatus().cooldownRemainingMs, 300)
    t.mock.timers.tick(299)
    await flush()
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    t.mock.timers.tick(1)
    await flush()
    assert.equal(f.session.getBridgeStatus().state, 'listening', 'auto-resume really occurs after cleanup, restore and cooldown')
    assert.equal(f.session.getBridgeStatus().readyForPrompt, true)
    for (const process of f.playCalls) assert.equal(process.kill.mock.callCount(), 0)
    f.quiet()
}

test('late target resolution after abort cannot issue another wpctl command, mute, Sano or local audio', async t => {
    const f = fixture(t)
    await f.start()
    const old = f.execCalls[0]
    f.abort()
    assert.equal(old.process.kill.mock.callCount(), 1)
    await f.start('New greeting')
    const current = f.capture.activeTtsPlayback
    old.callback(null, status, 'private stale diagnostics')
    old.process.child.emit('close', 0)
    await flush()
    assert.equal(f.execCalls.length, 2, 'old wpctl status must not lead to set-volume/set-mute')
    assert.deepEqual(f.volumes(), [])
    assert.equal(f.sano.mock.callCount(), 0)
    assert.equal(f.capture.activeTtsPlayback, current)
    await f.resolveTarget(1)
    await f.ack(0)
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    f.playCalls[0].child.emit('close', 0)
    await flush()
    await f.ack(1)
    f.quiet()
})

test('late mute ACK serializes old restore before new mute and cannot publish an old local target', async t => {
    const f = fixture(t)
    await f.start('Old greeting')
    await f.resolveTarget()
    const old = f.capture.activeTtsPlayback!
    assert.deepEqual(f.volumes().map(value => value.volume), [0])
    f.abort()
    await f.start('New greeting')
    await f.resolveTarget()
    const current = f.capture.activeTtsPlayback!
    assert.notEqual(current, old)
    assert.deepEqual(f.volumes().map(value => value.volume), [0], 'new mute waits for old ACK')
    await f.ack(0)
    assert.equal(old.localOutputTarget, undefined)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    await f.ack(1)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0])
    assert.equal(f.capture.localSpeakerOwner, current)
    assert.equal(current.controller.signal.aborted, false)
    assert.equal(f.session.getBridgeStatus().ttsStreaming, true)
    await f.ack(2)
    await f.ack(0, 'private duplicate old ACK')
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.capture.activeTtsPlayback, current)
    assert.equal(current.m5SpeakerMutedForLocalOutput, true)
    f.playCalls[0].child.emit('close', 0)
    await flush()
    await f.ack(3)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0, 62])
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    f.quiet()
})

test('in-flight speaker abort kills/reaps old process and old finally cannot unmute a newer speaker turn', async t => {
    const f = fixture(t)
    await f.start('Old greeting')
    await f.resolveTarget()
    await f.ack(0)
    const old = f.capture.activeTtsPlayback!
    const first = f.playCalls[0]
    f.abort()
    await flush()
    assert.equal(first.kill.mock.callCount(), 1)
    assert.deepEqual(first.kill.mock.calls[0].arguments, ['SIGKILL'])
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62], 'restore does not wait for pw-play close')
    await f.ack(1)
    await f.start('New greeting')
    await f.resolveTarget()
    await f.ack(2)
    const current = f.capture.activeTtsPlayback!
    assert.equal(f.playCalls.length, 2)
    first.child.emit('close', null, 'SIGKILL')
    first.child.emit('error', new Error('private late pw-play error'))
    await flush()
    await f.capture.finishTtsPlayback(old) // A duplicated stale finalizer is harmless too.
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0])
    assert.equal(f.capture.localSpeakerOwner, current)
    assert.equal(current.m5SpeakerMutedForLocalOutput, true)
    assert.equal(current.controller.signal.aborted, false)
    assert.equal(f.playCalls[1].kill.mock.callCount(), 0)
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    f.playCalls[1].child.emit('close', 0)
    await flush()
    await f.ack(3)
    f.quiet()
})

test('abort during old WAV setup restores M5 independently and cannot spawn/delete a newer playback', async t => {
    const f = fixture(t)
    const gate = deferred<void>()
    let oldFilename: string | undefined
    f.fileSetup.beforeWrite = async filename => {
        if (!oldFilename) { oldFilename = filename; await gate.promise }
    }
    await f.start('Old file setup')
    await f.resolveTarget()
    await f.ack(0)
    const old = f.capture.activeTtsPlayback!
    assert.equal(f.files.size, 1)
    assert.equal(f.playCalls.length, 0)
    f.abort()
    await flush()
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62], 'restore does not wait for fs.writeFile')
    await f.ack(1)
    await f.start('New local greeting')
    await f.resolveTarget()
    await f.ack(2)
    const current = f.capture.activeTtsPlayback!
    assert.equal(f.files.size, 2)
    assert.equal(f.playCalls.length, 1, 'only the new playback has spawned')
    gate.resolve()
    await flush()
    await f.capture.finishTtsPlayback(old)
    assert.equal(f.files.size, 1)
    assert.equal(f.files.has(oldFilename!), false, 'only the old generated directory was removed')
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.playCalls[0].kill.mock.callCount(), 0)
    assert.equal(f.capture.localSpeakerOwner, current)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0])
    f.playCalls[0].child.emit('close', 0)
    await flush()
    await f.ack(3)
    f.quiet()
})

test('close during async WAV write removes its file after settlement without late spawn/restore', async t => {
    const f = fixture(t)
    const gate = deferred<void>()
    f.fileSetup.beforeWrite = async () => { await gate.promise }
    await f.start()
    await f.resolveTarget()
    await f.ack(0)
    assert.equal(f.files.size, 1)
    f.session.close()
    await flush()
    assert.equal(f.playCalls.length, 0)
    assert.equal(f.files.size, 1, 'pending setup is not removed prematurely')
    gate.resolve()
    await flush()
    assert.equal(f.files.size, 0)
    assert.equal(f.playCalls.length, 0)
    assert.deepEqual(f.volumes().map(value => value.volume), [0], 'closed WS cannot receive restore')
    f.quiet()
})

test('abort with no replacement restores M5 even while old synthesis has not settled', async t => {
    const f = fixture(t)
    const pending = deferred<Buffer>()
    f.sano.mock.mockImplementation(async () => pending.promise)
    await f.start()
    await f.resolveTarget()
    await f.ack(0)
    assert.equal(f.sano.mock.callCount(), 1)
    assert.equal(f.playCalls.length, 0)
    f.abort()
    await flush()
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    await f.ack(1)
    assert.equal(f.capture.localSpeakerOwner, undefined)
    pending.resolve(Buffer.from('stale mock WAV'))
    await flush()
    assert.equal(f.playCalls.length, 0)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    f.quiet()
})

test('new M5 fallback waits for old mute and restore acknowledgments', async t => {
    const f = fixture(t)
    await f.start('Old local greeting')
    await f.resolveTarget()
    f.abort()
    await f.start('New M5 greeting')
    await f.resolveTarget(f.execCalls.length - 1, false)
    assert.equal(f.sano.mock.callCount(), 0)
    await f.ack(0)
    assert.equal(f.sano.mock.callCount(), 0)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    await f.ack(1)
    assert.equal(f.sano.mock.callCount(), 1)
    assert.equal(f.playCalls.length, 0)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    f.quiet()
})

test('nonempty avatar frames do not finish local speech or overlap ordered segments before native close and cleanup', async t => {
    const cleanup = [deferred<void>(), deferred<void>()]
    t.after(() => { for (const gate of cleanup) gate.resolve() })
    const f = fixture(t, { nonemptyFrames: true, bargeIn: true, reply: 'First mock sentence。Second mock sentence。' })
    f.fileSetup.beforeRemove = async directory => {
        const sample = f.files.get(`${directory}/speech.wav`)!.wav.readInt16LE(44)
        await cleanup[sample - 1].promise
    }
    f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    await f.start('Mock ordered reply')
    await f.resolveTarget()
    await f.ack(0)
    const playback = f.capture.activeTtsPlayback!
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.playCalls[0].child.closed, false)
    await sendAllAvatarFrames(t)
    const firstOrder = ['start:', 'sentence_start:0', 'frame:0111', 'frame:0122']
    assertLocalPending(f, playback, 1, firstOrder)
    assert.equal(f.sano.mock.callCount(), 2, 'next synthesis may prefetch, but native playback stays serialized')
    assert.deepEqual(f.sano.mock.calls.map(call => call.arguments[0]), ['First mock sentence。', 'Second mock sentence。'])
    assert.deepEqual(f.encode.mock.calls.map(call => call.arguments[1]), [0, 0], 'local speech needs no M5 preroll')
    assert.deepEqual(f.playedWavs, [mockWav(1)])
    f.session.handleMessage(wrapOpusPayload(Buffer.from([0x71]), 3))
    assert.equal(f.decodeFrame.mock.callCount(), 1, 'barge-in detector stays active after avatar frames drain')
    t.mock.timers.tick(1000) // Longer than the post-TTS cooldown, shorter than the native deadline.
    await flush()
    assertLocalPending(f, playback, 1, firstOrder)

    f.playCalls[0].child.emit('close', 0)
    await flush()
    assert.equal(f.files.size, 1, 'closed native helper still owns its WAV until cleanup settles')
    t.mock.timers.tick(1000)
    await flush()
    assertLocalPending(f, playback, 1, firstOrder)
    cleanup[0].resolve()
    await flush()
    assert.deepEqual(outputOrder(f), [...firstOrder, 'sentence_end:0', 'sentence_start:1', 'frame:0211'])
    assert.deepEqual(f.playedWavs, [mockWav(1), mockWav(2)], 'native WAV order matches sentence order')
    assert.equal(f.files.size, 1, 'first WAV is removed before the next helper starts')
    await sendAllAvatarFrames(t)
    const secondOrder = [...firstOrder, 'sentence_end:0', 'sentence_start:1', 'frame:0211', 'frame:0222']
    assertLocalPending(f, playback, 2, secondOrder)
    t.mock.timers.tick(1000)
    await flush()
    assertLocalPending(f, playback, 2, secondOrder)

    f.playCalls[1].child.emit('close', 0)
    await flush()
    assert.equal(f.files.size, 1)
    t.mock.timers.tick(1000)
    await flush()
    assertLocalPending(f, playback, 2, secondOrder)
    cleanup[1].resolve()
    await flush()
    assert.deepEqual(outputOrder(f), [...secondOrder, 'sentence_end:1', 'stop:'])
    assert.equal(playback.controller.signal.aborted, true, 'unused prefetch is reaped only after local completion')
    await assertNormalAutoResume(t, f)
    assert.equal(f.sano.mock.callCount(), 2)
})

test('native cached ACK omits M5 lead but still waits for native completion and restore', async t => {
    const f = fixture(t, { nonemptyFrames: true })
    const frames = [...Array.from({ length: 10 }, () => Buffer.from([0, 0])), ...mockFrames(7)]
    f.capture.fastAckFailed = false
    f.capture.fastAckEntries = [{ text: 'Mock cached ACK。', wav: mockWav(7), frames, localFrames: mockFrames(7) }]
    f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'realtime' }))
    f.session.handleMessage(wrapOpusPayload(Buffer.from([0x71]), 3))
    f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await flush(); await f.resolveTarget(); await f.ack(0)
    const playback = f.capture.activeTtsPlayback!
    await sendAllAvatarFrames(t)
    const order = ['start:', 'sentence_start:0', 'frame:0711', 'frame:0722']
    assertLocalPending(f, playback, 1, order)
    assert.equal(Date.now(), 120)
    f.playCalls[0].child.emit('close', 0)
    await flush()
    assert.deepEqual(outputOrder(f), [...order, 'sentence_end:0', 'stop:'])
    assert.deepEqual(f.volumes().map(v => v.volume), [0, 62])
    assert.deepEqual(f.playedWavs, [mockWav(7)])
    assert.equal(frames.length, 12, 'shared M5 cache is not shortened')
    assert.equal(f.sano.mock.callCount(), 0, 'LLM reply still waits for restore ACK')
    f.abort(); await f.ack(1)
})

for (const failure of ['missing target', 'unverified mute']) {
    test(`cached ACK retains full M5 lead after ${failure}`, async t => {
        const f = fixture(t, { nonemptyFrames: true })
        const frames = [...Array.from({ length: 10 }, () => Buffer.from([0, 0])), ...mockFrames(7)]
        f.capture.fastAckFailed = false
        f.capture.fastAckEntries = [{ text: 'Mock cached ACK。', wav: mockWav(7), frames, localFrames: mockFrames(7) }]
        f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'realtime' }))
        f.session.handleMessage(wrapOpusPayload(Buffer.from([0x71]), 3))
        f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
        await flush(); await f.resolveTarget(0, failure !== 'missing target')
        if (failure === 'unverified mute') { await f.ackResult(0, true); await f.ack(1) }
        await sendAllAvatarFrames(t)
        assert.deepEqual(outputOrder(f), ['start:', 'sentence_start:0', 'frame:0000', 'frame:0000', 'frame:0000'])
        assert.equal(f.playCalls.length, 0)
        assert.equal(f.sano.mock.callCount(), 0)
        assert.equal(frames.length, 12)
        f.abort(); await flush()
    })
}

test('warm native ACK cache encodes both lead policies from the same WAV without extra synthesis', async t => {
    const f = fixture(t, { nonemptyFrames: true })
    f.capture.fastAckFailed = false
    await f.capture.warmFastAck()
    const entries = f.capture.fastAckEntries!
    assert.ok(entries.length > 0)
    assert.equal(f.sano.mock.callCount(), entries.length)
    assert.equal(f.encode.mock.callCount(), entries.length * 2)
    for (let index = 0; index < entries.length; index++) {
        const calls = f.encode.mock.calls.slice(index * 2, index * 2 + 2)
        assert.deepEqual(calls.map(c => c.arguments[1]), [600, 0])
        assert.equal(calls[0].arguments[0], calls[1].arguments[0])
        assert.equal(entries[index].wav, calls[0].arguments[0])
        assert.ok(entries[index].localFrames)
    }
    assert.equal(f.playCalls.length, 0)
    assert.equal(f.execCalls.length, 0)
})

test('abort during native cache encoding cannot publish a partial ACK cache', async t => {
    const f = fixture(t, { nonemptyFrames: true })
    f.capture.fastAckFailed = false
    f.encode.mock.mockImplementation((_wav, lead = 0) => {
        if (lead === 0) f.capture.fastAckWarmup!.abort()
        return mockFrames(7)
    })
    await f.capture.warmFastAck()
    assert.equal(f.capture.fastAckEntries, undefined)
    assert.equal(f.capture.fastAckWarmup, undefined)
    assert.equal(f.capture.fastAckFailed, false)
    assert.equal(f.sano.mock.callCount(), 1)
    assert.equal(f.playCalls.length, 0)
})

test('cached fast ACK with nonempty frames waits for native close and cleanup before stop, restore or reply playback', async t => {
    const cleanup = deferred<void>()
    t.after(() => cleanup.resolve())
    const f = fixture(t, { nonemptyFrames: true, bargeIn: true, reply: 'Mock reply after ACK。' })
    f.fileSetup.beforeRemove = async directory => {
        if (f.files.get(`${directory}/speech.wav`)!.wav.readInt16LE(44) === 7) await cleanup.promise
    }
    f.capture.fastAckFailed = false
    f.capture.fastAckEntries = [{ text: 'Mock cached ACK。', wav: mockWav(7), frames: mockFrames(7) }]
    f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'start', mode: 'realtime' }))
    f.session.handleMessage(wrapOpusPayload(Buffer.from([0x71]), 3))
    f.session.handleMessage(JSON.stringify({ type: 'listen', state: 'stop' }))
    await flush()
    await f.resolveTarget()
    await f.ack(0)
    const cachedPlayback = f.capture.activeTtsPlayback!
    await sendAllAvatarFrames(t)
    const ackOrder = ['start:', 'sentence_start:0', 'frame:0711', 'frame:0722']
    assertLocalPending(f, cachedPlayback, 1, ackOrder)
    assert.equal(f.sano.mock.callCount(), 0, 'cached ACK never synthesizes again')
    assert.equal(f.encode.mock.callCount(), 0)
    f.session.handleMessage(wrapOpusPayload(Buffer.from([0x72]), 3))
    assert.equal(f.decodeFrame.mock.callCount(), 1, 'enabled barge-in still observes silence without cancelling ACK')
    t.mock.timers.tick(1000)
    await flush()
    assertLocalPending(f, cachedPlayback, 1, ackOrder)
    f.playCalls[0].child.emit('close', 0)
    await flush()
    assert.equal(f.files.size, 1)
    t.mock.timers.tick(1000)
    await flush()
    assertLocalPending(f, cachedPlayback, 1, ackOrder)
    assert.equal(f.sano.mock.callCount(), 0, 'reply cannot begin while cached helper cleanup is held')
    cleanup.resolve()
    await flush()
    assert.deepEqual(outputOrder(f), [...ackOrder, 'sentence_end:0', 'stop:'])
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    assert.equal(f.files.size, 0)
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.session.getBridgeStatus().state, 'processing')

    await f.ack(1)
    await f.resolveTarget(3)
    await f.ack(2)
    const replyPlayback = f.capture.activeTtsPlayback!
    assert.notEqual(replyPlayback, cachedPlayback)
    await sendAllAvatarFrames(t)
    const replyOrder = [...ackOrder, 'sentence_end:0', 'stop:', 'start:', 'sentence_start:0', 'frame:0111', 'frame:0122']
    t.mock.timers.tick(1000) // The completed ACK's cooldown must not resume listening over the reply.
    await flush()
    assertLocalPending(f, replyPlayback, 2, replyOrder, [0, 62, 0])
    assert.deepEqual(f.playedWavs, [mockWav(7), mockWav(1)], 'cached ACK completes before the reply native helper')
    f.playCalls[1].child.emit('close', 0)
    await flush()
    assert.deepEqual(outputOrder(f), [...replyOrder, 'sentence_end:0', 'stop:'])
    await assertNormalAutoResume(t, f, 3)
    assert.equal(f.sano.mock.callCount(), 1)
})

test('normal local completion aborts no closed speaker process and performs no error/fallback', async t => {
    const f = fixture(t)
    await f.start()
    await f.resolveTarget()
    await f.ack(0)
    const playback = f.capture.activeTtsPlayback!
    const process = f.playCalls[0]
    process.child.emit('close', 0)
    await flush()
    assert.equal(playback.controller.signal.aborted, true, 'normal finish still reaps unused prefetch')
    await f.ack(1)
    t.mock.timers.tick(120_000)
    await flush()
    assert.equal(process.kill.mock.callCount(), 0)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    f.quiet()
})

test('real pw-play failure restores M5 once using static diagnostics and no extra Sano/Hermes speech', async t => {
    const f = fixture(t)
    await f.start()
    await f.resolveTarget()
    await f.ack(0)
    f.playCalls[0].child.stderr.emit('data', Buffer.from('private audio engine diagnostic'))
    f.playCalls[0].child.emit('close', 9)
    await flush()
    await f.ack(1)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    assert.equal(f.sano.mock.callCount(), 1)
    assert.equal(f.errors.mock.callCount(), 0)
    assert.equal(f.warnings.mock.callCount(), 1)
    assert.equal(String(f.warnings.mock.calls[0].arguments[0]).includes('private'), false)
    assert.equal(f.json().some(value => value['type'] === 'alert'), false)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
})

test('failed/late mute ACK still queues restoration and does not poison the next local turn', async t => {
    const f = fixture(t)
    await f.start('Old greeting')
    await f.resolveTarget()
    f.abort()
    await f.start('New greeting')
    await f.resolveTarget()
    await f.ack(0, 'private mute failure')
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
    await f.ack(1)
    await f.ack(2)
    assert.equal(f.playCalls.length, 1)
    assert.equal(f.session.getBridgeStatus().state, 'processing')
    f.playCalls[0].child.emit('close', 0)
    await flush()
    await f.ack(3)
    f.quiet()
})

test('close terminates local playback with no late restoration/output or raw errors', async t => {
    const f = fixture(t)
    await f.start()
    await f.resolveTarget()
    await f.ack(0)
    const process = f.playCalls[0]
    const sentBeforeClose = f.sent.length
    f.session.close()
    assert.equal(process.kill.mock.callCount(), 1)
    process.child.emit('close', null)
    process.child.emit('error', new Error('private late close failure'))
    await flush()
    assert.equal(f.sent.length, sentBeforeClose)
    assert.equal(f.capture.localSpeakerOwner, undefined)
    f.quiet()
})

test('close while mute ACK is pending drains ownership without a late restore or native launch', async t => {
    const f = fixture(t)
    await f.start()
    await f.resolveTarget()
    const playback = f.capture.activeTtsPlayback!
    const sent = f.sent.length
    f.session.close()
    await f.ack(0, 'private late mute failure')
    assert.equal(f.sent.length, sent)
    assert.equal(f.capture.localSpeakerOwner, undefined)
    assert.equal(playback.m5SpeakerMutedForLocalOutput, false)
    assert.equal(f.sano.mock.callCount(), 0)
    assert.equal(f.playCalls.length, 0)
    f.quiet()
})

const unverifiedMuteAcks: Array<{ name: string; result: unknown }> = [
    { name: 'nonzero firmware mute volume', result: { content: [{ type: 'text', text: '{"speaker_volume":10,"permanent":false}' }], isError: false } },
    { name: 'missing mute result', result: undefined },
    { name: 'generic boolean success', result: true },
    { name: 'malformed mute content', result: { content: [{ type: 'text', text: 'private malformed ACK' }], isError: false } },
    { name: 'error-marked zero volume', result: { content: [{ type: 'text', text: '{"speaker_volume":0}' }], isError: true } },
]
for (const { name, result } of unverifiedMuteAcks) {
    test(`${name} cannot enable native output and restores before nonempty M5 fallback`, async t => {
        const f = fixture(t, { nonemptyFrames: true })
        await f.start()
        await f.resolveTarget()
        const playback = f.capture.activeTtsPlayback!
        await f.ackResult(0, result)
        assert.equal(playback.localOutputTarget, undefined)
        assert.equal(f.playCalls.length, 0)
        assert.equal(f.files.size, 0)
        assert.equal(f.sano.mock.callCount(), 0, 'fallback waits for restore ACK')
        assert.deepEqual(outputOrder(f), ['start:', 'sentence_start:0'])
        assert.deepEqual(f.volumes().map(value => value.volume), [0, 62], 'one restore, no mute retry')
        await f.ack(1)
        await sendAllAvatarFrames(t)
        assert.deepEqual(outputOrder(f), ['start:', 'sentence_start:0', 'frame:0111', 'frame:0122', 'sentence_end:0', 'stop:'])
        assert.equal(f.playCalls.length, 0)
        assert.equal(f.capture.localSpeakerOwner, undefined)
        assert.equal(f.session.getBridgeStatus().state, 'idle')
        assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
        assert.equal(f.warnings.mock.callCount(), 1)
        assert.equal(f.errors.mock.callCount(), 0)
        assert.equal(f.hermesTts.mock.callCount(), 0)
        assert.equal(f.json().some(value => value['type'] === 'alert'), false)
        assert.equal([...f.logs.mock.calls, ...f.warnings.mock.calls].some(call => call.arguments.some(value => String(value).includes('private'))), false)
    })
}

for (const { name, result } of [
    { name: 'wrong restore volume', result: { speaker_volume: 10 } },
    { name: 'malformed restore content', result: { content: [{ type: 'text', text: 'private malformed restore ACK' }], isError: false } },
]) {
    test(`${name} warns without false success or blind retry`, async t => {
        const f = fixture(t)
        await f.start()
        await f.resolveTarget()
        await f.ack(0)
        f.playCalls[0].child.emit('close', 0)
        await flush()
        await f.ackResult(1, result)
        assert.equal(f.logs.mock.calls.some(call => call.arguments.some(value => String(value).includes('M5 speaker restored'))), false)
        assert.equal(f.warnings.mock.callCount(), 1)
        assert.equal(f.warnings.mock.calls[0].arguments[0].includes('failed to restore M5 speaker'), true)
        assert.equal(f.capture.localSpeakerOwner, undefined)
        assert.equal(f.session.getBridgeStatus().state, 'idle')
        assert.deepEqual(f.volumes().map(value => value.volume), [0, 62])
        assert.equal([...f.logs.mock.calls, ...f.warnings.mock.calls].some(call => call.arguments.some(value => String(value).includes('private'))), false)
        await f.start('Next verified local greeting')
        await f.resolveTarget()
        await f.ack(2)
        assert.equal(f.playCalls.length, 2, 'the ownership queue remains reusable')
        f.playCalls[1].child.emit('close', 0)
        await flush()
        await f.ack(3)
        assert.equal(f.logs.mock.calls.filter(call => call.arguments.some(value => String(value).includes('M5 speaker restored volume=62'))).length, 1)
        assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0, 62])
        assert.equal(f.warnings.mock.callCount(), 1)
    })
}

test('active mute failure restores M5 before fallback and leaves the volume queue reusable', async t => {
    const f = fixture(t)
    await f.start()
    await f.resolveTarget()
    await f.ack(0, 'private mute failure')
    assert.equal(f.sano.mock.callCount(), 0)
    await f.ack(1)
    assert.equal(f.sano.mock.callCount(), 1)
    assert.equal(f.playCalls.length, 0)
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    await f.start('Next local greeting')
    await f.resolveTarget()
    await f.ack(2)
    f.playCalls[0].child.emit('close', 0)
    await flush()
    await f.ack(3)
    assert.deepEqual(f.volumes().map(value => value.volume), [0, 62, 0, 62])
    assert.equal(f.warnings.mock.callCount(), 1)
    assert.equal(String(f.warnings.mock.calls[0].arguments[0]).includes('private'), false)
    assert.equal(f.errors.mock.callCount(), 0)
    assert.equal(f.json().some(value => value['type'] === 'alert'), false)
})
