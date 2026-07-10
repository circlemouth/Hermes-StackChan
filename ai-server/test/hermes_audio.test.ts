import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { synthesizeWithHermes } from '../src/hermes_audio.js'

function minimalWav(): Buffer {
    const wav = Buffer.alloc(44)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(36, 4)
    wav.write('WAVE', 8, 'ascii')
    wav.write('fmt ', 12, 'ascii')
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(24_000, 24)
    wav.writeUInt32LE(48_000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36, 'ascii')
    wav.writeUInt32LE(0, 40)
    return wav
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert(address && typeof address === 'object')
    return address.port
}

test('synthesizeWithHermes uses the configured persistent local HTTP TTS endpoint', async () => {
    let requestBody = ''
    const server = createServer((request, response) => {
        request.setEncoding('utf8')
        request.on('data', chunk => { requestBody += chunk })
        request.on('end', () => {
            response.writeHead(200, { 'content-type': 'audio/wav' })
            response.end(minimalWav())
        })
    })
    const port = await listen(server)
    const previousUrl = process.env.STACKCHAN_LOCAL_TTS_URL
    process.env.STACKCHAN_LOCAL_TTS_URL = `http://127.0.0.1:${port}/?language=ja`

    try {
        const wav = await synthesizeWithHermes('こんにちは。')
        assert.equal(requestBody, 'こんにちは。')
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    } finally {
        if (previousUrl === undefined) delete process.env.STACKCHAN_LOCAL_TTS_URL
        else process.env.STACKCHAN_LOCAL_TTS_URL = previousUrl
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})

test('synthesizeWithHermes rejects a non-WAV local TTS response', async () => {
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('not audio')
    })
    const port = await listen(server)
    const previousUrl = process.env.STACKCHAN_LOCAL_TTS_URL
    process.env.STACKCHAN_LOCAL_TTS_URL = `http://127.0.0.1:${port}/`

    try {
        await assert.rejects(
            () => synthesizeWithHermes('test'),
            /did not return a valid WAV file/,
        )
    } finally {
        if (previousUrl === undefined) delete process.env.STACKCHAN_LOCAL_TTS_URL
        else process.env.STACKCHAN_LOCAL_TTS_URL = previousUrl
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})
