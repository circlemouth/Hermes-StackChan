// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpusScript = require('opusscript') as typeof import('opusscript')

const INPUT_SAMPLE_RATE = 16000
const INPUT_FRAME_SAMPLES = (INPUT_SAMPLE_RATE * 60) / 1000  // 960

export const OUTPUT_SAMPLE_RATE = 24000
export const OUTPUT_FRAME_DURATION_MS = 60
const OUTPUT_FRAME_SAMPLES = (OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_DURATION_MS) / 1000  // 1440

const inputDecoder = new OpusScript(INPUT_SAMPLE_RATE, 1)
const outputEncoder = new OpusScript(OUTPUT_SAMPLE_RATE, 1, OpusScript.Application.AUDIO)

// BinaryProtocol3: [type:1][reserved:1][payload_size:2 BE][payload...]
// Xiaozhi v3 uses type 0 for Opus. Type 1 is accepted for compatibility with older local builds.
// BinaryProtocol2: [version:2][type:2][reserved:4][timestamp:4][payload_size:4 BE][payload...]
// version 1 (or other): raw Opus bytes

export function extractOpusPayload(data: Buffer, version: number): Buffer | null {
    if (version === 3) {
        if (data.length < 4) return null
        if (data[0] !== 0x00 && data[0] !== 0x01) return null  // type != Opus
        const size = data.readUInt16BE(2)
        return data.subarray(4, 4 + size)
    }
    if (version === 2) {
        if (data.length < 16) return null
        // type field (offset 2, uint16): 0 = OPUS
        const type = data.readUInt16BE(2)
        if (type !== 0) return null
        const size = data.readUInt32BE(12)
        return data.subarray(16, 16 + size)
    }
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

export function encodeWavToOpusFrames(wav: Buffer): Buffer[] {
    const { pcm, sampleRate } = wavToPcm(wav)
    const resampled = resamplePcm(pcm, sampleRate, OUTPUT_SAMPLE_RATE)

    const frameBytes = OUTPUT_FRAME_SAMPLES * 2
    const frames: Buffer[] = []

    for (let i = 0; i < resampled.length; i += frameBytes) {
        let chunk = resampled.subarray(i, i + frameBytes)
        if (chunk.length < frameBytes) {
            const padded = Buffer.alloc(frameBytes, 0)
            chunk.copy(padded)
            chunk = padded
        }
        const encoded = outputEncoder.encode(chunk, OUTPUT_FRAME_SAMPLES)
        frames.push(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength))
    }

    return frames
}
