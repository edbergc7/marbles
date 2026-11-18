import { tick } from 'svelte'
import { library } from '../stores/library.svelte'
import { ui } from '../stores/ui.svelte'
import { errorText } from '../errors'
import { GhostSpring } from './ghost.svelte'
import type { SidebarView } from './viewState.svelte'
import type { DragItem } from './types'

// Pointer events, not HTML5 drag and drop: native DnD in Electron is unreliable (it can
// end the drag at once under Wayland, over-fires dragleave, and gives no events over the
// app iframe). Drop targets carry `data-drop="<key>"`; resolveDrop() maps a key to an action.
//   pin:<appId> | pin:end | folder:<folderId> | folder:end | newfolder | unfiled

const DRAG_THRESHOLD = 5

type Pending = { item: DragItem; x: number; y: number; el: HTMLElement; pointerId: number }

export class DragController {
  /** The item being dragged, once the pointer has moved past the threshold. */
  active = $state<DragItem | null>(null)
  dropKey = $state<string | null>(null)
  listEl = $state<HTMLDivElement>()

  readonly ghost: GhostSpring

  #view: SidebarView
  #newFolder: (thenMove?: string) => Promise<void>
  #pending: Pending | null = null
  #lastPoint = { x: 0, y: 0 }
  #scrollRaf = 0
  #springKey: string | null = null
  #springTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: { view: SidebarView; newFolder: (thenMove?: string) => Promise<void> }) {
    this.#view = deps.view
    this.#newFolder = deps.newFolder
    this.ghost = new GhostSpring(() => this.#lastPoint)
  }

  // ---------- spring-loaded folders ----------
  // Hovering an app over a closed folder opens it after a moment.

  #armSpring(key: string | null): void {
    if (key === this.#springKey) return
    this.#springKey = key
    clearTimeout(this.#springTimer)
    if (!key || this.active?.kind !== 'app' || !key.startsWith('folder:') || key === 'folder:end')
      return
    const id = key.slice('folder:'.length)
    if (!this.#view.isCollapsed(id)) return
    this.#springTimer = setTimeout(async () => {
      this.#view.expand(id)
      await tick()
      this.#updateDropTarget()
    }, 600)
  }

  /** The action for dropping `d` on target `key`, or null when the target doesn't take it. */
  #resolveDrop(key: string, d: DragItem): (() => Promise<unknown>) | null {
    const colon = key.indexOf(':')
    const kind = colon < 0 ? key : key.slice(0, colon)
    const arg = colon < 0 ? '' : key.slice(colon + 1)
    if (kind === 'newfolder') return d.kind === 'app' ? () => this.#newFolder(d.id) : null
    if (kind === 'unfiled') return d.kind === 'app' ? () => library.setFolder(d.id, null) : null
    if (kind === 'pin') {
      if (d.kind !== 'app') return null
      if (arg === d.id) return null // dropped on itself
      return () => library.movePin(d.id, arg === 'end' ? null : arg)
    }
    if (kind === 'folder') {
      if (arg === 'end') return d.kind === 'folder' ? () => library.moveFolder(d.id, null) : null
      if (d.kind === 'app') return () => library.setFolder(d.id, arg)
      if (arg === d.id) return null // dropped on itself
      return () => library.moveFolder(d.id, arg)
    }
    return null
  }

  onRowPointerDown = (e: PointerEvent, item: DragItem): void => {
    if (e.button !== 0 || this.active) return
    // Let buttons and the rename field handle their own pointer.
    if ((e.target as Element).closest('button, input')) return
    this.#pending = {
      item,
      x: e.clientX,
      y: e.clientY,
      el: e.currentTarget as HTMLElement,
      pointerId: e.pointerId
    }
    window.addEventListener('pointermove', this.#onPointerMove)
    window.addEventListener('pointerup', this.#onPointerUp)
    window.addEventListener('pointercancel', this.#cancel)
    window.addEventListener('keydown', this.#onDragKey, true)
    window.addEventListener('blur', this.#cancel)
  }

  #onPointerMove = (e: PointerEvent): void => {
    const pending = this.#pending
    if (!pending) return
    if (!this.active) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_THRESHOLD) return
      this.active = pending.item
      // Keep getting events even over the app iframe or outside the window.
      try {
        pending.el.setPointerCapture(pending.pointerId)
      } catch {
        /* pointer already gone */
      }
      document.body.classList.add('is-sidebar-dragging')
      this.#scrollRaf = requestAnimationFrame(this.#autoScroll)
      this.#lastPoint = { x: e.clientX, y: e.clientY }
      this.ghost.start(pending.item)
    }
    this.#lastPoint = { x: e.clientX, y: e.clientY }
    this.#updateDropTarget()
  }

  #updateDropTarget(): void {
    if (!this.active) return
    const el = document
      .elementFromPoint(this.#lastPoint.x, this.#lastPoint.y)
      ?.closest<HTMLElement>('[data-drop]')
    const key = el?.dataset.drop ?? null
    this.dropKey = key && this.#resolveDrop(key, this.active) ? key : null
    this.#armSpring(this.dropKey)
  }

  /** Scrolls the list while the pointer is near its top or bottom edge. */
  #autoScroll = (): void => {
    if (!this.active) return
    const listEl = this.listEl
    const lastPoint = this.#lastPoint
    if (listEl) {
      const r = listEl.getBoundingClientRect()
      const edge = 32
      const inX = lastPoint.x >= r.left && lastPoint.x <= r.right
      let dy = 0
      if (inX && lastPoint.y < r.top + edge) dy = -Math.ceil((r.top + edge - lastPoint.y) / 4)
      else if (inX && lastPoint.y > r.bottom - edge)
        dy = Math.ceil((lastPoint.y - (r.bottom - edge)) / 4)
      if (dy) {
        listEl.scrollTop += dy
        this.#updateDropTarget()
      }
    }
    this.#scrollRaf = requestAnimationFrame(this.#autoScroll)
  }

  #onPointerUp = (): void => {
    const d = this.active
    const key = this.dropKey
    const wasDrag = !!d
    const listEl = this.listEl
    // Measure before cancel(): the drop target or the source row may re-render.
    const targetRect =
      key && listEl
        ? (listEl
            .querySelector<HTMLElement>(`[data-drop="${CSS.escape(key)}"]`)
            ?.getBoundingClientRect() ?? null)
        : null
    const homeRect = this.#pending?.el.getBoundingClientRect() ?? null
    this.#cancel(false)
    if (!wasDrag) return
    if (d && key && this.#resolveDrop(key, d)) this.ghost.settle(targetRect, true)
    else this.ghost.settle(homeRect, false)
    // The pointerup that ends a drag also makes a click; don't let it select or toggle.
    const swallow = (ev: Event): void => {
      ev.stopPropagation()
      ev.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    const action = d && key ? this.#resolveDrop(key, d) : null
    if (action && d) {
      action()
        .then(() => ui.flashLanded(d.id))
        .catch((err) => ui.showToast(errorText(err)))
      if (d.kind === 'app' && key?.startsWith('folder:') && key !== 'folder:end') {
        this.#view.expand(key.slice('folder:'.length))
      }
    }
  }

  #onDragKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.active) {
      e.preventDefault()
      e.stopPropagation()
      this.#cancel()
    }
  }

  /** Stops the drag. With `animate`, the ghost flies back to the row it came from. */
  // Also a window listener (pointercancel, blur), so `animate` may be an Event: that animates.
  #cancel = (animate: unknown = true): void => {
    const pending = this.#pending
    if (animate !== false && this.ghost.item) {
      this.ghost.settle(pending?.el.getBoundingClientRect() ?? null, false)
    }
    clearTimeout(this.#springTimer)
    this.#springKey = null
    if (pending) {
      try {
        if (pending.el.hasPointerCapture(pending.pointerId))
          pending.el.releasePointerCapture(pending.pointerId)
      } catch {
        /* ignore */
      }
    }
    this.#pending = null
    this.active = null
    this.dropKey = null
    cancelAnimationFrame(this.#scrollRaf)
    document.body.classList.remove('is-sidebar-dragging')
    window.removeEventListener('pointermove', this.#onPointerMove)
    window.removeEventListener('pointerup', this.#onPointerUp)
    window.removeEventListener('pointercancel', this.#cancel)
    window.removeEventListener('keydown', this.#onDragKey, true)
    window.removeEventListener('blur', this.#cancel)
  }

  /** Cleans up listeners and timers if the sidebar unmounts mid-drag. */
  dispose(): void {
    this.#cancel(false)
    this.ghost.dispose()
  }
}
