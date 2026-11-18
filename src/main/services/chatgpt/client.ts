import { net } from 'electron'
import type { ModelInfo } from '../../../shared/types'
import { GenError, extractJsonText, textOf, type ChatMsg, type StreamResult } from '../llm'
import { ChatGPTAuth, ChatGPTAuthError } from './auth'
import {
  API_BASE,
  CHATGPT_PREFIX,
  errorCodeOf,
  isChatGPTModel,
  mapApiError,
  type MappedError
} from './protocol'
import { ResponsesStreamParser } from './responsesStream'

const MODELS_TTL_MS = 24 * 60 * 60 * 1000

function slugOf(id: string): string {
  return isChatGPTModel(id) ? id.slice(CHATGPT_PREFIX.length) : id
}

function toGen(e: MappedError): GenError {
  return new GenError(e.code, e.message, e.detail, e.transient)
}

function fromAuth(err: unknown): GenError | null {
  if (!(err instanceof ChatGPTAuthError)) return null
  return new GenError(err.transient ? 'network' : 'signin', err.message, err.message, err.transient)
}

export interface ChatGPTStreamParams {
  model: string
  messages: ChatMsg[]
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  onText: (text: string) => void
  onReasoning?: (text: string) => void
}

export interface ChatGPTCompleteParams {
  model: string
  messages: ChatMsg[]
  json?: boolean
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Calls OpenAI's Responses API with the person's ChatGPT plan. Mirrors LLMService's
 * streamChat/complete so the router can swap them. Plan requests must stream and must not be
 * stored, and reject sampling and output-length overrides, so those are never sent.
 */
export class ChatGPTClient {
  /** Models that rejected `reasoning` this session; they get requests without it. */
  private noReasoning = new Set<string>()
  private modelsMemo: { account: string; at: number; models: ModelInfo[] } | null = null

  constructor(public auth: ChatGPTAuth) {}

  private body(p: ChatGPTStreamParams): Record<string, unknown> {
    const slug = slugOf(p.model)
    const system = p.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content))
    const input = p.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((c) =>
                c.type === 'text'
                  ? { type: 'input_text', text: c.text }
                  : c.type === 'image'
                    ? { type: 'input_image', image_url: c.dataUrl }
                    : { type: 'input_file', filename: c.name, file_data: c.dataUrl }
              )
      }))
    const body: Record<string, unknown> = { model: slug, input, store: false, stream: true }
    if (system.length) body.instructions = system.join('\n\n')
    if (p.reasoning && p.reasoning !== 'off' && !this.noReasoning.has(slug)) {
      body.reasoning = { effort: p.reasoning }
    }
    return body
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let token: string
    try {
      token = await this.auth.accessToken()
    } catch (err) {
      throw fromAuth(err) ?? err
    }
    try {
      return await net.fetch(`${API_BASE}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error'
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError')
        throw new GenError('aborted', 'Stopped')
      throw new GenError(
        'network',
        "Couldn't connect to ChatGPT. Check your internet connection and try again.",
        err instanceof Error ? err.message : String(err),
        true
      )
    }
  }

  async streamChat(p: ChatGPTStreamParams): Promise<StreamResult> {
    const slug = slugOf(p.model)
    let res = await this.post(this.body(p), p.signal)

    // Retry once for things a second request can fix: a stale token, or a model that
    // doesn't take a reasoning setting.
    if (!res.ok) {
      const parsed = await readError(res)
      if (res.status === 401 && parsed.code !== 'subscription_sharing_invalid_user') {
        this.auth.invalidateAccessToken()
        res = await this.post(this.body(p), p.signal)
      } else if (
        parsed.code === 'subscription_sharing_unsupported_capability' &&
        /reasoning/i.test(parsed.param ?? parsed.message ?? '') &&
        !this.noReasoning.has(slug)
      ) {
        this.noReasoning.add(slug)
        res = await this.post(this.body(p), p.signal)
      } else {
        throw toGen(mapApiError(res.status, parsed.code, parsed.message, parsed.param))
      }
      if (!res.ok) {
        const again = await readError(res)
        throw toGen(mapApiError(res.status, again.code, again.message, again.param))
      }
    }
    if (!res.body) {
      throw new GenError(
        'network',
        'ChatGPT sent back nothing. Please try again.',
        'Empty body',
        true
      )
    }

    const parser = new ResponsesStreamParser()
    let result: StreamResult | null = null
    const handle = (events: ReturnType<ResponsesStreamParser['feed']>): void => {
      for (const e of events) {
        if (result) return
        switch (e.type) {
          case 'text':
            p.onText(e.text)
            break
          case 'reasoning':
            p.onReasoning?.(e.text)
            break
          case 'completed':
            result = {
              finishReason: 'stop',
              usage: e.usage
                ? { promptTokens: e.usage.inputTokens, completionTokens: e.usage.outputTokens }
                : null
            }
            break
          case 'incomplete':
            // The build parser reads 'length' as "came out too big".
            result = {
              finishReason:
                e.reason === 'max_output_tokens' ? 'length' : (e.reason ?? 'incomplete'),
              usage: null
            }
            break
          case 'failed':
            // Plan limits can arrive here after text has started.
            throw toGen(mapApiError(undefined, e.code, e.message, e.param))
        }
      }
    }

    try {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (!result) {
        const { done, value } = await reader.read()
        if (done) break
        handle(parser.feed(decoder.decode(value, { stream: true })))
      }
      if (!result) handle(parser.end())
      if (result) void reader.cancel().catch(() => {})
    } catch (err) {
      if (err instanceof GenError) throw err
      if (p.signal?.aborted) throw new GenError('aborted', 'Stopped')
      throw new GenError(
        'network',
        'The connection to ChatGPT dropped. Please try again.',
        err instanceof Error ? err.message : String(err),
        true
      )
    }
    // Success only counts once the server says the response completed.
    if (!result) {
      if (p.signal?.aborted) throw new GenError('aborted', 'Stopped')
      throw new GenError(
        'network',
        'ChatGPT stopped answering partway. Please try again.',
        'Stream ended without response.completed',
        true
      )
    }
    return result
  }

  /** Non-streaming call for naming and host.ai(): streams under the hood (required) and joins. */
  async complete(p: ChatGPTCompleteParams): Promise<string> {
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    if (p.signal) {
      if (p.signal.aborted) ac.abort()
      else p.signal.addEventListener('abort', onAbort, { once: true })
    }
    let timedOut = false
    const timer = p.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          ac.abort()
        }, p.timeoutMs)
      : null
    let text = ''
    try {
      await this.streamChat({
        model: p.model,
        messages: p.messages,
        reasoning: p.reasoning,
        signal: ac.signal,
        onText: (t) => {
          text += t
        }
      })
    } catch (err) {
      if (timedOut && err instanceof GenError && err.code === 'aborted') {
        throw new GenError(
          'network',
          'The AI took too long to answer. Please try again.',
          'Request timed out',
          true
        )
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      p.signal?.removeEventListener('abort', onAbort)
    }
    if (!text) {
      throw new GenError(
        'model',
        'The AI sent back an empty answer. Please try again.',
        'Empty',
        true
      )
    }
    return p.json ? extractJsonText(text) : text
  }

  // ---------- models ----------

  /** Models this account may use, as `chatgpt:<slug>`, in the server's order. Empty when signed out. */
  async listModels(): Promise<ModelInfo[]> {
    const account = this.auth.accountId()
    if (!account) return []
    const now = Date.now()
    const memo = this.modelsMemo
    if (memo && memo.account === account && now - memo.at < MODELS_TTL_MS) return memo.models

    let token: string
    try {
      token = await this.auth.accessToken()
    } catch {
      return memo?.account === account ? memo.models : []
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)
    try {
      const res = await net.fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ac.signal,
        redirect: 'error'
      })
      if (!res.ok) throw new Error(`ChatGPT returned HTTP ${res.status} for the model list`)
      const j = (await res.json()) as { models?: Record<string, unknown>[] }
      const models: ModelInfo[] = []
      for (const m of j.models ?? []) {
        if (m.visibility !== 'list') continue
        if (typeof m.slug !== 'string' || !m.slug || m.slug.length > 200) continue
        const name = typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug
        models.push({
          id: CHATGPT_PREFIX + m.slug,
          name,
          contextLength: null,
          promptPrice: null,
          completionPrice: null,
          inputs: ['image']
        })
      }
      this.modelsMemo = { account, at: now, models }
      return models
    } catch (err) {
      if (memo?.account === account) return memo.models // stale beats nothing
      throw err instanceof Error && err.message.startsWith('ChatGPT returned')
        ? err
        : new Error("Couldn't load the ChatGPT model list. Check your internet connection.", {
            cause: err
          })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Forget the cached model list (sign-out or account change). */
  clearModels(): void {
    this.modelsMemo = null
  }
}

async function readError(
  res: Response
): Promise<{ code?: string; message?: string; param?: string }> {
  try {
    const text = await res.text()
    try {
      return errorCodeOf(JSON.parse(text))
    } catch {
      return { message: text.slice(0, 200) }
    }
  } catch {
    return {}
  }
}
