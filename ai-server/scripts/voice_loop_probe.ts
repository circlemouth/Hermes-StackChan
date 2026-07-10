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
    playTarget: string
    playTargetName: string
    playTargetVolume: number | null
    promptDurationMs: number
    playbackElapsedMs: number
    responseStartMsFromRecordingStart: number | null
    responseLatencyMsFromPlaybackEnd: number | null
    internalTranscript: string | null
    internalSttElapsedMs: number | null
    internalFirstTtsSynthesizeElapsedMs: number | null
    internalFirstTtsFrameSentElapsedMs: number | null
    internalFirstAudibleTtsFrameSentElapsedMs: number | null
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

type BridgeStatus = {
    connected?: boolean
    readyForPrompt?: boolean
    reason?: string
    state?: string
    ttsStreaming?: boolean
    cooldownRemainingMs?: number
    followupRunning?: boolean
    followupQueued?: number
}

type OptionalRunResult = RunResult & {
    ok: boolean
    error?: string
}

type AudioPreflightReport = {
    ok: boolean
    lines: string[]
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
const RECORD_TARGET = process.env.STACKCHAN_PROBE_RECORD_TARGET ?? ''
const RECORD_TARGET_NAME = process.env.STACKCHAN_PROBE_RECORD_TARGET_NAME ?? 'C505 HD Webcam'
const RECORD_LEAD_MS = readEnvInt('STACKCHAN_PROBE_RECORD_LEAD_MS', 500, 0, 5000)
const RESPONSE_WINDOW_MS = readEnvInt('STACKCHAN_PROBE_RESPONSE_WINDOW_MS', 9000, 2000, 60000)
const RESPONSE_GUARD_MS = readEnvInt('STACKCHAN_PROBE_RESPONSE_GUARD_MS', 700, 0, 3000)
const SPEECH_RMS_THRESHOLD = readEnvFloat('STACKCHAN_PROBE_SPEECH_RMS_THRESHOLD', 0.018, 0.001, 0.2)
const SPEECH_MIN_MS = readEnvInt('STACKCHAN_PROBE_SPEECH_MIN_MS', 120, 20, 2000)
const PRE_PROMPT_QUIET_MS = readEnvInt('STACKCHAN_PROBE_PRE_PROMPT_QUIET_MS', 1500, 0, 10000)
const PRE_PROMPT_QUIET_TIMEOUT_MS = readEnvInt('STACKCHAN_PROBE_PRE_PROMPT_QUIET_TIMEOUT_MS', 30000, 1000, 120000)
const PRE_PROMPT_QUIET_RMS_THRESHOLD = readEnvFloat('STACKCHAN_PROBE_PRE_PROMPT_QUIET_RMS_THRESHOLD', 0.06, 0.001, 0.2)
const PROMPT_LEAD_SILENCE_MS = readEnvInt('STACKCHAN_PROBE_PROMPT_LEAD_SILENCE_MS', 800, 0, 3000)
const PROMPT_WARMUP_TONE_MS = readEnvInt('STACKCHAN_PROBE_PROMPT_WARMUP_TONE_MS', 0, 0, 3000)
const PROMPT_WARMUP_TONE_VOLUME = readEnvFloat('STACKCHAN_PROBE_PROMPT_WARMUP_TONE_VOLUME', 0.02, 0.001, 0.2)
const AI_SERVER_SERVICE = process.env.STACKCHAN_PROBE_AI_SERVER_SERVICE ?? 'stackchan-ai-server.service'
const BRIDGE_STATUS_URL = process.env.STACKCHAN_PROBE_BRIDGE_STATUS_URL ??
    `http://127.0.0.1:${process.env.STACKCHAN_CONTROL_PORT ?? '8766'}/internal/status`
const WAIT_BRIDGE_READY = readEnvBool('STACKCHAN_PROBE_WAIT_BRIDGE_READY', true)
const BRIDGE_READY_TIMEOUT_MS = readEnvInt('STACKCHAN_PROBE_BRIDGE_READY_TIMEOUT_MS', 60000, 1000, 300000)
const BRIDGE_READY_POLL_MS = readEnvInt('STACKCHAN_PROBE_BRIDGE_READY_POLL_MS', 500, 100, 5000)
const STT_URL = process.env.STACKCHAN_PROBE_STT_URL ?? 'http://127.0.0.1:52626/v1/audio/transcriptions'
const STT_API_KEY = process.env.STACKCHAN_PROBE_STT_API_KEY ?? process.env.WHISPER_API_KEY ?? ''
const CURRENT_USER = process.env.USER || process.env.LOGNAME || 'hayato'

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

async function runOptional(command: string, args: string[], options: { cwd?: string, timeoutMs?: number } = {}): Promise<OptionalRunResult> {
    try {
        return { ok: true, ...(await run(command, args, options)) }
    } catch (error) {
        return {
            ok: false,
            stdout: '',
            stderr: '',
            error: error instanceof Error ? error.message : String(error),
        }
    }
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

function parseWpctlSectionEntries(status: string, sectionName: string): Array<{ id: string, name: string }> {
    const entries: Array<{ id: string, name: string }> = []
    let inAudio = false
    let inSection = false
    for (const line of status.split(/\r?\n/)) {
        if (/^Audio\s*$/.test(line)) {
            inAudio = true
            inSection = false
            continue
        }
        if (/^Video\s*$/.test(line) || /^Settings\s*$/.test(line)) {
            inAudio = false
            inSection = false
            continue
        }
        if (!inAudio) continue

        if (new RegExp(`^\\s*├─ ${sectionName}:`).test(line)) {
            inSection = true
            continue
        }
        if (inSection && /^\s*├─ /.test(line)) {
            inSection = false
        }
        if (!inSection) continue

        const match = line.match(/^\D*(\d+)\.\s+(.+?)(?:\s+\[|$)/)
        if (match) entries.push({ id: match[1], name: match[2].trim() })
    }
    return entries
}

function readProcFile(filePath: string): string {
    try {
        return readFileSync(filePath, 'utf8')
    } catch {
        return ''
    }
}

function summarizeAlsaCards(cards: string): string {
    const names = cards
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^\d+\s+\[/.test(line))
    if (names.length === 0) return 'none'
    return names.join(' | ')
}

async function readDevSndSummary(): Promise<string> {
    const listing = await runOptional('ls', ['-l', '/dev/snd'], { timeoutMs: 2000 })
    if (!listing.ok) return listing.error ?? 'unavailable'
    return listing.stdout.trim() || 'empty'
}

function devSndAclTargets(): string[] {
    const preferred = [
        '/dev/snd/controlC2',
        '/dev/snd/pcmC2D0c',
        '/dev/snd/controlC0',
    ]
    return preferred.filter(target => existsSync(target))
}

async function readDevSndAclSummary(): Promise<string> {
    const targets = devSndAclTargets()
    if (targets.length === 0) return 'no /dev/snd control/pcm targets exist'
    const acl = await runOptional('getfacl', ['-p', ...targets], { timeoutMs: 2000 })
    if (!acl.ok) return acl.error ?? 'getfacl unavailable'
    return acl.stdout
        .split(/\r?\n/)
        .filter(line => /^(# file:|user:|group:|mask:|other:)/.test(line))
        .join('\n')
}

async function readBluetoothInfo(): Promise<string> {
    const device = BLUETOOTH_DEVICE || parseBluetoothDevice((await runOptional('bluetoothctl', ['devices'], { timeoutMs: 3000 })).stdout, BLUETOOTH_DEVICE_NAME)
    if (!device) return `Bluetooth device "${BLUETOOTH_DEVICE_NAME}" not found`
    const info = await runOptional('bluetoothctl', ['info', device], { timeoutMs: 3000 })
    return info.ok ? info.stdout.trim() : (info.error ?? 'bluetoothctl info unavailable')
}

function bluetoothIsConnected(info: string): boolean {
    return /^(\s*)Connected:\s+yes\s*$/mi.test(info)
}

function commandSummary(result: OptionalRunResult): string {
    if (!result.ok) return `failed (${result.error})`
    const text = `${result.stdout}${result.stderr}`.trim()
    if (!text) return 'ok'
    return text.split(/\r?\n/).slice(0, 3).join(' ; ')
}

async function runAudioPreflight(): Promise<AudioPreflightReport> {
    const lines: string[] = []
    const failures: string[] = []

    const wpctl = await runOptional('wpctl', ['status'], { timeoutMs: 3000 })
    const wpctlStatus = wpctl.stdout
    const devices = wpctl.ok ? parseWpctlSectionEntries(wpctlStatus, 'Devices') : []
    const sinks = wpctl.ok ? parseWpctlSectionEntries(wpctlStatus, 'Sinks') : []
    const sources = wpctl.ok ? parseWpctlSectionEntries(wpctlStatus, 'Sources') : []
    const playTarget = wpctl.ok
        ? (PLAY_TARGET
            ? sinks.find(sink => sink.id === PLAY_TARGET || sink.name.toLowerCase().includes(PLAY_TARGET.toLowerCase())) ?? null
            : parseWpctlTarget(wpctlStatus, PLAY_TARGET_NAME))
        : null
    const recordTarget = wpctl.ok ? parseWpctlSectionTarget(wpctlStatus, 'Sources', RECORD_TARGET || RECORD_TARGET_NAME) : null
    const arecord = await runOptional('arecord', ['-l'], { timeoutMs: 3000 })
    const aplay = await runOptional('aplay', ['-l'], { timeoutMs: 3000 })
    const user = await runOptional('id', [], { timeoutMs: 2000 })
    const userLine = user.stdout.trim()
    const bluetoothInfo = await readBluetoothInfo()
    const sndAclSummary = await readDevSndAclSummary()

    lines.push('Audio preflight')
    lines.push(`- Bridge: ${bridgeWaitSummary(await readBridgeStatus().catch(() => ({ connected: false, readyForPrompt: false, reason: 'status_unavailable' })))}`)
    lines.push(`- PipeWire command: ${wpctl.ok ? 'ok' : `failed (${wpctl.error})`}`)
    lines.push(`- PipeWire audio devices: ${devices.length}`)
    lines.push(`- PipeWire sinks: ${sinks.length ? sinks.map(s => `${s.id}:${s.name}`).join(' | ') : 'none'}`)
    lines.push(`- PipeWire sources: ${sources.length ? sources.map(s => `${s.id}:${s.name}`).join(' | ') : 'none'}`)
    lines.push(`- Requested playback target: ${JSON.stringify(PLAY_TARGET || PLAY_TARGET_NAME)} -> ${playTarget ? `${playTarget.id}:${playTarget.name}` : 'not found'}`)
    lines.push(`- Requested recording target: ${RECORD_TARGET || RECORD_TARGET_NAME || '(default)'} -> ${recordTarget ? `${recordTarget.id}:${recordTarget.name}` : 'not found'}`)

    const alsaCards = readProcFile('/proc/asound/cards')
    const alsaDevices = readProcFile('/proc/asound/devices')
    lines.push(`- ALSA cards in kernel: ${summarizeAlsaCards(alsaCards)}`)
    lines.push(`- arecord -l: ${commandSummary(arecord)}`)
    lines.push(`- aplay -l: ${commandSummary(aplay)}`)
    lines.push(`- /dev/snd: ${(await readDevSndSummary()).split(/\r?\n/).slice(0, 8).join(' ; ')}`)
    lines.push(`- /dev/snd ACL sample: ${sndAclSummary.replace(/\n/g, ' ; ')}`)
    lines.push(`- User: ${userLine || 'unknown'}`)
    lines.push(`- Bluetooth JBL: ${bluetoothInfo.split(/\r?\n/).filter(line => /^(Device|Name:|Connected:|Paired:|Trusted:)/.test(line.trim())).join(' ; ') || 'unavailable'}`)

    if (!wpctl.ok) failures.push('PipeWire status cannot be read.')
    if (devices.length === 0) failures.push('PipeWire sees no audio devices.')
    if (!playTarget) failures.push(`Playback target "${PLAY_TARGET || PLAY_TARGET_NAME}" is not available in PipeWire.`)
    if (!recordTarget) failures.push(`Recording target "${RECORD_TARGET || RECORD_TARGET_NAME}" is not available in PipeWire sources.`)
    if (!PLAY_TARGET && !bluetoothIsConnected(bluetoothInfo)) failures.push(`Bluetooth speaker "${BLUETOOTH_DEVICE_NAME}" is not connected.`)
    if (!arecord.ok || /no soundcards|サウンドカードが見つかりません/i.test(`${arecord.stdout}${arecord.stderr}`)) {
        failures.push('arecord cannot see a capture device.')
    }
    if (!aplay.ok || /no soundcards|サウンドカードが見つかりません/i.test(`${aplay.stdout}${aplay.stderr}`)) {
        failures.push('aplay cannot see a playback device.')
    }

    const hasAlsaCards = /^\s*\d+\s+\[/.test(alsaCards)
    if (hasAlsaCards && devices.length === 0) {
        failures.push('ALSA cards exist, but the current PipeWire session cannot access them.')
        if (!/\baudio\b/.test(userLine)) {
            failures.push('The current user is not in the audio group and /dev/snd is likely seat/ACL-gated.')
        }
    }

    if (failures.length > 0) {
        lines.push('')
        lines.push('Required before physical 10-turn probing:')
        for (const failure of failures) lines.push(`- ${failure}`)
        lines.push('')
        lines.push('Likely local fixes:')
        lines.push(`- Run: sudo setfacl -m u:${CURRENT_USER}:rw /dev/snd/*`)
        lines.push(`- Or add ${CURRENT_USER} to the audio group and start a fresh login session.`)
        lines.push('- Then run: systemctl --user restart pipewire wireplumber')
        lines.push(`- Reconnect JBL if needed: bluetoothctl connect ${BLUETOOTH_DEVICE || '<JBL_MAC>'}`)
        lines.push('- Alternatively, log into the local desktop seat as hayato so audio-device ACLs are assigned to this user.')
    }

    return { ok: failures.length === 0, lines }
}

function parseWpctlTarget(status: string, targetName: string): PipeWireTarget | null {
    return parseWpctlSectionTarget(status, 'Sinks', targetName)
}

function parseWpctlSectionTarget(status: string, sectionName: 'Sinks' | 'Sources', targetName: string): PipeWireTarget | null {
    const normalizedNeedle = targetName.trim().toLowerCase()
    if (!normalizedNeedle) return null

    let inSection = false
    for (const line of status.split(/\r?\n/)) {
        if (new RegExp(`^\\s*├─ ${sectionName}:`).test(line)) {
            inSection = true
            continue
        }
        if (inSection && /^\s*├─ /.test(line)) {
            inSection = false
        }
        if (!inSection) continue

        const match = line.match(/^\D*(\d+)\.\s+(.+?)(?:\s+\[vol:|$)/)
        if (!match) continue

        const name = match[2].trim()
        if (match[1] === targetName || name.toLowerCase().includes(normalizedNeedle)) {
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

async function resolveRecordTarget(): Promise<PipeWireTarget | null> {
    if (!RECORD_TARGET && !RECORD_TARGET_NAME) return null
    const status = (await run('wpctl', ['status'])).stdout
    const target = parseWpctlSectionTarget(status, 'Sources', RECORD_TARGET || RECORD_TARGET_NAME)
    if (!target) {
        throw new Error(`PipeWire recording target "${RECORD_TARGET || RECORD_TARGET_NAME}" was not found. Run "npm run probe:voice -- --devices" after connecting the USB camera microphone.`)
    }
    target.volume = await getPipeWireVolume(target.selector)
    return target
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

async function recordMicSample(recordingPath: string, durationMs: number, recordTarget?: PipeWireTarget | null): Promise<void> {
    const args = [
        ...(recordTarget?.selector ? ['--target', recordTarget.selector] : []),
        '--rate', '16000',
        '--channels', '1',
        '--format', 's16',
        recordingPath,
    ]
    const recorder = spawn('pw-record', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const recorderErrors: Buffer[] = []
    recorder.stderr.on('data', (chunk: Buffer) => recorderErrors.push(chunk))
    await sleep(durationMs)

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
        if (recordedBytes > 44) return
        const stderr = Buffer.concat(recorderErrors).toString('utf8')
        throw new Error(`pw-record quiet sample failed with code ${exitCode}: ${stderr}`)
    }
}

async function maxSpeechRms(filePath: string): Promise<number> {
    const wav = await readFile(filePath)
    const info = readWavInfo(wav)
    const bytesPerSampleFrame = info.channels * (info.bitsPerSample / 8)
    const frameMs = 20
    const frameBytes = Math.max(bytesPerSampleFrame, Math.round(info.sampleRate * frameMs / 1000) * bytesPerSampleFrame)
    let maxRms = 0

    for (let offset = info.dataOffset; offset < info.dataOffset + info.dataBytes; offset += frameBytes) {
        maxRms = Math.max(maxRms, rmsForFrame(wav, info, offset, frameBytes))
    }
    return maxRms
}

async function waitForQuietBeforePrompt(runDir: string, index: number): Promise<void> {
    if (PRE_PROMPT_QUIET_MS <= 0) return
    const recordTarget = await resolveRecordTarget()

    const deadline = Date.now() + PRE_PROMPT_QUIET_TIMEOUT_MS
    let attempt = 0
    while (true) {
        attempt += 1
        const samplePath = path.join(runDir, `quiet-${index}-${attempt}.wav`)
        await recordMicSample(samplePath, PRE_PROMPT_QUIET_MS, recordTarget)
        const maxRms = await maxSpeechRms(samplePath)
        if (maxRms < PRE_PROMPT_QUIET_RMS_THRESHOLD) {
            if (attempt > 1) {
                console.log(`[probe] ${index}: pre-prompt quiet after ${attempt} checks maxRms=${maxRms.toFixed(4)}`)
            }
            return
        }
        if (Date.now() >= deadline) {
            console.warn(`[probe] ${index}: pre-prompt quiet timeout, proceeding maxRms=${maxRms.toFixed(4)}`)
            return
        }
        console.log(`[probe] ${index}: waiting for M5 speech to finish maxRms=${maxRms.toFixed(4)}`)
        await sleep(500)
    }
}

async function readBridgeStatus(): Promise<BridgeStatus> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
        const response = await fetch(BRIDGE_STATUS_URL, { signal: controller.signal })
        const text = await response.text()
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
        const body = JSON.parse(text) as Record<string, unknown>
        const result = body['result']
        if (typeof result !== 'object' || result === null) {
            throw new Error('Bridge status response did not include result')
        }
        return result as BridgeStatus
    } finally {
        clearTimeout(timeout)
    }
}

function bridgeWaitSummary(status: BridgeStatus): string {
    const parts = [
        `connected=${status.connected === true}`,
        `ready=${status.readyForPrompt === true}`,
        `reason=${status.reason ?? 'unknown'}`,
    ]
    if (status.state) parts.push(`state=${status.state}`)
    if (status.ttsStreaming !== undefined) parts.push(`tts=${status.ttsStreaming}`)
    if (typeof status.cooldownRemainingMs === 'number') parts.push(`cooldown=${Math.round(status.cooldownRemainingMs)}ms`)
    if (status.followupRunning !== undefined) parts.push(`followup=${status.followupRunning}`)
    if (typeof status.followupQueued === 'number') parts.push(`queued=${status.followupQueued}`)
    return parts.join(' ')
}

async function waitForBridgeReadyBeforePrompt(index: number): Promise<void> {
    if (!WAIT_BRIDGE_READY) return

    const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS
    let lastSummary = ''
    let lastLogAt = 0
    while (true) {
        const status = await readBridgeStatus()
        if (status.connected === true && status.readyForPrompt === true) {
            if (lastSummary) console.log(`[probe] ${index}: bridge ready ${bridgeWaitSummary(status)}`)
            return
        }

        const summary = bridgeWaitSummary(status)
        const now = Date.now()
        if (summary !== lastSummary || now - lastLogAt > 5000) {
            console.log(`[probe] ${index}: waiting for bridge readiness ${summary}`)
            lastSummary = summary
            lastLogAt = now
        }
        if (now >= deadline) {
            throw new Error(`Bridge did not become ready before prompt ${index}: ${summary}`)
        }
        await sleep(BRIDGE_READY_POLL_MS)
    }
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
    'internalFirstTtsFrameSentElapsedMs' |
    'internalFirstAudibleTtsFrameSentElapsedMs' |
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

const INTERNAL_TTS_SEGMENT_SYNTHESIZE_RE = /\[timing\] done [^\n]*:tts(?:\.followup)?(?:\.stream)?\.(?:segment0|error\.segment0)\.synthesize elapsed=([0-9.]+)ms/g
const INTERNAL_TTS_FIRST_FRAME_RE = /\[timing\] mark [^\n]*:tts(?:\.followup)?(?:\.stream)?\.first_frame_sent elapsed=([0-9.]+)ms/g
const INTERNAL_TTS_FIRST_AUDIBLE_FRAME_RE = /\[timing\] mark [^\n]*:tts(?:\.followup)?(?:\.stream)?\.first_audible_frame_sent elapsed=([0-9.]+)ms/g

async function readInternalTurnSummary(sinceEpochMs: number): Promise<InternalTurnSummary> {
    if (!AI_SERVER_SERVICE) {
        return {
            internalTranscript: null,
            internalSttElapsedMs: null,
            internalFirstTtsSynthesizeElapsedMs: null,
            internalFirstTtsFrameSentElapsedMs: null,
            internalFirstAudibleTtsFrameSentElapsedMs: null,
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
            internalFirstTtsSynthesizeElapsedMs: lastRegexNumber(stdout, INTERNAL_TTS_SEGMENT_SYNTHESIZE_RE),
            internalFirstTtsFrameSentElapsedMs: lastRegexNumber(stdout, INTERNAL_TTS_FIRST_FRAME_RE),
            internalFirstAudibleTtsFrameSentElapsedMs: lastRegexNumber(stdout, INTERNAL_TTS_FIRST_AUDIBLE_FRAME_RE),
            internalProcessElapsedMs: lastRegexNumber(stdout, /\[timing\] done [^\n]*:process elapsed=([0-9.]+)ms/g),
        }
    } catch (error) {
        return {
            internalTranscript: null,
            internalSttElapsedMs: null,
            internalFirstTtsSynthesizeElapsedMs: null,
            internalFirstTtsFrameSentElapsedMs: null,
            internalFirstAudibleTtsFrameSentElapsedMs: null,
            internalProcessElapsedMs: null,
            internalLogError: error instanceof Error ? error.message : String(error),
        }
    }
}

async function recordWhilePlaying(promptPath: string, recordingPath: string, playTarget: PipeWireTarget, recordTarget: PipeWireTarget | null): Promise<number> {
    const args = [
        ...(recordTarget?.selector ? ['--target', recordTarget.selector] : []),
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
        const args = ['-y', '-loglevel', 'error']
        const filters: string[] = []
        const labels: string[] = []
        let inputIndex = 0

        args.push(
            '-f', 'lavfi',
            '-t', (PROMPT_WARMUP_TONE_MS / 1000).toFixed(3),
            '-i', 'sine=frequency=180:sample_rate=24000',
        )
        filters.push(`[${inputIndex}:a]volume=${PROMPT_WARMUP_TONE_VOLUME},aresample=24000[a${inputIndex}]`)
        labels.push(`[a${inputIndex}]`)
        inputIndex += 1

        if (PROMPT_LEAD_SILENCE_MS > 0) {
            args.push(
                '-f', 'lavfi',
                '-t', (PROMPT_LEAD_SILENCE_MS / 1000).toFixed(3),
                '-i', 'anullsrc=r=24000:cl=mono',
            )
            filters.push(`[${inputIndex}:a]aresample=24000[a${inputIndex}]`)
            labels.push(`[a${inputIndex}]`)
            inputIndex += 1
        }

        args.push('-i', rawPromptPath)
        filters.push(`[${inputIndex}:a]aresample=24000[a${inputIndex}]`)
        labels.push(`[a${inputIndex}]`)

        await run('ffmpeg', [
            ...args,
            '-filter_complex',
            `${filters.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`,
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
    const recordTarget = await resolveRecordTarget()

    await waitForBridgeReadyBeforePrompt(index)
    await waitForQuietBeforePrompt(runDir, index)
    console.log(`[probe] ${index}: playing prompt through target=${playTarget.selector} (${playTarget.name}), recording target=${recordTarget?.selector ?? '(default)'}${recordTarget ? ` (${recordTarget.name})` : ''}`)
    const internalLogSinceMs = Date.now()
    const playbackElapsedMs = await recordWhilePlaying(promptPath, recordingPath, playTarget, recordTarget)
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
        playTarget: playTarget.selector,
        playTargetName: playTarget.name,
        playTargetVolume: playTarget.volume,
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
            '  STACKCHAN_PROBE_RECORD_TARGET     PipeWire source id/name for USB camera mic; overrides name lookup',
            '  STACKCHAN_PROBE_RECORD_TARGET_NAME PipeWire source name substring, default "C505 HD Webcam"',
            '  STACKCHAN_PROBE_RESPONSE_WINDOW_MS Recording window after prompt playback, default 9000',
            '  STACKCHAN_PROBE_SPEECH_RMS_THRESHOLD RMS threshold for acoustic response start, default 0.018',
            '  STACKCHAN_PROBE_RESPONSE_GUARD_MS Ignore prompt tail before detecting response, default 700',
            '  STACKCHAN_PROBE_PRE_PROMPT_QUIET_MS Quiet webcam-mic window before each prompt, default 1500',
            '  STACKCHAN_PROBE_WAIT_BRIDGE_READY Wait until ai-server reports listening/ready before each prompt, default true',
            '  STACKCHAN_PROBE_BRIDGE_READY_TIMEOUT_MS Timeout for bridge readiness before failing a prompt',
            '  STACKCHAN_PROBE_PROMPT_LEAD_SILENCE_MS Silence prepended before JBL prompt playback, default 800',
            '  STACKCHAN_PROBE_PROMPT_WARMUP_TONE_MS Low-volume tone prepended before JBL prompt playback, default 0',
            '  STACKCHAN_PROBE_BLUETOOTH_RECONNECT Try bluetoothctl reconnect when JBL sink is missing, default true',
            '  STACKCHAN_PROBE_BLUETOOTH_DEVICE Optional Bluetooth MAC address for reconnect',
            '  STACKCHAN_PROBE_AI_SERVER_SERVICE User systemd unit for internal timing logs',
            '  STACKCHAN_PROBE_STT_URL           OpenAI-compatible transcription endpoint',
            '  STACKCHAN_PROBE_STT_API_KEY       Optional transcription endpoint API key',
            '',
            'Use --devices to print PipeWire devices without playing audio.',
            'Use --preflight to verify JBL playback, USB mic recording, PipeWire, ALSA, and bridge readiness.',
        ].join('\n'))
        return
    }
    if (args.includes('--preflight')) {
        const preflight = await runAudioPreflight()
        console.log(preflight.lines.join('\n'))
        if (!preflight.ok) process.exitCode = 1
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
    const preflight = await runAudioPreflight()
    if (!preflight.ok) {
        await writeFile(path.join(runDir, 'preflight.txt'), `${preflight.lines.join('\n')}\n`)
        throw new Error(`Audio preflight failed. Details were written to ${path.join(runDir, 'preflight.txt')}`)
    }
    const initialPlayTarget = await setPlayTargetVolume(await resolvePlayTarget())

    console.log(`[probe] run directory: ${runDir}`)
    console.log(`[probe] playback target: ${initialPlayTarget.selector} (${initialPlayTarget.name}), volume=${initialPlayTarget.volume ?? 'unknown'}`)
    console.log(`[probe] prompts: ${selectedPrompts.length}`)
    const results: ProbeResult[] = []
    for (let i = 0; i < selectedPrompts.length; i++) {
        const playTarget = await setPlayTargetVolume(await resolvePlayTarget())
        const result = await probeOne(selectedPrompts[i], i + 1, runDir, playTarget)
        results.push(result)
        console.log(`[probe] ${result.index}: latency=${result.responseLatencyMsFromPlaybackEnd ?? 'not-detected'}ms internalStt=${JSON.stringify(result.internalTranscript)} transcript=${JSON.stringify(result.transcript)}`)
    }

    const reportPath = path.join(runDir, 'report.json')
    await writeFile(reportPath, `${JSON.stringify({
        playTarget: initialPlayTarget.selector,
        playTargetName: initialPlayTarget.name,
        playTargetRequestedName: initialPlayTarget.requestedName,
        playTargetVolume: initialPlayTarget.volume,
        configuredPlayVolume: PLAY_VOLUME,
        recordTarget: RECORD_TARGET || RECORD_TARGET_NAME,
        promptLeadSilenceMs: PROMPT_LEAD_SILENCE_MS,
        promptWarmupToneMs: PROMPT_WARMUP_TONE_MS,
        promptWarmupToneVolume: PROMPT_WARMUP_TONE_VOLUME,
        waitBridgeReady: WAIT_BRIDGE_READY,
        bridgeStatusUrl: BRIDGE_STATUS_URL,
        bridgeReadyTimeoutMs: BRIDGE_READY_TIMEOUT_MS,
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
