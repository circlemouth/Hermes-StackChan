import http from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { Session } from './session.js'
import { serveMediaRequest, setObservedMediaBaseUrl } from './media.js'

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

        ws.on('message', (data: Buffer | string) => {
            session.handleMessage(data)
        })

        ws.on('close', () => {
            console.log(`[server] disconnected: ${ip}`)
            session.close()
        })

        ws.on('error', (err) => {
            console.error(`[server] error from ${ip}:`, err.message)
        })
    })

    server.listen(port, '0.0.0.0')
}
