import childProcess, { type ChildProcess } from 'child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type LocalTtsOutputConfig = {
    enabled: boolean
    targetName: string
    volume: number
    fallbackM5Volume: number
}

export type LocalAudioOperationOptions = { signal?: AbortSignal; timeoutMs?: number }

export function readLocalTtsOutputConfig(
    env: Record<string, string | undefined> = process.env,
): LocalTtsOutputConfig {
    const volume = Number(env['STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME'] ?? '0.35')
    const fallbackM5Volume = Number(env['STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME'] ?? '62')
    return {
        enabled: /^(1|true|yes|on)$/i.test(env['STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED']?.trim() ?? ''),
        targetName: env['STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME']?.trim() || 'JBL Flip 3',
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(1.2, volume)) : 0.35,
        fallbackM5Volume: Number.isFinite(fallbackM5Volume)
            ? Math.max(0, Math.min(100, Math.round(fallbackM5Volume)))
            : 62,
    }
}

export function findPipeWireSinkId(status: string, targetName: string): string | null {
    const needle = targetName.trim().toLowerCase()
    if (!needle) return null
    let inAudio = false
    let inSinks = false
    for (const line of status.split(/\r?\n/)) {
        if (/^Audio\s*$/.test(line)) {
            inAudio = true
            inSinks = false
            continue
        }
        if (/^(Video|Settings)\s*$/.test(line)) {
            inAudio = false
            inSinks = false
            continue
        }
        if (!inAudio) continue
        if (/^\s*├─ Sinks:/.test(line)) {
            inSinks = true
            continue
        }
        if (inSinks && /^\s*├─ /.test(line)) inSinks = false
        if (!inSinks) continue
        const match = line.match(/^\D*(\d+)\.\s+(.+?)(?:\s+\[|$)/)
        if (!match) continue
        if (match[1] === targetName || match[2].trim().toLowerCase().includes(needle)) return match[1]
    }
    return null
}

function requireActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('local TTS output aborted')
}

function validTarget(target: string): boolean {
    return typeof target === 'string' && /^[1-9][0-9]{0,9}$/.test(target) && Number(target) < 0xffffffff
}

// These inert sinks intentionally remain after close: faulty late error events
// must not become uncaught exceptions. They capture no operation/input state.
function ignoreError(): void {}

function waitForChild(
    child: ChildProcess,
    options: LocalAudioOperationOptions,
    timeoutMs: number,
    commandFailed: () => boolean = () => false,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let failure: Error | undefined
        let stopping = false
        let settled = false
        const stop = (error: Error) => {
            if (settled || stopping) return
            failure = error
            stopping = true
            clearTimeout(timer)
            try { child.kill('SIGKILL') } catch { /* Wait for close; never expose process errors. */ }
        }
        const onAbort = () => stop(new Error('local TTS output aborted'))
        const onError = () => stop(new Error('local TTS output process failed'))
        const drain = () => undefined // Discard stderr; do not retain private/unbounded output.
        const onClose = (code: number | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            child.removeListener('close', onClose)
            child.removeListener('error', onError)
            child.on('error', ignoreError)
            child.stderr?.removeListener('data', drain)
            child.stderr?.removeListener('error', onError)
            child.stderr?.on('error', ignoreError)
            if (failure) reject(failure)
            else if (code !== 0 || commandFailed()) reject(new Error('local TTS output process failed'))
            else resolve()
        }
        const timer = setTimeout(() => stop(new Error('local TTS output timed out')), timeoutMs)
        child.on('error', onError)
        child.on('close', onClose)
        child.stderr?.on('data', drain)
        child.stderr?.on('error', onError)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted) onAbort() // Also covers abort during spawn.
    })
}

async function execFileText(command: string, args: string[], options: LocalAudioOperationOptions): Promise<string> {
    requireActive(options.signal)
    let stdout = ''
    let failed = false
    let child: ChildProcess
    try {
        child = childProcess.execFile(command, args, {
            encoding: 'utf8', maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
        }, (error, value) => {
            failed = !!error || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024
            stdout = failed ? '' : value
        })
    } catch { throw new Error('local TTS output process failed') }
    await waitForChild(child, options, 3000, () => failed)
    requireActive(options.signal)
    return stdout
}

export async function resolveLocalTtsOutputTarget(config: LocalTtsOutputConfig, options: LocalAudioOperationOptions = {}): Promise<string | null> {
    if (!config.enabled) return null
    const status = await execFileText('wpctl', ['status'], options)
    const target = findPipeWireSinkId(status, config.targetName)
    if (!target) return null
    if (!validTarget(target)) throw new Error('invalid local TTS output target')
    await execFileText('wpctl', ['set-volume', target, config.volume.toFixed(2)], options)
    await execFileText('wpctl', ['set-mute', target, '0'], options)
    return target
}

const LOCAL_AUDIO_TEMP_PREFIX = 'stackchan-local-tts-'

function checkedTempDirectory(directory: string, parent: string): string {
    const resolved = path.resolve(directory)
    if (directory !== resolved || path.dirname(resolved) !== parent ||
        !new RegExp(`^${LOCAL_AUDIO_TEMP_PREFIX}[A-Za-z0-9]{6}$`).test(path.basename(resolved))) {
        throw new Error('local TTS output cleanup failed')
    }
    return resolved
}

export async function playWavOnLocalTarget(target: string, wav: Buffer, options: LocalAudioOperationOptions = {}): Promise<void> {
    requireActive(options.signal)
    if (!validTarget(target)) throw new Error('invalid local TTS output target')
    if (!Buffer.isBuffer(wav) || wav.length < 12 || wav.length > 8 * 1024 * 1024 ||
        wav.toString('utf8', 0, 4) !== 'RIFF' || wav.toString('utf8', 8, 12) !== 'WAVE') {
        throw new Error('invalid local TTS audio')
    }
    // Keep the complete container unchanged. A file lets libsndfile interpret its
    // actual rate/channels/encoding; '-' is raw stdin in pw-play, not a WAV file.
    const audio = Buffer.from(wav)
    const requestedTimeout = options.timeoutMs ?? 60_000
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1000, Math.min(120_000, Math.round(requestedTimeout))) : 60_000
    const tempParent = path.resolve(os.tmpdir())
    const prefix = path.join(tempParent, LOCAL_AUDIO_TEMP_PREFIX)
    let directory: string | undefined
    let failure: unknown
    try {
        let filename: string
        try {
            requireActive(options.signal)
            directory = await fs.mkdtemp(prefix)
            checkedTempDirectory(directory, tempParent)
            requireActive(options.signal)
            await fs.chmod(directory, 0o700)
            requireActive(options.signal)
            filename = path.join(directory, 'speech.wav')
            await fs.writeFile(filename, audio, { flag: 'wx', mode: 0o600, signal: options.signal })
            requireActive(options.signal)
            await fs.chmod(filename, 0o600)
            requireActive(options.signal)
        } catch {
            if (options.signal?.aborted) throw new Error('local TTS output aborted')
            throw new Error('local TTS output file setup failed')
        }
        let child: ChildProcess
        try {
            requireActive(options.signal)
            child = childProcess.spawn('pw-play', ['--target', target, filename], { stdio: ['ignore', 'ignore', 'pipe'] })
        } catch {
            if (options.signal?.aborted) throw new Error('local TTS output aborted')
            throw new Error('local TTS output process failed')
        }
        // No removal while pw-play may still be reading the file, including
        // cancellation/deadline: waitForChild kills and awaits close/reap first.
        await waitForChild(child, options, timeoutMs)
    } catch (error) {
        failure = error
    } finally {
        if (directory !== undefined) {
            try {
                const cleanupTarget = checkedTempDirectory(directory, tempParent)
                await fs.rm(cleanupTarget, { recursive: true, force: true })
            } catch {
                // Do not expose paths/audio/OS errors, even if cleanup overrides
                // a prior failure. A leftover file stays in its private directory.
                failure = new Error('local TTS output cleanup failed')
            }
        }
    }
    if (failure !== undefined) throw failure
}
