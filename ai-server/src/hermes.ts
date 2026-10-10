import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import path from 'path'
import { existsSync } from 'fs'
import WebSocket from 'ws'
import { ChildrenHttpHermesClient } from './children_hermes'

type JsonRpcId = number
type HermesEvent = {
    type: string
    session_id?: string
    text?: string
    payload?: unknown
    [key: string]: unknown
}
type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
}
type EventListener = (event: HermesEvent) => void
type CloseListener = (error: Error) => void

export type HermesPromptStreamEvent =
    | { type: 'delta'; text: string }
    | { type: 'complete'; text?: string }

// deadline is an absolute Unix timestamp in milliseconds, shared with STT/TTS.
// Existing one-argument callers retain the configured Hermes turn timeout.
export type HermesTurnOptions = {
    signal?: AbortSignal
    deadline?: number
}

export type HermesTransport = {
    start(onLine: (line: string) => void, onClose: (error: Error) => void, options?: HermesTurnOptions): Promise<void>
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
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error('Hermes operation failed')
}

function turnTimeout(): number {
    const value = Number(process.env.HERMES_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS)
    return Number.isSafeInteger(value) && value > 0 && value <= 3_600_000 ? value : DEFAULT_TURN_TIMEOUT_MS
}

// A timer is installed BEFORE any await, including transport/session creation.
// wait() also bounds dependencies which ignore AbortSignal, absorbing late rejection.
class OperationScope {
    readonly controller = new AbortController()
    readonly deadline: number
    private timer?: ReturnType<typeof setTimeout>
    private readonly externalAbort?: () => void

    constructor(options: HermesTurnOptions, timeoutMs: number, private readonly timeoutMessage: string) {
        if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
            throw new Error('Invalid Hermes deadline')
        }
        this.deadline = Math.min(Date.now() + timeoutMs, options.deadline ?? Infinity)
        if (options.signal) {
            this.externalAbort = () => this.abort(new Error('Hermes prompt cancelled'))
            options.signal.addEventListener('abort', this.externalAbort, { once: true })
        }
        this.externalSignal = options.signal
        if (options.signal?.aborted) this.externalAbort?.()
        else if (this.deadline <= Date.now()) this.abort(new Error(timeoutMessage))
        else {
            const expire = () => {
                const remaining = this.deadline - Date.now()
                // Timer clocks/rounding can fire slightly before Date.now's
                // absolute deadline. Never expire the work early.
                if (remaining > 0) this.timer = setTimeout(expire, remaining)
                else this.abort(this.deadlineError)
            }
            this.timer = setTimeout(expire, this.deadline - Date.now())
        }
    }

    private readonly externalSignal?: AbortSignal
    get signal(): AbortSignal { return this.controller.signal }
    get error(): Error { return asError(this.signal.reason) }
    get deadlineError(): Error { return new Error(this.timeoutMessage) }
    abort(error: Error): void {
        if (!this.signal.aborted) this.controller.abort(Date.now() >= this.deadline ? this.deadlineError : error)
    }
    check(): void {
        if (!this.signal.aborted && Date.now() >= this.deadline) this.abort(new Error(this.timeoutMessage))
        if (this.signal.aborted) throw this.error
    }

    async wait<T>(task: Promise<T>): Promise<T> {
        if (!this.signal.aborted && Date.now() >= this.deadline) this.abort(new Error(this.timeoutMessage))
        if (this.signal.aborted) {
            void task.catch(() => undefined)
            throw this.error
        }
        return await new Promise<T>((resolve, reject) => {
            const onAbort = () => { cleanup(); reject(this.error) }
            const cleanup = () => this.signal.removeEventListener('abort', onAbort)
            this.signal.addEventListener('abort', onAbort, { once: true })
            task.then(
                (value) => {
                    cleanup()
                    try { this.check(); resolve(value) } catch (error) { reject(error) }
                },
                (error) => { cleanup(); reject(error) },
            )
            // The task's handlers stay attached even if the abort wins the race.
            if (this.signal.aborted) onAbort()
        })
    }

    dispose(): void {
        clearTimeout(this.timer)
        if (this.externalAbort) this.externalSignal?.removeEventListener('abort', this.externalAbort)
    }
}

function eventFromEnvelope(value: Record<string, unknown>): HermesEvent | null {
    const event = value['method'] === 'event' ? value['params'] : value
    if (!isRecord(event) || typeof event['type'] !== 'string' || !event['type']) return null
    if (event['session_id'] !== undefined && typeof event['session_id'] !== 'string') return null
    if (event['text'] !== undefined && typeof event['text'] !== 'string') return null
    if (isRecord(event['payload']) && event['payload']['text'] !== undefined && typeof event['payload']['text'] !== 'string') return null
    if (['message.delta', 'message.complete'].includes(event['type']) && !event['session_id']) return null
    if (event['type'] === 'message.delta' && typeof event['text'] !== 'string'
        && (!isRecord(event['payload']) || typeof event['payload']['text'] !== 'string')) return null
    return event as HermesEvent
}

function errorFromJsonRpc(error: unknown): Error {
    // Backend messages can embed provider URLs/tokens or the full prompt.
    const code = isRecord(error) && Number.isSafeInteger(error['code']) ? ` (code=${error['code']})` : ''
    return new Error(`Hermes RPC request failed${code}`)
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
    } catch { return false }
}

export function assertLocalDashboardUrlAllowed(dashboardUrl: string): void {
    if (!isTruthyEnv(process.env.STACKCHAN_LOCAL_ONLY) || isLocalDashboardUrl(dashboardUrl)) return
    throw new Error('STACKCHAN_LOCAL_ONLY=true requires HERMES_DASHBOARD_URL to use localhost, 127.0.0.1, ::1, or host.docker.internal')
}

export function extractDashboardSessionToken(html: string): string | null {
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*(['"])(.*?)\1/)
    return match?.[2] ?? null
}

class StdioHermesTransport implements HermesTransport {
    private process?: ChildProcessWithoutNullStreams
    private startup?: Promise<void>
    private startupScope?: OperationScope

    async start(onLine: (line: string) => void, onClose: (error: Error) => void, options: HermesTurnOptions = {}): Promise<void> {
        if (this.startup) return await this.startup
        if (this.process && this.process.exitCode === null && this.process.signalCode === null && !this.process.killed) return
        const scope = new OperationScope(options, DEFAULT_RPC_TIMEOUT_MS, 'Hermes gateway startup timed out')
        this.startupScope = scope
        const task = (async () => {
            scope.check()
            const hermesRoot = defaultHermesRoot()
            const child = spawn(process.env.HERMES_PYTHON ?? 'python3', ['-m', 'tui_gateway.entry'], {
                cwd: hermesRoot,
                env: { ...process.env, PYTHONPATH: [hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            this.process = child
            const stdout = createInterface({ input: child.stdout })
            stdout.on('line', (line) => { if (this.process === child) onLine(line) })
            // Gateway stderr can contain transcripts/credentials; never echo it verbatim.
            child.stderr.on('data', () => undefined)
            await new Promise<void>((resolve, reject) => {
                let terminal = false
                let spawned = false
                const finish = (error: Error) => {
                    if (terminal) return
                    terminal = true
                    stdout.close()
                    scope.signal.removeEventListener('abort', onAbort)
                    if (!spawned) reject(error)
                    const current = this.process === child
                    // Retain a still-live child for dispose's kill/reap path.
                    if (current && (child.exitCode !== null || child.signalCode !== null || !child.pid)) this.process = undefined
                    if (child.exitCode === null && child.signalCode === null) child.kill()
                    if (current) onClose(error)
                }
                const onAbort = () => finish(scope.error)
                scope.signal.addEventListener('abort', onAbort, { once: true })
                child.once('spawn', () => { if (!terminal) { spawned = true; resolve() } })
                child.on('error', (error: NodeJS.ErrnoException) => finish(new Error(`Hermes gateway failed to start (${error.code ?? 'spawn error'})`)))
                child.stdin.on('error', () => finish(new Error('Hermes gateway stdin failed')))
                child.stdout.on('error', () => finish(new Error('Hermes gateway stdout failed')))
                stdout.on('error', () => finish(new Error('Hermes gateway stdout failed')))
                child.stderr.on('error', () => finish(new Error('Hermes gateway stderr failed')))
                child.on('exit', (code, signal) => finish(new Error(`Hermes gateway exited code=${code} signal=${signal}`)))
                child.on('close', () => finish(new Error('Hermes gateway closed')))
                if (scope.signal.aborted) onAbort()
            })
        })()
        this.startup = task
        try { await task } finally {
            scope.dispose()
            if (this.startup === task) this.startup = undefined
            if (this.startupScope === scope) this.startupScope = undefined
        }
    }

    async sendLine(line: string): Promise<void> {
        const child = this.process
        if (!child || child.killed || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
            throw new Error('Hermes stdio gateway is not running')
        }
        await new Promise<void>((resolve, reject) => {
            child.stdin.write(`${line}\n`, (error) => {
                if (error) reject(new Error('Hermes gateway stdin write failed'))
                else resolve()
            })
        })
    }

    async dispose(): Promise<void> {
        const child = this.process
        this.process = undefined
        this.startupScope?.abort(new Error('Hermes gateway disposed'))
        if (!child || child.exitCode !== null || child.signalCode !== null) return
        await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(escalate); clearTimeout(limit); child.removeListener('close', finish); resolve() }
            const escalate = setTimeout(() => child.kill('SIGKILL'), 250)
            const limit = setTimeout(finish, 1_000)
            child.once('close', finish)
            child.kill()
        })
    }
}

class DashboardWsTransport implements HermesTransport {
    private socket?: WebSocket
    private startup?: Promise<void>
    private startupScope?: OperationScope

    constructor(
        private readonly dashboardUrl = process.env.HERMES_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
        private readonly explicitToken = process.env.HERMES_DASHBOARD_TOKEN,
    ) {}

    async start(onLine: (line: string) => void, onClose: (error: Error) => void, options: HermesTurnOptions = {}): Promise<void> {
        if (this.startup) return await this.startup
        if (this.socket?.readyState === WebSocket.OPEN) return
        const scope = new OperationScope(options, DEFAULT_RPC_TIMEOUT_MS, 'Hermes Dashboard connection timed out')
        this.startupScope = scope
        const task = (async () => {
            scope.check()
            assertLocalDashboardUrlAllowed(this.dashboardUrl)
            const token = this.explicitToken ?? await this.fetchSessionToken(scope)
            scope.check()
            await new Promise<void>((resolve, reject) => {
                let opened = false
                let terminal = false
                const socket = new WebSocket(dashboardWebSocketUrl(this.dashboardUrl, token))
                this.socket = socket
                const fail = (error: Error) => {
                    if (terminal) return
                    terminal = true
                    scope.signal.removeEventListener('abort', onAbort)
                    if (!opened) reject(error)
                    if (this.socket !== socket) return
                    this.socket = undefined
                    socket.terminate()
                    onClose(error)
                }
                const onAbort = () => fail(scope.error)
                scope.signal.addEventListener('abort', onAbort, { once: true })
                socket.on('open', () => {
                    if (terminal || this.socket !== socket) return
                    opened = true
                    scope.signal.removeEventListener('abort', onAbort)
                    resolve()
                })
                socket.on('message', (data) => {
                    if (terminal || this.socket !== socket) return
                    for (const line of data.toString('utf8').split(/\r?\n/)) {
                        if (line.trim()) onLine(line)
                    }
                })
                // ws errors/close reasons may embed the token-bearing URL.
                socket.on('error', () => fail(new Error('Hermes Dashboard WebSocket failed')))
                socket.on('close', (code) => fail(new Error(code === 4403
                    ? 'Hermes Dashboard /api/ws rejected the connection. Start Hermes with dashboard --tui so /api/ws is enabled.'
                    : `Hermes Dashboard WebSocket closed code=${code}`)))
                if (scope.signal.aborted) onAbort()
            })
        })()
        this.startup = task
        try { await task } finally {
            scope.dispose()
            if (this.startup === task) this.startup = undefined
            if (this.startupScope === scope) this.startupScope = undefined
        }
    }

    async sendLine(line: string): Promise<void> {
        const socket = this.socket
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Hermes Dashboard WebSocket is not connected')
        await new Promise<void>((resolve, reject) => {
            socket.send(`${line}\n`, (error) => {
                if (error) reject(new Error('Hermes Dashboard WebSocket send failed'))
                else resolve()
            })
        })
    }

    async dispose(): Promise<void> {
        const socket = this.socket
        this.socket = undefined
        this.startupScope?.abort(new Error('Hermes Dashboard connection disposed'))
        if (!socket || socket.readyState === WebSocket.CLOSED) return
        await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(limit); socket.removeListener('close', finish); resolve() }
            const limit = setTimeout(finish, 500)
            socket.once('close', finish)
            // A graceful close can hang during the handshake or with an unresponsive peer.
            socket.terminate()
        })
    }

    private async fetchSessionToken(scope: OperationScope): Promise<string> {
        assertLocalDashboardUrlAllowed(this.dashboardUrl)
        let response: Response
        try { response = await scope.wait(fetch(this.dashboardUrl, { signal: scope.signal })) }
        catch { scope.check(); throw new Error('Failed to fetch Hermes Dashboard HTML') }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error(`Failed to fetch Hermes Dashboard HTML: HTTP ${response.status}`)
        }
        let html: string
        try { html = await scope.wait(response.text()) }
        catch { scope.check(); throw new Error('Failed to read Hermes Dashboard HTML') }
        const token = extractDashboardSessionToken(html)
        if (!token) throw new Error('Hermes Dashboard HTML did not contain window.__HERMES_SESSION_TOKEN__. Start Hermes with dashboard --tui or set HERMES_DASHBOARD_TOKEN.')
        return token
    }
}

type RpcTurn = { scope: OperationScope; generation: number; sessionId?: string; cancel?: (error: Error) => void }

// Exported for dependency-injected runtime tests; public transport clients below
// preserve their constructors and existing method signatures.
export class RpcHermesClient {
    private nextId = 1
    private sessionId?: string
    private sessionTask?: Promise<string>
    private started = false
    private startupTask?: Promise<void>
    private transportController?: AbortController
    private retirementTask?: Promise<void>
    private generation = 0
    private disposed = false
    private disposeTask?: Promise<void>
    private active?: RpcTurn
    private readonly pending = new Map<JsonRpcId, PendingRequest>()
    private readonly listeners = new Set<EventListener>()
    private readonly closeListeners = new Set<CloseListener>()

    constructor(private readonly transport: HermesTransport) {}

    async submitPrompt(prompt: string, options: HermesTurnOptions = {}): Promise<string> {
        let text = ''
        for await (const event of this.streamPrompt(prompt, options)) {
            if (event.type === 'delta') text += event.text
            else if (event.text !== undefined) text = event.text
        }
        return text
    }

    async *streamPrompt(prompt: string, options: HermesTurnOptions = {}): AsyncGenerator<HermesPromptStreamEvent> {
        if (this.disposed) throw new Error('Hermes client disposed')
        if (this.active) throw new Error('Hermes turn already active')
        const timeoutMs = turnTimeout()
        const scope = new OperationScope(options, timeoutMs, `Hermes prompt timed out after ${timeoutMs}ms`)
        const turn: RpcTurn = { scope, generation: this.generation }
        this.active = turn
        const queue: HermesPromptStreamEvent[] = []
        let done = false
        let failure: Error | undefined
        let wake: (() => void) | undefined
        const notify = () => { wake?.(); wake = undefined }
        const cleanup = () => {
            scope.dispose()
            scope.signal.removeEventListener('abort', onAbort)
            this.listeners.delete(onEvent)
            this.closeListeners.delete(onClose)
        }
        const fail = (error: Error) => {
            // A completed producer can still have queued events while its
            // consumer awaits TTS. Interruption must discard those too.
            if (failure) return
            // A nested setup/RPC timer shares this absolute deadline and may
            // win the callback race. Report the turn's deadline, not a misleading
            // 30s RPC timeout when the entire turn actually had only 40ms.
            if (!scope.signal.aborted && Date.now() >= scope.deadline) error = scope.deadlineError
            done = true
            failure = error
            queue.length = 0
            cleanup()
            scope.abort(error) // also wake setup/RPC waits, not only the event loop
            if (this.active === turn) this.active = undefined
            // No guaranteed turn ID in this protocol: ACK alone cannot prove
            // the old producer ended. Quarantine its connection AND session.
            if (turn.generation === this.generation && !this.disposed) this.retire(error)
            notify()
        }
        const onAbort = () => fail(scope.error)
        const onClose: CloseListener = (error) => scope.abort(error)
        const onEvent: EventListener = (event) => {
            if (done || event.session_id !== turn.sessionId || turn.generation !== this.generation) return
            try { scope.check() } catch { return } // check() wakes/quarantines an expired turn
            const text = eventText(event)
            if (event.type === 'message.delta' && text !== null) {
                queue.push({ type: 'delta', text })
                notify()
            } else if (event.type === 'message.complete') {
                done = true
                queue.push({ type: 'complete', text: text ?? undefined })
                cleanup()
                // Completion may race the prompt.submit response; stop that
                // RPC's timer so it cannot later invalidate a successful turn.
                scope.abort(new Error('Hermes turn completed'))
                notify()
            }
        }
        turn.cancel = fail
        const onExternalAbort = () => fail(new Error('Hermes prompt interrupted'))
        options.signal?.addEventListener('abort', onExternalAbort, { once: true })
        scope.signal.addEventListener('abort', onAbort, { once: true })
        this.closeListeners.add(onClose)
        try {
            scope.check()
            turn.sessionId = await scope.wait(this.ensureSession({ signal: scope.signal, deadline: scope.deadline }))
            scope.check()
            this.listeners.add(onEvent)
            void this.request('prompt.submit', { session_id: turn.sessionId, text: prompt }, DEFAULT_RPC_TIMEOUT_MS,
                { signal: scope.signal, deadline: scope.deadline }, false).catch((error) => {
                if (!done) scope.abort(asError(error))
            })
            while (!done || queue.length) {
                if (failure) throw failure
                if (queue.length) { yield queue.shift() as HermesPromptStreamEvent; continue }
                await new Promise<void>((resolve) => { wake = resolve })
            }
            if (failure) throw failure
        } catch (error) {
            if (!done) scope.abort(asError(error))
            throw failure ?? asError(error)
        } finally {
            // Consumer break/return also quarantines an unfinished producer.
            if (!done) scope.abort(new Error('Hermes prompt cancelled'))
            options.signal?.removeEventListener('abort', onExternalAbort)
            cleanup()
            if (this.active === turn) this.active = undefined
        }
    }

    async interrupt(): Promise<void> {
        const turn = this.active
        const sessionId = this.sessionId
        if (turn) {
            // Send best-effort cancellation before retiring the old transport.
            // Local wake never depends on a backend ACK or another stream event.
            if (sessionId && this.started) {
                const line = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'session.interrupt', params: { session_id: sessionId } })
                void this.transport.sendLine(line).catch(() => undefined)
            }
            const error = new Error('Hermes prompt interrupted')
            turn.scope.abort(error)
            turn.cancel?.(error) // scope may already have been aborted on completion
            await this.retirementTask
            return
        }
        if (!sessionId || this.disposed) return
        // A completed LLM turn may still own bridge-side TTS. Quarantine now,
        // not after an ACK: a queued next turn must never enter this old session.
        if (this.started) {
            const line = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'session.interrupt', params: { session_id: sessionId } })
            void this.transport.sendLine(line).catch(() => undefined)
        }
        this.retire(new Error('Hermes session interrupted'))
        await this.retirementTask
    }

    async dispose(): Promise<void> {
        if (this.disposeTask) return await this.disposeTask
        this.disposed = true
        this.retire(new Error('Hermes client disposed'))
        this.disposeTask = this.retirementTask ?? Promise.resolve()
        await this.disposeTask
    }

    private async ensureSession(options: HermesTurnOptions = {}): Promise<string> {
        if (this.disposed) throw new Error('Hermes client disposed')
        if (this.sessionId) return this.sessionId
        if (this.sessionTask) return await this.sessionTask
        const generation = this.generation
        const task = (async () => {
            const result = await this.request('session.create', {}, DEFAULT_RPC_TIMEOUT_MS, options)
            if (generation !== this.generation || this.disposed) throw new Error('Hermes session creation cancelled')
            if (!isRecord(result) || typeof result['session_id'] !== 'string' || !result['session_id']) {
                throw new Error('Hermes session.create returned no session_id')
            }
            this.sessionId = result['session_id']
            return this.sessionId
        })()
        this.sessionTask = task
        try { return await task } finally { if (this.sessionTask === task) this.sessionTask = undefined }
    }

    private async request(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
        options: HermesTurnOptions = {}, resetOnFailure = true): Promise<unknown> {
        const scope = new OperationScope(options, timeoutMs, `Hermes RPC ${method} timed out after ${timeoutMs}ms`)
        const generation = this.generation
        let id: number | undefined
        try {
            scope.check()
            await scope.wait(this.ensureTransport(scope))
            scope.check()
            if (generation !== this.generation) throw new Error('Hermes connection changed')
            id = this.nextId++
            const response = new Promise<unknown>((resolve, reject) => this.pending.set(id as number, { resolve, reject }))
            // Observe the response before sendLine, which can fail synchronously
            // or wait forever while responses/transport failures arrive.
            const result = scope.wait(response)
            void Promise.resolve().then(() => {
                scope.check()
                if (generation !== this.generation || this.disposed) throw new Error('Hermes connection changed')
                return this.transport.sendLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
            }).catch((error) => this.pending.get(id as number)?.reject(error))
            return await result
        } catch (error) {
            if (resetOnFailure && generation === this.generation && !this.disposed) this.retire(asError(error))
            throw error
        } finally {
            if (id !== undefined) this.pending.delete(id)
            scope.dispose()
        }
    }

    private async ensureTransport(scope: OperationScope): Promise<void> {
        if (this.disposed) throw new Error('Hermes client disposed')
        if (this.retirementTask) await scope.wait(this.retirementTask)
        scope.check()
        if (this.disposed) throw new Error('Hermes client disposed')
        if (this.started) return
        if (this.startupTask) return await scope.wait(this.startupTask)
        const generation = this.generation
        const controller = new AbortController()
        this.transportController = controller
        const task = Promise.resolve().then(() => {
            scope.check()
            if (generation !== this.generation) throw new Error('Hermes connection startup cancelled')
            return this.transport.start(
                (line) => { if (generation === this.generation && !this.disposed) this.handleLine(line) },
                (error) => { if (generation === this.generation && !this.disposed) this.retire(error) },
                { signal: controller.signal, deadline: scope.deadline },
            )
        }).then(() => {
            if (generation !== this.generation || this.disposed || controller.signal.aborted) throw new Error('Hermes connection ended during startup')
            this.started = true
        })
        this.startupTask = task
        try { await scope.wait(task) } finally { if (this.startupTask === task) this.startupTask = undefined }
    }

    private retire(error: Error): void {
        this.generation++
        this.started = false
        this.sessionId = undefined
        this.sessionTask = undefined
        this.startupTask = undefined
        this.transportController?.abort(error)
        this.transportController = undefined
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.active?.cancel?.(error) // generation already advanced; cannot recursively retire
        for (const listener of [...this.closeListeners]) listener(error)
        // Do not overlap old dispose with the next start on this transport.
        const previous = this.retirementTask
        const task = (async () => {
            await previous
            await this.transport.dispose()
        })().catch(() => { console.error('[hermes] transport cleanup failed') })
        this.retirementTask = task
        void task.then(() => { if (this.retirementTask === task) this.retirementTask = undefined })
    }

    private handleLine(line: string): void {
        if (!line.trim()) return
        let parsed: unknown
        try { parsed = JSON.parse(line) }
        catch { this.protocolFailure(); return }
        if (!isRecord(parsed) || (parsed['jsonrpc'] !== undefined && parsed['jsonrpc'] !== '2.0')) {
            this.protocolFailure(); return
        }
        if (Object.hasOwn(parsed, 'id')) {
            const id = parsed['id']
            const hasResult = Object.hasOwn(parsed, 'result')
            const hasError = Object.hasOwn(parsed, 'error')
            if (typeof id !== 'number' || !Number.isSafeInteger(id) || hasResult === hasError
                || (hasError && (!isRecord(parsed['error']) || typeof parsed['error']['message'] !== 'string'))) {
                this.protocolFailure(); return
            }
            const pending = this.pending.get(id)
            if (!pending) return // late replies to already retired/cancelled requests
            this.pending.delete(id)
            if (hasError) pending.reject(errorFromJsonRpc(parsed['error']))
            else pending.resolve(parsed['result'])
            return
        }
        if (Object.hasOwn(parsed, 'method') && parsed['method'] !== 'event') {
            if (typeof parsed['method'] !== 'string' || !parsed['method']
                || (parsed['params'] !== undefined && !isRecord(parsed['params']) && !Array.isArray(parsed['params']))) {
                this.protocolFailure()
            }
            return // Ignore well-formed notifications for extensions we do not consume.
        }
        const event = eventFromEnvelope(parsed)
        if (!event) { this.protocolFailure(); return }
        for (const listener of [...this.listeners]) listener(event)
    }

    private protocolFailure(): void {
        // Never include the raw JSON/body; it can contain a token or transcript.
        this.retire(new Error('Malformed Hermes RPC message; connection reset'))
    }
}

export class StdioHermesClient extends RpcHermesClient {
    constructor() { super(new StdioHermesTransport()) }
}

export class DashboardWsHermesClient extends RpcHermesClient {
    constructor(dashboardUrl?: string, token?: string) { super(new DashboardWsTransport(dashboardUrl, token)) }
}

export class HermesClient {
    private readonly client: RpcHermesClient | ChildrenHttpHermesClient

    constructor() {
        const mode = process.env.HERMES_CONNECT_MODE ?? 'stdio'
        if (mode === 'children_http') this.client = new ChildrenHttpHermesClient()
        else if (mode === 'dashboard_ws') this.client = new DashboardWsHermesClient()
        else if (mode === 'stdio') this.client = new StdioHermesClient()
        else throw new Error('Invalid HERMES_CONNECT_MODE; refusing transport fallback')
    }

    async submitPrompt(prompt: string, options: HermesTurnOptions = {}): Promise<string> {
        return await this.client.submitPrompt(prompt, options)
    }

    async *streamPrompt(prompt: string, options: HermesTurnOptions = {}): AsyncGenerator<HermesPromptStreamEvent> {
        yield* this.client.streamPrompt(prompt, options)
    }

    async interrupt(): Promise<void> { await this.client.interrupt() }
    async dispose(): Promise<void> { await this.client.dispose() }
}
