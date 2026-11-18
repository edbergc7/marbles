import type { AppMeta } from '../../../../shared/types'
import type { Sort } from './types'

// Per-viewer view state, persisted in localStorage.
const COLLAPSED_KEY = 'marbles:sidebarCollapsed'
const SORT_KEY = 'marbles:sidebarSort'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Collapsed sections, sort order, and the pin star that just popped. */
export class SidebarView {
  collapsed = $state<string[]>(load(COLLAPSED_KEY, []))
  sort = $state<Sort>(load<Sort>(SORT_KEY, 'recent') === 'name' ? 'name' : 'recent')
  /** The pin star that was just switched on; it pops. */
  poppedPin = $state<string | null>(null)

  #popTimer: ReturnType<typeof setTimeout> | undefined

  isCollapsed = (key: string): boolean => this.collapsed.includes(key)

  toggleCollapsed = (key: string): void => {
    this.collapsed = this.collapsed.includes(key)
      ? this.collapsed.filter((k) => k !== key)
      : [...this.collapsed, key]
    save(COLLAPSED_KEY, this.collapsed)
  }

  expand = (key: string): void => {
    if (this.collapsed.includes(key)) this.toggleCollapsed(key)
  }

  setSort = (s: Sort): void => {
    this.sort = s
    save(SORT_KEY, s)
  }

  sorted = (apps: AppMeta[]): AppMeta[] =>
    [...apps].sort((a, b) =>
      this.sort === 'recent'
        ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
        : collator.compare(a.name, b.name)
    )

  popPin = (id: string): void => {
    clearTimeout(this.#popTimer)
    this.poppedPin = id
    this.#popTimer = setTimeout(() => (this.poppedPin = null), 500)
  }

  dispose(): void {
    clearTimeout(this.#popTimer)
  }
}
