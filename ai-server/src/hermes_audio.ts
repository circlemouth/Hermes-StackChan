import { spawn } from 'child_process'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

type CommandResult = {
    stdout: string
    stderr: string
}

type TranscriptionResult = {
    success?: boolean
    transcript?: string
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

function run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options?.cwd,
            env: options?.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) => {
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }
            if (code === 0) resolve(result)
            else reject(new Error(`${command} exited with code ${code}: ${result.stderr || result.stdout}`))
        })
    })
}

function hermesPythonEnv(): NodeJS.ProcessEnv {
    const root = hermesRoot()
    return {
        ...process.env,
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    await mkdir(TEMP_ROOT, { recursive: true })
    const dir = path.join(TEMP_ROOT, randomUUID())
    await mkdir(dir, { recursive: true })
    try {
        return await fn(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

function parseJson<T>(stdout: string, label: string): T {
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (!line) throw new Error(`${label} produced no JSON output`)
    return JSON.parse(line) as T
}

export async function transcribeWithHermes(wav: Buffer): Promise<string> {
    return await withTempDir(async (dir) => {
        const inputPath = path.join(dir, 'input.wav')
        await writeFile(inputPath, wav)
        const script = [
            'import json, sys',
            'from tools.transcription_tools import transcribe_audio',
            'print(json.dumps(transcribe_audio(sys.argv[1]), ensure_ascii=False))',
        ].join('\n')
        const { stdout } = await run(pythonCommand(), ['-c', script, inputPath], {
            cwd: hermesRoot(),
            env: hermesPythonEnv(),
        })
        const result = parseJson<TranscriptionResult>(stdout, 'Hermes transcription')
        if (!result.success) throw new Error(result.error ?? 'Hermes transcription failed')
        return result.transcript ?? ''
    })
}

export async function synthesizeWithHermes(text: string): Promise<Buffer> {
    return await withTempDir(async (dir) => {
        const outputPath = path.join(dir, 'speech.wav')
        const script = [
            'import json, sys',
            'from tools.tts_tool import text_to_speech_tool',
            'result = text_to_speech_tool(sys.argv[1], output_path=sys.argv[2])',
            'print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))',
        ].join('\n')
        const { stdout } = await run(pythonCommand(), ['-c', script, text, outputPath], {
            cwd: hermesRoot(),
            env: hermesPythonEnv(),
        })
        const result = parseJson<TtsResult>(stdout, 'Hermes TTS')
        if (!result.success || !result.file_path) throw new Error(result.error ?? 'Hermes TTS failed')
        if (result.file_path.toLowerCase().endsWith('.wav')) {
            return await readFile(result.file_path)
        }
        const wavPath = path.join(dir, 'converted.wav')
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', result.file_path, '-ac', '1', '-ar', '24000', wavPath])
        return await readFile(wavPath)
    })
}
