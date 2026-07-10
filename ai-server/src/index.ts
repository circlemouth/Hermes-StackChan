import 'dotenv/config'
import { startServer } from './server.js'
import { startDeviceControlServer } from './device_control.js'
import { HermesClient } from './hermes.js'

const PORT = Number(process.env.PORT ?? '8765')
const CONTROL_PORT = Number(process.env.STACKCHAN_CONTROL_PORT ?? '8766')
const CONTROL_HOST = process.env.STACKCHAN_CONTROL_HOST ?? '127.0.0.1'

function isEnabled(value: string | undefined): boolean {
    return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

async function warmHermes(): Promise<void> {
    if (!isEnabled(process.env.STACKCHAN_HERMES_WARMUP_ENABLED)) return

    const configuredTimeout = Number(process.env.STACKCHAN_HERMES_WARMUP_TIMEOUT_MS ?? 20_000)
    const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.max(3_000, Math.min(60_000, Math.round(configuredTimeout)))
        : 20_000
    const previousTurnTimeout = process.env.HERMES_TURN_TIMEOUT_MS
    process.env.HERMES_TURN_TIMEOUT_MS = String(timeoutMs)
    const startedAt = performance.now()
    const client = new HermesClient()
    try {
        const reply = await client.submitPrompt('日本語で準備完了とだけ答えてください。')
        console.log(`[warmup] Hermes ready elapsed=${Math.round(performance.now() - startedAt)}ms chars=${reply.length}`)
    } catch (error) {
        console.warn(`[warmup] Hermes warmup skipped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
        await client.dispose().catch(() => undefined)
        if (previousTurnTimeout === undefined) delete process.env.HERMES_TURN_TIMEOUT_MS
        else process.env.HERMES_TURN_TIMEOUT_MS = previousTurnTimeout
    }
}

async function main(): Promise<void> {
    startDeviceControlServer(CONTROL_PORT, CONTROL_HOST)
    await warmHermes()
    startServer(PORT)
}

void main().catch((error) => {
    console.error(`[server] startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
})
