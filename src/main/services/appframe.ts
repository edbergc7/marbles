import { nativeTheme, protocol } from 'electron'
import { createHmac, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import designCss from '../../../design/design.css?raw'
import shimJs from '../appframe/shim.js?raw'
import sliderShimJs from '../appframe/slider-shim.js?raw'
import interFontPath from '../../../resources/fonts/inter-latin-wght-normal.woff2?asset'
import { scriptTag, styleTags, wrapAppDocument } from './appDocument'
import { appSchemeConfig } from './appScheme'
import { replaceAssetRefs } from './attachments'
import { registerCdnScheme, rewriteCdnUrls } from './cdnCache'
import type { LibraryService } from './library'
import type { SettingsService } from './settings'

const APPFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' cdn:",
  "style-src 'unsafe-inline' cdn:",
  // appframe: is for the app's own files (assets/…), checked per request in serveAsset.
  'img-src https: data: blob: cdn: appframe:',
  'font-src data: cdn: appframe:',
  'media-src blob: data: appframe:',
  'connect-src cdn:',
  'worker-src blob:',
  "frame-src 'none'",
  "form-action 'none'",
  // Same flags as the <iframe sandbox> in AppFrame.svelte. Repeated here so an app page
  // keeps its opaque origin even if it is ever loaded some other way.
  'sandbox allow-scripts allow-forms allow-modals allow-downloads'
].join('; ')

const FONT_FACE_CSS =
  '@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;' +
  'src:url("appframe://assets/inter-latin-wght-normal.woff2") format("woff2-variations")}'

const SHIM_TAG = scriptTag(shimJs + '\n' + sliderShimJs)

interface AppDocumentOptions {
  theme: 'light' | 'dark'
  accent: string
  css: string
}

/** Wraps (or patches) the generated HTML so it gets design.css, accent and theme. */
function buildAppDocument(rawHtml: string, opts: AppDocumentOptions): string {
  const head =
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${FONT_FACE_CSS}</style>` +
    styleTags(opts.css, opts.accent) +
    SHIM_TAG
  return wrapAppDocument(rewriteCdnUrls(rawHtml), head, opts.theme)
}

/** Registers every custom scheme in one call (must run before app is ready). */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'appframe',
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: true }
    },
    registerCdnScheme(),
    appSchemeConfig()
  ])
}

let fontCache: Buffer | null = null

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

const ASSET_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** Per-run key for asset tokens; a new one each start, so tokens never outlive the session. */
const ASSET_KEY = randomBytes(32)

/**
 * The secret path part that lets app `id`'s own frame load its files. Its page is served with
 * its `assets/<name>` references rewritten to include this, and no app learns another's.
 */
function assetToken(id: string): string {
  return createHmac('sha256', ASSET_KEY).update(id).digest('hex').slice(0, 32)
}

/** Points the app's `assets/<name>` references at its tokened asset URLs. */
function rewriteAssetRefs(html: string, id: string, names: string[]): string {
  let out = html
  const base = `appframe://app/${encodeURIComponent(id)}/assets/${assetToken(id)}/`
  for (const name of names) {
    if (out.includes(name)) out = replaceAssetRefs(out, name, base + encodeURIComponent(name))
  }
  return out
}

/**
 * An app's attached file. Two ways in: the host window (chat thumbnails, Files list), told apart
 * by its referrer, and the app's own frame, which carries the app's token (app frames send no
 * referrer). Anything else is refused.
 */
async function serveAsset(
  library: LibraryService,
  rawId: string,
  rawName: string,
  token: string | null,
  referrer: string,
  isHostUrl: (url: string) => boolean
): Promise<Response> {
  let id: string
  let name: string
  try {
    id = decodeURIComponent(rawId)
    name = decodeURIComponent(rawName)
  } catch {
    return plain(404, 'Not found')
  }
  const allowed = token === null ? !!referrer && isHostUrl(referrer) : token === assetToken(id)
  if (!allowed) return plain(403, 'Forbidden')
  const type = ASSET_TYPES[name.split('.').pop()?.toLowerCase() ?? '']
  if (!type) return plain(404, 'Not found')
  let body: Buffer
  try {
    body = await library.readAsset(id, name)
  } catch {
    return plain(404, 'Not found')
  }
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      // Lets an app draw its own image on a canvas (<img crossorigin>) and still read it back.
      // The check above already decided who may load it.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
  })
}

export function registerAppFrameProtocol(deps: {
  library: LibraryService
  settings: SettingsService
  /** The host window's own page: it may read every app's files (chat thumbnails). */
  isHostUrl: (url: string) => boolean
}): void {
  protocol.handle('appframe', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'assets') {
        if (url.pathname !== '/inter-latin-wght-normal.woff2') return plain(404, 'Not found')
        fontCache ??= await fs.readFile(interFontPath)
        return new Response(new Uint8Array(fontCache), {
          status: 200,
          headers: {
            'Content-Type': 'font/woff2',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000'
          }
        })
      }
      const parts = url.pathname.split('/').filter(Boolean)
      if (
        url.hostname === 'app' &&
        parts[1] === 'assets' &&
        (parts.length === 3 || parts.length === 4)
      ) {
        const token = parts.length === 4 ? parts[2] : null
        return await serveAsset(
          deps.library,
          parts[0],
          parts[parts.length - 1],
          token,
          request.referrer,
          deps.isHostUrl
        )
      }
      if (url.hostname !== 'app' || parts.length !== 2) return plain(404, 'Not found')
      const id = decodeURIComponent(parts[0])
      const n = Number(parts[1])
      if (!Number.isInteger(n) || n < 1) return plain(404, 'Not found')

      let html: string
      try {
        html = await deps.library.readVersion(id, n)
      } catch {
        return plain(404, 'Not found')
      }
      const s = await deps.settings.get()
      const theme =
        s.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : s.theme
      const names = (await deps.library.listAssets(id).catch(() => [])).map((f) => f.name)
      const body = buildAppDocument(rewriteAssetRefs(html, id, names), {
        theme,
        accent: s.accent,
        css: designCss
      })
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': APPFRAME_CSP,
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      console.warn('[appframe] error', err)
      return plain(500, 'Internal error')
    }
  })
}
