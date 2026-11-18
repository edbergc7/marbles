import { net, protocol } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeAtomic } from './library'

const CDN_ALLOWLIST = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']

const MAX_CDN_BYTES = 50 * 1024 * 1024
/** Total cache size; the oldest entries (by fetchedAt) are evicted past this. */
const MAX_CACHE_BYTES = 500 * 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000
/** Downloads running at once. Each can hold up to MAX_CDN_BYTES in memory, so an app asking
 * for many big files at the same time must not make main hold them all. */
const MAX_PARALLEL_FETCHES = 4

interface IndexEntry {
  contentType: string
  size: number
  fetchedAt: string
}

/** Rewrites CDN URLs (absolute and protocol-relative) in generated HTML to cdn://host/. */
export function rewriteCdnUrls(html: string): string {
  return html.replace(
    /(?<![A-Za-z0-9:])(https:)?\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//gi,
    (_m, _scheme, host: string) => `cdn://${host.toLowerCase()}/`
  )
}

export function registerCdnScheme(): Electron.CustomScheme {
  return {
    scheme: 'cdn',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

export class CdnCache {
  private index: Record<string, IndexEntry> | null = null
  private inflight = new Map<string, Promise<{ body: Buffer; contentType: string }>>()
  private indexWrite: Promise<void> = Promise.resolve()

  constructor(private cacheDir: string) {}

  private indexLoad: Promise<Record<string, IndexEntry>> | null = null
  private downloading = 0
  private downloadQueue: (() => void)[] = []

  /** Runs `fn` when one of the MAX_PARALLEL_FETCHES download slots is free. */
  private async withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.downloading >= MAX_PARALLEL_FETCHES) {
      await new Promise<void>((resolve) => this.downloadQueue.push(resolve))
    } else {
      this.downloading++
    }
    try {
      return await fn()
    } finally {
      // Hand our slot straight to the next waiter, or free it.
      const next = this.downloadQueue.shift()
      if (next) next()
      else this.downloading--
    }
  }

  private loadIndex(): Promise<Record<string, IndexEntry>> {
    this.indexLoad ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(join(this.cacheDir, 'index.json'), 'utf8'))
        this.index = raw && typeof raw === 'object' ? raw : {}
      } catch {
        this.index = {}
      }
      return this.index!
    })()
    return this.indexLoad
  }

  private saveIndex(): void {
    this.indexWrite = this.indexWrite
      .then(() => writeAtomic(join(this.cacheDir, 'index.json'), JSON.stringify(this.index)))
      .catch((err) => console.warn('[cdn] could not save index', err))
  }

  private fileFor(url: string): string {
    return join(this.cacheDir, createHash('sha256').update(url).digest('hex') + '.bin')
  }

  /** Returns the cached (or freshly fetched) body for an allowlisted https URL. */
  fetchCached(url: string): Promise<{ body: Buffer; contentType: string }> {
    const existing = this.inflight.get(url)
    if (existing) return existing
    const p = this.doFetch(url).finally(() => this.inflight.delete(url))
    this.inflight.set(url, p)
    return p
  }

  private async doFetch(url: string): Promise<{ body: Buffer; contentType: string }> {
    const index = await this.loadIndex()
    const hit = index[url]
    if (hit) {
      try {
        return { body: await fs.readFile(this.fileFor(url)), contentType: hit.contentType }
      } catch {
        delete index[url] // index points at a missing file; refetch
      }
    }
    return this.withDownloadSlot(() => this.download(url, index))
  }

  private async download(
    url: string,
    index: Record<string, IndexEntry>
  ): Promise<{ body: Buffer; contentType: string }> {
    // The timer starts here, not while waiting for a slot.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await net.fetch(url, { redirect: 'follow', signal: ac.signal })
      if (!res.ok) {
        const err = new Error(`Upstream returned ${res.status}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      // Enforce the size while streaming, so an oversized body never sits in memory whole.
      if (Number(res.headers.get('content-length')) > MAX_CDN_BYTES) {
        ac.abort()
        throw new Error('File too large')
      }
      const chunks: Uint8Array[] = []
      let total = 0
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.length
          if (total > MAX_CDN_BYTES) {
            ac.abort()
            throw new Error('File too large')
          }
          chunks.push(chunk)
        }
      }
      const body = Buffer.concat(chunks)
      const contentType = res.headers.get('content-type') || 'application/octet-stream'
      await fs.mkdir(this.cacheDir, { recursive: true })
      await fs.writeFile(this.fileFor(url), body)
      index[url] = { contentType, size: body.length, fetchedAt: new Date().toISOString() }
      await this.evict(index, url)
      this.saveIndex()
      return { body, contentType }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Drops the oldest entries until the cache fits MAX_CACHE_BYTES. Never drops `keep`. */
  private async evict(index: Record<string, IndexEntry>, keep: string): Promise<void> {
    let total = 0
    for (const e of Object.values(index)) total += e.size || 0
    if (total <= MAX_CACHE_BYTES) return
    const oldest = Object.entries(index)
      .filter(([u]) => u !== keep)
      .sort((a, b) => String(a[1].fetchedAt).localeCompare(String(b[1].fetchedAt)))
    for (const [u, e] of oldest) {
      if (total <= MAX_CACHE_BYTES) break
      delete index[u]
      total -= e.size || 0
      await fs.rm(this.fileFor(u), { force: true }).catch(() => {})
    }
  }

  /** Registers the `cdn://` protocol handler. The scheme must be registered as privileged earlier. */
  register(): void {
    protocol.handle('cdn', async (request) => {
      try {
        const u = new URL(request.url)
        const host = u.hostname.toLowerCase()
        if (!CDN_ALLOWLIST.includes(host)) return plain(403, `Host not allowed: ${host}`)
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return plain(405, 'Method not allowed')
        const target = `https://${host}${u.pathname}${u.search}`
        try {
          const { body, contentType } = await this.fetchCached(target)
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(body.length),
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000'
            }
          })
        } catch (err) {
          const status = (err as { status?: number }).status
          if (status === 404 || status === 403 || status === 410) {
            return plain(status, `Not found on ${host}`)
          }
          const msg = err instanceof Error ? err.message : String(err)
          return plain(502, `Could not load ${target} (no cached copy): ${msg}`)
        }
      } catch (err) {
        console.warn('[cdn] error', err)
        return plain(500, 'Internal error')
      }
    })
  }
}
