import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import http from 'node:http'
import childProcess from 'node:child_process'

// Requiring the diagnostic exposes pure/helpers only, never runs its CLI main.
const { normalizeText, similarityPercent, readWavMetadata, requestTranscription } = require('../scripts/benchmark_asr.cjs') as {
    normalizeText: (text: string) => string
    similarityPercent: (text: string) => number
    readWavMetadata: (wav: Buffer) => { wavBytes: number, audioSeconds: number }
    requestTranscription: (wav: Buffer, signal: AbortSignal) => Promise<string>
}
const FIXTURE = '今日は良い天気ですね。明日は公園で散歩をします。'
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_WAV_BYTES = 8 * 1024 * 1024
const originalHttpRequest = http.request
const originalSpawn = childProcess.spawn
const originalSetTimeout = globalThis.setTimeout

function wavFixture(dataBytes = 44100): Buffer {
    const wav = Buffer.alloc(44 + dataBytes)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(22050, 24)
    wav.writeUInt32LE(44100, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(dataBytes, 40)
    return wav
}

class MockRequest extends EventEmitter {
    body?: Buffer
    destroys = 0
    end(body: Buffer): void { this.body = body }
    destroy(): void { this.destroys++ }
}
class MockResponse extends EventEmitter {
    destroys = 0
    constructor(public statusCode = 200, public headers: Record<string, string> = {}) { super() }
    destroy(): void { this.destroys++ }
}

function isolatedHttp(t: TestContext) {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // Fail immediately if a future helper change tries to synthesize native audio.
    t.mock.method(childProcess, 'spawn', () => assert.fail('native execution is forbidden in ASR tests'))
    const request = new MockRequest()
    const controller = new AbortController()
    let callback: ((response: MockResponse) => void) | undefined
    let calls = 0
    let capturedUrl: unknown
    let capturedOptions: http.RequestOptions | undefined
    t.mock.method(http, 'request', (url: unknown, options: http.RequestOptions, onResponse: (response: MockResponse) => void) => {
        calls++
        capturedUrl = url
        capturedOptions = options
        callback = onResponse
        return request
    })
    return {
        request, controller,
        start: () => requestTranscription(wavFixture(4), controller.signal),
        respond: (response = new MockResponse()) => {
            assert.ok(callback)
            callback(response)
            return response
        },
        captured: () => ({ calls, url: capturedUrl, options: capturedOptions }),
        assertClean: (response?: MockResponse) => {
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
            const requestDestroys = request.destroys
            const responseDestroys = response?.destroys
            t.mock.timers.tick(60_000)
            assert.equal(request.destroys, requestDestroys, 'settled deadline cannot destroy a request again')
            assert.equal(response?.destroys, responseDestroys)
        },
    }
}

async function rejectsCode(promise: Promise<string>, code: string): Promise<void> {
    await assert.rejects(promise, (error: Error & { diagnosticCode?: string }) => {
        assert.equal(error.diagnosticCode, code)
        assert.equal(error.message, code, 'error payloads must not escape as diagnostic text')
        return true
    })
}

function sendJson(response: MockResponse, value: unknown): void {
    response.emit('data', Buffer.from(JSON.stringify(value)))
    response.emit('end')
}

test('ASR normalization handles NFKC, Japanese punctuation, case and whitespace', () => {
    assert.equal(normalizeText(' Ａ、B。\n\t'), 'ab')
    assert.equal(normalizeText('ｶﾞ。 ガ　！'), 'ガガ')
    assert.equal(normalizeText(''), '')
})

test('ASR similarity scores the fixed fixture with Unicode code points, not UTF-16 units', () => {
    const length = Array.from(normalizeText(FIXTURE)).length
    assert.equal(similarityPercent(FIXTURE), 100)
    assert.equal(similarityPercent(FIXTURE.replaceAll('。', '、\n')), 100)
    assert.equal(similarityPercent(''), 0)
    assert.equal(similarityPercent(`${FIXTURE}🙂`), 100 * (1 - 1 / (length + 1)))
    assert.equal(similarityPercent(FIXTURE.replace('今', '昨')), 100 * (1 - 1 / length))
    assert.ok(similarityPercent('違う文章') < 75)
})

test('ASR WAV metadata accepts canonical PCM16 mono audio and the exact byte bound', () => {
    assert.deepEqual(readWavMetadata(wavFixture()), { wavBytes: 44144, audioSeconds: 1 })
    assert.equal(readWavMetadata(wavFixture(MAX_WAV_BYTES - 44)).wavBytes, MAX_WAV_BYTES)
})

test('ASR WAV metadata rejects truncated, empty, oversized or inconsistent PCM headers', () => {
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(43), wavFixture(0), wavFixture(MAX_WAV_BYTES - 44 + 2)]) {
        assert.throws(() => readWavMetadata(invalid), { diagnosticCode: 'invalid_wav', message: 'invalid_wav' })
    }
    const mutations: Array<(wav: Buffer) => void> = [
        (wav) => wav.write('FAIL', 0),
        (wav) => wav.writeUInt32LE(1, 4),
        (wav) => wav.write('FAIL', 8),
        (wav) => wav.write('FAIL', 12),
        (wav) => wav.writeUInt32LE(18, 16),
        (wav) => wav.writeUInt16LE(3, 20),
        (wav) => wav.writeUInt16LE(2, 22),
        (wav) => wav.writeUInt32LE(0, 24),
        (wav) => wav.writeUInt32LE(1, 28),
        (wav) => wav.writeUInt16LE(4, 32),
        (wav) => wav.writeUInt16LE(8, 34),
        (wav) => wav.write('FAIL', 36),
        (wav) => wav.writeUInt32LE(2, 40),
    ]
    for (const mutate of mutations) {
        const wav = wavFixture(4)
        mutate(wav)
        assert.throws(() => readWavMetadata(wav), { diagnosticCode: 'invalid_wav' })
    }
    assert.throws(() => readWavMetadata(wavFixture(3)), { diagnosticCode: 'invalid_wav' })
})

test('ASR POST uses only the fixed loopback URL, model and multipart WAV, with no auth or proxy agent', async (t) => {
    const mock = isolatedHttp(t)
    const result = mock.start()
    const { calls, url, options } = mock.captured()
    assert.equal(calls, 1)
    assert.equal(url, 'http://127.0.0.1:8792/v1/audio/transcriptions')
    assert.equal(options?.method, 'POST')
    assert.equal(options?.agent, false)
    const headers = options?.headers as Record<string, string | number>
    assert.deepEqual(Object.keys(headers).sort(), ['content-length', 'content-type'])
    const contentType = String(headers['content-type'])
    assert.match(contentType, /^multipart\/form-data; boundary=asr-benchmark-[a-f0-9]{24}$/)
    const boundary = contentType.split('boundary=')[1]
    const wav = wavFixture(4)
    const expected = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-v3:turbo\r\n`
            + `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`
            + `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
            + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wav, Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    assert.deepEqual(mock.request.body, expected)
    assert.equal(headers['content-length'], expected.length)
    const response = mock.respond()
    sendJson(response, { text: FIXTURE })
    assert.equal(await result, FIXTURE)
    assert.equal(mock.request.destroys, 0)
    mock.assertClean(response)
})

test('ASR parses bytewise Japanese UTF-8 only after the complete JSON response', async (t) => {
    const mock = isolatedHttp(t)
    const result = mock.start()
    const response = mock.respond()
    for (const byte of Buffer.from(JSON.stringify({ text: FIXTURE }))) response.emit('data', Buffer.from([byte]))
    response.emit('end')
    assert.equal(await result, FIXTURE)
    mock.assertClean(response)
})

for (const status of [301, 302, 307, 308, 401, 500]) {
    test(`ASR rejects HTTP ${status} without redirects, retry or response disclosure`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_http_error')
        const response = mock.respond(new MockResponse(status, { location: 'http://invalid.example/private' }))
        sendJson(response, { error: 'PRIVATE_ERROR_SENTINEL' })
        await rejection
        assert.equal(mock.captured().calls, 1)
        assert.equal(mock.request.destroys, 1)
        assert.equal(response.destroys, 1)
        mock.assertClean(response)
    })
}

for (const [index, text] of ['PRIVATE_RESPONSE_SENTINEL', '{"text":', '{}', 'null', '[]', '{"text":7}', '{"text":null}'].entries()) {
    test(`ASR rejects malformed or non-text JSON schema case ${index + 1}`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_invalid_response')
        const response = mock.respond()
        response.emit('data', Buffer.from(text))
        response.emit('end')
        await rejection
        assert.equal(response.destroys, 1)
        assert.equal(mock.request.destroys, 1)
        mock.assertClean(response)
    })
}

test('ASR accepts exactly 64 KiB including trailing JSON whitespace', async (t) => {
    const mock = isolatedHttp(t)
    const result = mock.start()
    const response = mock.respond(new MockResponse(200, { 'content-length': String(MAX_RESPONSE_BYTES) }))
    const json = Buffer.from(JSON.stringify({ text: FIXTURE }))
    response.emit('data', Buffer.concat([json, Buffer.alloc(MAX_RESPONSE_BYTES - json.length, ' ')]))
    response.emit('end')
    assert.equal(await result, FIXTURE)
    mock.assertClean(response)
})

for (const [index, length] of ['65537', '9999999999999999999999999', '-1', 'garbage'].entries()) {
    test(`ASR rejects invalid or oversized declared content-length case ${index + 1}`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_response_too_large')
        const response = mock.respond(new MockResponse(200, { 'content-length': length }))
        await rejection
        assert.equal(response.destroys, 1)
        assert.equal(mock.request.destroys, 1)
        mock.assertClean(response)
    })
}

for (const chunked of [false, true]) {
    test(`ASR bounds ${chunked ? 'accumulated chunks' : 'a single chunk'} even without content-length`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_response_too_large')
        const response = mock.respond()
        if (chunked) {
            response.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES))
            assert.equal(response.destroys, 0, 'exact bound is not yet exceeded')
            response.emit('data', Buffer.alloc(1))
        } else response.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1))
        response.emit('data', Buffer.from('PRIVATE_LATE_PAYLOAD'))
        response.emit('end')
        await rejection
        assert.equal(mock.request.destroys, 1)
        assert.equal(response.destroys, 1)
        mock.assertClean(response)
    })
}

for (const failure of ['request error', 'response error', 'truncated response'] as const) {
    test(`ASR sanitizes ${failure} and cancels pending work exactly once`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_transport_error')
        let response: MockResponse | undefined
        if (failure === 'request error') mock.request.emit('error', new Error('PRIVATE_TRANSPORT_SENTINEL'))
        else {
            response = mock.respond()
            response.emit('data', Buffer.from('{"text":"partial'))
            response.emit(failure === 'response error' ? 'error' : 'aborted', new Error('PRIVATE_TRANSPORT_SENTINEL'))
            response.emit('end')
        }
        await rejection
        mock.request.emit('error', new Error('PRIVATE_LATE_ERROR'))
        response?.emit('error', new Error('PRIVATE_LATE_ERROR'))
        assert.equal(mock.request.destroys, 1)
        if (response) assert.equal(response.destroys, 1)
        mock.assertClean(response)
    })
}

for (const stage of ['before send', 'before headers', 'during response'] as const) {
    test(`ASR abort ${stage} removes its listener and destroys only pending resources`, async (t) => {
        const mock = isolatedHttp(t)
        if (stage === 'before send') mock.controller.abort()
        const rejection = rejectsCode(mock.start(), 'interrupted')
        const response = stage === 'during response' ? mock.respond() : undefined
        if (response) response.emit('data', Buffer.from('{"text":'))
        mock.controller.abort()
        await rejection
        if (stage === 'before send') assert.equal(mock.request.body, undefined)
        else assert.ok(mock.request.body)
        assert.equal(mock.request.destroys, 1)
        if (response) assert.equal(response.destroys, 1)
        mock.assertClean(response)
    })
}

for (const partialResponse of [false, true]) {
    test(`ASR 15s whole-request deadline bounds ${partialResponse ? 'trickling response data' : 'missing headers'}`, async (t) => {
        const mock = isolatedHttp(t)
        const rejection = rejectsCode(mock.start(), 'asr_timeout')
        const response = partialResponse ? mock.respond() : undefined
        if (response) response.emit('data', Buffer.from('{"text":"'))
        t.mock.timers.tick(14_999)
        if (response) response.emit('data', Buffer.from('still incomplete'))
        assert.equal(mock.request.destroys, 0)
        t.mock.timers.tick(1)
        await rejection
        assert.equal(mock.request.destroys, 1)
        if (response) {
            assert.equal(response.destroys, 1)
            sendJson(response, { text: FIXTURE })
        }
        mock.controller.abort()
        mock.assertClean(response)
    })
}

test('ASR success clears abort/deadline resources and ignores late errors without changing its result', async (t) => {
    const mock = isolatedHttp(t)
    const result = mock.start()
    const response = mock.respond()
    sendJson(response, { text: FIXTURE })
    assert.equal(await result, FIXTURE)
    mock.controller.abort()
    mock.request.emit('error', new Error('PRIVATE_LATE_ERROR'))
    response.emit('error', new Error('PRIVATE_LATE_ERROR'))
    assert.equal(mock.request.destroys, 0)
    assert.equal(response.destroys, 0)
    mock.assertClean(response)
})

test('ASR test contexts restore HTTP, native-spawn and timer mocks', () => {
    assert.equal(http.request, originalHttpRequest)
    assert.equal(childProcess.spawn, originalSpawn)
    assert.equal(globalThis.setTimeout, originalSetTimeout)
})
