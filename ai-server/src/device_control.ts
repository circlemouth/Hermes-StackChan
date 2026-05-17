import http from 'http'

export type StackChanToolName =
    | 'stackchan_get_head_angles'
    | 'stackchan_set_head_angles'
    | 'stackchan_set_led_color'

export type StackChanDeviceSession = {
    callRobotTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

const TOOL_MAP: Record<StackChanToolName, string> = {
    stackchan_get_head_angles: 'self.robot.get_head_angles',
    stackchan_set_head_angles: 'self.robot.set_head_angles',
    stackchan_set_led_color: 'self.robot.set_led_color',
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
        if (req.method !== 'POST' || req.url !== '/tools/call') {
            sendJson(res, 404, { success: false, error: 'not found' })
            return
        }

        try {
            const body = await readBody(req)
            if (!isRecord(body) || !isToolName(body['name'])) {
                sendJson(res, 400, { success: false, error: 'unknown StackChan tool' })
                return
            }
            if (!activeSession) {
                sendJson(res, 503, { success: false, error: 'No StackChan device is connected' })
                return
            }

            const args = isRecord(body['args']) ? body['args'] : {}
            const result = normalizeFirmwareResult(await activeSession.callRobotTool(TOOL_MAP[body['name']], args))
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
