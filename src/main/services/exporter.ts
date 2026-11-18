import { app, BrowserWindow, dialog, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import designCss from '../../../design/design.css?raw'
import exportShimJs from '../appframe/export-shim.js?raw'
import sliderShimJs from '../appframe/slider-shim.js?raw'
import interFontPath from '../../../resources/fonts/inter-latin-wght-normal.woff2?asset'
import { scriptTag, styleTags, wrapAppDocument } from './appDocument'
import { writeAtomic } from './library'
import type { LibraryService } from './library'
import type { SettingsService } from './settings'
import type { ExportResult } from '../../shared/types'
import { assetMime, imageSize, replaceAssetRefs } from './attachments'
import { utf8Text } from './docText'

interface StandaloneOptions {
  css: string
  accent: string
  /** 'light' | 'dark' bakes the theme in; 'system' (or omitted) follows prefers-color-scheme. */
  theme?: string
  title: string
  /** data: URL of the Inter variable woff2. Omit to skip the @font-face. */
  fontDataUrl?: string
  /** Contents of export-shim.js (with the __APP_ID__ placeholder). */
  shim: string
  appId: string
  /** The app's files. Those the HTML mentions are embedded; the rest are left out. */
  assets?: ExportAsset[]
}

interface ExportAsset {
  name: string
  mime: string
  data: Buffer
  width?: number
  height?: number
  /** UTF-8 text files: their text, for host.assets.text(). */
  text?: string
}

/**
 * Inlines the app's files: `assets/<name>` references in attributes and CSS become data: URLs,
 * and files the HTML still names afterwards (host.assets.text('data.csv')) go into the shim's
 * embedded list. Files the HTML never mentions are left out of the export.
 */
export function embedAssets(
  rawHtml: string,
  assets: ExportAsset[]
): { html: string; embedded: Record<string, unknown>[] } {
  let html = rawHtml
  const embedded: Record<string, unknown>[] = []
  for (const a of assets) {
    if (!html.includes(a.name)) continue
    html = replaceAssetRefs(html, a.name, `data:${a.mime};base64,${a.data.toString('base64')}`)
    if (html.includes(a.name)) {
      embedded.push({
        name: a.name,
        mime: a.mime,
        size: a.data.length,
        ...(a.width ? { width: a.width, height: a.height } : {}),
        base64: a.data.toString('base64'),
        ...(a.text !== undefined ? { text: a.text } : {})
      })
    }
  }
  return { html, embedded }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Pure: wraps generated HTML into a self-contained document that works from file://. */
export function buildStandaloneDocument(source: string, opts: StandaloneOptions): string {
  const safeId = opts.appId.replace(/[^A-Za-z0-9_.-]/g, '')
  const { html: rawHtml, embedded } = embedAssets(source, opts.assets ?? [])
  // "<" escaped so no file content can end the script or open an HTML comment in it.
  const assetsJson = JSON.stringify(embedded).replace(/</g, '\\u003c')
  const fontCss = opts.fontDataUrl
    ? '<style>@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;' +
      `font-weight:100 900;src:url("${opts.fontDataUrl}") format("woff2-variations")}</style>`
    : ''
  const hasTitle = /<title[\s>]/i.test(rawHtml)
  const head =
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    (hasTitle ? '' : `<title>${escapeHtml(opts.title)}</title>`) +
    fontCss +
    styleTags(opts.css, opts.accent) +
    scriptTag(opts.shim.replaceAll('__APP_ID__', safeId).replace('__ASSETS__', () => assetsJson))
  const theme = opts.theme === 'light' || opts.theme === 'dark' ? opts.theme : null
  return wrapAppDocument(rawHtml, head, theme)
}

function defaultFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return `${cleaned || 'app'}.html`
}

export class ExporterService {
  private fontCache: Buffer | null = null
  /** Files saved through the export dialog in this session: the only ones reveal() will show. */
  private exported = new Set<string>()

  constructor(private deps: { library: LibraryService; settings: SettingsService }) {}

  /** Builds the document and writes it atomically. Throws if the app/version doesn't exist. */
  async exportToFile(
    appId: string,
    version: number | undefined,
    filePath: string
  ): Promise<ExportResult> {
    return this.write(filePath, (await this.build(appId, version)).html)
  }

  private async write(path: string, html: string): Promise<ExportResult> {
    await writeAtomic(path, html)
    return { path, bytes: Buffer.byteLength(html, 'utf8') }
  }

  private async build(appId: string, version?: number): Promise<{ html: string; name: string }> {
    const meta = await this.deps.library.get(appId)
    if (!meta) throw new Error('App not found')
    const v = version ?? meta.currentVersion
    if (!Number.isInteger(v) || v < 1 || !meta.versions.some((x) => x.n === v)) {
      throw new Error(`Version ${version ?? v} doesn't exist`)
    }
    const raw = await this.deps.library.readVersion(appId, v)
    const s = await this.deps.settings.get()
    this.fontCache ??= await fs.readFile(interFontPath)
    const html = buildStandaloneDocument(raw, {
      css: designCss,
      accent: s.accent,
      theme: s.theme,
      title: meta.name,
      fontDataUrl: `data:font/woff2;base64,${this.fontCache.toString('base64')}`,
      shim: exportShimJs + '\n' + sliderShimJs,
      appId,
      assets: await this.assetsOf(appId)
    })
    return { html, name: meta.name }
  }

  private async assetsOf(appId: string): Promise<ExportAsset[]> {
    const out: ExportAsset[] = []
    for (const f of await this.deps.library.listAssets(appId)) {
      const data = await this.deps.library.readAsset(appId, f.name).catch(() => null)
      if (!data) continue
      const mime = assetMime(f.name)
      const text = mime.startsWith('image/') ? null : utf8Text(data)
      out.push({
        name: f.name,
        mime,
        data,
        ...(imageSize(data) ?? {}),
        ...(text !== null && !/\.(pdf|docx|xlsx)$/i.test(f.name) ? { text } : {})
      })
    }
    return out
  }

  async saveHtml(
    appId: string,
    version: number | undefined,
    win: BrowserWindow | null
  ): Promise<ExportResult | null> {
    const built = await this.build(appId, version) // fail before showing a dialog
    const opts = {
      title: 'Export as HTML',
      defaultPath: join(app.getPath('downloads'), defaultFileName(built.name)),
      filters: [{ name: 'HTML', extensions: ['html'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const out = await this.write(res.filePath, built.html)
    this.exported.add(out.path)
    return out
  }

  /** Shows a file this session exported, or the library folder. Any other path is refused. */
  async reveal(path: string): Promise<void> {
    if (typeof path !== 'string') return
    const library = (await this.deps.settings.get()).libraryPath
    if (path !== library && !this.exported.has(path)) return
    shell.showItemInFolder(path)
  }
}
