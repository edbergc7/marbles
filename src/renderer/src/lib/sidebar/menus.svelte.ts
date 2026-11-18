import type { AppMeta, LibraryFolder } from '../../../../shared/types'
import type { MenuItem } from '../../components/Menu.svelte'
import { library } from '../stores/library.svelte'
import { exportApp } from '../export'
import type { SidebarView } from './viewState.svelte'
import type { RenameController } from './rename.svelte'
import type { Ctx } from './types'

type MenuState = { x: number; y: number; items: MenuItem[]; key: string }
type PickerState = { x: number; y: number; current: string; onPick: (e: string) => void }

/** The open context menu / icon picker, and the builders for their items. */
export class MenuController {
  menu = $state<MenuState | null>(null)
  picker = $state<PickerState | null>(null)

  #view: SidebarView
  #rename: RenameController
  #newFolder: (thenMove?: string) => Promise<void>

  constructor(deps: {
    view: SidebarView
    rename: RenameController
    newFolder: (thenMove?: string) => Promise<void>
  }) {
    this.#view = deps.view
    this.#rename = deps.rename
    this.#newFolder = deps.newFolder
  }

  close = (): void => {
    this.menu = null
  }
  closePicker = (): void => {
    this.picker = null
  }

  appMenu = (app: AppMeta, ctx: Ctx, x: number, y: number): MenuItem[] => {
    const pinned = library.isPinned(app.id)
    return [
      {
        label: pinned ? 'Unpin' : 'Pin',
        icon: 'star',
        onSelect: () => library.togglePin(app.id)
      },
      {
        label: 'Move to folder…',
        icon: 'folder',
        onSelect: () => (this.menu = { x, y, items: this.moveMenu(app), key: `app:${app.id}` })
      },
      'separator',
      {
        label: 'Rename',
        icon: 'edit',
        hint: 'F2',
        onSelect: () => this.#rename.start('app', app.id, app.name, ctx)
      },
      {
        label: 'Change icon',
        icon: 'palette',
        onSelect: () =>
          (this.picker = { x, y, current: app.icon, onPick: (e) => library.setIcon(app.id, e) })
      },
      { label: 'Duplicate', icon: 'copy', onSelect: () => library.duplicate(app.id) },
      {
        label: 'Export HTML',
        icon: 'download',
        disabled: app.currentVersion < 1,
        onSelect: () => void exportApp(app)
      },
      'separator',
      {
        label: 'Move to Trash',
        icon: 'trash',
        danger: true,
        onSelect: () => library.moveToTrash(app.id)
      }
    ]
  }

  moveMenu = (app: AppMeta): MenuItem[] => {
    const current = library.folderOf(app)?.id ?? null
    return [
      ...library.layout.folders.map((f): MenuItem => ({
        label: f.name,
        icon: 'folder',
        checked: current === f.id,
        onSelect: () => library.setFolder(app.id, f.id)
      })),
      {
        label: 'Latest',
        checked: current === null,
        onSelect: () => library.setFolder(app.id, null)
      },
      'separator',
      { label: 'New folder…', icon: 'folderPlus', onSelect: () => this.#newFolder(app.id) }
    ]
  }

  folderMenu = (f: LibraryFolder): MenuItem[] => [
    {
      label: 'Rename',
      icon: 'edit',
      hint: 'F2',
      onSelect: () => this.#rename.start('folder', f.id, f.name)
    },
    'separator',
    {
      label: 'Delete folder',
      icon: 'trash',
      danger: true,
      onSelect: () => library.deleteFolder(f.id)
    }
  ]

  sortMenu = (): MenuItem[] => [
    {
      label: 'Recently changed',
      checked: this.#view.sort === 'recent',
      onSelect: () => this.#view.setSort('recent')
    },
    {
      label: 'Name',
      checked: this.#view.sort === 'name',
      onSelect: () => this.#view.setSort('name')
    }
  ]

  openAt = (e: MouseEvent, key: string, build: (x: number, y: number) => MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    let x = e.clientX
    let y = e.clientY
    if (e.type === 'click') {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      x = r.left
      y = r.bottom + 4
    }
    this.menu = { x, y, items: build(x, y), key }
  }
}
