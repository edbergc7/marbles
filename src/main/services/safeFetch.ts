import http from 'http'
import https from 'https'
import { lookup as dnsLookup } from 'dns'
import { isIP, type LookupFunction } from 'net'
import zlib from 'zlib'
import { BlockedAddressError, isPrivateAddress } from './netGuard'

/**
 * HTTP client behind host.fetch().
 *
 * Uses Node's http/https instead of Electron's net.fetch so that:
 *  - the local-network guard runs at connect time on the exact IP being dialled (no DNS-rebinding
 *    gap between "check" and "connect"), and
 *  - redirects are followed by hand, re-checking every hop.
 */

export interface SafeFetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  /** Refuse non-public addresses (Settings → Network off). */
  guard: boolean
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  /** Override for tests. */
  isBlocked?: (ip: string) => boolean
}

export interface SafeFetchResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: Buffer
}

export class ResponseTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Response too large (limit ${Math.round(limitBytes / 1024 / 1024)} MB)`)
    this.name = 'ResponseTooLargeError'
  }
}

function guardedLookup(host: string, isBlocked: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, '', 4)
      const list = addresses as { address: string; family: number }[]
      if (!list.length || list.some((a) => isBlocked(a.address))) {
        return callback(new BlockedAddressError(host), '', 4)
      }
      if (options.all) return callback(null, list as never)
      callback(null, list[0].address, list[0].family)
    })
  }
}

function decode(res: http.IncomingMessage): NodeJS.ReadableStream {
  const enc = String(res.headers['content-encoding'] ?? '')
    .toLowerCase()
    .trim()
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip())
  if (enc === 'deflate') return res.pipe(zlib.createInflate())
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress())
  return res
}

function once(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  init: SafeFetchInit,
  signal: AbortSignal
): Promise<{ res: http.IncomingMessage }> {
  const isBlocked = init.isBlocked ?? isPrivateAddress
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (init.guard) {
    const bare = host.replace(/\.$/, '').toLowerCase()
    if (bare === 'localhost' || bare.endsWith('.localhost')) {
      return Promise.reject(new BlockedAddressError(url.hostname))
    }
    // Literal IPs never go through lookup, so check them here.
    if (isIP(host) && isBlocked(host)) return Promise.reject(new BlockedAddressError(url.hostname))
  }
  const mod = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method,
        headers: { 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'Marbles', ...headers },
        lookup: init.guard ? guardedLookup(url.hostname, isBlocked) : undefined,
        signal
      },
      (res) => resolve({ res })
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Headers that may follow a redirect to a different origin. Everything else (Authorization,
 * API-key headers, custom tokens) stays with the origin the app chose to send it to. */
const CROSS_ORIGIN_SAFE = new Set(['accept', 'accept-language', 'user-agent', 'cache-control'])
const BODY_HEADERS = /^content-/i

/** Headers to send on the next hop of a redirect. */
export function redirectHeaders(
  headers: Record<string, string>,
  from: URL,
  to: URL,
  bodyDropped: boolean
): Record<string, string> {
  const crossOrigin = from.origin !== to.origin
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    if (bodyDropped && BODY_HEADERS.test(key)) continue
    if (crossOrigin && !CROSS_ORIGIN_SAFE.has(key) && !(!bodyDropped && key === 'content-type')) {
      continue
    }
    out[k] = v
  }
  return out
}

export async function safeFetch(start: URL, init: SafeFetchInit): Promise<SafeFetchResult> {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, init.timeoutMs)

  try {
    let url = start
    let method = init.method
    let body = init.body
    let headers = init.headers
    for (let hop = 0; ; hop++) {
      const { res } = await once(url, method, headers, body, init, ac.signal)
      const status = res.statusCode ?? 0
      const loc = status >= 300 && status < 400 ? res.headers.location : undefined
      if (loc) {
        res.resume() // discard the redirect body
        if (hop >= init.maxRedirects) {
          throw new Error(`Too many redirects (over ${init.maxRedirects})`)
        }
        const next = new URL(loc, url)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new Error(`Redirect to a non-http URL was refused: ${next.protocol}`)
        }
        // Like browsers: 303, and 301/302 after POST, continue as GET without a body.
        let bodyDropped = false
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          bodyDropped = body !== undefined
          body = undefined
        }
        headers = redirectHeaders(headers, url, next, bodyDropped || body === undefined)
        url = next
        continue
      }

      const declared = Number(res.headers['content-length'])
      if (
        Number.isFinite(declared) &&
        declared > init.maxBytes &&
        !res.headers['content-encoding']
      ) {
        res.destroy()
        throw new ResponseTooLargeError(init.maxBytes)
      }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of decode(res)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        total += buf.length
        if (total > init.maxBytes) {
          res.destroy()
          throw new ResponseTooLargeError(init.maxBytes)
        }
        chunks.push(buf)
      }
      const decoded = !!res.headers['content-encoding']
      const outHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue
        // The body is already decoded, so these would describe bytes the app never sees.
        if (decoded && (k === 'content-encoding' || k === 'content-length')) continue
        outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
      }
      return {
        status,
        statusText: res.statusMessage ?? '',
        headers: outHeaders,
        body: Buffer.concat(chunks)
      }
    }
  } catch (err) {
    if (timedOut)
      throw new Error(`Timed out after ${Math.round(init.timeoutMs / 1000)}s`, { cause: err })
    throw err
  } finally {
    clearTimeout(timer)
  }
}
