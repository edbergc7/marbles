import type { KeyStatus } from '../../../../shared/types'
import { errorText } from '../errors'

/**
 * The OpenRouter key as a single machine on `phase`:
 * loading → missing | unverified → (testing →) valid | rejected.
 * Every transition replaces the whole `state` object; nothing mutates in place.
 */
type KeyState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | {
      phase: 'unverified'
      source: 'env' | 'stored'
      insecureStorage: boolean
      /** A test failed for a non-rejection reason (e.g. no network). */
      lastError?: string
    }
  | { phase: 'testing'; source: 'env' | 'stored'; insecureStorage: boolean }
  | {
      phase: 'valid'
      source: 'env' | 'stored'
      insecureStorage: boolean
      label?: string
      creditsLeft?: number | null
    }
  | { phase: 'rejected'; source: 'env' | 'stored'; insecureStorage: boolean; reason: string }

class KeyStore {
  state = $state<KeyState>({ phase: 'loading' })
  /** Bumped by every action; in-flight results with an older number are dropped. */
  private seq = 0

  /** A key is present and not known to be bad, so builds may go ahead. */
  get usable(): boolean {
    const p = this.state.phase
    return p === 'unverified' || p === 'testing' || p === 'valid'
  }

  get isSet(): boolean {
    const p = this.state.phase
    return p !== 'loading' && p !== 'missing'
  }

  /** Fetch the status from main. */
  async refresh(): Promise<void> {
    let status: KeyStatus
    try {
      status = await window.api.secrets.status()
    } catch {
      status = { set: false, source: null, insecureStorage: false }
    }
    // A verdict earned this session still applies while the key kept its source.
    const cur = this.state
    if ((cur.phase === 'valid' || cur.phase === 'rejected') && cur.source === status.source) return
    this.state = this.fromStatus(status)
  }

  /** What main reports, with no verdict yet. */
  private fromStatus(status: KeyStatus): KeyState {
    if (!status.set || !status.source) return { phase: 'missing' }
    return {
      phase: 'unverified',
      source: status.source,
      insecureStorage: status.insecureStorage
    }
  }

  /** Save a new key, then test it. A setKey error throws and leaves the state intact. */
  async save(key: string): Promise<void> {
    const status = await window.api.secrets.setKey(key)
    // A new key: drop any verdict (and any test still in flight) for the old one.
    this.seq++
    this.state = this.fromStatus(status)
    await this.test()
  }

  /** Test the current key against OpenRouter. */
  async test(): Promise<void> {
    const s = this.state
    if (s.phase === 'loading' || s.phase === 'missing') return
    const base = { source: s.source, insecureStorage: s.insecureStorage }
    const n = ++this.seq
    this.state = { phase: 'testing', ...base }
    try {
      const r = await window.api.secrets.testKey()
      if (n !== this.seq) return
      if (r.ok) this.state = { phase: 'valid', ...base, label: r.label, creditsLeft: r.creditsLeft }
      else if (r.rejected)
        this.state = {
          phase: 'rejected',
          ...base,
          reason: r.error ?? 'OpenRouter rejected the API key'
        }
      else this.state = { phase: 'unverified', ...base, lastError: r.error ?? 'Key test failed' }
    } catch (e) {
      if (n !== this.seq) return
      this.state = {
        phase: 'unverified',
        ...base,
        lastError: errorText(e)
      }
    }
  }

  /** Remove the stored key. */
  async clear(): Promise<void> {
    const status = await window.api.secrets.clearKey()
    this.seq++
    this.state = this.fromStatus(status)
  }

  /** A build was answered with a 401: the saved key is known to be bad. */
  markRejected(reason: string): void {
    const s = this.state
    if (s.phase === 'loading' || s.phase === 'missing') return
    this.seq++
    this.state = { phase: 'rejected', source: s.source, insecureStorage: s.insecureStorage, reason }
  }
}

export const key = new KeyStore()
