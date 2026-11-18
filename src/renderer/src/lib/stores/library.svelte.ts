import type { AppMeta, LibraryFolder, LibraryLayout, TrashedApp } from '../../../../shared/types'
import { ui } from './ui.svelte'
import { errorText } from '../errors'

const LAST_KEY = 'marbles:lastApp'

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}
function writeLast(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id)
    else localStorage.removeItem(LAST_KEY)
  } catch {
    /* ignore */
  }
}

class LibraryStore {
  apps = $state<AppMeta[]>([])
  layout = $state<LibraryLayout>({ folders: [], pinned: [] })
  trash = $state<TrashedApp[]>([])
  selectedId = $state<string | null>(null)
  loaded = $state(false)
  error = $state<string | null>(null)

  selected = $derived(this.apps.find((a) => a.id === this.selectedId) ?? null)

  private refreshing: Promise<void> | null = null
  private pending = false

  async init(): Promise<void> {
    await this.refresh()
    const last = readLast()
    if (last && this.apps.some((a) => a.id === last)) this.selectedId = last
    else this.selectedId = this.apps[0]?.id ?? null
    window.api.library.onChanged(() => void this.refresh())
  }

  dismissError(): void {
    this.error = null
  }

  /** Coalesces overlapping refreshes: at most one in flight plus one queued. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pending = true
      return this.refreshing
    }
    this.refreshing = (async () => {
      do {
        this.pending = false
        try {
          const [apps, trash, layout] = await Promise.all([
            window.api.library.list(),
            window.api.library.listTrash(),
            window.api.library.layout()
          ])
          this.apps = apps
          this.trash = trash
          this.layout = layout
          this.error = null
        } catch (e) {
          this.error = errorText(e)
        }
      } while (this.pending)
      this.loaded = true
      if (this.selectedId && !this.apps.some((a) => a.id === this.selectedId)) {
        this.select(this.apps[0]?.id ?? null)
      }
    })()
    try {
      await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  select(id: string | null): void {
    this.selectedId = id
    writeLast(id)
    if (id) ui.view = 'app'
  }

  private replace(meta: AppMeta): void {
    const i = this.apps.findIndex((a) => a.id === meta.id)
    if (i >= 0) this.apps[i] = meta
    else this.apps.unshift(meta)
  }

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    this.replace(await window.api.library.rename(id, trimmed))
  }

  async setIcon(id: string, icon: string): Promise<void> {
    this.replace(await window.api.library.setIcon(id, icon))
  }

  async duplicate(id: string): Promise<void> {
    const copy = await window.api.library.duplicate(id)
    this.replace(copy)
    this.select(copy.id)
    ui.showToast('Duplicated')
  }

  async moveToTrash(id: string): Promise<void> {
    const idx = this.apps.findIndex((a) => a.id === id)
    const wasSelected = this.selectedId === id
    const trashId = await window.api.library.trash(id)
    this.apps = this.apps.filter((a) => a.id !== id)
    if (wasSelected) this.select(this.apps[Math.min(idx, this.apps.length - 1)]?.id ?? null)
    ui.showToast('Moved to Trash', {
      label: 'Undo',
      run: () => void this.undoTrash(trashId, wasSelected)
    })
    void this.refresh()
  }

  /** Restore after an Undo (id is the trash id); keeps the current selection if the trashed app wasn't it. */
  private async undoTrash(trashId: string, wasSelected: boolean): Promise<void> {
    try {
      const meta = await window.api.library.restore(trashId)
      this.trash = this.trash.filter((t) => t.id !== trashId)
      this.replace(meta)
      if (wasSelected) this.select(meta.id)
    } catch (e) {
      ui.showToast(errorText(e))
    }
  }

  async restore(id: string): Promise<void> {
    const meta = await window.api.library.restore(id)
    this.trash = this.trash.filter((t) => t.id !== id)
    this.replace(meta)
    this.select(meta.id)
    ui.showToast('Restored')
  }

  /** Permanently deletes everything in the Trash, after the user confirms in a native dialog. */
  async emptyTrash(): Promise<void> {
    try {
      const n = await window.api.library.emptyTrash()
      if (n === null) return
      this.trash = await window.api.library.listTrash()
      if (n > 0) ui.showToast(n === 1 ? 'Deleted 1 app forever' : `Deleted ${n} apps forever`)
    } catch (e) {
      ui.showToast(errorText(e))
    }
  }

  /** Permanently deletes one trashed app, after the user confirms in a native dialog. */
  async deleteForever(id: string): Promise<void> {
    try {
      if (!(await window.api.library.deleteTrashed(id))) return
      this.trash = this.trash.filter((t) => t.id !== id)
      ui.showToast('Deleted forever')
    } catch (e) {
      ui.showToast(errorText(e))
    }
  }

  // ---------- folders & pins ----------

  isPinned(id: string): boolean {
    return this.layout.pinned.includes(id)
  }

  /** The app's folder, or null when Unfiled (including a folder id that no longer exists). */
  folderOf(app: AppMeta): LibraryFolder | null {
    return (app.folder && this.layout.folders.find((f) => f.id === app.folder)) || null
  }

  async togglePin(id: string): Promise<void> {
    const pinned = this.isPinned(id)
      ? this.layout.pinned.filter((p) => p !== id)
      : [...this.layout.pinned, id]
    await this.setPinned(pinned)
  }

  /** Pins `id` (if needed) and places it before `beforeId` (end when null). */
  async movePin(id: string, beforeId: string | null): Promise<void> {
    const rest = this.layout.pinned.filter((p) => p !== id)
    const i = beforeId ? rest.indexOf(beforeId) : -1
    rest.splice(i < 0 ? rest.length : i, 0, id)
    await this.setPinned(rest)
  }

  private async setPinned(ids: string[]): Promise<void> {
    const prev = this.layout
    this.layout = { ...prev, pinned: ids } // optimistic, so drags feel instant
    try {
      this.layout = await window.api.library.setPinned(ids)
    } catch (e) {
      this.layout = prev
      throw e
    }
  }

  async createFolder(name: string): Promise<LibraryFolder> {
    const folder = await window.api.library.createFolder(name)
    this.layout = { ...this.layout, folders: [...this.layout.folders, folder] }
    return folder
  }

  async updateFolder(id: string, patch: { name?: string }): Promise<void> {
    this.layout = await window.api.library.updateFolder(id, patch)
  }

  async deleteFolder(id: string): Promise<void> {
    const name = this.layout.folders.find((f) => f.id === id)?.name ?? 'Folder'
    const n = this.apps.filter((a) => a.folder === id).length
    try {
      this.layout = await window.api.library.deleteFolder(id)
    } finally {
      // Even on a partial failure some apps may have moved; refresh also fixes the selection.
      await this.refresh()
    }
    ui.showToast(
      n === 0
        ? `Deleted “${name}”`
        : `Deleted “${name}”. ${n === 1 ? 'Its app was' : `Its ${n} apps were`} moved to Trash.`
    )
  }

  /** Places folder `id` before `beforeId` (end when null). */
  async moveFolder(id: string, beforeId: string | null): Promise<void> {
    const ids = this.layout.folders.map((f) => f.id).filter((f) => f !== id)
    const i = beforeId ? ids.indexOf(beforeId) : -1
    ids.splice(i < 0 ? ids.length : i, 0, id)
    const prev = this.layout
    const byId = new Map(prev.folders.map((f) => [f.id, f]))
    this.layout = { ...prev, folders: ids.map((f) => byId.get(f)!).filter(Boolean) }
    try {
      this.layout = await window.api.library.reorderFolders(ids)
    } catch (e) {
      this.layout = prev
      throw e
    }
  }

  async setFolder(appId: string, folderId: string | null): Promise<void> {
    const app = this.apps.find((a) => a.id === appId)
    if (!app || (app.folder ?? null) === folderId) return
    this.replace(await window.api.library.setFolder(appId, folderId))
  }

  async setCurrent(id: string, n: number): Promise<void> {
    this.replace(await window.api.versions.setCurrent(id, n))
  }

  /** Previous / next existing version numbers relative to current. */
  neighbours(app: AppMeta): { prev: number | null; next: number | null } {
    const ns = app.versions.map((v) => v.n).sort((a, b) => a - b)
    const prev = [...ns].reverse().find((n) => n < app.currentVersion) ?? null
    const next = ns.find((n) => n > app.currentVersion) ?? null
    return { prev, next }
  }
}

export const library = new LibraryStore()
