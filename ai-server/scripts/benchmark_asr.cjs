#!/usr/bin/env node
// Fixed public synthetic fixture only: no dotenv, bridge imports, profiles or playback.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const ASR_URL = 'http://127.0.0.1:8792/v1/audio/transcriptions'
const MODEL = 'whisper-v3:turbo'
const FIXTURE = '今日は良い天気ですね。明日は公園で散歩をします。'
const FIXTURE_ID = 'public-ja-weather-walk-v1'
const DEADLINE_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_WAV_BYTES = 8 * 1024 * 1024
const runtimeRoot = path.resolve(__dirname, '..', '.sanotts')

class BenchmarkError extends Error {
    constructor(code) {
        super(code)
        this.diagnosticCode = code
    }
}
const fail = (code) => new BenchmarkError(code)

function normalizeText(text) {
    return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
}

function similarityPercent(text) {
    const expected = Array.from(normalizeText(FIXTURE))
    const actual = Array.from(normalizeText(text))
    let row = Array.from({ length: expected.length + 1 }, (_, i) => i)
    for (let i = 0; i < actual.length; i++) {
        const next = [i + 1]
        for (let j = 0; j < expected.length; j++) {
            next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (actual[i] === expected[j] ? 0 : 1)))
        }
        row = next
    }
    return 100 * (1 - row[expected.length] / Math.max(expected.length, actual.length, 1))
}

function readWavMetadata(wav) {
    // The pinned native CLI emits canonical PCM16 mono WAVs (44-byte header).
    if (wav.length < 44 || wav.length > MAX_WAV_BYTES
        || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 16) !== 'WAVEfmt '
        || wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(16) !== 16
        || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1
        || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16
        || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44
        || wav.readUInt32LE(40) === 0 || wav.readUInt32LE(40) % 2 !== 0
        || wav.readUInt32LE(24) === 0 || wav.readUInt32LE(28) !== wav.readUInt32LE(24) * 2) {
        throw fail('invalid_wav')
    }
    return { wavBytes: wav.length, audioSeconds: +(wav.readUInt32LE(40) / wav.readUInt32LE(28)).toFixed(3) }
}

function synthesize(output, signal) {
    return new Promise((resolve, reject) => {
        const command = path.join(runtimeRoot, 'bin', 'sanotts-cli')
        const args = [
            '--model', path.join(runtimeRoot, 'assets', 'saanotts-jp-v3-int8.bin'),
            '--dict', path.join(runtimeRoot, 'assets', 'k1-dict-438750.bin'),
            '--output', output, '--text', FIXTURE,
        ]
        const child = spawn(command, args, { shell: false, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } })
        let failure
        const stop = (code) => {
            failure ??= fail(code)
            child.kill('SIGKILL')
        }
        const onAbort = () => stop('interrupted')
        const timer = setTimeout(() => stop('synthesis_timeout'), 30_000)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        child.on('error', () => { failure ??= fail('native_runtime_unavailable') })
        // Reap the child before the caller removes its output directory.
        child.on('close', (code) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            if (failure || code !== 0) reject(failure ?? fail('synthesis_failed'))
            else resolve()
        })
    })
}

function requestTranscription(wav, signal) {
    return new Promise((resolve, reject) => {
        const boundary = `asr-benchmark-${randomBytes(12).toString('hex')}`
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${MODEL}\r\n`
                + `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`
                + `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
                + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
            wav, Buffer.from(`\r\n--${boundary}--\r\n`),
        ])
        let settled = false
        let response
        const finish = (error, text) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            if (error) {
                response?.destroy()
                request.destroy()
                reject(error)
            } else resolve(text)
        }
        const onAbort = () => finish(fail('interrupted'))
        // Plain node:http to a literal loopback URL: no proxy, redirects, auth or overrides.
        const request = http.request(ASR_URL, {
            method: 'POST', agent: false,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
        }, (res) => {
            response = res
            res.on('error', () => finish(fail('asr_transport_error')))
            res.on('aborted', () => finish(fail('asr_transport_error')))
            if (res.statusCode !== 200) { finish(fail('asr_http_error')); return }
            const length = res.headers['content-length']
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
                finish(fail('asr_response_too_large'))
                return
            }
            const chunks = []
            let bytes = 0
            res.on('data', (chunk) => {
                if (settled) return
                bytes += chunk.length
                if (bytes > MAX_RESPONSE_BYTES) { finish(fail('asr_response_too_large')); return }
                chunks.push(chunk)
            })
            res.on('end', () => {
                if (settled) return
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    if (typeof parsed?.text !== 'string') throw fail('asr_invalid_response')
                    finish(undefined, parsed.text)
                } catch { finish(fail('asr_invalid_response')) }
            })
        })
        const timer = setTimeout(() => finish(fail('asr_timeout')), DEADLINE_MS)
        request.on('error', () => finish(fail('asr_transport_error')))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        else request.end(body)
    })
}

async function main() {
    const controller = new AbortController()
    const interrupt = () => controller.abort()
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', interrupt)
    const tempRoot = fs.realpathSync(os.tmpdir())
    let directory
    let identity
    try {
        directory = fs.mkdtempSync(path.join(tempRoot, 'standalone-asr-benchmark-'))
        fs.chmodSync(directory, 0o700)
        identity = fs.lstatSync(directory)
        const output = path.join(directory, 'fixture.wav')
        fs.writeFileSync(output, '', { flag: 'wx', mode: 0o600 })
        const synthesisStarted = performance.now()
        await synthesize(output, controller.signal)
        const outputStat = fs.lstatSync(output)
        if (!outputStat.isFile() || outputStat.size > MAX_WAV_BYTES || (outputStat.mode & 0o777) !== 0o600) {
            throw fail('invalid_wav')
        }
        const wav = fs.readFileSync(output)
        const metadata = readWavMetadata(wav)
        const synthesisMs = +(performance.now() - synthesisStarted).toFixed(2)
        console.log(JSON.stringify({ fixtureId: FIXTURE_ID, synthesisMs, ...metadata }))
        const times = []
        const scores = []
        for (let run = 1; run <= 3; run++) {
            const started = performance.now()
            const text = await requestTranscription(wav, controller.signal)
            const elapsedMs = +(performance.now() - started).toFixed(2)
            const similarityScore = +similarityPercent(text).toFixed(2)
            times.push(elapsedMs)
            scores.push(similarityScore)
            console.log(JSON.stringify({ run, elapsedMs, similarityScore, ...metadata }))
        }
        console.log(JSON.stringify({
            fixtureId: FIXTURE_ID, firstCallMs: times[0], repeatedMeanMs: +((times[1] + times[2]) / 2).toFixed(2),
            minSimilarityScore: Math.min(...scores), calls: 3,
        }))
    } finally {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', interrupt)
        if (directory !== undefined) {
            // Verify the exact absolute mkdtemp target and its original identity before removal.
            const current = fs.lstatSync(directory)
            if (!identity || !path.isAbsolute(directory) || path.dirname(directory) !== tempRoot
                || !path.basename(directory).startsWith('standalone-asr-benchmark-')
                || !current.isDirectory() || current.isSymbolicLink() || fs.realpathSync(directory) !== directory
                || current.dev !== identity.dev || current.ino !== identity.ino) {
                throw fail('cleanup_refused')
            }
            fs.rmSync(directory, { recursive: true, force: false })
        }
    }
}

module.exports = { normalizeText, similarityPercent, readWavMetadata, requestTranscription }
if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ error: error instanceof BenchmarkError ? error.diagnosticCode : 'benchmark_failed' }))
        process.exitCode = 1
    })
}
