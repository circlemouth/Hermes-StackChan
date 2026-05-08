import { randomUUID } from 'crypto'
import type WebSocket from 'ws'
import { decodeOpusFrames, encodeWavToOpusFrames, extractOpusPayload, wrapOpusPayload, OUTPUT_SAMPLE_RATE, OUTPUT_FRAME_DURATION_MS } from './audio.js'
import { transcribe } from './stt.js'
import { chat, type Message } from './llm.js'
import { synthesize } from './tts.js'
import { elapsedMs, nowMs, withTiming } from './timing.js'

type State = 'idle' | 'listening' | 'processing'

// auto モード: フレームが途切れてから処理開始するまでの無音判定時間 (ms)
const SILENCE_TIMEOUT_MS = 1500
// 最長録音時間 (ms) — 無音検知がなくても強制処理
const MAX_RECORDING_MS = 15000
// STT を呼ぶ最低フレーム数 (10フレーム × 60ms = 600ms 未満は無音とみなす)
const MIN_FRAMES_FOR_STT = 10
// TTS 再生後、次の listen start を受け付けるまでのクールダウン (ms) — エコー誤検知防止
const POST_TTS_COOLDOWN_MS = 2000

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ??
    'あなたはStackChanという小さなロボットです。明るく元気に日本語で話します。'

export class Session {
    private readonly sessionId = randomUUID()
    private state: State = 'idle'
    private version = 3
    private opusFrames: Buffer[] = []
    private messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]
    private silenceTimer?: ReturnType<typeof setTimeout>
    private maxDurationTimer?: ReturnType<typeof setTimeout>
    private cooldownUntil = 0

    constructor(private readonly ws: WebSocket) {}

    handleMessage(data: Buffer | string): void {
        if (typeof data === 'string') {
            try {
                this.handleJson(JSON.parse(data) as Record<string, unknown>)
            } catch (e) {
                console.error('[session] JSON parse error:', e)
            }
        } else {
            const str = data.toString('utf8')
            if (str.startsWith('{') || str.startsWith('[')) {
                try {
                    this.handleJson(JSON.parse(str) as Record<string, unknown>)
                    return
                } catch {
                    // JSON でなければバイナリとして処理
                }
            }
            this.handleBinary(data)
        }
    }

    private handleBinary(data: Buffer): void {
        if (this.state !== 'listening') return
        const payload = extractOpusPayload(data, this.version)
        if (payload) {
            this.opusFrames.push(payload)
            this.resetSilenceTimer()
        }
    }

    private resetSilenceTimer(): void {
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
        this.silenceTimer = setTimeout(() => {
            console.log(`[session ${this.sessionId}] silence detected, triggering process`)
            this.triggerProcess()
        }, SILENCE_TIMEOUT_MS)
    }

    private clearTimers(): void {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = undefined }
        if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = undefined }
    }

    private triggerProcess(): void {
        if (this.state !== 'listening') return
        this.clearTimers()
        if (this.opusFrames.length < MIN_FRAMES_FOR_STT) {
            console.log(`[session ${this.sessionId}] too few frames (${this.opusFrames.length}), skipping`)
            this.opusFrames = []
            this.state = 'idle'
            return
        }
        this.state = 'processing'
        this.process().catch((err) => {
            console.error(`[session ${this.sessionId}] process error:`, err)
        }).finally(() => {
            this.state = 'idle'
        })
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
                if (Date.now() < this.cooldownUntil) {
                    console.log(`[session ${this.sessionId}] listen start ignored (post-TTS cooldown)`)
                    return
                }
                this.clearTimers()
                this.state = 'listening'
                this.opusFrames = []
                // 最長録音タイマーをセット
                this.maxDurationTimer = setTimeout(() => {
                    console.log(`[session ${this.sessionId}] max duration reached, triggering process`)
                    this.triggerProcess()
                }, MAX_RECORDING_MS)
                console.log(`[session ${this.sessionId}] listening started (mode=${msg['mode']})`)
            } else if (listenState === 'stop') {
                this.triggerProcess()
            }
        }

        if (type === 'abort') {
            this.clearTimers()
            this.state = 'idle'
        }
    }

    private async process(): Promise<void> {
        const processStartMs = nowMs()
        const frames = this.opusFrames.splice(0)
        console.log(`[session ${this.sessionId}] processing ${frames.length} frames`)
        if (frames.length === 0) return

        // 1. Opus → PCM → Whisper
        const pcm = await withTiming(
            `session:${this.sessionId}:audio.decode`,
            async () => decodeOpusFrames(frames),
            { frames: frames.length },
        )
        if (pcm.length === 0) return

        const text = await withTiming(
            `session:${this.sessionId}:stt`,
            () => transcribe(pcm, 16000),
            { pcmBytes: pcm.length },
        )
        console.log(`[session ${this.sessionId}] STT: "${text}"`)
        this.sendJson({ type: 'stt', text })

        if (!text.trim()) return

        // 2. LLM
        this.messages.push({ role: 'user', content: text })
        const reply = await withTiming(
            `session:${this.sessionId}:llm`,
            () => chat(this.messages),
            { messageCount: this.messages.length },
        )
        this.messages.push({ role: 'assistant', content: reply })
        console.log(`[session ${this.sessionId}] LLM: "${reply}"`)
        this.sendJson({ type: 'llm', emotion: 'neutral' })

        // 3. TTS → Opus → device
        const wav = await withTiming(
            `session:${this.sessionId}:tts.synthesize`,
            () => synthesize(reply),
            { textLength: reply.length },
        )
        const opusFrames = await withTiming(
            `session:${this.sessionId}:tts.encode`,
            async () => encodeWavToOpusFrames(wav),
            { wavBytes: wav.length },
        )

        this.sendJson({ type: 'tts', state: 'start' })
        this.sendJson({ type: 'tts', state: 'sentence_start', text: reply })
        const streamStartMs = nowMs()
        for (const frame of opusFrames) {
            if (this.state !== 'processing') break
            this.sendBinary(wrapOpusPayload(frame, this.version))
            await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
        }
        console.log(`[timing] done session:${this.sessionId}:tts.stream elapsed=${elapsedMs(streamStartMs)} frames=${opusFrames.length}`)
        this.sendJson({ type: 'tts', state: 'sentence_end', text: reply })
        this.sendJson({ type: 'tts', state: 'stop' })

        // TTS 再生後のエコー誤検知を防ぐためクールダウンを設定
        this.cooldownUntil = Date.now() + POST_TTS_COOLDOWN_MS
        console.log(`[timing] done session:${this.sessionId}:process elapsed=${elapsedMs(processStartMs)}`)
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
