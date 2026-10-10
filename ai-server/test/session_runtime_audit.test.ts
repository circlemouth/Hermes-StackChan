import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Session, isIgnorableShortTranscript, isIgnorableTimeoutTranscript, type SessionDeps } from '../src/session.ts'
import { getDeviceBridgeStatus } from '../src/device_control.ts'

async function flush() { for (let i = 0; i < 150; i++) await Promise.resolve() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function fixture(t: TestContext, deps: SessionDeps = {}, realRegistration = false, skipHello = false) {
    t.mock.method(console, 'log', () => undefined)
    t.mock.method(console, 'error', () => undefined)
    const sent: Array<string | Buffer> = []
    const prompts: string[] = []
    const session = new Session({ send: (v: string | Buffer) => sent.push(v) } as never, {
        ...(realRegistration ? {} : { registerDeviceSession: () => () => undefined }),
        createInputOpusDecoder: () => ({ decodeFrame: () => Buffer.alloc(1920), dispose: () => undefined }),
        decodeOpusFrames: frames => Buffer.concat(frames.map(f => Buffer.alloc(1920, f[0]))),
        transcribeWav: async () => 'はい',
        hermes: { submitPrompt: async p => { prompts.push(p); return '返事。' }, interrupt: async () => undefined, dispose: async () => undefined },
        synthesizeText: async () => Buffer.alloc(44), encodeWavToOpusFrames: () => [], autoLedEnabled: false,
        localVadConfig: { enabled: false, rmsThreshold: 0.01, startSpeechMs: 60, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
        postTtsCooldownMs: 0, ...deps,
    })
    t.after(() => session.close())
    const control = (type: string, state?: string) => session.handleMessage(JSON.stringify({ type, state, version: 1, mode: 'auto' }))
    if (!skipHello) control('hello')
    const speak = () => { control('listen', 'start'); session.handleMessage(Buffer.from([1])); control('listen', 'stop') }
    return { session, control, speak, sent, prompts }
}

test('R02 disconnect catches asynchronous Hermes disposal failure and is idempotent', async t => {
    const warn = t.mock.method(console, 'warn', () => undefined)
    let disposed = 0
    const f = fixture(t, { hermes: { submitPrompt: async () => '', interrupt: async () => undefined, dispose: async () => { disposed++; throw new Error('private backend error') } } })
    f.session.close(); f.session.close(); await flush()
    assert.equal(disposed, 1); assert.equal(warn.mock.callCount(), 1)
    assert.equal(String(warn.mock.calls[0].arguments[0]).includes('private'), false)
})

test('R04 whole-turn deadline aborts STT and propagates absolute options', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    let signal: AbortSignal | undefined; let deadline: number | undefined
    const f = fixture(t, { turnTimeoutMs: 100, transcribeWav: async (_wav, options) => {
        signal = options?.signal; deadline = options?.deadline
        return await new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    } })
    f.speak(); await flush(); assert.equal(deadline, 1100); assert.equal(signal?.aborted, false)
    t.mock.timers.tick(100); await flush()
    assert.equal(signal?.aborted, true); assert.equal(f.prompts.length, 0)
    assert.equal(f.session.getBridgeStatus().state, 'listening')
})

test('R09 meaningful short affirmations and negations reach Hermes by default', async t => {
    for (const text of ['はい', 'うん', '了解', 'なるほど', 'わかった', 'OK', 'いいえ']) {
        assert.equal(isIgnorableShortTranscript(text), false); assert.equal(isIgnorableTimeoutTranscript(text), false)
        const f = fixture(t, { transcribeWav: async () => text }); f.speak(); await flush()
        assert.deepEqual(f.prompts, [text]); f.session.close()
    }
})

test('R10 explicit device listen during cooldown immediately accepts opening audio', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    let count = 0
    const f = fixture(t, { postTtsCooldownMs: 1500, transcribeWav: async () => `turn ${++count}` })
    f.speak(); await flush(); assert.equal(f.session.getBridgeStatus().state, 'idle')
    f.speak(); await flush(); assert.deepEqual(f.prompts, ['turn 1', 'turn 2'])
})

test('R10 cooldown input without a new listen control is retained and replayed', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    const batches: number[][] = []
    const f = fixture(t, { postTtsCooldownMs: 300, decodeOpusFrames: frames => { batches.push(frames.map(f => f[0])); return Buffer.alloc(1920) } })
    f.speak(); await flush(); f.session.handleMessage(Buffer.from([7])); f.session.handleMessage(Buffer.from([8]))
    t.mock.timers.tick(300); await flush(); f.control('listen', 'stop'); await flush()
    assert.deepEqual(batches, [[1], [7, 8]])
})

test('R10/R13 notification cannot steal an utterance already buffered during cooldown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    const batches: number[][] = []; const prompts: string[] = []; const notice = deferred<string>()
    let transcripts = 0
    const f = fixture(t, {
        postTtsCooldownMs: 300,
        decodeOpusFrames: frames => { batches.push(frames.map(frame => frame[0])); return Buffer.alloc(1920) },
        transcribeWav: async () => `human ${++transcripts}`,
        hermes: { submitPrompt: async p => { prompts.push(p); return p === 'notice' ? notice.promise : '返事。' }, interrupt: async () => undefined, dispose: async () => undefined },
    })
    f.speak(); await flush()
    f.session.handleMessage(Buffer.from([7])); await f.session.enqueueFollowup('notice')
    f.session.handleMessage(Buffer.from([8])); await flush()
    assert.equal(f.session.getBridgeStatus().state, 'idle')
    assert.deepEqual(prompts, ['human 1'])
    t.mock.timers.tick(300); await flush(); f.control('listen', 'stop'); await flush()
    assert.deepEqual(batches, [[1], [7, 8]])
    assert.deepEqual(prompts, ['human 1', 'human 2', 'notice'])
    notice.resolve('お知らせ。'); await flush()
})

test('R10/R13 rejected cooldown VAD candidate releases the queued notification after replay', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    const speech = Buffer.alloc(1920)
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i)
    const f = fixture(t, {
        postTtsCooldownMs: 300,
        createInputOpusDecoder: () => ({ decodeFrame: frame => frame[0] === 1 ? speech : Buffer.alloc(1920), dispose: () => undefined }),
        localVadConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 120, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
    })
    f.control('listen', 'start'); await f.session.enqueueFollowup('first'); await flush()
    f.session.handleMessage(Buffer.from([1])); await f.session.enqueueFollowup('notice')
    f.session.handleMessage(Buffer.from([0])); await flush()
    assert.deepEqual(f.prompts, ['first']); assert.equal(f.session.getBridgeStatus().followupQueued, 1)
    t.mock.timers.tick(300); await flush()
    assert.deepEqual(f.prompts, ['first', 'notice'])
    assert.equal(f.session.getBridgeStatus().followupQueued, 0)
})

test('R13 accepted follow-ups drain FIFO before automatic listening', async t => {
    const first = deferred<string>(); const prompts: string[] = []
    const f = fixture(t, { hermes: { submitPrompt: async p => { prompts.push(p); return prompts.length === 1 ? first.promise : '返事。' }, interrupt: async () => undefined, dispose: async () => undefined } })
    await f.session.enqueueFollowup('one'); await flush()
    await f.session.enqueueFollowup('two'); await f.session.enqueueFollowup('three')
    first.resolve('返事。'); await flush()
    assert.deepEqual(prompts, ['one', 'two', 'three']); assert.equal(f.session.getBridgeStatus().followupQueued, 0)
})

test('R13 notification does not erase an active human capture', async t => {
    const f = fixture(t)
    f.control('listen', 'start'); f.session.handleMessage(Buffer.from([1]))
    await f.session.enqueueFollowup('notice'); assert.equal(f.session.getBridgeStatus().followupQueued, 1)
    f.control('listen', 'stop'); await flush(); assert.deepEqual(f.prompts, ['はい', 'notice'])
})

test('R13 notification preserves a voiced candidate before the VAD start threshold', async t => {
    const speech = Buffer.alloc(1920)
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i)
    let captured: Buffer = Buffer.alloc(0)
    const f = fixture(t, {
        createInputOpusDecoder: () => ({ decodeFrame: () => speech, dispose: () => undefined }),
        localVadConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 120, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
        transcribeWav: async wav => { captured = wav.subarray(44); return 'はい' },
    })
    f.control('listen', 'start'); f.session.handleMessage(Buffer.from([1]))
    await f.session.enqueueFollowup('notice'); await flush()
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    assert.equal(f.session.getBridgeStatus().followupQueued, 1)
    f.session.handleMessage(Buffer.from([2])); f.control('listen', 'stop'); await flush()
    assert.deepEqual(captured, Buffer.concat([speech, speech]))
    assert.deepEqual(f.prompts, ['はい', 'notice'])
})

test('R13 a rejected voiced candidate becoming silence releases a queued notification', async t => {
    const speech = Buffer.alloc(1920)
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i)
    const f = fixture(t, {
        createInputOpusDecoder: () => ({ decodeFrame: frame => frame[0] === 1 ? speech : Buffer.alloc(1920), dispose: () => undefined }),
        localVadConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 120, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 120 },
    })
    f.control('listen', 'start'); f.session.handleMessage(Buffer.from([1]))
    await f.session.enqueueFollowup('notice')
    f.session.handleMessage(Buffer.from([0])); await flush()
    assert.deepEqual(f.prompts, ['notice'])
})

test('R04/R13 TTS timeout awaits Hermes retirement before the next queued producer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    const retirement = deferred<void>(); const hungTts = deferred<Buffer>(); const prompts: string[] = []
    let synthesisCount = 0
    const f = fixture(t, { turnTimeoutMs: 100,
        hermes: { submitPrompt: async p => { prompts.push(p); return '返事。' }, interrupt: () => retirement.promise, dispose: async () => undefined },
        synthesizeText: async () => ++synthesisCount === 1 ? hungTts.promise : Buffer.alloc(44),
    })
    await f.session.enqueueFollowup('one'); await flush()
    await f.session.enqueueFollowup('two'); t.mock.timers.tick(100); await flush()
    assert.deepEqual(prompts, ['one']); assert.equal(f.session.getBridgeStatus().followupQueued, 1)
    retirement.resolve(); await flush()
    assert.deepEqual(prompts, ['one', 'two'])
    hungTts.resolve(Buffer.alloc(44)); await flush()
    assert.equal(f.session.getBridgeStatus().state, 'idle')
})

test('R04 stale deadline retirement cannot reset a newer human capture', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 })
    const retirement = deferred<void>(); const hungTts = deferred<Buffer>()
    const f = fixture(t, { turnTimeoutMs: 100,
        hermes: { submitPrompt: async () => '返事。', interrupt: () => retirement.promise, dispose: async () => undefined },
        synthesizeText: () => hungTts.promise,
    })
    await f.session.enqueueFollowup('one'); await flush(); t.mock.timers.tick(100); await flush()
    f.control('listen', 'start'); f.session.handleMessage(Buffer.from([9]))
    retirement.resolve(); await flush()
    assert.equal(f.session.getBridgeStatus().state, 'listening')
    assert.equal((f.session as unknown as { opusFrames: Buffer[] }).opusFrames[0][0], 9)
    hungTts.resolve(Buffer.alloc(44))
})

test('R22 only hello-negotiated devices register, first owner is stable and promoted on close', async t => {
    let registrations = 0
    const f = fixture(t, { registerDeviceSession: () => { registrations++; return () => undefined } }, false, true)
    assert.equal(registrations, 0); f.control('hello'); f.control('hello'); assert.equal(registrations, 1)
    const a = fixture(t, {}, true); const b = fixture(t, {}, true)
    a.control('hello'); b.control('hello')
    const status = async () => getDeviceBridgeStatus() as Record<string, unknown>
    assert.equal((await status()).sessionId, a.session.getBridgeStatus().sessionId)
    b.session.close(); assert.equal((await status()).sessionId, a.session.getBridgeStatus().sessionId)
    const c = fixture(t, {}, true); c.control('hello'); a.session.close()
    assert.equal((await status()).sessionId, c.session.getBridgeStatus().sessionId)
})

test('R13/R24 VAD barge prefix is installed atomically even when its first packet is silence', async t => {
    const pending = deferred<Buffer>(); let synthesisCount = 0; let captured: Buffer = Buffer.alloc(0)
    const speech = Buffer.alloc(1920)
    for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(3000, i)
    const decode = (frame: Buffer) => frame[0] ? speech : Buffer.alloc(1920)
    const f = fixture(t, {
        synthesizeText: async () => ++synthesisCount === 1 ? pending.promise : Buffer.alloc(44),
        createInputOpusDecoder: () => ({ decodeFrame: decode, dispose: () => undefined }), decodeOpusFrame: decode,
        transcribeWav: async wav => { captured = wav.subarray(44); return 'はい' },
        localVadConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 120, endSilenceMs: 650, minSpeechMs: 120, preRollMs: 180 },
        bargeInConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 180, minSpeechMs: 180, ignoreTtsStartMs: 0 },
    })
    await f.session.enqueueFollowup('first'); await flush(); await f.session.enqueueFollowup('notice')
    for (const value of [0, 11, 12, 13]) f.session.handleMessage(Buffer.from([value]))
    f.control('listen', 'stop'); await flush()
    assert.deepEqual(captured, Buffer.concat([Buffer.alloc(1920), speech, speech, speech]))
    assert.deepEqual(f.prompts, ['first', 'はい', 'notice'])
    pending.resolve(Buffer.alloc(44))
})

test('R13/R24 queued notification cannot steal the barge-in prefix from human STT', async t => {
    const pending = deferred<Buffer>(); const batches: number[][] = []; let synthesisCount = 0
    const f = fixture(t, {
        synthesizeText: async () => ++synthesisCount === 1 ? pending.promise : Buffer.alloc(44),
        decodeOpusFrame: () => { const pcm = Buffer.alloc(1920); for (let i = 0; i < 960; i++) pcm.writeInt16LE(4000, i * 2); return pcm },
        decodeOpusFrames: frames => { batches.push(frames.map(f => f[0])); return Buffer.alloc(1920) },
        bargeInConfig: { enabled: true, rmsThreshold: 0.01, startSpeechMs: 180, minSpeechMs: 180, ignoreTtsStartMs: 0 },
    })
    await f.session.enqueueFollowup('first'); await flush()
    await f.session.enqueueFollowup('notice')
    for (const value of [11, 12, 13]) f.session.handleMessage(Buffer.from([value]))
    f.control('listen', 'stop'); await flush()
    assert.deepEqual(batches, [[11, 12, 13]])
    assert.deepEqual(f.prompts, ['first', 'はい', 'notice'])
    f.session.close(); pending.resolve(Buffer.alloc(44)); await flush()
})
