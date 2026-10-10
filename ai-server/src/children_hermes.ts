import type { HermesPromptStreamEvent } from './hermes'

const DEFAULT_URL = 'http://127.0.0.1:9188'
const MAX_BODY_CHARS = 1_048_576

type RecordValue = Record<string, unknown>
type RequestAuthorization = { cookie?: string; csrf?: string }
type Turn = {
    controller: AbortController
    failure?: Error
    setup?: Promise<string>
    sessionId?: string
    cancellation?: Promise<void>
    timer?: ReturnType<typeof setTimeout>
    deadline: number
}

export type ChildrenOperationOptions = {
    signal?: AbortSignal
    /** Absolute Unix time in milliseconds. */
    deadline?: number
}

export type ChildrenHermesOptions = {
    url?: string
    profileId?: string
    requestTimeoutMs?: number
    turnTimeoutMs?: number
    heartbeatMs?: number
}

// All messages are constants: neither backend error bodies nor fetch/JSON errors
// may escape into the bridge's logs (they can contain credentials or transcripts).
class ChildrenError extends Error {}
function fail(message: string): ChildrenError { return new ChildrenError(message) }
function record(value: unknown): value is RecordValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function operationScope(options: ChildrenOperationOptions, timeoutMs: number) {
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw fail('Invalid children Hermes deadline')
    const controller = new AbortController()
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs)
    const onAbort = () => controller.abort()
    const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()))
    timer.unref()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted || deadline <= Date.now()) onAbort()
    return {
        controller, signal: controller.signal, deadline,
        close: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort) },
    }
}

// An existing single-flight authorization request may have another caller's
// signal. Each waiter still observes its own cancellation/absolute deadline.
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(fail('Children Hermes operation cancelled or timed out')) }
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value) }, (error) => {
            signal.removeEventListener('abort', onAbort); reject(error)
        })
        if (signal.aborted) onAbort()
    })
}

function duration(value: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw fail('Invalid children Hermes timeout configuration')
    }
    return value
}

export function normalizeChildrenHermesUrl(value: string): string {
    // Check the original authority too: URL normalizes octal, hex and shortened
    // IPv4 addresses. No credentials, proxy/Docker hosts, paths or queries.
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/i.test(value)) {
        throw fail('Children Hermes endpoint must be an HTTP loopback origin')
    }
    try {
        const url = new URL(value)
        if (url.port === '0') throw fail('Invalid children Hermes endpoint')
        // Never trust DNS to resolve localhost to loopback.
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
        return url.origin
    } catch {
        throw fail('Invalid children Hermes endpoint')
    }
}

async function readJson(response: Response): Promise<unknown> {
    if (!response.body) throw fail('Invalid children Hermes JSON response')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
            if (text.length > MAX_BODY_CHARS) throw fail('Children Hermes response is too large')
        }
        text += decoder.decode()
        return JSON.parse(text) as unknown
    } catch (error) {
        if (error instanceof ChildrenError) throw error
        throw fail('Invalid children Hermes JSON response')
    } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
    }
}

// Parse SSE incrementally, including split UTF-8, CRLF/CR/LF, comments and
// multiline data fields. Bound both a line and an unfinished event in RAM.
async function* sseEvents(response: Response): AsyncGenerator<{ event: string; data: string }> {
    if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        throw fail('Invalid children Hermes event stream')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    let event = 'message'
    let data: string[] = []
    let dataSize = 0
    try {
        let ended = false
        while (!ended) {
            const chunk = await reader.read()
            ended = chunk.done
            buffer += ended ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
            while (true) {
                const end = buffer.search(/[\r\n]/)
                if (end < 0 || (!ended && end === buffer.length - 1 && buffer[end] === '\r')) break
                const line = buffer.slice(0, end)
                const separatorLength = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1
                buffer = buffer.slice(end + separatorLength)
                if (line.length > MAX_BODY_CHARS) throw fail('Children Hermes event is too large')
                if (line === '') {
                    if (data.length) yield { event, data: data.join('\n') }
                    event = 'message'
                    data = []
                    dataSize = 0
                } else if (!line.startsWith(':')) {
                    const colon = line.indexOf(':')
                    const field = colon < 0 ? line : line.slice(0, colon)
                    let value = colon < 0 ? '' : line.slice(colon + 1)
                    if (value.startsWith(' ')) value = value.slice(1)
                    if (field === 'event') event = value
                    if (field === 'data') {
                        dataSize += value.length + 1
                        if (dataSize > MAX_BODY_CHARS) throw fail('Children Hermes event is too large')
                        data.push(value)
                    }
                }
            }
            if (buffer.length > MAX_BODY_CHARS) throw fail('Children Hermes event is too large')
        }
        // An unterminated event is not a completed SSE event; never treat EOF as done.
    } catch (error) {
        if (error instanceof ChildrenError) throw error
        throw fail('Children Hermes event stream failed')
    } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
    }
}

export class ChildrenHttpHermesClient {
    private readonly url: string
    private readonly profileId: string
    private readonly requestTimeoutMs: number
    private readonly turnTimeoutMs: number
    private readonly heartbeatMs: number
    private cookie?: string
    private csrf?: string
    private sessionId?: string
    private active?: Turn
    private disposed = false
    private disposeTask?: Promise<void>
    private cancelTask?: Promise<void>
    private heartbeatTimer?: ReturnType<typeof setTimeout>
    private heartbeatTask?: Promise<void>
    private sessionFailure?: Error
    private sessionRetirementTask?: Promise<void>
    private authorizationTask?: Promise<void>
    private authorizationSignal?: AbortSignal
    private readonly audioControllers = new Set<AbortController>()
    private readonly setupTasks = new Set<Promise<string>>()

    constructor(options: ChildrenHermesOptions = {}) {
        this.url = normalizeChildrenHermesUrl(options.url ?? process.env.HERMES_CHILDREN_URL ?? DEFAULT_URL)
        this.profileId = options.profileId ?? process.env.HERMES_CHILDREN_PROFILE_ID ?? 'child1'
        if (!['child1', 'child2'].includes(this.profileId)) throw fail('Invalid children Hermes profile selection')
        this.requestTimeoutMs = duration(options.requestTimeoutMs ?? 10_000, 60_000)
        this.turnTimeoutMs = duration(options.turnTimeoutMs ?? Number(process.env.HERMES_TURN_TIMEOUT_MS ?? 600_000), 3_600_000)
        this.heartbeatMs = duration(options.heartbeatMs ?? 30_000, 60_000)
        if (this.heartbeatMs + this.requestTimeoutMs >= 90_000) {
            throw fail('Children Hermes heartbeat configuration exceeds session expiry')
        }
    }

    async submitPrompt(prompt: string, options: ChildrenOperationOptions = {}): Promise<string> {
        let result = ''
        for await (const event of this.streamPrompt(prompt, options)) {
            if (event.type === 'delta') result += event.text
            else if (event.text !== undefined) result = event.text
        }
        return result
    }

    async *streamPrompt(prompt: string, options: ChildrenOperationOptions = {}): AsyncGenerator<HermesPromptStreamEvent> {
        if (this.disposed) throw fail('Children Hermes client disposed')
        if (this.active) throw fail('Children Hermes turn already active')
        if (typeof prompt !== 'string' || !prompt.trim() || [...prompt.trim()].length > 16_384) {
            throw fail('Invalid children Hermes prompt')
        }
        if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw fail('Invalid children Hermes deadline')
        const deadline = Math.min(options.deadline ?? Infinity, Date.now() + this.turnTimeoutMs)
        if (options.signal?.aborted) throw fail('Children Hermes turn cancelled')
        if (deadline <= Date.now()) throw fail('Children Hermes turn timed out')
        const turn: Turn = { controller: new AbortController(), deadline }
        const onAbort = () => {
            turn.failure ??= fail('Children Hermes turn cancelled')
            turn.controller.abort()
        }
        this.active = turn
        options.signal?.addEventListener('abort', onAbort, { once: true })
        if (options.signal?.aborted) onAbort()
        turn.timer = setTimeout(() => {
            turn.failure ??= fail('Children Hermes turn timed out')
            turn.controller.abort()
        }, Math.max(1, deadline - Date.now()))
        turn.timer.unref()
        let complete = false
        try {
            if (this.cancelTask) await waitFor(this.cancelTask.catch(() => undefined), turn.controller.signal)
            // Creation keeps a bounded background request to learn/close late
            // IDs, but its caller observes cancellation and the turn deadline now.
            if (turn.failure) throw turn.failure
            turn.setup = this.ensureSession({ signal: turn.controller.signal, deadline }, turn)
            const setup = turn.setup
            this.setupTasks.add(setup)
            void setup.then(() => this.setupTasks.delete(setup), () => this.setupTasks.delete(setup))
            const sessionId = await waitFor(turn.setup, turn.controller.signal)
            this.checkTurn(turn)
            const response = await this.request(`/api/session/${sessionId}/turn`, 'POST', { text: prompt }, turn.controller.signal)
            let emittedChars = 0
            for await (const event of sseEvents(response)) {
                this.checkTurn(turn)
                if (!['token', 'done', 'error'].includes(event.event)) continue
                if (event.event === 'error') throw fail('Children Hermes turn failed')
                let payload: unknown
                try { payload = JSON.parse(event.data) as unknown } catch { throw fail('Invalid children Hermes event') }
                if (!record(payload)) throw fail('Invalid children Hermes event')
                if (event.event === 'token') {
                    if (typeof payload['token'] !== 'string') throw fail('Invalid children Hermes token event')
                    emittedChars += payload['token'].length
                    if (emittedChars > 4 * MAX_BODY_CHARS) throw fail('Children Hermes response is too large')
                    yield { type: 'delta', text: payload['token'] }
                } else {
                    if (typeof payload['response'] !== 'string') throw fail('Invalid children Hermes done event')
                    complete = true
                    yield { type: 'complete', text: payload['response'] }
                    return
                }
            }
            throw fail('Children Hermes stream ended before completion')
        } catch (error) {
            if (turn.failure) throw turn.failure
            if (error instanceof ChildrenError) throw error
            throw fail('Children Hermes request failed')
        } finally {
            clearTimeout(turn.timer)
            options.signal?.removeEventListener('abort', onAbort)
            turn.controller.abort()
            // Consumer break, timeout, parse failure and network EOF also stop
            // the worker; aborting fetch alone is not sufficient for cancellation.
            if (!complete && !this.disposed) {
                await this.cancelTurn(turn).catch(() => undefined)
            }
            if (this.active === turn) this.active = undefined
        }
    }

    async interrupt(): Promise<void> {
        const turn = this.active
        if (turn) {
            turn.failure = fail('Children Hermes turn cancelled')
            turn.controller.abort()
            clearTimeout(turn.timer)
        }
        if (this.disposed) return
        try {
            if (turn) await this.cancelTurn(turn)
            else await this.cancelSession()
        } finally {
            // Release ownership even when the generator is parked on a token
            // awaiting TTS. Its later finally shares this exact cancellation.
            if (this.active === turn) this.active = undefined
        }
    }

    async dispose(): Promise<void> {
        if (this.disposeTask) return await this.disposeTask
        this.disposed = true
        for (const controller of this.audioControllers) controller.abort()
        this.stopHeartbeat()
        const turn = this.active
        if (turn) {
            turn.failure = fail('Children Hermes client disposed')
            turn.controller.abort()
            clearTimeout(turn.timer)
        }
        this.disposeTask = (async () => {
            try {
                await turn?.setup?.catch(() => undefined)
                await Promise.allSettled([...this.setupTasks])
                await this.authorizationTask?.catch(() => undefined)
                await this.heartbeatTask?.catch(() => undefined)
                await this.cancelTask?.catch(() => undefined)
                if (this.sessionId) {
                    await this.cancelSession().catch(() => undefined)
                    await this.jsonRequest(`/api/session/${this.sessionId}/close`, 'POST', {}).catch(() => undefined)
                }
            } finally {
                this.stopHeartbeat()
                this.sessionId = undefined
                this.cookie = undefined
                this.csrf = undefined
                this.active = undefined
            }
        })()
        return await this.disposeTask
    }

    private checkTurn(turn: Turn): void {
        if (!turn.failure && turn.deadline <= Date.now()) {
            turn.failure = fail('Children Hermes turn timed out')
            turn.controller.abort()
        }
        if (turn.failure) throw turn.failure
        if (this.disposed) throw fail('Children Hermes client disposed')
        if (this.sessionFailure) throw this.sessionFailure
    }

    private validateProfile(value: unknown): void {
        if (!record(value) || value['id'] !== this.profileId || value['enabled'] !== true) {
            throw fail('Children Hermes profile is not enabled')
        }
        // The bridge uses external STT/TTS. Enforce backend voice permission
        // here too so that this route cannot bypass a parent's voice toggle.
        if (!record(value['features']) || value['features']['voice'] !== true) {
            throw fail('Children Hermes profile voice is disabled')
        }
    }

    async ensureVoiceEnabled(options: ChildrenOperationOptions = {}): Promise<void> {
        if (this.disposed) throw fail('Children Hermes client disposed')
        const scope = operationScope(options, this.requestTimeoutMs)
        this.audioControllers.add(scope.controller)
        let ownedTask: Promise<void> | undefined
        try {
            if (scope.signal.aborted) throw fail('Children Hermes operation cancelled or timed out')
            // The public setup waiter may return before its authorization has
            // finished cancelling. Independent callers drain that request under
            // their own deadline and retry; even a caller which joined BEFORE
            // the initiating scope aborted must not inherit its cancellation.
            for (;;) {
                if (!this.authorizationTask) {
                    const task = this.refreshAuthorization(scope)
                    ownedTask = task
                    this.authorizationTask = task
                    this.authorizationSignal = scope.signal
                    void task.finally(() => {
                        if (this.authorizationTask === task) {
                            this.authorizationTask = undefined
                            this.authorizationSignal = undefined
                        }
                    }).catch(() => undefined)
                }
                const task = this.authorizationTask
                const initiatingSignal = this.authorizationSignal
                try {
                    await waitFor(task, scope.signal)
                    break
                } catch (error) {
                    if (task === ownedTask || scope.signal.aborted || this.disposed || !initiatingSignal?.aborted) throw error
                    // The retired task has settled; discard only its cancellation,
                    // never permission/HTTP failures of a live authorization.
                    if (this.authorizationTask === task) {
                        this.authorizationTask = undefined
                        this.authorizationSignal = undefined
                    }
                }
            }
            if (this.disposed || scope.signal.aborted) throw fail('Children Hermes operation cancelled or timed out')
        } catch (error) {
            // The initiating caller owns this HTTP request. Drain its aborted
            // body before returning so an immediate retry cannot join a doomed
            // authorization task. Other cancelled waiters need not block it.
            if (ownedTask && scope.signal.aborted) await ownedTask.catch(() => undefined)
            throw error
        } finally {
            scope.close()
            this.audioControllers.delete(scope.controller)
        }
    }

    async synthesize(text: string, options: ChildrenOperationOptions = {}): Promise<Buffer> {
        if (typeof text !== 'string' || !text.trim() || [...text].length > 2_000) {
            throw fail('Invalid children Hermes TTS input')
        }
        const scope = operationScope(options, Math.max(this.requestTimeoutMs, 30_000))
        this.audioControllers.add(scope.controller)
        try {
            await this.ensureVoiceEnabled(scope)
            if (this.disposed || scope.signal.aborted) throw fail('Children Hermes operation cancelled or timed out')
            const response = await this.request('/api/audio/tts', 'POST', { text, profile_id: this.profileId }, scope.signal)
            if (!response.body || !/^audio\/wav(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
                await response.body?.cancel().catch(() => undefined)
                throw fail('Invalid children Hermes TTS audio')
            }
            const reader = response.body.getReader()
            const chunks: Buffer[] = []
            let bytes = 0
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    bytes += value.byteLength
                    if (bytes > 32 * 1024 * 1024) throw fail('Children Hermes TTS audio is too large')
                    chunks.push(Buffer.from(value))
                }
            } finally {
                await reader.cancel().catch(() => undefined)
                reader.releaseLock()
            }
            const wav = Buffer.concat(chunks)
            if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
                throw fail('Invalid children Hermes TTS audio')
            }
            if (this.disposed || scope.signal.aborted) throw fail('Children Hermes operation cancelled or timed out')
            return wav
        } catch (error) {
            if (error instanceof ChildrenError) throw error
            throw fail('Children Hermes TTS request failed')
        } finally {
            scope.close()
            this.audioControllers.delete(scope.controller)
        }
    }

    private async refreshAuthorization(options: ChildrenOperationOptions = {}): Promise<void> {
        const statusResponse = await this.jsonRequest('/api/status', 'GET', undefined, options)
        const status = statusResponse.value
        if (!record(status) || typeof status['csrf_token'] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(status['csrf_token']) || !Array.isArray(status['profiles'])) {
            throw fail('Invalid children Hermes status response')
        }
        const setCookies = statusResponse.response.headers.getSetCookie()
        const owner = setCookies.map((cookie) => cookie.match(/^children_owner=([A-Za-z0-9_-]{1,256});/i)).find(Boolean)?.[1]
        if (owner && this.cookie && `children_owner=${owner}` !== this.cookie && this.sessionId) {
            this.sessionFailure = fail('Children Hermes owner authorization expired')
            this.stopHeartbeat()
            if (this.active) {
                this.active.failure = this.sessionFailure
                this.active.controller.abort()
            }
            await this.retireFailedSession()
        }
        if (owner) this.cookie = `children_owner=${owner}`
        if (!this.cookie) throw fail('Children Hermes status did not issue owner authorization')
        this.csrf = status['csrf_token']
        this.validateProfile(status['profiles'].find((profile: unknown) => record(profile) && profile['id'] === this.profileId))
        if (this.disposed) throw fail('Children Hermes client disposed')
    }

    private async retireFailedSession(): Promise<void> {
        if (this.sessionRetirementTask) return await this.sessionRetirementTask
        const task = this.finishSessionRetirement()
        this.sessionRetirementTask = task
        try { await task } finally {
            if (this.sessionRetirementTask === task) this.sessionRetirementTask = undefined
        }
    }

    private async finishSessionRetirement(): Promise<void> {
        // Stop scheduling first, then drain in-flight work so no late heartbeat
        // or cancellation result can poison the newly created session.
        this.stopHeartbeat()
        await this.heartbeatTask?.catch(() => undefined)
        await this.cancelTask?.catch(() => undefined)
        const oldId = this.sessionId
        this.sessionId = undefined
        // Close with the old authorization; never give the old ID to a new
        // owner. Local quarantine does not depend on backend close succeeding.
        if (oldId) await this.jsonRequest(`/api/session/${oldId}/close`, 'POST', {}).catch(() => undefined)
        this.cookie = undefined
        this.csrf = undefined
    }

    private async ensureSession(options: ChildrenOperationOptions, turn: Turn): Promise<string> {
        if (this.sessionFailure) await this.retireFailedSession()
        if (turn.failure) throw turn.failure
        await this.ensureVoiceEnabled(options)
        if (this.disposed) throw fail('Children Hermes client disposed')
        if (turn.failure) throw turn.failure
        // Only successful authorization (including enabled/voice checks) lets a
        // transient failure recover. Revocation can never be bypassed here.
        this.sessionFailure = undefined
        if (this.sessionId) { turn.sessionId = this.sessionId; return this.sessionId }
        const authorization = { cookie: this.cookie, csrf: this.csrf }
        const { value } = await this.jsonRequest('/api/session', 'POST', { profile_id: this.profileId }, {}, authorization)
        if (!record(value) || typeof value['session_id'] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value['session_id'])) {
            throw fail('Invalid children Hermes session response')
        }
        const sessionId = value['session_id']
        try {
            this.validateProfile(value['profile'])
            this.checkTurn(turn)
            if (this.active !== turn) throw fail('Children Hermes turn cancelled')
        } catch (error) {
            // A late ID belongs to its original caller/authorization, not to a
            // newer turn. Never install it or cancel/clear the newer session.
            await this.jsonRequest(`/api/session/${sessionId}/close`, 'POST', {}, {}, authorization).catch(() => undefined)
            throw error
        }
        turn.sessionId = this.sessionId = sessionId
        this.scheduleHeartbeat()
        return sessionId
    }

    private scheduleHeartbeat(): void {
        if (this.disposed || this.sessionFailure || !this.sessionId) return
        this.heartbeatTimer = setTimeout(() => {
            this.heartbeatTask = (async () => {
                try {
                    const { value } = await this.jsonRequest(`/api/session/${this.sessionId}/heartbeat`, 'POST', {})
                    if (!record(value) || value['ok'] !== true || value['expires_in'] !== 90) {
                        throw fail('Invalid children Hermes heartbeat response')
                    }
                } catch {
                    this.sessionFailure = fail('Children Hermes session heartbeat failed')
                    if (this.active) {
                        this.active.failure = this.sessionFailure
                        this.active.controller.abort()
                    }
                } finally {
                    this.scheduleHeartbeat()
                }
            })()
        }, this.heartbeatMs)
        this.heartbeatTimer.unref()
    }

    private stopHeartbeat(): void {
        clearTimeout(this.heartbeatTimer)
        this.heartbeatTimer = undefined
    }

    private async cancelTurn(turn: Turn): Promise<void> {
        if (!turn.sessionId) return // unsubmitted late creation closes itself
        turn.cancellation ??= this.cancelSession(turn.sessionId)
        await turn.cancellation
    }

    private async cancelSession(sessionId = this.sessionId): Promise<void> {
        if (!sessionId || sessionId !== this.sessionId) return
        if (this.cancelTask) return await this.cancelTask
        this.cancelTask = this.jsonRequest(`/api/session/${sessionId}/cancel`, 'POST', {}).then(() => undefined)
        try {
            await this.cancelTask
        } catch {
            this.sessionFailure = fail('Children Hermes cancellation failed')
            this.stopHeartbeat()
            throw this.sessionFailure
        } finally {
            this.cancelTask = undefined
        }
    }

    private async jsonRequest(path: string, method: 'GET' | 'POST', body?: RecordValue, options: ChildrenOperationOptions = {}, authorization?: RequestAuthorization): Promise<{ value: unknown; response: Response }> {
        const scope = operationScope(options, this.requestTimeoutMs)
        try {
            const response = await this.request(path, method, body, scope.signal, authorization)
            const value = await readJson(response)
            if (scope.signal.aborted) throw fail('Children Hermes operation cancelled or timed out')
            return { response, value }
        } catch (error) {
            if (error instanceof ChildrenError) throw error
            throw fail('Children Hermes request failed')
        } finally {
            scope.close()
        }
    }

    private async request(path: string, method: 'GET' | 'POST', body: RecordValue | undefined, signal: AbortSignal, authorization?: RequestAuthorization): Promise<Response> {
        const { cookie, csrf } = authorization ?? { cookie: this.cookie, csrf: this.csrf }
        const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Cache-Control': 'no-store' }
        if (cookie) headers['Cookie'] = cookie
        if (method === 'POST') {
            if (!csrf || !cookie) throw fail('Children Hermes owner authorization is unavailable')
            headers['X-CSRF-Token'] = csrf
            headers['Content-Type'] = 'application/json'
        }
        let response: Response
        try {
            response = await fetch(`${this.url}${path}`, {
                method, headers, body: body === undefined ? undefined : JSON.stringify(body),
                signal, redirect: 'error', credentials: 'omit',
            })
        } catch {
            throw fail('Children Hermes request failed')
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            if ([404, 410].includes(response.status) && /^\/api\/session\/[^/]+\/(?:turn|heartbeat|cancel)$/.test(path)) {
                this.sessionFailure = fail('Children Hermes session expired')
                this.stopHeartbeat()
            }
            throw fail(`Children Hermes HTTP request rejected (${response.status})`)
        }
        return response
    }
}
