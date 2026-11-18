import { constants as fsConstants, promises as fs } from 'fs'
import { extname, join } from 'path'
import { randomInt } from 'crypto'
import type {
  AppMeta,
  ChatMessage,
  CreateAppInput,
  LibraryFolder,
  LibraryLayout,
  TrashedApp,
  VersionInfo
} from '../../shared/types'

const ID_RE = /^[a-z0-9-]+$/
const VERSION_FILE_RE = /^v(\d+)\.html$/
const FOLDER_ID_RE = /^f-[a-z0-9]{4,12}$/
/** An asset file name: no path parts, no leading dot. */
const ASSET_NAME_RE = /^[\w-][\w.-]{0,99}$/
const LAYOUT_LOCK = ':layout'
/** Lock key for whole-library mutations that don't belong to one app. */
const GLOBAL_LOCK = ':global'

/**
 * Version of the library's on-disk layout, stored as `format` in library.json. A missing file
 * or field means 1. Raise it when a change would make an older Marbles damage what a newer
 * one wrote: older builds then open the library read-only instead of writing to it.
 */
export const LIBRARY_FORMAT = 1

export const LIBRARY_TOO_NEW_MSG =
  'This library was saved by a newer version of Marbles. Update Marbles to make changes.'

export class LibraryTooNewError extends Error {
  constructor() {
    super(LIBRARY_TOO_NEW_MSG)
    this.name = 'LibraryTooNewError'
  }
}

/** The `format` of raw library.json content; anything unusable counts as 1. */
function libraryFormatOf(raw: unknown): number {
  const f = raw && typeof raw === 'object' ? (raw as { format?: unknown }).format : undefined
  return typeof f === 'number' && Number.isInteger(f) && f >= 1 ? f : 1
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s || 'app'
}

function rand4(): string {
  let out = ''
  for (let i = 0; i < 4; i++) out += randomInt(36).toString(36)
  return out
}

export function makeId(name: string): string {
  return `${slugify(name)}-${rand4()}`
}

function prettify(folder: string): string {
  const words = folder
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return 'Untitled'
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function writeAtomic(
  file: string,
  data: string,
  opts: { mode?: number } = {}
): Promise<void> {
  const tmp = `${file}.${process.pid}.${rand4()}.tmp`
  try {
    // A mode is applied at creation (no world-readable window); the chmod covers a umask
    // that only removes bits and a temp file that already existed.
    await fs.writeFile(
      tmp,
      data,
      opts.mode === undefined ? 'utf8' : { encoding: 'utf8', mode: opts.mode }
    )
    if (opts.mode !== undefined) await fs.chmod(tmp, opts.mode).catch(() => {})
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Reads a library file as text, refusing a symbolic link. A library can come from somewhere
 * else (a shared or synced folder, an unpacked archive), and a linked storage.json would let
 * its app read any JSON file on this computer through host.storage.
 */
async function readFileNoLink(file: string): Promise<string> {
  // Windows has no O_NOFOLLOW, so the link is also checked by hand first.
  if ((await fs.lstat(file)).isSymbolicLink()) {
    throw new Error(`Refusing to read a link: ${file}`)
  }
  const fh = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    return await fh.readFile('utf8')
  } finally {
    await fh.close()
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFileNoLink(file)) as T
  } catch {
    return null
  }
}

function isoOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback
}

/** Validates/normalizes raw meta.json content. Returns null when unusable. */
function normalizeMeta(raw: unknown, id: string): AppMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  const now = new Date().toISOString()
  const versions: VersionInfo[] = Array.isArray(r.versions)
    ? (r.versions as unknown[])
        .filter(
          (v): v is Record<string, unknown> =>
            !!v && typeof v === 'object' && Number.isInteger((v as { n?: unknown }).n)
        )
        .map((v) => ({
          n: v.n as number,
          createdAt: isoOr(v.createdAt, now),
          model: typeof v.model === 'string' ? v.model : '',
          prompt: typeof v.prompt === 'string' ? v.prompt : '',
          ...(typeof v.cost === 'number' && Number.isFinite(v.cost) && v.cost >= 0
            ? { cost: v.cost }
            : {})
        }))
    : []
  const createdAt = isoOr(r.createdAt, now)
  return {
    id,
    name: r.name,
    icon: typeof r.icon === 'string' && r.icon ? r.icon : '✨',
    createdAt,
    updatedAt: isoOr(r.updatedAt, createdAt),
    currentVersion: Number.isInteger(r.currentVersion) ? (r.currentVersion as number) : 0,
    versions,
    ...(typeof r.folder === 'string' && FOLDER_ID_RE.test(r.folder) ? { folder: r.folder } : {})
  }
}

function cleanLabel(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** Validates/normalizes raw library.json content. Never throws. */
function normalizeLayout(raw: unknown): LibraryLayout {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const folders: LibraryFolder[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.folders)) {
    for (const f of r.folders as unknown[]) {
      if (!f || typeof f !== 'object') continue
      const o = f as Record<string, unknown>
      if (typeof o.id !== 'string' || !FOLDER_ID_RE.test(o.id) || seen.has(o.id)) continue
      seen.add(o.id)
      folders.push({ id: o.id, name: cleanLabel(o.name, 60) || 'Folder' })
    }
  }
  const pinned = Array.isArray(r.pinned)
    ? [
        ...new Set(
          (r.pinned as unknown[]).filter((p): p is string => typeof p === 'string' && ID_RE.test(p))
        )
      ]
    : []
  return { folders, pinned }
}

/** Picks `name` or `name-2.ext`, `name-3.ext`… so nothing in `taken` is overwritten. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}${ext}`
    if (!taken.has(cand.toLowerCase())) return cand
  }
}

export class LibraryService {
  private locks = new Map<string, Promise<unknown>>()
  private notifier: (ids: string[]) => void = () => {}

  constructor(private getLibraryPath: () => Promise<string>) {}

  /** Registers the callback fired after our own mutations. */
  setNotifier(fn: (ids: string[]) => void): void {
    this.notifier = fn
  }

  private notify(ids: string[]): void {
    try {
      this.notifier(ids)
    } catch (err) {
      console.warn('[library] notifier failed', err)
    }
  }

  // ---------- paths ----------

  private assertId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !id || id.length > 80 || !ID_RE.test(id)) {
      throw new Error(`Invalid app id: ${String(id)}`)
    }
  }

  private async appsDir(): Promise<string> {
    return join(await this.getLibraryPath(), 'apps')
  }
  private async trashDir(): Promise<string> {
    return join(await this.getLibraryPath(), 'trash')
  }
  private async appDir(id: string): Promise<string> {
    this.assertId(id)
    const dir = join(await this.appsDir(), id)
    // A symlinked app folder (e.g. in a shared library) would send meta/storage writes outside
    // the library. list() already skips them; refuse them here too.
    const st = await fs.lstat(dir).catch(() => null)
    if (st?.isSymbolicLink()) throw new Error(`App folder is a link, not a folder: ${id}`)
    return dir
  }

  /** Resolves when every in-flight locked mutation has finished. Never rejects. */
  async settle(): Promise<void> {
    await Promise.all([...this.locks.values()].map((p) => p.catch(() => {})))
  }

  /** True when a newer Marbles wrote this library: it can be read here but not changed. */
  async tooNew(): Promise<boolean> {
    return libraryFormatOf(await readJson<unknown>(await this.layoutFile())) > LIBRARY_FORMAT
  }

  /** Serializes mutations per app id. Refuses them all in a library from a newer Marbles. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (await this.tooNew()) throw new LibraryTooNewError()
      return fn()
    }
    const prev = this.locks.get(id) ?? Promise.resolve()
    const next = prev.then(run, run)
    const tail = next.catch(() => {})
    this.locks.set(id, tail)
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id)
    })
    return next
  }

  // ---------- meta ----------

  /** Reads meta.json; synthesizes one for hand-dropped folders that contain vN.html files. */
  private async loadMeta(dir: string, id: string): Promise<AppMeta | null> {
    const raw = await readJson<unknown>(join(dir, 'meta.json'))
    const meta = normalizeMeta(raw, id)
    if (meta) return meta
    if (raw !== null) {
      console.warn(`[library] invalid meta.json in ${dir}; skipping`)
      return null
    }
    return this.synthesizeMeta(dir, id)
  }

  private async synthesizeMeta(dir: string, id: string): Promise<AppMeta | null> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return null
    }
    const ns = entries
      .map((f) => VERSION_FILE_RE.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .filter((n) => n >= 1)
      .sort((a, b) => a - b)
    if (!ns.length) {
      console.warn(`[library] ${dir} has no meta.json and no vN.html; skipping`)
      return null
    }
    const versions: VersionInfo[] = []
    for (const n of ns) {
      let createdAt = new Date().toISOString()
      try {
        const st = await fs.stat(join(dir, `v${n}.html`))
        createdAt = st.mtime.toISOString()
      } catch {
        // keep now
      }
      versions.push({ n, createdAt, model: '', prompt: '' })
    }
    const meta: AppMeta = {
      id,
      name: prettify(id),
      icon: '✨',
      createdAt: versions[0].createdAt,
      updatedAt: versions[versions.length - 1].createdAt,
      currentVersion: ns[ns.length - 1],
      versions
    }
    try {
      await writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    } catch (err) {
      console.warn(`[library] could not save synthesized meta for ${id}`, err)
    }
    return meta
  }

  private async saveMeta(meta: AppMeta): Promise<void> {
    const dir = await this.appDir(meta.id)
    await fs.mkdir(dir, { recursive: true })
    await writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  }

  private async requireMeta(id: string): Promise<AppMeta> {
    const meta = await this.loadMeta(await this.appDir(id), id)
    if (!meta) throw new Error(`App not found: ${id}`)
    return meta
  }

  // ---------- library ----------

  async list(): Promise<AppMeta[]> {
    const apps = await this.appsDir()
    let names: string[]
    try {
      const dirents = await fs.readdir(apps, { withFileTypes: true })
      names = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
    const out: AppMeta[] = []
    for (const name of names) {
      try {
        let folder = name
        if (!ID_RE.test(folder)) {
          // Hand-dropped folder with an unfriendly name: give it a valid id if it holds versions.
          const probe = await fs.readdir(join(apps, name)).catch(() => [] as string[])
          if (!probe.some((f) => VERSION_FILE_RE.test(f))) {
            console.warn(`[library] skipping folder with invalid id: ${name}`)
            continue
          }
          folder = makeId(name)
          await fs.rename(join(apps, name), join(apps, folder))
        }
        const meta = await this.loadMeta(join(apps, folder), folder)
        if (meta) out.push(meta)
      } catch (err) {
        console.warn(`[library] skipping ${name}`, err)
      }
    }
    out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return out
  }

  async get(id: string): Promise<AppMeta | null> {
    const dir = await this.appDir(id)
    try {
      return await this.loadMeta(dir, id)
    } catch {
      return null
    }
  }

  /** Takes GLOBAL_LOCK synchronously so a relocation's settle() sees in-progress creates. */
  create(input: CreateAppInput): Promise<AppMeta> {
    return this.withLock(GLOBAL_LOCK, async () => {
      const name = input.name?.trim() || 'Untitled'
      const apps = await this.appsDir()
      await fs.mkdir(apps, { recursive: true })
      let id = makeId(name)
      while (await exists(join(apps, id))) id = makeId(name)
      const dir = join(apps, id)
      await fs.mkdir(dir, { recursive: true })
      const now = new Date().toISOString()
      const meta: AppMeta = {
        id,
        name,
        icon: input.icon || '✨',
        createdAt: now,
        updatedAt: now,
        currentVersion: 0,
        versions: []
      }
      if (typeof input.html === 'string') {
        await writeAtomic(join(dir, 'v1.html'), input.html)
        meta.currentVersion = 1
        meta.versions.push({
          n: 1,
          createdAt: now,
          model: input.model ?? '',
          prompt: input.prompt ?? '',
          ...(input.cost !== undefined ? { cost: input.cost } : {})
        })
      }
      await this.saveMeta(meta)
      this.notify([id])
      return meta
    })
  }

  rename(id: string, name: string): Promise<AppMeta> {
    return this.withLock(id, async () => {
      const meta = await this.requireMeta(id)
      meta.name = name.trim() || meta.name
      meta.updatedAt = new Date().toISOString()
      await this.saveMeta(meta)
      this.notify([id])
      return meta
    })
  }

  setIcon(id: string, icon: string): Promise<AppMeta> {
    return this.withLock(id, async () => {
      const meta = await this.requireMeta(id)
      meta.icon = icon.trim() || meta.icon
      meta.updatedAt = new Date().toISOString()
      await this.saveMeta(meta)
      this.notify([id])
      return meta
    })
  }

  duplicate(id: string): Promise<AppMeta> {
    return this.withLock(GLOBAL_LOCK, async () => {
      const src = await this.requireMeta(id)
      const apps = await this.appsDir()
      const name = `${src.name} copy`
      let newId = makeId(name)
      while (await exists(join(apps, newId))) newId = makeId(name)
      await fs.cp(await this.appDir(id), join(apps, newId), { recursive: true })
      const now = new Date().toISOString()
      const meta: AppMeta = { ...src, id: newId, name, createdAt: now, updatedAt: now }
      await this.saveMeta(meta)
      this.notify([newId])
      return meta
    })
  }

  private async moveDir(from: string, to: string): Promise<void> {
    try {
      await fs.rename(from, to)
    } catch {
      // cross-device or transient lock: copy then remove
      await fs.cp(from, to, { recursive: true })
      await fs.rm(from, { recursive: true, force: true })
    }
  }

  /** Moves the app to the trash; resolves with the id it landed under (may be suffixed). */
  trash(id: string): Promise<string> {
    return this.withLock(id, async () => {
      const dir = await this.appDir(id)
      if (!(await exists(dir))) throw new Error(`App not found: ${id}`)
      const trash = await this.trashDir()
      await fs.mkdir(trash, { recursive: true })
      let target = id
      while (await exists(join(trash, target))) target = `${id}-${rand4()}`
      await this.moveDir(dir, join(trash, target))
      await writeAtomic(
        join(trash, target, 'trash.json'),
        JSON.stringify({ trashedAt: new Date().toISOString() })
      )
      this.notify([id])
      return target
    })
  }

  async listTrash(): Promise<TrashedApp[]> {
    const trash = await this.trashDir()
    let names: string[]
    try {
      const dirents = await fs.readdir(trash, { withFileTypes: true })
      names = dirents.filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name)
    } catch {
      return []
    }
    const out: TrashedApp[] = []
    for (const id of names) {
      const dir = join(trash, id)
      const meta = normalizeMeta(await readJson<unknown>(join(dir, 'meta.json')), id)
      const info = await readJson<{ trashedAt?: string }>(join(dir, 'trash.json'))
      let trashedAt = info?.trashedAt
      if (!trashedAt || Number.isNaN(Date.parse(trashedAt))) {
        trashedAt =
          (await fs.stat(dir).catch(() => null))?.mtime.toISOString() ?? new Date().toISOString()
      }
      out.push({ id, name: meta?.name ?? prettify(id), icon: meta?.icon ?? '✨', trashedAt })
    }
    out.sort((a, b) => Date.parse(b.trashedAt) - Date.parse(a.trashedAt))
    return out
  }

  /**
   * Permanently deletes everything listTrash() shows: only folders directly inside
   * <library>/trash whose names match ID_RE. Never follows symlinks, and refuses to run if the
   * trash folder itself is not a real folder. Resolves with how many apps were deleted.
   */
  emptyTrash(): Promise<number> {
    return this.withLock(GLOBAL_LOCK, async () => {
      const trash = await this.trashDir()
      let st: Awaited<ReturnType<typeof fs.lstat>>
      try {
        st = await fs.lstat(trash)
      } catch {
        return 0 // no trash folder yet
      }
      if (!st.isDirectory())
        throw new Error('The Trash folder is not a normal folder. Nothing was deleted.')
      const dirents = await fs.readdir(trash, { withFileTypes: true })
      let deleted = 0
      for (const d of dirents) {
        // Same filter as listTrash(); a symlink is never isDirectory() on a Dirent, so it is skipped.
        if (!d.isDirectory() || !ID_RE.test(d.name)) continue
        await fs.rm(join(trash, d.name), { recursive: true })
        deleted++
      }
      if (deleted) this.notify([])
      return deleted
    })
  }

  /** Permanently deletes one trashed app. Validates the id and refuses symlinks. */
  deleteTrashed(id: string): Promise<void> {
    return this.withLock(GLOBAL_LOCK, async () => {
      this.assertId(id)
      const dir = join(await this.trashDir(), id)
      const st = await fs.lstat(dir).catch(() => null)
      if (!st) throw new Error(`Not in trash: ${id}`)
      if (!st.isDirectory())
        throw new Error('That Trash item is not a normal folder. Nothing was deleted.')
      await fs.rm(dir, { recursive: true })
      this.notify([])
    })
  }

  restore(id: string): Promise<AppMeta> {
    return this.withLock(GLOBAL_LOCK, async () => {
      this.assertId(id)
      const trash = await this.trashDir()
      const from = join(trash, id)
      if (!(await exists(from))) throw new Error(`Not in trash: ${id}`)
      const apps = await this.appsDir()
      await fs.mkdir(apps, { recursive: true })
      const prelim = normalizeMeta(await readJson<unknown>(join(from, 'meta.json')), id)
      let newId = id
      if (await exists(join(apps, newId))) {
        newId = makeId(prelim?.name ?? id)
        while (await exists(join(apps, newId))) newId = makeId(prelim?.name ?? id)
      }
      await this.moveDir(from, join(apps, newId))
      await fs.rm(join(apps, newId, 'trash.json'), { force: true })
      const meta = await this.loadMeta(join(apps, newId), newId)
      if (!meta) throw new Error(`Restored folder has no usable content: ${newId}`)
      await this.saveMeta(meta) // rewrites id to match folder
      this.notify([id, newId])
      return meta
    })
  }

  // ---------- folders & pins (library.json) ----------

  private async layoutFile(): Promise<string> {
    return join(await this.getLibraryPath(), 'library.json')
  }

  async layout(): Promise<LibraryLayout> {
    return normalizeLayout(await readJson<unknown>(await this.layoutFile()))
  }

  /** Read-modify-write of library.json under one lock. */
  private editLayout<T>(
    fn: (layout: LibraryLayout) => T
  ): Promise<{ layout: LibraryLayout; out: T }> {
    return this.withLock(LAYOUT_LOCK, async () => {
      const layout = await this.layout()
      const out = fn(layout)
      const file = await this.layoutFile()
      await fs.mkdir(join(file, '..'), { recursive: true })
      await writeAtomic(file, JSON.stringify({ format: LIBRARY_FORMAT, ...layout }, null, 2))
      this.notify([])
      return { layout, out }
    })
  }

  private requireFolder(layout: LibraryLayout, id: string): LibraryFolder {
    const f = layout.folders.find((x) => x.id === id)
    if (!f) throw new Error(`Folder not found: ${id}`)
    return f
  }

  async createFolder(name: string): Promise<LibraryFolder> {
    const { out } = await this.editLayout((layout) => {
      let id = `f-${rand4()}${rand4()}`
      while (layout.folders.some((f) => f.id === id)) id = `f-${rand4()}${rand4()}`
      const folder: LibraryFolder = { id, name: cleanLabel(name, 60) || 'New folder' }
      layout.folders.push(folder)
      return folder
    })
    return out
  }

  async updateFolder(id: string, patch: { name?: string }): Promise<LibraryLayout> {
    const { layout } = await this.editLayout((layout) => {
      const f = this.requireFolder(layout, id)
      const name = cleanLabel(patch.name, 60)
      if (name) f.name = name
    })
    return layout
  }

  /**
   * Moves every app in the folder to the Trash, then removes the folder. The apps go first, so a
   * failure midway leaves the folder in place with whatever is still in it. Restored apps keep a
   * stale folder id, which reads as Unfiled.
   */
  /** Takes GLOBAL_LOCK synchronously (not after the reads below) so a relocation's settle() sees us. */
  deleteFolder(id: string): Promise<LibraryLayout> {
    return this.withLock(GLOBAL_LOCK, async () => {
      this.requireFolder(await this.layout(), id)
      const apps = await this.list()
      for (const a of apps.filter((x) => x.folder === id)) await this.trash(a.id)
      const { layout } = await this.editLayout((layout) => {
        layout.folders = layout.folders.filter((f) => f.id !== id)
      })
      return layout
    })
  }

  async reorderFolders(ids: string[]): Promise<LibraryLayout> {
    const { layout } = await this.editLayout((layout) => {
      const order = Array.isArray(ids) ? ids : []
      const rank = (fid: string): number => {
        const i = order.indexOf(fid)
        return i < 0 ? Number.MAX_SAFE_INTEGER : i
      }
      layout.folders = layout.folders
        .map((f, i) => ({ f, i }))
        .sort((a, b) => rank(a.f.id) - rank(b.f.id) || a.i - b.i)
        .map((x) => x.f)
    })
    return layout
  }

  async setPinned(ids: string[]): Promise<LibraryLayout> {
    const clean = normalizeLayout({ pinned: ids }).pinned
    const { layout } = await this.editLayout((layout) => {
      layout.pinned = clean
    })
    return layout
  }

  async setFolder(appId: string, folderId: string | null): Promise<AppMeta> {
    this.assertId(appId)
    if (folderId !== null && (typeof folderId !== 'string' || !FOLDER_ID_RE.test(folderId))) {
      throw new Error(`Invalid folder id: ${String(folderId)}`)
    }
    return this.withLock(appId, async () => {
      if (folderId) this.requireFolder(await this.layout(), folderId)
      const meta = await this.requireMeta(appId)
      if (folderId) meta.folder = folderId
      else delete meta.folder
      // Filing an app is not a change to the app: updatedAt stays.
      await this.saveMeta(meta)
      this.notify([appId])
      return meta
    })
  }

  // ---------- versions ----------

  async readVersion(id: string, n: number): Promise<string> {
    if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid version: ${n}`)
    return readFileNoLink(join(await this.appDir(id), `v${n}.html`))
  }

  writeVersion(
    id: string,
    html: string,
    info: { model: string; prompt: string; cost?: number }
  ): Promise<AppMeta> {
    return this.withLock(id, async () => {
      const meta = await this.requireMeta(id)
      const dir = await this.appDir(id)
      let max = meta.versions.reduce((m, v) => Math.max(m, v.n), 0)
      // Also account for files not listed in meta (never overwrite an existing vN.html).
      const files = await fs.readdir(dir).catch(() => [] as string[])
      for (const f of files) {
        const m = VERSION_FILE_RE.exec(f)
        if (m) max = Math.max(max, Number(m[1]))
      }
      const n = max + 1
      const now = new Date().toISOString()
      await writeAtomic(join(dir, `v${n}.html`), html)
      meta.versions.push({
        n,
        createdAt: now,
        model: info.model,
        prompt: info.prompt,
        ...(info.cost !== undefined ? { cost: info.cost } : {})
      })
      meta.currentVersion = n
      meta.updatedAt = now
      await this.saveMeta(meta)
      this.notify([id])
      return meta
    })
  }

  setCurrent(id: string, n: number): Promise<AppMeta> {
    return this.withLock(id, async () => {
      const meta = await this.requireMeta(id)
      if (!meta.versions.some((v) => v.n === n)) throw new Error(`Version ${n} does not exist`)
      meta.currentVersion = n
      meta.updatedAt = new Date().toISOString()
      await this.saveMeta(meta)
      this.notify([id])
      return meta
    })
  }

  // ---------- chat ----------

  async readChat(id: string): Promise<ChatMessage[]> {
    const raw = await readJson<unknown>(join(await this.appDir(id), 'chat.json'))
    return Array.isArray(raw) ? (raw as ChatMessage[]) : []
  }

  writeChat(id: string, chat: ChatMessage[]): Promise<void> {
    return this.withLock(id, async () => {
      const dir = await this.appDir(id)
      if (!(await exists(dir))) throw new Error(`App not found: ${id}`)
      await writeAtomic(join(dir, 'chat.json'), JSON.stringify(chat, null, 2))
    })
  }

  // ---------- assets ----------

  /**
   * Copies files into <app>/assets/, renaming on a clash so nothing is overwritten.
   * Returns the names they landed under, in order.
   */
  addAssets(id: string, files: { name: string; path: string }[]): Promise<string[]> {
    return this.withLock(id, async () => {
      const dir = await this.appDir(id)
      if (!(await exists(dir))) throw new Error(`App not found: ${id}`)
      const assets = join(dir, 'assets')
      const st = await fs.lstat(assets).catch(() => null)
      if (st?.isSymbolicLink()) throw new Error(`Assets folder is a link: ${id}`)
      await fs.mkdir(assets, { recursive: true })
      const taken = new Set((await fs.readdir(assets)).map((f) => f.toLowerCase()))
      const out: string[] = []
      for (const f of files) {
        if (!ASSET_NAME_RE.test(f.name)) throw new Error(`Invalid asset name: ${f.name}`)
        const name = uniqueName(f.name, taken)
        taken.add(name.toLowerCase())
        await fs.copyFile(f.path, join(assets, name), fsConstants.COPYFILE_EXCL)
        out.push(name)
      }
      this.notify([id])
      return out
    })
  }

  /** The app's files, by name. Links and anything that isn't a plain file are left out. */
  async listAssets(id: string): Promise<{ name: string; size: number }[]> {
    const dir = join(await this.appDir(id), 'assets')
    const st = await fs.lstat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return []
    const out: { name: string; size: number }[] = []
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !ASSET_NAME_RE.test(e.name)) continue
      const f = await fs.lstat(join(dir, e.name)).catch(() => null)
      if (f?.isFile()) out.push({ name: e.name, size: f.size })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Takes a file out of the app: moved to <app>/removed-assets/ (not deleted, and no longer
   * served or listed), so a removal by mistake can be undone by hand.
   */
  removeAsset(id: string, name: string): Promise<void> {
    return this.withLock(id, async () => {
      if (typeof name !== 'string' || !ASSET_NAME_RE.test(name)) {
        throw new Error(`Invalid asset name: ${String(name)}`)
      }
      const dir = await this.appDir(id)
      const from = join(dir, 'assets', name)
      if ((await fs.lstat(from)).isSymbolicLink()) throw new Error(`Refusing a link: ${name}`)
      const bin = join(dir, 'removed-assets')
      await fs.mkdir(bin, { recursive: true })
      const taken = new Set((await fs.readdir(bin)).map((f) => f.toLowerCase()))
      await fs.rename(from, join(bin, uniqueName(name, taken)))
      this.notify([id])
    })
  }

  /** Reads <app>/assets/<name>, refusing links and anything outside that folder. */
  async readAsset(id: string, name: string): Promise<Buffer> {
    if (typeof name !== 'string' || !ASSET_NAME_RE.test(name)) {
      throw new Error(`Invalid asset name: ${String(name)}`)
    }
    const file = join(await this.appDir(id), 'assets', name)
    for (const p of [join(file, '..'), file]) {
      if ((await fs.lstat(p)).isSymbolicLink()) throw new Error(`Refusing to read a link: ${p}`)
    }
    return fs.readFile(file)
  }

  // ---------- storage (used by BridgeService) ----------

  async readStorage(id: string): Promise<Record<string, unknown>> {
    const raw = await readJson<unknown>(join(await this.appDir(id), 'storage.json'))
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  }

  writeStorage(id: string, data: Record<string, unknown>): Promise<void> {
    return this.withLock(id, async () => {
      const dir = await this.appDir(id)
      if (!(await exists(dir))) throw new Error(`App not found: ${id}`)
      await writeAtomic(join(dir, 'storage.json'), JSON.stringify(data, null, 2))
    })
  }
}
