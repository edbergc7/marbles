import type { AiCallOptions } from '../../shared/types'
import type { LLMService, ChatMsg, ContentPart } from './llm'
import { sniffImage } from './attachments'
import type { SettingsService } from './settings'

const MAX_CONCURRENT_PER_APP = 4
/** Rolling cap per app, so a runaway loop can't drain the user's credits or plan quota. */
const MAX_PER_MINUTE = 30
const WINDOW_MS = 60_000
const TIMEOUT_MS = 120_000
const MAX_TOKENS = 4000
const ROLES = new Set(['user', 'assistant', 'system'])
const MAX_IMAGES = 4
const MAX_FILES = 2
/** All images and PDFs in one call, decoded. */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

/** Decodes a data: URL, or null if it isn't one. */
function decodeDataUrl(v: unknown): { mime: string; bytes: Buffer } | null {
  if (typeof v !== 'string') return null
  const m = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(v)
  if (!m) return null
  return { mime: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') }
}

/**
 * Checks the images and PDFs an app sends and turns them into message parts. The bytes are
 * checked, not the claimed type, so an app can't pass something else off as an image.
 */
export function mediaParts(o: { images?: unknown; files?: unknown }): ContentPart[] {
  const parts: ContentPart[] = []
  let total = 0
  const images = o.images === undefined ? [] : o.images
  const files = o.files === undefined ? [] : o.files
  if (!Array.isArray(images)) throw new Error('host.ai: images must be an array')
  if (!Array.isArray(files)) throw new Error('host.ai: files must be an array')
  if (images.length > MAX_IMAGES) throw new Error(`host.ai: at most ${MAX_IMAGES} images per call`)
  if (files.length > MAX_FILES) throw new Error(`host.ai: at most ${MAX_FILES} PDFs per call`)
  for (const [i, img] of images.entries()) {
    const d = decodeDataUrl(img)
    const real = d ? sniffImage(d.bytes) : null
    if (!d || !real) {
      throw new Error(`host.ai: images[${i}] isn't a PNG, JPEG, WebP or GIF image`)
    }
    total += d.bytes.length
    parts.push({ type: 'image', dataUrl: `data:${real};base64,${d.bytes.toString('base64')}` })
  }
  for (const [i, f] of files.entries()) {
    const raw = f && typeof f === 'object' ? (f as { name?: unknown; data?: unknown }) : null
    const d = decodeDataUrl(raw?.data)
    if (!d || d.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error(`host.ai: files[${i}] isn't a PDF`)
    }
    total += d.bytes.length
    const name =
      typeof raw?.name === 'string' && /^[\w .()-]{1,100}$/.test(raw.name)
        ? raw.name
        : 'document.pdf'
    parts.push({
      type: 'file',
      name,
      dataUrl: `data:application/pdf;base64,${d.bytes.toString('base64')}`
    })
  }
  if (total > MAX_MEDIA_BYTES) {
    throw new Error(
      `host.ai: images and PDFs together must be under ${MAX_MEDIA_BYTES / 1024 / 1024} MB`
    )
  }
  return parts
}

/**
 * Builds the handler behind host.ai(): Utility model by default. opts.model is honoured
 * only when it exactly matches the Utility or Naming model (never the Builder model, which
 * is usually the most expensive).
 */
export function createAiHandler(
  llm: LLMService,
  settings: SettingsService
): (appId: string, opts: AiCallOptions) => Promise<string> {
  const inFlight = new Map<string, number>()
  const recent = new Map<string, number[]>()

  return async (appId, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const messages: ChatMsg[] = []
    if (typeof o.system === 'string' && o.system)
      messages.push({ role: 'system', content: o.system })
    if (Array.isArray(o.messages) && o.messages.length) {
      for (const m of o.messages) {
        if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') {
          throw new Error('host.ai: messages must be { role, content } objects')
        }
        messages.push({ role: m.role, content: m.content })
      }
    } else if (typeof o.prompt === 'string' && o.prompt) {
      messages.push({ role: 'user', content: o.prompt })
    }
    if (!messages.some((m) => m.role !== 'system')) {
      throw new Error('host.ai needs a prompt or messages')
    }
    // Images and PDFs go with the last user message.
    const media = mediaParts(o)
    if (media.length) {
      const last = messages.map((m) => m.role).lastIndexOf('user')
      if (last === -1) throw new Error('host.ai: images and files need a user message to go with')
      const text = messages[last].content as string
      messages[last] = { role: 'user', content: [{ type: 'text', text }, ...media] }
    }
    const hasImages = media.some((p) => p.type === 'image')

    const n = inFlight.get(appId) ?? 0
    if (n >= MAX_CONCURRENT_PER_APP) {
      throw new Error(
        `Too many AI requests at once (max ${MAX_CONCURRENT_PER_APP}). Wait for one to finish.`
      )
    }
    const now = Date.now()
    const times = (recent.get(appId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (times.length >= MAX_PER_MINUTE) {
      recent.set(appId, times)
      throw new Error('This app is asking the AI too often. Try again in a minute.')
    }
    times.push(now)
    recent.set(appId, times)
    inFlight.set(appId, n + 1)
    try {
      const cfg = await settings.get()
      // Generated apps are untrusted: only let them pick a model the user already configured.
      const allowed = [cfg.utilityModel, cfg.namingModel]
      let model =
        typeof o.model === 'string' && allowed.includes(o.model) ? o.model : cfg.utilityModel
      if (hasImages && !(await llm.supportsImages(model))) {
        // Use whichever of the two can see images.
        const other = allowed.find((m) => m && m !== model)
        if (other && (await llm.supportsImages(other))) model = other
        else {
          throw new Error(
            "host.ai: the AI models set up in Marbles can't see images. Pick one that can in Marbles' Settings."
          )
        }
      }
      return await llm.complete({
        model,
        messages,
        json: o.json === true,
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS
      })
    } finally {
      const left = (inFlight.get(appId) ?? 1) - 1
      if (left <= 0) inFlight.delete(appId)
      else inFlight.set(appId, left)
    }
  }
}
