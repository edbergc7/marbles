import { SvelteSet } from 'svelte/reactivity'
import type { NotifiedEvent } from '../../../../shared/types'
import { library } from './library.svelte'
import { ui } from './ui.svelte'

/** An alarm nobody answers stops by itself. */
const ALARM_MAX_MS = 60_000
/** Time between the starts of two rings of the alarm. */
const ALARM_EVERY_MS = 1_600

/**
 * Notifications from apps (host.notify), as the window shows them: a dot on the app's sidebar
 * row until it is opened, and Marbles' own sound. The app's page may be closed by then, so
 * the sound comes from here, not from the app.
 */
class AlertsStore {
  /** Apps with a notification the person hasn't looked at yet. */
  unread = new SvelteSet<string>()
  /** The app whose alarm is ringing. */
  ringing = $state<string | null>(null)

  private audio: AudioContext | null = null
  private alarmTimer: ReturnType<typeof setInterval> | undefined
  private alarmStop: ReturnType<typeof setTimeout> | undefined

  init(): void {
    window.api.bridge.onNotified((e) => this.onNotified(e))
  }

  private isOnScreen(appId: string): boolean {
    return ui.view === 'app' && library.selectedId === appId
  }

  private onNotified({ appId, alarm }: NotifiedEvent): void {
    // On screen, the app's page is running and plays its own sound.
    if (this.isOnScreen(appId)) return
    this.unread.add(appId)
    if (alarm) this.startAlarm(appId)
    else this.chime()
  }

  /** The person opened the app: clear its dot and silence its alarm. */
  seen(appId: string): void {
    this.unread.delete(appId)
    if (this.ringing === appId) this.stopAlarm()
  }

  stopAlarm(): void {
    clearInterval(this.alarmTimer)
    clearTimeout(this.alarmStop)
    this.ringing = null
  }

  private startAlarm(appId: string): void {
    this.stopAlarm()
    this.ringing = appId
    this.ring()
    this.alarmTimer = setInterval(() => this.ring(), ALARM_EVERY_MS)
    this.alarmStop = setTimeout(() => this.stopAlarm(), ALARM_MAX_MS)
  }

  private context(): AudioContext | null {
    try {
      this.audio ??= new AudioContext()
      if (this.audio.state === 'suspended') void this.audio.resume()
      return this.audio
    } catch {
      return null
    }
  }

  /** One soft note: a sine with a quick attack and a gentle fade. */
  private tone(freq: number, start: number, length: number, volume: number): void {
    const ctx = this.context()
    if (!ctx) return
    const t = ctx.currentTime + start
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + length + 0.05)
  }

  /** A single two-note chime for an ordinary notification. */
  chime(): void {
    this.tone(880, 0, 0.35, 0.18)
    this.tone(1318.5, 0.12, 0.6, 0.16)
  }

  /** One ring of the alarm: three quick high beeps. */
  private ring(): void {
    for (let i = 0; i < 3; i++) this.tone(1046.5, i * 0.18, 0.14, 0.22)
  }
}

export const alerts = new AlertsStore()
