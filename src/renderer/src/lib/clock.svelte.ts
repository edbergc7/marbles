/**
 * A shared, coarse clock for relative times ("5m ago"). Templates that call the
 * helpers in time.ts read `clock.now`, so they re-render on each tick.
 */
const TICK_MS = 30_000

class Clock {
  now = $state(Date.now())

  constructor() {
    setInterval(() => this.refresh(), TICK_MS)
    // Catch up straight away after the window was hidden or the computer slept.
    window.addEventListener('focus', () => this.refresh())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh()
    })
  }

  refresh(): void {
    this.now = Date.now()
  }
}

export const clock = new Clock()
