import type { FrameError } from '../../../../shared/types'

const MAX = 50

/** Runtime state of the app currently shown in the frame. */
class FrameStore {
  errors = $state<FrameError[]>([])
  /** Which app/version the errors belong to. */
  key = $state('')

  reset(key: string): void {
    this.key = key
    this.errors = []
  }

  add(key: string, e: FrameError): void {
    if (key !== this.key || this.errors.length >= MAX) return
    const last = this.errors[this.errors.length - 1]
    if (last && last.message === e.message && last.source === e.source) return
    this.errors.push(e)
  }

  clear(): void {
    this.errors = []
  }
}

export const frame = new FrameStore()

/** Plain-text report of the current errors (for copying, and for "Fix"). */
export function errorReport(errors: FrameError[]): string {
  return errors
    .map((e) => {
      const where = e.source ? ` (${shortSource(e.source)}${e.line ? `:${e.line}` : ''})` : ''
      return `[${e.kind}] ${e.message}${where}${e.stack ? `\n${e.stack}` : ''}`
    })
    .join('\n\n')
}

export function shortSource(src: string): string {
  if (src.startsWith('appframe://')) return 'app'
  try {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- parsing only, not state
    const u = new URL(src)
    const file = u.pathname.split('/').filter(Boolean).pop() ?? u.host
    return `${u.host.replace(/^cdn\.|^www\./, '')}/…/${file}`
  } catch {
    return src
  }
}
