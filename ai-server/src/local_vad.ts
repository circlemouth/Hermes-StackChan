export const LOCAL_VAD_SAMPLE_RATE = 16000
export const LOCAL_VAD_FRAME_MS = 30
export const LOCAL_VAD_FRAME_SAMPLES = (LOCAL_VAD_SAMPLE_RATE * LOCAL_VAD_FRAME_MS) / 1000
export const LOCAL_VAD_FRAME_BYTES = LOCAL_VAD_FRAME_SAMPLES * 2

export type LocalRmsVadConfig = {
    enabled: boolean
    rmsThreshold: number
    startSpeechMs: number
    endSilenceMs: number
    minSpeechMs: number
    preRollMs: number
}

export type LocalRmsVadResult = {
    speechStarted: boolean
    inSpeech: boolean
    utteranceEnded: boolean
    ignoredShortSpeech: boolean
    speechMs: number
    silenceMs: number
    rms: number
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

export function readLocalRmsVadConfig(env: Record<string, string | undefined> = process.env): LocalRmsVadConfig {
    return {
        enabled: readEnvBool('STACKCHAN_LOCAL_VAD_ENABLED', true, env),
        rmsThreshold: readEnvFloat('STACKCHAN_VAD_RMS_THRESHOLD', 0.012, 0.001, 0.2, env),
        startSpeechMs: readEnvInt('STACKCHAN_VAD_START_SPEECH_MS', 120, LOCAL_VAD_FRAME_MS, 2000, env),
        endSilenceMs: readEnvInt('STACKCHAN_VAD_END_SILENCE_MS', 900, LOCAL_VAD_FRAME_MS, 5000, env),
        minSpeechMs: readEnvInt('STACKCHAN_VAD_MIN_SPEECH_MS', 240, LOCAL_VAD_FRAME_MS, 5000, env),
        preRollMs: readEnvInt('STACKCHAN_VAD_PREROLL_MS', 300, 0, 3000, env),
    }
}

export function rmsNormalized(pcm: Buffer): number {
    const samples = Math.floor(pcm.length / 2)
    if (samples === 0) return 0

    let sumSquares = 0
    for (let i = 0; i < samples; i++) {
        const sample = pcm.readInt16LE(i * 2)
        sumSquares += sample * sample
    }
    return Math.sqrt(sumSquares / samples) / 32768
}

const EMPTY_RESULT: LocalRmsVadResult = {
    speechStarted: false,
    inSpeech: false,
    utteranceEnded: false,
    ignoredShortSpeech: false,
    speechMs: 0,
    silenceMs: 0,
    rms: 0,
}

export class LocalRmsVad {
    private pending = Buffer.alloc(0)
    private speechRunMs = 0
    private activeSpeechMs = 0
    private silenceRunMs = 0
    private started = false
    private lastRms = 0

    constructor(private readonly config: LocalRmsVadConfig = readLocalRmsVadConfig()) {}

    reset(): void {
        this.pending = Buffer.alloc(0)
        this.speechRunMs = 0
        this.activeSpeechMs = 0
        this.silenceRunMs = 0
        this.started = false
        this.lastRms = 0
    }

    processPcm(pcm: Buffer): LocalRmsVadResult {
        if (!this.config.enabled || pcm.length === 0) {
            return { ...EMPTY_RESULT, inSpeech: this.started, speechMs: this.activeSpeechMs, silenceMs: this.silenceRunMs }
        }

        let speechStarted = false
        let utteranceEnded = false
        let ignoredShortSpeech = false
        let data = this.pending.length > 0 ? Buffer.concat([this.pending, pcm]) : pcm

        while (data.length >= LOCAL_VAD_FRAME_BYTES) {
            const chunk = data.subarray(0, LOCAL_VAD_FRAME_BYTES)
            data = data.subarray(LOCAL_VAD_FRAME_BYTES)
            const rms = rmsNormalized(chunk)
            this.lastRms = rms
            const voiced = rms >= this.config.rmsThreshold

            if (!this.started) {
                if (voiced) {
                    this.speechRunMs += LOCAL_VAD_FRAME_MS
                    if (this.speechRunMs >= this.config.startSpeechMs) {
                        this.started = true
                        speechStarted = true
                        this.activeSpeechMs = this.speechRunMs
                        this.silenceRunMs = 0
                    }
                } else {
                    this.speechRunMs = 0
                }
                continue
            }

            if (voiced) {
                this.activeSpeechMs += LOCAL_VAD_FRAME_MS
                this.silenceRunMs = 0
            } else {
                this.silenceRunMs += LOCAL_VAD_FRAME_MS
                if (this.silenceRunMs >= this.config.endSilenceMs) {
                    if (this.activeSpeechMs >= this.config.minSpeechMs) {
                        utteranceEnded = true
                    } else {
                        ignoredShortSpeech = true
                    }
                    break
                }
            }
        }

        this.pending = Buffer.from(data)
        const result = {
            speechStarted,
            inSpeech: this.started,
            utteranceEnded,
            ignoredShortSpeech,
            speechMs: this.activeSpeechMs,
            silenceMs: this.silenceRunMs,
            rms: this.lastRms,
        }

        if (utteranceEnded || ignoredShortSpeech) {
            this.reset()
        }

        return result
    }
}
