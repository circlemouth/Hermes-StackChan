import OpenAI from 'openai'
import { pcmToWav } from './audio.js'

let openaiClient: OpenAI | null = null

function getOpenAIClient(): OpenAI {
    if (!openaiClient) {
        openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        })
    }
    return openaiClient
}

async function transcribeLocal(wav: Buffer): Promise<string> {
    const baseURL = process.env.STT_BASE_URL!
    const formData = new FormData()
    formData.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')

    const res = await fetch(
        `${baseURL}/asr?task=transcribe&language=ja&encode=true&output=json`,
        { method: 'POST', body: formData }
    )
    if (!res.ok) throw new Error(`Whisper ASR failed: ${res.status}`)
    const json = await res.json() as { text: string }
    return json.text
}

async function transcribeOpenAI(wav: Buffer): Promise<string> {
    const file = new File([wav], 'audio.wav', { type: 'audio/wav' })
    const result = await getOpenAIClient().audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'ja',
    })
    return result.text
}

export async function transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    const wav = pcmToWav(pcm, sampleRate)
    if (process.env.STT_BASE_URL) {
        return transcribeLocal(wav)
    }
    return transcribeOpenAI(wav)
}
