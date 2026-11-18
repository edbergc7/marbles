type View = 'app' | 'new' | 'trash' | 'settings'

const SIDEBAR_KEY = 'marbles:sidebarOpen'

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'false'
  } catch {
    return true
  }
}

const DRAWER_W_KEY = 'marbles:drawerWidth'
const DRAWER_MIN_W = 300
const DRAWER_MAX_W = 640
const DRAWER_DEFAULT_W = 360

function clampDrawerWidth(w: number): number {
  return Math.round(Math.min(DRAWER_MAX_W, Math.max(DRAWER_MIN_W, w)))
}

function loadDrawerWidth(): number {
  try {
    const n = Number(localStorage.getItem(DRAWER_W_KEY))
    return n ? clampDrawerWidth(n) : DRAWER_DEFAULT_W
  } catch {
    return DRAWER_DEFAULT_W
  }
}

class UiStore {
  view = $state<View>('app')
  /** The "Get started" pop-up (connect ChatGPT or an OpenRouter key). */
  getStartedOpen = $state(false)
  /** The Ctrl/Cmd+K command palette. */
  paletteOpen = $state(false)
  /** Set to ask the title bar to start renaming the open app; it clears it. */
  renameRequested = $state(false)
  drawerOpen = $state(false)
  drawerWidth = $state(loadDrawerWidth())
  sidebarOpen = $state(loadSidebarOpen())
  search = $state('')
  toast = $state<string | null>(null)
  toastAction = $state<{ label: string; run: () => void } | null>(null)
  /**
   * A sidebar row to highlight once: 'drop' after a drag lands on it, 'new' when a
   * freshly built app arrives in the library. Cleared after the animation.
   */
  landed = $state<{ id: string; kind: 'drop' | 'new' } | null>(null)
  /** An app that was just built; its first frame load fades in slowly. */
  justBuilt = $state<string | null>(null)
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private landedTimer: ReturnType<typeof setTimeout> | undefined
  private builtTimer: ReturnType<typeof setTimeout> | undefined

  flashLanded(id: string, kind: 'drop' | 'new' = 'drop'): void {
    clearTimeout(this.landedTimer)
    this.landed = null
    // Next frame, so landing twice on the same row restarts the animation.
    requestAnimationFrame(() => {
      this.landed = { id, kind }
      this.landedTimer = setTimeout(() => (this.landed = null), kind === 'new' ? 1400 : 900)
    })
  }

  markJustBuilt(id: string): void {
    clearTimeout(this.builtTimer)
    this.justBuilt = id
    this.builtTimer = setTimeout(() => (this.justBuilt = null), 4000)
  }

  showToast(message: string, action?: { label: string; run: () => void }): void {
    this.toast = message
    this.toastAction = action ?? null
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(
      () => {
        this.toast = null
        this.toastAction = null
      },
      action ? 5000 : 1800
    )
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen
    try {
      localStorage.setItem(SIDEBAR_KEY, String(this.sidebarOpen))
    } catch {
      /* ignore */
    }
  }

  toggleDrawer(): void {
    this.drawerOpen = !this.drawerOpen
  }

  /** Set the chat drawer width while dragging (clamped, not saved yet). */
  setDrawerWidth(w: number): void {
    this.drawerWidth = clampDrawerWidth(w)
  }

  /** Save the current drawer width so it is remembered next time. */
  saveDrawerWidth(): void {
    try {
      localStorage.setItem(DRAWER_W_KEY, String(this.drawerWidth))
    } catch {
      /* ignore */
    }
  }
}

export const ui = new UiStore()
