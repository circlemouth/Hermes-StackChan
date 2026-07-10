import { execFile, spawn } from 'child_process'

export type LocalTtsOutputConfig = {
    enabled: boolean
    targetName: string
    volume: number
    fallbackM5Volume: number
}

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

function execFileText(command: string, args: string[], timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${command} failed: ${(stderr || error.message).trim()}`))
                return
            }
            resolve(stdout)
        })
    })
}

export async function resolveLocalTtsOutputTarget(config: LocalTtsOutputConfig): Promise<string | null> {
    if (!config.enabled) return null
    const status = await execFileText('wpctl', ['status'])
    const target = findPipeWireSinkId(status, config.targetName)
    if (!target) return null
    await execFileText('wpctl', ['set-volume', target, config.volume.toFixed(2)])
    await execFileText('wpctl', ['set-mute', target, '0'])
    return target
}

export function playWavOnLocalTarget(target: string, wav: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('pw-play', ['--target', target, '-'], {
            stdio: ['pipe', 'ignore', 'pipe'],
        })
        const stderr: Buffer[] = []
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
                return
            }
            reject(new Error(`pw-play exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
        })
        child.stdin.on('error', (error) => {
            if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error)
        })
        child.stdin.end(wav)
    })
}
