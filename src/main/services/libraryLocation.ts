import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join, relative, resolve, isAbsolute } from 'path'
import type { LibraryFolderInfo, Settings } from '../../shared/types'
import type { SettingsService } from './settings'

const BUSY_MSG = 'Wait for builds and changes to finish first'

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function fold(p: string): string {
  const r = resolve(p)
  return CASE_INSENSITIVE ? r.toLowerCase() : r
}

function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b)
}

/** True when `child` is strictly inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(fold(parent), fold(child))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function countApps(root: string): Promise<number> {
  let n = 0
  try {
    for (const e of await fs.readdir(join(root, 'apps'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      try {
        await fs.access(join(root, 'apps', e.name, 'meta.json'))
        n++
      } catch {
        // not an app folder
      }
    }
  } catch {
    // no apps dir
  }
  return n
}

async function inspect(path: string, current: string): Promise<LibraryFolderInfo> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(path)
  } catch {
    // unreadable or missing: treated as empty
  }
  const isLibrary = await isDir(join(path, 'apps'))
  return {
    path,
    empty: entries.every((n) => n.startsWith('.')),
    isLibrary,
    appCount: isLibrary ? await countApps(path) : 0,
    isCurrent: samePath(path, current)
  }
}

export class LibraryLocationService {
  /** 'ready' or 'relocating': while relocating, IPC write handlers are rejected. */
  private status: 'ready' | 'relocating' = 'ready'

  constructor(
    private deps: {
      settings: SettingsService
      /** Applies a settings patch through the path that fires onSettingsChanged. */
      applySettings: (patch: Partial<Settings>) => Promise<Settings>
      isBusy: () => boolean
      /** Waits for in-flight library and bridge storage writes to finish. Never rejects. */
      settle: () => Promise<void>
    }
  ) {}

  isRelocating(): boolean {
    return this.status === 'relocating'
  }

  private beginRelocation(): void {
    if (this.status === 'relocating') throw new Error('The library is already being moved')
    if (this.deps.isBusy()) throw new Error(BUSY_MSG)
    this.status = 'relocating'
  }

  async pick(win: BrowserWindow | null): Promise<LibraryFolderInfo | null> {
    const opts = {
      title: 'Choose library folder',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return inspect(res.filePaths[0], (await this.deps.settings.get()).libraryPath)
  }

  async moveTo(path: string): Promise<Settings> {
    this.beginRelocation()
    try {
      await this.deps.settle()
      const target = resolve(path)
      const current = resolve((await this.deps.settings.get()).libraryPath)
      if (samePath(target, current)) throw new Error('That is already your library folder')
      if (isInside(current, target) || isInside(target, current)) {
        throw new Error("The new folder can't be inside the current library, or contain it")
      }
      await fs.mkdir(target, { recursive: true })
      const info = await inspect(target, current)
      if (!info.empty) throw new Error('Choose an empty folder to move your library into')

      await fs.mkdir(current, { recursive: true })
      const before = new Set(await fs.readdir(target))
      const expected = await countApps(current)
      try {
        await fs.cp(current, target, { recursive: true, errorOnExist: false, force: false })
        const copied = await countApps(target)
        if (copied !== expected) {
          throw new Error(
            `Copy incomplete (${copied} of ${expected} apps). Your library was not moved`
          )
        }
      } catch (err) {
        for (const name of await fs.readdir(target).catch(() => [] as string[])) {
          if (!before.has(name)) await fs.rm(join(target, name), { recursive: true, force: true })
        }
        throw err
      }
      return this.deps.applySettings({ libraryPath: target })
    } finally {
      this.status = 'ready'
    }
  }

  async useExisting(path: string): Promise<Settings> {
    this.beginRelocation()
    try {
      await this.deps.settle()
      const target = resolve(path)
      const current = (await this.deps.settings.get()).libraryPath
      const info = await inspect(target, current)
      if (!info.empty && !info.isLibrary) {
        throw new Error("That folder isn't a Marbles library and isn't empty")
      }
      if (info.isCurrent) return this.deps.settings.get()
      await fs.mkdir(join(target, 'apps'), { recursive: true })
      return this.deps.applySettings({ libraryPath: target })
    } finally {
      this.status = 'ready'
    }
  }

  async reset(): Promise<Settings> {
    this.beginRelocation()
    try {
      await this.deps.settle()
      const def = this.deps.settings.defaults().libraryPath
      const current = (await this.deps.settings.get()).libraryPath
      if (samePath(def, current)) return this.deps.settings.get()
      await fs.mkdir(join(def, 'apps'), { recursive: true })
      return this.deps.applySettings({ libraryPath: def })
    } finally {
      this.status = 'ready'
    }
  }
}
