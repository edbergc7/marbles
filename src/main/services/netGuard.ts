import { isIP } from 'net'

/**
 * Keeps host.fetch() off the user's own machine and home/office network unless they allow it.
 * Generated apps are written by a model and may read untrusted content, so by default they may
 * only reach the public internet.
 */

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(
      `Blocked: ${host} is on your computer or local network. ` +
        'Allow it in Settings → Network if this app should reach it.'
    )
    this.name = 'BlockedAddressError'
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ip & mask) === (ipv4ToInt(base) & mask)
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + broadcast
]

/** Expands an IPv6 string to 8 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // trailing dotted IPv4 (e.g. ::ffff:1.2.3.4)
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[1])
    s =
      s.slice(0, -v4[1].length) +
      ((n >>> 16) & 0xffff).toString(16) +
      ':' +
      (n & 0xffff).toString(16)
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : []
  const fill = s.includes('::') ? 8 - h.length - t.length : 0
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t]
  if (parts.length !== 8) return null
  const out = parts.map((p) => parseInt(p || '0', 16))
  return out.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : out
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0])
  if (kind === 4) {
    const n = ipv4ToInt(ip)
    return V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits))
  }
  if (kind === 6) {
    const g = ipv6Groups(ip)
    if (!g) return true // unparseable: be safe
    // IPv4-mapped / IPv4-compatible / NAT64-well-known → check the embedded IPv4
    const embedded =
      (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) ||
      (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    if (embedded && !(g[5] === 0 && g[6] === 0 && g[7] <= 1)) {
      const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
      return isPrivateAddress(v4)
    }
    if (g.every((x) => x === 0)) return true // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return true // not an IP at all: treat as unsafe
}

/** Request headers an app may not set (routing, credentials, proxy auth). */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'cookie',
  'cookie2',
  'connection',
  'content-length',
  'accept-encoding', // we decode gzip/deflate/br ourselves
  'transfer-encoding'
])

export function cleanRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase().trim()
    if (FORBIDDEN_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) continue
    out[k] = v
  }
  return out
}

/**
 * True when a URL hostname is plainly local without a DNS lookup: localhost names and
 * loopback/private IP literals. Other names need resolving first (see appFrameNet.ts).
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const bare = h.replace(/^\[|\]$/g, '')
  return isIP(bare) !== 0 && isPrivateAddress(bare)
}
