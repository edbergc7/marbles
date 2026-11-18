import type { NoticesState } from '../../../../shared/types'

class NoticesStore {
  state = $state<NoticesState | null>(null)
  private started = false

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    window.api.notices.onChanged((s) => (this.state = s))
    this.state = await window.api.notices.get()
  }

  async check(): Promise<void> {
    this.state = await window.api.notices.check()
  }

  async dismiss(id: string): Promise<void> {
    this.state = await window.api.notices.dismiss(id)
  }

  open(id: string): void {
    void window.api.notices.open(id)
  }
}

export const notices = new NoticesStore()
