import OpenAI from 'openai'
import { pcmToWav } from './audio.js'

let client: OpenAI | null = null

function getClient(): OpenAI {
    if (!client) {
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        })
    }
    return client
}

export async function transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    const wav = pcmToWav(pcm, sampleRate)
    const file = new File([wav], 'audio.wav', { type: 'audio/wav' })
    const result = await getClient().audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'ja',
    })
    return result.text
}
