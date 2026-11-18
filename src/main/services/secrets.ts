import { app, BrowserWindow, dialog, net, safeStorage } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { writeAtomic } from './library'
import type { KeyStatus } from '../../shared/types'

/** true when safeStorage has no OS keyring (Linux without libsecret), so secrets are only obfuscated. */
export function safeStorageInsecure(): boolean {
  if (process.platform !== 'linux') return false
  try {
    return safeStorage.getSelectedStorageBackend() === 'basic_text'
  } catch {
    return false
  }
}

/**
 * With no OS keyring on Linux, Electron reports encryption as unavailable until
 * plain-text mode is enabled. Secrets are then only obfuscated; `insecureStorage`
 * tells the user so.
 */
export function allowSafeStorageFallback(): void {
  if (safeStorageInsecure()) safeStorage.setUsePlainTextEncryption(true)
}

/** Best-effort: older versions wrote secret files world-readable. No-op where modes don't apply. */
export async function tightenPermissions(file: string): Promise<void> {
  await fs.chmod(file, 0o600).catch(() => {})
}

const CONSENT_FILE = 'storage-consent.json'
let consent: boolean | undefined
let sessionOnly = false
let consentAsk: Promise<boolean> | null = null

async function askConsent(): Promise<boolean> {
  const file = join(app.getPath('userData'), CONSENT_FILE)
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { plainText?: boolean }
    if (raw.plainText === true) return true
  } catch {
    // no saved answer yet
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Marbles',
    message: 'This computer has no password keyring.',
    detail:
      'Marbles cannot store your sign-in or API key encrypted here. ' +
      'You can keep it only until you quit Marbles, or save it without encryption ' +
      '(anyone who can read your files could read it).',
    buttons: ['Keep for this session only', 'Save without encryption'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 1) return false
  try {
    await fs.mkdir(dirname(file), { recursive: true })
    await writeAtomic(file, JSON.stringify({ plainText: true }), { mode: 0o600 })
  } catch {
    // Not remembered: the question comes back next run.
  }
  return true
}

/**
 * Whether a secret may be written to disk. Always true with a real keyring. Without one the
 * person must agree once; "session only" is remembered in memory for this run only.
 */
export async function canPersistSecrets(): Promise<boolean> {
  if (!safeStorageInsecure()) return true
  if (consent) return true
  if (sessionOnly) return false
  consentAsk ??= askConsent()
    .then((ok) => {
      if (ok) consent = true
      else sessionOnly = true
      return ok
    })
    .finally(() => {
      consentAsk = null
    })
  return consentAsk
}

export class SecretsService {
  private cached: string | null | undefined

  private get file(): string {
    return join(app.getPath('userData'), 'secrets.json')
  }

  private insecure(): boolean {
    return safeStorageInsecure()
  }

  private allowFallbackIfNoKeyring(): void {
    allowSafeStorageFallback()
  }

  private envKey(): string | null {
    const k = process.env['OPENROUTER_API_KEY']?.trim()
    return k ? k : null
  }

  private async readStored(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached
    let result: string | null = null
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as { openrouter?: string }
      await tightenPermissions(this.file)
      this.allowFallbackIfNoKeyring()
      if (raw.openrouter && safeStorage.isEncryptionAvailable()) {
        result = safeStorage.decryptString(Buffer.from(raw.openrouter, 'base64'))
      }
    } catch {
      result = null
    }
    this.cached = result
    return result
  }

  /** The key to use for requests (env wins). Main process only; never sent to the renderer. */
  async getKey(): Promise<string | null> {
    return this.envKey() ?? (await this.readStored())
  }

  async status(): Promise<KeyStatus> {
    const insecureStorage = this.insecure()
    if (this.envKey()) return { set: true, source: 'env', insecureStorage }
    const stored = await this.readStored()
    return { set: !!stored, source: stored ? 'stored' : null, insecureStorage }
  }

  async setKey(key: string): Promise<KeyStatus> {
    const k = typeof key === 'string' ? key.trim() : ''
    if (!k) throw new Error('The API key is empty')
    if (/\s/.test(k)) throw new Error('The API key must not contain spaces or line breaks')
    if (k.length < 8 || k.length > 512) throw new Error('That does not look like an API key')
    this.allowFallbackIfNoKeyring()
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system')
    }
    if (await canPersistSecrets()) {
      const enc = safeStorage.encryptString(k).toString('base64')
      await fs.mkdir(dirname(this.file), { recursive: true })
      await writeAtomic(this.file, JSON.stringify({ openrouter: enc }), { mode: 0o600 })
    } else {
      // Session only: keep it in memory and drop any older stored copy.
      await fs.rm(this.file, { force: true })
    }
    this.cached = k
    return this.status()
  }

  async clearKey(): Promise<KeyStatus> {
    await fs.rm(this.file, { force: true })
    this.cached = null
    return this.status()
  }

  async testKey(): Promise<{
    ok: boolean
    error?: string
    label?: string
    creditsLeft?: number | null
    rejected?: boolean
  }> {
    const key = await this.getKey()
    if (!key) return { ok: false, error: 'No API key set' }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    try {
      const res = await net.fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${key}` },
        signal: ac.signal
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'OpenRouter rejected the API key', rejected: true }
      }
      if (!res.ok) return { ok: false, error: `OpenRouter returned HTTP ${res.status}` }
      const json = (await res.json()) as {
        data?: { label?: string; limit_remaining?: number | null }
      }
      const d = json.data ?? {}
      return {
        ok: true,
        label: typeof d.label === 'string' ? d.label : undefined,
        creditsLeft: typeof d.limit_remaining === 'number' ? d.limit_remaining : null
      }
    } catch (err) {
      if (ac.signal.aborted) return { ok: false, error: 'The request timed out' }
      void err
      return { ok: false, error: "Couldn't reach OpenRouter. Check your internet connection." }
    } finally {
      clearTimeout(timer)
    }
  }
}
