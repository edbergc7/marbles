import { watch, promises as fs, type FSWatcher } from 'fs'
import { join, sep } from 'path'

const DEBOUNCE_MS = 150
const POLL_MS = 2000

/**
 * Watches <library>/apps and reports affected app ids (debounced).
 * Uses recursive fs.watch; falls back to a 2s poll if that is unavailable.
 */
export class LibraryWatcher {
  private fsw: FSWatcher | null = null
  private rootw: FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private timer: NodeJS.Timeout | null = null
  private pending = new Set<string>()
  private generation = 0

  constructor(
    private getLibraryPath: () => Promise<string>,
    private onIds: (ids: string[]) => void
  ) {}

  async start(): Promise<void> {
    this.stop()
    const gen = ++this.generation
    let apps: string
    try {
      apps = join(await this.getLibraryPath(), 'apps')
      await fs.mkdir(apps, { recursive: true })
    } catch (err) {
      console.warn('[watcher] cannot prepare library dir', err)
      return
    }
    if (gen !== this.generation) return
    this.watchLayout(join(apps, '..'))
    try {
      const w = watch(apps, { recursive: true }, (_event, filename) => {
        const name = filename ? String(filename) : ''
        const id = name.split(sep)[0].split('/')[0]
        this.push(id ? [id] : [])
      })
      w.on('error', (err) => {
        console.warn('[watcher] fs.watch error; switching to polling', err)
        w.close()
        if (this.fsw === w) this.fsw = null
        if (gen === this.generation) this.startPolling(apps, gen)
      })
      this.fsw = w
    } catch (err) {
      console.warn('[watcher] recursive watch unavailable; polling', err)
      this.startPolling(apps, gen)
    }
  }

  /** library.json (folders, pins) sits at the library root, outside apps/. */
  private watchLayout(root: string): void {
    try {
      const w = watch(root, (_event, filename) => {
        if (String(filename ?? '') === 'library.json') this.push([])
      })
      w.on('error', () => {
        w.close()
        if (this.rootw === w) this.rootw = null
      })
      this.rootw = w
    } catch (err) {
      console.warn('[watcher] cannot watch library root', err)
    }
  }

  stop(): void {
    this.generation++
    this.fsw?.close()
    this.fsw = null
    this.rootw?.close()
    this.rootw = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private push(ids: string[]): void {
    if (!ids.length) this.pending.add('')
    for (const id of ids) this.pending.add(id)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const all = this.pending.has('')
      const ids = [...this.pending].filter(Boolean)
      this.pending.clear()
      this.onIds(all ? [] : ids)
    }, DEBOUNCE_MS)
  }

  private async snapshot(apps: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    let names: string[]
    try {
      names = (await fs.readdir(apps, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return out
    }
    for (const name of names) {
      try {
        const files = await fs.readdir(join(apps, name))
        const parts: string[] = []
        for (const f of files) {
          if (f.endsWith('.tmp')) continue
          const st = await fs.stat(join(apps, name, f)).catch(() => null)
          if (st) parts.push(`${f}:${st.mtimeMs}:${st.size}`)
        }
        out.set(name, parts.sort().join('|'))
      } catch {
        // folder vanished mid-scan
      }
    }
    return out
  }

  private startPolling(apps: string, gen: number): void {
    let last: Map<string, string> | null = null
    const tick = async (): Promise<void> => {
      if (gen !== this.generation) return
      const snap = await this.snapshot(apps)
      if (last) {
        const changed: string[] = []
        for (const [id, sig] of snap) if (last.get(id) !== sig) changed.push(id)
        for (const id of last.keys()) if (!snap.has(id)) changed.push(id)
        if (changed.length) this.push(changed)
      }
      last = snap
    }
    void tick()
    this.pollTimer = setInterval(() => void tick(), POLL_MS)
  }
}
