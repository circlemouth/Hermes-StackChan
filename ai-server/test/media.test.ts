import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFirstDisplayImage, resolveDisplayImageSource, setObservedMediaBaseUrl, stripMediaForSpeech } from '../src/media.ts'

test('media helpers extract MEDIA paths, publish local URLs, and strip speech text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackchan-media-'))
    const imagePath = path.join(dir, 'image.png')
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    setObservedMediaBaseUrl('http://stackchan.local:8765')

    const reply = `MEDIA:${imagePath}\nこちらを表示します`
    assert.equal(extractFirstDisplayImage(reply), imagePath)
    assert.equal(stripMediaForSpeech(reply), 'こちらを表示します')

    const url = resolveDisplayImageSource(`MEDIA:${imagePath}`)
    assert.ok(url?.startsWith('http://stackchan.local:8765/media/'))

    fs.rmSync(dir, { recursive: true, force: true })
})
