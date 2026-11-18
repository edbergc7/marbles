import type { LibraryService } from './library'
import type { NotifierService } from './notifier'
import { BlockedAddressError, cleanRequestHeaders } from './netGuard'
import { ResponseTooLargeError, safeFetch } from './safeFetch'
import { assetMime, imageSize } from './attachments'
import { utf8Text } from './docText'
import type {
  AiCallOptions,
  AppAssetInfo,
  BridgeFetchInit,
  BridgeFetchResult,
  BridgeMethod,
  SavedAiResult
} from '../../shared/types'

const ID_RE = /^[a-z0-9-]+$/
const MAX_KEY_LEN = 200
const MAX_STORAGE_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_FETCHES_PER_APP = 6
const MAX_QUEUED_FETCHES_PER_APP = 100

/** Backs host.ai(); see hostAi.ts. */
export type AiHandler = (appId: string, opts: AiCallOptions) => Promise<string>

export class BridgeService {
  private storageChains = new Map<string, Promise<unknown>>()
  private fetchSlots = new Map<string, { running: number; waiting: (() => void)[] }>()
  /** host.ai({ saveAs }) calls still running: they write to storage when they finish. */
  private savedAiJobs = new Set<Promise<unknown>>()

  constructor(
    private library: LibraryService,
    /** Settings → Network: let apps reach localhost / the local network. */
    private allowLocalNetwork: () => Promise<boolean>,
    private aiHandler: AiHandler,
    private notifier: NotifierService
  ) {}

  /**
   * Resolves when every in-flight serialized storage op has finished, including the result a
   * host.ai({ saveAs }) call still has to write. Never rejects.
   */
  async settle(): Promise<void> {
    await Promise.all([...this.savedAiJobs].map((p) => p.catch(() => {})))
    await Promise.all([...this.storageChains.values()].map((p) => p.catch(() => {})))
  }

  async call(appId: string, method: BridgeMethod, args: unknown[]): Promise<unknown> {
    if (typeof appId !== 'string' || !ID_RE.test(appId) || appId.length > 80) {
      throw new Error('Invalid app id')
    }
    if (!Array.isArray(args)) args = []
    switch (method) {
      case 'storage.get':
        return this.storageGet(appId, args[0])
      case 'storage.set':
        return this.storageSet(appId, args[0], args[1])
      case 'storage.remove':
        return this.storageRemove(appId, args[0])
      case 'storage.keys':
        await this.requireApp(appId)
        return Object.keys(await this.library.readStorage(appId))
      case 'ai':
        await this.requireApp(appId)
        return this.ai(appId, args[0] as AiCallOptions)
      case 'fetch':
        await this.requireApp(appId)
        return this.limitFetch(appId, () =>
          this.fetch(args[0], args[1] as BridgeFetchInit | undefined)
        )
      case 'notify':
        await this.requireApp(appId)
        return this.notifier.schedule(appId, args[0])
      case 'notify.cancel':
        return this.notifier.cancel(appId, args[0])
      case 'notify.list':
        return this.notifier.list(appId)
      case 'assets.list':
        await this.requireApp(appId)
        return this.listAssets(appId)
      case 'assets.text':
      case 'assets.base64': {
        await this.requireApp(appId)
        const buf = await this.readAsset(appId, args[0])
        if (method === 'assets.base64') return buf.toString('base64')
        const text = utf8Text(buf)
        if (text === null) {
          throw new Error(
            `host.assets.text: ${String(args[0])} isn't text. Use host.assets.base64.`
          )
        }
        return text
      }
      default:
        throw new Error(`Unknown bridge method: ${String(method)}`)
    }
  }

  // ---------- assets ----------

  async listAssets(appId: string): Promise<AppAssetInfo[]> {
    const out: AppAssetInfo[] = []
    for (const f of await this.library.listAssets(appId)) {
      const info: AppAssetInfo = { name: f.name, mime: assetMime(f.name), size: f.size }
      if (info.mime.startsWith('image/')) {
        const dims = await this.library
          .readAsset(appId, f.name)
          .then(imageSize)
          .catch(() => null)
        if (dims) Object.assign(info, dims)
      }
      out.push(info)
    }
    return out
  }

  private async readAsset(appId: string, name: unknown): Promise<Buffer> {
    if (typeof name !== 'string' || !name) throw new Error('host.assets: name must be a string')
    // Accept "assets/x.csv" as well as "x.csv".
    const bare = name.replace(/^\.?\/?assets\//, '')
    try {
      return await this.library.readAsset(appId, bare)
    } catch {
      throw new Error(`host.assets: this app has no file called ${bare}`)
    }
  }

  // ---------- storage ----------

  private checkKey(key: unknown): string {
    if (typeof key !== 'string' || !key) throw new Error('Storage key must be a non-empty string')
    if (key.length > MAX_KEY_LEN)
      throw new Error(`Storage key is too long (max ${MAX_KEY_LEN} characters)`)
    return key
  }

  /** Serializes read-modify-write cycles per app. */
  private serialize<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.storageChains.get(appId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.storageChains.set(appId, tail)
    void tail.then(() => {
      if (this.storageChains.get(appId) === tail) this.storageChains.delete(appId)
    })
    return next
  }

  private async requireApp(appId: string): Promise<void> {
    if (!(await this.library.get(appId))) throw new Error('App not found')
  }

  private async storageGet(appId: string, rawKey: unknown): Promise<unknown> {
    await this.requireApp(appId)
    const key = this.checkKey(rawKey)
    const data = await this.library.readStorage(appId)
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined
  }

  /**
   * Registers the serialization slot synchronously (validation moved inside), so a relocation's
   * settle() sees a set that was already accepted by the IPC gate.
   */
  private storageSet(appId: string, rawKey: unknown, value: unknown): Promise<void> {
    return this.serialize(appId, async () => {
      const key = this.checkKey(rawKey)
      if (value === undefined) throw new Error('Storage value must be JSON-serializable')
      await this.requireApp(appId)
      const data = await this.library.readStorage(appId)
      // Own-property safe assignment (keys like "__proto__" stay plain data).
      const next: Record<string, unknown> = Object.create(null)
      Object.assign(next, data)
      next[key] = value
      const json = JSON.stringify({ ...next }, null, 2)
      if (Buffer.byteLength(json, 'utf8') > MAX_STORAGE_BYTES) {
        throw new Error('Storage is full (5 MB limit per app). Remove some data first.')
      }
      await this.library.writeStorage(appId, { ...next })
    })
  }

  private storageRemove(appId: string, rawKey: unknown): Promise<void> {
    return this.serialize(appId, async () => {
      const key = this.checkKey(rawKey)
      await this.requireApp(appId)
      const data = await this.library.readStorage(appId)
      if (!Object.prototype.hasOwnProperty.call(data, key)) return
      delete data[key]
      await this.library.writeStorage(appId, data)
    })
  }

  // ---------- ai ----------

  private notifyQuietly(appId: string, message: string): void {
    try {
      this.notifier.schedule(appId, { message })
    } catch {
      /* over the pending limit: the saved result is still there */
    }
  }

  private async ai(appId: string, opts: AiCallOptions): Promise<string> {
    const o = opts && typeof opts === 'object' ? opts : {}
    if (o.notify !== undefined && o.saveAs === undefined) {
      throw new Error('host.ai: notify only works together with saveAs')
    }
    if (o.saveAs === undefined) return this.aiHandler(appId, o)
    // The app's page is unloaded when the person switches apps, but this call keeps going in
    // main. Recording it in storage lets the app pick the answer up when it opens again.
    const key = this.checkKey(o.saveAs)
    const notify = typeof o.notify === 'string' && o.notify.trim() ? o.notify : null
    const startedAt = Date.now()
    const save = (v: SavedAiResult): Promise<void> => this.storageSet(appId, key, v).catch(() => {}) // app deleted or storage full
    await this.storageSet(appId, key, { status: 'running', startedAt })
    const job = (async () => {
      try {
        const text = await this.aiHandler(appId, o)
        await save({ status: 'done', text, startedAt, finishedAt: Date.now() })
        if (notify) this.notifyQuietly(appId, notify)
        return text
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        await save({ status: 'error', error, startedAt, finishedAt: Date.now() })
        if (notify) this.notifyQuietly(appId, `${notify} (failed)`)
        throw err
      }
    })()
    this.savedAiJobs.add(job)
    void job.catch(() => {}).finally(() => this.savedAiJobs.delete(job))
    return job
  }

  // ---------- fetch ----------

  /**
   * Caps parallel host.fetch() calls per app (main-process memory, and use as a request relay).
   * Extra calls wait in a bounded queue, so ordinary Promise.all() code keeps working.
   */
  private async limitFetch<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    let slot = this.fetchSlots.get(appId)
    if (!slot) {
      slot = { running: 0, waiting: [] }
      this.fetchSlots.set(appId, slot)
    }
    if (slot.running >= MAX_FETCHES_PER_APP) {
      if (slot.waiting.length >= MAX_QUEUED_FETCHES_PER_APP) {
        throw new Error('Too many requests queued. Wait for some to finish.')
      }
      await new Promise<void>((resolve) => slot.waiting.push(resolve))
    } else {
      slot.running++
    }
    try {
      return await fn()
    } finally {
      // Hand our slot straight to the next waiter, or free it.
      const next = slot.waiting.shift()
      if (next) next()
      else if (--slot.running === 0) this.fetchSlots.delete(appId)
    }
  }

  private async fetch(rawUrl: unknown, init?: BridgeFetchInit): Promise<BridgeFetchResult> {
    if (typeof rawUrl !== 'string') throw new Error('host.fetch: url must be a string')
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error(`Invalid URL: ${rawUrl}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only http and https URLs are allowed')
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!/^[A-Z]+$/.test(method)) throw new Error(`Invalid method: ${method}`)
    const rawHeaders: Record<string, string> = {}
    if (init?.headers && typeof init.headers === 'object') {
      for (const [k, v] of Object.entries(init.headers)) {
        if (typeof v === 'string') rawHeaders[k] = v
      }
    }
    const headers = cleanRequestHeaders(rawHeaders)
    const guard = !(await this.allowLocalNetwork())
    const body =
      typeof init?.body === 'string' && method !== 'GET' && method !== 'HEAD'
        ? init.body
        : undefined
    const as = init?.as === 'base64' ? 'base64' : 'text'

    try {
      const res = await safeFetch(url, {
        method,
        headers,
        body,
        guard,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        maxRedirects: MAX_REDIRECTS
      })
      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: as === 'base64' ? res.body.toString('base64') : res.body.toString('utf8')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const passThrough =
        err instanceof BlockedAddressError ||
        err instanceof ResponseTooLargeError ||
        /^(Timed out|Too many redirects|Redirect to a non-http)/.test(msg)
      if (passThrough) throw new Error(msg, { cause: err })
      throw new Error(`Network error: ${msg}`, { cause: err })
    }
  }
}
