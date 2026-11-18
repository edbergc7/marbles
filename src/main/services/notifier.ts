import type { NotifyOptions } from '../../shared/types'

/** Pending notifications per app, so a buggy loop can't pile up timers. */
const MAX_PENDING_PER_APP = 20
/** Notifications shown per app per minute, so an app can't flood the desktop. */
const MAX_SHOWN_PER_MINUTE = 6
const WINDOW_MS = 60_000
/** setTimeout's limit is about 24.8 days; a week is plenty for timers and reminders. */
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MESSAGE_LEN = 300
const MAX_ID_LEN = 100

export interface NotifierDeps {
  /** The app's display name, or null if it no longer exists. Used as the notification title. */
  appName: (appId: string) => Promise<string | null>
  /** Shows a system notification; `onClick` brings Marbles forward on that app. */
  show: (title: string, body: string, onClick: () => void) => void
  /** The person clicked a notification from this app. */
  onClick: (appId: string) => void
  /**
   * The app is on screen in a focused Marbles window. Its page is running and handles the
   * moment itself, so nothing is shown.
   */
  isWatched?: (appId: string) => boolean
  /** A notification was shown: the window adds the sidebar dot and plays the sound. */
  onFired?: (appId: string, alarm: boolean) => void
  now?: () => number
}

/**
 * Backs host.notify(): system notifications an app shows now or schedules for later. Timers
 * live in main, so they fire while the person is in another app (whose page is unloaded). They
 * last until Marbles quits.
 */
export class NotifierService {
  private pending = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
  private shown = new Map<string, number[]>()
  private nextId = 1

  constructor(private deps: NotifierDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** Shows or schedules a notification. Returns its id (the app's own, or a generated one). */
  schedule(appId: string, raw: unknown): string {
    const o = (raw && typeof raw === 'object' ? raw : {}) as NotifyOptions
    if (typeof o.message !== 'string' || !o.message.trim()) {
      throw new Error('host.notify: message must be a non-empty string')
    }
    const message = o.message.trim().slice(0, MAX_MESSAGE_LEN)
    const alarm = o.alarm === true
    let id: string
    if (o.id === undefined) id = `n${this.nextId++}`
    else if (typeof o.id === 'string' && o.id && o.id.length <= MAX_ID_LEN) id = o.id
    else throw new Error(`host.notify: id must be a string of up to ${MAX_ID_LEN} characters`)

    let delay = 0
    if (o.at !== undefined) {
      if (typeof o.at !== 'number' || !Number.isFinite(o.at)) {
        throw new Error('host.notify: at must be a time in milliseconds, like Date.now() + 60000')
      }
      delay = Math.max(0, o.at - this.now())
      if (delay > MAX_DELAY_MS) throw new Error('host.notify: at must be within the next 7 days')
    }

    let mine = this.pending.get(appId)
    if (!mine) {
      mine = new Map()
      this.pending.set(appId, mine)
    }
    // Same id replaces the earlier one (a timer that was restarted or changed).
    const old = mine.get(id)
    if (old !== undefined) clearTimeout(old)
    else if (mine.size >= MAX_PENDING_PER_APP) {
      throw new Error(`host.notify: at most ${MAX_PENDING_PER_APP} pending notifications per app`)
    }
    const timer = setTimeout(() => {
      this.forget(appId, id)
      void this.fire(appId, message, alarm)
    }, delay)
    mine.set(id, timer)
    return id
  }

  cancel(appId: string, id: unknown): void {
    if (typeof id !== 'string') throw new Error('host.notify.cancel: id must be a string')
    const timer = this.pending.get(appId)?.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.forget(appId, id)
  }

  /** Ids of this app's notifications that haven't fired yet. */
  list(appId: string): string[] {
    return [...(this.pending.get(appId)?.keys() ?? [])]
  }

  private forget(appId: string, id: string): void {
    const mine = this.pending.get(appId)
    if (!mine) return
    mine.delete(id)
    if (!mine.size) this.pending.delete(appId)
  }

  private async fire(appId: string, message: string, alarm: boolean): Promise<void> {
    if (this.deps.isWatched?.(appId)) return
    const now = this.now()
    const times = (this.shown.get(appId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (times.length >= MAX_SHOWN_PER_MINUTE) {
      this.shown.set(appId, times)
      return
    }
    // The title is always the app's name, so an app can't pass itself off as something else.
    const name = await this.deps.appName(appId).catch(() => null)
    if (!name) return
    times.push(now)
    this.shown.set(appId, times)
    try {
      this.deps.show(name, message, () => this.deps.onClick(appId))
    } catch {
      /* no notification server (e.g. no D-Bus): the window's dot and sound still work */
    }
    this.deps.onFired?.(appId, alarm)
  }
}
