import { randomUUID } from 'crypto'
import type WebSocket from 'ws'
import { createInputOpusDecoder, decodeOpusFrames, encodeWavToOpusFrames, extractOpusPayload, pcmToWav, wrapOpusPayload, INPUT_SAMPLE_RATE, INPUT_FRAME_DURATION_MS, OUTPUT_SAMPLE_RATE, OUTPUT_FRAME_DURATION_MS, type InputOpusDecoder } from './audio.js'
import { HermesClient, type HermesPromptStreamEvent, type HermesTurnOptions } from './hermes.js'
import { transcribeWithHermes, synthesizeWithHermes } from './hermes_audio.js'
import { synthesizeWithSanoTts } from './sanotts_audio.js'
import { readSpeakerVolumeAck, readSpeakerVolumeAckRecord } from './speaker_volume_ack.js'
import { registerDeviceSession, type StackChanBridgeStatus } from './device_control.js'
import { extractFirstDisplayImage, resolveDisplayImageSource, stripMediaForSpeech } from './media.js'
import { elapsedMs, nowMs, withTiming } from './timing.js'
import { LocalRmsVad, readLocalRmsVadConfig, rmsNormalized, type LocalRmsVadConfig } from './local_vad.js'
import {
    playWavOnLocalTarget,
    readLocalTtsOutputConfig,
    resolveLocalTtsOutputTarget,
    type LocalTtsOutputConfig,
} from './local_audio_output.js'

type State = 'idle' | 'listening' | 'processing'
export type StackChanEmotion = 'neutral' | 'happy' | 'laughing' | 'angry' | 'sad' | 'crying' | 'sleepy' | 'doubtful'
export type TtsProvider = 'sanotts' | 'hermes'

export function readTtsProvider(value: unknown): TtsProvider {
    return typeof value === 'string' && value.trim().toLowerCase() === 'hermes' ? 'hermes' : 'sanotts'
}

export function formatConversationLogText(text: string, mode = process.env['HERMES_CONNECT_MODE'], quote = true): string {
    if (mode?.trim().toLowerCase() === 'children_http') return `length=${text.length}`
    return quote ? `"${text}"` : text
}

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
        enabled: readEnvBool('STACKCHAN_BARGE_IN_ENABLED', false, env),
        rmsThreshold: readEnvFloat('STACKCHAN_BARGE_IN_RMS_THRESHOLD', 0.03, 0.005, 1.0, env),
        startSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_START_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 2000, env),
        minSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_MIN_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 3000, env),
        ignoreTtsStartMs: readEnvInt('STACKCHAN_BARGE_IN_IGNORE_TTS_START_MS', 300, 0, 5000, env),
    }
}

export function readSpeechSegmentationConfig(env: Record<string, string | undefined> = process.env): SpeechSegmentationConfig {
    return {
        maxSpeechChars: readEnvInt('STACKCHAN_MAX_SPEECH_CHARS', 800, 8, 4000, env),
        segmentMaxChars: readEnvInt('STACKCHAN_TTS_SEGMENT_MAX_CHARS', 160, 8, 800, env),
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

function stableSpeechSegmentsFromPartialReply(
    text: string,
    config: SpeechSegmentationConfig = SPEECH_SEGMENTATION_CONFIG,
): string[] {
    const speech = normalizeSpeechText(stripMediaForSpeech(text))
    if (!speech) return []
    const segments = splitStackChanSpeechText(text, config, '')
    if (segments.length === 0) return []
    if (/[。！？!?\n]$/.test(speech)) return segments
    return segments.slice(0, -1)
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
const PROCESS_ERROR_SPEECH = '返答処理でエラーが起きました。設定とサーバーログを確認してください。'
const PROCESS_ERROR_ALERT_MAX_CHARS = 120
const AUTO_RESUME_LISTENING = readEnvBool('STACKCHAN_AUTO_RESUME_LISTENING', true)
const IGNORE_SHORT_TRANSCRIPTS = readEnvBool('STACKCHAN_IGNORE_SHORT_TRANSCRIPTS', true)
const TTS_PREROLL_MS = readEnvInt('STACKCHAN_TTS_PREROLL_MS', 0, 0, 600)
const FAST_ACK_ENABLED = readEnvBool('STACKCHAN_FAST_ACK_ENABLED', false)
const FAST_ACK_TEXT = (process.env.STACKCHAN_FAST_ACK_TEXT ?? 'はい。').trim() || 'はい。'
const FAST_ACK_TEXTS = readFastAckTexts()
const STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS = readEnvBool('STACKCHAN_STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS', true)
const MAX_DURATION_STT_RMS_THRESHOLD = readEnvFloat('STACKCHAN_MAX_DURATION_STT_RMS_THRESHOLD', 0.006, 0, 0.2)
const STREAMING_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_STREAMING_DECODE_FAILURE_LIMIT', 3, 1, 20)
const BARGE_IN_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_BARGE_IN_DECODE_FAILURE_LIMIT', 3, 1, 20)
const DEFAULT_IGNORED_SHORT_TRANSCRIPTS = new Set([
    'あ', 'あっ', 'あー',
    'え', 'えっ', 'えー',
    'お', 'おっ',
    'ん',
    'はは', 'ハハ', 'ふふ', 'フフ',
    'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ',
])
const DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS = new Set(['あ', 'あっ', 'あー', 'え', 'えっ', 'えー', 'お', 'おっ', 'ん', 'はは', 'ハハ', 'ふふ', 'フフ', 'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ'])
const TURN_TIMEOUT_MS = readEnvInt('STACKCHAN_TURN_TIMEOUT_MS', 180_000, 1000, 600_000)
const SPEAKER_LEASE_MS = 30_000
const SPEAKER_LEASE_RENEW_MS = 10_000

type FastAckCacheEntry = {
    text: string
    wav: Buffer
    frames: Buffer[]
    localFrames?: Buffer[]
}

function readFastAckTexts(): string[] {
    const raw = process.env.STACKCHAN_FAST_ACK_TEXTS?.trim()
    const values = raw
        ? raw.split(/[|\n]/g).map(item => item.trim()).filter(Boolean)
        : [FAST_ACK_TEXT]
    return [...new Set(values)].slice(0, 16)
}

function stackChanVoicePrompt(prompt: string): string {
    const prefix = process.env.STACKCHAN_REPLY_PROMPT_PREFIX?.trim()
    if (!prefix) return prompt
    return `${prefix}\nユーザー: ${prompt}`
}

function normalizedShortTranscript(text: string): string {
    return text
        .normalize('NFKC')
        .trim()
        .replace(/[、。！？!?\s]/g, '')
        .replace(/[ー〜~]+$/g, 'ー')
}

export function isIgnorableShortTranscript(text: string): boolean {
    if (!IGNORE_SHORT_TRANSCRIPTS) return false
    const normalized = normalizedShortTranscript(text)
    if (!normalized) return false

    const configured = process.env.STACKCHAN_IGNORED_SHORT_TRANSCRIPTS
    const ignored = configured
        ? new Set(configured.split(',').map(item => normalizedShortTranscript(item)).filter(Boolean))
        : DEFAULT_IGNORED_SHORT_TRANSCRIPTS
    return ignored.has(normalized)
}

export function isIgnorableTimeoutTranscript(text: string): boolean {
    if (!IGNORE_SHORT_TRANSCRIPTS) return false
    const normalized = normalizedShortTranscript(text)
    if (!normalized) return false
    return DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS.has(normalized)
}

function isMissingSttProviderError(message: string): boolean {
    return /No STT provider available/i.test(message)
}

function compactErrorForBubble(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    const compact = raw.replace(/\s+/g, ' ').trim()
    if (!compact) return 'unknown error'
    if (isMissingSttProviderError(compact)) return 'STT設定がありません。サーバー設定を確認してください。'
    if (compact.length <= PROCESS_ERROR_ALERT_MAX_CHARS) return compact
    return `${compact.slice(0, PROCESS_ERROR_ALERT_MAX_CHARS - 3)}...`
}

function buildProcessingErrorAlertMessage(error: unknown): string {
    return `HERMES AI server error: ${compactErrorForBubble(error)}`
}
type AutoLedState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

type PendingMcpRequest = {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

type HermesSessionClient = {
    submitPrompt(prompt: string, options?: HermesTurnOptions): Promise<string>
    streamPrompt?(prompt: string, options?: HermesTurnOptions): AsyncIterable<HermesPromptStreamEvent>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}

type TtsPlayback = {
    turn: AbortController
    controller: AbortController
    generation: number
    label: string
    streamStartMs: number
    streamedFrames: number
    segmentCount: number
    interrupted: boolean
    firstFrameLogged: boolean
    firstAudibleFrameLogged: boolean
    localOutputChecked: boolean
    localOutputTarget?: string
    m5SpeakerMutedForLocalOutput: boolean
    m5AdmissionNeedsReset?: boolean
    speakerLeaseId?: string
    speakerLeaseTimer?: ReturnType<typeof setInterval>
    localOutputController?: AbortController
    localSegmentStreaming?: boolean
    localSegmentFailed?: boolean
}

type SynthesizedSegment = {
    wav: Buffer
    opusFrames: Buffer[]
}

type PrefetchedSegment = {
    index: number
    promise: Promise<SynthesizedSegment>
}

export type SessionDeps = {
    hermes?: HermesSessionClient
    registerDeviceSession?: typeof registerDeviceSession
    decodeOpusFrames?: typeof decodeOpusFrames
    createInputOpusDecoder?: typeof createInputOpusDecoder
    decodeOpusFrame?: (opus: Buffer) => Buffer
    encodeWavToOpusFrames?: typeof encodeWavToOpusFrames
    transcribeWav?: typeof transcribeWithHermes
    synthesizeText?: typeof synthesizeWithHermes
    synthesizeSanoText?: typeof synthesizeWithSanoTts
    synthesizeHermesText?: typeof synthesizeWithHermes
    postTtsCooldownMs?: number
    turnTimeoutMs?: number
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
    // Immutable for this connection: changing the environment affects only new sessions.
    private readonly diagnosticVoicePaused = readEnvBool('STACKCHAN_DIAGNOSTIC_VOICE_PAUSED', false)
    private helloReceived = false
    private state: State = 'idle'
    private version = 3
    private opusFrames: Buffer[] = []
    private readonly hermes: HermesSessionClient
    private unregisterDeviceSession: () => void = () => undefined
    private readonly registerDeviceSessionFn: typeof registerDeviceSession
    private readonly decodeOpusFramesFn: typeof decodeOpusFrames
    private readonly createInputOpusDecoderFn: typeof createInputOpusDecoder
    private readonly decodeOpusFrameFn?: (opus: Buffer) => Buffer
    private readonly encodeWavToOpusFramesFn: typeof encodeWavToOpusFrames
    private readonly transcribeWavFn: typeof transcribeWithHermes
    private readonly synthesizeSanoTextFn: typeof synthesizeWithSanoTts
    private readonly synthesizeHermesTextFn: typeof synthesizeWithHermes
    private readonly localVadConfig: LocalRmsVadConfig
    private readonly localVad: LocalRmsVad
    private readonly bargeInConfig: BargeInConfig
    private readonly bargeInVad: LocalRmsVad
    private readonly speechSegmentationConfig: SpeechSegmentationConfig
    private readonly autoLedConfig: AutoLedConfig
    private readonly localTtsOutputConfig: LocalTtsOutputConfig
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
    private streamingDecodeFailures = 0
    private bargeInDecoder: InputOpusDecoder
    private bargeInDecodeFailed = false
    private bargeInDecodeFailures = 0
    private processingTurn?: AbortController
    private producerEpoch = 0
    private hermesRetirement: Promise<void> = Promise.resolve()
    private readonly turnDeadlines = new WeakMap<AbortController, number>()
    private readonly turnTimeoutMs: number
    private bargeInFrames: Buffer[] = []
    private cooldownFrames: Buffer[] = []
    private installingCaptureFrames = false
    private activeTtsPlayback?: TtsPlayback
    private localSpeakerOwner?: TtsPlayback
    private localSpeakerOperations: Promise<void> = Promise.resolve()
    private fastAckWarmup?: AbortController
    private ttsStreaming = false
    private ttsStopSent = false
    private ttsGeneration = 0
    private ttsStartedAt = 0
    private manualLedHoldUntil = 0
    private lastAutoLedState?: AutoLedState
    private lastListenMode = ''
    private processingSource: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap' = 'arrival-gap'
    private currentSpeechMs = 0
    private followupQueue: string[] = []
    private followupRunning = false
    private fastAckEntries?: FastAckCacheEntry[]
    private fastAckFailed = false
    private lastFastAckIndex = -1
    private ttsProvider: TtsProvider = 'sanotts'
    private closed = false

    constructor(private readonly ws: WebSocket, deps: SessionDeps = {}) {
        this.hermes = deps.hermes ?? new HermesClient()
        this.decodeOpusFramesFn = deps.decodeOpusFrames ?? decodeOpusFrames
        this.createInputOpusDecoderFn = deps.createInputOpusDecoder ?? createInputOpusDecoder
        this.decodeOpusFrameFn = deps.decodeOpusFrame
        this.encodeWavToOpusFramesFn = deps.encodeWavToOpusFrames ?? encodeWavToOpusFrames
        this.transcribeWavFn = deps.transcribeWav ?? transcribeWithHermes
        this.synthesizeSanoTextFn = deps.synthesizeSanoText ?? deps.synthesizeText ?? synthesizeWithSanoTts
        this.synthesizeHermesTextFn = deps.synthesizeHermesText ?? deps.synthesizeText ?? synthesizeWithHermes
        this.postTtsCooldownMs = deps.postTtsCooldownMs ?? POST_TTS_COOLDOWN_MS
        this.turnTimeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS
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
        this.localTtsOutputConfig = readLocalTtsOutputConfig()
        if (typeof deps.autoLedEnabled === 'boolean') this.autoLedConfig.enabled = deps.autoLedEnabled
        this.streamingDecoder = this.createInputOpusDecoderFn()
        this.bargeInDecoder = this.createInputOpusDecoderFn()
        this.registerDeviceSessionFn = deps.registerDeviceSession ?? registerDeviceSession
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        this.cancelProcessingTurn()
        this.cancelFastAckWarmup()
        this.followupQueue = []
        this.cooldownFrames = []
        // Firmware restores on disconnect/lease expiry; this closed session
        // cannot retain or reacquire volume ownership.
        if (this.localSpeakerOwner) this.localSpeakerOwner.m5SpeakerMutedForLocalOutput = false
        this.localSpeakerOwner = undefined
        this.clearTimers()
        this.unregisterDeviceSession()
        this.streamingDecoder.dispose()
        this.bargeInDecoder.dispose()
        for (const [id, pending] of this.pendingMcp) {
            clearTimeout(pending.timer)
            pending.reject(new Error('StackChan WebSocket disconnected'))
            this.pendingMcp.delete(id)
        }
        void Promise.resolve().then(() => this.hermes.dispose()).catch(() => {
            console.warn(`[session ${this.sessionId}] Hermes cleanup failed; local session is closed`)
        })
    }

    handleMessage(data: Buffer | string): void {
        if (this.closed) return
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
        if (this.diagnosticVoicePaused) return
        const payload = extractOpusPayload(data, this.version)
        if (!payload) return

        if (this.state === 'processing') {
            this.tryHandleBargeIn(payload)
            return
        }

        if (this.state === 'idle' && Date.now() < this.cooldownUntil) {
            // Older firmware already displays Listening after tts.stop. Preserve
            // its input until our cooldown ends instead of losing the next word.
            this.cooldownFrames.push(Buffer.from(payload))
            const limit = Math.ceil(MAX_RECORDING_MS / INPUT_FRAME_DURATION_MS)
            if (this.cooldownFrames.length > limit) this.cooldownFrames.shift()
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
            this.streamingDecodeFailures += 1
            this.recreateStreamingDecoder()
            this.localVad.reset()
            this.pcmChunks = []
            this.currentSpeechMs = 0
            if (this.streamingDecodeFailures >= STREAMING_DECODE_FAILURE_LIMIT) {
                this.streamingDecodeFailed = true
                console.warn(`[session ${this.sessionId}] local VAD streaming decode failed ${this.streamingDecodeFailures} times, using arrival-gap timeout: ${String(error)}`)
            } else {
                console.warn(`[session ${this.sessionId}] local VAD streaming decode skipped invalid frame ${this.streamingDecodeFailures}/${STREAMING_DECODE_FAILURE_LIMIT}: ${String(error)}`)
            }
            this.resetSilenceTimer()
            return
        }
        this.streamingDecodeFailures = 0
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
            this.armMaxDurationTimer()
            console.log(`[session ${this.sessionId}] vad speech started rms=${result.rms.toFixed(4)}`)
        }

        if (result.ignoredShortSpeech) {
            console.log(`[session ${this.sessionId}] vad ignored short speech speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.preRollPcmChunks = this.pcmChunks.splice(0)
            this.localVad.reset()
            this.currentSpeechMs = 0
            return
        }

        if (result.utteranceEnded) {
            console.log(`[session ${this.sessionId}] vad silence ended speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.triggerProcess('local-vad')
        } else if (!this.installingCaptureFrames) {
            this.drainFollowupQueue()
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
        this.recreateStreamingDecoder()
        this.streamingDecodeFailed = false
        this.streamingDecodeFailures = 0
    }

    private resetBargeInDetector(): void {
        this.bargeInFrames = []
        this.bargeInVad.reset()
        this.recreateBargeInDecoder()
        this.bargeInDecodeFailed = false
        this.bargeInDecodeFailures = 0
    }

    private recreateStreamingDecoder(): void {
        this.streamingDecoder.dispose()
        this.streamingDecoder = this.createInputOpusDecoderFn()
    }

    private recreateBargeInDecoder(): void {
        this.bargeInDecoder.dispose()
        this.bargeInDecoder = this.createInputOpusDecoderFn()
    }

    private tryHandleBargeIn(payload: Buffer): boolean {
        if (!this.bargeInConfig.enabled || this.bargeInDecodeFailed) return false
        if (!this.ttsStreaming) return false
        if (Date.now() - this.ttsStartedAt < this.bargeInConfig.ignoreTtsStartMs) return false

        let pcm: Buffer
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.bargeInDecoder.decodeFrame(payload)
        } catch (error) {
            this.bargeInDecodeFailures += 1
            this.bargeInVad.reset()
            this.bargeInFrames = []
            this.recreateBargeInDecoder()
            if (this.bargeInDecodeFailures >= BARGE_IN_DECODE_FAILURE_LIMIT) {
                this.bargeInDecodeFailed = true
                console.warn(`[session ${this.sessionId}] barge-in decode failed ${this.bargeInDecodeFailures} times, disabled for current TTS: ${String(error)}`)
            } else {
                console.warn(`[session ${this.sessionId}] barge-in decode skipped invalid frame ${this.bargeInDecodeFailures}/${BARGE_IN_DECODE_FAILURE_LIMIT}: ${String(error)}`)
            }
            return false
        }
        this.bargeInDecodeFailures = 0

        this.bargeInFrames.push(Buffer.from(payload))
        const limit = Math.ceil((this.bargeInConfig.startSpeechMs + this.bargeInConfig.minSpeechMs + 240) / INPUT_FRAME_DURATION_MS)
        if (this.bargeInFrames.length > limit) this.bargeInFrames.shift()
        const result = this.bargeInVad.processPcm(pcm)
        if (!result.inSpeech || result.speechMs < this.bargeInConfig.minSpeechMs) return false

        console.log(`[session ${this.sessionId}] barge-in detected rms=${result.rms.toFixed(4)} speechMs=${result.speechMs}`)
        this.handleBargeIn(this.bargeInFrames.splice(0))
        return true
    }

    private beginProcessingTurn(): AbortController {
        this.cancelProcessingTurn()
        const turn = new AbortController()
        this.processingTurn = turn
        const epoch = ++this.producerEpoch
        this.turnDeadlines.set(turn, Date.now() + this.turnTimeoutMs)
        const timer = setTimeout(() => {
            if (this.processingTurn !== turn || this.closed) return
            this.sendProcessingErrorAlert(new Error('Conversation deadline exceeded'))
            this.cancelProcessingTurn()
            const retirement = this.interruptHermes()
            this.state = 'idle'
            this.cooldownUntil = 0
            void retirement.then(() => {
                if (this.closed || this.producerEpoch !== epoch || this.state !== 'idle') return
                this.drainFollowupQueue()
                if (this.state === 'idle' && this.shouldAutoResumeListening()) this.startListening('turn-timeout')
            })
        }, this.turnTimeoutMs)
        turn.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
        return turn
    }

    private interruptHermes(): Promise<void> {
        // Invoke synchronously so an RPC client quarantines its generation now;
        // its bounded retirement must settle before a subsequent producer.
        try {
            this.hermesRetirement = this.hermes.interrupt().catch(() => {
                console.warn(`[session ${this.sessionId}] Hermes interruption cleanup failed`)
            })
        } catch {
            this.hermesRetirement = Promise.resolve()
        }
        return this.hermesRetirement
    }

    private turnOptions(turn: AbortController): HermesTurnOptions {
        return { signal: turn.signal, deadline: this.turnDeadlines.get(turn) }
    }

    private finishProcessingTurn(turn: AbortController, source: string): void {
        if (this.processingTurn !== turn || this.closed) return
        this.processingTurn = undefined
        this.followupRunning = false
        turn.abort()
        this.state = 'idle'
        this.setAutoLedState('idle')
        // Accepted notifications take priority over returning to quiet listening.
        this.drainFollowupQueue()
        if (this.state !== 'idle' || !this.shouldAutoResumeListening()) return
        if (Date.now() < this.cooldownUntil) this.delayListeningUntilCooldownEnds(source)
        else this.startListening(source)
    }

    private isProcessingTurnActive(turn: AbortController): boolean {
        return !this.closed && this.state === 'processing' && this.processingTurn === turn && !turn.signal.aborted
    }

    private cancelProcessingTurn(): void {
        const turn = this.processingTurn
        this.processingTurn = undefined
        this.followupRunning = false
        turn?.abort()
        this.cancelTtsPlayback()
    }

    private cancelTtsPlayback(): void {
        const playback = this.activeTtsPlayback
        if (!playback) return
        this.activeTtsPlayback = undefined
        playback.interrupted = true
        if (playback.speakerLeaseTimer) clearInterval(playback.speakerLeaseTimer)
        playback.controller.abort()
        this.sendTtsStopOnce(playback.generation)
        this.ttsStreaming = false
        // Restore independently of a cancelled synthesis/local process settling.
        void this.restoreM5SpeakerAfterLocalOutput(playback)
    }

    private cancelFastAckWarmup(): void {
        const warmup = this.fastAckWarmup
        this.fastAckWarmup = undefined
        warmup?.abort()
    }

    private handleBargeIn(firstPayloads: Buffer[]): void {
        this.cancelProcessingTurn()
        this.cancelFastAckWarmup()
        const interruptedGeneration = this.ttsGeneration
        this.sendTtsStopOnce(interruptedGeneration)
        this.ttsGeneration += 1
        this.ttsStreaming = false
        this.cooldownUntil = 0
        this.clearTimers()
        this.resetCapture()
        this.resetBargeInDetector()
        void this.interruptHermes()
        this.startListening('barge-in', firstPayloads)
        this.setAutoLedState('listening')
    }

    private triggerProcess(reason: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap', force = false): void {
        if (this.state !== 'listening') return
        this.clearTimers()
        const hasVadPcm = this.pcmChunks.length > 0
        // An explicit stop ends healthy-VAD capture; buffered Opus alone is not
        // speech evidence (including after an ignored short utterance was reset).
        // Preserve forced processing when VAD is disabled or decoding is uncertain.
        if (reason === 'listen-stop' && this.shouldUseLocalVad() && this.streamingDecodeFailures === 0 &&
            !hasVadPcm && this.currentSpeechMs === 0) {
            this.resetCapture()
            this.state = 'idle'
            this.setAutoLedState('idle')
            this.drainFollowupQueue()
            return
        }
        const pcmBytes = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const minPcmBytes = Math.ceil((this.localVadConfig.minSpeechMs / 1000) * INPUT_SAMPLE_RATE) * 2
        if (!force && hasVadPcm && (this.currentSpeechMs < this.localVadConfig.minSpeechMs || pcmBytes < minPcmBytes)) {
            console.log(`[session ${this.sessionId}] too little VAD speech speechMs=${this.currentSpeechMs} pcmBytes=${pcmBytes}, restarting listen`)
            this.resetCapture()
            this.startListening('short-speech')
            return
        }
        if (!force && !hasVadPcm && this.opusFrames.length < MIN_FRAMES_FOR_STT) {
            console.log(`[session ${this.sessionId}] too few frames (${this.opusFrames.length}), restarting listen`)
            this.resetCapture()
            this.startListening('too-few-frames')
            return
        }
        const turn = this.beginProcessingTurn()
        this.processingSource = reason
        this.state = 'processing'
        this.setAutoLedState('thinking')
        this.process(turn).catch(async (err) => {
            if (!this.isProcessingTurnActive(turn)) return
            console.error(`[session ${this.sessionId}] process error:`, err)
            this.setAutoLedState('error')
            this.sendProcessingErrorAlert(err)
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.error', turn).catch((error) => {
                    if (this.isProcessingTurnActive(turn)) console.error(`[session ${this.sessionId}] error speech failed:`, error)
                })
                if (this.isProcessingTurnActive(turn)) this.sendProcessingErrorAlert(err)
            }
        }).finally(() => this.finishProcessingTurn(turn, 'post-tts'))
    }

    private shouldAutoResumeListening(): boolean {
        return AUTO_RESUME_LISTENING &&
            (this.lastListenMode === 'realtime' || this.lastListenMode === 'auto') &&
            !this.closed
    }

    private startListening(source: string, initialFrames: Buffer[] = []): void {
        this.producerEpoch += 1
        if (this.processingTurn) void this.interruptHermes()
        this.cancelProcessingTurn()
        this.clearTimers()
        this.state = 'listening'
        this.resetCapture()
        this.setAutoLedState('listening')
        if (!this.localVadConfig.enabled) {
            console.log(`[session ${this.sessionId}] local vad disabled, using arrival-gap timeout`)
        }
        this.armMaxDurationTimer()
        const buffered = [...initialFrames, ...this.cooldownFrames.splice(0)]
        this.installingCaptureFrames = true
        try {
            for (const payload of buffered) {
                if (this.state !== 'listening') break
                this.handleListeningPayload(payload)
            }
        } finally { this.installingCaptureFrames = false }
        console.log(`[session ${this.sessionId}] listening started (${source})`)
        this.drainFollowupQueue()
    }

    private armMaxDurationTimer(): void {
        if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
        this.maxDurationTimer = setTimeout(() => {
            if (this.shouldUseLocalVad() && this.pcmChunks.length === 0 && this.currentSpeechMs === 0) {
                console.log(`[session ${this.sessionId}] max duration reached without VAD speech, restarting listen`)
                this.resetCapture()
                this.startListening('empty-timeout')
                return
            }
            console.log(`[session ${this.sessionId}] max duration reached, triggering process`)
            this.triggerProcess('max-duration', true)
        }, MAX_RECORDING_MS)
    }

    private delayListeningUntilCooldownEnds(source: string): void {
        if (this.delayedListenTimer) clearTimeout(this.delayedListenTimer)
        this.resetCapture()
        const delayMs = Math.max(0, this.cooldownUntil - Date.now())
        this.delayedListenTimer = setTimeout(() => {
            this.delayedListenTimer = undefined
            if (this.state !== 'idle') return
            this.startListening(source)
        }, delayMs)
        console.log(`[session ${this.sessionId}] listen start delayed ${delayMs}ms (post-TTS cooldown)`)
    }

    private handleJson(msg: Record<string, unknown>): void {
        const type = msg['type'] as string | undefined

        if (type === 'hello') {
            this.cancelFastAckWarmup()
            this.version = (msg['version'] as number | undefined) ?? 3
            this.ttsProvider = readTtsProvider(msg['tts_provider'])
            this.fastAckEntries = undefined
            this.fastAckFailed = false
            this.sendJson({
                type: 'hello',
                transport: 'websocket',
                session_id: this.sessionId,
                tts_provider: this.ttsProvider,
                audio_params: {
                    sample_rate: OUTPUT_SAMPLE_RATE,
                    frame_duration: OUTPUT_FRAME_DURATION_MS,
                },
            })
            if (!this.helloReceived) this.unregisterDeviceSession = this.registerDeviceSessionFn(this)
            this.helloReceived = true
            console.log(`[session ${this.sessionId}] hello, protocol version=${this.version}, tts=${this.ttsProvider}`)
            if (FAST_ACK_ENABLED && !this.diagnosticVoicePaused) void this.warmFastAck()
            return
        }

        if (type === 'listen') {
            if (this.diagnosticVoicePaused) return
            const listenState = msg['state'] as string | undefined
            if (listenState === 'start' || listenState === 'detect') {
                const isWakeWordStart = listenState === 'detect'
                const mode = String(msg['mode'] ?? '')
                const source = isWakeWordStart ? `wake_word=${formatConversationLogText(String(msg['text'] ?? ''), undefined, false)}` : `mode=${mode}`
                if (!isWakeWordStart) this.lastListenMode = mode
                if (!isWakeWordStart && Date.now() < this.cooldownUntil) {
                    if (this.state === 'listening') {
                        console.log(`[session ${this.sessionId}] listen start already active (${source})`)
                        return
                    }
                    // An explicit device listen.start means its UI/microphone
                    // are ready now. Accept immediately rather than discard input.
                    this.cooldownUntil = 0
                }
                this.startListening(source)
            } else if (listenState === 'stop') {
                this.triggerProcess('listen-stop', true)
            }
        }

        if (type === 'abort') {
            this.cancelProcessingTurn()
            this.cancelFastAckWarmup()
            this.clearTimers()
            this.sendTtsStopOnce(this.ttsGeneration)
            this.ttsGeneration += 1
            this.ttsStreaming = false
            this.cooldownUntil = 0
            this.state = 'idle'
            this.resetCapture()
            this.resetBargeInDetector()
            this.followupQueue = []
            this.cooldownFrames = []
            this.setAutoLedState('idle')
            void this.interruptHermes()
            return
        }

        if (type === 'mcp') {
            this.handleMcpPayload(msg['payload'])
        }
    }

    private async process(turn: AbortController): Promise<void> {
        const processStartMs = nowMs()
        const frames = this.opusFrames.splice(0)
        const vadPcm = this.pcmChunks.splice(0)
        this.preRollPcmChunks = []
        const source = this.processingSource
        console.log(`[session ${this.sessionId}] processing source=${source} frames=${frames.length} pcmBytes=${vadPcm.reduce((sum, chunk) => sum + chunk.length, 0)}`)
        if (frames.length === 0 && vadPcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-capture')
            return
        }

        // 1. Opus -> PCM -> Hermes STT
        const pcm = vadPcm.length > 0
            ? Buffer.concat(vadPcm)
            : await withTiming(
                `session:${this.sessionId}:audio.decode`,
                async () => this.decodeOpusFramesFn(frames),
                { frames: frames.length },
            )
        if (!this.isProcessingTurnActive(turn)) return
        if (pcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-pcm')
            return
        }
        if (source === 'max-duration' && vadPcm.length === 0 && MAX_DURATION_STT_RMS_THRESHOLD > 0) {
            const rms = rmsNormalized(pcm)
            if (rms < MAX_DURATION_STT_RMS_THRESHOLD) {
                console.log(`[session ${this.sessionId}] ignored low-rms max-duration audio rms=${rms.toFixed(4)} threshold=${MAX_DURATION_STT_RMS_THRESHOLD.toFixed(4)}`)
                this.resumeListeningAfterIgnoredInput('low-rms-timeout')
                return
            }
        }

        const wavForStt = pcmToWav(pcm, INPUT_SAMPLE_RATE)
        const text = await withTiming(
            `session:${this.sessionId}:stt`,
            () => this.transcribeWavFn(wavForStt, this.turnOptions(turn)),
            { pcmBytes: pcm.length },
        )
        if (!this.isProcessingTurnActive(turn)) return
        console.log(`[session ${this.sessionId}] STT: ${formatConversationLogText(text)}`)

        if (!text.trim()) {
            this.resumeListeningAfterIgnoredInput('empty-transcript')
            return
        }
        if (isIgnorableShortTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored short transcript: ${formatConversationLogText(text)}`)
            this.resumeListeningAfterIgnoredInput('ignored-short-transcript')
            return
        }
        if (source === 'max-duration' && vadPcm.length === 0 && isIgnorableTimeoutTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored timeout transcript: ${formatConversationLogText(text)}`)
            this.resumeListeningAfterIgnoredInput('ignored-timeout-transcript')
            return
        }

        this.sendJson({ type: 'stt', text })
        await this.trySpeakFastAck(turn)
        if (!this.isProcessingTurnActive(turn)) return

        // 2. Hermes LLM turn -> 3. selected TTS -> Opus -> device
        await this.speakHermesReply(text, 'llm', 'tts', turn)
        if (this.isProcessingTurnActive(turn)) this.setAutoLedState('idle')
        console.log(`[timing] done session:${this.sessionId}:process elapsed=${elapsedMs(processStartMs)}`)
    }

    private resumeListeningAfterIgnoredInput(source: string): void {
        if (this.state !== 'processing' || this.closed) return
        this.startListening(source)
    }

    async enqueueFollowup(prompt: string): Promise<void> {
        if (this.diagnosticVoicePaused) throw new Error('StackChan diagnostic voice pause is enabled')
        const cleanPrompt = prompt.trim()
        if (this.closed) throw new Error('StackChan session is closed')
        if (!cleanPrompt) throw new Error('Follow-up prompt is empty')
        if (this.followupQueue.length >= 32) throw new Error('StackChan follow-up queue is full')
        this.followupQueue.push(cleanPrompt)
        this.drainFollowupQueue()
    }

    getBridgeStatus(): StackChanBridgeStatus & { diagnosticVoicePaused: boolean } {
        const cooldownRemainingMs = Math.max(0, this.cooldownUntil - Date.now())
        const readyForPrompt =
            !this.closed &&
            !this.diagnosticVoicePaused &&
            this.state === 'listening' &&
            !this.ttsStreaming &&
            cooldownRemainingMs === 0 &&
            !this.followupRunning &&
            this.followupQueue.length === 0 &&
            this.delayedListenTimer === undefined

        let reason = 'ready'
        if (this.closed) reason = 'closed'
        else if (this.diagnosticVoicePaused && this.helloReceived) reason = 'diagnostic_voice_paused'
        else if (this.state !== 'listening') reason = `state_${this.state}`
        else if (this.ttsStreaming) reason = 'tts_streaming'
        else if (cooldownRemainingMs > 0) reason = 'post_tts_cooldown'
        else if (this.followupRunning) reason = 'followup_running'
        else if (this.followupQueue.length > 0) reason = 'followup_queued'
        else if (this.delayedListenTimer !== undefined) reason = 'listen_delayed'

        return {
            connected: !this.closed,
            diagnosticVoicePaused: this.diagnosticVoicePaused,
            sessionId: this.sessionId,
            state: this.state,
            readyForPrompt,
            reason,
            ttsProvider: this.ttsProvider,
            ttsStreaming: this.ttsStreaming,
            cooldownRemainingMs,
            followupRunning: this.followupRunning,
            followupQueued: this.followupQueue.length,
            pendingMcp: this.pendingMcp.size,
            lastListenMode: this.lastListenMode,
        }
    }

    private drainFollowupQueue(): void {
        if (this.diagnosticVoicePaused || this.closed || this.followupRunning || this.state === 'processing') return
        const capturing = this.shouldUseLocalVad()
            ? this.pcmChunks.length > 0 || this.currentSpeechMs > 0 || this.localVad.hasCandidateSpeech()
            : this.opusFrames.length > 0
        // Implicit old-device input is already human capture even while the
        // post-TTS timer keeps state idle. Do not steal its remaining frames.
        if (this.cooldownFrames.length > 0 || (this.state === 'listening' && capturing)) return
        if (this.followupQueue.length === 0) return
        this.clearTimers()
        this.resetCapture()
        this.state = 'idle'
        const prompt = this.followupQueue.shift()
        if (!prompt) return

        const turn = this.beginProcessingTurn()
        this.followupRunning = true
        this.state = 'processing'
        this.setAutoLedState('thinking')
        this.processFollowup(prompt, turn).catch(async (err) => {
            if (!this.isProcessingTurnActive(turn)) return
            console.error(`[session ${this.sessionId}] follow-up error:`, err)
            this.setAutoLedState('error')
            this.sendProcessingErrorAlert(err)
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.followup.error', turn).catch((error) => {
                    if (this.isProcessingTurnActive(turn)) console.error(`[session ${this.sessionId}] follow-up error speech failed:`, error)
                })
                if (this.isProcessingTurnActive(turn)) this.sendProcessingErrorAlert(err)
            }
        }).finally(() => this.finishProcessingTurn(turn, 'post-followup'))
    }

    private async processFollowup(prompt: string, turn: AbortController): Promise<void> {
        const followupStartMs = nowMs()
        console.log(`[session ${this.sessionId}] follow-up prompt queued length=${prompt.length}`)
        await this.speakHermesReply(prompt, 'followup.llm', 'tts.followup', turn)
        console.log(`[timing] done session:${this.sessionId}:followup elapsed=${elapsedMs(followupStartMs)}`)
    }

    private startProcessingKeepalive(turn: AbortController): () => void {
        const timer = setInterval(() => {
            if (this.isProcessingTurnActive(turn)) this.sendJson({ type: 'llm', emotion: 'doubtful' })
        }, PROCESSING_KEEPALIVE_MS)
        const stop = () => clearInterval(timer)
        turn.signal.addEventListener('abort', stop, { once: true })
        return () => {
            stop()
            turn.signal.removeEventListener('abort', stop)
        }
    }

    private async speakHermesReply(prompt: string, llmLabel: string, ttsLabel: string, turn: AbortController): Promise<string> {
        await this.hermesRetirement
        if (!this.isProcessingTurnActive(turn)) return ''
        const hermesPrompt = stackChanVoicePrompt(prompt)
        if (this.hermes.streamPrompt && readEnvBool('STACKCHAN_STREAM_LLM_TTS', true)) {
            return await this.speakHermesReplyStreaming(hermesPrompt, llmLabel, ttsLabel, turn)
        }
        return await this.speakHermesReplyBuffered(hermesPrompt, llmLabel, ttsLabel, turn)
    }

    private async speakHermesReplyBuffered(prompt: string, llmLabel: string, ttsLabel: string, turn: AbortController): Promise<string> {
        const stopKeepalive = this.startProcessingKeepalive(turn)
        this.sendJson({ type: 'llm', emotion: 'doubtful' })
        let reply: string
        try {
            reply = await withTiming(
                `session:${this.sessionId}:${llmLabel}`,
                () => this.hermes.submitPrompt(prompt, this.turnOptions(turn)),
                { textLength: prompt.length },
            )
        } finally {
            stopKeepalive()
        }
        if (!this.isProcessingTurnActive(turn)) return reply
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): ${formatConversationLogText(reply)}`)
        this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) })
        void this.displayFirstImageFromReply(reply)

        const speechSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig)
        await this.speakSegments(speechSegments, ttsLabel, turn)
        return reply
    }

    private async speakHermesReplyStreaming(prompt: string, llmLabel: string, ttsLabel: string, turn: AbortController): Promise<string> {
        const streamPrompt = this.hermes.streamPrompt
        if (!streamPrompt) return await this.speakHermesReplyBuffered(prompt, llmLabel, ttsLabel, turn)

        const stopKeepalive = this.startProcessingKeepalive(turn)
        this.sendJson({ type: 'llm', emotion: 'doubtful' })

        const llmStartMs = nowMs()
        let reply = ''
        let spokenSegments = 0
        let playback: TtsPlayback | undefined
        let streamCompleted = false

        try {
            for await (const event of streamPrompt.call(this.hermes, prompt, this.turnOptions(turn))) {
                if (event.type === 'delta') {
                    reply += event.text
                } else if (event.type === 'complete' && event.text) {
                    reply = event.text
                }

                if (!this.isProcessingTurnActive(turn)) break
                const stableSegments = stableSpeechSegmentsFromPartialReply(reply, this.speechSegmentationConfig)
                while (spokenSegments < stableSegments.length && this.isProcessingTurnActive(turn)) {
                    playback ??= this.startTtsPlayback(ttsLabel, turn)
                    await this.speakSegmentInPlayback(
                        playback,
                        stableSegments[spokenSegments],
                        `${ttsLabel}.stream.segment${spokenSegments}`,
                        spokenSegments,
                    )
                    spokenSegments += 1
                    if (playback.interrupted) break
                }
                if (playback?.interrupted || !this.isProcessingTurnActive(turn)) break
                if (
                    STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS &&
                    spokenSegments >= this.speechSegmentationConfig.maxSegments
                ) {
                    console.log(`[session ${this.sessionId}] stopping LLM stream after spoken segment limit (${spokenSegments})`)
                    void this.interruptHermes()
                    break
                }
            }
            streamCompleted = true
        } finally {
            stopKeepalive()
            if (playback && (!streamCompleted || !this.isProcessingTurnActive(turn))) {
                await this.finishTtsPlayback(playback)
            }
        }

        console.log(`[timing] done session:${this.sessionId}:${llmLabel}.stream elapsed=${elapsedMs(llmStartMs)}`)
        if (!this.isProcessingTurnActive(turn)) return reply
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): ${formatConversationLogText(reply)}`)
        this.sendJson({ type: 'llm', emotion: inferStackChanEmotion(reply) })
        void this.displayFirstImageFromReply(reply)

        const finalSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig)
        if (!playback) {
            await this.speakSegments(finalSegments, ttsLabel, turn)
            return reply
        }

        try {
            const remainingSegments = finalSegments.slice(spokenSegments)
            await this.speakSegmentsInPlayback(playback, remainingSegments, ttsLabel, spokenSegments)
        } finally {
            await this.finishTtsPlayback(playback)
        }
        return reply
    }

    private async synthesizeSegment(speechText: string, label: string, signal: AbortSignal, leadSilenceMs = 0): Promise<SynthesizedSegment> {
        signal.throwIfAborted()
        const synthesisLabel = `session:${this.sessionId}:${label}.synthesize`
        const synthesisStartMs = nowMs()
        console.log(`[timing] start ${synthesisLabel} ${JSON.stringify({ textLength: speechText.length, provider: this.ttsProvider })}`)
        let wav: Buffer
        try {
            wav = this.ttsProvider === 'hermes'
                ? await this.synthesizeHermesTextFn(speechText, { signal, deadline: this.processingTurn ? this.turnDeadlines.get(this.processingTurn) : undefined })
                : await this.synthesizeSanoTextFn(speechText, { signal })
            signal.throwIfAborted()
            console.log(`[timing] done ${synthesisLabel} elapsed=${elapsedMs(synthesisStartMs)}`)
        } catch (error) {
            console.log(`[timing] ${signal.aborted ? 'cancelled' : 'error'} ${synthesisLabel} elapsed=${elapsedMs(synthesisStartMs)}`)
            throw error
        }
        if (leadSilenceMs > 0) {
            console.log(`[session ${this.sessionId}] tts preroll ${leadSilenceMs}ms`)
        }
        const opusFrames = await withTiming(
            `session:${this.sessionId}:${label}.encode`,
            async () => this.encodeWavToOpusFramesFn(wav, leadSilenceMs),
            { wavBytes: wav.length, leadSilenceMs },
        )
        signal.throwIfAborted()
        return { wav, opusFrames }
    }

    private async warmFastAck(): Promise<void> {
        if (this.closed || this.fastAckEntries || this.fastAckFailed || this.fastAckWarmup) return
        const warmup = new AbortController()
        this.fastAckWarmup = warmup
        // Publish only a complete cache. An old warmup cannot overwrite a new hello.
        const entries: FastAckCacheEntry[] = []
        try {
            for (let index = 0; index < FAST_ACK_TEXTS.length; index++) {
                const text = FAST_ACK_TEXTS[index]
                const audio = await this.synthesizeSegment(text, `tts.fast_ack.cache${index}`, warmup.signal, TTS_PREROLL_MS)
                // Native WAV has no M5 preroll. Cache a matching avatar stream so
                // a muted M5 silence prefix does not delay the subsequent LLM request.
                const localFrames = this.localTtsOutputConfig.enabled && TTS_PREROLL_MS > 0
                    ? await withTiming(`session:${this.sessionId}:tts.fast_ack.cache${index}.encode.local`,
                        async () => this.encodeWavToOpusFramesFn(audio.wav, 0))
                    : audio.opusFrames
                warmup.signal.throwIfAborted()
                entries.push({ text, wav: audio.wav, frames: audio.opusFrames, localFrames })
            }
            if (this.fastAckWarmup !== warmup || warmup.signal.aborted || this.closed) return
            this.fastAckEntries = entries
            console.log(`[session ${this.sessionId}] fast ack cached variants=${entries.length}`)
        } catch (error) {
            if (this.fastAckWarmup !== warmup || warmup.signal.aborted || this.closed) return
            this.fastAckFailed = true
            console.warn(`[session ${this.sessionId}] fast ack cache failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            if (this.fastAckWarmup === warmup) this.fastAckWarmup = undefined
        }
    }

    private pickFastAck(): FastAckCacheEntry | undefined {
        if (!this.fastAckEntries || this.fastAckEntries.length === 0) return undefined
        if (this.fastAckEntries.length === 1) return this.fastAckEntries[0]

        let index = Math.floor(Math.random() * this.fastAckEntries.length)
        if (index === this.lastFastAckIndex) {
            index = (index + 1 + Math.floor(Math.random() * (this.fastAckEntries.length - 1))) % this.fastAckEntries.length
        }
        this.lastFastAckIndex = index
        return this.fastAckEntries[index]
    }

    private async trySpeakFastAck(turn: AbortController): Promise<void> {
        if (!this.isProcessingTurnActive(turn) || !FAST_ACK_ENABLED || this.fastAckFailed) return
        if (!this.fastAckEntries) {
            void this.warmFastAck()
            return
        }

        const ack = this.pickFastAck()
        if (!ack) return
        const playback = this.startTtsPlayback('tts.fast_ack', turn)
        try {
            console.log(`[session ${this.sessionId}] fast ack selected: ${formatConversationLogText(ack.text)}`)
            await this.speakCachedSegmentInPlayback(playback, ack.text, ack.wav, ack.frames, 0, ack.localFrames)
        } finally {
            await this.finishTtsPlayback(playback)
        }
    }

    private async speakSegments(segments: string[], label: string, turn: AbortController): Promise<void> {
        if (segments.length === 0 || !this.isProcessingTurnActive(turn)) return
        const playback = this.startTtsPlayback(label, turn)
        try {
            await this.speakSegmentsInPlayback(playback, segments, label, 0)
        } finally {
            await this.finishTtsPlayback(playback)
        }
    }

    private startTtsPlayback(label: string, turn: AbortController): TtsPlayback {
        this.cancelTtsPlayback()
        const generation = this.ttsGeneration + 1
        this.ttsGeneration = generation
        this.ttsStopSent = false
        this.ttsStreaming = true
        this.ttsStartedAt = Date.now()
        this.resetBargeInDetector()
        this.sendJson({ type: 'tts', state: 'start' })
        this.setAutoLedState('speaking')
        const playback: TtsPlayback = {
            turn,
            controller: new AbortController(),
            generation,
            label,
            streamStartMs: nowMs(),
            streamedFrames: 0,
            segmentCount: 0,
            interrupted: false,
            firstFrameLogged: false,
            firstAudibleFrameLogged: false,
            localOutputChecked: false,
            m5SpeakerMutedForLocalOutput: false,
        }
        this.activeTtsPlayback = playback
        return playback
    }

    private isTtsPlaybackActive(playback: TtsPlayback): boolean {
        return this.isProcessingTurnActive(playback.turn) && this.activeTtsPlayback === playback &&
            !playback.controller.signal.aborted && this.ttsGeneration === playback.generation
    }

    private prefetchSegment(playback: TtsPlayback, segment: string, label: string, index: number): PrefetchedSegment {
        const promise = this.synthesizeSegment(segment, `${label}.segment${index}`, playback.controller.signal)
        promise.catch(() => undefined)
        return { index, promise }
    }

    private async speakSegmentsInPlayback(
        playback: TtsPlayback,
        segments: string[],
        label: string,
        startIndex: number,
    ): Promise<void> {
        let prefetched: PrefetchedSegment | undefined
        try {
            for (let offset = 0; offset < segments.length; offset++) {
                const index = startIndex + offset
                if (!this.isTtsPlaybackActive(playback)) {
                    playback.interrupted = true
                    break
                }

                const segment = segments[offset]
                const framesPromise = prefetched?.index === index ? prefetched.promise : undefined
                prefetched = undefined
                const nextSegment = segments[offset + 1]
                await this.speakSegmentInPlayback(
                    playback,
                    segment,
                    `${label}.segment${index}`,
                    index,
                    framesPromise,
                    () => {
                        if (nextSegment && this.isTtsPlaybackActive(playback)) {
                            prefetched = this.prefetchSegment(playback, nextSegment, label, index + 1)
                        }
                    },
                )
                if (playback.interrupted) break
            }
        } finally {
            prefetched?.promise.catch(() => undefined)
        }
    }

    private async speakSegmentInPlayback(
        playback: TtsPlayback,
        segment: string,
        label: string,
        index: number,
        framesPromise?: Promise<SynthesizedSegment>,
        onFramesReady?: () => void,
    ): Promise<void> {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }

        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index })
        await this.prepareLocalTtsOutput(playback)
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        const leadSilenceMs = playback.localOutputTarget
            ? 0
            : (index === 0 && playback.streamedFrames === 0 ? TTS_PREROLL_MS : 0)
        const audio = framesPromise ? await framesPromise : await this.synthesizeSegment(segment, label, playback.controller.signal, leadSilenceMs)
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        onFramesReady?.()
        await this.prepareSegmentOutput(playback)
        if (!this.isTtsPlaybackActive(playback)) { playback.interrupted = true; return }
        const localPlayback = this.startLocalSegmentPlayback(playback, audio.wav)
        localPlayback.catch(() => undefined)
        const leadSilenceFrames = Math.ceil(leadSilenceMs / OUTPUT_FRAME_DURATION_MS)
        const frames = audio.opusFrames
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const frame = frames[frameIndex]
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true
                break
            }
            if (playback.localSegmentFailed) break
            this.sendBinary(wrapOpusPayload(frame, this.version))
            playback.streamedFrames += 1
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames)
            await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
        }
        const localSucceeded = await localPlayback
        playback.localSegmentStreaming = false
        if ((!localSucceeded || playback.localSegmentFailed) && this.isTtsPlaybackActive(playback)) await this.replayFailedLocalSegment(playback, frames)
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        playback.segmentCount += 1
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index })
    }

    private async speakCachedSegmentInPlayback(
        playback: TtsPlayback,
        segment: string,
        wav: Buffer,
        opusFrames: Buffer[],
        index: number,
        localOpusFrames?: Buffer[],
    ): Promise<void> {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }

        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index })
        await this.prepareLocalTtsOutput(playback)
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        await this.prepareSegmentOutput(playback)
        if (!this.isTtsPlaybackActive(playback)) { playback.interrupted = true; return }
        const localPlayback = this.startLocalSegmentPlayback(playback, wav)
        localPlayback.catch(() => undefined)
        const frames = playback.localOutputTarget && localOpusFrames ? localOpusFrames : opusFrames
        const leadSilenceFrames = !playback.localOutputTarget && index === 0 && playback.streamedFrames === 0
            ? Math.ceil(TTS_PREROLL_MS / OUTPUT_FRAME_DURATION_MS)
            : 0
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
            const frame = frames[frameIndex]
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true
                break
            }
            if (playback.localSegmentFailed) break
            this.sendBinary(wrapOpusPayload(frame, this.version))
            playback.streamedFrames += 1
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames)
            await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
        }
        const localSucceeded = await localPlayback
        playback.localSegmentStreaming = false
        if ((!localSucceeded || playback.localSegmentFailed) && this.isTtsPlaybackActive(playback)) await this.replayFailedLocalSegment(playback, frames)
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        playback.segmentCount += 1
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index })
    }

    private async prepareSegmentOutput(playback: TtsPlayback): Promise<void> {
        // Reserve the segment before yielding: a concurrent renewal failure must
        // either be handled here (no frames sent yet), or stop/replay this segment.
        playback.localSegmentStreaming = true
        playback.localSegmentFailed = false
        await this.localSpeakerOperations
        if (!this.isTtsPlaybackActive(playback)) return
        if (!playback.localOutputTarget) {
            await this.restoreM5SpeakerAfterLocalOutput(playback)
            if (playback.m5SpeakerMutedForLocalOutput || this.localSpeakerOwner) {
                throw new Error('M5 speaker restoration unverified; cannot emit fallback audio')
            }
            if (!this.isTtsPlaybackActive(playback)) return
            if (playback.m5AdmissionNeedsReset) {
                this.sendJson({ type: 'tts', state: 'start', reset: true })
                playback.m5AdmissionNeedsReset = false
            }
            // Any failure before this verified fallback gate is now recovered.
            // Failures after returning keep the flag and trigger whole replay.
            playback.localSegmentFailed = false
        }
    }

    private queueLocalSpeakerOperation(operation: () => Promise<void>): Promise<void> {
        const queued = this.localSpeakerOperations.then(operation)
        // A failed ACK must not permanently poison the queue.
        this.localSpeakerOperations = queued.catch(() => undefined)
        return queued
    }

    private async prepareLocalTtsOutput(playback: TtsPlayback): Promise<void> {
        if (playback.localOutputChecked || !this.isTtsPlaybackActive(playback)) return
        playback.localOutputChecked = true
        await this.localSpeakerOperations
        if (this.localSpeakerOwner && this.localSpeakerOwner !== playback) {
            await this.restoreM5SpeakerAfterLocalOutput(this.localSpeakerOwner)
            if (this.localSpeakerOwner) throw new Error('Previous speaker lease restoration is unverified')
        }
        if (!this.localTtsOutputConfig.enabled) {
            await this.localSpeakerOperations
            return
        }

        try {
            const target = await resolveLocalTtsOutputTarget(this.localTtsOutputConfig, { signal: playback.controller.signal })
            if (!this.isTtsPlaybackActive(playback)) return
            if (!target) {
                // A newer M5 fallback must wait for any previous mute/restore ACK.
                await this.localSpeakerOperations
                if (this.isTtsPlaybackActive(playback)) console.log(`[session ${this.sessionId}] local TTS output unavailable; using M5 speaker`)
                return
            }
            await this.queueLocalSpeakerOperation(async () => {
                if (!this.isTtsPlaybackActive(playback)) return
                this.localSpeakerOwner = playback
                // The device may have applied mute even if its ACK fails/is late.
                playback.m5SpeakerMutedForLocalOutput = true
                playback.speakerLeaseId ??= `${this.sessionId}:${playback.generation}`
                const result = await this.callRobotToolInternal('self.robot.set_speaker_volume', {
                    volume: 0,
                    permanent: false,
                    lease_id: playback.speakerLeaseId,
                    lease_ms: SPEAKER_LEASE_MS,
                }, { automatic: true, waitForResponse: true })
                if (readSpeakerVolumeAck(result) !== 0 || !this.speakerLeaseAckMatches(result, playback)) throw new Error('M5 mute acknowledgement unverified')
            })
            if (!this.isTtsPlaybackActive(playback)) return
            playback.localOutputTarget = target
            playback.localOutputController = new AbortController()
            this.startSpeakerLeaseRenewal(playback)
            console.log(`[session ${this.sessionId}] local TTS output active target=${target}; M5 speaker muted temporarily`)
        } catch {
            if (!this.isTtsPlaybackActive(playback)) return
            console.warn(`[session ${this.sessionId}] local TTS output setup failed; using M5 speaker`)
            await this.restoreM5SpeakerAfterLocalOutput(playback)
            await this.localSpeakerOperations
            if (playback.m5SpeakerMutedForLocalOutput) throw new Error('M5 speaker restoration unverified; temporary lease will expire')
        }
    }

    private speakerLeaseAckMatches(result: unknown, playback: TtsPlayback): boolean {
        return readSpeakerVolumeAckRecord(result)?.['lease_id'] === playback.speakerLeaseId
    }

    private startSpeakerLeaseRenewal(playback: TtsPlayback): void {
        let renewing = false
        playback.speakerLeaseTimer = setInterval(() => {
            if (renewing || !this.isTtsPlaybackActive(playback) || this.localSpeakerOwner !== playback) return
            renewing = true
            void this.queueLocalSpeakerOperation(async () => {
                if (!this.isTtsPlaybackActive(playback) || this.localSpeakerOwner !== playback) return
                const result = await this.callRobotToolInternal('self.robot.set_speaker_volume', {
                    volume: 0, permanent: false, lease_id: playback.speakerLeaseId, lease_ms: SPEAKER_LEASE_MS,
                }, { automatic: true, waitForResponse: true })
                if (readSpeakerVolumeAck(result) !== 0 || !this.speakerLeaseAckMatches(result, playback)) throw new Error('Speaker lease renewal unverified')
            }).catch(async () => {
                playback.localOutputTarget = undefined
                playback.localSegmentFailed = true
                playback.localOutputController?.abort()
                // A running segment coordinates reap/flush/restore/replay itself.
                if (!playback.localSegmentStreaming) {
                    await this.restoreM5SpeakerAfterLocalOutput(playback)
                    if (playback.m5SpeakerMutedForLocalOutput) playback.controller.abort()
                }
            }).finally(() => { renewing = false })
        }, SPEAKER_LEASE_RENEW_MS)
    }

    private startLocalSegmentPlayback(playback: TtsPlayback, wav: Buffer): Promise<boolean> {
        const target = playback.localOutputTarget
        if (!target || !this.isTtsPlaybackActive(playback)) return Promise.resolve(true)
        return playWavOnLocalTarget(target, wav, { signal: playback.localOutputController
            ? AbortSignal.any([playback.controller.signal, playback.localOutputController.signal])
            : playback.controller.signal }).then(() => true).catch(async () => {
            if (!this.isTtsPlaybackActive(playback)) return true
            console.warn(`[session ${this.sessionId}] local TTS playback failed; coordinating M5 replay`)
            playback.localOutputTarget = undefined
            playback.localSegmentFailed = true
            return false
        })
    }

    private async replayFailedLocalSegment(playback: TtsPlayback, frames: Buffer[]): Promise<void> {
        // Discard the muted avatar suffix before unmuting. Firmware processes
        // reset admission synchronously; restore ACK orders the replay after it.
        this.sendJson({ type: 'tts', state: 'start', reset: true })
        await this.restoreM5SpeakerAfterLocalOutput(playback)
        if (playback.m5SpeakerMutedForLocalOutput) throw new Error('M5 fallback unavailable until speaker lease expires')
        if (!this.isTtsPlaybackActive(playback)) return
        // Restoration retires the muted hardware-output epoch. Open a fresh
        // admission epoch only after its ACK, never while an old player can run.
        this.sendJson({ type: 'tts', state: 'start', reset: true })
        playback.m5AdmissionNeedsReset = false
        // The failed external player's position is unknown: replay one full sentence.
        for (const frame of frames) {
            if (!this.isTtsPlaybackActive(playback)) return
            this.sendBinary(wrapOpusPayload(frame, this.version))
            playback.streamedFrames += 1
            await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
        }
    }

    private noteSpeakerLeaseReleased(playback: TtsPlayback): void {
        playback.m5SpeakerMutedForLocalOutput = false
        this.localSpeakerOwner = undefined
        // An older owner's deferred restoration can also retire the current
        // turn's admission. Reopen only at its verified fallback emission gate.
        if (this.activeTtsPlayback) this.activeTtsPlayback.m5AdmissionNeedsReset = true
    }

    private async restoreM5SpeakerAfterLocalOutput(playback: TtsPlayback): Promise<void> {
        if (!playback.m5SpeakerMutedForLocalOutput || this.localSpeakerOwner !== playback) return
        await this.queueLocalSpeakerOperation(async () => {
            if (!playback.m5SpeakerMutedForLocalOutput || this.localSpeakerOwner !== playback) return
            if (playback.speakerLeaseTimer) clearInterval(playback.speakerLeaseTimer)
            if (this.closed) return // Device disconnect/expiry owns recovery now.
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await this.callRobotToolInternal('self.robot.set_speaker_volume', {
                        volume: this.localTtsOutputConfig.fallbackM5Volume,
                        permanent: false,
                        lease_id: playback.speakerLeaseId,
                    }, { automatic: true, waitForResponse: true })
                    const restored = readSpeakerVolumeAck(result)
                    if (restored === undefined || !this.speakerLeaseAckMatches(result, playback)) throw new Error('M5 restore acknowledgement unverified')
                    this.noteSpeakerLeaseReleased(playback)
                    console.log(`[session ${this.sessionId}] M5 speaker restored volume=${restored}`)
                    return
                } catch {
                    if (this.closed) return
                }
            }
            // Expiry/disconnect/permanent user settings may have already released
            // the lease. Verify that fact without reapplying any fallback volume.
            try {
                const status = readSpeakerVolumeAckRecord(await this.callRobotToolInternal('self.robot.get_status', {}, {
                    automatic: true, waitForResponse: true,
                }))
                if (status?.['lease_active'] === false) {
                    this.noteSpeakerLeaseReleased(playback)
                    return
                }
            } catch { /* Unverified state retains responsibility; no blind unmute. */ }
            console.warn(`[session ${this.sessionId}] M5 restore unverified; bounded device lease retains recovery responsibility`)
        })
    }

    private logTtsFrameMilestones(playback: TtsPlayback, audibleFrame: boolean): void {
        if (!playback.firstFrameLogged) {
            playback.firstFrameLogged = true
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_frame_sent elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames}`)
        }
        if (audibleFrame && !playback.firstAudibleFrameLogged) {
            playback.firstAudibleFrameLogged = true
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_audible_frame_sent elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames}`)
        }
    }

    private async finishTtsPlayback(playback: TtsPlayback): Promise<void> {
        const wasActive = this.isTtsPlaybackActive(playback)
        if (this.activeTtsPlayback === playback) {
            this.sendTtsStopOnce(playback.generation)
            this.activeTtsPlayback = undefined
            this.ttsStreaming = false
            this.resetBargeInDetector()
        }
        // Reap any unconsumed prefetch without touching a later playback's signal.
        playback.controller.abort()
        console.log(`[timing] done session:${this.sessionId}:${playback.label}.stream elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames} segments=${playback.segmentCount}`)

        if (wasActive && !playback.interrupted) {
            // TTS 再生後のエコー誤検知を防ぐためクールダウンを設定
            this.cooldownUntil = Date.now() + this.postTtsCooldownMs
        }
        await this.restoreM5SpeakerAfterLocalOutput(playback)
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

    private sendProcessingErrorAlert(error: unknown): void {
        this.sendJson({
            type: 'alert',
            status: 'HERMES AI ERROR',
            message: buildProcessingErrorAlertMessage(error),
            emotion: 'sad',
        })
    }

    private sendJson(obj: Record<string, unknown>): void {
        if (this.closed) return
        try {
            this.ws.send(JSON.stringify(obj))
        } catch {
            // 切断済みの場合は無視
        }
    }

    private sendBinary(data: Buffer): void {
        if (this.closed) return
        try {
            this.ws.send(data)
        } catch {
            // 切断済みの場合は無視
        }
    }
}
