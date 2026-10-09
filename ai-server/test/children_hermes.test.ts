import { test } from 'node:test'
import assert from 'node:assert/strict'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { ChildrenHttpHermesClient, normalizeChildrenHermesUrl } from '../src/children_hermes.ts'
import { HermesClient } from '../src/hermes.ts'
import { synthesizeWithHermes, transcribeWithHermes } from '../src/hermes_audio.ts'

const OWNER = 'mock_owner_private'
const CSRF = 'mock_csrf_private'
const SESSION = 'mock_session_private'
const PRIVATE = 'private_child_transcript_response_cookie'
const profile = (voice = true, enabled = true, id = 'child1') => ({ id, enabled, features: { voice, camera: false, search: false } })
function deferred<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
}
type RequestRecord = { path: string; method?: string; headers: IncomingMessage['headers']; body: unknown }
type Options = {
    status?: () => unknown
    session?: (res: ServerResponse) => void
    turn?: (res: ServerResponse) => void
    heartbeat?: (res: ServerResponse) => void
    tts?: (res: ServerResponse) => void
    override?: (req: IncomingMessage, res: ServerResponse) => boolean
    cookie?: string | null
}
async function mock(options: Options = {}) {
    const requests: RequestRecord[] = []
    const heartbeated = deferred()
    const turned = deferred()
    const created = deferred()
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw && req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw
        requests.push({ path: req.url ?? '', method: req.method, headers: req.headers, body })
        if (options.override?.(req, res)) return
        const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
        if (req.url === '/api/status') {
            const cookie = options.cookie === undefined ? `children_owner=${OWNER}; Path=/; HttpOnly; SameSite=strict` : options.cookie
            if (!req.headers.cookie && cookie) res.setHeader('Set-Cookie', [cookie, 'children_admin=must_not_be_forwarded; HttpOnly'])
            json(options.status?.() ?? { csrf_token: CSRF, profiles: [profile(), profile(true, false, 'child2')] })
            return
        }
        // Check that only the API-issued owner, never admin/browser cookies, is sent.
        assert.equal(req.headers.cookie, `children_owner=${OWNER}`)
        assert.equal(req.headers['x-csrf-token'], CSRF)
        if (req.url === '/api/session') {
            created.resolve()
            if (options.session) options.session(res)
            else json({ session_id: SESSION, profile: profile() })
        } else if (req.url === `/api/session/${SESSION}/turn`) {
            turned.resolve()
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
            if (options.turn) options.turn(res)
            else res.end('event: token\ndata: {"token":"やあ"}\n\nevent: done\ndata: {"response":"やあ！","actions":[],"sources":[]}\n\n')
        } else if (req.url === `/api/session/${SESSION}/heartbeat`) {
            heartbeated.resolve()
            if (options.heartbeat) options.heartbeat(res)
            else json({ ok: true, expires_in: 90 })
        } else if (req.url === '/api/audio/tts') {
            if (options.tts) options.tts(res)
            else { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav()) }
        } else if (req.url?.endsWith('/close')) json({ closed: true })
        else if (req.url?.endsWith('/cancel')) json({ cancelled: true })
        else { res.writeHead(404); res.end(PRIVATE) }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return {
        url: `http://127.0.0.1:${address.port}`, requests, heartbeated, turned, created,
        close: async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}
function wav(): Buffer {
    const result = Buffer.alloc(44)
    result.write('RIFF', 0)
    result.writeUInt32LE(36, 4)
    result.write('WAVE', 8)
    return result
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
    const result: T[] = []
    for await (const event of events) result.push(event)
    return result
}
async function privateRejection(promise: Promise<unknown>, message?: RegExp) {
    await assert.rejects(promise, (error: Error) => {
        for (const secret of [OWNER, CSRF, SESSION, PRIVATE]) assert.ok(!error.message.includes(secret))
        if (message) assert.match(error.message, message)
        assert.equal(error.cause, undefined)
        return true
    })
}
async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
    const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    try {
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await run()
    } finally {
        for (const [key, value] of Object.entries(old)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('children endpoint accepts only literal loopback origins, without DNS/proxy/URL tricks', () => {
    assert.equal(normalizeChildrenHermesUrl('http://localhost:9188/'), 'http://127.0.0.1:9188')
    assert.equal(normalizeChildrenHermesUrl('http://[::1]:9188'), 'http://[::1]:9188')
    for (const value of [
        'https://example.com', 'http://host.docker.internal:9188', 'http://127.0.0.2:9188',
        'http://127.1:9188', 'http://2130706433:9188', 'http://0x7f000001:9188',
        'http://127.0.0.1.example.com', 'http://user:password@127.0.0.1:9188',
        'http://127.0.0.1:9188/api', 'http://127.0.0.1:9188/?secret=x',
        'http://127.0.0.1:9188/#secret', 'http://127.0.0.1:0', 'ws://127.0.0.1:9188',
        ' http://127.0.0.1:9188', 'http://localhost.:9188',
    ]) assert.throws(() => normalizeChildrenHermesUrl(value), /Children Hermes|children Hermes/)
})

test('HermesClient children_http uses owner + CSRF, backend defaults, reuses session and closes once', async () => {
    const backend = await mock()
    try {
        await withEnv({ HERMES_CONNECT_MODE: 'children_http', HERMES_CHILDREN_URL: backend.url, HERMES_CHILDREN_PROFILE_ID: 'child1', HERMES_DASHBOARD_URL: 'http://127.0.0.1:1' }, async () => {
            const client = new HermesClient()
            try {
                assert.equal(await client.submitPrompt('こんにちは'), 'やあ！')
                assert.deepEqual(await collect(client.streamPrompt('続き')), [{ type: 'delta', text: 'やあ' }, { type: 'complete', text: 'やあ！' }])
                assert.equal(backend.requests.filter((r) => r.path === '/api/session').length, 1)
                assert.deepEqual(backend.requests.find((r) => r.path === '/api/session')?.body, { profile_id: 'child1' })
                assert.deepEqual(backend.requests.find((r) => r.path.endsWith('/turn'))?.body, { text: 'こんにちは' })
                assert.equal(backend.requests.filter((r) => r.path === '/api/status').length, 2)
            } finally {
                await client.dispose()
                await client.dispose()
            }
            assert.equal(backend.requests.filter((r) => r.path.endsWith('/close')).length, 1)
            await privateRejection(client.submitPrompt(PRIVATE), /disposed/)
        })
    } finally { await backend.close() }
})

test('SSE handles bytewise Japanese UTF-8, CRLF/CR/LF, comments, multiline data and ignores tools/actions', async () => {
    const backend = await mock({ turn: (res) => {
        const data = Buffer.from(': ping\r\nevent: tool\r\ndata: {"name":"capture_photo"}\r\n\r\nevent: token\rdata: {\rdata: "token":"こんにちは"}\r\revent: done\ndata: {"response":"完成","actions":[{"name":"forbidden"}]}\n\n')
        for (const byte of data) res.write(Buffer.from([byte]))
        res.end()
    } })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    try {
        assert.deepEqual(await collect(client.streamPrompt('test')), [{ type: 'delta', text: 'こんにちは' }, { type: 'complete', text: '完成' }])
    } finally { await client.dispose(); await backend.close() }
})

test('disabled, missing and voice-disabled profiles fail before session/turn/TTS creation', async () => {
    for (const profiles of [[profile(false)], [profile(true, false)], [profile(true, true, 'child2')], []]) {
        const backend = await mock({ status: () => ({ csrf_token: CSRF, profiles }) })
        const client = new ChildrenHttpHermesClient({ url: backend.url })
        try {
            await privateRejection(client.submitPrompt(PRIVATE), /profile/)
            await privateRejection(client.synthesize(PRIVATE), /profile/)
            assert.ok(backend.requests.every((r) => r.path === '/api/status'))
        } finally { await client.dispose(); await backend.close() }
    }
})

test('child2 cannot fall back to enabled child1 and a revoked voice toggle is checked each turn', async () => {
    let voice = true
    const backend = await mock({ status: () => ({ csrf_token: CSRF, profiles: [profile(voice), profile(true, false, 'child2')] }) })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    const child2 = new ChildrenHttpHermesClient({ url: backend.url, profileId: 'child2' })
    try {
        await privateRejection(child2.submitPrompt(PRIVATE), /profile/)
        assert.equal(await client.submitPrompt('first'), 'やあ！')
        voice = false
        await privateRejection(client.submitPrompt(PRIVATE), /voice/)
        assert.equal(backend.requests.filter((r) => r.path.endsWith('/turn')).length, 1)
    } finally { await client.dispose(); await child2.dispose(); await backend.close() }
})

test('missing or malformed owner/CSRF fails closed without forwarding admin credentials', async () => {
    for (const options of [
        { cookie: null }, { cookie: 'children_owner=bad value; HttpOnly' },
        { status: () => ({ csrf_token: '\r\n' + PRIVATE, profiles: [profile()] }) },
        { status: () => ({ csrf_token: CSRF, profiles: PRIVATE }) },
    ]) {
        const backend = await mock(options)
        const client = new ChildrenHttpHermesClient({ url: backend.url })
        try {
            await privateRejection(client.submitPrompt(PRIVATE))
            assert.deepEqual(backend.requests.map((r) => r.path), ['/api/status'])
        } finally { await client.dispose(); await backend.close() }
    }
})

test('redirects are rejected for status, turn and TTS without contacting their target', async () => {
    let redirectedRequests = 0
    const target = http.createServer((_req, res) => { redirectedRequests++; res.end(PRIVATE) })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const address = target.address()
    assert.ok(address && typeof address === 'object')
    try {
        for (const path of ['/api/status', `/api/session/${SESSION}/turn`, '/api/audio/tts']) {
            const backend = await mock({ override: (req, res) => {
                if (req.url !== path) return false
                res.writeHead(307, { location: `http://127.0.0.1:${address.port}/${PRIVATE}` }); res.end(PRIVATE)
                return true
            } })
            const client = new ChildrenHttpHermesClient({ url: backend.url })
            try {
                await privateRejection(path.endsWith('/tts') ? client.synthesize(PRIVATE) : client.submitPrompt(PRIVATE))
            } finally { await client.dispose(); await backend.close() }
        }
        assert.equal(redirectedRequests, 0)
    } finally { await new Promise<void>((resolve) => target.close(() => resolve())) }
})

test('HTTP busy/errors and SSE error/malformed/truncated/oversized responses never expose content', async () => {
    for (const turn of [
        (res: ServerResponse) => res.end(`event: error\ndata: {"code":"${PRIVATE}"}\n\n`),
        (res: ServerResponse) => res.end(`event: token\ndata: ${PRIVATE}\n\n`),
        (res: ServerResponse) => res.end(`event: done\ndata: {"response":42,"secret":"${PRIVATE}"}\n\n`),
        (res: ServerResponse) => res.end('event: token\ndata: {"token":"partial"}\n\n'),
        (res: ServerResponse) => res.end('event: done\ndata: {"response":"no delimiter"}'),
        (res: ServerResponse) => res.end('data: ' + 'x'.repeat(1_048_577)),
    ]) {
        const backend = await mock({ turn })
        const client = new ChildrenHttpHermesClient({ url: backend.url })
        try {
            await privateRejection(client.submitPrompt(PRIVATE))
            assert.ok(backend.requests.some((r) => r.path.endsWith('/cancel')))
        } finally { await client.dispose(); await backend.close() }
    }
    const backend = await mock({ session: (res) => { res.writeHead(409); res.end(PRIVATE + OWNER + CSRF + SESSION) } })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    try { await privateRejection(client.submitPrompt(PRIVATE), /409/); assert.equal(backend.requests.length, 2) }
    finally { await client.dispose(); await backend.close() }
})

test('interrupt aborts reads, cancels backend and drops late response; concurrent turns are rejected', async () => {
    const backend = await mock({ turn: (res) => { res.write('event: token\ndata: {"token":"first"}\n\n') } })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    const stream = client.streamPrompt('test')
    try {
        assert.deepEqual(await stream.next(), { value: { type: 'delta', text: 'first' }, done: false })
        await privateRejection(client.submitPrompt(PRIVATE), /already active/)
        const pending = stream.next()
        const rejected = privateRejection(pending, /cancelled/)
        await client.interrupt()
        await rejected
        assert.ok(backend.requests.some((r) => r.path.endsWith('/cancel')))
    } finally { await stream.return(); await client.dispose(); await backend.close() }
})

test('consumer break cancels worker, and a turn timeout cancels a stalled stream', async () => {
    const backend = await mock({ turn: (res) => { res.write('event: token\ndata: {"token":"first"}\n\n') } })
    const client = new ChildrenHttpHermesClient({ url: backend.url, turnTimeoutMs: 60 })
    try {
        for await (const event of client.streamPrompt('test')) { assert.equal(event.type, 'delta'); break }
        assert.ok(backend.requests.some((r) => r.path.endsWith('/cancel')))
        await privateRejection(client.submitPrompt(PRIVATE), /timed out/)
    } finally { await client.dispose(); await backend.close() }
})

test('heartbeat runs before 90-second expiry, failures fail closed, and disposal stops it', async () => {
    const success = await mock()
    const healthy = new ChildrenHttpHermesClient({ url: success.url, heartbeatMs: 15 })
    try {
        assert.equal(await healthy.submitPrompt('first'), 'やあ！')
        await success.heartbeated.promise
        await healthy.dispose()
        assert.equal(success.requests.filter((r) => r.path.endsWith('/heartbeat')).length, 1)
    } finally { await healthy.dispose(); await success.close() }
    const backend = await mock({
        turn: (res) => res.write(': keepalive\n\n'),
        heartbeat: (res) => { res.writeHead(404); res.end(PRIVATE) },
    })
    const client = new ChildrenHttpHermesClient({ url: backend.url, heartbeatMs: 15 })
    try {
        await privateRejection(client.submitPrompt(PRIVATE), /heartbeat/)
        await privateRejection(client.submitPrompt(PRIVATE), /heartbeat/)
        await client.dispose()
        assert.equal(backend.requests.filter((r) => r.path.endsWith('/heartbeat')).length, 1)
        assert.equal(backend.requests.filter((r) => r.path.endsWith('/close')).length, 1)
    } finally { await client.dispose(); await backend.close() }
})

test('dispose racing session creation learns and closes the session without submitting a turn', async () => {
    let sessionResponse!: ServerResponse
    const backend = await mock({ session: (res) => { sessionResponse = res } })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    const prompt = privateRejection(client.submitPrompt(PRIVATE), /disposed/)
    try {
        await backend.created.promise
        const disposal = client.dispose()
        sessionResponse.writeHead(200, { 'content-type': 'application/json' })
        sessionResponse.end(JSON.stringify({ session_id: SESSION, profile: profile() }))
        await disposal
        await prompt
        assert.ok(!backend.requests.some((r) => r.path.endsWith('/turn')))
        assert.equal(backend.requests.filter((r) => r.path.endsWith('/close')).length, 1)
    } finally { await client.dispose(); await backend.close() }
})

test('session profile mismatches are closed and invalid prompt/configuration never starts requests', async () => {
    const backend = await mock({ session: (res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ session_id: SESSION, profile: profile(true, true, 'child2') }))
    } })
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    try {
        await privateRejection(client.submitPrompt(''), /Invalid/)
        await privateRejection(client.submitPrompt('x'.repeat(16_385)), /Invalid/)
        assert.equal(backend.requests.length, 0)
        await privateRejection(client.submitPrompt(PRIVATE), /profile/)
        assert.ok(backend.requests.some((r) => r.path.endsWith('/close')))
        assert.ok(!backend.requests.some((r) => r.path.endsWith('/turn')))
        assert.throws(() => new ChildrenHttpHermesClient({ profileId: PRIVATE }), /Invalid/)
        assert.throws(() => new ChildrenHttpHermesClient({ heartbeatMs: 90_000 }), /Invalid/)
        await withEnv({ HERMES_CONNECT_MODE: 'children_typo' }, async () => { assert.throws(() => new HermesClient(), /refusing transport fallback/) })
    } finally { await client.dispose(); await backend.close() }
})

test('child TTS uses regular backend API with permissions/auth and no chat session or personal fallback', async () => {
    const backend = await mock()
    const client = new ChildrenHttpHermesClient({ url: backend.url })
    try {
        assert.deepEqual(await client.synthesize('音声テスト'), wav())
        await withEnv({ HERMES_CONNECT_MODE: 'children_http', HERMES_CHILDREN_URL: backend.url, HERMES_CHILDREN_PROFILE_ID: 'child1', STACKCHAN_LOCAL_TTS_URL: 'http://127.0.0.1:1', HERMES_PYTHON: 'must-not-run' }, async () => {
            assert.deepEqual(await synthesizeWithHermes('音声テスト'), wav())
        })
        assert.deepEqual(backend.requests.find((r) => r.path === '/api/audio/tts')?.body, { text: '音声テスト', profile_id: 'child1' })
        assert.ok(backend.requests.every((r) => ['/api/status', '/api/audio/tts'].includes(r.path)))
        await privateRejection(client.synthesize('x'.repeat(2_001)), /Invalid/)
    } finally { await client.dispose(); await backend.close() }
})

test('child TTS malformed/error WAVs are sanitized and never fall back to other engines', async () => {
    for (const tts of [
        (res: ServerResponse) => { res.writeHead(503); res.end(PRIVATE) },
        (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(PRIVATE) },
        (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(PRIVATE) },
    ]) {
        const backend = await mock({ tts })
        const client = new ChildrenHttpHermesClient({ url: backend.url })
        try { await privateRejection(client.synthesize(PRIVATE)) }
        finally { await client.dispose(); await backend.close() }
    }
})

test('bounded JSON request timeouts and transport failures are sanitized', async () => {
    const backend = await mock({ override: (req, res) => {
        if (req.url !== '/api/status') return false
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"private":"' + PRIVATE)
        return true
    } })
    const client = new ChildrenHttpHermesClient({ url: backend.url, requestTimeoutMs: 30 })
    try { await privateRejection(client.submitPrompt(PRIVATE)) }
    finally { await client.dispose(); await backend.close() }
    const unavailable = new ChildrenHttpHermesClient({ url: backend.url, requestTimeoutMs: 30 })
    try { await privateRejection(unavailable.submitPrompt(PRIVATE), /request failed/) }
    finally { await unavailable.dispose() }
})

test('child STT uses local multipart with no owner/admin/API key and sanitizes errors or redirects', async () => {
    let behavior: 'ok' | 'error' | 'redirect' = 'ok'
    let leaked = 0
    const backend = await mock({ override: (req, res) => {
        if (req.url === '/leak') { leaked++; res.end(PRIVATE); return true }
        if (req.url !== '/v1/audio/transcriptions') return false
        assert.equal(req.headers.cookie, undefined)
        assert.equal(req.headers.authorization, undefined)
        assert.equal(req.headers['x-csrf-token'], undefined)
        if (behavior === 'redirect') { res.writeHead(307, { location: '/leak' }); res.end() }
        else if (behavior === 'error') { res.writeHead(503); res.end(PRIVATE + OWNER + CSRF + SESSION) }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"テスト"}') }
        return true
    } })
    try {
        await withEnv({ HERMES_CONNECT_MODE: 'children_http', HERMES_CHILDREN_URL: backend.url, HERMES_STT_URL: `${backend.url}/v1/audio/transcriptions`, HERMES_STT_API_KEY: PRIVATE, HERMES_PYTHON: 'must-not-run' }, async () => {
            assert.equal(await transcribeWithHermes(wav()), 'テスト')
            behavior = 'error'
            await privateRejection(transcribeWithHermes(wav()))
            behavior = 'redirect'
            await privateRejection(transcribeWithHermes(wav()))
            assert.equal(leaked, 0)
            const request = backend.requests.find((r) => r.path === '/v1/audio/transcriptions')
            assert.match(String(request?.body), /name="file"/)
        })
    } finally { await backend.close() }
})

test('child STT rejects missing/nonloopback endpoint and voice-disabled profile without Python fallback', async () => {
    const backend = await mock({ status: () => ({ csrf_token: CSRF, profiles: [profile(false)] }) })
    try {
        await withEnv({ HERMES_CONNECT_MODE: 'children_http', HERMES_CHILDREN_URL: backend.url, HERMES_STT_URL: undefined, STACKCHAN_STT_URL: undefined, HERMES_PYTHON: 'must-not-run' }, async () => {
            await privateRejection(transcribeWithHermes(wav()), /loopback/)
            process.env.HERMES_STT_URL = 'https://example.com/v1/audio/transcriptions'
            await privateRejection(transcribeWithHermes(wav()), /loopback/)
            process.env.HERMES_STT_URL = 'http://127.0.0.1:8792/v1/audio/transcriptions'
            await privateRejection(transcribeWithHermes(wav()), /voice/)
        })
        assert.ok(backend.requests.every((r) => r.path === '/api/status'))
    } finally { await backend.close() }
})
