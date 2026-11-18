import type { ChatMessage } from '../../../../shared/types'

/** Persisted chat (chat.json) for the app currently shown in the drawer. */
class ChatStore {
  appId = $state<string | null>(null)
  messages = $state<ChatMessage[]>([])
  private seq = 0

  async load(appId: string | null): Promise<void> {
    const mine = ++this.seq
    if (appId !== this.appId) this.messages = []
    this.appId = appId
    if (!appId) return
    const msgs = await window.api.chat.read(appId).catch(() => [])
    if (mine === this.seq) this.messages = msgs
  }

  /** Re-read if this app's chat is the one on screen. */
  async reloadIf(appId: string): Promise<void> {
    if (this.appId === appId) await this.load(appId)
  }
}

export const chat = new ChatStore()
