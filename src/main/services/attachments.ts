import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import {
  ATTACH_IMAGE_TYPES,
  ATTACH_MAX_BYTES,
  ATTACH_MAX_CHARS,
  ATTACH_TEXT_EXTS,
  type AttachKind,
  type StagedAttachment
} from '../../shared/types'
import { docxText, utf8Text, xlsxText } from './docText'

/** Largest copy sent to the AI; the renderer downscales big images well under this. */
const MAX_MODEL_BYTES = 8 * 1024 * 1024
/** Staged files nobody sent (a removed chip, an abandoned request) are dropped after this. */
const MAX_STAGED = 64

interface Staged extends StagedAttachment {
  dir: string
  modelMime: string
}

const TEXT_MIME: Record<string, string> = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown'
}
const DOC_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

const UNSUPPORTED_MSG =
  'Marbles can attach images, PDFs, Word and Excel files, and text files like .txt, .md, .csv and .json.'

function startsWith(data: Uint8Array, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) if (data[i] !== ascii.charCodeAt(i)) return false
  return true
}

/** What the file is, from its bytes and (for documents and text) its extension. */
export function detectKind(
  name: string,
  data: Uint8Array
): { kind: AttachKind; mime: string; ext: string } {
  const img = sniffImage(data)
  if (img) return { kind: 'image', mime: img, ext: ATTACH_IMAGE_TYPES[img] }
  const ext = extname(name).toLowerCase()
  if (ext === '.pdf') {
    if (!startsWith(data, '%PDF-')) throw new Error("That file isn't a valid PDF.")
    return { kind: 'pdf', mime: DOC_MIME[ext], ext }
  }
  if (ext === '.docx' || ext === '.xlsx') {
    if (!startsWith(data, 'PK\x03\x04')) {
      throw new Error(`That file isn't a valid ${ext === '.docx' ? 'Word' : 'Excel'} file.`)
    }
    return { kind: ext === '.docx' ? 'docx' : 'xlsx', mime: DOC_MIME[ext], ext }
  }
  if (ATTACH_TEXT_EXTS.includes(ext)) {
    return { kind: 'text', mime: TEXT_MIME[ext] ?? 'text/plain', ext }
  }
  throw new Error(UNSUPPORTED_MSG)
}

/** The text sent to the AI for a text, Word or Excel file. */
async function documentText(kind: AttachKind, data: Uint8Array): Promise<string> {
  if (kind === 'text') {
    const t = utf8Text(data)
    if (t === null) throw new Error("That file isn't plain text (or isn't UTF-8).")
    return t
  }
  try {
    return kind === 'docx' ? await docxText(data) : await xlsxText(data)
  } catch (err) {
    console.warn('[attachments] could not read document:', err)
    throw new Error(
      `Couldn't read that ${kind === 'docx' ? 'Word' : 'Excel'} file. It may be damaged or password-protected.`,
      { cause: err }
    )
  }
}

/** Checks the file's first bytes, so a renamed file can't pass as an image. */
export function sniffImage(data: Uint8Array): string | null {
  const b = (i: number): number => data[i] ?? -1
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png'
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg'
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif'
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...Array.from(data.subarray(from, to)))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** A safe file name: letters, digits, dot, dash, underscore; `ext` (".png") is put on the end. */
export function cleanFileName(name: string, ext: string): string {
  const base = (
    String(name || '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  return (base || 'file') + ext
}

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  return null
}

/**
 * Files attached to a request, held in <userData>/staging until the build that uses them is
 * saved (then they're copied into the app's assets/ and dropped here). A failed build keeps
 * them, so "Try again" can send them again. Everything here is cleared at startup.
 */
export class AttachmentStore {
  private staged = new Map<string, Staged>()

  constructor(private root: string) {}

  async clear(): Promise<void> {
    this.staged.clear()
    await fs.rm(this.root, { recursive: true, force: true }).catch(() => {})
  }

  async stage(
    name: unknown,
    mime: unknown,
    data: unknown,
    model?: unknown
  ): Promise<StagedAttachment> {
    const bytes = toBytes(data)
    if (!bytes || !bytes.length) throw new Error('That file is empty.')
    if (bytes.length > ATTACH_MAX_BYTES) {
      throw new Error(`That file is too big (max ${ATTACH_MAX_BYTES / 1024 / 1024} MB).`)
    }
    const rawName = typeof name === 'string' ? name : ''
    // Trust the bytes (and, for documents, the extension) over the claimed type: a .png that is
    // really a JPEG still works.
    void mime
    const { kind, mime: real, ext } = detectKind(rawName, bytes)
    let modelBytes = bytes
    let modelMime = real
    let text: string | null = null
    let truncated = false
    if (kind === 'image') {
      if (model && typeof model === 'object') {
        const m = model as { mime?: unknown; data?: unknown }
        const mb = toBytes(m.data)
        const mm = mb ? sniffImage(mb) : null
        if (!mb || !mm || mb.length > MAX_MODEL_BYTES) throw new Error('Invalid image copy.')
        modelBytes = mb
        modelMime = mm
      }
      if (modelBytes.length > MAX_MODEL_BYTES) {
        throw new Error('That image is too big to send to the AI. Try a smaller one.')
      }
    } else if (kind !== 'pdf') {
      text = await documentText(kind, bytes)
      if (!text.trim()) throw new Error('That file has no text in it.')
      if (text.length > ATTACH_MAX_CHARS) {
        text = text.slice(0, ATTACH_MAX_CHARS)
        truncated = true
      }
    }

    if (this.staged.size >= MAX_STAGED) {
      const oldest = this.staged.keys().next().value
      if (oldest) await this.discard(oldest)
    }
    const id = randomUUID()
    const dir = join(this.root, id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'original'), bytes)
    if (modelBytes !== bytes) await fs.writeFile(join(dir, 'model'), modelBytes)
    if (text !== null) await fs.writeFile(join(dir, 'text'), text, 'utf8')
    const item: Staged = {
      id,
      name: cleanFileName(rawName, ext),
      mime: real,
      size: bytes.length,
      kind,
      ...(truncated ? { truncated } : {}),
      dir,
      modelMime
    }
    this.staged.set(id, item)
    return {
      id,
      name: item.name,
      mime: item.mime,
      size: item.size,
      kind,
      ...(truncated ? { truncated } : {})
    }
  }

  async discard(id: unknown): Promise<void> {
    if (typeof id !== 'string') return
    const item = this.staged.get(id)
    if (!item) return
    this.staged.delete(id)
    await fs.rm(item.dir, { recursive: true, force: true }).catch(() => {})
  }

  /** Looks up staged ids; throws if any is unknown (e.g. the app restarted since). */
  resolve(ids: unknown): Staged[] {
    if (ids === undefined) return []
    if (!Array.isArray(ids)) throw new Error('Invalid attachments')
    return ids.map((id) => {
      const item = typeof id === 'string' ? this.staged.get(id) : undefined
      if (!item) throw new Error('An attached file is gone. Remove it and attach it again.')
      return item
    })
  }

  /** The text sent for a text, Word or Excel file. */
  async text(item: Staged): Promise<string> {
    return fs.readFile(join(item.dir, 'text'), 'utf8')
  }

  /** The copy for the AI (an image, or a PDF as it is), as a data URL. */
  async modelDataUrl(item: Staged): Promise<string> {
    let buf: Buffer
    try {
      buf = await fs.readFile(join(item.dir, 'model'))
    } catch {
      buf = await fs.readFile(join(item.dir, 'original'))
    }
    return `data:${item.modelMime};base64,${buf.toString('base64')}`
  }

  originalPath(item: Staged): string {
    return join(item.dir, 'original')
  }
}

const ASSET_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ATTACH_IMAGE_TYPES).map(([m, e]) => [e, m])),
  '.jpeg': 'image/jpeg',
  ...TEXT_MIME,
  ...DOC_MIME
}

/** MIME type of an app file, from its extension. */
export function assetMime(name: string): string {
  const ext = extname(name).toLowerCase()
  return (
    ASSET_MIME[ext] ?? (ATTACH_TEXT_EXTS.includes(ext) ? 'text/plain' : 'application/octet-stream')
  )
}

/** Width and height of a PNG, JPEG, GIF or WebP, from its header; null if it can't tell. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number): number => (b[i] << 8) | b[i + 1]
  const u16le = (i: number): number => b[i] | (b[i + 1] << 8)
  const u24le = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const u32be = (i: number): number =>
    ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  const type = sniffImage(b)
  if (type === 'image/png' && b.length >= 24) return { width: u32be(16), height: u32be(20) }
  if (type === 'image/gif' && b.length >= 10) return { width: u16le(6), height: u16le(8) }
  if (type === 'image/webp' && b.length >= 30) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 }
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (type === 'image/jpeg') {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      const len = u16be(i + 2)
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), hold the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16be(i + 7), height: u16be(i + 5) }
      }
      i += 2 + len
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces references to one app file, `assets/<name>` or `./assets/<name>`, in attributes, CSS
 * url() and JS string literals. A longer name that only starts with it is left alone.
 */
export function replaceAssetRefs(html: string, name: string, replacement: string): string {
  const ref = new RegExp(`(["'\`(=\\s])(?:\\./)?assets/${escapeRegExp(name)}(?=["'\`)\\s?#])`, 'g')
  return html.replace(ref, (_m, lead: string) => lead + replacement)
}
