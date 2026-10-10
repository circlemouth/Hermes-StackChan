import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { ChildrenHttpHermesClient } from '../src/children_hermes.ts'
import { pcmToWav } from '../src/audio.ts'

function deferred<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
}
const profile = (voice: boolean) => ({ id: 'child1', enabled: true, features: { voice, camera: false, search: false } })
async function backend() {
    const requests: Array<{ path: string; cookie?: string; csrf?: string; body: unknown }> = []
    const state = { voice: true, owner: 'owner1', heartbeatFails: false, cancelFails: false, closeFails: false, stallTurn: false,
        stallStatus: false, stallTts: false, turnExpired: false, stallSession: false }
    const turned = deferred()
    const statusStarted = deferred()
    const ttsStarted = deferred()
    const sessionStarted = deferred()
    const sessionClosed = deferred()
    const delayedSessions: Array<() => void> = []
    let created = 0
    const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        const url = request.url ?? ''
        requests.push({ path: url, cookie: request.headers.cookie,
            csrf: typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined,
            body: raw ? JSON.parse(raw) : undefined })
        const json = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
        if (url === '/api/status') {
            statusStarted.resolve()
            if (state.stallStatus) { response.writeHead(200); response.write('{'); return }
            response.setHeader('Set-Cookie', `children_owner=${state.owner}; Path=/; HttpOnly`)
            json({ csrf_token: `csrf_${state.owner}`, profiles: [profile(state.voice)] })
        } else if (url === '/api/session') {
            const id = ++created
            const finish = () => json({ session_id: `session${id}`, profile: profile(state.voice) })
            sessionStarted.resolve()
            if (state.stallSession) delayedSessions.push(finish)
            else finish()
        } else if (url.endsWith('/heartbeat')) {
            if (state.heartbeatFails) { response.writeHead(503); response.end('private backend error'); return }
            json({ ok: true, expires_in: 90 })
        } else if (url.endsWith('/cancel')) {
            if (state.cancelFails) { response.writeHead(503); response.end('private backend error'); return }
            json({ ok: true })
        } else if (url.endsWith('/close')) {
            sessionClosed.resolve()
            if (state.closeFails) { response.writeHead(503); response.end('private backend error'); return }
            json({ ok: true })
        } else if (url.endsWith('/turn')) {
            if (state.turnExpired) { response.writeHead(404); response.end('private expired session'); return }
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write('event: token\ndata: {"token":"hello"}\n\n')
            turned.resolve()
            if (!state.stallTurn) response.end('event: done\ndata: {"response":"recovered"}\n\n')
        } else if (url === '/api/audio/tts') {
            ttsStarted.resolve()
            response.writeHead(200, { 'content-type': 'audio/wav' })
            if (state.stallTts) response.write('RIFF')
            else response.end(pcmToWav(Buffer.alloc(2), 24000))
        } else { response.writeHead(404); response.end() }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert(address && typeof address === 'object')
    return { url: `http://127.0.0.1:${address.port}`, state, requests, turned, statusStarted, ttsStarted, sessionStarted, sessionClosed,
        releaseSessions: () => { for (const finish of delayedSessions.splice(0)) finish() },
        created: () => created,
        close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) },
    }
}
function clientFor(mock: { url: string }) {
    return new ChildrenHttpHermesClient({ url: mock.url, requestTimeoutMs: 200, turnTimeoutMs: 1000, heartbeatMs: 10 })
}

test('R05 transient heartbeat failure quarantines old session and reauthorizes/recreates on same client', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    mock.state.stallTurn = true
    mock.state.heartbeatFails = true
    try {
        await assert.rejects(client.submitPrompt('first'), /heartbeat/)
        mock.state.heartbeatFails = false
        mock.state.stallTurn = false
        mock.state.closeFails = true // Recovery must not depend on old close succeeding.
        assert.equal(await client.submitPrompt('second'), 'recovered')
        assert.equal(mock.created(), 2)
        const oldClose = mock.requests.findIndex((r) => r.path === '/api/session/session1/close')
        const statuses = mock.requests.map((r, i) => r.path === '/api/status' ? i : -1).filter((i) => i >= 0)
        assert.equal(statuses.length, 2)
        assert.ok(oldClose >= 0 && oldClose < statuses[1])
        assert.equal(mock.requests[statuses[1]].cookie, undefined, 'fresh owner authorization, not stale cached credentials')
        assert.ok(mock.requests.some((r) => r.path === '/api/session/session2/turn'))
        await Promise.all([client.dispose(), client.dispose(), client.dispose()])
        assert.equal(mock.requests.filter((r) => r.path === '/api/session/session2/close').length, 1)
        await assert.rejects(client.submitPrompt('after dispose'), /disposed/)
    } finally { await client.dispose(); await mock.close() }
})

test('R05 recovery cannot bypass revoked voice permission; reenable permits later authorized recovery', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    mock.state.stallTurn = true
    mock.state.heartbeatFails = true
    try {
        await assert.rejects(client.submitPrompt('first'), /heartbeat/)
        mock.state.heartbeatFails = false
        mock.state.stallTurn = false
        mock.state.voice = false
        await assert.rejects(client.submitPrompt('revoked'), /voice is disabled/)
        await assert.rejects(client.synthesize('revoked audio'), /voice is disabled/)
        assert.equal(mock.created(), 1)
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/turn')).length, 1)
        assert.equal(mock.requests.filter((r) => r.path === '/api/audio/tts').length, 0)
        mock.state.voice = true
        assert.equal(await client.submitPrompt('enabled again'), 'recovered')
        assert.equal(mock.created(), 2)
    } finally { await client.dispose(); await mock.close() }
})

test('R05 failed cancel is transient and consumer break is followed by a fresh session', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    mock.state.stallTurn = true
    mock.state.cancelFails = true
    try {
        for await (const event of client.streamPrompt('first')) {
            assert.equal(event.type, 'delta')
            break
        }
        mock.state.cancelFails = false
        mock.state.stallTurn = false
        assert.equal(await client.submitPrompt('second'), 'recovered')
        assert.equal(mock.created(), 2)
        assert.ok(mock.requests.some((r) => r.path === '/api/session/session1/close'))
    } finally { await client.dispose(); await mock.close() }
})

test('R05 a backend-expired session is recreated even when cancellation still succeeds', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    try {
        assert.equal(await client.submitPrompt('first'), 'recovered')
        mock.state.turnExpired = true
        await assert.rejects(client.submitPrompt('expired'), /404/)
        mock.state.turnExpired = false
        assert.equal(await client.submitPrompt('fresh'), 'recovered')
        assert.equal(mock.created(), 2)
    } finally { await client.dispose(); await mock.close() }
})

test('R05 owner rotation fails current turn closed but permits later fresh authorized session', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    try {
        assert.equal(await client.submitPrompt('first'), 'recovered')
        mock.state.owner = 'owner2'
        await assert.rejects(client.submitPrompt('owner changed'), /authorization expired/)
        assert.equal(await client.submitPrompt('new owner'), 'recovered')
        assert.equal(mock.created(), 2)
        const close = mock.requests.find((r) => r.path === '/api/session/session1/close')
        assert.equal(close?.cookie, 'children_owner=owner1')
        const turn = mock.requests.find((r) => r.path === '/api/session/session2/turn')
        assert.equal(turn?.cookie, 'children_owner=owner2')
    } finally { await client.dispose(); await mock.close() }
})

test('R04 children audio cancellation includes authorization and a stalled TTS body', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    try {
        mock.state.stallStatus = true
        const controller = new AbortController()
        const rejected = assert.rejects(client.synthesize('hello', { signal: controller.signal }), /cancelled|failed|JSON/)
        await mock.statusStarted.promise; controller.abort(); await rejected
        assert.equal(mock.requests.filter((r) => r.path === '/api/audio/tts').length, 0)
        mock.state.stallStatus = false
        mock.state.stallTts = true
        const timedOut = assert.rejects(client.synthesize('hello', { deadline: Date.now() + 150 }), /failed|cancelled/)
        await mock.ttsStarted.promise; await timedOut
        mock.state.stallTts = false
        assert.ok((await client.synthesize('retry')).length > 44)
        assert.equal(mock.created(), 0, 'permission/audio probes never create a chat session')
    } finally { await client.dispose(); await mock.close() }
})

test('children chat accepts shared cancellation/deadline options and stops a stalled turn', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    try {
        const already = new AbortController(); already.abort()
        await assert.rejects(client.submitPrompt('pre-aborted', { signal: already.signal }), /cancelled/)
        await assert.rejects(client.submitPrompt('pre-expired', { deadline: Date.now() - 1 }), /timed out/)
        assert.equal(mock.requests.length, 0)
        mock.state.stallTurn = true
        const controller = new AbortController()
        const cancelled = assert.rejects(client.submitPrompt('first', { signal: controller.signal }), /cancelled/)
        await mock.turned.promise; controller.abort(); await cancelled
        const expired = assert.rejects(client.submitPrompt('second', { deadline: Date.now() + 50 }), /timed out/)
        await expired
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/cancel')).length, 2)
        mock.state.stallTurn = false
        assert.equal(await client.submitPrompt('retry'), 'recovered')
    } finally { await client.dispose(); await mock.close() }
})

test('R02/R05 dispose remains idempotent and nonthrowing with rejected close requests', { timeout: 5000 }, async () => {
    const mock = await backend()
    const client = clientFor(mock)
    try {
        await client.submitPrompt('hello')
        mock.state.cancelFails = true
        mock.state.closeFails = true
        await Promise.all([client.dispose(), client.dispose()])
        await client.dispose()
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/close')).length, 1)
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/cancel')).length, 1)
    } finally { await client.dispose(); await mock.close() }
})

async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Test operation did not settle')), ms)
        })])
    } finally { clearTimeout(timer) }
}

test('R12/R23 interrupted Children token consumer releases ownership without late cancellation of next turn', async () => {
    const mock = await backend()
    const client = clientFor(mock)
    const old = client.streamPrompt('old')
    const next = client.streamPrompt('new')
    try {
        assert.equal((await within(old.next())).value?.type, 'delta')
        await within(client.interrupt())
        mock.state.stallTurn = true
        assert.equal((await within(next.next())).value?.type, 'delta')
        await assert.rejects(within(old.next()), /cancelled/)
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/cancel')).length, 1)
        await assert.rejects(client.submitPrompt('concurrent'), /already active/)
        await within(next.return(undefined))
        assert.equal(mock.requests.filter((r) => r.path.endsWith('/cancel')).length, 2)
        mock.state.stallTurn = false
        assert.equal(await within(client.submitPrompt('third')), 'recovered')
        assert.equal(mock.created(), 1)
    } finally { await old.return(undefined); await next.return(undefined); await client.dispose(); await mock.close() }
})

for (const mode of ['abort', 'deadline', 'interrupt'] as const) {
    test(`R03/R04/R05 Children setup ${mode} returns promptly and late ID cannot replace newer session/owner`, async () => {
        const mock = await backend()
        mock.state.stallSession = true
        const client = new ChildrenHttpHermesClient({ url: mock.url, requestTimeoutMs: 5000, turnTimeoutMs: 5000, heartbeatMs: 1000 })
        const controller = new AbortController()
        const pending = client.submitPrompt('old', { signal: controller.signal,
            deadline: Date.now() + (mode === 'deadline' ? 200 : 5000) })
        try {
            await within(mock.sessionStarted.promise)
            const rejected = assert.rejects(within(pending), mode === 'deadline' ? /timed out/ : /cancelled/)
            if (mode === 'abort') controller.abort()
            if (mode === 'interrupt') await within(client.interrupt())
            await rejected // old creation is still deliberately unresolved
            mock.state.stallSession = false
            mock.state.owner = 'owner2'
            assert.equal(await within(client.submitPrompt('new')), 'recovered')
            assert.equal(mock.created(), 2)
            mock.releaseSessions()
            await within(mock.sessionClosed.promise)
            const oldClose = mock.requests.find((r) => r.path === '/api/session/session1/close')
            assert.equal(oldClose?.cookie, 'children_owner=owner1')
            assert.equal(oldClose?.csrf, 'csrf_owner1')
            assert.equal(mock.requests.find((r) => r.path === '/api/session/session2/turn')?.csrf, 'csrf_owner2')
            assert.equal(await within(client.submitPrompt('third')), 'recovered')
            assert.equal(mock.created(), 2)
            assert.equal(mock.requests.filter((r) => r.path === '/api/session/session2/turn').length, 2)
            assert.equal(mock.requests.filter((r) => r.path === '/api/session/session1/turn').length, 0)
        } finally { mock.releaseSessions(); await pending.catch(() => undefined); await client.dispose(); await mock.close() }
    })
}

for (const mode of ['abort', 'deadline', 'interrupt'] as const) {
    test(`R03/R05 ${mode} during authorization cannot poison the next independent turn`, { timeout: 8000 }, async () => {
        const mock = await backend()
        const client = new ChildrenHttpHermesClient({ url: mock.url, requestTimeoutMs: 5000, turnTimeoutMs: 5000, heartbeatMs: 1000 })
        const originalFetch = globalThis.fetch
        const statusStarted = deferred()
        const statusAborted = deferred()
        const retryEnteredAuthorization = deferred()
        let releaseAbortedStatus: (() => void) | undefined
        let statusCalls = 0
        let authorizationCalls = 0
        const authorize = client.ensureVoiceEnabled.bind(client)
        client.ensureVoiceEnabled = (options = {}) => {
            const result = authorize(options)
            if (++authorizationCalls === 2) retryEnteredAuthorization.resolve()
            return result
        }
        globalThis.fetch = async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
            if (url.href === `${mock.url}/api/status` && ++statusCalls === 1) {
                statusStarted.resolve()
                return await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        releaseAbortedStatus = () => reject(new Error('fixture delayed abort'))
                        statusAborted.resolve()
                    }, { once: true })
                })
            }
            return await originalFetch(input, init)
        }
        const controller = new AbortController()
        const pending = client.submitPrompt('old', { signal: controller.signal,
            deadline: Date.now() + (mode === 'deadline' ? 200 : 5000) })
        let joinedAudio: Promise<Buffer> | undefined
        try {
            await within(statusStarted.promise)
            if (mode === 'abort') {
                joinedAudio = client.synthesize('independent waiter already joined')
                void joinedAudio.catch(() => undefined)
                await within(retryEnteredAuthorization.promise)
            }
            const rejected = assert.rejects(within(pending), mode === 'deadline' ? /timed out/ : /cancelled/)
            if (mode === 'abort') controller.abort()
            if (mode === 'interrupt') await within(client.interrupt())
            await rejected // public cancellation must not wait for fetch cleanup
            await within(statusAborted.promise)
            if (mode === 'deadline') {
                const bounded = client.submitPrompt('bounded retry', { deadline: Date.now() + 50 })
                await within(retryEnteredAuthorization.promise)
                await assert.rejects(within(bounded), /timed out/)
                assert.equal(statusCalls, 1, 'waiting for retired authorization honors the new caller deadline')
            }
            const next = client.submitPrompt('new')
            await within(retryEnteredAuthorization.promise) // B has joined while A's abort is still parked
            assert.equal(statusCalls, 1)
            releaseAbortedStatus?.()
            assert.equal(await within(next), 'recovered')
            if (joinedAudio) assert.equal((await within(joinedAudio)).toString('ascii', 0, 4), 'RIFF')
            assert.equal(statusCalls, 2, 'independent retry must perform fresh authorization')
            assert.equal(mock.created(), 1, 'cancelled authorization cannot create a session')
            assert.equal(await within(client.submitPrompt('third')), 'recovered')
            assert.equal(mock.created(), 1)
        } finally {
            controller.abort()
            releaseAbortedStatus?.()
            globalThis.fetch = originalFetch
            await pending.catch(() => undefined)
            await client.dispose()
            await mock.close()
        }
    })
}
