import type { Settings } from '../../../../shared/types'

class SettingsStore {
  value = $state<Settings | null>(null)
  /** OS preference, tracked so 'system' theme re-renders apps when it flips. */
  osDark = $state(window.matchMedia('(prefers-color-scheme: dark)').matches)

  resolvedTheme = $derived.by<'dark' | 'light'>(() => {
    const t = this.value?.theme ?? 'dark'
    if (t === 'system') return this.osDark ? 'dark' : 'light'
    return t
  })

  async init(): Promise<void> {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => (this.osDark = e.matches))
    this.value = await window.api.settings.get()
    this.apply()
  }

  async set(patch: Partial<Settings>): Promise<void> {
    this.value = await window.api.settings.set(patch)
    this.apply()
  }

  private apply(): void {
    if (!this.value) return
    const root = document.documentElement
    if (this.value.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', this.value.theme)
    root.style.setProperty('--accent', this.value.accent)
  }
}

export const settings = new SettingsStore()
