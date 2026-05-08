import { randomUUID } from 'crypto'
import type WebSocket from 'ws'
import { decodeOpusFrames, encodeWavToOpusFrames, extractOpusPayload, wrapOpusPayload, OUTPUT_SAMPLE_RATE, OUTPUT_FRAME_DURATION_MS } from './audio.js'
import { transcribe } from './stt.js'
import { chat, type Message } from './llm.js'
import { synthesize } from './tts.js'

type State = 'idle' | 'listening' | 'processing'

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ??
    'あなたはStackChanという小さなロボットです。明るく元気に日本語で話します。'

export class Session {
    private readonly sessionId = randomUUID()
    private state: State = 'idle'
    private version = 3
    private opusFrames: Buffer[] = []
    private messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]

    constructor(private readonly ws: WebSocket) {}

    handleMessage(data: Buffer | string): void {
        if (typeof data === 'string') {
            try {
                this.handleJson(JSON.parse(data) as Record<string, unknown>)
            } catch {
                console.error('[session] JSON parse error')
            }
        } else {
            this.handleBinary(data)
        }
    }

    private handleBinary(data: Buffer): void {
        if (this.state !== 'listening') return
        const payload = extractOpusPayload(data, this.version)
        if (payload) this.opusFrames.push(payload)
    }

    private handleJson(msg: Record<string, unknown>): void {
        const type = msg['type'] as string | undefined

        if (type === 'hello') {
            this.version = (msg['version'] as number | undefined) ?? 3
            this.sendJson({
                type: 'hello',
                transport: 'websocket',
                session_id: this.sessionId,
                audio_params: {
                    sample_rate: OUTPUT_SAMPLE_RATE,
                    frame_duration: OUTPUT_FRAME_DURATION_MS,
                },
            })
            console.log(`[session ${this.sessionId}] hello, protocol version=${this.version}`)
            return
        }

        if (type === 'listen') {
            const listenState = msg['state'] as string | undefined
            if (listenState === 'start' || listenState === 'detect') {
                this.state = 'listening'
                this.opusFrames = []
            } else if (listenState === 'stop' && this.state === 'listening') {
                this.state = 'processing'
                this.process().catch((err) => {
                    console.error('[session] process error:', err)
                }).finally(() => {
                    this.state = 'idle'
                })
            }
        }

        if (type === 'abort') {
            this.state = 'idle'
        }
    }

    private async process(): Promise<void> {
        const frames = this.opusFrames.splice(0)
        if (frames.length === 0) return

        // 1. Opus → PCM → Whisper
        const pcm = decodeOpusFrames(frames)
        if (pcm.length === 0) return

        const text = await transcribe(pcm, 16000)
        console.log(`[session ${this.sessionId}] STT: "${text}"`)
        this.sendJson({ type: 'stt', text })

        if (!text.trim()) return

        // 2. LLM
        this.messages.push({ role: 'user', content: text })
        const reply = await chat(this.messages)
        this.messages.push({ role: 'assistant', content: reply })
        console.log(`[session ${this.sessionId}] LLM: "${reply}"`)
        this.sendJson({ type: 'llm', emotion: 'neutral' })

        // 3. TTS → Opus → device
        const wav = await synthesize(reply)
        const opusFrames = encodeWavToOpusFrames(wav)

        this.sendJson({ type: 'tts', state: 'start' })
        this.sendJson({ type: 'tts', state: 'sentence_start', text: reply })
        for (const frame of opusFrames) {
            if (this.state !== 'processing') break  // abortされた場合は中断
            this.sendBinary(wrapOpusPayload(frame, this.version))
        }
        this.sendJson({ type: 'tts', state: 'sentence_end', text: reply })
        this.sendJson({ type: 'tts', state: 'stop' })
    }

    private sendJson(obj: Record<string, unknown>): void {
        try {
            this.ws.send(JSON.stringify(obj))
        } catch {
            // 切断済みの場合は無視
        }
    }

    private sendBinary(data: Buffer): void {
        try {
            this.ws.send(data)
        } catch {
            // 切断済みの場合は無視
        }
    }
}
