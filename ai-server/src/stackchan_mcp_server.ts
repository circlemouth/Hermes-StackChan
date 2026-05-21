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
        name: 'stackchan_get_status',
        description: [
            'Get local StackChan status, including battery, charging, Wi-Fi state, volume, brightness, firmware version,',
            'Hermes autostart, and whether the bridge WebSocket is configured.',
            'The firmware does not expose the full bridge URL or secrets.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
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
    {
        name: 'stackchan_power_off',
        description: 'Power off the physical StackChan. Use only when the user explicitly asks to turn it off.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_take_photo',
        description: [
            'Capture one still photo from StackChan camera and return it as an MCP image content block.',
            'Use this when the user asks you to look, see, inspect, identify something, read visible text, or asks "what is this?".',
            'If the MCP client returns a MEDIA: path after this tool result, pass that path to vision_analyze for visual reasoning.',
            'Do not use this for video streaming or continuous monitoring.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                quality: { type: 'integer', minimum: 1, maximum: 100, default: 80 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_display_image',
        description: [
            'Display an image on StackChan screen for a short preview.',
            'Accepts an HTTP/HTTPS image URL, a local image path, or a MEDIA: path produced by Hermes tools.',
            'Use this when you generate or receive an image that would be useful for the user to see on the physical StackChan display.',
            'JPEG and PNG are supported by the firmware preview path.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                source: {
                    type: 'string',
                    description: 'HTTP/HTTPS URL, local file path, file:// URL, or image path to display.',
                },
                duration_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 6 },
            },
            required: ['source'],
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_capture_screen',
        description: [
            'Capture the current StackChan screen and return it as an MCP image content block.',
            'Use this when you need to inspect what is currently visible on the physical device display.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                quality: { type: 'integer', minimum: 1, maximum: 100, default: 80 },
            },
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

function parseFirmwareImage(value: unknown): Record<string, unknown> | null {
    const image = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!isRecord(image)) return null
    if (image['type'] !== 'image') return null
    if (typeof image['mimeType'] !== 'string' || typeof image['data'] !== 'string') return null
    return {
        type: 'image',
        mimeType: image['mimeType'],
        data: image['data'],
    }
}

export function normalizeBridgeResultToMcpContent(result: unknown): Array<Record<string, unknown>> {
    if (!isRecord(result) || !Array.isArray(result['content'])) {
        return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }

    const content: Array<Record<string, unknown>> = []
    for (const item of result['content']) {
        if (!isRecord(item) || typeof item['type'] !== 'string') continue
        if (item['type'] === 'text' && typeof item['text'] === 'string') {
            content.push({ type: 'text', text: item['text'] })
            continue
        }
        if (item['type'] === 'image') {
            if (typeof item['mimeType'] === 'string' && typeof item['data'] === 'string') {
                content.push({ type: 'image', mimeType: item['mimeType'], data: item['data'] })
                continue
            }
            if ('image' in item) {
                try {
                    const parsed = parseFirmwareImage(item['image'])
                    if (parsed) content.push(parsed)
                } catch {
                    // Fall through to text fallback below if no usable image block was found.
                }
            }
        }
    }

    return content.length > 0 ? content : [{ type: 'text', text: JSON.stringify(result, null, 2) }]
}

export async function handleRequest(req: JsonRpcRequest): Promise<void> {
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
                content: normalizeBridgeResultToMcpContent(result),
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

export function startStdioServer(): void {
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
}

if (require.main === module) {
    startStdioServer()
}
