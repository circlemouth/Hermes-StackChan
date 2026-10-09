import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { readWebSocketKeepaliveInterval, startWebSocketKeepalive, WEBSOCKET_PONG_TIMEOUT_MS, type WebSocketTerminationReason } from '../src/websocket_keepalive.ts'

class MockWebSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN
    pings = 0
    terminations = 0
    pingError?: Error
    throwOnPing = false
    replyImmediately = false
    pingCallback?: (err?: Error) => void

    ping(_data: unknown, _mask: unknown, callback: (err?: Error) => void): void {
        this.pings++
        if (this.throwOnPing) throw new Error('ping failed')
        this.pingCallback = callback
        if (this.replyImmediately) this.emit('pong', Buffer.alloc(0))
        callback(this.pingError)
    }

    terminate(): void {
        this.terminations++
        this.readyState = WebSocket.CLOSING
        // Real ws emits close asynchronously, not by calling Session.close here.
    }
}

function start(
    ws: MockWebSocket,
    interval = 3000,
    onTermination?: (reason: WebSocketTerminationReason) => void,
): () => void {
    return startWebSocketKeepalive(ws as unknown as WebSocket, interval, onTermination)
}

function assertClean(ws: MockWebSocket): void {
    for (const event of ['pong', 'close', 'error']) assert.equal(ws.listenerCount(event), 0)
}

test('keepalive interval defaults and clamps only finite values', () => {
    for (const raw of [undefined, '', ' ', 'NaN', 'Infinity', '-Infinity', 'bad', NaN, Infinity]) {
        assert.equal(readWebSocketKeepaliveInterval(raw), 3000)
    }
    assert.equal(readWebSocketKeepaliveInterval('3000'), 3000)
    assert.equal(readWebSocketKeepaliveInterval('4500.9'), 4500)
    for (const raw of [0, -500, 999]) assert.equal(readWebSocketKeepaliveInterval(raw), 1000)
    for (const raw of [60_001, 1e100]) assert.equal(readWebSocketKeepaliveInterval(raw), 60_000)
})

test('missing pong terminates after 12s grace and cleanup waits for normal close ownership', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    let sessionCloses = 0
    const reasons: WebSocketTerminationReason[] = []
    ws.on('close', () => sessionCloses++)
    start(ws, 3000, (reason) => reasons.push(reason))
    t.mock.timers.tick(3000)
    assert.equal(ws.pings, 1)
    t.mock.timers.tick(WEBSOCKET_PONG_TIMEOUT_MS - 1)
    assert.equal(ws.terminations, 0)
    assert.equal(ws.pings, 1, 'outstanding ping does not reset its deadline')
    ws.emit('message', Buffer.from('application data is not a pong'))
    t.mock.timers.tick(1)
    assert.equal(ws.terminations, 1)
    assert.deepEqual(reasons, ['pong_timeout'])
    assert.equal(sessionCloses, 0)
    assert.equal(ws.listenerCount('pong'), 0)
    assert.equal(ws.listenerCount('error'), 0)
    assert.equal(ws.listenerCount('close'), 1, 'normal close handler is preserved')
    ws.emit('close')
    assert.equal(sessionCloses, 1)
    t.mock.timers.tick(60_000)
    assert.equal(ws.pings, 1)
    assert.equal(ws.terminations, 1)
    assert.deepEqual(reasons, ['pong_timeout'])
})

test('idle connection remains alive indefinitely with only pong replies', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    const stop = start(ws)
    for (let i = 0; i < 40; i++) {
        t.mock.timers.tick(3000)
        ws.emit('pong', Buffer.alloc(0))
    }
    assert.equal(ws.pings, 40)
    assert.equal(ws.terminations, 0)
    stop()
    assertClean(ws)
    t.mock.timers.tick(60_000)
    assert.equal(ws.pings, 40)
})

test('late healthy pong clears the deadline and a later lost pong still expires', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    start(ws)
    t.mock.timers.tick(3000)
    for (let i = 0; i < 3; i++) t.mock.timers.tick(3000)
    t.mock.timers.tick(2000)
    ws.emit('pong') // 11 seconds after the ping, within the conservative grace.
    t.mock.timers.tick(1000)
    assert.equal(ws.pings, 2)
    assert.equal(ws.terminations, 0, 'original deadline was cleared')
    for (let i = 0; i < 4; i++) t.mock.timers.tick(3000)
    assert.equal(ws.terminations, 1)
    assertClean(ws)
})

test('immediate pong replies also clear the armed deadline', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    ws.replyImmediately = true
    const stop = start(ws)
    for (let i = 0; i < 20; i++) t.mock.timers.tick(3000)
    assert.equal(ws.pings, 20)
    assert.equal(ws.terminations, 0)
    stop()
})

test('normal TCP close cleans pending timers/listeners without termination', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    const reasons: WebSocketTerminationReason[] = []
    const stop = start(ws, 3000, (reason) => reasons.push(reason))
    t.mock.timers.tick(3000)
    ws.readyState = WebSocket.CLOSED
    ws.emit('close')
    stop() // Cleanup is idempotent.
    assertClean(ws)
    t.mock.timers.tick(60_000)
    assert.equal(ws.pings, 1)
    assert.equal(ws.terminations, 0)
    ws.pingCallback?.(new Error('send callback after clean close'))
    assert.deepEqual(reasons, [], 'clean close never reports a transport failure')
})

for (const failure of ['timeout', 'throw', 'callback', 'error event'] as const) {
    for (const callbackThrows of [false, true]) {
        test(`${failure} reports exactly one reason and cleans up${callbackThrows ? ' even if diagnostics throw' : ''}`, (t) => {
            t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
            const ws = new MockWebSocket()
            const reasons: WebSocketTerminationReason[] = []
            const expected: WebSocketTerminationReason = failure === 'timeout'
                ? 'pong_timeout'
                : failure === 'error event' ? 'socket_error' : 'ping_error'
            ws.throwOnPing = failure === 'throw'
            if (failure === 'callback') ws.pingError = new Error('send failed')
            const stop = start(ws, 3000, (reason) => {
                assertClean(ws)
                reasons.push(reason)
                if (callbackThrows) throw new Error('diagnostic callback failed')
            })
            const onError = ws.listeners('error')[0]
            t.mock.timers.tick(3000)
            if (failure === 'timeout') t.mock.timers.tick(WEBSOCKET_PONG_TIMEOUT_MS)
            if (failure === 'error event') ws.emit('error', new Error('private socket detail'))
            assert.equal(ws.terminations, 1)
            assert.deepEqual(reasons, [expected], 'only a fixed reason reaches diagnostics')
            assertClean(ws)
            // Late callbacks, a queued error handler, close and repeated stop cannot
            // report a second failure or terminate the already-stopped transport.
            ws.pingCallback?.(new Error('late send failure'))
            onError(new Error('late socket failure'))
            ws.emit('close', 1006, Buffer.from('private close reason'))
            stop()
            stop()
            t.mock.timers.tick(60_000)
            assert.equal(ws.terminations, 1)
            assert.equal(ws.pings, 1)
            assert.deepEqual(reasons, [expected])
            assertClean(ws)
        })
    }
}

test('closing socket is not pinged and timers/listeners are stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const ws = new MockWebSocket()
    start(ws, NaN)
    ws.readyState = WebSocket.CLOSING
    t.mock.timers.tick(3000)
    assertClean(ws)
    t.mock.timers.tick(60_000)
    assert.equal(ws.pings, 0)
    assert.equal(ws.terminations, 0)
})
