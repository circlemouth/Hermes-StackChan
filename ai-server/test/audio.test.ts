import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { encodeWavToOpusFrames, extractOpusPayload, pcmToWav, wrapOpusPayload } from '../src/audio.ts'

const require = createRequire(import.meta.url)
const OpusScript = require('opusscript')

function analyzeDecodedTone(frame: Buffer, sampleRate: number): { peak: number; zeroCrossings: number } {
    const decoder = new OpusScript(sampleRate, 1)
    try {
        const decoded: Buffer = decoder.decode(frame)
        let peak = 0
        let zeroCrossings = 0
        let lastSign = 0

        for (let i = 0; i + 1 < decoded.length; i += 2) {
            const sample = decoded.readInt16LE(i)
            peak = Math.max(peak, Math.abs(sample))
            const sign = Math.sign(sample)
            if (sign !== 0 && lastSign !== 0 && sign !== lastSign) zeroCrossings++
            if (sign !== 0) lastSign = sign
        }
        return { peak, zeroCrossings }
    } finally {
        decoder.delete?.()
    }
}

function analyzeDecodedToneInFreshProcess(frame: Buffer, sampleRate: number): { peak: number; zeroCrossings: number } {
    const script = `
const OpusScript = require(${JSON.stringify(require.resolve('opusscript'))});
const frame = Buffer.from(process.argv[1], 'base64');
const sampleRate = Number(process.argv[2]);
const decoder = new OpusScript(sampleRate, 1);
try {
  const decoded = decoder.decode(frame);
  let peak = 0;
  let zeroCrossings = 0;
  let lastSign = 0;
  for (let i = 0; i + 1 < decoded.length; i += 2) {
    const sample = decoded.readInt16LE(i);
    peak = Math.max(peak, Math.abs(sample));
    const sign = Math.sign(sample);
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) zeroCrossings++;
    if (sign !== 0) lastSign = sign;
  }
  console.log(JSON.stringify({ peak, zeroCrossings }));
} finally {
  decoder.delete?.();
}
`
    const result = spawnSync(process.execPath, ['-e', script, frame.toString('base64'), String(sampleRate)], {
        encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return JSON.parse(result.stdout) as { peak: number; zeroCrossings: number }
}

test('encodeWavToOpusFrames encodes padded speech with lead silence', () => {
    const pcmBytes = 39042
    const pcm = Buffer.alloc(pcmBytes, 0)
    for (let i = 0; i < pcm.length / 2; i++) {
        const sample = Math.round(Math.sin(i / 6) * 6000)
        pcm.writeInt16LE(sample, i * 2)
    }

    const wav = pcmToWav(pcm, 24000)
    const frames = encodeWavToOpusFrames(wav, 600)

    assert.ok(frames.length > 10)
    assert.ok(frames.every(frame => frame.length > 0))
})

test('encodeWavToOpusFrames preserves a simple tone without harsh clipping', () => {
    const sampleRate = 24000
    const samples = 1440
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 8000)
        pcm.writeInt16LE(sample, i * 2)
    }

    const frames = encodeWavToOpusFrames(pcmToWav(pcm, sampleRate), 0)
    assert.equal(frames.length, 1)

    const { peak, zeroCrossings } = analyzeDecodedTone(frames[0], sampleRate)
    assert.ok(peak < 20000, `decoded tone clipped too hard: peak=${peak}`)
    assert.ok(zeroCrossings < 120, `decoded tone is too noisy: zeroCrossings=${zeroCrossings}`)
})

test('encodeWavToOpusFrames survives repeated encoder allocation', () => {
    const sampleRate = 24000
    const samples = 1440
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 4000)
        pcm.writeInt16LE(sample, i * 2)
    }
    const wav = pcmToWav(pcm, sampleRate)

    for (let i = 0; i < 200; i++) {
        const frames = encodeWavToOpusFrames(wav, 600)
        assert.ok(frames.length > 1)
        assert.ok(frames.every(frame => frame.length > 0))
    }
})

test('encodeWavToOpusFrames survives high OpusScript heap pointers', () => {
    const heldEncoders: Array<{ delete?: () => void }> = []
    try {
        for (let i = 0; i < 700; i++) {
            heldEncoders.push(new OpusScript(24000, 1, OpusScript.Application.AUDIO))
        }

        const sampleRate = 24000
        const samples = 1440
        const pcm = Buffer.alloc(samples * 2)
        for (let i = 0; i < samples; i++) {
            const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 4000)
            pcm.writeInt16LE(sample, i * 2)
        }

        const frames = encodeWavToOpusFrames(pcmToWav(pcm, sampleRate), 600)
        assert.ok(frames.length > 1)
        assert.ok(frames.every(frame => frame.length > 0))

        const audibleFrame = frames[frames.length - 1]
        const { peak, zeroCrossings } = analyzeDecodedToneInFreshProcess(audibleFrame, sampleRate)
        assert.ok(peak < 20000, `high-pointer decoded tone clipped too hard: peak=${peak}`)
        assert.ok(zeroCrossings < 120, `high-pointer decoded tone is too noisy: zeroCrossings=${zeroCrossings}`)
    } finally {
        for (const encoder of heldEncoders) encoder.delete?.()
    }
})

test('encodeWavToOpusFrames survives failed input decoder activity', () => {
    const sampleRate = 24000
    const samples = 1440
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 4000)
        pcm.writeInt16LE(sample, i * 2)
    }
    const wav = pcmToWav(pcm, sampleRate)
    const badDecoder = new OpusScript(16000, 1)

    for (let i = 0; i < 20; i++) {
        try {
            badDecoder.decode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
        } catch {
            // Invalid input frames are expected here; output TTS encode must stay healthy.
        }
        const frames = encodeWavToOpusFrames(wav, 600)
        assert.ok(frames.length > 1)
        assert.ok(frames.every(frame => frame.length > 0))
    }
    badDecoder.delete?.()
})

test('extractOpusPayload rejects empty and truncated framed payloads', () => {
    const payload = Buffer.from([1, 2, 3, 4])

    assert.deepEqual(extractOpusPayload(wrapOpusPayload(payload, 3), 3), payload)
    const truncatedV3 = Buffer.from([0x00, 0x00, 0x00, 0x08, 1, 2])
    assert.equal(extractOpusPayload(truncatedV3, 3), null)
    const emptyV3 = Buffer.from([0x00, 0x00, 0x00, 0x00])
    assert.equal(extractOpusPayload(emptyV3, 3), null)

    assert.deepEqual(extractOpusPayload(wrapOpusPayload(payload, 2), 2), payload)
    const truncatedV2 = Buffer.alloc(18)
    truncatedV2.writeUInt16BE(2, 0)
    truncatedV2.writeUInt16BE(0, 2)
    truncatedV2.writeUInt32BE(8, 12)
    assert.equal(extractOpusPayload(truncatedV2, 2), null)

    assert.equal(extractOpusPayload(Buffer.alloc(0), 1), null)
})
