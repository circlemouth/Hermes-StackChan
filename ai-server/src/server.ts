import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { Session } from './session.js'
import { serveMediaRequest, setObservedMediaBaseUrl } from './media.js'
import { readWebSocketKeepaliveInterval, startWebSocketKeepalive } from './websocket_keepalive.js'

const DEVICE_KEEPALIVE_INTERVAL_MS = readWebSocketKeepaliveInterval(process.env.STACKCHAN_WS_KEEPALIVE_MS)

export function startServer(port: number): void {
    const server = http.createServer((req, res) => {
        if (serveMediaRequest(req, res)) return
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
    })
    const wss = new WebSocketServer({ server, path: '/ws' })

    server.on('listening', () => {
        console.log('[server] WebSocket server listening')
        console.log('[server] Media server listening')
    })

    wss.on('connection', (ws: WebSocket, req) => {
        if (req.headers.host) {
            setObservedMediaBaseUrl(`http://${req.headers.host}`)
        }
        console.log('[server] connected')

        const session = new Session(ws)
        ws.on('message', (data: Buffer | string) => {
            session.handleMessage(data)
        })

        ws.on('close', (code: number) => {
            console.log(`[server] disconnected: ${code}`)
            session.close()
        })

        // Keep consuming errors after keepalive cleanup; diagnostics below report
        // only a fixed reason, never the error object or connection metadata.
        ws.on('error', () => {})

        startWebSocketKeepalive(ws, DEVICE_KEEPALIVE_INTERVAL_MS, (reason) => {
            console.error(`[server] transport terminated: ${reason}`)
        })
    })

    server.listen(port, '0.0.0.0')
}
