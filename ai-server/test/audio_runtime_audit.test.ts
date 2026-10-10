import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { encodeWavToOpusFrames, pcmToWav, wavToPcm } from '../src/audio.ts'
import { synthesizeWithHermes, transcribeWithHermes } from '../src/hermes_audio.ts'

function chunk(id: string, body: Buffer): Buffer {
    const header = Buffer.alloc(8)
    header.write(id)
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body, Buffer.alloc(body.length & 1)])
}
function fmt(format = 1, channels = 1, bits = 16): Buffer {
    const body = Buffer.alloc(16)
    body.writeUInt16LE(format, 0)
    body.writeUInt16LE(channels, 2)
    body.writeUInt32LE(24000, 4)
    body.writeUInt32LE(24000 * channels * bits / 8, 8)
    body.writeUInt16LE(channels * bits / 8, 12)
    body.writeUInt16LE(bits, 14)
    return body
}
function riff(...chunks: Buffer[]): Buffer {
    const body = Buffer.concat([Buffer.from('WAVE'), ...chunks])
    const header = Buffer.alloc(8)
    header.write('RIFF')
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body])
}
function samples(...values: number[]): Buffer {
    const pcm = Buffer.alloc(values.length * 2)
    values.forEach((value, i) => pcm.writeInt16LE(value, i * 2))
    return pcm
}

test('R16 walks padded RIFF chunks and honors declared data/RIFF bounds', () => {
    const pcm = samples(1000, -2000)
    const wav = riff(chunk('JUNK', Buffer.from('datax')), chunk('LIST', Buffer.from('embedded data text')),
        chunk('fmt ', fmt()), chunk('data', pcm), chunk('LIST', Buffer.from('not audio')))
    assert.deepEqual(wavToPcm(Buffer.concat([wav, Buffer.from('trailing ignored bytes')])).pcm, pcm)
    const extended = Buffer.concat([fmt(), Buffer.from([0, 0])])
    assert.deepEqual(wavToPcm(riff(chunk('data', pcm), chunk('fmt ', extended))).pcm, pcm)
    assert.deepEqual(wavToPcm(pcmToWav(pcm, 24000)), { pcm, sampleRate: 24000 })
})

test('R16 stereo downmix preserves duration before Opus encoding', () => {
    const stereo = Buffer.alloc(1440 * 4)
    for (let i = 0; i < 1440; i++) {
        stereo.writeInt16LE(6000, i * 4)
        stereo.writeInt16LE(-2000, i * 4 + 2)
    }
    const wav = riff(chunk('fmt ', fmt(1, 2)), chunk('data', stereo))
    const { pcm } = wavToPcm(wav)
    assert.equal(pcm.length, 1440 * 2)
    assert.equal(pcm.readInt16LE(0), 2000)
    assert.equal(encodeWavToOpusFrames(wav, 0).length, 1)
})

test('R16 converts supported integer, float and extensible samples to PCM16 mono', () => {
    assert.deepEqual(wavToPcm(riff(chunk('fmt ', fmt(1, 1, 8)), chunk('data', Buffer.from([0, 128, 255])))).pcm,
        samples(-32768, 0, 32512))
    const ints24 = Buffer.alloc(6)
    ints24.writeIntLE(-8388608, 0, 3); ints24.writeIntLE(4194304, 3, 3)
    assert.deepEqual(wavToPcm(riff(chunk('fmt ', fmt(1, 1, 24)), chunk('data', ints24))).pcm, samples(-32768, 16384))
    const ints32 = Buffer.alloc(8)
    ints32.writeInt32LE(-2147483648, 0); ints32.writeInt32LE(1073741824, 4)
    assert.deepEqual(wavToPcm(riff(chunk('fmt ', fmt(1, 1, 32)), chunk('data', ints32))).pcm, samples(-32768, 16384))
    for (const bits of [32, 64]) {
        const floats = Buffer.alloc(bits / 8 * 3)
        for (const [i, value] of [-1, 0.5, 1.2].entries()) {
            if (bits === 32) floats.writeFloatLE(value, i * 4)
            else floats.writeDoubleLE(value, i * 8)
        }
        assert.deepEqual(wavToPcm(riff(chunk('fmt ', fmt(3, 1, bits)), chunk('data', floats))).pcm, samples(-32768, 16384, 32767))
        if (bits === 32) floats.writeFloatLE(NaN, 0)
        else floats.writeDoubleLE(Infinity, 0)
        assert.throws(() => wavToPcm(riff(chunk('fmt ', fmt(3, 1, bits)), chunk('data', floats))), /non-finite/)
    }
    const extensible = Buffer.alloc(40)
    fmt(0xfffe).copy(extensible)
    extensible.writeUInt16LE(22, 16)
    extensible.writeUInt16LE(16, 18)
    extensible.writeUInt32LE(4, 20)
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(extensible, 24)
    assert.deepEqual(wavToPcm(riff(chunk('fmt ', extensible), chunk('data', samples(111)))).pcm, samples(111))
    extensible[39] ^= 1
    assert.throws(() => wavToPcm(riff(chunk('fmt ', extensible), chunk('data', samples(111)))), /extensible/)
})

test('R16 rejects truncated chunks, missing padding, invalid format/alignment and fake signatures', () => {
    const good = riff(chunk('fmt ', fmt()), chunk('data', samples(1, 2)))
    assert.throws(() => wavToPcm(Buffer.alloc(8)), /header/)
    assert.throws(() => wavToPcm(good.subarray(0, good.length - 1)), /Truncated/)
    const hugeData = Buffer.from(good)
    hugeData.writeUInt32LE(1000, 40)
    assert.throws(() => wavToPcm(hugeData), /Truncated/)
    const noPad = riff(chunk('fmt ', fmt()), chunk('data', Buffer.from([1])))
    const missingPad = Buffer.from(noPad.subarray(0, noPad.length - 1))
    missingPad.writeUInt32LE(missingPad.length - 8, 4)
    assert.throws(() => wavToPcm(missingPad), /padding/)
    assert.throws(() => wavToPcm(noPad), /alignment/)
    assert.throws(() => wavToPcm(riff(chunk('fmt ', fmt()), chunk('LIST', Buffer.from('data not a chunk')))), /data chunk/)
    const badRate = fmt(); badRate.writeUInt32LE(1, 8)
    assert.throws(() => wavToPcm(riff(chunk('fmt ', badRate), chunk('data', samples(1)))), /byte rate/)
    assert.throws(() => wavToPcm(riff(chunk('fmt ', fmt(7)), chunk('data', samples(1)))), /format/)
    assert.throws(() => wavToPcm(riff(chunk('fmt ', fmt()), chunk('fmt ', fmt()), chunk('data', samples(1)))), /Duplicate/)
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
}
async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert(address && typeof address === 'object')
    return `http://127.0.0.1:${address.port}`
}
async function close(server: Server): Promise<void> {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
}
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try { await fn() } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('R04 STT HTTP abort/deadline closes a stalled body and permits a succeeding retry', { timeout: 5000 }, async () => {
    let ready = deferred<void>()
    let closed = deferred<void>()
    let stall = true
    const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
            if (!stall) { response.end('{"text":"recovered"}'); return }
            response.writeHead(200, { 'content-type': 'application/json' })
            response.write('{"text":"')
            response.on('close', () => closed.resolve())
            ready.resolve()
        })
    })
    const url = await listen(server)
    try {
        await withEnv({ HERMES_CONNECT_MODE: 'stdio', HERMES_STT_URL: url }, async () => {
            const controller = new AbortController()
            const first = transcribeWithHermes(pcmToWav(samples(0), 16000), { signal: controller.signal })
            const rejected = assert.rejects(first, /aborted/)
            await ready.promise
            controller.abort()
            await rejected
            await closed.promise
            ready = deferred<void>(); closed = deferred<void>()
            const second = transcribeWithHermes(pcmToWav(samples(0), 16000), { deadline: Date.now() + 150 })
            const timedOut = assert.rejects(second, /timed out/)
            await ready.promise
            await timedOut
            await closed.promise
            stall = false
            assert.equal(await transcribeWithHermes(pcmToWav(samples(0), 16000)), 'recovered')
        })
    } finally { await close(server) }
})

test('R04 local HTTP TTS observes caller cancellation and already expired deadlines', { timeout: 5000 }, async () => {
    const ready = deferred<void>()
    const server = createServer((request, response) => {
        request.resume(); request.on('end', () => { response.writeHead(200); response.write('RIFF'); ready.resolve() })
    })
    const url = await listen(server)
    try {
        await withEnv({ HERMES_CONNECT_MODE: 'stdio', STACKCHAN_LOCAL_TTS_URL: url }, async () => {
            const controller = new AbortController()
            const rejected = assert.rejects(synthesizeWithHermes('hello', { signal: controller.signal }), /aborted/)
            await ready.promise; controller.abort(); await rejected
            await assert.rejects(synthesizeWithHermes('hello', { deadline: Date.now() - 1 }), /timed out/)
        })
    } finally { await close(server) }
})

// Test fake Python/ffmpeg executables exercise real spawn/error/close ordering.
const helperScript = `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const http = require('http');
const mode = process.env.AUDIO_AUDIT_MODE;
const output = process.argv[process.argv.length - 1];
const isFfmpeg = path.basename(process.argv[1]) === 'ffmpeg';
if (mode === 'convert' && !isFfmpeg) {
    const file = path.join(path.dirname(output), 'speech.mp3'); fs.writeFileSync(file, 'fake compressed audio');
    console.log(JSON.stringify({success:true,file_path:file})); process.exit(0);
}
if (mode === 'success') { console.log(JSON.stringify({success:true,transcript:'recovered'})); process.exit(0); }
const dir = path.dirname(output);
const info = JSON.stringify({pid:process.pid,dir,isFfmpeg});
const req = http.request(process.env.AUDIO_AUDIT_NOTIFY, {method:'POST'}, (res) => res.resume()); req.end(info);
if (mode !== 'ignore-term') process.on('SIGTERM', () => {
    setTimeout(() => { fs.writeFileSync(process.env.AUDIO_AUDIT_MARKER, String(fs.existsSync(dir))); process.exit(0); }, 80);
});
else process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`

async function helperFixture(fn: (root: string, ready: () => Promise<{ pid: number; dir: string; isFfmpeg: boolean }>) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'stackchan-audio-audit-'))
    let next = deferred<{ pid: number; dir: string; isFfmpeg: boolean }>()
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const item of request) chunks.push(Buffer.from(item))
        const current = next; next = deferred()
        current.resolve(JSON.parse(Buffer.concat(chunks).toString()))
        response.end('ok')
    })
    const url = await listen(server)
    try {
        for (const name of ['fake-python', 'ffmpeg']) {
            await writeFile(path.join(root, name), helperScript)
            await chmod(path.join(root, name), 0o700)
        }
        await withEnv({ HERMES_CONNECT_MODE: 'stdio', HERMES_STT_URL: undefined, STACKCHAN_STT_URL: undefined,
            STACKCHAN_LOCAL_TTS_URL: undefined, HERMES_ROOT: root, HERMES_PYTHON: path.join(root, 'fake-python'),
            AUDIO_AUDIT_NOTIFY: url, AUDIO_AUDIT_MARKER: path.join(root, 'marker'), PATH: `${root}${path.delimiter}${process.env.PATH}`,
        }, async () => fn(root, () => next.promise))
    } finally {
        await close(server)
        const resolved = await realpath(root)
        assert.equal(resolved, root)
        assert.equal(path.dirname(root), await realpath(tmpdir()))
        assert.ok(path.basename(root).startsWith('stackchan-audio-audit-'))
        await rm(root, { recursive: true, force: true })
    }
}

async function assertClean(info: { pid: number; dir: string }): Promise<void> {
    assert.throws(() => process.kill(info.pid, 0), /ESRCH/)
    await assert.rejects(access(info.dir), { code: 'ENOENT' })
}

test('R04 Python STT/TTS await process close before temp cleanup, then allow retry', { timeout: 5000 }, async () => {
    await helperFixture(async (root, ready) => {
        for (const operation of [
            (signal: AbortSignal) => transcribeWithHermes(pcmToWav(samples(0), 16000), { signal }),
            (signal: AbortSignal) => synthesizeWithHermes('hello', { signal }),
        ]) {
            await withEnv({ AUDIO_AUDIT_MODE: 'wait' }, async () => {
                const started = ready()
                const controller = new AbortController()
                const rejected = assert.rejects(operation(controller.signal), /aborted/)
                const info = await started
                controller.abort(); await rejected
                assert.equal(await readFile(path.join(root, 'marker'), 'utf8'), 'true', 'directory must exist until helper exits')
                await assertClean(info)
            })
        }
        await withEnv({ AUDIO_AUDIT_MODE: 'success' }, async () => {
            assert.equal(await transcribeWithHermes(pcmToWav(samples(0), 16000)), 'recovered')
        })
    })
})

test('R04 stopped Python receives SIGKILL after deadline and spawn failure cleans temp directory', { timeout: 5000 }, async () => {
    await helperFixture(async (root, ready) => {
        await withEnv({ AUDIO_AUDIT_MODE: 'ignore-term' }, async () => {
            const started = ready()
            const rejected = assert.rejects(transcribeWithHermes(pcmToWav(samples(0), 16000), { deadline: Date.now() + 500 }), /timed out/)
            const info = await started
            await rejected; await assertClean(info)
        })
        await withEnv({ HERMES_PYTHON: path.join(root, 'does-not-exist') }, async () => {
            await assert.rejects(transcribeWithHermes(pcmToWav(samples(0), 16000)), /could not start/)
        })
        const aborted = new AbortController(); aborted.abort()
        await assert.rejects(transcribeWithHermes(pcmToWav(samples(0), 16000), { signal: aborted.signal }), /aborted/)
    })
})

test('R04 conversion ffmpeg inherits synthesis cancellation and shared deadline', { timeout: 5000 }, async () => {
    await helperFixture(async (root, ready) => {
        await withEnv({ AUDIO_AUDIT_MODE: 'convert' }, async () => {
            const started = ready()
            const controller = new AbortController()
            const rejected = assert.rejects(synthesizeWithHermes('hello', { signal: controller.signal, deadline: Date.now() + 2000 }), /aborted/)
            const info = await started
            assert.equal(info.isFfmpeg, true)
            controller.abort(); await rejected
            assert.equal(await readFile(path.join(root, 'marker'), 'utf8'), 'true')
            await assertClean(info)
            const secondStarted = ready()
            const timedOut = assert.rejects(synthesizeWithHermes('hello', { deadline: Date.now() + 500 }), /timed out/)
            const secondInfo = await secondStarted
            await timedOut; await assertClean(secondInfo)
        })
    })
})
