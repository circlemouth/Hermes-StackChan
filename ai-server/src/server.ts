import { WebSocketServer, type WebSocket } from 'ws'
import { Session } from './session.js'

export function startServer(port: number): void {
    const wss = new WebSocketServer({ port })

    wss.on('listening', () => {
        console.log(`[server] WebSocket server listening on ws://0.0.0.0:${port}/ws`)
    })

    wss.on('connection', (ws: WebSocket, req) => {
        const ip = req.socket.remoteAddress ?? 'unknown'
        console.log(`[server] connected: ${ip}`)

        const session = new Session(ws)

        ws.on('message', (data: Buffer | string) => {
            session.handleMessage(data)
        })

        ws.on('close', () => {
            console.log(`[server] disconnected: ${ip}`)
        })

        ws.on('error', (err) => {
            console.error(`[server] error from ${ip}:`, err.message)
        })
    })
}
