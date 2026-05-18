import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'

type MediaEntry = {
    filePath: string
    mimeType: string
    expiresAt: number
}

const MEDIA_TTL_MS = Number(process.env.STACKCHAN_MEDIA_TTL_MS ?? 10 * 60 * 1000)
const MAX_MEDIA_FILE_BYTES = Number(process.env.STACKCHAN_MEDIA_MAX_BYTES ?? 5 * 1024 * 1024)
const mediaEntries = new Map<string, MediaEntry>()
let observedBaseUrl: string | null = null

function configuredBaseUrl(): string | null {
    const value = process.env.STACKCHAN_PUBLIC_BASE_URL?.trim()
    return value ? value.replace(/\/+$/, '') : null
}

function publicBaseUrl(): string {
    return configuredBaseUrl() ?? observedBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? '8765'}`
}

function cleanSource(source: string): string {
    return source.trim().replace(/^<|>$/g, '').replace(/^['"`]|['"`]$/g, '').replace(/[),.。]+$/u, '')
}

function mimeTypeForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    return null
}

function isHttpUrl(source: string): boolean {
    return /^https?:\/\//i.test(source)
}

function filePathFromSource(source: string): string | null {
    if (source.startsWith('file://')) {
        try {
            return new URL(source).pathname
        } catch {
            return null
        }
    }
    return path.isAbsolute(source) ? source : null
}

export function setObservedMediaBaseUrl(baseUrl: string): void {
    if (configuredBaseUrl()) return
    observedBaseUrl = baseUrl.replace(/\/+$/, '')
}

export function registerMediaFile(filePath: string): string {
    const resolved = path.resolve(filePath)
    const mimeType = mimeTypeForFile(resolved)
    if (!mimeType) {
        throw new Error(`Unsupported image type for StackChan display: ${resolved}`)
    }
    const stats = fs.statSync(resolved)
    if (!stats.isFile()) throw new Error(`Media path is not a file: ${resolved}`)
    if (stats.size > MAX_MEDIA_FILE_BYTES) {
        throw new Error(`Media file is too large for StackChan display: ${resolved}`)
    }

    const id = crypto.randomUUID()
    mediaEntries.set(id, {
        filePath: resolved,
        mimeType,
        expiresAt: Date.now() + MEDIA_TTL_MS,
    })
    return `${publicBaseUrl()}/media/${id}`
}

export function resolveDisplayImageSource(source: string): string | null {
    const cleaned = cleanSource(source).replace(/^MEDIA:\s*/iu, '')
    if (!cleaned) return null
    if (isHttpUrl(cleaned)) return cleaned

    const filePath = filePathFromSource(cleaned)
    return filePath ? registerMediaFile(filePath) : null
}

export function extractFirstDisplayImage(text: string): string | null {
    const mediaMatch = text.match(/MEDIA:\s*(\S+)/u)
    if (mediaMatch?.[1]) return cleanSource(mediaMatch[1])

    const markdownMatch = text.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u)
    if (markdownMatch?.[1]) return cleanSource(markdownMatch[1])

    return null
}

export function stripMediaForSpeech(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]+\)/gu, '')
        .replace(/MEDIA:\s*\S+/gu, '')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
}

export function serveMediaRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/media/')) return false

    const id = decodeURIComponent(url.pathname.slice('/media/'.length))
    const entry = mediaEntries.get(id)
    if (!entry || entry.expiresAt < Date.now()) {
        if (entry) mediaEntries.delete(id)
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('media not found')
        return true
    }

    const stream = fs.createReadStream(entry.filePath)
    stream.on('error', () => {
        mediaEntries.delete(id)
        if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('media not found')
    })
    res.writeHead(200, {
        'content-type': entry.mimeType,
        'cache-control': 'no-store',
    })
    stream.pipe(res)
    return true
}
