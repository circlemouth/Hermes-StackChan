#!/usr/bin/env node
// Fixed public diagnostics only. No playback, environment-file loading, or text logs.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const FIXTURES = Object.freeze([
    Object.freeze({ id: 'ack', text: 'はい。' }),
    Object.freeze({ id: 'question', text: '今日は何をして遊んだの？' }),
    Object.freeze({ id: 'long', text: '今度は少し音量を上げました。スタックチャンから、JBLスピーカーで話しています。声の大きさと速さを確認してください。' }),
])
const rounded = value => Math.round(value * 100) / 100
function median(values) {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
}

// Lazy dependencies: importing for mocked tests never loads a runtime, creates a
// file, or runs the CLI. The actual production helper includes close/read/cleanup.
async function runPipelineBenchmark({ iterations = 3, synthesize, encode, now = () => performance.now(), signal } = {}) {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) {
        throw new Error('iterations must be an integer from 1 to 10')
    }
    signal?.throwIfAborted()
    synthesize ??= require('../dist/sanotts_audio.js').synthesizeWithSanoTts
    let frameDurationMs = 60 // The mocked encoder contract used by offline tests.
    if (!encode) {
        const audio = require('../dist/audio.js')
        encode = audio.encodeWavToOpusFrames
        frameDurationMs = audio.OUTPUT_FRAME_DURATION_MS
    }
    if (!Number.isInteger(frameDurationMs) || frameDurationMs <= 0 || frameDurationMs > 1000) throw new Error('invalid frame duration')
    const fixtures = []
    const elapsed = start => {
        const duration = now() - start
        if (!Number.isFinite(duration) || duration < 0) throw new Error('invalid monotonic clock')
        return duration
    }
    for (const fixture of FIXTURES) {
        const samples = []
        for (let iteration = 1; iteration <= iterations; iteration++) {
            signal?.throwIfAborted()
            const start = now()
            const wav = await synthesize(fixture.text, { signal })
            const synthesisMs = elapsed(start)
            signal?.throwIfAborted()
            if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > 8 * 1024 * 1024 ||
                wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
                throw new Error('invalid diagnostic WAV')
            }
            // Alternate order to reveal first-encoder/cache bias. Neither variant
            // plays sound; each is encoded from the exact same unmodified WAV.
            const variants = []
            for (const leadMs of iteration % 2 ? [0, 600] : [600, 0]) {
                signal?.throwIfAborted()
                const encodeStart = now()
                const frames = encode(wav, leadMs)
                const encodeMs = elapsed(encodeStart)
                signal?.throwIfAborted()
                if (!Array.isArray(frames) || frames.length === 0 || !frames.every(frame => Buffer.isBuffer(frame) && frame.length > 0)) {
                    throw new Error('invalid diagnostic Opus frames')
                }
                variants.push({ leadMs, frames: frames.length, scheduledFrameMs: frames.length * frameDurationMs, encodeMs: rounded(encodeMs) })
            }
            const native = variants.find(variant => variant.leadMs === 0)
            samples.push({ iteration, wavBytes: wav.length, synthesisMs: rounded(synthesisMs), variants,
                nativeComponentSumMs: rounded(synthesisMs + native.encodeMs),
                dualCacheComponentSumMs: rounded(synthesisMs + variants.reduce((total, variant) => total + variant.encodeMs, 0)) })
        }
        fixtures.push({ id: fixture.id, textBytes: Buffer.byteLength(fixture.text, 'utf8'), samples,
            summary: { firstSynthesisMs: samples[0].synthesisMs,
                repeatedSynthesisMedianMs: median(samples.slice(1).map(sample => sample.synthesisMs)),
                nativeEncodeMedianMs: median(samples.map(sample => sample.variants.find(variant => variant.leadMs === 0).encodeMs)),
                m5EncodeMedianMs: median(samples.map(sample => sample.variants.find(variant => variant.leadMs === 600).encodeMs)),
                nativeComponentSumMedianMs: median(samples.map(sample => sample.nativeComponentSumMs)) } })
    }
    signal?.throwIfAborted()
    return { schemaVersion: 1, iterations, frameDurationMs, fixtures,
        scope: 'offline Sano helper + synchronous Opus encoding; no STT/LLM/player; .env not loaded; OS caches not flushed',
        limits: ['Component sums are not end-to-end or first-audio latency.',
            'Scheduled frames are not physical speaker duration/drain.',
            'First process is not proven cold start; encoder order alternates.',
            'The fixed 600 ms comparison does not read/change service preroll.',
            'No microphone, device control, Hermes conversation or audio playback.'] }
}

function runLegacyBenchmark(commandArgument) {
    const runtimeRoot = process.env.SANOTTS_RUNTIME_DIR ?? path.resolve(__dirname, '..', '.sanotts')
    const command = commandArgument ?? process.env.SANOTTS_COMMAND ?? path.join(runtimeRoot, 'bin', 'sanotts-cli')
    const model = process.env.SANOTTS_MODEL_PATH ?? path.join(runtimeRoot, 'assets', 'saanotts-jp-v3-int8.bin')
    const dict = process.env.SANOTTS_DICT_PATH ?? path.join(runtimeRoot, 'assets', 'k1-dict-438750.bin')
    const tempRoot = path.resolve(os.tmpdir())
    const directory = mkdtempSync(path.join(tempRoot, 'sanotts-benchmark-'))
    const output = path.join(directory, 'diagnostic.wav')
    const times = []
    try {
        for (let run = 0; run < 8; run++) {
            const started = performance.now()
            const child = spawnSync(command, [
                '--model', model, '--dict', dict, '--output', output,
                '--text', '今日は良い天気ですね。',
            ], { stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL', shell: false })
            if (child.error || child.status !== 0) throw new Error('Sano diagnostic failed')
            const wav = readFileSync(output)
            if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid diagnostic WAV')
            const elapsedMs = performance.now() - started
            times.push(elapsedMs)
            console.log(JSON.stringify({ run: run + 1, elapsedMs: +elapsedMs.toFixed(2), wavBytes: wav.length, audioSeconds: +(wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24)).toFixed(3) }))
        }
        const repeated = times.slice(1).sort((a, b) => a - b)
        console.log(JSON.stringify({ firstProcessMs: +times[0].toFixed(2), repeatedProcessMedianMs: +repeated[3].toFixed(2), scope: 'one-shot process + fixed-text synthesis + WAV read; no STT/LLM/playback; OS caches not flushed' }))
    } finally {
        // Only remove our verified mkdtemp directory, never an environment-supplied path.
        if (path.dirname(directory) !== tempRoot || !path.basename(directory).startsWith('sanotts-benchmark-')) throw new Error('Unsafe diagnostic cleanup path')
        rmSync(directory, { recursive: true, force: true })
    }
}

async function main() {
    const args = process.argv.slice(2)
    if (args[0] !== '--pipeline') {
        if (args.length > 1 || args[0]?.startsWith('--')) throw new Error('invalid diagnostic arguments')
        return runLegacyBenchmark(args[0])
    }
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--iterations' && /^[1-9][0-9]*$/.test(args[2]))) {
        throw new Error('invalid diagnostic arguments')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = setTimeout(abort, 60000)
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    try {
        const result = await runPipelineBenchmark({ iterations: args.length === 3 ? Number(args[2]) : 3, signal: controller.signal })
        console.log(JSON.stringify(result)) // Publish only a complete, non-aborted report.
    } finally {
        clearTimeout(timer)
        process.removeListener('SIGINT', abort)
        process.removeListener('SIGTERM', abort)
    }
}

module.exports = { runPipelineBenchmark }
if (require.main === module) {
    main().catch(() => { console.error('Offline Sano diagnostic failed or aborted. Build ai-server and check the local runtime.'); process.exitCode = 1 })
}
