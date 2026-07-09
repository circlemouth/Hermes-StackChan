import http from 'http'
import { resolveDisplayImageSource } from './media.js'

export type StackChanToolName =
    | 'stackchan_get_status'
    | 'stackchan_set_speaker_volume'
    | 'stackchan_play_test_tone'
    | 'stackchan_get_head_angles'
    | 'stackchan_set_head_angles'
    | 'stackchan_set_led_color'
    | 'stackchan_power_off'
    | 'stackchan_take_photo'
    | 'stackchan_display_image'
    | 'stackchan_capture_screen'
    | 'stackchan_create_reminder'
    | 'stackchan_get_reminders'
    | 'stackchan_stop_reminder'

export type StackChanDeviceSession = {
    callRobotTool(name: string, args: Record<string, unknown>): Promise<unknown>
    enqueueFollowup(prompt: string): Promise<void>
    getBridgeStatus(): StackChanBridgeStatus
}

export type StackChanBridgeStatus = {
    connected: boolean
    sessionId?: string
    state?: string
    readyForPrompt: boolean
    reason: string
    ttsStreaming?: boolean
    cooldownRemainingMs?: number
    followupRunning?: boolean
    followupQueued?: number
    pendingMcp?: number
    lastListenMode?: string
}

const TOOL_MAP: Record<StackChanToolName, string> = {
    stackchan_get_status: 'self.robot.get_status',
    stackchan_set_speaker_volume: 'self.robot.set_speaker_volume',
    stackchan_play_test_tone: 'self.audio.play_test_tone',
    stackchan_get_head_angles: 'self.robot.get_head_angles',
    stackchan_set_head_angles: 'self.robot.set_head_angles',
    stackchan_set_led_color: 'self.robot.set_led_color',
    stackchan_power_off: 'self.robot.power_off',
    stackchan_take_photo: 'self.camera.capture_photo',
    stackchan_display_image: 'self.screen.preview_image_url',
    stackchan_capture_screen: 'self.screen.capture_screenshot',
    stackchan_create_reminder: 'self.robot.create_reminder',
    stackchan_get_reminders: 'self.robot.get_reminders',
    stackchan_stop_reminder: 'self.robot.stop_reminder',
}

let activeSession: StackChanDeviceSession | null = null
let serverStarted = false

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function isToolName(value: unknown): value is StackChanToolName {
    return typeof value === 'string' && value in TOOL_MAP
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('error', reject)
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
            } catch (error) {
                reject(error)
            }
        })
    })
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
}

function normalizeFirmwareResult(result: unknown): unknown {
    if (typeof result !== 'string') return result
    try {
        return JSON.parse(result) as unknown
    } catch {
        return result
    }
}

function clampDurationSeconds(value: unknown): number {
    const duration = typeof value === 'number' ? value : Number(value ?? 6)
    if (!Number.isFinite(duration)) return 6
    return Math.max(1, Math.min(30, Math.round(duration)))
}

function readImageSource(args: Record<string, unknown>): string | null {
    const source = args['source'] ?? args['url'] ?? args['path'] ?? args['image']
    return typeof source === 'string' && source.trim() ? source : null
}

function clampReminderDurationSeconds(value: unknown): number {
    const duration = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(duration)) {
        throw new Error('duration_seconds must be a finite number')
    }
    return Math.max(1, Math.min(86400, Math.round(duration)))
}

function readReminderMessage(value: unknown): string {
    const message = typeof value === 'string' ? value.trim() : ''
    if (!message) throw new Error('message is required')
    return message.slice(0, 120)
}

function readReminderRepeat(value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value.toLowerCase() === 'true'
    return false
}

function clampSpeakerVolume(value: unknown): number {
    const volume = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(volume)) {
        throw new Error('volume must be a finite number')
    }
    return Math.max(0, Math.min(100, Math.round(volume)))
}

function clampToneFrequency(value: unknown): number {
    const frequency = typeof value === 'number' ? value : Number(value ?? 440)
    if (!Number.isFinite(frequency)) {
        throw new Error('frequency_hz must be a finite number')
    }
    return Math.max(100, Math.min(2000, Math.round(frequency)))
}

function clampToneDurationMs(value: unknown): number {
    const duration = typeof value === 'number' ? value : Number(value ?? 800)
    if (!Number.isFinite(duration)) {
        throw new Error('duration_ms must be a finite number')
    }
    return Math.max(100, Math.min(3000, Math.round(duration)))
}

function clampToneAmplitude(value: unknown): number {
    const amplitude = typeof value === 'number' ? value : Number(value ?? 6000)
    if (!Number.isFinite(amplitude)) {
        throw new Error('amplitude must be a finite number')
    }
    return Math.max(500, Math.min(16000, Math.round(amplitude)))
}

function readReminderId(value: unknown): number {
    const id = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(id) || id < 0) {
        throw new Error('id must be a non-negative integer')
    }
    return id
}


function readFollowupPrompt(body: Record<string, unknown>): string {
    const prompt = body['prompt']
    if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt is required')
    }
    return prompt.trim().slice(0, 12000)
}

async function enqueueFollowupPrompt(prompt: string): Promise<void> {
    if (!activeSession) {
        throw new Error('No StackChan device is connected')
    }
    await activeSession.enqueueFollowup(prompt)
}

async function callStackChanTool(name: StackChanToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!activeSession) {
        throw new Error('No StackChan device is connected')
    }

    if (name === 'stackchan_display_image') {
        const source = readImageSource(args)
        if (!source) throw new Error('stackchan_display_image requires source, url, path, or image')

        const url = resolveDisplayImageSource(source)
        if (!url) throw new Error(`Unsupported image source for StackChan display: ${source}`)

        return await activeSession.callRobotTool(TOOL_MAP[name], {
            url,
            duration_seconds: clampDurationSeconds(args['duration_seconds']),
        })
    }

    if (name === 'stackchan_create_reminder') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            duration_seconds: clampReminderDurationSeconds(args['duration_seconds']),
            message: readReminderMessage(args['message']),
            repeat: readReminderRepeat(args['repeat']),
        })
    }

    if (name === 'stackchan_set_speaker_volume') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            volume: clampSpeakerVolume(args['volume']),
            permanent: readReminderRepeat(args['permanent']),
        })
    }

    if (name === 'stackchan_play_test_tone') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            frequency_hz: clampToneFrequency(args['frequency_hz']),
            duration_ms: clampToneDurationMs(args['duration_ms']),
            amplitude: clampToneAmplitude(args['amplitude']),
        })
    }

    if (name === 'stackchan_stop_reminder') {
        return await activeSession.callRobotTool(TOOL_MAP[name], {
            id: readReminderId(args['id']),
        })
    }

    return await activeSession.callRobotTool(TOOL_MAP[name], args)
}

export function registerDeviceSession(session: StackChanDeviceSession): () => void {
    activeSession = session
    return () => {
        if (activeSession === session) activeSession = null
    }
}

export function startDeviceControlServer(port: number, host = '127.0.0.1'): void {
    if (serverStarted) return
    serverStarted = true

    const server = http.createServer(async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        if (req.method === 'GET' && pathname === '/internal/status') {
            sendJson(res, 200, {
                success: true,
                result: activeSession?.getBridgeStatus() ?? {
                    connected: false,
                    readyForPrompt: false,
                    reason: 'no_device_session',
                },
            })
            return
        }

        if (req.method !== 'POST' || (pathname !== '/tools/call' && pathname !== '/internal/followup')) {
            sendJson(res, 404, { success: false, error: 'not found' })
            return
        }

        try {
            const body = await readBody(req)
            if (!isRecord(body)) {
                sendJson(res, 400, { success: false, error: 'request body must be an object' })
                return
            }
            if (!activeSession) {
                sendJson(res, 503, { success: false, error: 'No StackChan device is connected' })
                return
            }

            if (pathname === '/internal/followup') {
                await enqueueFollowupPrompt(readFollowupPrompt(body))
                sendJson(res, 202, { success: true, result: { queued: true } })
                return
            }

            if (!isToolName(body['name'])) {
                sendJson(res, 400, { success: false, error: 'unknown StackChan tool' })
                return
            }

            const args = isRecord(body['args']) ? body['args'] : {}
            const result = normalizeFirmwareResult(await callStackChanTool(body['name'], args))
            sendJson(res, 200, { success: true, result })
        } catch (error) {
            sendJson(res, 500, {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    })

    server.listen(port, host, () => {
        console.log(`[control] StackChan robot control listening on http://${host}:${port}`)
    })
}
