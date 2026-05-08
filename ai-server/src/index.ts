import 'dotenv/config'
import { startServer } from './server.js'

const PORT = Number(process.env.PORT ?? '8765')

if (!process.env.OPENAI_API_KEY) {
    console.error('[error] OPENAI_API_KEY is not set')
    process.exit(1)
}

startServer(PORT)
