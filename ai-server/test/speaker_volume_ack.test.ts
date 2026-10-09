import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSpeakerVolumeAck } from '../src/speaker_volume_ack.ts'

const mcp = (text: string) => ({ content: [{ type: 'text', text }], isError: false })

test('speaker ACK accepts explicit integer volume objects and bounded JSON/MCP text wrappers', () => {
    for (const volume of [0, 10, 62, 100]) {
        const result = { speaker_volume: volume, permanent: false }
        for (const ack of [result, JSON.stringify(result), mcp(JSON.stringify(result)), JSON.stringify(mcp(JSON.stringify(result)))]) {
            assert.equal(readSpeakerVolumeAck(ack), volume)
        }
    }
})

test('speaker ACK rejects generic success, missing fields, malformed or non-integer volumes', () => {
    for (const ack of [undefined, null, true, false, 0, 'true', 'OK', '', '{', {}, [],
        { volume: 0 }, { speaker_volume: '0' }, { speaker_volume: true },
        { speaker_volume: 0.5 }, { speaker_volume: NaN }, { speaker_volume: Infinity },
        { speaker_volume: -1 }, { speaker_volume: 101 }, Object.create({ speaker_volume: 0 }),
        mcp('private malformed result'), mcp('{"volume":0}'), mcp('true')]) {
        assert.equal(readSpeakerVolumeAck(ack), undefined)
    }
})

test('speaker ACK rejects errors and ambiguous or malformed MCP content', () => {
    const text = '{"speaker_volume":0}'
    for (const ack of [
        { speaker_volume: 0, isError: true }, { speaker_volume: 0, error: 'private' },
        { speaker_volume: 0, isError: 'false' }, { ...mcp(text), isError: true },
        mcp('{"speaker_volume":0,"isError":true}'), mcp('{"speaker_volume":0,"error":"private"}'),
        { ...mcp(text), speaker_volume: 0 }, { content: [] }, { content: null },
        { content: [{ type: 'image', text }] }, { content: [{ type: 'text', text: 0 }] },
        { content: [...mcp(text).content, ...mcp(text).content] },
        { content: [{ type: 'text', text, isError: true }] },
        { content: [{ type: 'text', text, error: 'private' }] },
        { content: [Object.create({ type: 'text', text })] },
    ]) assert.equal(readSpeakerVolumeAck(ack), undefined)
})

test('speaker ACK bounds string work and wrapper depth and contains accessor failures', () => {
    const text = '{"speaker_volume":0}'
    assert.equal(readSpeakerVolumeAck(`${' '.repeat(4096)}${text}`), undefined)
    let nested: unknown = { speaker_volume: 0 }
    for (let index = 0; index < 4; index++) nested = mcp(JSON.stringify(nested))
    assert.equal(readSpeakerVolumeAck(nested), undefined)
    const string = `${' '.repeat(2050)}${text}`
    assert.equal(readSpeakerVolumeAck(JSON.stringify(string)), undefined, 'aggregate decoded text is bounded')
    assert.equal(readSpeakerVolumeAck({ get speaker_volume() { throw new Error('private accessor') } }), undefined)
})
