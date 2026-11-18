import type { ChatGPTStatus } from '../../../../shared/types'
import { errorText } from '../errors'
import { settings } from './settings.svelte'

export const USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Sign in with ChatGPT, as main reports it. Tokens never reach the renderer. */
class ChatGPTStore {
  status = $state<ChatGPTStatus | null>(null)
  /** Last sign-in or sign-out problem, shown under the button. */
  error = $state<string | null>(null)
  private listeners = new Set<() => void>()

  /** Signed in and the plan may pay for requests here. */
  get usable(): boolean {
    return this.status?.state === 'signed_in' && this.status.planOk
  }

  async init(): Promise<void> {
    window.api.chatgpt.onStatus((s) => this.set(s))
    await this.refresh()
  }

  async refresh(): Promise<void> {
    try {
      this.set(await window.api.chatgpt.status())
    } catch {
      this.set({ state: 'signed_out' })
    }
  }

  /** Called when sign-in state changes (gen reloads its model list). */
  onChange(cb: () => void): void {
    this.listeners.add(cb)
  }

  private set(s: ChatGPTStatus): void {
    const prev = this.status
    this.status = s
    const was = prev?.state === 'signed_in'
    const is = s.state === 'signed_in'
    if (was !== is) for (const cb of this.listeners) cb()
  }

  async signIn(): Promise<void> {
    this.error = null
    try {
      this.set(await window.api.chatgpt.signIn())
      // Main may have pointed the model roles at ChatGPT; pick that up.
      settings.value = await window.api.settings.get()
    } catch (err) {
      const msg = errorText(err)
      if (msg !== 'Sign-in was cancelled.') this.error = msg
      await this.refresh()
    }
  }

  async cancel(): Promise<void> {
    await window.api.chatgpt.cancelSignIn()
  }

  async signOut(): Promise<void> {
    this.error = null
    try {
      const r = await window.api.chatgpt.signOut()
      if (!r.revoked) {
        this.error =
          "Signed out here, but ChatGPT couldn't be reached to end the session. You can disconnect Marbles in ChatGPT's settings."
      }
    } catch (err) {
      this.error = errorText(err)
    }
    await this.refresh()
  }
}

export const chatgpt = new ChatGPTStore()
