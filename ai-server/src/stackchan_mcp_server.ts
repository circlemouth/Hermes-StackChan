import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import { HermesClient } from './hermes.js'

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

const HERMES_SUBAGENT_TOOL_NAME = 'stackchan_ask_hermes_subagent'

export const tools: ToolDefinition[] = [
    {
        name: 'stackchan_get_status',
        description: [
            'Get local StackChan status, including battery, charging, Wi-Fi state, volume, brightness, firmware version,',
            'HERMES Launcher auto-open setting, and whether the bridge WebSocket is configured.',
            'The firmware does not expose the full bridge URL or secrets.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_set_speaker_volume',
        description: [
            'Set the physical StackChan speaker volume from 0 to 100.',
            'Use temporary low values such as 25-45 when diagnosing distorted or noisy M5 speaker output.',
            'Set permanent only when the user explicitly asks to save the volume.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                volume: { type: 'integer', minimum: 0, maximum: 100 },
                permanent: { type: 'boolean', default: false },
            },
            required: ['volume'],
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_play_test_tone',
        description: [
            'Play a short diagnostic sine tone directly on the physical StackChan speaker.',
            'This bypasses Hermes, TTS, and Opus streaming, so it is useful for isolating M5 speaker, codec, and firmware output issues.',
            'Use low amplitude and short duration unless the user explicitly asks for a louder test.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                frequency_hz: { type: 'integer', minimum: 100, maximum: 2000, default: 440 },
                duration_ms: { type: 'integer', minimum: 100, maximum: 3000, default: 800 },
                amplitude: { type: 'integer', minimum: 500, maximum: 16000, default: 6000 },
            },
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
        description: [
            'Move StackChan head to a yaw and/or pitch angle.',
            'Use small, infrequent movements during conversation so the robot feels alive without being distracting.',
            'For attention, return yaw near 0 and pitch slightly upward.',
            'Do not narrate the motion unless the user asks what you are doing.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                yaw: { type: 'number', minimum: -128, maximum: 128 },
                pitch: { type: 'number', minimum: 0, maximum: 90 },
                speed: { type: 'number', minimum: 100, maximum: 1000, default: 150 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_set_led_color',
        description: [
            'Set StackChan RGB LED color as a subtle nonverbal cue.',
            'Use this sparingly, for example soft green while listening, soft blue while speaking, or off when idle.',
            'Values are limited to 0..168 for safe brightness.',
        ].join(' '),
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
    {
        name: HERMES_SUBAGENT_TOOL_NAME,
        description: [
            'Delegate a slow or multi-step user request to a background Hermes sub-agent.',
            'Use this when StackChan should acknowledge quickly instead of making the user wait for research, code work, long reasoning, or tool-heavy work.',
            'After calling this tool, immediately tell the user in one short phrase that you are working on it.',
            'The sub-agent result will be reported back to the active StackChan session later.',
            'Do not use this for simple greetings or questions you can answer immediately.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 12000,
                    description: 'The user request or task to delegate to the background Hermes sub-agent.',
                },
                guidance: {
                    type: 'string',
                    maxLength: 2000,
                    description: 'Optional guidance about output format, language, or constraints for the sub-agent.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_create_reminder',
        description: [
            'Create a local reminder on the physical StackChan.',
            'Use this when the user asks StackChan to remind them after a relative duration, such as "remind me in 10 minutes".',
            'The device will display and play a local notification when the reminder fires.',
            'Do not use this for calendar scheduling at an absolute date unless you can convert it to a relative duration.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                duration_seconds: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 86400,
                    description: 'Relative reminder delay in seconds.',
                },
                message: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 120,
                    description: 'Short message to show when the reminder fires.',
                },
                repeat: {
                    type: 'boolean',
                    default: false,
                    description: 'Whether the reminder repeats using the same duration.',
                },
            },
            required: ['duration_seconds', 'message'],
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_get_reminders',
        description: 'Get active local StackChan reminders.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'stackchan_stop_reminder',
        description: 'Stop a local StackChan reminder by ID. Use stackchan_get_reminders first if the ID is unknown.',
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    type: 'integer',
                    description: 'Reminder ID returned by stackchan_create_reminder or stackchan_get_reminders.',
                },
            },
            required: ['id'],
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

function readStringArg(args: Record<string, unknown>, name: string, maxChars: number): string {
    const value = args[name]
    return typeof value === 'string' ? value.trim().slice(0, maxChars) : ''
}

function buildSubagentPrompt(query: string, guidance: string): string {
    const prefix = process.env.HERMES_SUBAGENT_PROMPT_PREFIX ?? [
        'You are a background Hermes sub-agent for StackChan.',
        'Solve the delegated request carefully and independently.',
        'Return a concise answer in the user’s language unless guidance says otherwise.',
        'Do not mention internal tool mechanics unless it is useful to the user.',
        `Do not call ${HERMES_SUBAGENT_TOOL_NAME}; you are already the background sub-agent.`,
    ].join(' ')
    return `${prefix}\n\nUser request:\n${query}${guidance ? `\n\nGuidance:\n${guidance}` : ''}`
}

export function buildSubagentFollowupPrompt(query: string, answer: string): string {
    return [
        '$Hermesサブエージェントから応答が届きました。',
        '先ほどのユーザー依頼への続報として、ユーザーに自然な会話で短く伝えてください。',
        '内部のtool名や実装詳細は話さず、必要な結論と次にできることだけを伝えてください。',
        `このフォローアップでは ${HERMES_SUBAGENT_TOOL_NAME} を使わず、下の回答を要約して伝えてください。`,
        '',
        `ユーザー依頼:\n${query}`,
        '',
        `サブエージェント回答:\n${answer}`,
    ].join('\n')
}


async function postFollowup(prompt: string): Promise<void> {
    const res = await fetch(`${controlUrl()}/internal/followup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
    })
    const body = await res.json().catch(() => undefined) as unknown
    if (!res.ok || !isRecord(body) || body['success'] !== true) {
        const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`
        throw new Error(error)
    }
}

async function runHermesSubagentTask(taskId: string, query: string, guidance: string): Promise<void> {
    const client = new HermesClient()
    try {
        const answer = await client.submitPrompt(buildSubagentPrompt(query, guidance))
        await postFollowup(buildSubagentFollowupPrompt(query, answer))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await postFollowup(buildSubagentFollowupPrompt(
            query,
            `サブエージェント処理でエラーが発生しました。task_id=${taskId}: ${message}`,
        )).catch((followupError) => {
            console.error(`[stackchan_mcp] subagent follow-up failed task=${taskId}:`, followupError)
        })
    } finally {
        await client.dispose().catch(() => undefined)
    }
}

export function startHermesSubagentTask(args: Record<string, unknown>): { taskId: string; message: string } {
    const query = readStringArg(args, 'query', 12000)
    if (!query) throw new Error(`${HERMES_SUBAGENT_TOOL_NAME} requires query`)
    const guidance = readStringArg(args, 'guidance', 2000)
    const taskId = randomUUID()
    void runHermesSubagentTask(taskId, query, guidance).catch((error) => {
        console.error(`[stackchan_mcp] subagent task failed task=${taskId}:`, error)
    })
    return {
        taskId,
        message: `Hermes sub-agent task ${taskId} accepted. Give the user a short acknowledgement now; the result will be reported later.`,
    }
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
            if (name === HERMES_SUBAGENT_TOOL_NAME) {
                const result = startHermesSubagentTask(args)
                respond(req.id, {
                    content: [{ type: 'text', text: result.message }],
                    isError: false,
                })
                return
            }

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
