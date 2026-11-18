import type { DragItem } from './types'
import { reduceMotion } from './motion'

// The ghost chases the pointer on a slightly bouncy spring and tilts with its own
// velocity, swinging around the grab point like a card held by one corner. It is moved
// by writing `transform` each frame, not through state, so it costs no re-renders.

const GRAB = { x: 12, y: 8 } // ghost offset from the pointer
const STIFFNESS = 700
const DAMPING = 36 // below critical (~53), so it overshoots a little

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class GhostSpring {
  item = $state<DragItem | null>(null)
  el = $state<HTMLDivElement>()

  #raf = 0
  #settleTimer: ReturnType<typeof setTimeout> | undefined
  #g = { x: 0, y: 0, vx: 0, vy: 0, rz: 0, rx: 0, ry: 0, t: 0 }
  #getPoint: () => { x: number; y: number }

  constructor(getPoint: () => { x: number; y: number }) {
    this.#getPoint = getPoint
  }

  start(item: DragItem): void {
    clearTimeout(this.#settleTimer)
    cancelAnimationFrame(this.#raf)
    const p = this.#getPoint()
    Object.assign(this.#g, { x: p.x, y: p.y, vx: 0, vy: 0, rz: 0, rx: 0, ry: 0, t: 0 })
    if (this.el) {
      this.el.style.transition = ''
      this.el.style.opacity = ''
    }
    this.item = item
    this.#raf = requestAnimationFrame(this.#tick)
  }

  #tick = (now: number): void => {
    const g = this.#g
    const p = this.#getPoint()
    let dt = g.t ? Math.min(0.05, (now - g.t) / 1000) : 1 / 60
    g.t = now
    if (reduceMotion) {
      g.x = p.x
      g.y = p.y
    } else {
      // Semi-implicit Euler in small steps keeps the spring stable on slow frames.
      while (dt > 0) {
        const h = Math.min(dt, 1 / 120)
        g.vx += (STIFFNESS * (p.x - g.x) - DAMPING * g.vx) * h
        g.vy += (STIFFNESS * (p.y - g.y) - DAMPING * g.vy) * h
        g.x += g.vx * h
        g.y += g.vy * h
        dt -= h
      }
      // Tilt toward the direction of travel, eased so it doesn't jitter.
      const k = 0.25
      g.rz += (clamp(g.vx * 0.012, -14, 14) - g.rz) * k
      g.ry += (clamp(g.vx * 0.02, -22, 22) - g.ry) * k
      g.rx += (clamp(-g.vy * 0.03, -28, 28) - g.rx) * k
    }
    if (this.el) {
      this.el.style.transform =
        `translate3d(${g.x + GRAB.x}px, ${g.y + GRAB.y}px, 0) perspective(500px) ` +
        `rotateX(${g.rx}deg) rotateY(${g.ry}deg) rotate(${g.rz}deg)`
    }
    this.#raf = requestAnimationFrame(this.#tick)
  }

  /** Ends the ghost: it flies to `to` (or just fades), shrinking if it was dropped. */
  settle(to: DOMRect | null, dropped: boolean): void {
    cancelAnimationFrame(this.#raf)
    const el = this.el
    if (!el || !this.item || reduceMotion) {
      this.item = null
      return
    }
    const g = this.#g
    const x = to ? to.left + (dropped ? 10 : 0) : g.x + GRAB.x
    const y = to ? to.top + (to.height - el.offsetHeight) / 2 : g.y + GRAB.y
    const scale = dropped ? 0.55 : 1
    el.style.transition = 'transform 260ms cubic-bezier(0.3, 0, 0, 1), opacity 260ms var(--ease-in)'
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
    el.style.opacity = '0'
    this.#settleTimer = setTimeout(() => (this.item = null), 270)
  }

  dispose(): void {
    cancelAnimationFrame(this.#raf)
    clearTimeout(this.#settleTimer)
  }
}
