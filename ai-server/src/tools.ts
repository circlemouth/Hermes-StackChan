import type OpenAI from 'openai'
import { withTiming } from './timing.js'

type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool

const WEATHER_CODES: Record<number, string> = {
    0: '快晴', 1: '晴れ', 2: '一部曇り', 3: '曇り',
    45: '霧', 48: '霧氷',
    51: '霧雨（弱）', 53: '霧雨', 55: '霧雨（強）',
    61: '雨（弱）', 63: '雨', 65: '雨（強）',
    71: '雪（弱）', 73: '雪', 75: '雪（強）',
    80: 'にわか雨（弱）', 81: 'にわか雨', 82: 'にわか雨（強）',
    95: '雷雨', 99: '雷雨（雹あり）',
}

async function getWeather(city: string): Promise<string> {
    const geoRes = await withTiming(
        'tool.weather.geocode',
        () => fetch(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ja`
        ),
        { city },
    )
    if (!geoRes.ok) return `天気情報の取得に失敗しました`

    const geoData = await withTiming(
        'tool.weather.geocode.parse',
        async () => await geoRes.json() as { results?: { latitude: number; longitude: number; name: string }[] },
    )
    if (!geoData.results?.length) return `${city}の位置情報が見つかりませんでした`

    const { latitude, longitude, name } = geoData.results[0]

    const weatherRes = await withTiming(
        'tool.weather.forecast',
        () => fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
            `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,precipitation&timezone=auto`
        ),
        { city: name, latitude, longitude },
    )
    if (!weatherRes.ok) return `天気情報の取得に失敗しました`

    const weatherData = await withTiming(
        'tool.weather.forecast.parse',
        async () => await weatherRes.json() as {
            current: {
                temperature_2m: number
                apparent_temperature: number
                weathercode: number
                windspeed_10m: number
                precipitation: number
            }
        },
    )
    const c = weatherData.current
    const condition = WEATHER_CODES[c.weathercode] ?? '不明'

    return `${name}の現在の天気: ${condition}、気温${c.temperature_2m}°C（体感${c.apparent_temperature}°C）、風速${c.windspeed_10m}km/h`
}

export const TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: '指定した都市・地域の現在の天気情報を取得する',
            parameters: {
                type: 'object',
                properties: {
                    city: {
                        type: 'string',
                        description: '都市名または地域名（日本語可、例: 東京、大阪、札幌）',
                    },
                },
                required: ['city'],
            },
        },
    },
]

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'get_weather') {
        return getWeather(args['city'] as string)
    }
    return 'ツールが見つかりませんでした'
}
