import assert from 'node:assert/strict'
import test from 'node:test'
import { findPipeWireSinkId, readLocalTtsOutputConfig } from '../src/local_audio_output.js'

test('findPipeWireSinkId resolves only an audio sink', () => {
    const status = `PipeWire

Audio
 ├─ Devices:
 │      48. Built-in Audio [alsa]
 ├─ Sinks:
 │      53. Built-in Audio Analog Stereo [vol: 0.50]
 │  *   72. JBL Flip 3 [vol: 0.35]
 ├─ Sources:
 │      51. C505 HD Webcam Mono [vol: 1.00]

Video
 ├─ Sinks:
 │      99. JBL Flip 3 Camera
`
    assert.equal(findPipeWireSinkId(status, 'JBL Flip 3'), '72')
    assert.equal(findPipeWireSinkId(status, '53'), '53')
    assert.equal(findPipeWireSinkId(status, 'missing'), null)
})

test('readLocalTtsOutputConfig clamps local and fallback volumes', () => {
    assert.deepEqual(readLocalTtsOutputConfig({
        STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED: 'true',
        STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME: ' Red speaker ',
        STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME: '3',
        STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME: '120',
    }), {
        enabled: true,
        targetName: 'Red speaker',
        volume: 1.2,
        fallbackM5Volume: 100,
    })
})
