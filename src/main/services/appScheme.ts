import { protocol } from 'electron'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import { APP_HOST, APP_SCHEME, appRelativePath } from './guard'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

export function appSchemeConfig(): Electron.CustomScheme {
  return {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

/**
 * Serves the built renderer (out/renderer) at app://marbles/. Only files inside that folder are
 * reachable, so the host window can't read other local files the way a file:// page could.
 */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host.toLowerCase() !== APP_HOST) return notFound()
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 })
      }
      const rel = appRelativePath(url.pathname)
      const type = rel ? TYPES[extname(rel).toLowerCase()] : undefined
      if (!rel || !type) return notFound()
      let body: Buffer
      try {
        body = await fs.readFile(join(rendererDir, rel))
      } catch {
        return notFound()
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(body.length),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache'
        }
      })
    } catch (err) {
      console.warn('[app] error', err)
      return new Response('Internal error', { status: 500 })
    }
  })
}
