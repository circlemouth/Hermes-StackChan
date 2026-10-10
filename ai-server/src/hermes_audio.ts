import { spawn } from 'child_process'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { ChildrenHttpHermesClient, normalizeChildrenHermesUrl } from './children_hermes'

// Owner-only client: TTS/STT permission probes never create a chat session.
let childrenAudioClient: { key: string; client: ChildrenHttpHermesClient } | undefined
function childAudioClient(): ChildrenHttpHermesClient {
    const key = JSON.stringify([process.env.HERMES_CHILDREN_URL, process.env.HERMES_CHILDREN_PROFILE_ID])
    if (!childrenAudioClient || childrenAudioClient.key !== key) {
        childrenAudioClient = { key, client: new ChildrenHttpHermesClient() }
    }
    return childrenAudioClient.client
}

function childSttUrl(value: string): string {
    try {
        const url = new URL(value)
        const authority = value.match(/^(https?:\/\/[^/]+)\/v1\/audio\/transcriptions$/i)?.[1]
        if (!authority || url.pathname !== '/v1/audio/transcriptions') throw new Error()
        return `${normalizeChildrenHermesUrl(authority)}/v1/audio/transcriptions`
    } catch {
        throw new Error('Children Hermes STT requires an HTTP loopback transcription endpoint')
    }
}

export type AudioOperationOptions = {
    signal?: AbortSignal
    /** Absolute Unix time in milliseconds; shared by all stages of the operation. */
    deadline?: number
}

type CommandResult = {
    stdout: string
    stderr: string
}

function audioAborted(): Error { return new Error('Hermes audio operation aborted') }

async function withAudioOperation<T>(
    options: AudioOperationOptions, timeoutMs: number, fn: (options: AudioOperationOptions) => Promise<T>,
): Promise<T> {
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new Error('Invalid Hermes audio deadline')
    if (options.signal?.aborted) throw audioAborted()
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs)
    if (deadline <= Date.now()) throw new Error('Hermes audio operation timed out')
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, deadline - Date.now()))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    try {
        const result = await fn({ signal: controller.signal, deadline })
        if (deadline <= Date.now()) timedOut = true
        if (timedOut) throw new Error('Hermes audio operation timed out')
        if (controller.signal.aborted) throw audioAborted()
        return result
    } catch (error) {
        if (timedOut) throw new Error('Hermes audio operation timed out')
        if (controller.signal.aborted) throw audioAborted()
        throw error
    } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
    }
}

function checkAudio(options: AudioOperationOptions): void {
    if (options.signal?.aborted) throw audioAborted()
    if (options.deadline !== undefined && options.deadline <= Date.now()) throw new Error('Hermes audio operation timed out')
}

type TranscriptionResult = {
    success?: boolean
    transcript?: string
    text?: string
    result?: string
    error?: string
}

type TtsResult = {
    success?: boolean
    file_path?: string
    error?: string
}

const TEMP_ROOT = path.join(tmpdir(), 'stackchan-hermes')

function hermesRoot(): string {
    return process.env.HERMES_ROOT ?? path.resolve(process.cwd(), '..', 'hermes-agent')
}

function pythonCommand(): string {
    return process.env.HERMES_PYTHON ?? 'python3'
}

function run(command: string, args: string[], options: AudioOperationOptions & { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        try { checkAudio(options) } catch (error) { reject(error); return }
        // A process group lets cancellation also stop ffmpeg spawned by a Python
        // helper. Never settle on error/exit: wait for close before temp cleanup.
        const grouped = process.platform !== 'win32'
        const child = spawn(command, args, {
            cwd: options.cwd, env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'], detached: grouped,
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let bytes = 0
        let failure: Error | undefined
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined
        const kill = (signal: NodeJS.Signals) => {
            if (grouped && child.pid) {
                try { process.kill(-child.pid, signal); return } catch { /* already closed */ }
            }
            try { child.kill(signal) } catch { /* already closed */ }
        }
        const stop = (error: Error) => {
            if (failure) return
            failure = error
            kill('SIGTERM')
            killTimer = setTimeout(() => kill('SIGKILL'), 250)
        }
        const onAbort = () => stop(audioAborted())
        const append = (target: Buffer[], chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 1_048_576) stop(new Error('Hermes audio helper output is too large'))
            else target.push(chunk)
        }
        child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
        child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
        child.on('error', () => { failure ??= new Error('Hermes audio helper could not start') })
        child.on('close', (code) => {
            clearTimeout(killTimer)
            clearTimeout(deadlineTimer)
            options.signal?.removeEventListener('abort', onAbort)
            if (failure && grouped) kill('SIGKILL')
            if (failure) reject(failure)
            else if (code !== 0) reject(new Error(`Hermes audio helper exited with code ${code}`))
            else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
        })
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.deadline !== undefined) {
            deadlineTimer = setTimeout(() => stop(new Error('Hermes audio operation timed out')), Math.max(1, options.deadline - Date.now()))
        }
        if (options.signal?.aborted) onAbort()
    })
}

function hermesPythonEnv(): NodeJS.ProcessEnv {
    const root = hermesRoot()
    const localOnly = process.env.STACKCHAN_LOCAL_ONLY
    return {
        ...process.env,
        ...(localOnly ? { STACKCHAN_LOCAL_ONLY: localOnly, HERMES_LOCAL_ONLY: '1' } : {}),
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    }
}

function configuredSttUrl(): string {
    return process.env.HERMES_STT_URL ?? process.env.STACKCHAN_STT_URL ?? ''
}

function configuredLocalTtsUrl(): string {
    return process.env.STACKCHAN_LOCAL_TTS_URL ?? ''
}

function readTimeoutMs(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback)
    if (!Number.isFinite(value)) return fallback
    return Math.max(500, Math.min(120_000, Math.round(value)))
}

async function readChildSttText(response: Response): Promise<string> {
    if (!response.body) throw new Error('Invalid children Hermes STT response')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let bytes = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > 1_048_576) throw new Error('Children Hermes STT response is too large')
            chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks).toString('utf8')
    } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
    }
}

async function transcribeWithOpenAiCompatibleStt(wav: Buffer, url: string, options: AudioOperationOptions, childrenOnly = false): Promise<string> {
    const form = new FormData()
    form.append('model', process.env.HERMES_STT_MODEL ?? process.env.STACKCHAN_STT_MODEL ?? 'whisper-1')
    form.append('language', process.env.HERMES_STT_LANGUAGE ?? process.env.HERMES_LOCAL_STT_LANGUAGE ?? 'ja')
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'input.wav')

    const apiKey = childrenOnly ? '' : process.env.HERMES_STT_API_KEY ?? process.env.WHISPER_API_KEY ?? ''
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
            body: form,
            signal: options.signal,
            ...(childrenOnly ? { redirect: 'error' as const, credentials: 'omit' as const } : {}),
        })
        if (childrenOnly && !response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error('Children Hermes STT request rejected')
        }
        const text = childrenOnly ? await readChildSttText(response) : await response.text()
        if (!response.ok) throw new Error(`STT endpoint failed: HTTP ${response.status}: ${text}`)
        const result = JSON.parse(text) as TranscriptionResult
        const transcript = result.text ?? result.transcript ?? result.result ?? ''
        if (childrenOnly && typeof transcript !== 'string') throw new Error('Invalid children Hermes STT response')
        return String(transcript).trim()
    } catch (error) {
        if (childrenOnly) throw new Error('Children Hermes STT request failed')
        throw error
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    await mkdir(TEMP_ROOT, { recursive: true })
    const id = randomUUID()
    const dir = path.resolve(TEMP_ROOT, id)
    await mkdir(dir)
    try {
        return await fn(dir)
    } finally {
        if (path.dirname(dir) !== path.resolve(TEMP_ROOT) || path.basename(dir) !== id) {
            throw new Error('Invalid Hermes audio temporary directory')
        }
        await rm(dir, { recursive: true, force: true })
    }
}

function parseJson<T>(stdout: string, label: string): T {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (!line) throw new Error(`${label} produced no JSON output`)
    return JSON.parse(line) as T
}

export async function transcribeWithHermes(wav: Buffer, options: AudioOperationOptions = {}): Promise<string> {
    return await withAudioOperation(options, readTimeoutMs('HERMES_STT_TIMEOUT_MS', 30_000), async (operation) => {
        const sttUrl = configuredSttUrl()
        if (process.env.HERMES_CONNECT_MODE === 'children_http') {
            const url = childSttUrl(sttUrl)
            await childAudioClient().ensureVoiceEnabled(operation)
            return await transcribeWithOpenAiCompatibleStt(wav, url, operation, true)
        }
        if (sttUrl) return await transcribeWithOpenAiCompatibleStt(wav, sttUrl, operation)

        return await withTempDir(async (dir) => {
            checkAudio(operation)
            const inputPath = path.join(dir, 'input.wav')
            await writeFile(inputPath, wav, { signal: operation.signal })
            const script = [
                'import json, sys',
                'from tools.transcription_tools import transcribe_audio',
                'print(json.dumps(transcribe_audio(sys.argv[1]), ensure_ascii=False))',
            ].join('\n')
            const { stdout } = await run(pythonCommand(), ['-c', script, inputPath], {
                ...operation, cwd: hermesRoot(), env: hermesPythonEnv(),
            })
            const result = parseJson<TranscriptionResult>(stdout, 'Hermes transcription')
            if (!result.success) throw new Error('Hermes transcription failed')
            return result.transcript ?? ''
        })
    })
}

async function synthesizeWithLocalHttpTts(text: string, url: string, options: AudioOperationOptions): Promise<Buffer> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
        signal: options.signal,
    })
    if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Local TTS endpoint failed: HTTP ${response.status}: ${detail}`)
    }

    const wav = Buffer.from(await response.arrayBuffer())
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Local TTS endpoint did not return a valid WAV file')
    }
    return wav
}

export async function synthesizeWithHermes(text: string, options: AudioOperationOptions = {}): Promise<Buffer> {
    const localTtsUrl = configuredLocalTtsUrl()
    const timeoutMs = localTtsUrl && process.env.HERMES_CONNECT_MODE !== 'children_http'
        ? readTimeoutMs('STACKCHAN_LOCAL_TTS_TIMEOUT_MS', 15_000)
        : readTimeoutMs('HERMES_TTS_TIMEOUT_MS', 30_000)
    return await withAudioOperation(options, timeoutMs, async (operation) => {
        if (process.env.HERMES_CONNECT_MODE === 'children_http') {
            return await childAudioClient().synthesize(text, operation)
        }
        if (localTtsUrl) return await synthesizeWithLocalHttpTts(text, localTtsUrl, operation)

        return await withTempDir(async (dir) => {
            checkAudio(operation)
            const outputPath = path.join(dir, 'speech.wav')
            const script = [
                'import json, sys',
                'from tools.tts_tool import text_to_speech_tool',
                'result = text_to_speech_tool(sys.argv[1], output_path=sys.argv[2])',
                'print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))',
            ].join('\n')
            const { stdout } = await run(pythonCommand(), ['-c', script, text, outputPath], {
                ...operation, cwd: hermesRoot(), env: hermesPythonEnv(),
            })
            const result = parseJson<TtsResult>(stdout, 'Hermes TTS')
            if (!result.success || !result.file_path) throw new Error('Hermes TTS failed')
            checkAudio(operation)
            if (result.file_path.toLowerCase().endsWith('.wav')) {
                return await readFile(result.file_path, { signal: operation.signal })
            }
            const wavPath = path.join(dir, 'converted.wav')
            await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', result.file_path, '-ac', '1', '-ar', '24000', wavPath], operation)
            return await readFile(wavPath, { signal: operation.signal })
        })
    })
}
