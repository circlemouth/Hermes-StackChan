import OpenAI from 'openai'
import { TOOLS, callTool } from './tools.js'

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
        tools: TOOLS,
        tool_choice: 'auto',
    })

    const choice = response.choices[0]

    // ツール呼び出しが必要な場合はツールを実行して再度APIを呼ぶ
    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        const extended: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            ...messages,
            choice.message,
        ]

        for (const toolCall of choice.message.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
            const result = await callTool(toolCall.function.name, args)
            console.log(`[llm] tool ${toolCall.function.name}(${toolCall.function.arguments}) => ${result}`)
            extended.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result,
            })
        }

        const final = await getClient().chat.completions.create({
            model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
            messages: extended,
        })
        return final.choices[0]?.message.content ?? ''
    }

    return choice.message.content ?? ''
}
