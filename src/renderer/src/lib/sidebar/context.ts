import { getContext, setContext } from 'svelte'
import type { SidebarView } from './viewState.svelte'
import type { RenameController } from './rename.svelte'
import type { MenuController } from './menus.svelte'
import type { DragController } from './dragDrop.svelte'

export type SidebarCtx = {
  view: SidebarView
  rename: RenameController
  menus: MenuController
  dnd: DragController
  newFolder: (thenMove?: string) => Promise<void>
}

const KEY = Symbol('sidebar')

export const setSidebar = (ctx: SidebarCtx): SidebarCtx => setContext(KEY, ctx)
export const getSidebar = (): SidebarCtx => getContext<SidebarCtx>(KEY)
