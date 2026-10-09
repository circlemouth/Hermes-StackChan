import { spawn } from 'child_process'
import { access, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// Matches the pinned upstream SAAN_CONSOLE_LINE_MAX. Do not truncate speech.
export const SANOTTS_MAX_TEXT_BYTES = 512
const MAX_WAV_BYTES = 8 * 1024 * 1024

export type SanoTtsConfig = {
    command: string
    modelPath: string
    dictionaryPath: string
    timeoutMs: number
}

export type SanoTtsOptions = {
    signal?: AbortSignal
}

function serverRoot(): string {
    return path.resolve(__dirname, '..')
}

export function readSanoTtsConfig(
    env: Record<string, string | undefined> = process.env,
): SanoTtsConfig {
    const runtimeRoot = env.SANOTTS_RUNTIME_DIR ?? path.join(serverRoot(), '.sanotts')
    const parsedTimeout = env.SANOTTS_TIMEOUT_MS ? Number(env.SANOTTS_TIMEOUT_MS) : Number.NaN
    return {
        command: env.SANOTTS_COMMAND ?? path.join(runtimeRoot, 'bin', 'sanotts-cli'),
        modelPath: env.SANOTTS_MODEL_PATH ?? path.join(runtimeRoot, 'assets', 'saanotts-jp-v3-int8.bin'),
        dictionaryPath: env.SANOTTS_DICT_PATH ?? path.join(runtimeRoot, 'assets', 'k1-dict-438750.bin'),
        timeoutMs: Number.isFinite(parsedTimeout) ? Math.max(1000, Math.min(120000, Math.round(parsedTimeout))) : 30000,
    }
}

async function assertRuntimeFiles(config: SanoTtsConfig): Promise<void> {
    try {
        await Promise.all([
            access(config.command),
            access(config.modelPath),
            access(config.dictionaryPath),
        ])
    } catch {
        throw new Error('sanoTTS-jp runtime is missing. Run `npm run setup:sanotts` in ai-server.')
    }
}

function aborted(): Error {
    return new Error('sanoTTS-jp synthesis aborted')
}

function run(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(aborted()); return }
        // No shell; native diagnostics may contain rejected input characters, so
        // do not capture/forward stderr into bridge logs or user-visible errors.
        const child = spawn(command, args, { stdio: 'ignore', shell: false })
        let failure: Error | undefined
        let settled = false
        const stop = (error: Error) => {
            failure ??= error
            child.kill('SIGKILL')
        }
        const onAbort = () => stop(aborted())
        const timer = setTimeout(() => stop(new Error(`sanoTTS-jp timed out after ${timeoutMs}ms`)), timeoutMs)
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            if (error) reject(error)
            else resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        // Handle aborts that raced with process creation/listener registration.
        if (signal?.aborted) onAbort()
        child.on('error', () => finish(new Error('sanoTTS-jp could not start')))
        // Await close before the caller removes the temporary output directory.
        child.on('close', (code) => finish(failure ?? (code === 0 ? undefined : new Error(`sanoTTS-jp exited with code ${code}`))))
    })
}

export async function synthesizeWithSanoTts(text: string, options: SanoTtsOptions = {}): Promise<Buffer> {
    const cleanText = text.trim()
    if (!cleanText) throw new Error('sanoTTS-jp cannot synthesize empty text')
    if (cleanText.includes('\0')) throw new Error('sanoTTS-jp text must not contain NUL')
    if (Buffer.byteLength(cleanText, 'utf8') > SANOTTS_MAX_TEXT_BYTES) {
        throw new Error(`sanoTTS-jp text exceeds ${SANOTTS_MAX_TEXT_BYTES} UTF-8 bytes; use shorter TTS segments`)
    }
    if (options.signal?.aborted) throw aborted()

    const config = readSanoTtsConfig()
    await assertRuntimeFiles(config)
    const tempDir = await mkdtemp(path.join(tmpdir(), 'stackchan-sanotts-'))
    const outputPath = path.join(tempDir, 'speech.wav')
    try {
        await run(config.command, [
            '--model', config.modelPath,
            '--dict', config.dictionaryPath,
            '--output', outputPath,
            '--text', cleanText,
        ], config.timeoutMs, options.signal)
        if (options.signal?.aborted) throw aborted()
        const output = await stat(outputPath)
        if (!output.isFile() || output.size < 44 || output.size > MAX_WAV_BYTES) {
            throw new Error('sanoTTS-jp returned an invalid or oversized WAV')
        }
        const wav = await readFile(outputPath)
        if (options.signal?.aborted) throw aborted()
        if (wav.length > MAX_WAV_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('sanoTTS-jp returned an invalid or oversized WAV')
        }
        return wav
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
}
