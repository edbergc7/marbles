import { app, net } from 'electron'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import type { GenErrorCode, ModelInfo } from '../../shared/types'
import type { SecretsService } from './secrets'
import type { ChatGPTClient } from './chatgpt/client'
import { isChatGPTModel } from './chatgpt/protocol'
import { GITHUB_REPO } from '../project'

const API = 'https://openrouter.ai/api/v1'
const MODELS_TTL_MS = 24 * 60 * 60 * 1000

export type ChatRole = 'user' | 'assistant' | 'system'
/** One piece of a multi-part message. Images and files (PDFs) are data URLs. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }
  | { type: 'file'; name: string; dataUrl: string }

function hasFilePart(messages: ChatMsg[]): boolean {
  return messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'file')
  )
}

export interface ChatMsg {
  role: ChatRole
  content: string | ContentPart[]
}

/** The text of a message, with any images left out. */
export function textOf(content: ChatMsg['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

/** OpenRouter (OpenAI chat completions) message shape. */
function toOpenRouter(m: ChatMsg): Record<string, unknown> {
  if (typeof m.content === 'string') return { role: m.role, content: m.content }
  return {
    role: m.role,
    content: m.content.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : p.type === 'image'
          ? { type: 'image_url', image_url: { url: p.dataUrl } }
          : { type: 'file', file: { filename: p.name, file_data: p.dataUrl } }
    )
  }
}

export interface Usage {
  promptTokens?: number
  completionTokens?: number
  cost?: number
}

export class GenError extends Error {
  constructor(
    public code: GenErrorCode,
    message: string,
    /** Technical text (HTTP status, provider message), shown only with advanced options on. */
    public detail?: string,
    /** Likely to work if tried again in a moment (network blip, overload, provider outage). */
    public transient = false
  ) {
    super(message)
    this.name = 'GenError'
  }
}

export function toGenError(err: unknown): GenError {
  if (err instanceof GenError) return err
  if (err instanceof Error && err.name === 'AbortError') return new GenError('aborted', 'Stopped')
  const msg = err instanceof Error ? err.message : String(err)
  return new GenError('unknown', 'Something went wrong. Please try again.', msg)
}

function mapStatus(status: number, detail?: string): GenError {
  const tech = `HTTP ${status}${detail ? `: ${detail}` : ''}`
  switch (status) {
    case 401:
      return new GenError('auth', "Your OpenRouter key isn't working. Check it in Settings.", tech)
    case 402:
      return new GenError(
        'credits',
        'Your OpenRouter account is out of credit. Add credit at openrouter.ai, then try again.',
        tech
      )
    case 429:
      return new GenError(
        'rate_limit',
        'The AI service is busy right now. Wait a minute and try again.',
        tech,
        true
      )
    case 400:
    case 404:
    case 413:
    case 422:
      return new GenError(
        'model',
        "The AI couldn't handle this request. Try rewording it, or ask for something smaller.",
        tech
      )
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
      return new GenError(
        'model',
        'The AI service is having trouble right now. Try again in a minute.',
        tech,
        true
      )
    default:
      return new GenError(
        'unknown',
        "Something went wrong on the AI service's side. Try again in a minute.",
        tech,
        status >= 500
      )
  }
}

async function errorFromResponse(res: Response): Promise<GenError> {
  let detail: string | undefined
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown } | string }
      if (typeof j.error === 'string') detail = j.error
      else if (typeof j.error?.message === 'string') detail = j.error.message
    } catch {
      detail = text.slice(0, 200)
    }
  } catch {
    // ignore
  }
  return mapStatus(res.status, detail)
}

/** Error object found inside a 200 / SSE payload. */
function errorFromPayload(e: unknown): GenError {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown }
  const message = typeof o.message === 'string' ? o.message : 'The model returned an error'
  const code = typeof o.code === 'number' ? o.code : Number(o.code)
  if (Number.isFinite(code) && code >= 400) return mapStatus(code, message)
  return new GenError('model', 'The AI ran into a problem. Please try again.', message, true)
}

function wrapNetwork(err: unknown): GenError {
  if (err instanceof GenError) return err
  if (err instanceof Error && err.name === 'AbortError') return new GenError('aborted', 'Stopped')
  return new GenError(
    'network',
    "Couldn't connect to the AI service. Check your internet connection and try again.",
    err instanceof Error ? err.message : String(err),
    true
  )
}

export interface StreamParams {
  model: string
  messages: ChatMsg[]
  maxTokens: number
  temperature?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  onText: (text: string) => void
  onReasoning?: (text: string) => void
}

export interface StreamResult {
  finishReason: string | null
  usage: Usage | null
}

export interface CompleteParams {
  model: string
  messages: ChatMsg[]
  json?: boolean
  maxTokens: number
  temperature?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  timeoutMs?: number
}

function parseUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  return {
    promptTokens: num(o.prompt_tokens),
    completionTokens: num(o.completion_tokens),
    cost: num(o.cost)
  }
}

/** Lenient JSON extraction: strips code fences and takes the first {...} block. */
export function extractJsonText(text: string): string {
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const cand = t.slice(start, end + 1)
    try {
      JSON.parse(cand)
      return cand
    } catch {
      // fall through
    }
  }
  return t
}

export class LLMService {
  private modelsMemo: { at: number; models: ModelInfo[] } | null = null

  constructor(
    private secrets: SecretsService,
    private chatgpt?: ChatGPTClient
  ) {}

  /**
   * Whether `model` can be called right now: an OpenRouter key for OpenRouter ids, a ChatGPT
   * sign-in whose plan may be used here for `chatgpt:` ids. Returns the error to show if not.
   */
  async readiness(model: string): Promise<GenError | null> {
    if (isChatGPTModel(model)) {
      const st = this.chatgpt ? await this.chatgpt.auth.status() : null
      if (st?.state === 'signed_in' && st.planOk) return null
      if (st?.state === 'signed_in') {
        return new GenError('signin', "Your ChatGPT plan can't be used in Marbles.")
      }
      if (st?.state === 'reauth_required') {
        return new GenError('signin', 'Sign in to ChatGPT again in Settings to use this model.')
      }
      return new GenError('signin', 'Sign in with ChatGPT in Settings to use this model.')
    }
    if (await this.secrets.getKey()) return null
    return new GenError('no_key', 'Add your OpenRouter API key in Settings to use this model.')
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.secrets.getKey()
    if (!key) throw new GenError('no_key', 'Add your OpenRouter API key in Settings')
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter shows these to the key's owner as the app that made the request.
      ...(GITHUB_REPO ? { 'HTTP-Referer': `https://github.com/${GITHUB_REPO}` } : {}),
      'X-Title': 'Marbles'
    }
  }

  async streamChat(p: StreamParams): Promise<StreamResult> {
    if (isChatGPTModel(p.model)) return this.requireChatGPT().streamChat(p)
    const headers = await this.headers()
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages.map(toOpenRouter),
      stream: true,
      max_tokens: p.maxTokens,
      usage: { include: true }
    }
    if (p.temperature !== undefined) body.temperature = p.temperature
    if (p.reasoning) {
      body.reasoning = p.reasoning === 'off' ? { enabled: false } : { effort: p.reasoning }
    }
    await this.addPdfParser(body, p.model, p.messages)

    let res: Response
    try {
      res = await net.fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: p.signal
      })
    } catch (err) {
      throw wrapNetwork(err)
    }
    if (!res.ok) throw await errorFromResponse(res)
    if (!res.body)
      throw new GenError(
        'network',
        'The AI service sent back nothing. Please try again.',
        'Empty response body',
        true
      )

    let finishReason: string | null = null
    let usage: Usage | null = null

    const handleData = (data: string): boolean => {
      if (data === '[DONE]') return true
      let j: Record<string, unknown>
      try {
        j = JSON.parse(data) as Record<string, unknown>
      } catch {
        return false
      }
      if (j.error) throw errorFromPayload(j.error)
      const u = parseUsage(j.usage)
      if (u) usage = u
      const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0]
      if (!choice) return false
      const delta = (choice.delta ?? {}) as Record<string, unknown>
      if (typeof delta.reasoning === 'string' && delta.reasoning) {
        p.onReasoning?.(delta.reasoning)
      } else if (Array.isArray(delta.reasoning_details)) {
        for (const d of delta.reasoning_details as Record<string, unknown>[]) {
          const t =
            typeof d.text === 'string' ? d.text : typeof d.summary === 'string' ? d.summary : ''
          if (t) p.onReasoning?.(t)
        }
      }
      if (typeof delta.content === 'string' && delta.content) p.onText(delta.content)
      if (typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason
        if (finishReason === 'error') {
          throw errorFromPayload(choice.error ?? j.error)
        }
      }
      return false
    }

    const handleLine = (rawLine: string): boolean => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!line || line.startsWith(':')) return false
      if (line.startsWith('data:')) return handleData(line.slice(5).trim())
      // A bare JSON error object (no "data:" prefix)
      if (line.startsWith('{')) return handleData(line)
      return false
    }

    try {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let finished = false
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (handleLine(line)) {
            finished = true
            break
          }
        }
      }
      if (!finished && buf.trim()) handleLine(buf)
      if (finished) void reader.cancel().catch(() => {})
    } catch (err) {
      if (err instanceof GenError) throw err
      if (p.signal?.aborted) throw new GenError('aborted', 'Stopped')
      throw wrapNetwork(err)
    }
    return { finishReason, usage }
  }

  async complete(p: CompleteParams): Promise<string> {
    if (isChatGPTModel(p.model)) return this.requireChatGPT().complete(p)
    const headers = await this.headers()
    const body: Record<string, unknown> = {
      model: p.model,
      messages: p.messages.map(toOpenRouter),
      max_tokens: p.maxTokens
    }
    if (p.temperature !== undefined) body.temperature = p.temperature
    if (p.json) body.response_format = { type: 'json_object' }
    if (p.reasoning) {
      body.reasoning = p.reasoning === 'off' ? { enabled: false } : { effort: p.reasoning }
    }
    await this.addPdfParser(body, p.model, p.messages)

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
    try {
      let res: Response
      try {
        res = await net.fetch(`${API}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ac.signal
        })
      } catch (err) {
        if (timedOut)
          throw new GenError(
            'network',
            'The AI took too long to answer. Please try again.',
            'Request timed out',
            true
          )
        throw wrapNetwork(err)
      }
      if (!res.ok) throw await errorFromResponse(res)
      let j: Record<string, unknown>
      try {
        j = (await res.json()) as Record<string, unknown>
      } catch (err) {
        if (timedOut)
          throw new GenError(
            'network',
            'The AI took too long to answer. Please try again.',
            'Request timed out',
            true
          )
        throw wrapNetwork(err)
      }
      if (j.error) throw errorFromPayload(j.error)
      const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0]
      const message = (choice?.message ?? {}) as Record<string, unknown>
      const content = typeof message.content === 'string' ? message.content : ''
      if (!content)
        throw new GenError(
          'model',
          'The AI sent back an empty answer. Please try again.',
          'Empty completion',
          true
        )
      return p.json ? extractJsonText(content) : content
    } finally {
      if (timer) clearTimeout(timer)
      p.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Whether the model takes image input. ChatGPT plan models all do. An OpenRouter model counts
   * as able when the list doesn't say (unknown id, list unavailable): the provider then decides.
   */
  async supportsImages(model: string): Promise<boolean> {
    if (isChatGPTModel(model)) return true
    try {
      const info = (await this.listOpenRouterModels()).find((m) => m.id === model)
      return !info?.inputs || info.inputs.includes('image')
    } catch {
      return true
    }
  }

  /**
   * PDFs go to models that read them natively as they are. For the rest, OpenRouter extracts
   * the text; pick its free text engine, not the paid OCR one it would otherwise use.
   */
  private async addPdfParser(
    body: Record<string, unknown>,
    model: string,
    messages: ChatMsg[]
  ): Promise<void> {
    if (!hasFilePart(messages)) return
    let native = false
    try {
      const info = (await this.listOpenRouterModels()).find((m) => m.id === model)
      native = !!info?.inputs?.includes('file')
    } catch {
      // unknown: let the parser handle it
    }
    if (!native) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]
  }

  private requireChatGPT(): ChatGPTClient {
    if (!this.chatgpt) throw new GenError('signin', 'Sign in with ChatGPT in Settings first.')
    return this.chatgpt
  }

  // ---------- models ----------

  /** ChatGPT plan models (when signed in) first, then OpenRouter's. Either half may be empty. */
  async listModels(): Promise<ModelInfo[]> {
    const [gpt, or] = await Promise.allSettled([
      this.chatgpt ? this.chatgpt.listModels() : Promise.resolve([]),
      this.listOpenRouterModels()
    ])
    const a = gpt.status === 'fulfilled' ? gpt.value : []
    if (or.status === 'rejected' && !a.length) throw or.reason
    return [...a, ...(or.status === 'fulfilled' ? or.value : [])]
  }

  private get modelsFile(): string {
    return join(app.getPath('userData'), 'models.json')
  }

  private async listOpenRouterModels(): Promise<ModelInfo[]> {
    const now = Date.now()
    if (this.modelsMemo && now - this.modelsMemo.at < MODELS_TTL_MS) {
      return this.modelsMemo.models
    }
    let disk: { at: number; models: ModelInfo[] } | null = null
    try {
      const raw = JSON.parse(await fs.readFile(this.modelsFile, 'utf8')) as {
        at?: number
        models?: ModelInfo[]
      }
      if (typeof raw.at === 'number' && Array.isArray(raw.models)) {
        disk = { at: raw.at, models: raw.models }
      }
    } catch {
      // no cache
    }
    // A list saved before input kinds were recorded is refreshed early.
    if (disk && now - disk.at < MODELS_TTL_MS && disk.models.some((m) => m.inputs)) {
      this.modelsMemo = disk
      return disk.models
    }
    try {
      const models = await this.fetchModels()
      this.modelsMemo = { at: now, models }
      try {
        await fs.mkdir(dirname(this.modelsFile), { recursive: true })
        await fs.writeFile(this.modelsFile, JSON.stringify(this.modelsMemo), 'utf8')
      } catch {
        // cache write is best effort
      }
      return models
    } catch (err) {
      if (disk) {
        this.modelsMemo = disk
        return disk.models // stale beats nothing
      }
      throw err
    }
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)
    try {
      const res = await net.fetch(`${API}/models`, { signal: ac.signal })
      if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status} for the model list`)
      const j = (await res.json()) as { data?: Record<string, unknown>[] }
      const per1M = (v: unknown): number | null => {
        const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null
      }
      const out: ModelInfo[] = []
      for (const m of j.data ?? []) {
        if (typeof m.id !== 'string') continue
        const pricing = (m.pricing ?? {}) as Record<string, unknown>
        const arch = (m.architecture ?? {}) as Record<string, unknown>
        const mods = Array.isArray(arch.input_modalities) ? arch.input_modalities : null
        out.push({
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          contextLength: typeof m.context_length === 'number' ? m.context_length : null,
          promptPrice: per1M(pricing.prompt),
          completionPrice: per1M(pricing.completion),
          ...(mods
            ? {
                inputs: (['image', 'file'] as const).filter((k) => mods.includes(k))
              }
            : {})
        })
      }
      return out
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('OpenRouter returned')) throw err
      throw new Error("Couldn't load the model list. Check your internet connection.", {
        cause: err
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
