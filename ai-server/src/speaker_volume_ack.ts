const MAX_ACK_TEXT_LENGTH = 4096
const MAX_ACK_DEPTH = 6

/** Parse only explicit firmware volume acknowledgements, never generic success. */
export function readSpeakerVolumeAck(result: unknown): number | undefined {
    return readSpeakerVolumeAckRecord(result)?.['speaker_volume'] as number | undefined
}

export function readSpeakerVolumeAckRecord(result: unknown): Record<string, unknown> | undefined {
    let remainingText = MAX_ACK_TEXT_LENGTH
    const parse = (value: unknown, depth: number): Record<string, unknown> | undefined => {
        if (depth > MAX_ACK_DEPTH) return undefined
        if (typeof value === 'string') {
            if (!value.length || value.length > remainingText) return undefined
            remainingText -= value.length
            return parse(JSON.parse(value) as unknown, depth + 1)
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
        const record = value as Record<string, unknown>
        const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key)
        // Reject error/malformed error markers at every wrapper layer.
        if (has('error') || record['success'] === false || (has('isError') && record['isError'] !== false)) return undefined
        if (has('content')) {
            // Mixed or multiple results are ambiguous, so cannot authorize playback.
            if (has('speaker_volume')) return undefined
            const content = record['content']
            if (!Array.isArray(content) || content.length !== 1) return undefined
            const item: unknown = content[0]
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
            const textItem = item as Record<string, unknown>
            const itemHas = (key: string) => Object.prototype.hasOwnProperty.call(textItem, key)
            if (!itemHas('type') || !itemHas('text') || itemHas('error')
                || (itemHas('isError') && textItem['isError'] !== false)) return undefined
            if (textItem['type'] !== 'text' || typeof textItem['text'] !== 'string') return undefined
            return parse(textItem['text'], depth + 1)
        }
        if (!has('speaker_volume')) return undefined
        const volume = record['speaker_volume']
        return typeof volume === 'number' && Number.isInteger(volume) && volume >= 0 && volume <= 100
            ? record
            : undefined
    }
    try {
        return parse(result, 0)
    } catch {
        // Malformed JSON/accessors are unverifiable; never expose result content.
        return undefined
    }
}
