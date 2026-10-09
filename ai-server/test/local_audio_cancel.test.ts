import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import { EventEmitter, getEventListeners } from 'node:events'
import { playWavOnLocalTarget, resolveLocalTtsOutputTarget, readLocalTtsOutputConfig } from '../src/local_audio_output.ts'

class FakeChild extends EventEmitter {
    stdin = null // File playback must not create/write a stdin pipe.
    stderr = new EventEmitter()
    kill = (_signal: string) => true
}
function fakeChild(t: TestContext) {
    const child = new FakeChild()
    const kill = t.mock.method(child, 'kill')
    return { child, kill }
}
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(yes => { resolve = yes })
    return { promise, resolve }
}
async function flush() { for (let index = 0; index < 60; index++) await Promise.resolve() }
function wavBuffer(size = 46) {
    const wav = Buffer.alloc(size)
    wav.write('RIFF', 0); wav.writeUInt32LE(size - 8, 4); wav.write('WAVE', 8)
    if (size >= 46) {
        wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20)
        wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28)
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
        wav.write('data', 36); wav.writeUInt32LE(size - 44, 40)
    }
    return wav
}
const directory = '/tmp/mock-only/stackchan-local-tts-Ab12Cd'
const filename = `${directory}/speech.wav`
type SetupStage = 'mkdtemp' | 'directory mode' | 'write' | 'file mode'
function fixture(t: TestContext, target = '72') {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    t.mock.method(os, 'tmpdir', () => '/tmp/mock-only')
    const setup = { before: async (_stage: SetupStage) => undefined as void }
    const stages: SetupStage[] = []
    const writes: Array<{ wav: Buffer; options: Record<string, unknown> }> = []
    const mkdtemp = t.mock.method(fs, 'mkdtemp', async (prefix: unknown) => {
        assert.equal(prefix, '/tmp/mock-only/stackchan-local-tts-')
        stages.push('mkdtemp'); await setup.before('mkdtemp')
        return directory
    })
    const chmod = t.mock.method(fs, 'chmod', async (name: unknown, mode: unknown) => {
        const stage = name === directory ? 'directory mode' : 'file mode'
        assert.equal(name, stage === 'directory mode' ? directory : filename)
        assert.equal(mode, stage === 'directory mode' ? 0o700 : 0o600)
        stages.push(stage); await setup.before(stage)
    })
    const write = t.mock.method(fs, 'writeFile', async (name: unknown, data: unknown, options: Record<string, unknown>) => {
        assert.equal(name, filename)
        assert.ok(Buffer.isBuffer(data))
        assert.equal(options['mode'], 0o600)
        assert.equal(options['flag'], 'wx')
        writes.push({ wav: Buffer.from(data), options })
        stages.push('write'); await setup.before('write')
    })
    const rm = t.mock.method(fs, 'rm', async (name: unknown, options: unknown) => {
        assert.equal(name, directory)
        assert.deepEqual(options, { recursive: true, force: true })
    })
    const children: ReturnType<typeof fakeChild>[] = []
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown>; callback: (error: Error | null, stdout: string, stderr: string) => void; process: ReturnType<typeof fakeChild> }> = []
    const spawn = t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: Record<string, unknown>) => {
        assert.equal(command, 'pw-play')
        assert.deepEqual(args, ['--target', target, filename])
        assert.deepEqual(options, { stdio: ['ignore', 'ignore', 'pipe'] })
        const process = fakeChild(t)
        children.push(process)
        return process.child as unknown as ReturnType<typeof childProcess.spawn>
    })
    const exec = t.mock.method(childProcess, 'execFile', (command: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        assert.equal(command, 'wpctl')
        const process = fakeChild(t)
        calls.push({ command, args, options, callback, process })
        return process.child as unknown as ReturnType<typeof childProcess.execFile>
    })
    const http = t.mock.method(globalThis, 'fetch', async () => { throw new Error('HTTP forbidden') })
    t.after(() => assert.equal(http.mock.callCount(), 0))
    return { children, calls, spawn, exec, mkdtemp, chmod, write, rm, setup, stages, writes }
}
const config = readLocalTtsOutputConfig({ STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED: 'true', STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME: 'Mock speaker' })
const status = 'Audio\n ├─ Sinks:\n │ 72. Mock speaker [vol: 0.35]\n ├─ Sources:\n'

test('pw-play uses an unchanged private WAV file, no raw stdin, then removes resources', async t => {
    const f = fixture(t)
    const controller = new AbortController()
    const wav = wavBuffer()
    const original = Buffer.from(wav)
    const result = playWavOnLocalTarget('72', wav, { signal: controller.signal })
    wav.fill(0xff) // Async setup must not let the caller mutate the audio snapshot.
    await flush()
    const { child, kill } = f.children[0]
    assert.deepEqual(f.stages, ['mkdtemp', 'directory mode', 'write', 'file mode'])
    assert.equal(f.write.mock.callCount(), 1)
    assert.deepEqual(f.writes[0].wav, original)
    assert.deepEqual(f.writes[0].options, { flag: 'wx', mode: 0o600, signal: controller.signal })
    assert.equal(child.stdin, null)
    assert.equal(f.rm.mock.callCount(), 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    child.emit('close', 0)
    await result
    assert.equal(f.rm.mock.callCount(), 1)
    assert.equal(child.listenerCount('close'), 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    controller.abort('private abort reason')
    child.emit('error', new Error('late private process error'))
    child.stderr.emit('error', new Error('late private stderr error'))
    child.emit('close', 1)
    t.mock.timers.tick(120_000)
    assert.equal(kill.mock.callCount(), 0)
    assert.equal(f.spawn.mock.callCount(), 1)
    assert.equal(f.exec.mock.callCount(), 0)
    assert.equal(f.rm.mock.callCount(), 1)
})

test('pre-aborted file playback never creates files or spawns and hides signal.reason', async t => {
    const f = fixture(t)
    const controller = new AbortController()
    controller.abort(new Error('private signal reason'))
    await assert.rejects(playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal }), { message: 'local TTS output aborted' })
    assert.equal(f.mkdtemp.mock.callCount(), 0)
    assert.equal(f.rm.mock.callCount(), 0)
    assert.equal(f.spawn.mock.callCount(), 0)
})

for (const stage of ['mkdtemp', 'directory mode', 'write', 'file mode'] as const) {
    test(`abort during async ${stage} waits for setup settlement, removes only its directory, never spawns`, async t => {
        const f = fixture(t)
        const controller = new AbortController()
        const gate = deferred<void>()
        f.setup.before = async current => { if (current === stage) await gate.promise }
        const result = playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal })
        const rejection = assert.rejects(result, { message: 'local TTS output aborted' })
        await flush()
        assert.equal(f.stages.at(-1), stage)
        controller.abort('private reason')
        await flush()
        assert.equal(f.spawn.mock.callCount(), 0)
        assert.equal(f.rm.mock.callCount(), 0, 'never remove while async setup may still use/create the path')
        gate.resolve()
        await rejection
        assert.equal(f.stages.at(-1), stage, 'no later setup stage after abort')
        assert.equal(f.rm.mock.callCount(), 1)
        assert.equal(f.spawn.mock.callCount(), 0)
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    })
}

for (const stage of ['mkdtemp', 'directory mode', 'write', 'file mode'] as const) {
    test(`${stage} failure is sanitized and cleans up only a created directory`, async t => {
        const f = fixture(t)
        f.setup.before = async current => { if (current === stage) throw new Error('private filesystem path/detail') }
        await assert.rejects(playWavOnLocalTarget('72', wavBuffer()), { message: 'local TTS output file setup failed' })
        assert.equal(f.rm.mock.callCount(), stage === 'mkdtemp' ? 0 : 1)
        assert.equal(f.spawn.mock.callCount(), 0)
    })
}

for (const unsafe of ['/tmp/mock-only', '/tmp/stackchan-local-tts-Ab12Cd', '/tmp/mock-only/stackchan-local-tts-', '/tmp/mock-only/stackchan-local-tts-Ab12Cd/speech.wav', '/tmp/mock-only/../mock-only/stackchan-local-tts-Ab12Cd', 'stackchan-local-tts-Ab12Cd']) {
    test(`unexpected generated path ${JSON.stringify(unsafe)} never reaches write/chmod/delete/spawn`, async t => {
        const f = fixture(t)
        f.mkdtemp.mock.mockImplementation(async () => unsafe)
        await assert.rejects(playWavOnLocalTarget('72', wavBuffer()), { message: 'local TTS output cleanup failed' })
        assert.equal(f.chmod.mock.callCount(), 0)
        assert.equal(f.write.mock.callCount(), 0)
        assert.equal(f.rm.mock.callCount(), 0)
        assert.equal(f.spawn.mock.callCount(), 0)
    })
}

test('file playback abort SIGKILLs exactly once and reaps before directory removal/rejection', async t => {
    const f = fixture(t)
    const controller = new AbortController()
    const result = playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal })
    const rejection = assert.rejects(result, { message: 'local TTS output aborted' })
    let settled = false
    void result.catch(() => { settled = true })
    await flush()
    const { child, kill } = f.children[0]
    controller.abort()
    child.emit('error', new Error('private kill error'))
    t.mock.timers.tick(120_000)
    await flush()
    assert.equal(settled, false)
    assert.equal(f.rm.mock.callCount(), 0)
    assert.equal(kill.mock.callCount(), 1)
    assert.deepEqual(kill.mock.calls[0].arguments, ['SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    await rejection
    assert.equal(f.rm.mock.callCount(), 1)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(child.stderr.listenerCount('data'), 0)
})

test('abort during spawn kills/reaps before cleanup without any stdin operation', async t => {
    const f = fixture(t)
    const controller = new AbortController()
    const process = fakeChild(t)
    f.spawn.mock.mockImplementation(() => {
        controller.abort()
        return process.child as unknown as ReturnType<typeof childProcess.spawn>
    })
    const result = playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal })
    const rejection = assert.rejects(result, { message: 'local TTS output aborted' })
    await flush()
    assert.equal(process.kill.mock.callCount(), 1)
    assert.equal(process.child.stdin, null)
    assert.equal(f.rm.mock.callCount(), 0)
    process.child.emit('close', null)
    await rejection
    assert.equal(f.rm.mock.callCount(), 1)
})

for (const [requested, deadline] of [[12, 1000], [500_000, 120_000], [NaN, 60_000]] as const) {
    test(`pw-play bounds deadline ${requested} to ${deadline}ms and reaps before cleanup`, async t => {
        const f = fixture(t)
        const result = playWavOnLocalTarget('72', wavBuffer(), { timeoutMs: requested })
        const rejection = assert.rejects(result, { message: 'local TTS output timed out' })
        await flush()
        const { child, kill } = f.children[0]
        t.mock.timers.tick(deadline - 1)
        assert.equal(kill.mock.callCount(), 0)
        t.mock.timers.tick(1)
        assert.equal(kill.mock.callCount(), 1)
        assert.equal(f.rm.mock.callCount(), 0)
        child.emit('close', null, 'SIGKILL')
        await rejection
        assert.equal(f.rm.mock.callCount(), 1)
        t.mock.timers.tick(120_000)
        assert.equal(kill.mock.callCount(), 1)
    })
}

for (const target of ['', '-1', '--target=private', '72;private', '72\0private', ' 72', '00', '4294967295', '4294967296', 'private speaker']) {
    test(`invalid target ${JSON.stringify(target)} fails before filesystem/spawn`, async t => {
        const f = fixture(t)
        await assert.rejects(playWavOnLocalTarget(target, wavBuffer()), { message: 'invalid local TTS output target' })
        assert.equal(f.mkdtemp.mock.callCount(), 0)
        assert.equal(f.spawn.mock.callCount(), 0)
    })
}

test('file playback accepts the exact 8MiB bound and last valid numeric target without raw flags', async t => {
    const f = fixture(t, '4294967294')
    const wav = wavBuffer(8 * 1024 * 1024)
    const result = playWavOnLocalTarget('4294967294', wav)
    await flush()
    assert.deepEqual(f.writes[0].wav, wav)
    f.children[0].child.emit('close', 0)
    await result
})

test('file playback rejects empty/oversized/nonbuffer/malformed container before creation', async t => {
    const f = fixture(t)
    const wrongWave = wavBuffer(); wrongWave.write('NOPE', 8)
    const highBitRiff = wavBuffer(); highBitRiff[0] |= 0x80
    for (const wav of [Buffer.alloc(0), Buffer.alloc(11), Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from('not a WAV container'), wrongWave, highBitRiff, 'RIFF WAV' as unknown as Buffer]) {
        await assert.rejects(playWavOnLocalTarget('72', wav), { message: 'invalid local TTS audio' })
    }
    assert.equal(f.mkdtemp.mock.callCount(), 0)
    assert.equal(f.spawn.mock.callCount(), 0)
})

test('pw-play drains stderr without returning any private/unbounded diagnostics', async t => {
    const f = fixture(t)
    const result = playWavOnLocalTarget('72', wavBuffer())
    const rejection = assert.rejects(result, { message: 'local TTS output process failed' })
    await flush()
    const { child } = f.children[0]
    const privateChunk = Buffer.from('private stderr '.repeat(5000))
    for (let index = 0; index < 256; index++) child.stderr.emit('data', privateChunk)
    child.emit('close', 17)
    await rejection
    assert.equal(child.stderr.listenerCount('data'), 0)
    assert.equal(f.rm.mock.callCount(), 1)
})

for (const event of ['error', 'stderr', 'throw'] as const) {
    test(`pw-play ${event} failure stays static and cleans up after close`, async t => {
        const f = fixture(t)
        if (event === 'throw') f.spawn.mock.mockImplementation(() => { throw new Error('private spawn detail') })
        const result = playWavOnLocalTarget('72', wavBuffer())
        const rejection = assert.rejects(result, { message: 'local TTS output process failed' })
        await flush()
        if (event !== 'throw') {
            const { child, kill } = f.children[0]
            if (event === 'error') child.emit('error', new Error('private process detail'))
            else child.stderr.emit('error', new Error('private stream detail'))
            assert.equal(kill.mock.callCount(), 1)
            assert.equal(f.rm.mock.callCount(), 0)
            child.emit('close', null)
        }
        await rejection
        assert.equal(f.rm.mock.callCount(), 1)
    })
}

test('cleanup completion is awaited, and late abort/error events cannot revive/kill/re-delete', async t => {
    const f = fixture(t)
    const gate = deferred<void>()
    f.rm.mock.mockImplementation(async () => { await gate.promise })
    const controller = new AbortController()
    const result = playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal })
    let settled = false
    void result.then(() => { settled = true })
    await flush()
    const { child, kill } = f.children[0]
    child.emit('close', 0)
    await flush()
    assert.equal(f.rm.mock.callCount(), 1)
    assert.equal(settled, false)
    controller.abort('private reason')
    child.emit('error', new Error('late private error'))
    child.stderr.emit('error', new Error('late private stderr'))
    t.mock.timers.tick(120_000)
    assert.equal(kill.mock.callCount(), 0)
    gate.resolve()
    await result
    child.emit('close', 1)
    assert.equal(f.rm.mock.callCount(), 1)
})

for (const outcome of ['success', 'abort', 'spawn failure'] as const) {
    test(`cleanup error after ${outcome} is static and overrides prior outcome`, async t => {
        const f = fixture(t)
        const controller = new AbortController()
        f.rm.mock.mockImplementation(async () => { throw new Error('private filesystem path/audio detail') })
        if (outcome === 'spawn failure') f.spawn.mock.mockImplementation(() => { throw new Error('private spawn error') })
        const result = playWavOnLocalTarget('72', wavBuffer(), { signal: controller.signal })
        const rejection = assert.rejects(result, { message: 'local TTS output cleanup failed' })
        await flush()
        if (outcome !== 'spawn failure') {
            if (outcome === 'abort') controller.abort()
            f.children[0].child.emit('close', outcome === 'success' ? 0 : null)
        }
        await rejection
        assert.equal(f.rm.mock.callCount(), 1)
    })
}

test('target resolution is bounded and performs only ordered wpctl commands', async t => {
    const f = fixture(t)
    const result = resolveLocalTtsOutputTarget(config)
    for (const [index, stdout] of [status, '', ''].entries()) {
        const call = f.calls[index]
        assert.deepEqual(call.options, { encoding: 'utf8', maxBuffer: 64 * 1024, killSignal: 'SIGKILL' })
        call.callback(null, stdout, 'private stderr ignored')
        call.process.child.emit('close', 0)
        await flush()
    }
    assert.equal(await result, '72')
    assert.deepEqual(f.calls.map(call => call.args), [['status'], ['set-volume', '72', '0.35'], ['set-mute', '72', '0']])
    t.mock.timers.tick(120_000)
    for (const call of f.calls) assert.equal(call.process.kill.mock.callCount(), 0)
    assert.equal(f.spawn.mock.callCount(), 0)
    assert.equal(f.mkdtemp.mock.callCount(), 0)
})

for (const stage of [0, 1, 2]) {
    test(`target resolution abort in stage ${stage} reaps and starts no later command`, async t => {
        const f = fixture(t)
        const controller = new AbortController()
        const result = resolveLocalTtsOutputTarget(config, { signal: controller.signal })
        const rejection = assert.rejects(result, { message: 'local TTS output aborted' })
        for (let index = 0; index < stage; index++) {
            f.calls[index].callback(null, index === 0 ? status : '', '')
            f.calls[index].process.child.emit('close', 0)
            await flush()
        }
        const call = f.calls[stage]
        controller.abort()
        assert.equal(call.process.kill.mock.callCount(), 1)
        call.callback(null, stage === 0 ? status : '', '')
        call.process.child.emit('close', null)
        await rejection
        assert.equal(f.calls.length, stage + 1)
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
        call.callback(new Error('late private callback'), '', 'late private stderr')
        call.process.child.emit('error', new Error('late private process event'))
    })
}

test('target resolution preabort, deadline and oversized stdout fail closed with static errors', async t => {
    const f = fixture(t)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(resolveLocalTtsOutputTarget(config, { signal: controller.signal }), { message: 'local TTS output aborted' })
    assert.equal(f.exec.mock.callCount(), 0)
    const timeout = resolveLocalTtsOutputTarget(config)
    const timedOut = assert.rejects(timeout, { message: 'local TTS output timed out' })
    t.mock.timers.tick(3000)
    assert.equal(f.calls[0].process.kill.mock.callCount(), 1)
    f.calls[0].process.child.emit('close', null)
    await timedOut
    const oversized = resolveLocalTtsOutputTarget(config)
    const rejected = assert.rejects(oversized, { message: 'local TTS output process failed' })
    f.calls[1].callback(null, 'private'.repeat(10_000), '')
    f.calls[1].process.child.emit('close', 0)
    await rejected
    assert.equal(f.calls.length, 2)
})
