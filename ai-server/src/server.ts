import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { Session } from './session.js'
import { serveMediaRequest, setObservedMediaBaseUrl } from './media.js'

const DEVICE_KEEPALIVE_INTERVAL_MS = Math.max(1000, Number(process.env.STACKCHAN_WS_KEEPALIVE_MS ?? '3000') || 3000)

export function startServer(port: number): void {
    const server = http.createServer((req, res) => {
        if (serveMediaRequest(req, res)) return
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
    })
    const wss = new WebSocketServer({ server, path: '/ws' })

    server.on('listening', () => {
        console.log(`[server] WebSocket server listening on ws://0.0.0.0:${port}/ws`)
        console.log(`[server] Media server listening on http://0.0.0.0:${port}/media/...`)
    })

    wss.on('connection', (ws: WebSocket, req) => {
        const ip = req.socket.remoteAddress ?? 'unknown'
        if (req.headers.host) {
            setObservedMediaBaseUrl(`http://${req.headers.host}`)
        }
        console.log(`[server] connected: ${ip}`)

        const session = new Session(ws)
        const keepaliveTimer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return
            try {
                ws.ping()
            } catch {
                // The close handler will clean up the session.
            }
        }, DEVICE_KEEPALIVE_INTERVAL_MS)

        ws.on('message', (data: Buffer | string) => {
            session.handleMessage(data)
        })

        ws.on('close', () => {
            clearInterval(keepaliveTimer)
            console.log(`[server] disconnected: ${ip}`)
            session.close()
        })

        ws.on('error', (err) => {
            console.error(`[server] error from ${ip}:`, err.message)
        })
    })

    server.listen(port, '0.0.0.0')
}
