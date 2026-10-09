import { WebSocket } from 'ws'

const DEFAULT_INTERVAL_MS = 3000
export const WEBSOCKET_PONG_TIMEOUT_MS = 12_000

export function readWebSocketKeepaliveInterval(raw?: string | number): number {
    const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw)
    return Number.isFinite(value)
        ? Math.min(60_000, Math.max(1000, Math.trunc(value)))
        : DEFAULT_INTERVAL_MS
}

// Only transport PONGs prove liveness; idle listening needs no application traffic.
// Termination uses the socket's normal close event for Session ownership cleanup.
export type WebSocketTerminationReason = 'pong_timeout' | 'ping_error' | 'socket_error'

export function startWebSocketKeepalive(
    ws: WebSocket,
    intervalMs: number,
    onTermination?: (reason: WebSocketTerminationReason) => void,
): () => void {
    let stopped = false
    let pongDeadline: ReturnType<typeof setTimeout> | undefined

    const onPong = (): void => {
        if (pongDeadline !== undefined) clearTimeout(pongDeadline)
        pongDeadline = undefined
    }
    const stop = (): void => {
        if (stopped) return
        stopped = true
        clearInterval(interval)
        onPong()
        ws.off('pong', onPong)
        ws.off('close', stop)
        ws.off('error', onError)
    }
    const terminate = (reason: WebSocketTerminationReason): void => {
        if (stopped) return
        stop()
        try {
            onTermination?.(reason)
        } catch {
            // Diagnostics must not interfere with transport or Session cleanup.
        }
        ws.terminate()
    }
    // EventEmitter passes the raw error to listeners; never forward it as a reason.
    const onError = (): void => terminate('socket_error')
    const interval = setInterval(() => {
        if (stopped) return
        if (ws.readyState !== WebSocket.OPEN) {
            stop()
            return
        }
        // Never replace an outstanding deadline: repeated pings must not keep a
        // silent peer alive forever. Allow 12s, not just one 3s interval, to reply.
        if (pongDeadline !== undefined) return
        pongDeadline = setTimeout(() => terminate('pong_timeout'), WEBSOCKET_PONG_TIMEOUT_MS)
        try {
            ws.ping(undefined, undefined, (err?: Error) => {
                if (err) terminate('ping_error')
            })
        } catch {
            terminate('ping_error')
        }
    }, readWebSocketKeepaliveInterval(intervalMs))

    ws.on('pong', onPong)
    ws.on('close', stop)
    ws.on('error', onError)
    return stop
}
