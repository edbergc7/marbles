import type { ChatMessage } from '../../../shared/types'

/** A user request and the assistant's result, either of which can be missing. */
export type Turn = { user: ChatMessage | null; reply: ChatMessage | null }

/** Pairs of user request → assistant result, in order. */
export function pairTurns(messages: readonly ChatMessage[]): Turn[] {
  const out: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push({ user: m, reply: null })
    else if (m.role === 'assistant') {
      const last = out[out.length - 1]
      if (last && !last.reply) last.reply = m
      else out.push({ user: null, reply: m })
    }
  }
  return out
}
