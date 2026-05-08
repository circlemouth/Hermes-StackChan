import OpenAI from 'openai'
import { TOOLS, callTool } from './tools.js'
import { withTiming } from './timing.js'

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
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
    const response = await withTiming(
        'llm.chat.initial',
        () => getClient().chat.completions.create({
            model,
            messages,
            tools: TOOLS,
            tool_choice: 'auto',
        }),
        { model, messageCount: messages.length },
    )

    const choice = response.choices[0]

    // ツール呼び出しが必要な場合はツールを実行して再度APIを呼ぶ
    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        const extended: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            ...messages,
            choice.message,
        ]

        for (const toolCall of choice.message.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
            const result = await withTiming(
                `llm.tool.${toolCall.function.name}`,
                () => callTool(toolCall.function.name, args),
            )
            console.log(`[llm] tool ${toolCall.function.name}(${toolCall.function.arguments}) => ${result}`)
            extended.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: result,
            })
        }

        const final = await withTiming(
            'llm.chat.final',
            () => getClient().chat.completions.create({
                model,
                messages: extended,
            }),
            { model, messageCount: extended.length },
        )
        return final.choices[0]?.message.content ?? ''
    }

    return choice.message.content ?? ''
}
