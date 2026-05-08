import { withTiming } from './timing.js'

const VOICEVOX_URL = () => process.env.VOICEVOX_URL ?? 'http://localhost:50021'
const SPEAKER_ID = () => Number(process.env.VOICEVOX_SPEAKER ?? '1')

export async function synthesize(text: string): Promise<Buffer> {
    const speakerId = SPEAKER_ID()
    const baseUrl = VOICEVOX_URL()

    const queryRes = await withTiming(
        'tts.voicevox.audio_query',
        () => fetch(
            `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
            { method: 'POST' }
        ),
        { baseUrl, speakerId, textLength: text.length },
    )
    if (!queryRes.ok) {
        throw new Error(`VOICEVOX audio_query failed: ${queryRes.status}`)
    }
    const query = await withTiming(
        'tts.voicevox.audio_query.parse',
        async () => await queryRes.json(),
    )

    const synthRes = await withTiming(
        'tts.voicevox.synthesis',
        () => fetch(
            `${baseUrl}/synthesis?speaker=${speakerId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            }
        ),
        { baseUrl, speakerId, textLength: text.length },
    )
    if (!synthRes.ok) {
        throw new Error(`VOICEVOX synthesis failed: ${synthRes.status}`)
    }

    return Buffer.from(await withTiming(
        'tts.voicevox.audio_buffer',
        () => synthRes.arrayBuffer(),
    ))
}
