import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { chmod, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readSanoTtsConfig, synthesizeWithSanoTts } from '../src/sanotts_audio.ts'

test('readSanoTtsConfig resolves files below the configured runtime directory', () => {
    const config = readSanoTtsConfig({
        SANOTTS_RUNTIME_DIR: '/tmp/sanotts-runtime',
        SANOTTS_TIMEOUT_MS: '45000',
    })

    assert.equal(config.command, path.join('/tmp/sanotts-runtime', 'bin', 'sanotts-cli'))
    assert.equal(config.modelPath, path.join('/tmp/sanotts-runtime', 'assets', 'saanotts-jp-v3-int8.bin'))
    assert.equal(config.dictionaryPath, path.join('/tmp/sanotts-runtime', 'assets', 'k1-dict-438750.bin'))
    assert.equal(config.timeoutMs, 45000)
})

test('readSanoTtsConfig accepts individual file overrides and bounds timeout', () => {
    const config = readSanoTtsConfig({
        SANOTTS_COMMAND: '/opt/bin/sano',
        SANOTTS_MODEL_PATH: '/models/model.bin',
        SANOTTS_DICT_PATH: '/models/dict.bin',
        SANOTTS_TIMEOUT_MS: '10',
    })

    assert.equal(config.command, '/opt/bin/sano')
    assert.equal(config.modelPath, '/models/model.bin')
    assert.equal(config.dictionaryPath, '/models/dict.bin')
    assert.equal(config.timeoutMs, 1000)
    assert.equal(readSanoTtsConfig({ SANOTTS_TIMEOUT_MS: '' }).timeoutMs, 30000)
    assert.equal(readSanoTtsConfig({ SANOTTS_TIMEOUT_MS: 'Infinity' }).timeoutMs, 30000)
    assert.equal(readSanoTtsConfig({ SANOTTS_TIMEOUT_MS: '999999' }).timeoutMs, 120000)
})

test('sanoTTS-jp validates input before loading or starting a runtime', async () => {
    await assert.rejects(synthesizeWithSanoTts('   '), /empty text/)
    await assert.rejects(synthesizeWithSanoTts('a\0b'), /NUL/)
    await assert.rejects(synthesizeWithSanoTts('あ'.repeat(171)), /512 UTF-8 bytes/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(synthesizeWithSanoTts('診断。', { signal: controller.signal }), /aborted/)
})

test('custom Sano one-shot commands keep argument compatibility, bounds, and lifecycle', async (t) => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'sanotts-test-'))
    const command = path.join(fixture, 'mock.cjs')
    const record = path.join(fixture, 'record.json')
    const configEnv = {
        SANOTTS_COMMAND: command,
        SANOTTS_MODEL_PATH: path.join(fixture, 'model.bin'),
        SANOTTS_DICT_PATH: path.join(fixture, 'dict.bin'),
        SANOTTS_TIMEOUT_MS: '1000',
    }
    const previous = Object.fromEntries(Object.keys(configEnv).map((key) => [key, process.env[key]]))
    await writeFile(configEnv.SANOTTS_MODEL_PATH, 'model')
    await writeFile(configEnv.SANOTTS_DICT_PATH, 'dict')
    await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const text = args[args.indexOf('--text') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, output, pid: process.pid }));
if (text === 'fail') { process.stderr.write('PRIVATE_DIAGNOSTIC_SENTINEL'); process.exit(7); }
if (text === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (text === 'large') { const fd = fs.openSync(output, 'w'); fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1); fs.closeSync(fd); }
else { const wav = Buffer.alloc(46); wav.write(text === 'invalid' ? 'FAIL' : 'RIFF'); wav.write('WAVE', 8); fs.writeFileSync(output, wav); }
`)
    await chmod(command, 0o700)
    Object.assign(process.env, configEnv)
    const recorded = async () => JSON.parse(await readFile(record, 'utf8')) as { args: string[], output: string, pid: number }
    const checkCleaned = async () => {
        const info = await recorded()
        await assert.rejects(access(path.dirname(info.output)), { code: 'ENOENT' })
    }
    try {
        await t.test('passes exact text as one argument without shell interpretation', async () => {
            const text = '診断。; $(printf nope) "quoted"\n二行目'
            const wav = await synthesizeWithSanoTts(` ${text} `)
            assert.equal(wav.length, 46)
            assert.deepEqual((await recorded()).args, [
                '--model', configEnv.SANOTTS_MODEL_PATH,
                '--dict', configEnv.SANOTTS_DICT_PATH,
                '--output', (await recorded()).output,
                '--text', text,
            ])
            await checkCleaned()
        })
        await t.test('does not propagate helper stderr/private text into errors', async () => {
            await assert.rejects(synthesizeWithSanoTts('fail'), (error: Error) => {
                assert.equal(error.message, 'sanoTTS-jp exited with code 7')
                return true
            })
            await checkCleaned()
        })
        await t.test('rejects malformed and oversized output before returning audio', async () => {
            await assert.rejects(synthesizeWithSanoTts('invalid'), /invalid or oversized WAV/)
            await checkCleaned()
            await assert.rejects(synthesizeWithSanoTts('large'), /invalid or oversized WAV/)
            await checkCleaned()
        })
        await t.test('timeout kills and reaps the helper before cleanup', async () => {
            await assert.rejects(synthesizeWithSanoTts('hang'), /timed out after 1000ms/)
            const info = await recorded()
            assert.throws(() => process.kill(info.pid, 0), { code: 'ESRCH' })
            await checkCleaned()
        })
        await t.test('abort kills and reaps the helper before cleanup', async () => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 200)
            try {
                await assert.rejects(synthesizeWithSanoTts('hang', { signal: controller.signal }), /aborted/)
            } finally { clearTimeout(timer) }
            const info = await recorded()
            assert.throws(() => process.kill(info.pid, 0), { code: 'ESRCH' })
            await checkCleaned()
        })
        await t.test('missing runtime does not silently select another engine', async () => {
            process.env.SANOTTS_COMMAND = path.join(fixture, 'missing')
            await assert.rejects(synthesizeWithSanoTts('診断。'), /runtime is missing/)
        })
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rm(fixture, { recursive: true, force: true })
    }
})
