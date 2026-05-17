import { createInterface } from 'readline'

type JsonRpcRequest = {
    jsonrpc?: string
    id?: number | string
    method?: string
    params?: unknown
}

type ToolDefinition = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
}

const tools: ToolDefinition[] = [
    {
        name: 'stackchan_get_head_angles',
        description: 'Get the current StackChan head yaw and pitch angles.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_set_head_angles',
        description: 'Move StackChan head to the specified yaw and/or pitch angles.',
        inputSchema: {
            type: 'object',
            properties: {
                yaw: { type: 'number', minimum: -128, maximum: 128 },
                pitch: { type: 'number', minimum: -128, maximum: 128 },
                speed: { type: 'number', minimum: 1, maximum: 255, default: 150 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_set_led_color',
        description: 'Set StackChan RGB LED color.',
        inputSchema: {
            type: 'object',
            properties: {
                red: { type: 'integer', minimum: 0, maximum: 168 },
                green: { type: 'integer', minimum: 0, maximum: 168 },
                blue: { type: 'integer', minimum: 0, maximum: 168 },
            },
            required: ['red', 'green', 'blue'],
            additionalProperties: false,
        },
    },
]

function controlUrl(): string {
    return process.env.STACKCHAN_CONTROL_URL ??
        `http://127.0.0.1:${process.env.STACKCHAN_CONTROL_PORT ?? '8766'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function respond(id: JsonRpcRequest['id'], result: unknown): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id: JsonRpcRequest['id'], code: number, message: string): void {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function callBridge(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${controlUrl()}/tools/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args }),
    })
    const body = await res.json() as unknown
    if (!res.ok || !isRecord(body) || body['success'] !== true) {
        const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`
        throw new Error(error)
    }
    return body['result']
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
    if (req.method === 'initialize') {
        respond(req.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'stackchan-robot', version: '1.0.0' },
        })
        return
    }

    if (req.method === 'tools/list') {
        respond(req.id, { tools })
        return
    }

    if (req.method === 'tools/call') {
        if (!isRecord(req.params) || typeof req.params['name'] !== 'string') {
            respondError(req.id, -32602, 'tools/call requires a tool name')
            return
        }
        const name = req.params['name']
        const args = isRecord(req.params['arguments']) ? req.params['arguments'] : {}
        try {
            const result = await callBridge(name, args)
            respond(req.id, {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: false,
            })
        } catch (error) {
            respond(req.id, {
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            })
        }
        return
    }

    if (req.method?.startsWith('notifications/')) return
    respondError(req.id, -32601, `Unknown method: ${req.method ?? ''}`)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
    if (!line.trim()) return
    try {
        const request = JSON.parse(line) as JsonRpcRequest
        void handleRequest(request)
    } catch (error) {
        respondError(undefined, -32700, error instanceof Error ? error.message : String(error))
    }
})
