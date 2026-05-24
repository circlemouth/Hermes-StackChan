import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalRmsVad, LOCAL_VAD_FRAME_BYTES, readEnvFloat, readEnvInt, rmsNormalized, type LocalRmsVadConfig } from '../src/local_vad.ts'

const config: LocalRmsVadConfig = {
    enabled: true,
    rmsThreshold: 0.012,
    startSpeechMs: 120,
    endSilenceMs: 900,
    minSpeechMs: 240,
    preRollMs: 300,
}

function pcmFrame(amplitude: number): Buffer {
    const frame = Buffer.alloc(LOCAL_VAD_FRAME_BYTES)
    for (let i = 0; i < frame.length / 2; i++) {
        frame.writeInt16LE(amplitude, i * 2)
    }
    return frame
}

function feed(vad: LocalRmsVad, frames: Buffer[]) {
    let result = vad.processPcm(Buffer.alloc(0))
    for (const frame of frames) result = vad.processPcm(frame)
    return result
}

test('LocalRmsVad does not start speech for silence', () => {
    const vad = new LocalRmsVad(config)
    const result = feed(vad, Array.from({ length: 40 }, () => pcmFrame(0)))
    assert.equal(result.speechStarted, false)
    assert.equal(result.inSpeech, false)
    assert.equal(result.utteranceEnded, false)
})

test('LocalRmsVad starts speech after threshold audio is sustained', () => {
    const vad = new LocalRmsVad(config)
    const result = feed(vad, Array.from({ length: 4 }, () => pcmFrame(1600)))
    assert.equal(result.speechStarted, true)
    assert.equal(result.inSpeech, true)
    assert.equal(result.speechMs, 120)
    assert.ok(result.rms >= config.rmsThreshold)
})

test('LocalRmsVad ends utterance after speech followed by configured silence', () => {
    const vad = new LocalRmsVad(config)
    feed(vad, Array.from({ length: 10 }, () => pcmFrame(1600)))
    const result = feed(vad, Array.from({ length: 30 }, () => pcmFrame(0)))
    assert.equal(result.utteranceEnded, true)
    assert.equal(result.speechMs, 300)
    assert.equal(result.silenceMs, 900)
})

test('LocalRmsVad rejects speech shorter than minimum duration', () => {
    const vad = new LocalRmsVad({ ...config, startSpeechMs: 60, minSpeechMs: 240 })
    feed(vad, Array.from({ length: 2 }, () => pcmFrame(1600)))
    const result = feed(vad, Array.from({ length: 30 }, () => pcmFrame(0)))
    assert.equal(result.utteranceEnded, false)
    assert.equal(result.ignoredShortSpeech, true)
})

test('LocalRmsVad reset clears accumulated speech state', () => {
    const vad = new LocalRmsVad(config)
    assert.equal(feed(vad, Array.from({ length: 4 }, () => pcmFrame(1600))).inSpeech, true)
    vad.reset()
    assert.equal(feed(vad, [pcmFrame(0)]).inSpeech, false)
})

test('local VAD helpers read RMS and env values predictably', () => {
    assert.ok(rmsNormalized(pcmFrame(3276)) > 0.09)
    assert.equal(readEnvInt('A', 10, 1, 20, { A: '12.4' }), 12)
    assert.equal(readEnvFloat('A', 0.5, 0.1, 1, { A: '0.75' }), 0.75)
    assert.equal(readEnvFloat('A', 0.5, 0.1, 1, { A: 'bad' }), 0.5)
})
