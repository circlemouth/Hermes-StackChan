import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import path from 'path'
import { existsSync } from 'fs'
import WebSocket from 'ws'

type JsonRpcId = number

type JsonRpcResponse = {
    jsonrpc?: string
    id?: JsonRpcId
    result?: unknown
    error?: unknown
}

type HermesEvent = {
    type?: string
    session_id?: string
    text?: string
    payload?: unknown
    [key: string]: unknown
}

type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

type EventListener = (event: HermesEvent) => void
type CloseListener = (error: Error) => void

type HermesTransport = {
    start(onLine: (line: string) => void, onClose: (error: Error) => void): Promise<void>
    sendLine(line: string): Promise<void>
    dispose(): Promise<void>
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const DEFAULT_TURN_TIMEOUT_MS = 600_000
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:9119'
const LOCAL_DASHBOARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

function defaultHermesRoot(): string {
    if (process.env.HERMES_ROOT) return process.env.HERMES_ROOT
    const fromAiServer = path.resolve(process.cwd(), '..', 'hermes-agent')
    if (existsSync(path.join(fromAiServer, 'tui_gateway', 'entry.py'))) return fromAiServer
    return path.resolve(process.cwd(), 'hermes-agent')
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function eventFromEnvelope(value: unknown): HermesEvent | null {
    if (!isRecord(value)) return null
    if (value['method'] === 'event' && isRecord(value['params'])) {
        return value['params'] as HermesEvent
    }
    if (typeof value['type'] === 'string') {
        return value as HermesEvent
    }
    return null
}

function errorFromJsonRpc(error: unknown): Error {
    if (isRecord(error) && typeof error['message'] === 'string') {
        return new Error(error['message'])
    }
    return new Error(JSON.stringify(error))
}

function eventText(event: HermesEvent): string | null {
    if (typeof event.text === 'string') return event.text
    if (isRecord(event.payload) && typeof event.payload['text'] === 'string') return event.payload['text']
    return null
}

function dashboardWebSocketUrl(dashboardUrl: string, token: string): string {
    const url = new URL(dashboardUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/api/ws'
    url.search = ''
    url.searchParams.set('token', token)
    return url.toString()
}

function isTruthyEnv(value: string | undefined): boolean {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

export function isLocalDashboardUrl(dashboardUrl: string): boolean {
    try {
        const url = new URL(dashboardUrl)
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        return LOCAL_DASHBOARD_HOSTS.has(hostname)
    } catch {
        return false
    }
}

export function assertLocalDashboardUrlAllowed(dashboardUrl: string): void {
    if (!isTruthyEnv(process.env.STACKCHAN_LOCAL_ONLY)) return
    if (isLocalDashboardUrl(dashboardUrl)) return
    throw new Error(
        `STACKCHAN_LOCAL_ONLY=true requires HERMES_DASHBOARD_URL to use localhost, 127.0.0.1, ::1, or host.docker.internal; got ${dashboardUrl}`,
    )
}

export function extractDashboardSessionToken(html: string): string | null {
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*(['"])(.*?)\1/)
    return match?.[2] ?? null
}

class StdioHermesTransport implements HermesTransport {
    private process?: ChildProcessWithoutNullStreams

    async start(onLine: (line: string) => void, onClose: (error: Error) => void): Promise<void> {
        if (this.process && !this.process.killed) return

        const hermesRoot = defaultHermesRoot()
        const python = process.env.HERMES_PYTHON ?? 'python3'
        const env = {
            ...process.env,
            PYTHONPATH: [hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        }

        this.process = spawn(python, ['-m', 'tui_gateway.entry'], {
            cwd: hermesRoot,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        const stdout = createInterface({ input: this.process.stdout })
        stdout.on('line', onLine)

        this.process.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim()
            if (text) console.error(`[hermes] ${text}`)
        })

        this.process.on('exit', (code, signal) => {
            console.error(`[hermes] gateway exited code=${code} signal=${signal}`)
            this.process = undefined
            onClose(new Error('Hermes gateway exited'))
        })
    }

    async sendLine(line: string): Promise<void> {
        if (!this.process || this.process.killed) {
            throw new Error('Hermes stdio gateway is not running')
        }
        await new Promise<void>((resolve, reject) => {
            this.process?.stdin.write(`${line}\n`, (error) => {
                if (error) reject(error)
                else resolve()
            })
        })
    }

    async dispose(): Promise<void> {
        this.process?.kill()
        this.process = undefined
    }
}

class DashboardWsTransport implements HermesTransport {
    private socket?: WebSocket

    constructor(
        private readonly dashboardUrl = process.env.HERMES_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
        private readonly explicitToken = process.env.HERMES_DASHBOARD_TOKEN,
    ) {}

    async start(onLine: (line: string) => void, onClose: (error: Error) => void): Promise<void> {
        if (this.socket?.readyState === WebSocket.OPEN) return

        assertLocalDashboardUrlAllowed(this.dashboardUrl)
        const token = this.explicitToken ?? await this.fetchSessionToken()
        const wsUrl = dashboardWebSocketUrl(this.dashboardUrl, token)

        await new Promise<void>((resolve, reject) => {
            let opened = false
            const socket = new WebSocket(wsUrl)
            this.socket = socket

            socket.on('open', () => {
                opened = true
                resolve()
            })
            socket.on('message', (data) => {
                const text = data.toString('utf8')
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim()) onLine(line)
                }
            })
            socket.on('error', (error) => {
                if (!opened) reject(error)
                else onClose(error instanceof Error ? error : new Error(String(error)))
            })
            socket.on('close', (code, reason) => {
                this.socket = undefined
                const message = code === 4403
                    ? 'Hermes Dashboard /api/ws rejected the connection. Start Hermes with dashboard --tui so /api/ws is enabled.'
                    : `Hermes Dashboard WebSocket closed code=${code} reason=${reason.toString('utf8')}`
                const error = new Error(message)
                if (!opened) reject(error)
                else onClose(error)
            })
        })
    }

    async sendLine(line: string): Promise<void> {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('Hermes Dashboard WebSocket is not connected')
        }
        await new Promise<void>((resolve, reject) => {
            this.socket?.send(`${line}\n`, (error) => {
                if (error) reject(error)
                else resolve()
            })
        })
    }

    async dispose(): Promise<void> {
        const socket = this.socket
        this.socket = undefined
        if (!socket || socket.readyState === WebSocket.CLOSED) return
        await new Promise<void>((resolve) => {
            socket.once('close', () => resolve())
            socket.close()
        })
    }

    private async fetchSessionToken(): Promise<string> {
        assertLocalDashboardUrlAllowed(this.dashboardUrl)
        let response: Response
        try {
            response = await fetch(this.dashboardUrl)
        } catch (error) {
            throw new Error(`Failed to fetch Hermes Dashboard HTML from ${this.dashboardUrl}: ${String(error)}`)
        }
        if (!response.ok) {
            throw new Error(`Failed to fetch Hermes Dashboard HTML from ${this.dashboardUrl}: HTTP ${response.status}`)
        }
        const html = await response.text()
        const token = extractDashboardSessionToken(html)
        if (!token) {
            throw new Error('Hermes Dashboard HTML did not contain window.__HERMES_SESSION_TOKEN__. Start Hermes with dashboard --tui or set HERMES_DASHBOARD_TOKEN.')
        }
        return token
    }
}

class RpcHermesClient {
    private nextId = 1
    private sessionId?: string
    private started = false
    private disposed = false
    private readonly pending = new Map<JsonRpcId, PendingRequest>()
    private readonly listeners = new Set<EventListener>()
    private readonly closeListeners = new Set<CloseListener>()

    constructor(private readonly transport: HermesTransport) {}

    async submitPrompt(prompt: string): Promise<string> {
        const sessionId = await this.ensureSession()
        const turnTimeoutMs = Number(process.env.HERMES_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS)

        return await new Promise<string>((resolve, reject) => {
            let complete = false
            const fragments: string[] = []
            const timer = setTimeout(() => {
                cleanup()
                reject(new Error(`Hermes prompt timed out after ${turnTimeoutMs}ms`))
            }, turnTimeoutMs)

            const cleanup = () => {
                clearTimeout(timer)
                this.listeners.delete(onEvent)
                this.closeListeners.delete(onClose)
            }

            const onClose: CloseListener = (error) => {
                cleanup()
                reject(error)
            }

            const onEvent: EventListener = (event) => {
                const text = eventText(event)
                if (event.type === 'message.delta' && text !== null) {
                    if (event.session_id !== sessionId) return
                    fragments.push(text)
                }
                if (event.type === 'message.complete') {
                    if (event.session_id !== sessionId) return
                    complete = true
                    cleanup()
                    resolve(text ?? fragments.join(''))
                }
            }

            this.listeners.add(onEvent)
            this.closeListeners.add(onClose)
            this.request('prompt.submit', { session_id: sessionId, text: prompt })
                .then(() => {
                    if (!complete) return
                })
                .catch((error) => {
                    cleanup()
                    reject(error)
                })
        })
    }

    async interrupt(): Promise<void> {
        if (!this.sessionId) return
        await this.request('session.interrupt', { session_id: this.sessionId }).then(() => undefined)
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        const error = new Error('Hermes client disposed')
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.reject(error)
            this.pending.delete(id)
        }
        for (const listener of [...this.closeListeners]) {
            listener(error)
        }
        this.closeListeners.clear()
        this.listeners.clear()
        await this.transport.dispose()
    }

    private async ensureSession(): Promise<string> {
        if (this.sessionId) return this.sessionId
        const result = await this.request('session.create', {})
        if (!isRecord(result) || typeof result['session_id'] !== 'string') {
            throw new Error('Hermes session.create returned no session_id')
        }
        this.sessionId = result['session_id']
        return this.sessionId
    }

    private async request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
        await this.ensureTransport()

        const id = this.nextId++
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

        return await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Hermes RPC ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            this.transport.sendLine(payload).catch((error) => {
                clearTimeout(timer)
                this.pending.delete(id)
                reject(error)
            })
        })
    }

    private async ensureTransport(): Promise<void> {
        if (this.disposed) throw new Error('Hermes client disposed')
        if (this.started) return
        await this.transport.start(
            (line) => this.handleLine(line),
            (error) => this.handleClose(error),
        )
        this.started = true
    }

    private handleClose(error: Error): void {
        if (this.disposed) return
        this.started = false
        this.sessionId = undefined
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.reject(error)
            this.pending.delete(id)
        }
        for (const listener of [...this.closeListeners]) {
            listener(error)
        }
    }

    private handleLine(line: string): void {
        if (!line.trim()) return
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            console.error(`[hermes] non-json message: ${line}`)
            return
        }

        const response = parsed as JsonRpcResponse
        if (typeof response.id === 'number') {
            const pending = this.pending.get(response.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(response.id)
            if (response.error) pending.reject(errorFromJsonRpc(response.error))
            else pending.resolve(response.result)
            return
        }

        const event = eventFromEnvelope(parsed)
        if (!event) return
        for (const listener of [...this.listeners]) {
            listener(event)
        }
    }
}

export class StdioHermesClient extends RpcHermesClient {
    constructor() {
        super(new StdioHermesTransport())
    }
}

export class DashboardWsHermesClient extends RpcHermesClient {
    constructor(dashboardUrl?: string, token?: string) {
        super(new DashboardWsTransport(dashboardUrl, token))
    }
}

export class HermesClient {
    private readonly client: RpcHermesClient

    constructor() {
        this.client = process.env.HERMES_CONNECT_MODE === 'dashboard_ws'
            ? new DashboardWsHermesClient()
            : new StdioHermesClient()
    }

    async submitPrompt(prompt: string): Promise<string> {
        return await this.client.submitPrompt(prompt)
    }

    async interrupt(): Promise<void> {
        await this.client.interrupt()
    }

    async dispose(): Promise<void> {
        await this.client.dispose()
    }
}
