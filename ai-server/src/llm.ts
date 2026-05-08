import OpenAI from 'openai'

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }

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

export async function chat(messages: Message[]): Promise<string> {
    const response = await getClient().chat.completions.create({
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        messages,
    })
    return response.choices[0]?.message.content ?? ''
}
