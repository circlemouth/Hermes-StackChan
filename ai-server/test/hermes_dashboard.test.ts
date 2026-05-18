import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { HermesClient, extractDashboardSessionToken } from '../src/hermes.ts'

type DashboardMock = {
    url: string
    requests: Array<Record<string, unknown>>
    close: () => Promise<void>
}

const originalEnv = {
    HERMES_CONNECT_MODE: process.env.HERMES_CONNECT_MODE,
    HERMES_DASHBOARD_URL: process.env.HERMES_DASHBOARD_URL,
    HERMES_DASHBOARD_TOKEN: process.env.HERMES_DASHBOARD_TOKEN,
}

function restoreEnv(): void {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
    socket.send(JSON.stringify(payload))
}

async function startDashboardMock(html: string): Promise<DashboardMock> {
    const requests: Array<Record<string, unknown>> = []
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
    })
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/api/ws' || url.searchParams.get('token') !== 'abc123') {
            socket.destroy()
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req)
        })
    })

    wss.on('connection', (ws) => {
        send(ws, { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } })
        ws.on('message', (data) => {
            const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>
            requests.push(message)
            if (message['method'] === 'session.create') {
                send(ws, { jsonrpc: '2.0', id: message['id'], result: { session_id: 'stackchan-test-session' } })
                return
            }
            if (message['method'] === 'prompt.submit') {
                send(ws, { jsonrpc: '2.0', id: message['id'], result: { status: 'streaming' } })
                send(ws, {
                    jsonrpc: '2.0',
                    method: 'event',
                    params: {
                        type: 'message.complete',
                        session_id: 'some-existing-dashboard-session',
                        text: 'これは別セッション',
                    },
                })
                send(ws, {
                    jsonrpc: '2.0',
                    method: 'event',
                    params: {
                        type: 'message.complete',
                        session_id: 'stackchan-test-session',
                        payload: { text: 'やあ' },
                    },
                })
                return
            }
            if (message['method'] === 'session.interrupt') {
                send(ws, { jsonrpc: '2.0', id: message['id'], result: { interrupted: true } })
            }
        })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')

    return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: async () => {
            await new Promise<void>((resolve) => wss.close(() => resolve()))
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

test.afterEach(() => {
    restoreEnv()
})

test('extractDashboardSessionToken reads Hermes Dashboard HTML token', () => {
    assert.equal(
        extractDashboardSessionToken('<script>window.__HERMES_SESSION_TOKEN__="abc123";</script>'),
        'abc123',
    )
    assert.equal(
        extractDashboardSessionToken("<script>window.__HERMES_SESSION_TOKEN__ = 'def456'</script>"),
        'def456',
    )
    assert.equal(extractDashboardSessionToken('<html></html>'), null)
})

test('HermesClient connects to Dashboard /api/ws, creates a separate session, submits prompts, and interrupts it', async () => {
    const dashboard = await startDashboardMock('<script>window.__HERMES_SESSION_TOKEN__="abc123";</script>')
    process.env.HERMES_CONNECT_MODE = 'dashboard_ws'
    process.env.HERMES_DASHBOARD_URL = dashboard.url
    delete process.env.HERMES_DASHBOARD_TOKEN

    const client = new HermesClient()
    try {
        assert.equal(await client.submitPrompt('こんにちは'), 'やあ')
        await client.interrupt()
    } finally {
        await client.dispose()
        await dashboard.close()
    }

    assert.deepEqual(
        dashboard.requests.map((request) => request['method']),
        ['session.create', 'prompt.submit', 'session.interrupt'],
    )
    assert.deepEqual(dashboard.requests[0]['params'], {})
    assert.deepEqual(dashboard.requests[1]['params'], {
        session_id: 'stackchan-test-session',
        text: 'こんにちは',
    })
    assert.deepEqual(dashboard.requests[2]['params'], {
        session_id: 'stackchan-test-session',
    })
})

test('HermesClient reports a clear error when Dashboard token is missing', async () => {
    const dashboard = await startDashboardMock('<html><body>no token</body></html>')
    process.env.HERMES_CONNECT_MODE = 'dashboard_ws'
    process.env.HERMES_DASHBOARD_URL = dashboard.url
    delete process.env.HERMES_DASHBOARD_TOKEN

    const client = new HermesClient()
    try {
        await assert.rejects(
            () => client.submitPrompt('こんにちは'),
            /window\.__HERMES_SESSION_TOKEN__|HERMES_DASHBOARD_TOKEN/,
        )
    } finally {
        await client.dispose()
        await dashboard.close()
    }
})
