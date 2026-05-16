import 'dotenv/config'
import { startServer } from './server.js'

const PORT = Number(process.env.PORT ?? '8765')
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? ''

function isLocalOpenAICompatibleEndpoint(baseUrl: string): boolean {
    if (!baseUrl) return false
    try {
        const url = new URL(baseUrl)
        const hostname = url.hostname.toLowerCase()
        return url.protocol === 'http:' ||
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname.endsWith('.local') ||
            /^10\./.test(hostname) ||
            /^192\.168\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    } catch {
        return false
    }
}

if (!process.env.OPENAI_API_KEY) {
    if (isLocalOpenAICompatibleEndpoint(OPENAI_BASE_URL)) {
        process.env.OPENAI_API_KEY = 'local'
        console.log('[server] OPENAI_API_KEY is not set; using placeholder key for local OpenAI-compatible endpoint')
    } else {
        console.error('[error] OPENAI_API_KEY is not set')
        process.exit(1)
    }
}

startServer(PORT)
