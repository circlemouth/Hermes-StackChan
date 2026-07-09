// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpusScript = require('opusscript') as typeof import('opusscript')

export const INPUT_SAMPLE_RATE = 16000
export const INPUT_FRAME_DURATION_MS = 60
export const INPUT_FRAME_SAMPLES = (INPUT_SAMPLE_RATE * INPUT_FRAME_DURATION_MS) / 1000  // 960

export const OUTPUT_SAMPLE_RATE = 24000
export const OUTPUT_FRAME_DURATION_MS = 60
const OUTPUT_FRAME_SAMPLES = (OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_DURATION_MS) / 1000  // 1440
const OUTPUT_GAIN = readOutputGain()
const OUTPUT_PCM_INPUT_MODE = readOpusPcmInputMode()

const inputDecoder = new OpusScript(INPUT_SAMPLE_RATE, 1)

export type InputOpusDecoder = {
    decodeFrame(opus: Buffer): Buffer
    dispose(): void
}

export function createInputOpusDecoder(): InputOpusDecoder {
    const decoder = new OpusScript(INPUT_SAMPLE_RATE, 1) as OpusDecoderInternals
    return {
        decodeFrame(opus: Buffer): Buffer {
            const pcm = decoder.decode(opus)
            return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        },
        dispose(): void {
            decoder.delete?.()
        },
    }
}

// BinaryProtocol3: [type:1][reserved:1][payload_size:2 BE][payload...]
// Xiaozhi v3 uses type 0 for Opus. Type 1 is accepted for compatibility with older local builds.
// BinaryProtocol2: [version:2][type:2][reserved:4][timestamp:4][payload_size:4 BE][payload...]
// version 1 (or other): raw Opus bytes

export function extractOpusPayload(data: Buffer, version: number): Buffer | null {
    if (version === 3) {
        if (data.length < 4) return null
        if (data[0] !== 0x00 && data[0] !== 0x01) return null  // type != Opus
        const size = data.readUInt16BE(2)
        if (size <= 0 || 4 + size > data.length) return null
        return Buffer.from(data.subarray(4, 4 + size))
    }
    if (version === 2) {
        if (data.length < 16) return null
        // type field (offset 2, uint16): 0 = OPUS
        const type = data.readUInt16BE(2)
        if (type !== 0) return null
        const size = data.readUInt32BE(12)
        if (size <= 0 || 16 + size > data.length) return null
        return Buffer.from(data.subarray(16, 16 + size))
    }
    if (data.length === 0) return null
    return data  // raw
}

export function wrapOpusPayload(opus: Buffer, version: number): Buffer {
    if (version === 3) {
        const header = Buffer.alloc(4)
        header[0] = 0x00
        header[1] = 0x00
        header.writeUInt16BE(opus.length, 2)
        return Buffer.concat([header, opus])
    }
    if (version === 2) {
        const header = Buffer.alloc(16)
        header.writeUInt16BE(2, 0)      // version
        header.writeUInt16BE(0, 2)      // type = OPUS
        header.writeUInt32BE(0, 4)      // reserved
        header.writeUInt32BE(0, 8)      // timestamp
        header.writeUInt32BE(opus.length, 12)
        return Buffer.concat([header, opus])
    }
    return opus
}

export function decodeOpusFrames(frames: Buffer[]): Buffer {
    const chunks: Buffer[] = []
    for (const frame of frames) {
        try {
            const pcm = inputDecoder.decode(frame)
            chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        } catch {
            // 壊れたフレームはスキップ
        }
    }
    return Buffer.concat(chunks)
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)   // mono
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
}

export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
    const sampleRate = wav.readUInt32LE(24)
    const dataIdx = wav.indexOf(Buffer.from('data'))
    if (dataIdx === -1) throw new Error('WAV data chunk not found')
    return { pcm: wav.subarray(dataIdx + 8), sampleRate }
}

function resamplePcm(pcm: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return pcm
    const inputSamples = pcm.length / 2
    const outputSamples = Math.ceil(inputSamples * toRate / fromRate)
    const out = Buffer.alloc(outputSamples * 2)
    for (let i = 0; i < outputSamples; i++) {
        const src = i * fromRate / toRate
        const idx = Math.floor(src)
        const frac = src - idx
        const s0 = idx < inputSamples ? pcm.readInt16LE(idx * 2) : 0
        const s1 = idx + 1 < inputSamples ? pcm.readInt16LE((idx + 1) * 2) : s0
        const v = Math.round(s0 + frac * (s1 - s0))
        out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2)
    }
    return out
}

function readOutputGain(): number {
    const gain = Number(process.env.STACKCHAN_TTS_OUTPUT_GAIN ?? 0.65)
    if (!Number.isFinite(gain)) return 0.65
    return Math.max(0.1, Math.min(1.0, gain))
}

type OpusPcmInputMode = 'direct' | 'buffer' | 'int16'

function readOpusPcmInputMode(): OpusPcmInputMode {
    const mode = process.env.STACKCHAN_OPUS_PCM_INPUT?.trim().toLowerCase()
    if (mode === 'int16') return mode
    return 'buffer'
}

type OpusEncoderInternals = {
    encode(buffer: Buffer, frameSize: number): Buffer
    handler?: {
        _encode(inputPointer: number, inputLength: number, outputPointer: number, frameSize: number): number
    }
    inPCM?: Uint16Array
    inPCMPointer?: number
    outOpusPointer?: number
    delete?: () => void
}

type OpusDecoderInternals = {
    decode(buffer: Buffer): Buffer
    delete?: () => void
}

function encodePcmFrame(outputEncoder: OpusEncoderInternals, chunk: Buffer): Buffer {
    if (OUTPUT_PCM_INPUT_MODE === 'int16') {
        return outputEncoder.encode(pcmChunkToInt16Array(chunk), OUTPUT_FRAME_SAMPLES)
    }

    // OpusScript's public encode() builds HEAPU16.subarray() with a byte pointer
    // as the element index. Once the shared WASM heap grows, that view can become
    // length 0 and TTS frames fail with "offset is out of bounds". Keep the same
    // PCM representation the wrapper expects, but create the view from a byte
    // offset so output TTS stays stable after long input-decoder activity.
    const heapBuffer = outputEncoder.inPCM?.buffer
    const inputPointer = outputEncoder.inPCMPointer
    const outputPointer = outputEncoder.outOpusPointer
    const handler = outputEncoder.handler
    if (
        heapBuffer
        && typeof inputPointer === 'number'
        && typeof outputPointer === 'number'
        && Number.isInteger(inputPointer)
        && Number.isInteger(outputPointer)
        && handler
    ) {
        const pcmWords = new Uint16Array(heapBuffer, inputPointer, chunk.length)
        pcmWords.set(chunk)
        const encodedLength = handler._encode(inputPointer, chunk.length, outputPointer, OUTPUT_FRAME_SAMPLES)
        if (encodedLength < 0) throw new Error(`Encode error: ${encodedLength}`)
        return Buffer.from(new Uint8Array(heapBuffer, outputPointer, encodedLength))
    }

    return outputEncoder.encode(chunk, OUTPUT_FRAME_SAMPLES)
}

function applyPcmGain(pcm: Buffer, gain: number): Buffer {
    if (gain >= 0.999) return pcm
    const out = Buffer.alloc(pcm.length)
    for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i)
        const scaled = Math.round(sample * gain)
        out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i)
    }
    return out
}

export function encodeWavToOpusFrames(wav: Buffer, leadSilenceMs = 0): Buffer[] {
    const { pcm, sampleRate } = wavToPcm(wav)
    const frameBytes = OUTPUT_FRAME_SAMPLES * 2
    let resampled = applyPcmGain(resamplePcm(pcm, sampleRate, OUTPUT_SAMPLE_RATE), OUTPUT_GAIN)
    if (leadSilenceMs > 0) {
        const leadFrames = Math.ceil(leadSilenceMs / OUTPUT_FRAME_DURATION_MS)
        resampled = Buffer.concat([Buffer.alloc(leadFrames * frameBytes, 0), resampled])
    }

    const frames: Buffer[] = []
    const outputEncoder = new OpusScript(OUTPUT_SAMPLE_RATE, 1, OpusScript.Application.AUDIO)

    try {
        for (let i = 0; i < resampled.length; i += frameBytes) {
            let chunk = resampled.subarray(i, i + frameBytes)
            if (chunk.length < frameBytes) {
                const padded = Buffer.alloc(frameBytes, 0)
                chunk.copy(padded)
                chunk = padded
            }
            const encoded = encodePcmFrame(outputEncoder, chunk)
            frames.push(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength))
        }
    } finally {
        outputEncoder.delete?.()
    }

    return frames
}

function pcmChunkToInt16Array(chunk: Buffer): Buffer {
    const samples = new Int16Array(OUTPUT_FRAME_SAMPLES)
    for (let sample = 0; sample < OUTPUT_FRAME_SAMPLES; sample++) {
        samples[sample] = chunk.readInt16LE(sample * 2)
    }
    return samples as unknown as Buffer
}
