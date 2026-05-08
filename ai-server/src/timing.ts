export function nowMs(): number {
    return performance.now()
}

export function elapsedMs(startMs: number): string {
    return `${(nowMs() - startMs).toFixed(1)}ms`
}

export async function withTiming<T>(
    label: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>,
): Promise<T> {
    const startMs = nowMs()
    const suffix = meta ? ` ${JSON.stringify(meta)}` : ''
    console.log(`[timing] start ${label}${suffix}`)
    try {
        const result = await fn()
        console.log(`[timing] done ${label} elapsed=${elapsedMs(startMs)}`)
        return result
    } catch (error) {
        console.log(`[timing] error ${label} elapsed=${elapsedMs(startMs)}`)
        throw error
    }
}
