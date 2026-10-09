import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'

type Variant = { leadMs: number, frames: number, scheduledFrameMs: number, encodeMs: number }
type Sample = { iteration: number, wavBytes: number, synthesisMs: number, variants: Variant[], nativeComponentSumMs: number }
type Report = { schemaVersion: number, fixtures: { id: string, textBytes: number, samples: Sample[], summary: { repeatedSynthesisMedianMs: number | null } }[], scope: string }
const { runPipelineBenchmark } = require('../scripts/benchmark_sanotts.cjs') as {
    runPipelineBenchmark: (options: {
        iterations?: unknown,
        synthesize?: (text: string, options: { signal?: AbortSignal }) => Promise<Buffer>,
        encode?: (wav: Buffer, leadMs: number) => Buffer[],
        now?: () => number,
        signal?: AbortSignal,
    }) => Promise<Report>
}

function wavFixture(): Buffer {
    const wav = Buffer.alloc(44)
    wav.write('RIFF', 0)
    wav.write('WAVE', 8)
    return wav
}
function clock(): () => number { let time = 0; return () => (time += 10) }

test('importing the diagnostic performs no native execution or filesystem allocation', () => {
    const script = require.resolve('../scripts/benchmark_sanotts.cjs')
    // Test the import in a fresh process without interfering with Node's loader.
    const imported = childProcess.spawnSync(process.execPath, ['-e', `
        const cp = require('node:child_process'), fs = require('node:fs')
        const forbidden = () => { throw new Error('import side effect') }
        cp.spawn = cp.spawnSync = fs.mkdtempSync = forbidden
        require(${JSON.stringify(script)})
    `], { encoding: 'utf8' })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
})

test('pipeline synthesizes each public fixture once per iteration, alternates encoding order and does not log text', async (t) => {
    t.mock.method(childProcess, 'spawn', () => assert.fail('native execution forbidden'))
    t.mock.method(childProcess, 'spawnSync', () => assert.fail('native execution forbidden'))
    const texts: string[] = []
    const waves: Buffer[] = []
    const calls: { wav: Buffer, leadMs: number }[] = []
    const controller = new AbortController()
    const report = await runPipelineBenchmark({ iterations: 3, signal: controller.signal, now: clock(),
        synthesize: async (text, options) => {
            assert.equal(options.signal, controller.signal)
            texts.push(text); const wav = wavFixture(); waves.push(wav); return wav
        },
        encode: (wav, leadMs) => { calls.push({ wav, leadMs }); return Array.from({ length: leadMs ? 17 : 7 }, () => Buffer.from([1])) },
    })
    assert.equal(texts.length, 9)
    assert.equal(calls.length, 18)
    assert.deepEqual(report.fixtures.map(fixture => fixture.id), ['ack', 'question', 'long'])
    for (let index = 0; index < 9; index++) {
        assert.equal(calls[index * 2].wav, waves[index])
        assert.equal(calls[index * 2 + 1].wav, waves[index])
        assert.deepEqual([calls[index * 2].leadMs, calls[index * 2 + 1].leadMs], index % 3 === 1 ? [600, 0] : [0, 600])
    }
    const json = JSON.stringify(report)
    for (const text of new Set(texts)) assert.equal(json.includes(text), false)
    for (const fixture of report.fixtures) {
        assert.equal(fixture.summary.repeatedSynthesisMedianMs, 10)
        for (const sample of fixture.samples) {
            assert.equal(sample.synthesisMs, 10)
            assert.equal(sample.nativeComponentSumMs, 20)
            assert.equal(sample.variants.find(variant => variant.leadMs === 0)?.scheduledFrameMs, 420)
            assert.equal(sample.variants.find(variant => variant.leadMs === 600)?.scheduledFrameMs, 1020)
        }
    }
})

test('single iteration has no invented repeated-process median', async () => {
    const report = await runPipelineBenchmark({ iterations: 1, now: clock(), synthesize: async () => wavFixture(), encode: () => [Buffer.from([1])] })
    assert.ok(report.fixtures.every(fixture => fixture.summary.repeatedSynthesisMedianMs === null))
})

test('invalid iteration bounds fail before dependencies or synthesis', async () => {
    for (const iterations of [0, -1, 11, 1.1, NaN, Infinity, '3']) {
        await assert.rejects(runPipelineBenchmark({ iterations, synthesize: async () => assert.fail('must not synthesize') }), /iterations/)
    }
})

test('abort before synthesis or while returning WAV prevents encoding and publication', async () => {
    for (const before of [true, false]) {
        const controller = new AbortController()
        if (before) controller.abort()
        let calls = 0
        await assert.rejects(runPipelineBenchmark({ signal: controller.signal,
            synthesize: async () => { calls++; controller.abort(); return wavFixture() },
            encode: () => assert.fail('must not encode after abort'),
        }))
        assert.equal(calls, before ? 0 : 1)
    }
})

test('abort during encoding prevents later variants and fixtures', async () => {
    const controller = new AbortController()
    let synthesisCalls = 0, encodeCalls = 0
    await assert.rejects(runPipelineBenchmark({ signal: controller.signal,
        synthesize: async () => { synthesisCalls++; return wavFixture() },
        encode: () => { encodeCalls++; controller.abort(); return [Buffer.from([1])] },
    }))
    assert.equal(synthesisCalls, 1)
    assert.equal(encodeCalls, 1)
})

test('invalid or oversized WAVs and invalid frames are rejected', async () => {
    for (const wav of [Buffer.alloc(43), Buffer.alloc(44), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
        await assert.rejects(runPipelineBenchmark({ synthesize: async () => wav, encode: () => assert.fail('invalid WAV must not encode') }), /invalid diagnostic WAV/)
    }
    for (const frames of [[], [Buffer.alloc(0)], ['not a buffer']]) {
        await assert.rejects(runPipelineBenchmark({ synthesize: async () => wavFixture(), encode: () => frames as Buffer[] }), /invalid diagnostic Opus frames/)
    }
})

test('non-monotonic timing fails instead of reporting a negative measurement', async () => {
    let time = 10
    await assert.rejects(runPipelineBenchmark({ now: () => time--, synthesize: async () => wavFixture(), encode: () => [Buffer.from([1])] }), /invalid monotonic clock/)
})
