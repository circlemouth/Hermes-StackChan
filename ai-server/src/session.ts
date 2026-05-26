import { randomUUID } from 'crypto'
import type WebSocket from 'ws'
import { createInputOpusDecoder, decodeOpusFrames, encodeWavToOpusFrames, extractOpusPayload, pcmToWav, wrapOpusPayload, INPUT_SAMPLE_RATE, INPUT_FRAME_DURATION_MS, OUTPUT_SAMPLE_RATE, OUTPUT_FRAME_DURATION_MS, type InputOpusDecoder } from './audio.js'
import { HermesClient } from './hermes.js'
import { transcribeWithHermes, synthesizeWithHermes } from './hermes_audio.js'
import { registerDeviceSession } from './device_control.js'
import { extractFirstDisplayImage, resolveDisplayImageSource, stripMediaForSpeech } from './media.js'
import { elapsedMs, nowMs, withTiming } from './timing.js'
import { LocalRmsVad, readLocalRmsVadConfig, type LocalRmsVadConfig } from './local_vad.js'

type State = 'idle' | 'listening' | 'processing'
export type StackChanEmotion = 'neutral' | 'happy' | 'laughing' | 'angry' | 'sad' | 'crying' | 'sleepy' | 'doubtful'

export type TurnControlConfig = {
    silenceTimeoutMs: number
    maxRecordingMs: number
    minFramesForStt: number
    postTtsCooldownMs: number
}

export type BargeInConfig = {
    enabled: boolean
    rmsThreshold: number
    startSpeechMs: number
    minSpeechMs: number
    ignoreTtsStartMs: number
}

export type SpeechSegmentationConfig = {
    maxSpeechChars: number
    segmentMaxChars: number
    maxSegments: number
}

export type AutoLedConfig = {
    enabled: boolean
    manualHoldMs: number
}

export function readEnvInt(
    name: string,
    fallback: number,
    min: number,
    max: number,
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
}

export function readEnvFloat(
    name: string,
    fallback: number,
    min: number,
    max: number,
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

export function readEnvBool(
    name: string,
    fallback: boolean,
    env: Record<string, string | undefined> = process.env,
): boolean {
    const raw = env[name]
    if (!raw) return fallback
    return /^(1|true|yes|on)$/i.test(raw.trim())
}

export function readTurnControlConfig(env: Record<string, string | undefined> = process.env): TurnControlConfig {
    return {
        silenceTimeoutMs: readEnvInt('STACKCHAN_SILENCE_TIMEOUT_MS', 1200, 300, 5000, env),
        maxRecordingMs: readEnvInt('STACKCHAN_MAX_RECORDING_MS', 15000, 3000, 60000, env),
        minFramesForStt: readEnvInt('STACKCHAN_MIN_FRAMES_FOR_STT', 10, 1, 100, env),
        postTtsCooldownMs: readEnvInt('STACKCHAN_POST_TTS_COOLDOWN_MS', 1500, 0, 10000, env),
    }
}

export function readBargeInConfig(env: Record<string, string | undefined> = process.env): BargeInConfig {
    return {
        enabled: readEnvBool('STACKCHAN_BARGE_IN_ENABLED', true, env),
        rmsThreshold: readEnvFloat('STACKCHAN_BARGE_IN_RMS_THRESHOLD', 0.03, 0.005, 0.3, env),
        startSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_START_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 2000, env),
        minSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_MIN_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 3000, env),
        ignoreTtsStartMs: readEnvInt('STACKCHAN_BARGE_IN_IGNORE_TTS_START_MS', 300, 0, 5000, env),
    }
}

export function readSpeechSegmentationConfig(env: Record<string, string | undefined> = process.env): SpeechSegmentationConfig {
    return {
        maxSpeechChars: readEnvInt('STACKCHAN_MAX_SPEECH_CHARS', 800, 40, 4000, env),
        segmentMaxChars: readEnvInt('STACKCHAN_TTS_SEGMENT_MAX_CHARS', 160, 40, 800, env),
        maxSegments: readEnvInt('STACKCHAN_TTS_MAX_SEGMENTS', 8, 1, 32, env),
    }
}

export function readAutoLedConfig(env: Record<string, string | undefined> = process.env): AutoLedConfig {
    return {
        enabled: readEnvBool('STACKCHAN_AUTO_LED_ENABLED', true, env),
        manualHoldMs: readEnvInt('STACKCHAN_AUTO_LED_MANUAL_HOLD_MS', 8000, 0, 60000, env),
    }
}

export function inferStackChanEmotion(text: string): StackChanEmotion {
    const normalized = stripMediaForSpeech(text).toLowerCase()

    if (/笑|www|haha|lol/.test(normalized)) return 'laughing'
    if (/ありがとう|嬉しい|うれしい|よかった|できた|楽しい|いいね|great|nice|happy/.test(normalized)) return 'happy'
    if (/ごめん|すみません|残念|悲しい|申し訳|sorry/.test(normalized)) return 'sad'
    if (/眠い|おやすみ|sleepy|good night/.test(normalized)) return 'sleepy'
    if (/うーん|確認|わからない|分からない|不明|たぶん|maybe|not sure/.test(normalized)) return 'doubtful'
    return 'neutral'
}

export function limitStackChanSpeechText(text: string, maxChars = MAX_SPEECH_TEXT_CHARS): string {
    const stripped = stripMediaForSpeech(text).replace(/\s+/g, ' ').trim()
    if (stripped.length <= maxChars) return stripped
    return `${stripped.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

function normalizeSpeechText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n+ */g, '\n')
        .trim()
}

function splitLongSegment(segment: string, maxChars: number): string[] {
    if (segment.length <= maxChars) return [segment]
    const chunks: string[] = []
    let rest = segment
    while (rest.length > maxChars) {
        let splitAt = -1
        const window = rest.slice(0, maxChars + 1)
        for (const marker of ['、', '，', ',', ' ']) {
            const idx = window.lastIndexOf(marker)
            if (idx > Math.floor(maxChars * 0.45)) {
                splitAt = idx + 1
                break
            }
        }
        if (splitAt <= 0) splitAt = maxChars
        chunks.push(rest.slice(0, splitAt).trim())
        rest = rest.slice(splitAt).trim()
    }
    if (rest) chunks.push(rest)
    return chunks.filter(Boolean)
}

export function splitStackChanSpeechText(
    text: string,
    config: SpeechSegmentationConfig = SPEECH_SEGMENTATION_CONFIG,
    fallback = '画像を表示しました。',
): string[] {
    let speech = normalizeSpeechText(stripMediaForSpeech(text))
    if (!speech) speech = fallback
    if (speech.length > config.maxSpeechChars) {
        speech = `${speech.slice(0, Math.max(1, config.maxSpeechChars - 1)).trimEnd()}…`
    }

    const rawSegments: string[] = []
    let current = ''
    for (let i = 0; i < speech.length; i++) {
        const ch = speech[i]
        if (ch === '\n') {
            if (current.trim()) rawSegments.push(current.trim())
            current = ''
            continue
        }
        current += ch
        const prev = i > 0 ? speech[i - 1] : ''
        const next = i + 1 < speech.length ? speech[i + 1] : ''
        const isSentenceEnd = /[。！？!?]/.test(ch) ||
            (ch === '.' && !/\d/.test(prev) && !/\d/.test(next))
        if (isSentenceEnd) {
            if (current.trim()) rawSegments.push(current.trim())
            current = ''
        }
    }
    if (current.trim()) rawSegments.push(current.trim())

    const segments = rawSegments.flatMap(segment => splitLongSegment(segment, config.segmentMaxChars))
    return segments.filter(Boolean).slice(0, config.maxSegments)
}

// auto モード: フレームが途切れてから処理開始するまでの無音判定時間 (ms)
const TURN_CONTROL_CONFIG = readTurnControlConfig()
const SILENCE_TIMEOUT_MS = TURN_CONTROL_CONFIG.silenceTimeoutMs
// 最長録音時間 (ms) — 無音検知がなくても強制処理
const MAX_RECORDING_MS = TURN_CONTROL_CONFIG.maxRecordingMs
// STT を呼ぶ最低フレーム数 (10フレーム × 60ms = 600ms 未満は無音とみなす)
const MIN_FRAMES_FOR_STT = TURN_CONTROL_CONFIG.minFramesForStt
// TTS 再生後、次の listen start を受け付けるまでのクールダウン (ms) — エコー誤検知防止
const POST_TTS_COOLDOWN_MS = TURN_CONTROL_CONFIG.postTtsCooldownMs
const BARGE_IN_CONFIG = readBargeInConfig()
const SPEECH_SEGMENTATION_CONFIG = readSpeechSegmentationConfig()
const AUTO_LED_CONFIG = readAutoLedConfig()
const MAX_SPEECH_TEXT_CHARS = SPEECH_SEGMENTATION_CONFIG.maxSpeechChars
const MCP_REQUEST_TIMEOUT_MS = 10_000
const PROCESSING_KEEPALIVE_MS = 10_000
const PROCESS_ERROR_SPEECH = '返答の処理に時間がかかっています。もう一度短く話してください。'
type AutoLedState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

type PendingMcpRequest = {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

type HermesSessionClient = {
    submitPrompt(prompt: string): Promise<string>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}

type SessionDeps = {
    hermes?: HermesSessionClient
    registerDeviceSession?: typeof registerDeviceSession
    decodeOpusFrames?: typeof decodeOpusFrames
    createInputOpusDecoder?: typeof createInputOpusDecoder
    decodeOpusFrame?: (opus: Buffer) => Buffer
    encodeWavToOpusFrames?: typeof encodeWavToOpusFrames
    transcribeWav?: typeof transcribeWithHermes
    synthesizeText?: typeof synthesizeWithHermes
    postTtsCooldownMs?: number
    localVadConfig?: LocalRmsVadConfig
    bargeInConfig?: BargeInConfig
    speechSegmentationConfig?: SpeechSegmentationConfig
    autoLedConfig?: AutoLedConfig
    bargeInEnabled?: boolean
    autoLedEnabled?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export class Session {
    private readonly sessionId = randomUUID()
    private state: State = 'idle'
    private version = 3
    private opusFrames: Buffer[] = []
    private readonly hermes: HermesSessionClient
    private readonly unregisterDeviceSession: () => void
    private readonly decodeOpusFramesFn: typeof decodeOpusFrames
    private readonly createInputOpusDecoderFn: typeof createInputOpusDecoder
    private readonly decodeOpusFrameFn?: (opus: Buffer) => Buffer
    private readonly encodeWavToOpusFramesFn: typeof encodeWavToOpusFrames
    private readonly transcribeWavFn: typeof transcribeWithHermes
    private readonly synthesizeTextFn: typeof synthesizeWithHermes
    private readonly localVadConfig: LocalRmsVadConfig
    private readonly localVad: LocalRmsVad
    private readonly bargeInConfig: BargeInConfig
    private readonly bargeInVad: LocalRmsVad
    private readonly speechSegmentationConfig: SpeechSegmentationConfig
    private readonly autoLedConfig: AutoLedConfig
    private readonly pendingMcp = new Map<number, PendingMcpRequest>()
    private nextMcpId = 1
    private silenceTimer?: ReturnType<typeof setTimeout>
    private maxDurationTimer?: ReturnType<typeof setTimeout>
    private delayedListenTimer?: ReturnType<typeof setTimeout>
    private cooldownUntil = 0
    private readonly postTtsCooldownMs: number
    private pcmChunks: Buffer[] = []
    private preRollPcmChunks: Buffer[] = []
    private streamingDecoder: InputOpusDecoder
    private streamingDecodeFailed = false
    private bargeInDecoder: InputOpusDecoder
    private bargeInDecodeFailed = false
    private ttsStreaming = false
    private ttsStopSent = false
    private ttsGeneration = 0
    private ttsStartedAt = 0
    private manualLedHoldUntil = 0
    private lastAutoLedState?: AutoLedState
    private processingSource: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap' = 'arrival-gap'
    private currentSpeechMs = 0

    constructor(private readonly ws: WebSocket, deps: SessionDeps = {}) {
        this.hermes = deps.hermes ?? new HermesClient()
        this.decodeOpusFramesFn = deps.decodeOpusFrames ?? decodeOpusFrames
        this.createInputOpusDecoderFn = deps.createInputOpusDecoder ?? createInputOpusDecoder
        this.decodeOpusFrameFn = deps.decodeOpusFrame
        this.encodeWavToOpusFramesFn = deps.encodeWavToOpusFrames ?? encodeWavToOpusFrames
        this.transcribeWavFn = deps.transcribeWav ?? transcribeWithHermes
        this.synthesizeTextFn = deps.synthesizeText ?? synthesizeWithHermes
        this.postTtsCooldownMs = deps.postTtsCooldownMs ?? POST_TTS_COOLDOWN_MS
        this.localVadConfig = deps.localVadConfig ?? readLocalRmsVadConfig()
        this.localVad = new LocalRmsVad(this.localVadConfig)
        this.bargeInConfig = { ...(deps.bargeInConfig ?? BARGE_IN_CONFIG) }
        if (typeof deps.bargeInEnabled === 'boolean') this.bargeInConfig.enabled = deps.bargeInEnabled
        this.bargeInVad = new LocalRmsVad({
            enabled: this.bargeInConfig.enabled,
            rmsThreshold: this.bargeInConfig.rmsThreshold,
            startSpeechMs: this.bargeInConfig.startSpeechMs,
            endSilenceMs: 1000,
            minSpeechMs: this.bargeInConfig.minSpeechMs,
            preRollMs: 0,
        })
        this.speechSegmentationConfig = deps.speechSegmentationConfig ?? SPEECH_SEGMENTATION_CONFIG
        this.autoLedConfig = { ...(deps.autoLedConfig ?? AUTO_LED_CONFIG) }
        if (typeof deps.autoLedEnabled === 'boolean') this.autoLedConfig.enabled = deps.autoLedEnabled
        this.streamingDecoder = this.createInputOpusDecoderFn()
        this.bargeInDecoder = this.createInputOpusDecoderFn()
        this.unregisterDeviceSession = (deps.registerDeviceSession ?? registerDeviceSession)(this)
    }

    close(): void {
        this.clearTimers()
        this.unregisterDeviceSession()
        for (const [id, pending] of this.pendingMcp) {
            clearTimeout(pending.timer)
            pending.reject(new Error('StackChan WebSocket disconnected'))
            this.pendingMcp.delete(id)
        }
        void this.hermes.dispose()
    }

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
        const payload = extractOpusPayload(data, this.version)
        if (!payload) return

        if (this.state === 'processing') {
            this.tryHandleBargeIn(payload)
            return
        }

        if (this.state !== 'listening') return
        this.handleListeningPayload(payload)
    }

    private handleListeningPayload(payload: Buffer): void {
        this.opusFrames.push(payload)
        if (this.shouldUseLocalVad()) {
            this.handleVadPayload(payload)
        } else {
            this.resetSilenceTimer()
        }
    }

    private shouldUseLocalVad(): boolean {
        return this.localVadConfig.enabled && !this.streamingDecodeFailed
    }

    private handleVadPayload(payload: Buffer): void {
        let pcm: Buffer
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.streamingDecoder.decodeFrame(payload)
        } catch (error) {
            this.streamingDecodeFailed = true
            console.warn(`[session ${this.sessionId}] local VAD streaming decode failed, using arrival-gap timeout: ${String(error)}`)
            this.resetVadBuffers()
            this.resetSilenceTimer()
            return
        }
        if (pcm.length === 0) return

        const collectingBefore = this.pcmChunks.length > 0
        if (collectingBefore) {
            this.pcmChunks.push(pcm)
        } else {
            this.appendPreRollPcm(pcm)
        }

        const result = this.localVad.processPcm(pcm)
        this.currentSpeechMs = result.speechMs

        if (result.speechStarted && this.pcmChunks.length === 0) {
            this.pcmChunks = this.preRollPcmChunks.splice(0)
            console.log(`[session ${this.sessionId}] vad speech started rms=${result.rms.toFixed(4)}`)
        }

        if (result.ignoredShortSpeech) {
            console.log(`[session ${this.sessionId}] vad ignored short speech speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.opusFrames = []
            this.resetVadBuffers()
            return
        }

        if (result.utteranceEnded) {
            console.log(`[session ${this.sessionId}] vad silence ended speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.triggerProcess('local-vad')
        }
    }

    private appendPreRollPcm(pcm: Buffer): void {
        if (this.localVadConfig.preRollMs <= 0) {
            this.preRollPcmChunks = []
            return
        }
        this.preRollPcmChunks.push(pcm)
        const maxChunks = Math.max(1, Math.ceil(this.localVadConfig.preRollMs / INPUT_FRAME_DURATION_MS))
        while (this.preRollPcmChunks.length > maxChunks) {
            this.preRollPcmChunks.shift()
        }
    }

    private resetSilenceTimer(): void {
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
        this.silenceTimer = setTimeout(() => {
            console.log(`[session ${this.sessionId}] silence detected, triggering process`)
            this.triggerProcess('arrival-gap')
        }, SILENCE_TIMEOUT_MS)
    }

    private clearTimers(): void {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = undefined }
        if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = undefined }
        if (this.delayedListenTimer) { clearTimeout(this.delayedListenTimer); this.delayedListenTimer = undefined }
    }

    private resetVadBuffers(): void {
        this.localVad.reset()
        this.pcmChunks = []
        this.preRollPcmChunks = []
        this.currentSpeechMs = 0
    }

    private resetCapture(): void {
        this.opusFrames = []
        this.resetVadBuffers()
        this.streamingDecoder = this.createInputOpusDecoderFn()
        this.streamingDecodeFailed = false
    }

    private resetBargeInDetector(): void {
        this.bargeInVad.reset()
        this.bargeInDecoder = this.createInputOpusDecoderFn()
        this.bargeInDecodeFailed = false
    }

    private tryHandleBargeIn(payload: Buffer): boolean {
        if (!this.bargeInConfig.enabled || this.bargeInDecodeFailed) return false
        if (!this.ttsStreaming) return false
        if (Date.now() - this.ttsStartedAt < this.bargeInConfig.ignoreTtsStartMs) return false

        let pcm: Buffer
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.bargeInDecoder.decodeFrame(payload)
        } catch (error) {
            this.bargeInDecodeFailed = true
            console.warn(`[session ${this.sessionId}] barge-in decode failed, disabled for current TTS: ${String(error)}`)
            return false
        }

        const result = this.bargeInVad.processPcm(pcm)
        if (!result.inSpeech || result.speechMs < this.bargeInConfig.minSpeechMs) return false

        console.log(`[session ${this.sessionId}] barge-in detected rms=${result.rms.toFixed(4)} speechMs=${result.speechMs}`)
        this.handleBargeIn(payload)
        return true
    }

    private handleBargeIn(firstPayload: Buffer): void {
        const interruptedGeneration = this.ttsGeneration
        this.sendTtsStopOnce(interruptedGeneration)
        this.ttsGeneration += 1
        this.ttsStreaming = false
        this.cooldownUntil = 0
        this.clearTimers()
        this.resetCapture()
        this.resetBargeInDetector()
        void this.hermes.interrupt().catch((error) => {
            console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error)
        })
        this.startListening('barge-in')
        this.setAutoLedState('listening')
        this.handleListeningPayload(firstPayload)
    }

    private triggerProcess(reason: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap', force = false): void {
        if (this.state !== 'listening') return
        this.clearTimers()
        const hasVadPcm = this.pcmChunks.length > 0
        const pcmBytes = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const minPcmBytes = Math.ceil((this.localVadConfig.minSpeechMs / 1000) * INPUT_SAMPLE_RATE) * 2
        if (!force && hasVadPcm && (this.currentSpeechMs < this.localVadConfig.minSpeechMs || pcmBytes < minPcmBytes)) {
            console.log(`[session ${this.sessionId}] too little VAD speech speechMs=${this.currentSpeechMs} pcmBytes=${pcmBytes}, skipping`)
            this.resetCapture()
            this.state = 'idle'
            return
        }
        if (!force && !hasVadPcm && this.opusFrames.length < MIN_FRAMES_FOR_STT) {
            console.log(`[session ${this.sessionId}] too few frames (${this.opusFrames.length}), skipping`)
            this.resetCapture()
            this.state = 'idle'
            return
        }
        this.processingSource = reason
        this.state = 'processing'
        this.setAutoLedState('thinking')
        this.process().catch(async (err) => {
            console.error(`[session ${this.sessionId}] process error:`, err)
            this.setAutoLedState('error')
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.error').catch((error) => {
                    console.error(`[session ${this.sessionId}] error speech failed:`, error)
                })
            }
        }).finally(() => {
            if (this.state === 'processing') {
                this.state = 'idle'
                this.setAutoLedState('idle')
            }
        })
    }

    private startListening(source: string): void {
        this.clearTimers()
        this.state = 'listening'
        this.resetCapture()
        this.setAutoLedState('listening')
        if (!this.localVadConfig.enabled) {
            console.log(`[session ${this.sessionId}] local vad disabled, using arrival-gap timeout`)
        }
        // 最長録音タイマーをセット
        this.maxDurationTimer = setTimeout(() => {
            console.log(`[session ${this.sessionId}] max duration reached, triggering process`)
            this.triggerProcess('max-duration', true)
        }, MAX_RECORDING_MS)
        console.log(`[session ${this.sessionId}] listening started (${source})`)
    }

    private delayListeningUntilCooldownEnds(source: string): void {
        if (this.delayedListenTimer) clearTimeout(this.delayedListenTimer)
        this.resetCapture()
        const delayMs = Math.max(0, this.cooldownUntil - Date.now())
        this.delayedListenTimer = setTimeout(() => {
            this.delayedListenTimer = undefined
            this.startListening(source)
        }, delayMs)
        console.log(`[session ${this.sessionId}] listen start delayed ${delayMs}ms (post-TTS cooldown)`)
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
                const isWakeWordStart = listenState === 'detect'
                const source = isWakeWordStart ? `wake_word=${String(msg['text'] ?? '')}` : `mode=${String(msg['mode'] ?? '')}`
                if (!isWakeWordStart && Date.now() < this.cooldownUntil) {
                    if (this.state === 'listening') {
                        console.log(`[session ${this.sessionId}] listen start already active (${source})`)
                        return
                    }
                    this.delayListeningUntilCooldownEnds(source)
                    return
                }
                this.startListening(source)
            } else if (listenState === 'stop') {
                this.triggerProcess('listen-stop', true)
            }
        }

        if (type === 'abort') {
            this.clearTimers()
            this.sendTtsStopOnce(this.ttsGeneration)
            this.ttsGeneration += 1
            this.ttsStreaming = false
            this.cooldownUntil = 0
            this.state = 'idle'
            this.resetCapture()
            this.resetBargeInDetector()
            this.setAutoLedState('idle')
            void this.hermes.interrupt().catch((error) => {
                console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error)
            })
            return
        }

        if (type === 'mcp') {
            this.handleMcpPayload(msg['payload'])
        }
    }

    private async process(): Promise<void> {
        const processStartMs = nowMs()
        const frames = this.opusFrames.splice(0)
        const vadPcm = this.pcmChunks.splice(0)
        this.preRollPcmChunks = []
        const source = this.processingSource
        console.log(`[session ${this.sessionId}] processing source=${source} frames=${frames.length} pcmBytes=${vadPcm.reduce((sum, chunk) => sum + chunk.length, 0)}`)
        if (frames.length === 0 && vadPcm.length === 0) return

        // 1. Opus -> PCM -> Hermes STT
        const pcm = vadPcm.length > 0
            ? Buffer.concat(vadPcm)
            : await withTiming(
                `session:${this.sessionId}:audio.decode`,
                async () => this.decodeOpusFramesFn(frames),
                { frames: frames.length },
            )
        if (pcm.length === 0) return

        const wavForStt = pcmToWav(pcm, INPUT_SAMPLE_RATE)
        const text = await withTiming(
            `session:${this.sessionId}:stt`,
            () => this.transcribeWavFn(wavForStt),
            { pcmBytes: pcm.length },
        )
        console.log(`[session ${this.sessionId}] STT: "${text}"`)
        this.sendJson({ type: 'stt', text })

        if (!text.trim()) return

        // 2. Hermes LLM turn
        const processingKeepalive = setInterval(() => {
            this.sendJson({ type: 'llm', emotion: 'doubtful' })
        }, PROCESSING_KEEPALIVE_MS)
        this.sendJson({ type: 'llm', emotion: 'doubtful' })
        let reply: string
        try {
            reply = await withTiming(
                `session:${this.sessionId}:llm`,
                () => this.hermes.submitPrompt(text),
                { textLength: text.length },
            )
        } finally {
            clearInterval(processingKeepalive)
        }
        console.log(`[session ${this.sessionId}] LLM: "${reply}"`)
        this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) })
        void this.displayFirstImageFromReply(reply)

        // 3. Hermes TTS -> Opus -> device
        const speechSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig)
        await this.speakSegments(speechSegments, 'tts')
        if (this.state === 'processing') this.setAutoLedState('idle')
        console.log(`[timing] done session:${this.sessionId}:process elapsed=${elapsedMs(processStartMs)}`)
    }

    private async synthesizeSegmentToOpus(speechText: string, label: string): Promise<Buffer[]> {
        const wav = await withTiming(
            `session:${this.sessionId}:${label}.synthesize`,
            () => this.synthesizeTextFn(speechText),
            { textLength: speechText.length },
        )
        const opusFrames = await withTiming(
            `session:${this.sessionId}:${label}.encode`,
            async () => this.encodeWavToOpusFramesFn(wav),
            { wavBytes: wav.length },
        )
        return opusFrames
    }

    private async speakSegments(segments: string[], label: string): Promise<void> {
        if (segments.length === 0) return
        const generation = this.ttsGeneration + 1
        this.ttsGeneration = generation
        this.ttsStopSent = false
        this.ttsStreaming = true
        this.ttsStartedAt = Date.now()
        this.resetBargeInDetector()
        this.sendJson({ type: 'tts', state: 'start' })
        this.setAutoLedState('speaking')

        let interrupted = false
        const streamStartMs = nowMs()
        let streamedFrames = 0
        try {
            for (let i = 0; i < segments.length; i++) {
                if (this.state !== 'processing' || this.ttsGeneration !== generation) {
                    interrupted = true
                    break
                }
                const segment = segments[i]
                this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index: i })
                const opusFrames = await this.synthesizeSegmentToOpus(segment, `${label}.segment${i}`)
                for (const frame of opusFrames) {
                    if (this.state !== 'processing' || this.ttsGeneration !== generation) {
                        interrupted = true
                        break
                    }
                    this.sendBinary(wrapOpusPayload(frame, this.version))
                    streamedFrames += 1
                    await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
                }
                if (this.state !== 'processing' || this.ttsGeneration !== generation) {
                    interrupted = true
                    break
                }
                this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index: i })
            }
        } finally {
            this.sendTtsStopOnce(generation)
            if (this.ttsGeneration === generation) {
                this.ttsStreaming = false
                this.resetBargeInDetector()
            }
        }
        console.log(`[timing] done session:${this.sessionId}:${label}.stream elapsed=${elapsedMs(streamStartMs)} frames=${streamedFrames} segments=${segments.length}`)

        if (!interrupted && this.state === 'processing' && this.ttsGeneration === generation) {
            // TTS 再生後のエコー誤検知を防ぐためクールダウンを設定
            this.cooldownUntil = Date.now() + this.postTtsCooldownMs
        }
    }

    private sendTtsStopOnce(generation: number): void {
        if (!this.ttsStreaming && this.ttsGeneration === generation) return
        if (this.ttsGeneration !== generation) return
        if (this.ttsStopSent) return
        this.ttsStopSent = true
        this.sendJson({ type: 'tts', state: 'stop' })
    }

    private async displayFirstImageFromReply(reply: string): Promise<void> {
        const source = extractFirstDisplayImage(reply)
        if (!source) return

        try {
            const url = resolveDisplayImageSource(source)
            if (!url) return
            await this.callRobotTool('self.screen.preview_image_url', {
                url,
                duration_seconds: 6,
            })
        } catch (error) {
            console.error(`[session ${this.sessionId}] display image error:`, error)
        }
    }

    async callRobotTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        return await this.callRobotToolInternal(name, args, { automatic: false, waitForResponse: true })
    }

    private async callRobotToolInternal(
        name: string,
        args: Record<string, unknown>,
        options: { automatic: boolean; waitForResponse: boolean },
    ): Promise<unknown> {
        if (name === 'self.robot.set_led_color' && !options.automatic) {
            this.manualLedHoldUntil = Date.now() + this.autoLedConfig.manualHoldMs
        }

        const id = this.nextMcpId++
        const payload = {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
        }

        if (!options.waitForResponse) {
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload })
            return undefined
        }

        return await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingMcp.delete(id)
                reject(new Error(`StackChan robot tool timed out: ${name}`))
            }, MCP_REQUEST_TIMEOUT_MS)
            this.pendingMcp.set(id, { resolve, reject, timer })
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload })
        })
    }

    private setAutoLedState(state: AutoLedState): void {
        if (!this.autoLedConfig.enabled) return
        if (Date.now() < this.manualLedHoldUntil) return
        if (this.lastAutoLedState === state) return
        this.lastAutoLedState = state

        const colors: Record<AutoLedState, { red: number; green: number; blue: number }> = {
            listening: { red: 0, green: 32, blue: 0 },
            thinking: { red: 32, green: 24, blue: 0 },
            speaking: { red: 0, green: 0, blue: 40 },
            idle: { red: 0, green: 0, blue: 0 },
            error: { red: 48, green: 0, blue: 0 },
        }

        void this.callRobotToolInternal('self.robot.set_led_color', colors[state], {
            automatic: true,
            waitForResponse: false,
        }).catch((error) => {
            console.error(`[session ${this.sessionId}] auto LED error:`, error)
        })
    }

    private handleMcpPayload(payload: unknown): void {
        if (!isRecord(payload) || typeof payload['id'] !== 'number') return
        const pending = this.pendingMcp.get(payload['id'])
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingMcp.delete(payload['id'])
        if (isRecord(payload['error'])) {
            pending.reject(new Error(String(payload['error']['message'] ?? 'StackChan robot tool failed')))
            return
        }
        pending.resolve(payload['result'])
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
