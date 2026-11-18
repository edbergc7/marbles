import { app } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { writeAtomic } from './library'
import type { Settings } from '../../shared/types'

/**
 * Version of settings.json, stored as `format`. A missing field means 1. Raise it when a
 * setting changes meaning, so the next version can tell what it is reading. Settings from a
 * newer Marbles are read as they are: unknown keys and the higher number are kept on write.
 */
const SETTINGS_FORMAT = 1

export class SettingsService {
  private cache: Settings | null = null

  private get file(): string {
    return join(app.getPath('userData'), 'settings.json')
  }

  defaults(): Settings {
    return {
      format: SETTINGS_FORMAT,
      builderModel: 'moonshotai/kimi-k3',
      utilityModel: 'moonshotai/kimi-k2.7-code',
      namingModel: 'google/gemini-2.5-flash-lite',
      reasoningEffort: 'low',
      allowLocalNetwork: false,
      showAdvanced: false,
      theme: 'dark',
      accent: '#ff6b2c',
      libraryPath: join(app.getPath('userData'), 'library'),
      chatgptWelcomed: false,
      setupDone: false,
      checkForUpdates: true,
      dismissedNotices: []
    }
  }

  async get(): Promise<Settings> {
    if (this.cache) return { ...this.cache }
    let stored: Partial<Settings> = {}
    try {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      // missing or invalid file: fall back to defaults
    }
    const format =
      typeof stored.format === 'number' && Number.isInteger(stored.format)
        ? Math.max(stored.format, SETTINGS_FORMAT)
        : SETTINGS_FORMAT
    this.cache = { ...this.defaults(), ...stored, format }
    return { ...this.cache }
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get()
    // The renderer can't change the format number.
    const next = { ...current, ...patch, format: current.format }
    await fs.mkdir(dirname(this.file), { recursive: true })
    await writeAtomic(this.file, JSON.stringify(next, null, 2))
    this.cache = next
    return { ...next }
  }
}
