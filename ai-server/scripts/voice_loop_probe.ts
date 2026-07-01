import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import path from 'path'
import { synthesizeWithHermes } from '../src/hermes_audio.ts'

type RunResult = {
    stdout: string
    stderr: string
}

type WavInfo = {
    sampleRate: number
    channels: number
    bitsPerSample: number
    dataOffset: number
    dataBytes: number
    durationMs: number
}

type ProbeResult = {
    index: number
    prompt: string
    promptDurationMs: number
    playbackElapsedMs: number
    responseStartMsFromRecordingStart: number | null
    responseLatencyMsFromPlaybackEnd: number | null
    internalTranscript: string | null
    internalSttElapsedMs: number | null
    internalFirstTtsSynthesizeElapsedMs: number | null
    internalProcessElapsedMs: number | null
    internalLogError?: string
    transcript: string
    recordingPath: string
    responsePath: string
}

type PipeWireTarget = {
    id: string
    name: string
    selector: string
    requestedName: string
    volume: number | null
}

const DEFAULT_PROMPTS = [
    'こんにちは。短く返事して。',
    '今日の調子はどう？一言で答えて。',
    '十秒後にリマインダーを設定して。',
]

loadDotEnvFile(path.resolve(process.cwd(), '.env'))

const RUN_ROOT = path.resolve(process.cwd(), 'probe-runs')
const PLAY_TARGET = process.env.STACKCHAN_PROBE_PLAY_TARGET ?? ''
const PLAY_TARGET_NAME = process.env.STACKCHAN_PROBE_PLAY_TARGET_NAME ?? 'JBL Flip 3'
const PLAY_VOLUME = readEnvFloat('STACKCHAN_PROBE_PLAY_VOLUME', 0.35, 0, 1.2)
const BLUETOOTH_RECONNECT = readEnvBool('STACKCHAN_PROBE_BLUETOOTH_RECONNECT', true)
const BLUETOOTH_DEVICE = process.env.STACKCHAN_PROBE_BLUETOOTH_DEVICE ?? ''
const BLUETOOTH_DEVICE_NAME = process.env.STACKCHAN_PROBE_BLUETOOTH_DEVICE_NAME ?? PLAY_TARGET_NAME
const BLUETOOTH_CONNECT_TIMEOUT_MS = readEnvInt('STACKCHAN_PROBE_BLUETOOTH_CONNECT_TIMEOUT_MS', 12000, 1000, 60000)
const BLUETOOTH_SETTLE_MS = readEnvInt('STACKCHAN_PROBE_BLUETOOTH_SETTLE_MS', 4000, 500, 20000)
const RECORD_TARGET = process.env.STACKCHAN_PROBE_RECORD_TARGET ?? '57'
const RECORD_LEAD_MS = readEnvInt('STACKCHAN_PROBE_RECORD_LEAD_MS', 500, 0, 5000)
const RESPONSE_WINDOW_MS = readEnvInt('STACKCHAN_PROBE_RESPONSE_WINDOW_MS', 9000, 2000, 60000)
const RESPONSE_GUARD_MS = readEnvInt('STACKCHAN_PROBE_RESPONSE_GUARD_MS', 250, 0, 3000)
const SPEECH_RMS_THRESHOLD = readEnvFloat('STACKCHAN_PROBE_SPEECH_RMS_THRESHOLD', 0.018, 0.001, 0.2)
const SPEECH_MIN_MS = readEnvInt('STACKCHAN_PROBE_SPEECH_MIN_MS', 120, 20, 2000)
const PROMPT_LEAD_SILENCE_MS = readEnvInt('STACKCHAN_PROBE_PROMPT_LEAD_SILENCE_MS', 800, 0, 3000)
const PROMPT_WARMUP_TONE_MS = readEnvInt('STACKCHAN_PROBE_PROMPT_WARMUP_TONE_MS', 0, 0, 3000)
const PROMPT_WARMUP_TONE_VOLUME = readEnvFloat('STACKCHAN_PROBE_PROMPT_WARMUP_TONE_VOLUME', 0.02, 0.001, 0.2)
const AI_SERVER_SERVICE = process.env.STACKCHAN_PROBE_AI_SERVER_SERVICE ?? 'stackchan-ai-server.service'
const STT_URL = process.env.STACKCHAN_PROBE_STT_URL ?? 'http://127.0.0.1:52626/v1/audio/transcriptions'
const STT_API_KEY = process.env.STACKCHAN_PROBE_STT_API_KEY ?? process.env.WHISPER_API_KEY ?? ''

function loadDotEnvFile(filePath: string): void {
    if (!existsSync(filePath)) return
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (!match || process.env[match[1]] !== undefined) continue
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        process.env[match[1]] = value
    }
}

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
}

function readEnvFloat(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

function readEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined) return fallback
    return /^(1|true|yes|on)$/i.test(raw)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function run(command: string, args: string[], options: { cwd?: string, timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let timedOut = false
        const timeout = options.timeoutMs
            ? setTimeout(() => {
                timedOut = true
                child.kill('SIGTERM')
                setTimeout(() => child.kill('SIGKILL'), 1000).unref()
            }, options.timeoutMs)
            : undefined
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) => {
            if (timeout) clearTimeout(timeout)
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }
            if (timedOut) {
                reject(new Error(`${command} timed out after ${options.timeoutMs}ms: ${result.stderr || result.stdout}`))
                return
            }
            if (code === 0) resolve(result)
            else reject(new Error(`${command} exited with code ${code}: ${result.stderr || result.stdout}`))
        })
    })
}

function parseBluetoothDevice(devices: string, deviceName: string): string | null {
    const needle = deviceName.trim().toLowerCase()
    if (!needle) return null
    for (const line of devices.split(/\r?\n/)) {
        const match = line.match(/^Device\s+([0-9A-F:]{17})\s+(.+)$/i)
        if (match && match[2].trim().toLowerCase().includes(needle)) {
            return match[1]
        }
    }
    return null
}

function parseWpctlTarget(status: string, targetName: string): PipeWireTarget | null {
    const normalizedNeedle = targetName.trim().toLowerCase()
    if (!normalizedNeedle) return null

    let inSinks = false
    for (const line of status.split(/\r?\n/)) {
        if (/^\s*├─ Sinks:/.test(line)) {
            inSinks = true
            continue
        }
        if (inSinks && /^\s*├─ /.test(line)) {
            inSinks = false
        }
        if (!inSinks) continue

        const match = line.match(/^\D*(\d+)\.\s+(.+?)(?:\s+\[vol:|$)/)
        if (!match) continue

        const name = match[2].trim()
        if (name.toLowerCase().includes(normalizedNeedle)) {
            return {
                id: match[1],
                name,
                selector: match[1],
                requestedName: targetName,
                volume: null,
            }
        }
    }

    return null
}

async function getPipeWireVolume(selector: string): Promise<number | null> {
    try {
        const { stdout } = await run('wpctl', ['get-volume', selector])
        const match = stdout.match(/Volume:\s+([0-9.]+)/)
        if (!match) return null
        const value = Number(match[1])
        return Number.isFinite(value) ? value : null
    } catch {
        return null
    }
}

async function resolvePlayTarget(): Promise<PipeWireTarget> {
    if (PLAY_TARGET) {
        const volume = await getPipeWireVolume(PLAY_TARGET)
        return {
            id: PLAY_TARGET,
            name: PLAY_TARGET,
            selector: PLAY_TARGET,
            requestedName: PLAY_TARGET_NAME,
            volume,
        }
    }

    const target = parseWpctlTarget((await run('wpctl', ['status'])).stdout, PLAY_TARGET_NAME)
    if (!target && BLUETOOTH_RECONNECT) {
        await reconnectBluetoothPlaybackDevice().catch((error) => {
            console.warn(`[probe] Bluetooth reconnect failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }

    const targetAfterReconnect = target ?? parseWpctlTarget((await run('wpctl', ['status'])).stdout, PLAY_TARGET_NAME)
    if (!targetAfterReconnect) {
        const btHint = BLUETOOTH_RECONNECT
            ? ` Bluetooth reconnect was attempted for "${BLUETOOTH_DEVICE || BLUETOOTH_DEVICE_NAME}".`
            : ''
        throw new Error(`PipeWire playback target named "${PLAY_TARGET_NAME}" was not found.${btHint} Run "npm run probe:voice -- --devices" after connecting the JBL speaker.`)
    }
    targetAfterReconnect.volume = await getPipeWireVolume(targetAfterReconnect.selector)
    return targetAfterReconnect
}

async function reconnectBluetoothPlaybackDevice(): Promise<void> {
    const device = BLUETOOTH_DEVICE || parseBluetoothDevice((await run('bluetoothctl', ['devices'])).stdout, BLUETOOTH_DEVICE_NAME)
    if (!device) {
        throw new Error(`Bluetooth device named "${BLUETOOTH_DEVICE_NAME}" was not found`)
    }

    console.log(`[probe] playback target not found; attempting Bluetooth reconnect to ${device}`)
    await run('bluetoothctl', ['connect', device], { timeoutMs: BLUETOOTH_CONNECT_TIMEOUT_MS })
    await sleep(BLUETOOTH_SETTLE_MS)
}

async function setPlayTargetVolume(target: PipeWireTarget): Promise<PipeWireTarget> {
    await run('wpctl', ['set-volume', target.selector, PLAY_VOLUME.toFixed(2)])
    return {
        ...target,
        volume: await getPipeWireVolume(target.selector),
    }
}

function readWavInfo(wav: Buffer): WavInfo {
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Not a WAV file')
    }
    const fmtOffset = wav.indexOf(Buffer.from('fmt '))
    const dataMarker = wav.indexOf(Buffer.from('data'))
    if (fmtOffset < 0 || dataMarker < 0) throw new Error('WAV fmt/data chunk not found')
    const channels = wav.readUInt16LE(fmtOffset + 10)
    const sampleRate = wav.readUInt32LE(fmtOffset + 12)
    const bitsPerSample = wav.readUInt16LE(fmtOffset + 22)
    const dataBytes = wav.readUInt32LE(dataMarker + 4)
    const dataOffset = dataMarker + 8
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8)
    return {
        sampleRate,
        channels,
        bitsPerSample,
        dataOffset,
        dataBytes,
        durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
    }
}

async function wavDurationMs(filePath: string): Promise<number> {
    return readWavInfo(await readFile(filePath)).durationMs
}

function rmsForFrame(wav: Buffer, info: WavInfo, startByte: number, frameBytes: number): number {
    let samples = 0
    let sumSquares = 0
    const end = Math.min(startByte + frameBytes, info.dataOffset + info.dataBytes)
    const bytesPerSample = info.bitsPerSample / 8
    for (let offset = startByte; offset + bytesPerSample <= end; offset += bytesPerSample * info.channels) {
        const sample = info.bitsPerSample === 16
            ? wav.readInt16LE(offset)
            : (wav.readInt8(offset) << 8)
        sumSquares += sample * sample
        samples += 1
    }
    if (samples === 0) return 0
    return Math.sqrt(sumSquares / samples) / 32768
}

async function detectSpeechStartMs(filePath: string, afterMs: number): Promise<number | null> {
    const wav = await readFile(filePath)
    const info = readWavInfo(wav)
    const bytesPerSampleFrame = info.channels * (info.bitsPerSample / 8)
    const frameMs = 20
    const frameBytes = Math.max(bytesPerSampleFrame, Math.round(info.sampleRate * frameMs / 1000) * bytesPerSampleFrame)
    const minFrames = Math.max(1, Math.ceil(SPEECH_MIN_MS / frameMs))
    const startDataByte = info.dataOffset + Math.max(0, Math.round(info.sampleRate * afterMs / 1000) * bytesPerSampleFrame)
    let runFrames = 0
    let runStartMs = 0

    for (let offset = startDataByte; offset < info.dataOffset + info.dataBytes; offset += frameBytes) {
        const rms = rmsForFrame(wav, info, offset, frameBytes)
        const frameStartMs = Math.round(((offset - info.dataOffset) / bytesPerSampleFrame / info.sampleRate) * 1000)
        if (rms >= SPEECH_RMS_THRESHOLD) {
            if (runFrames === 0) runStartMs = frameStartMs
            runFrames += 1
            if (runFrames >= minFrames) return runStartMs
        } else {
            runFrames = 0
        }
    }
    return null
}

async function transcribeWav(filePath: string): Promise<string> {
    const wav = await readFile(filePath)
    const form = new FormData()
    form.append('model', process.env.STACKCHAN_PROBE_STT_MODEL ?? 'whisper-1')
    form.append('language', process.env.STACKCHAN_PROBE_STT_LANGUAGE ?? 'ja')
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), path.basename(filePath))

    const response = await fetch(STT_URL, {
        method: 'POST',
        headers: STT_API_KEY ? { authorization: `Bearer ${STT_API_KEY}` } : undefined,
        body: form,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`STT failed: HTTP ${response.status}: ${text}`)
    const parsed = JSON.parse(text) as Record<string, unknown>
    return String(parsed['text'] ?? parsed['transcript'] ?? parsed['result'] ?? text).trim()
}

type InternalTurnSummary = Pick<ProbeResult,
    'internalTranscript' |
    'internalSttElapsedMs' |
    'internalFirstTtsSynthesizeElapsedMs' |
    'internalProcessElapsedMs' |
    'internalLogError'
>

function lastRegexValue(text: string, pattern: RegExp): string | null {
    let value: string | null = null
    for (const match of text.matchAll(pattern)) value = match[1]
    return value
}

function lastRegexNumber(text: string, pattern: RegExp): number | null {
    const value = lastRegexValue(text, pattern)
    if (value === null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

async function readInternalTurnSummary(sinceEpochMs: number): Promise<InternalTurnSummary> {
    if (!AI_SERVER_SERVICE) {
        return {
            internalTranscript: null,
            internalSttElapsedMs: null,
            internalFirstTtsSynthesizeElapsedMs: null,
            internalProcessElapsedMs: null,
        }
    }

    try {
        const { stdout } = await run('journalctl', [
            '--user',
            '-u', AI_SERVER_SERVICE,
            '--since', `@${Math.floor(sinceEpochMs / 1000)}`,
            '--no-pager',
            '-o', 'cat',
        ])
        return {
            internalTranscript: lastRegexValue(stdout, /\] STT: "([^"]*)"/g),
            internalSttElapsedMs: lastRegexNumber(stdout, /\[timing\] done [^\n]*:stt elapsed=([0-9.]+)ms/g),
            internalFirstTtsSynthesizeElapsedMs: lastRegexNumber(stdout, /\[timing\] done [^\n]*:tts\.(?:stream\.)?(?:segment0|error\.segment0|followup\.segment0)\.synthesize elapsed=([0-9.]+)ms/g),
            internalProcessElapsedMs: lastRegexNumber(stdout, /\[timing\] done [^\n]*:process elapsed=([0-9.]+)ms/g),
        }
    } catch (error) {
        return {
            internalTranscript: null,
            internalSttElapsedMs: null,
            internalFirstTtsSynthesizeElapsedMs: null,
            internalProcessElapsedMs: null,
            internalLogError: error instanceof Error ? error.message : String(error),
        }
    }
}

async function recordWhilePlaying(promptPath: string, recordingPath: string, playTarget: PipeWireTarget): Promise<number> {
    const args = [
        ...(RECORD_TARGET ? ['--target', RECORD_TARGET] : []),
        '--rate', '16000',
        '--channels', '1',
        '--format', 's16',
        recordingPath,
    ]
    const recorder = spawn('pw-record', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const recorderErrors: Buffer[] = []
    recorder.stderr.on('data', (chunk: Buffer) => recorderErrors.push(chunk))
    await sleep(RECORD_LEAD_MS)

    const startedAt = Date.now()
    await run('pw-play', ['--target', playTarget.selector, promptPath])
    const playbackElapsedMs = Date.now() - startedAt
    await sleep(RESPONSE_WINDOW_MS)

    recorder.kill('SIGINT')
    const exitCode = await new Promise<number | null>((resolve) => {
        const timeout = setTimeout(() => {
            recorder.kill('SIGTERM')
        }, 2000)
        recorder.on('close', (code) => {
            clearTimeout(timeout)
            resolve(code)
        })
    })
    if (exitCode !== 0 && exitCode !== null) {
        const recordedBytes = await stat(recordingPath).then(info => info.size).catch(() => 0)
        if (recordedBytes > 44) return playbackElapsedMs
        const stderr = Buffer.concat(recorderErrors).toString('utf8')
        throw new Error(`pw-record failed with code ${exitCode}: ${stderr}`)
    }
    return playbackElapsedMs
}

async function trimResponse(recordingPath: string, responsePath: string, startMs: number): Promise<void> {
    await run('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-ss', (startMs / 1000).toFixed(3),
        '-i', recordingPath,
        '-t', (RESPONSE_WINDOW_MS / 1000).toFixed(3),
        '-ac', '1',
        '-ar', '16000',
        responsePath,
    ])
}

async function writePromptWav(prompt: string, promptPath: string): Promise<void> {
    const wav = await synthesizeWithHermes(prompt)
    if (PROMPT_LEAD_SILENCE_MS <= 0 && PROMPT_WARMUP_TONE_MS <= 0) {
        await writeFile(promptPath, wav)
        return
    }

    const rawPromptPath = promptPath.replace(/\.wav$/i, '.raw.wav')
    await writeFile(rawPromptPath, wav)
    if (PROMPT_WARMUP_TONE_MS > 0) {
        await run('ffmpeg', [
            '-y',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-t', (PROMPT_WARMUP_TONE_MS / 1000).toFixed(3),
            '-i', 'sine=frequency=180:sample_rate=24000',
            '-i', rawPromptPath,
            '-filter_complex',
            `[0:a]volume=${PROMPT_WARMUP_TONE_VOLUME},aresample=24000[a0];[1:a]aresample=24000[a1];[a0][a1]concat=n=2:v=0:a=1[out]`,
            '-map', '[out]',
            '-ac', '1',
            promptPath,
        ])
        return
    }

    await run('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-i', rawPromptPath,
        '-af', `adelay=${PROMPT_LEAD_SILENCE_MS}:all=1`,
        promptPath,
    ])
}

async function probeOne(prompt: string, index: number, runDir: string, playTarget: PipeWireTarget): Promise<ProbeResult> {
    const promptPath = path.join(runDir, `prompt-${index}.wav`)
    const recordingPath = path.join(runDir, `recording-${index}.wav`)
    const responsePath = path.join(runDir, `response-${index}.wav`)
    await writePromptWav(prompt, promptPath)
    const promptDurationMs = await wavDurationMs(promptPath)

    console.log(`[probe] ${index}: playing prompt through target=${playTarget.selector} (${playTarget.name}), recording target=${RECORD_TARGET}`)
    const internalLogSinceMs = Date.now()
    const playbackElapsedMs = await recordWhilePlaying(promptPath, recordingPath, playTarget)
    const promptEndMs = RECORD_LEAD_MS + playbackElapsedMs
    const detectAfterMs = promptEndMs + RESPONSE_GUARD_MS
    const responseStartMs = await detectSpeechStartMs(recordingPath, detectAfterMs)
    const trimStartMs = Math.max(promptEndMs, (responseStartMs ?? detectAfterMs) - 250)
    await trimResponse(recordingPath, responsePath, trimStartMs)
    const internal = await readInternalTurnSummary(internalLogSinceMs)
    const transcript = await transcribeWav(responsePath).catch((error) => `STT_ERROR: ${String(error)}`)

    return {
        index,
        prompt,
        promptDurationMs,
        playbackElapsedMs,
        responseStartMsFromRecordingStart: responseStartMs,
        responseLatencyMsFromPlaybackEnd: responseStartMs === null ? null : responseStartMs - promptEndMs,
        ...internal,
        transcript,
        recordingPath,
        responsePath,
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    if (args.includes('--help') || args.includes('-h')) {
        console.log([
            'Usage: npm run probe:voice -- [prompt ...]',
            '',
            'Environment:',
            '  STACKCHAN_PROBE_PLAY_TARGET       PipeWire sink id/name for playback; overrides name lookup',
            '  STACKCHAN_PROBE_PLAY_TARGET_NAME  PipeWire sink name substring, default "JBL Flip 3"',
            '  STACKCHAN_PROBE_PLAY_VOLUME       Playback volume set before probing, default 0.35',
            '  STACKCHAN_PROBE_RECORD_TARGET     PipeWire source id/name for USB camera mic, default 57',
            '  STACKCHAN_PROBE_RESPONSE_WINDOW_MS Recording window after prompt playback, default 9000',
            '  STACKCHAN_PROBE_SPEECH_RMS_THRESHOLD RMS threshold for acoustic response start, default 0.018',
            '  STACKCHAN_PROBE_PROMPT_LEAD_SILENCE_MS Silence prepended before JBL prompt playback, default 800',
            '  STACKCHAN_PROBE_PROMPT_WARMUP_TONE_MS Low-volume tone prepended before JBL prompt playback, default 0',
            '  STACKCHAN_PROBE_BLUETOOTH_RECONNECT Try bluetoothctl reconnect when JBL sink is missing, default true',
            '  STACKCHAN_PROBE_BLUETOOTH_DEVICE Optional Bluetooth MAC address for reconnect',
            '  STACKCHAN_PROBE_AI_SERVER_SERVICE User systemd unit for internal timing logs',
            '  STACKCHAN_PROBE_STT_URL           OpenAI-compatible transcription endpoint',
            '  STACKCHAN_PROBE_STT_API_KEY       Optional transcription endpoint API key',
            '',
            'Use --devices to print PipeWire devices without playing audio.',
        ].join('\n'))
        return
    }
    if (args.includes('--devices')) {
        const { stdout } = await run('wpctl', ['status'])
        console.log(stdout)
        return
    }

    const prompts = args.filter(arg => !arg.startsWith('--'))
    const selectedPrompts = prompts.length > 0 ? prompts : DEFAULT_PROMPTS
    const runDir = path.join(RUN_ROOT, new Date().toISOString().replace(/[:.]/g, '-'))
    await mkdir(runDir, { recursive: true })
    const playTarget = await setPlayTargetVolume(await resolvePlayTarget())

    console.log(`[probe] run directory: ${runDir}`)
    console.log(`[probe] playback target: ${playTarget.selector} (${playTarget.name}), volume=${playTarget.volume ?? 'unknown'}`)
    console.log(`[probe] prompts: ${selectedPrompts.length}`)
    const results: ProbeResult[] = []
    for (let i = 0; i < selectedPrompts.length; i++) {
        const result = await probeOne(selectedPrompts[i], i + 1, runDir, playTarget)
        results.push(result)
        console.log(`[probe] ${result.index}: latency=${result.responseLatencyMsFromPlaybackEnd ?? 'not-detected'}ms internalStt=${JSON.stringify(result.internalTranscript)} transcript=${JSON.stringify(result.transcript)}`)
    }

    const reportPath = path.join(runDir, 'report.json')
    await writeFile(reportPath, `${JSON.stringify({
        playTarget: playTarget.selector,
        playTargetName: playTarget.name,
        playTargetRequestedName: playTarget.requestedName,
        playTargetVolume: playTarget.volume,
        configuredPlayVolume: PLAY_VOLUME,
        recordTarget: RECORD_TARGET,
        promptLeadSilenceMs: PROMPT_LEAD_SILENCE_MS,
        promptWarmupToneMs: PROMPT_WARMUP_TONE_MS,
        promptWarmupToneVolume: PROMPT_WARMUP_TONE_VOLUME,
        aiServerService: AI_SERVER_SERVICE,
        responseWindowMs: RESPONSE_WINDOW_MS,
        speechRmsThreshold: SPEECH_RMS_THRESHOLD,
        results,
    }, null, 2)}\n`)
    console.log(`[probe] report: ${reportPath}`)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
