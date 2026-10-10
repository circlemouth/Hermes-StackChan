import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import {
    DashboardWsHermesClient, RpcHermesClient, StdioHermesClient,
    type HermesTransport, type HermesTurnOptions,
} from '../src/hermes.ts'

function deferred<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

type Connection = { line: (line: string) => void; close: (error: Error) => void; options: HermesTurnOptions }
type Request = { id: number; method: string; params: Record<string, unknown> }

class ScriptedTransport implements HermesTransport {
    connections: Connection[] = []
    requests: Request[] = []
    disposals = 0
    sessionCount = 0
    starting?: ReturnType<typeof deferred<void>>
    onRequest?: (request: Request, connection: Connection) => void
    onStarted = deferred()
    promptSent = deferred<Request>()

    async start(line: Connection['line'], close: Connection['close'], options: HermesTurnOptions = {}): Promise<void> {
        this.connections.push({ line, close, options })
        this.onStarted.resolve()
        await this.starting?.promise
    }
    async sendLine(line: string): Promise<void> {
        const request = JSON.parse(line) as Request
        this.requests.push(request)
        const connection = this.connections.at(-1)!
        if (this.onRequest) this.onRequest(request, connection)
        else if (request.method === 'session.create') reply(connection, request, { session_id: `session-${++this.sessionCount}` })
        else if (request.method === 'prompt.submit') {
            reply(connection, request, { status: 'streaming' })
            this.promptSent.resolve(request)
        } else reply(connection, request, {})
    }
    async dispose(): Promise<void> { this.disposals++ }
}

function reply(connection: Connection, request: Request, result: unknown) {
    connection.line(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}
function event(connection: Connection, type: string, sessionId: string, text?: string) {
    connection.line(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, text } }))
}
function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    return (async () => { const events: T[] = []; for await (const event of stream) events.push(event); return events })()
}
async function within<T>(promise: Promise<T>, ms = 1_500): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Test operation did not settle')), ms)
        })])
    } finally { clearTimeout(timer) }
}
async function waitFor(check: () => boolean) {
    const end = Date.now() + 1_500
    while (!check()) {
        if (Date.now() >= end) throw new Error('Test condition did not settle')
        await delay(5)
    }
}

// Exercise the actual RpcHermesClient, never copied source snippets.
test('R23 transport startup and session creation are single-flight', async () => {
    const transport = new ScriptedTransport()
    transport.starting = deferred()
    const create = deferred()
    transport.onRequest = (request, connection) => {
        void create.promise.then(() => reply(connection, request, { session_id: 'shared-session' }))
    }
    const client = new RpcHermesClient(transport)
    // Multiple low-level consumers intentionally test the shared setup path;
    // public conversation turns themselves must be single-active.
    const setup = client as unknown as { ensureSession(options?: HermesTurnOptions): Promise<string> }
    try {
        const calls = Array.from({ length: 10 }, () => setup.ensureSession({ deadline: Date.now() + 1_000 }))
        await transport.onStarted.promise
        assert.equal(transport.connections.length, 1)
        transport.starting.resolve()
        await waitFor(() => transport.requests.length === 1)
        assert.equal(transport.requests[0].method, 'session.create')
        create.resolve()
        assert.deepEqual(await within(Promise.all(calls)), Array(10).fill('shared-session'))
        assert.equal(transport.connections.length, 1)
        assert.equal(transport.requests.length, 1)
    } finally { transport.starting.resolve(); create.resolve(); await client.dispose() }
})

test('R04 idle interruption retires synchronously before a queued producer and ignores its delayed ACK', async () => {
    const transport = new ScriptedTransport(); const client = new RpcHermesClient(transport)
    let oldInterrupt: { request: Request; connection: Connection } | undefined
    transport.onRequest = (request, connection) => {
        if (request.method === 'session.create') reply(connection, request, { session_id: `session-${++transport.sessionCount}` })
        else if (request.method === 'prompt.submit') {
            reply(connection, request, { status: 'streaming' })
            event(connection, 'message.complete', String(request.params.session_id), String(request.params.text))
        } else if (request.method === 'session.interrupt') oldInterrupt = { request, connection }
    }
    try {
        await within(client.submitPrompt('one', { deadline: Date.now() + 1_000 }))
        const retirement = client.interrupt()
        const next = client.submitPrompt('two', { deadline: Date.now() + 1_000 })
        await within(retirement)
        await waitFor(() => transport.sessionCount === 2)
        assert.equal(transport.sessionCount, 2)
        assert.ok(oldInterrupt)
        reply(oldInterrupt.connection, oldInterrupt.request, {})
        await within(next)
        assert.equal(transport.connections.length, 2)
        assert.equal(transport.disposals, 1)
    } finally { await client.dispose() }
})

test('R03 timeout includes a transport start which ignores cancellation, and late start is quarantined', async () => {
    const transport = new ScriptedTransport()
    transport.starting = deferred()
    const oldStart = transport.starting
    const client = new RpcHermesClient(transport)
    const start = Date.now()
    try {
        const pending = client.submitPrompt('A', { deadline: start + 50 })
        await within(assert.rejects(pending, /timed out/))
        assert.ok(Date.now() - start < 1_000)
        assert.equal(transport.requests.length, 0)
        assert.equal(transport.connections[0].options.signal?.aborted, true)
        transport.starting = undefined
        transport.promptSent = deferred<Request>()
        const next = client.submitPrompt('B', { deadline: Date.now() + 1_000 })
        const request = await within(transport.promptSent.promise)
        oldStart.resolve()
        event(transport.connections[0], 'message.complete', String(request.params.session_id), 'stale')
        event(transport.connections[1], 'message.complete', String(request.params.session_id), 'fresh')
        assert.equal(await within(next), 'fresh')
        assert.equal(transport.connections.length, 2)
    } finally { oldStart.resolve(); await client.dispose() }
})

test('R03 deadline includes session.create; expired turn never submits and subsequent turn retries', async () => {
    const transport = new ScriptedTransport()
    transport.onRequest = () => undefined
    const client = new RpcHermesClient(transport)
    try {
        await within(assert.rejects(client.submitPrompt('A', { deadline: Date.now() + 50 }), /timed out/))
        assert.deepEqual(transport.requests.map((request) => request.method), ['session.create'])
        transport.onRequest = undefined
        const next = client.submitPrompt('B', { deadline: Date.now() + 1_000 })
        const request = await within(transport.promptSent.promise)
        event(transport.connections.at(-1)!, 'message.complete', String(request.params.session_id), 'recovered')
        assert.equal(await within(next), 'recovered')
        assert.equal(transport.connections.length, 2)
    } finally { await client.dispose() }
})

test('R03 signal cancels setup locally; already-aborted and expired options perform no I/O', async () => {
    const transport = new ScriptedTransport()
    transport.starting = deferred()
    const client = new RpcHermesClient(transport)
    const controller = new AbortController()
    try {
        const pending = client.submitPrompt('setup', { signal: controller.signal })
        const rejected = assert.rejects(pending, /cancelled/)
        await transport.onStarted.promise
        controller.abort(new Error('private abort reason'))
        await within(rejected)
        assert.equal(transport.connections[0].options.signal?.aborted, true)
        await assert.rejects(client.submitPrompt('never', { signal: controller.signal }), /cancelled/)
        await assert.rejects(client.submitPrompt('expired', { deadline: Date.now() - 1 }), /timed out/)
        assert.equal(transport.connections.length, 1)
        assert.equal(transport.requests.length, 0)
    } finally { transport.starting.resolve(); await client.dispose() }
})

test('R03 configured turn timeout applies before transport setup even without explicit options', async () => {
    const original = process.env.HERMES_TURN_TIMEOUT_MS
    process.env.HERMES_TURN_TIMEOUT_MS = '40'
    const transport = new ScriptedTransport()
    transport.starting = deferred()
    const client = new RpcHermesClient(transport)
    try {
        await within(assert.rejects(client.submitPrompt('A'), /prompt timed out after 40ms/))
        assert.equal(transport.requests.length, 0)

        const racedTransport = new ScriptedTransport()
        racedTransport.onRequest = (_request, connection) => {
            assert.equal(typeof connection.options.deadline, 'number')
            // Keep timer callbacks queued, then let a nested RPC failure arrive
            // first after the shared absolute deadline has already expired.
            while (Date.now() <= connection.options.deadline!) { /* synchronous setup fixture */ }
            connection.close(new Error('Hermes RPC session.create timed out after 30000ms'))
        }
        const racedClient = new RpcHermesClient(racedTransport)
        try {
            await within(assert.rejects(racedClient.submitPrompt('raced setup'), /prompt timed out after 40ms/))
            assert.equal(racedTransport.requests.length, 1)
        } finally { await racedClient.dispose() }
    } finally {
        transport.starting.resolve()
        await client.dispose()
        if (original === undefined) delete process.env.HERMES_TURN_TIMEOUT_MS
        else process.env.HERMES_TURN_TIMEOUT_MS = original
    }
})

test('R03 expired absolute deadline rejects late completion even before a timer callback can run', async () => {
    const transport = new ScriptedTransport()
    transport.onRequest = (request, connection) => {
        if (request.method === 'session.create') reply(connection, request, { session_id: 'session' })
        else if (request.method === 'prompt.submit') {
            reply(connection, request, {})
            // Deliberately block this isolated test process past the deadline.
            const end = Date.now() + 50
            while (Date.now() < end) { /* simulate synchronous backend callback work */ }
            event(connection, 'message.complete', 'session', 'too late')
        }
    }
    const client = new RpcHermesClient(transport)
    try { await within(assert.rejects(client.submitPrompt('A', { deadline: Date.now() + 30 }), /timed out/)) }
    finally { await client.dispose() }
})

test('R11 overlapping public turns are rejected without damaging the first', async () => {
    const transport = new ScriptedTransport()
    const client = new RpcHermesClient(transport)
    try {
        const pending = client.submitPrompt('first')
        const request = await transport.promptSent.promise
        await assert.rejects(client.submitPrompt('second'), /already active/)
        event(transport.connections[0], 'message.complete', String(request.params.session_id), 'first reply')
        assert.equal(await within(pending), 'first reply')
        assert.equal(transport.requests.filter((request) => request.method === 'prompt.submit').length, 1)
    } finally { await client.dispose() }
})

test('R11 timed-out A cannot provide B deltas/completion and B has a distinct session', async () => {
    const transport = new ScriptedTransport()
    const client = new RpcHermesClient(transport)
    try {
        const first = client.submitPrompt('A', { deadline: Date.now() + 60 })
        const a = await transport.promptSent.promise
        const old = transport.connections[0]
        await within(assert.rejects(first, /timed out/))
        transport.promptSent = deferred<Request>()
        const second = collect(client.streamPrompt('B', { deadline: Date.now() + 1_000 }))
        const b = await transport.promptSent.promise
        const current = transport.connections[1]
        assert.notEqual(a.params.session_id, b.params.session_id)
        event(old, 'message.delta', String(a.params.session_id), 'OLD ')
        event(old, 'message.complete', String(b.params.session_id), 'OLD forged session')
        old.close(new Error('late old close'))
        event(current, 'message.complete', String(a.params.session_id), 'OLD session')
        event(current, 'message.delta', String(b.params.session_id), 'new ')
        event(current, 'message.complete', String(b.params.session_id), 'new answer')
        assert.deepEqual(await within(second), [{ type: 'delta', text: 'new ' }, { type: 'complete', text: 'new answer' }])
    } finally { await client.dispose() }
})

test('R12 interrupt ACK without stream events wakes pending next and repeated interrupts stay local', async () => {
    const transport = new ScriptedTransport()
    const client = new RpcHermesClient(transport)
    try {
        const stream = client.streamPrompt('waiting')
        const pending = stream.next()
        const rejected = assert.rejects(pending, /interrupted/)
        await transport.promptSent.promise
        await within(client.interrupt())
        await within(rejected)
        assert.equal(transport.requests.filter((request) => request.method === 'session.interrupt').length, 1)
        await within(client.interrupt())
        await within(client.interrupt())
        transport.promptSent = deferred<Request>()
        const next = client.submitPrompt('new turn')
        const b = await transport.promptSent.promise
        event(transport.connections.at(-1)!, 'message.complete', String(b.params.session_id), 'new reply')
        assert.equal(await within(next), 'new reply')
        assert.equal((client as unknown as { listeners: Set<unknown> }).listeners.size, 0)
        assert.equal((client as unknown as { pending: Map<unknown, unknown> }).pending.size, 0)
    } finally { await client.dispose() }
})

test('interrupt during session.create wakes locally without creating an interrupt RPC or prompt', async () => {
    const transport = new ScriptedTransport()
    transport.onRequest = () => undefined
    const client = new RpcHermesClient(transport)
    try {
        const pending = client.submitPrompt('initializing')
        const rejected = assert.rejects(pending, /interrupted/)
        await waitFor(() => transport.requests.length === 1)
        await within(client.interrupt())
        await within(rejected)
        assert.deepEqual(transport.requests.map((request) => request.method), ['session.create'])
    } finally { await client.dispose() }
})

test('consumer return quarantines an unfinished producer', async () => {
    const transport = new ScriptedTransport()
    const client = new RpcHermesClient(transport)
    try {
        const stream = client.streamPrompt('A')
        const pending = stream.next()
        const request = await transport.promptSent.promise
        event(transport.connections[0], 'message.delta', String(request.params.session_id), 'partial')
        assert.deepEqual(await pending, { done: false, value: { type: 'delta', text: 'partial' } })
        await within(stream.return(undefined))
        assert.equal((client as unknown as { active?: unknown }).active, undefined)
        assert.ok(transport.disposals >= 1)
    } finally { await client.dispose() }
})

test('completion before prompt ACK does not leave a timer that poisons a later turn', async () => {
    const transport = new ScriptedTransport()
    transport.onRequest = (request, connection) => {
        if (request.method === 'session.create') reply(connection, request, { session_id: 'normal-session' })
        else if (request.method === 'prompt.submit') event(connection, 'message.complete', String(request.params.session_id), 'complete without ACK')
    }
    const client = new RpcHermesClient(transport)
    try {
        assert.equal(await within(client.submitPrompt('A', { deadline: Date.now() + 80 })), 'complete without ACK')
        await delay(110)
        assert.equal(await within(client.submitPrompt('B')), 'complete without ACK')
        assert.equal(transport.connections.length, 1)
        assert.equal((client as unknown as { pending: Map<unknown, unknown> }).pending.size, 0)
    } finally { await client.dispose() }
})

test('R26 malformed top-level/response/event values fail only the turn and allow recovery', async (t) => {
    const malformed = [
        'null', '[]', '{}', 'true', '42', '"secret text"', '{broken',
        '{"jsonrpc":"1.0","id":1,"result":{}}',
        '{"jsonrpc":"2.0","id":"2","result":{}}',
        '{"jsonrpc":"2.0","id":2}',
        '{"jsonrpc":"2.0","id":2,"result":{},"error":{"message":"bad"}}',
        '{"jsonrpc":"2.0","id":2,"error":null}',
        '{"jsonrpc":"2.0","method":"event","params":null}',
        '{"type":"message.delta","session_id":"session-1","text":42}',
        '{"type":"message.delta","session_id":"session-1"}',
        '{"type":"message.complete","session_id":42}',
        '{"type":"message.complete","text":"no session"}',
    ]
    for (const line of malformed) await t.test(line, async () => {
        const transport = new ScriptedTransport()
        const client = new RpcHermesClient(transport)
        try {
            const pending = client.submitPrompt('A')
            const rejected = assert.rejects(pending, /Malformed Hermes RPC/)
            await transport.promptSent.promise
            assert.doesNotThrow(() => transport.connections[0].line(line))
            await within(rejected)
            transport.promptSent = deferred<Request>()
            const next = client.submitPrompt('B')
            const request = await transport.promptSent.promise
            event(transport.connections[1], 'message.complete', String(request.params.session_id), 'recovered')
            assert.equal(await within(next), 'recovered')
        } finally { await client.dispose() }
    })
})

test('valid RPC errors reject only the current turn without exposing private backend details', async () => {
    const transport = new ScriptedTransport()
    const privateMessage = 'private provider token and transcript'
    transport.onRequest = (request, connection) => connection.line(JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32000, message: privateMessage },
    }))
    const client = new RpcHermesClient(transport)
    try {
        await assert.rejects(client.submitPrompt('A'), (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.match(error.message, /Hermes RPC request failed.*-32000/)
            assert.ok(!error.message.includes(privateMessage))
            return true
        })
        transport.onRequest = undefined
        const next = client.submitPrompt('B')
        const request = await transport.promptSent.promise
        event(transport.connections.at(-1)!, 'message.complete', String(request.params.session_id), 'recovered')
        assert.equal(await within(next), 'recovered')
    } finally { await client.dispose() }
})

test('normal payload-text events, empty completion and unknown well-shaped events remain compatible', async () => {
    const transport = new ScriptedTransport()
    const client = new RpcHermesClient(transport)
    try {
        const pending = client.submitPrompt('A')
        const request = await transport.promptSent.promise
        const connection = transport.connections[0]
        connection.line(JSON.stringify({ type: 'gateway.ready', payload: null }))
        connection.line(JSON.stringify({ jsonrpc: '2.0', method: 'extension.notification', params: {} }))
        connection.line(JSON.stringify({ type: 'message.delta', session_id: request.params.session_id, payload: { text: 'payload text' } }))
        event(connection, 'message.complete', String(request.params.session_id))
        assert.equal(await within(pending), 'payload text')
        transport.promptSent = deferred<Request>()
        const next = client.submitPrompt('B')
        await transport.promptSent.promise
        assert.equal(transport.requests.filter((request) => request.method === 'session.create').length, 1)
        event(connection, 'message.complete', String(request.params.session_id), '')
        assert.equal(await within(next), '')
    } finally { await client.dispose() }
})

test('dispose rejects an in-flight startup once and is idempotent', async () => {
    const transport = new ScriptedTransport()
    transport.starting = deferred()
    const client = new RpcHermesClient(transport)
    const pending = client.submitPrompt('A')
    const rejected = assert.rejects(pending, /disposed/)
    await transport.onStarted.promise
    await within(Promise.all([client.dispose(), client.dispose()]))
    await within(rejected)
    transport.starting.resolve()
    assert.equal(transport.disposals, 1)
    await assert.rejects(client.submitPrompt('B'), /disposed/)
})

// Real socket tests cover fetch/body reads, WebSocket handshake, and transport
// teardown, not only a fake start() promise.
async function httpMock(handler: http.RequestListener, upgrade?: (socket: import('node:stream').Duplex) => void) {
    const server = http.createServer(handler)
    const sockets = new Set<import('node:net').Socket>()
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    if (upgrade) server.on('upgrade', (_request, socket) => upgrade(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())) },
    }
}

test('R03 real dashboard HTML headers/body and WebSocket handshake obey the absolute turn deadline', async (t) => {
    for (const mode of ['headers', 'body', 'handshake']) await t.test(mode, async () => {
        const backend = await httpMock((_request, response) => {
            if (mode === 'headers') return
            response.writeHead(200, { 'content-type': 'text/html' })
            response.write('<script>window.__HERMES_SESSION_TOKEN__="token";</script>')
            if (mode === 'handshake') response.end()
        }, () => undefined)
        const client = new DashboardWsHermesClient(backend.url, mode === 'handshake' ? 'token' : undefined)
        try {
            const start = Date.now()
            await within(assert.rejects(client.submitPrompt('A', { deadline: start + 60 }), /timed out/))
            assert.ok(Date.now() - start < 1_000)
            await within(client.dispose())
        } finally { await client.dispose(); await backend.close() }
    })
})

test('R11/R12 real dashboard cancellation opens a new socket/session and ignores old-session events', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const address = wss.address()
    assert.ok(typeof address === 'object' && address)
    const sockets: WebSocket[] = []
    const requests: Request[] = []
    wss.on('connection', (socket) => {
        const id = sockets.push(socket)
        socket.on('message', (data) => {
            const request = JSON.parse(data.toString()) as Request
            requests.push(request)
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'session.create' ? { session_id: `ws-session-${id}` } : {} }))
            if (request.method === 'prompt.submit' && id === 2) {
                socket.send(JSON.stringify({ type: 'message.complete', session_id: 'ws-session-1', text: 'old response' }))
                socket.send(JSON.stringify({ type: 'message.complete', session_id: 'ws-session-2', text: 'new response' }))
            }
        })
    })
    const client = new DashboardWsHermesClient(`http://127.0.0.1:${address.port}`, 'token')
    try {
        const pending = client.submitPrompt('A')
        const rejected = assert.rejects(pending, /interrupted/)
        await waitFor(() => requests.some((request) => request.method === 'prompt.submit'))
        await within(client.interrupt())
        await within(rejected)
        assert.equal(await within(client.submitPrompt('B')), 'new response')
        assert.equal(sockets.length, 2)
        assert.equal(requests.filter((request) => request.method === 'session.create').length, 2)
    } finally {
        await client.dispose()
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
})

test('R01 real missing executable/cwd and immediate exit reject safely; corrected configuration retries', async () => {
    const original = { HERMES_PYTHON: process.env.HERMES_PYTHON, HERMES_ROOT: process.env.HERMES_ROOT }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-runtime-audit-'))
    const helper = path.join(temp, 'mock-python')
    const client = new StdioHermesClient()
    try {
        process.env.HERMES_ROOT = temp
        process.env.HERMES_PYTHON = path.join(temp, 'missing-python')
        await within(assert.rejects(client.submitPrompt('missing executable'), /failed to start|ENOENT/))
        process.env.HERMES_PYTHON = process.execPath
        process.env.HERMES_ROOT = path.join(temp, 'missing-cwd')
        await within(assert.rejects(client.submitPrompt('missing cwd'), /failed to start|ENOENT/))
        process.env.HERMES_ROOT = temp
        // Node rejects the Python -m flag and exits immediately after spawning.
        await within(assert.rejects(client.submitPrompt('immediate exit'), /exited|closed|stdin/))
        await writeFile(helper, `#!${process.execPath}\nconst readline = require('node:readline');
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => { const m=JSON.parse(line); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(m.method==='session.create') send({jsonrpc:'2.0',id:m.id,result:{session_id:'stdio-recovered'}});
else { send({jsonrpc:'2.0',id:m.id,result:{}}); if(m.method==='prompt.submit') {
const waiting=m.params.text==='waiting'||m.params.text==='ignoreTERM';
if(m.params.text==='ignoreTERM') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
send({type:waiting?'message.delta':'message.complete',session_id:m.params.session_id,text:waiting?'ready':'recovered'}); } } });
`)
        await chmod(helper, 0o700)
        process.env.HERMES_PYTHON = helper
        assert.equal(await within(client.submitPrompt('corrected'), 2_000), 'recovered')
        const stream = client.streamPrompt('waiting')
        assert.deepEqual(await within(stream.next()), { done: false, value: { type: 'delta', text: 'ready' } })
        const failed = stream.next()
        const rejected = assert.rejects(failed, /stdin failed/)
        // Inject a real Node pipe error, not a fake transport exception.
        const internals = client as unknown as { transport: { process?: import('node:child_process').ChildProcessWithoutNullStreams } }
        assert.ok(internals.transport.process)
        internals.transport.process.stdin.destroy(new Error('private pipe error'))
        await within(rejected)
        assert.equal(await within(client.submitPrompt('after pipe failure'), 2_000), 'recovered')
        const stubborn = client.streamPrompt('ignoreTERM')
        assert.equal((await within(stubborn.next())).value?.type, 'delta')
        const child = internals.transport.process!
        const interrupted = assert.rejects(stubborn.next(), /interrupted/)
        await within(client.interrupt())
        await within(interrupted)
        assert.equal(child.signalCode, 'SIGKILL', 'dispose must escalate and reap a child which ignores SIGTERM')
    } finally {
        await client.dispose()
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()))
        assert.ok(path.basename(temp).startsWith('hermes-runtime-audit-'))
        await rm(temp, { recursive: true, force: true })
    }
})

for (const mode of ['interrupt', 'abort', 'dispose'] as const) {
    test(`R12/R23 ${mode} retires completed RPC producer while consumer awaits TTS`, async () => {
        const transport = new ScriptedTransport()
        transport.onRequest = (request, connection) => {
            if (request.method === 'session.create') reply(connection, request, { session_id: `session-${++transport.sessionCount}` })
            else if (request.method === 'prompt.submit') {
                reply(connection, request, { status: 'streaming' })
                event(connection, 'message.delta', String(request.params.session_id), String(request.params.text))
                event(connection, 'message.complete', String(request.params.session_id), String(request.params.text))
            } else reply(connection, request, {})
        }
        const client = new RpcHermesClient(transport)
        const controller = new AbortController()
        const old = client.streamPrompt('old', { signal: controller.signal })
        try {
            assert.equal((await within(old.next())).value?.type, 'delta')
            if (mode === 'interrupt') await within(client.interrupt())
            else if (mode === 'abort') controller.abort()
            else await within(client.dispose())
            if (mode === 'dispose') {
                await assert.rejects(within(old.next()), /disposed/)
                await assert.rejects(client.submitPrompt('new'), /disposed/)
            } else {
                const next = client.streamPrompt('new')
                try {
                    assert.deepEqual((await within(next.next())).value, { type: 'delta', text: 'new' })
                    await assert.rejects(within(old.next()), /interrupted/)
                    await assert.rejects(client.submitPrompt('concurrent'), /already active/)
                    assert.deepEqual(await within(collect(next)), [{ type: 'complete', text: 'new' }])
                    assert.equal(await within(client.submitPrompt('third')), 'third')
                    assert.equal(transport.sessionCount, 2)
                    assert.equal(transport.connections.length, 2)
                    assert.equal(transport.disposals, 1)
                } finally { await next.return(undefined) }
            }
        } finally { await old.return(undefined); await client.dispose() }
    })
}
