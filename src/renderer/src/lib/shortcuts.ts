import { gen } from './stores/gen.svelte'
import { library } from './stores/library.svelte'
import { ui } from './stores/ui.svelte'

let focusSearch: (() => void) | null = null

export function registerSearchFocus(fn: () => void): void {
  focusSearch = fn
}

/**
 * Handles a host shortcut (key already lowercased, mod key held).
 * Returns true when it was handled. Shared by the window listener and the
 * app iframe, which forwards these keys because it swallows keyboard events.
 */
export function handleShortcut(key: string, shift: boolean, typing = false): boolean {
  switch (key) {
    case 'n':
      gen.openNew()
      return true
    case 'j':
      if (ui.view === 'app' && library.selected) ui.toggleDrawer()
      return true
    case 'b':
      ui.toggleSidebar()
      return true
    case 'k':
      ui.paletteOpen = !ui.paletteOpen
      return true
    case 'f':
      focusSearch?.()
      return true
    case ',':
      ui.view = 'settings'
      return true
    case 'z': {
      const app = library.selected
      if (typing || ui.view !== 'app' || !app) return false
      const { prev, next } = library.neighbours(app)
      const target = shift ? next : prev
      if (target !== null) void library.setCurrent(app.id, target)
      return true
    }
    default:
      return false
  }
}
