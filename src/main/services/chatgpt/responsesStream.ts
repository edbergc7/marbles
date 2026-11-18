/**
 * Server-sent events from POST /v1/responses (stream: true), turned into the few things the
 * app cares about. Pure (no Electron), so scripts/test-chatgpt.mjs can load it.
 */

export interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
}

export type ResponsesEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'completed'; usage: StreamUsage | null }
  /** Stopped early; reason e.g. "max_output_tokens" or "content_filter". */
  | { type: 'incomplete'; reason?: string }
  | { type: 'failed'; code?: string; message?: string; param?: string }

/** Event types whose `delta` is reasoning text (summary or raw, depending on the model). */
const REASONING_DELTAS = new Set([
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta'
])

function usageOf(u: unknown): StreamUsage | null {
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const inputTokens = num(o.input_tokens)
  const outputTokens = num(o.output_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return null
  return { inputTokens, outputTokens }
}

function errorFields(e: unknown): { code?: string; message?: string; param?: string } {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return { code: str(o.code) ?? str(o.type), message: str(o.message), param: str(o.param) }
}

/** Maps one decoded `data:` payload to an event, or null for events we ignore. */
function eventFromPayload(j: Record<string, unknown>): ResponsesEvent | null {
  const type = j.type
  if (type === 'response.output_text.delta') {
    return typeof j.delta === 'string' && j.delta ? { type: 'text', text: j.delta } : null
  }
  if (typeof type === 'string' && REASONING_DELTAS.has(type)) {
    return typeof j.delta === 'string' && j.delta ? { type: 'reasoning', text: j.delta } : null
  }
  const response = (j.response && typeof j.response === 'object' ? j.response : {}) as Record<
    string,
    unknown
  >
  if (type === 'response.completed') return { type: 'completed', usage: usageOf(response.usage) }
  if (type === 'response.incomplete') {
    const d = response.incomplete_details as Record<string, unknown> | undefined
    return { type: 'incomplete', reason: typeof d?.reason === 'string' ? d.reason : undefined }
  }
  if (type === 'response.failed') return { type: 'failed', ...errorFields(response.error) }
  if (type === 'error') {
    // The error object may be the event itself or nested under `error`.
    return { type: 'failed', ...errorFields(j.error && typeof j.error === 'object' ? j.error : j) }
  }
  return null
}

/** Splits an SSE byte stream (already decoded to text) into events. Feed chunks, then end(). */
export class ResponsesStreamParser {
  private buf = ''
  private data: string[] = []

  feed(chunk: string): ResponsesEvent[] {
    this.buf += chunk
    const out: ResponsesEvent[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.line(line, out)
    }
    return out
  }

  end(): ResponsesEvent[] {
    const out: ResponsesEvent[] = []
    if (this.buf) {
      this.line(this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf, out)
      this.buf = ''
    }
    this.dispatch(out)
    return out
  }

  private line(line: string, out: ResponsesEvent[]): void {
    if (line === '') {
      this.dispatch(out)
      return
    }
    if (line.startsWith(':')) return
    if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''))
      return
    }
    // A bare JSON object (some proxies drop the "data:" prefix).
    if (line.startsWith('{')) {
      this.dispatch(out)
      this.data.push(line)
      this.dispatch(out)
    }
    // "event:", "id:", "retry:" lines carry nothing we need: the payload has its own `type`.
  }

  private dispatch(out: ResponsesEvent[]): void {
    if (!this.data.length) return
    const raw = this.data.join('\n')
    this.data = []
    if (raw === '[DONE]') return
    let j: unknown
    try {
      j = JSON.parse(raw)
    } catch {
      return
    }
    if (!j || typeof j !== 'object') return
    const e = eventFromPayload(j as Record<string, unknown>)
    if (e) out.push(e)
  }
}
