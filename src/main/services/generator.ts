import designCss from '../../../design/design.css?raw'
import { colorFor, formatIcon, isOrbColor } from '../../shared/appIcon'
import builderMd from '../prompts/builder.md?raw'
import createUserMd from '../prompts/create-user.md?raw'
import editUserMd from '../prompts/edit-user.md?raw'
import nameMd from '../prompts/name.md?raw'
import describeMd from '../prompts/describe.md?raw'
import type {
  AppMeta,
  AttachKind,
  ChatAttachment,
  ChatMessage,
  GenErrorCode,
  GenEvent,
  GenRequest,
  ReasoningEffort,
  ScopeVerdict
} from '../../shared/types'
import { LIBRARY_TOO_NEW_MSG, type LibraryService } from './library'
import type { SettingsService } from './settings'
import {
  GenError,
  toGenError,
  type ChatMsg,
  type ContentPart,
  type LLMService,
  type Usage
} from './llm'
import { assetMime, imageSize, type AttachmentStore } from './attachments'
import { uniqueName } from './library'
import { ATTACH_MAX_FILES } from '../../shared/types'
import { GenParser } from './genParser'

/** How often the live reasoning ticker updates. */
const THOUGHT_MS = 500

/** Last sentence-ish chunk of the model's reasoning, one line, for the building screen. */
function thoughtTail(raw: string): string {
  const flat = raw
    .replace(/[*#`_>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= 110) return flat
  const cut = flat.slice(-110)
  const sp = cut.indexOf(' ')
  return '…' + (sp > 0 && sp < 30 ? cut.slice(sp + 1) : cut)
}

const MAX_TOKENS = 32_000
const TEMPERATURE = 0.4
const PROGRESS_MS = 250
const NAME_TIMEOUT_MS = 15_000
const HISTORY_MAX = 10
/** Wait before the one automatic retry of a temporary failure. */
const RETRY_DELAY_MS = 3000

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

type EventBody = GenEvent extends infer E
  ? E extends { jobId: string }
    ? Omit<E, 'jobId'>
    : never
  : never

interface Named {
  name: string
  icon: string
  /** Set when the naming model judged the request too big or not possible. */
  scope?: { scope: ScopeVerdict; reason: string; smaller: string }
}

interface Job {
  id: string
  ac: AbortController
}

/** Where a generation is, so a failure after the app hit disk is never reported as one. */
type GenPhase =
  'preparing' | 'describing' | 'naming' | 'streaming' | 'retrying' | 'saving' | 'committed'

/** What `run`'s catch and finally need to know, mutated by the phases. */
interface RunState {
  phase: GenPhase
  /** The app whose edit lock this job holds, released in finally. */
  lockedApp: string | null
}

type Staged = ReturnType<AttachmentStore['resolve']>
type StreamResult = Awaited<ReturnType<LLMService['streamChat']>>
type BuildOk = Extract<ReturnType<GenParser['finish']>, { ok: true }>

/** The validated request: attachments, prompt, settings and the models to use. */
interface Prepared {
  staged: Staged
  /** What the user typed (may be empty when only files were attached). */
  typed: string
  /** `typed`, or the default sentence for a file-only request. */
  prompt: string
  s: Awaited<ReturnType<SettingsService['get']>>
  model: string
  /** A model that describes the images when the Builder can't see them. */
  describer: string | null
}

/** The Builder's input and what the save phase needs from building it. */
interface Built {
  messages: ChatMsg[]
  texts: string[]
  fileParts: ContentPart[]
  /** Names the attachments will be saved under. */
  planned: string[]
  baseVersion: number | undefined
  chatBefore: ChatMessage[]
}

/** Replaces every occurrence with a function so `$` in the value is never special. */
function fill(template: string, values: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(v)
  return out
}

function titleCase(s: string): string {
  return s.replace(/\p{L}[\p{L}\p{N}']*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
}

function fallbackName(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  const name = titleCase(words.join(' ')).slice(0, 40).trim()
  return name || 'New App'
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

const DESCRIBE_TIMEOUT_MS = 90_000
const DESCRIBE_MAX_TOKENS = 2000

const KIND_LABEL: Record<AttachKind, string> = {
  image: 'image, shown after this message',
  pdf: 'PDF, attached after this message',
  text: 'text file, below',
  docx: 'Word document, converted to HTML below',
  xlsx: 'Excel workbook, one CSV block per sheet below'
}

/**
 * The prompt block about attached files: a numbered list, then the text of text/Word/Excel
 * files inline. Images and PDFs follow the message as separate parts.
 */
function attachNote(
  files: { name: string; kind: AttachKind; truncated?: boolean }[],
  texts: string[],
  described = false
): string {
  if (!files.length) return ''
  const label = (k: AttachKind): string =>
    k === 'image' && described ? 'image, described below' : KIND_LABEL[k]
  const list = files.map((f, i) => `${i + 1}. ${f.name} (${label(f.kind)})`).join('\n')
  const hasImages = files.some((f) => f.kind === 'image')
  const hasDocs = files.some((f) => f.kind !== 'image')
  let out = `\n\nThe user attached ${files.length === 1 ? 'a file' : `${files.length} files`}:\n${list}\n`
  if (described && hasImages) {
    out +=
      "\nYou can't see the images, so another model described each one. Treat the description " +
      'as what the image shows.\n'
  }
  files.forEach((f, i) => {
    if (f.kind === 'image' && described) {
      out += `\n<image_description name="${f.name}">\n${texts[i]}\n</image_description>\n`
      return
    }
    if (f.kind === 'image' || f.kind === 'pdf') return
    const cut = f.truncated ? '\n[The file is longer; only the beginning is shown.]' : ''
    out += `\n<file name="${f.name}">\n${texts[i]}${cut}\n</file>\n`
  })
  if (hasImages) {
    out +=
      '\nUse the images as a reference for what to build or change (layout, content, look), ' +
      'unless the request says otherwise.'
  }
  if (hasDocs) {
    out +=
      '\nUse the documents as the request says: a spec to follow, content to show, or sample ' +
      'data. For sample data, build the app to work with data shaped like it (the user can load ' +
      "their file into the app); don't copy a whole data file into the app unless asked."
  }
  return (
    out +
    '\nEach file is saved with the app as assets/<name> (see "App files"). Put one inside the ' +
    'app only when the request asks for it.'
  )
}

function kb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The first `{…}` in the text that parses as JSON, ignoring anything around it. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  for (let end = text.indexOf('}', start); end !== -1; end = text.indexOf('}', end + 1)) {
    try {
      const v: unknown = JSON.parse(text.slice(start, end + 1))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // not complete yet, try the next closing brace
    }
  }
  return null
}

const EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high']

export class GeneratorService {
  private jobs = new Map<string, Job>()
  private editingApps = new Set<string>()

  constructor(
    private deps: {
      library: LibraryService
      settings: SettingsService
      llm: LLMService
      attachments: AttachmentStore
      emit: (e: GenEvent) => void
    }
  ) {}

  /** True while any generation job is running. */
  isBusy(): boolean {
    return this.jobs.size > 0 || this.editingApps.size > 0
  }

  start(jobId: string, req: GenRequest): void {
    if (
      typeof jobId !== 'string' ||
      jobId.length === 0 ||
      jobId.length > 64 ||
      this.jobs.has(jobId)
    ) {
      throw new Error('Invalid job id')
    }
    const job: Job = { id: jobId, ac: new AbortController() }
    this.jobs.set(jobId, job)
    void setImmediate(() => {
      void this.run(job, req).finally(() => this.jobs.delete(jobId))
    })
  }

  stop(jobId: string): void {
    this.jobs.get(jobId)?.ac.abort()
  }

  private emit(job: Job, body: EventBody): void {
    this.deps.emit({ jobId: job.id, ...body } as GenEvent)
  }

  private fail(job: Job, code: GenErrorCode, message: string, detail?: string): void {
    this.emit(job, { type: 'error', code, message, ...(detail ? { detail } : {}) })
  }

  /**
   * One generation, start to finish: prepare, build the messages, name (create), stream, save.
   * Each phase is a method below; the ones that can fail early return null after reporting the
   * error. `state` carries what the catch/finally need (current phase, the edit lock).
   */
  private async run(job: Job, req: GenRequest): Promise<void> {
    const state: RunState = { phase: 'preparing', lockedApp: null }
    try {
      const p = await this.prepare(job, req, state)
      if (!p) return
      const built = await this.buildMessages(job, req, p, state)
      if (!built) return

      const naming = await this.startNaming(job, req, p, built, state)
      if (naming.stopped) return
      const { namePromise } = naming

      const { res, parser, t0 } = await this.streamBuild(job, req, p, built.messages, state)
      const { finishReason, usage } = res

      console.log(
        `[gen] ${job.id.slice(0, 8)} ${req.kind} model=${p.model} ms=${Date.now() - t0} ` +
          `prompt_tokens=${usage?.promptTokens ?? '?'} completion_tokens=${usage?.completionTokens ?? '?'} ` +
          `finish=${finishReason ?? '?'} chars=${parser.htmlChars} cost=${usage?.cost ?? '?'}`
      )
      const cost = await this.costOf(p.model, usage)

      if (job.ac.signal.aborted) throw new GenError('aborted', 'Stopped')
      const result = parser.finish(finishReason)
      if (!result.ok) return this.fail(job, 'invalid_output', result.message)
      this.emit(job, { type: 'progress', chars: parser.htmlChars })

      const meta = await this.saveBuild(job, req, p, built, namePromise, result, cost, state)
      this.emit(job, {
        type: 'done',
        appId: meta.id,
        version: meta.currentVersion,
        meta
      })
    } catch (err) {
      const e = toGenError(err)
      if (state.phase === 'committed') {
        // Unreachable: nothing after the commit throws. Never fail a job whose result is saved.
        console.error(`[gen] ${job.id.slice(0, 8)} error after commit: ${e.detail ?? e.message}`)
      } else if (state.phase !== 'saving' && job.ac.signal.aborted) {
        // Stop is only honoured before the save; a failure during it is a real error.
        this.fail(job, 'aborted', 'Stopped')
      } else {
        if (e.code === 'unknown')
          console.error(`[gen] ${job.id.slice(0, 8)} failed: ${e.detail ?? e.message}`)
        this.fail(job, e.code, e.message, e.detail)
      }
    } finally {
      if (state.lockedApp) this.editingApps.delete(state.lockedApp)
      // The naming call (if still running) is cancelled with the job.
      job.ac.abort()
    }
  }

  /**
   * Validates the request, resolves attachments, takes the edit lock, announces the job and
   * checks the model and library are usable. Null when it already reported a failure.
   */
  private async prepare(job: Job, req: GenRequest, state: RunState): Promise<Prepared | null> {
    const { library, settings } = this.deps
    const bail = (code: GenErrorCode, message: string): null => {
      this.fail(job, code, message)
      return null
    }
    if (!req || (req.kind !== 'create' && req.kind !== 'edit')) {
      return bail('unknown', 'Invalid generation request')
    }
    let staged: Staged
    try {
      staged = this.deps.attachments.resolve(req.attachments)
    } catch (err) {
      return bail('unknown', err instanceof Error ? err.message : String(err))
    }
    if (staged.length > ATTACH_MAX_FILES) {
      return bail('unknown', `Attach at most ${ATTACH_MAX_FILES} files at a time.`)
    }
    const typed = typeof req.prompt === 'string' ? req.prompt.trim() : ''
    if (!typed && !staged.length) return bail('unknown', 'Describe what you want first')
    // A file on its own means "build (or change it to match) this".
    const onlyImages = staged.every((a) => a.kind === 'image')
    const prompt =
      typed ||
      (onlyImages
        ? staged.length > 1
          ? 'Build what these images show.'
          : 'Build what this image shows.'
        : 'Build a tool for the attached file' + (staged.length > 1 ? 's.' : '.'))

    const s = await settings.get()
    const model = (req.model && req.model.trim()) || s.builderModel
    const appId = req.kind === 'edit' ? req.appId : undefined

    if (req.kind === 'edit') {
      if (this.editingApps.has(req.appId)) return bail('unknown', 'A change is already in progress')
      this.editingApps.add(req.appId)
      state.lockedApp = req.appId
    }

    this.emit(job, { type: 'started', kind: req.kind, appId, model })

    const notReady = await this.deps.llm.readiness(model)
    if (notReady) return bail(notReady.code, notReady.message)
    // A Builder that can't see images gets them described by one of the user's models that can.
    let describer: string | null = null
    if (staged.some((a) => a.kind === 'image') && !(await this.deps.llm.supportsImages(model))) {
      for (const m of [s.utilityModel, s.namingModel]) {
        if (m && !(await this.deps.llm.readiness(m)) && (await this.deps.llm.supportsImages(m))) {
          describer = m
          break
        }
      }
      if (!describer) {
        return bail(
          'model',
          'None of your AI models can see images. Pick one that can in Settings, or remove the image and describe it in words.'
        )
      }
    }
    // Before any tokens are spent: the result couldn't be saved.
    if (await library.tooNew()) return bail('unknown', LIBRARY_TOO_NEW_MSG)
    return { staged, typed, prompt, s, model, describer }
  }

  /**
   * Describes images if needed, reads the attachments and builds the system + user messages.
   * Null when it already reported a failure.
   */
  private async buildMessages(
    job: Job,
    req: GenRequest,
    p: Prepared,
    state: RunState
  ): Promise<Built | null> {
    const { library } = this.deps
    const { staged, prompt, describer } = p
    const texts: string[] = []
    const fileParts: ContentPart[] = []
    const descriptions = new Map<string, string>()
    if (describer) {
      const images = staged.filter((a) => a.kind === 'image')
      this.emit(job, { type: 'looking', count: images.length })
      state.phase = 'describing'
      const described = await Promise.all(
        images.map(async (a) =>
          this.describeImage(job, describer, await this.deps.attachments.modelDataUrl(a))
        )
      )
      if (job.ac.signal.aborted) throw new GenError('aborted', 'Stopped')
      console.log(
        `[gen] ${job.id.slice(0, 8)} described ${images.length} image(s) with ${describer}`
      )
      for (const [i, a] of images.entries()) descriptions.set(a.id, described[i])
    }
    for (const a of staged) {
      const description = descriptions.get(a.id)
      if (description !== undefined) {
        texts.push(description)
      } else if (a.kind === 'image' || a.kind === 'pdf') {
        const dataUrl = await this.deps.attachments.modelDataUrl(a)
        texts.push('')
        fileParts.push(
          a.kind === 'image' ? { type: 'image', dataUrl } : { type: 'file', name: a.name, dataUrl }
        )
      } else texts.push(await this.deps.attachments.text(a))
    }
    // The app's files, and the names new ones will be saved under (a second "logo.png" becomes
    // "logo-2.png" now, so the Builder refers to the file that will really be there).
    const existing = req.kind === 'edit' ? await library.listAssets(req.appId).catch(() => []) : []
    const taken = new Set(existing.map((f) => f.name.toLowerCase()))
    const planned = staged.map((a) => {
      const n = uniqueName(a.name, taken)
      taken.add(n.toLowerCase())
      return n
    })
    const namedFiles = staged.map((a, i) => ({ ...a, name: planned[i] }))
    const assets = req.kind === 'edit' ? await this.assetsNote(req.appId, existing) : ''
    const note = attachNote(namedFiles, texts, !!describer)
    let userContent: string
    let chatBefore: ChatMessage[] = []
    let baseVersion: number | undefined
    if (req.kind === 'create') {
      userContent = fill(createUserMd, { PROMPT: prompt, ATTACHMENTS: note, ASSETS: assets })
    } else {
      const baseMeta = await library.get(req.appId)
      if (!baseMeta) {
        this.fail(job, 'unknown', 'App not found')
        return null
      }
      // Read even for a fresh rebuild: it's the fallback if the chat can't be re-read on save.
      chatBefore = await library.readChat(req.appId).catch(() => [])
      if (req.fresh) {
        // Same input as a create. The old code and chat stay out, or the model copies them.
        userContent = fill(createUserMd, { PROMPT: prompt, ATTACHMENTS: note, ASSETS: assets })
      } else {
        const base = req.baseVersion ?? baseMeta.currentVersion
        if (!base || base < 1) {
          this.fail(job, 'unknown', 'This app has no version to change')
          return null
        }
        baseVersion = base
        let html: string
        try {
          html = await library.readVersion(req.appId, base)
        } catch {
          this.fail(job, 'unknown', `Version ${base} could not be read`)
          return null
        }
        userContent = fill(editUserMd, {
          HTML: html,
          VERSION: String(base),
          HISTORY: this.historyLines(chatBefore),
          PROMPT: prompt,
          ATTACHMENTS: note,
          ASSETS: assets
        })
      }
    }
    const messages: ChatMsg[] = [
      { role: 'system', content: fill(builderMd, { DESIGN_CSS: designCss }) },
      {
        role: 'user',
        content: fileParts.length
          ? [{ type: 'text', text: userContent }, ...fileParts]
          : userContent
      }
    ]
    return { messages, texts, fileParts, planned, baseVersion, chatBefore }
  }

  /**
   * Create only: starts naming in parallel and, unless skipped, waits for its scope verdict
   * before the Builder is paid for. `stopped` is true when the request was refused as out of
   * scope (the 'scope' event is already sent).
   */
  private async startNaming(
    job: Job,
    req: GenRequest,
    p: Prepared,
    built: Built,
    state: RunState
  ): Promise<{ namePromise: Promise<Named> | null; stopped: boolean }> {
    if (req.kind !== 'create') return { namePromise: null, stopped: false }
    state.phase = 'naming'
    const namePromise = this.nameApp(
      job,
      p.prompt,
      p.s.namingModel,
      built.fileParts,
      p.staged.map((a) => a.name),
      built.texts.find((t) => t) ?? ''
    )
    // The same cheap call checks scope. Wait for it before spending on the Builder, so a
    // request Marbles can't do well costs a fraction of a cent instead of a full build.
    if (!req.skipScope) {
      const named = await namePromise
      if (job.ac.signal.aborted) throw new GenError('aborted', 'Stopped')
      if (named.scope) {
        console.log(`[gen] ${job.id.slice(0, 8)} scope=${named.scope.scope}, not built`)
        this.emit(job, { type: 'scope', ...named.scope })
        return { namePromise, stopped: true }
      }
    }
    return { namePromise, stopped: false }
  }

  /** Streams the Builder's answer, with one automatic retry of a temporary failure. */
  private async streamBuild(
    job: Job,
    req: GenRequest,
    p: Prepared,
    messages: ChatMsg[],
    state: RunState
  ): Promise<{ res: StreamResult; parser: GenParser; t0: number }> {
    const parser = new GenParser()
    const t0 = Date.now()
    let lastProgress = 0
    let thought = ''
    let lastThought = 0
    let gotContent = false

    const handleEvents = (evs: ReturnType<GenParser['feed']>): void => {
      for (const ev of evs) {
        if (ev.type === 'plan') this.emit(job, { type: 'plan', items: ev.items })
        else this.emit(job, { type: 'step', index: ev.index })
      }
    }

    const stream = (): ReturnType<LLMService['streamChat']> =>
      this.deps.llm.streamChat({
        model: p.model,
        messages,
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        reasoning:
          req.kind === 'edit' && req.effort && EFFORTS.includes(req.effort)
            ? req.effort
            : p.s.reasoningEffort,
        signal: job.ac.signal,
        onReasoning: (text) => {
          if (gotContent) return
          thought = (thought + text).slice(-400)
          const now = Date.now()
          if (now - lastThought < THOUGHT_MS) return
          lastThought = now
          this.emit(job, { type: 'thinking', text: thoughtTail(thought) })
        },
        onText: (text) => {
          gotContent = true
          handleEvents(parser.feed(text))
          const now = Date.now()
          if (parser.opened && now - lastProgress >= PROGRESS_MS) {
            lastProgress = now
            this.emit(job, { type: 'progress', chars: parser.htmlChars })
          }
        }
      })

    state.phase = 'streaming'
    let res: StreamResult
    try {
      res = await stream()
    } catch (err) {
      // A temporary failure (network blip, overload, provider outage) before any of the app
      // arrived: wait a moment and try once more, so the user never sees it.
      const e = toGenError(err)
      if (!e.transient || gotContent || job.ac.signal.aborted) throw e
      console.log(`[gen] ${job.id.slice(0, 8)} retrying after: ${e.detail ?? e.message}`)
      state.phase = 'retrying'
      await abortableSleep(RETRY_DELAY_MS, job.ac.signal)
      if (job.ac.signal.aborted) throw new GenError('aborted', 'Stopped')
      thought = ''
      res = await stream()
    }
    return { res, parser, t0 }
  }

  /**
   * Writes the app (create or new version), then its attachments and chat log. Everything after
   * the commit is best-effort and never fails the job.
   */
  private async saveBuild(
    job: Job,
    req: GenRequest,
    p: Prepared,
    built: Built,
    namePromise: Promise<Named> | null,
    result: BuildOk,
    cost: number | undefined,
    state: RunState
  ): Promise<AppMeta> {
    const { library } = this.deps
    const { staged, typed, prompt, model } = p
    const { planned, chatBefore, baseVersion } = built
    state.phase = 'saving'
    const now = new Date().toISOString()
    const assistantContent = result.plan.join('\n')
    // The tail every assistant chat entry shares.
    const tail = {
      plan: result.plan,
      ...(result.next.length ? { next: result.next } : {}),
      model,
      ...(cost !== undefined ? { cost } : {}),
      ts: now
    }
    let meta: AppMeta
    if (req.kind === 'create') {
      const named = await namePromise!
      meta = await library.create({
        name: named.name,
        icon: named.icon,
        html: result.html,
        model,
        prompt,
        cost
      })
      state.phase = 'committed'
      // The app and its version are on disk; files and the chat log are best-effort and
      // never fail the job.
      const attached = await this.saveAttachments(job, meta.id, staged, planned)
      await this.writeChatBestEffort(job, meta.id, async () => [
        { role: 'user', content: typed, ...attached, ts: now },
        {
          role: 'assistant',
          content: assistantContent || 'Built v1',
          version: 1,
          ...tail
        }
      ])
    } else {
      meta = await library.writeVersion(req.appId, result.html, { model, prompt, cost })
      state.phase = 'committed'
      const attached = await this.saveAttachments(job, req.appId, staged, planned)
      await this.writeChatBestEffort(job, req.appId, async () => {
        const chat = await library.readChat(req.appId).catch(() => chatBefore)
        return [
          ...chat,
          { role: 'user', content: typed, ...attached, ts: now },
          {
            role: 'assistant',
            content: assistantContent || `Built v${meta.currentVersion}`,
            version: meta.currentVersion,
            ...(baseVersion ? { baseVersion } : {}),
            ...(req.fresh ? { fresh: true } : {}),
            ...tail
          }
        ]
      })
    }
    return meta
  }

  /** Writes the chat log built by `entries`; a failure is logged, never thrown. */
  private async writeChatBestEffort(
    job: Job,
    appId: string,
    entries: () => Promise<ChatMessage[]>
  ): Promise<void> {
    try {
      await this.deps.library.writeChat(appId, await entries())
    } catch (err) {
      console.error(
        `[gen] ${job.id.slice(0, 8)} chat not saved: ` +
          (err instanceof Error ? err.message : String(err))
      )
    }
  }

  /**
   * USD cost of a build: OpenRouter's own figure, or tokens × the model's listed prices when the
   * provider didn't report it. undefined when neither is known.
   */
  private async costOf(model: string, usage: Usage | null): Promise<number | undefined> {
    if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost
    if (usage?.promptTokens === undefined || usage.completionTokens === undefined) return undefined
    try {
      const info = (await this.deps.llm.listModels()).find((m) => m.id === model)
      if (!info || info.promptPrice === null || info.completionPrice === null) return undefined
      return (
        (usage.promptTokens * info.promptPrice + usage.completionTokens * info.completionPrice) /
        1e6
      )
    } catch {
      return undefined
    }
  }

  /**
   * Copies a saved build's files into the app's assets/ and drops them from staging.
   * Returns the chat entry's `attachments` field (empty object when there are none or the copy
   * failed, so the chat still saves).
   */
  private async saveAttachments(
    job: Job,
    appId: string,
    staged: ReturnType<AttachmentStore['resolve']>,
    planned: string[]
  ): Promise<{ attachments?: ChatAttachment[] }> {
    if (!staged.length) return {}
    try {
      const names = await this.deps.library.addAssets(
        appId,
        staged.map((a, i) => ({ name: planned[i], path: this.deps.attachments.originalPath(a) }))
      )
      if (names.some((n, i) => n !== planned[i])) {
        console.warn(`[gen] ${job.id.slice(0, 8)} asset names changed on save: ${names.join(', ')}`)
      }
      for (const a of staged) await this.deps.attachments.discard(a.id)
      return {
        attachments: staged.map((a, i) => ({
          name: names[i],
          mime: a.mime,
          size: a.size,
          kind: a.kind
        }))
      }
    } catch (err) {
      console.error(
        `[gen] ${job.id.slice(0, 8)} attachments not saved: ` +
          (err instanceof Error ? err.message : String(err))
      )
      return {}
    }
  }

  /** The "files this app already has" block of an edit prompt. */
  private async assetsNote(
    appId: string,
    files: { name: string; size: number }[]
  ): Promise<string> {
    if (!files.length) return ''
    const lines: string[] = []
    for (const f of files) {
      const mime = assetMime(f.name)
      let dims = ''
      if (mime.startsWith('image/')) {
        const size = await this.deps.library
          .readAsset(appId, f.name)
          .then((b) => imageSize(b))
          .catch(() => null)
        if (size) dims = `, ${size.width}×${size.height}`
      }
      lines.push(`- assets/${f.name} (${mime}${dims}, ${kb(f.size)})`)
    }
    return (
      '\nFiles saved with this app (earlier attachments). Use one only when the request asks, ' +
      'or keep using it if the current app already does:\n' +
      lines.join('\n') +
      '\n'
    )
  }

  private historyLines(chat: ChatMessage[]): string {
    const lines: string[] = []
    for (let i = 0; i < chat.length; i++) {
      const m = chat[i]
      if (m.role !== 'user') continue
      const next = chat[i + 1]
      const v = next?.role === 'assistant' && next.version ? `v${next.version}: ` : ''
      const files = m.attachments?.length
        ? ` (attached: ${m.attachments.map((a) => a.name).join(', ')})`
        : ''
      lines.push(`- ${v}${oneLine(m.content || '(no text)', 300)}${files}`)
    }
    const last = lines.slice(-HISTORY_MAX)
    return last.length ? last.join('\n') : '(none)'
  }

  /** A detailed description of one image, for a Builder that can't see it. */
  private async describeImage(job: Job, model: string, dataUrl: string): Promise<string> {
    const text = await this.deps.llm.complete({
      model,
      messages: [
        { role: 'system', content: describeMd },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', dataUrl }
          ]
        }
      ],
      maxTokens: DESCRIBE_MAX_TOKENS,
      signal: job.ac.signal,
      timeoutMs: DESCRIBE_TIMEOUT_MS
    })
    return text.trim()
  }

  private async nameApp(
    job: Job,
    prompt: string,
    namingModel: string,
    parts: ContentPart[] = [],
    fileNames: string[] = [],
    excerpt = ''
  ): Promise<Named> {
    // The naming model sees images (when it can) and PDFs, so "build this" + a screenshot or a
    // spec is named and scope-checked from the file itself. It always gets the file names.
    const seeImages = await this.deps.llm.supportsImages(namingModel)
    const extra = parts.filter((p) => p.type === 'file' || (p.type === 'image' && seeImages))
    const text =
      prompt.slice(0, 2000) +
      (fileNames.length ? `\n\n(Attached: ${fileNames.join(', ')})` : '') +
      (excerpt ? `\n\nStart of the attached file:\n${excerpt.slice(0, 800)}` : '')
    const userContent: ChatMsg['content'] = extra.length ? [{ type: 'text', text }, ...extra] : text
    const fallback: Named = {
      name: fallbackName(prompt),
      icon: formatIcon(colorFor(prompt))
    }
    const done = (v: Named): Named => {
      if (!job.ac.signal.aborted) this.emit(job, { type: 'named', name: v.name, icon: v.icon })
      return v
    }
    return this.deps.llm
      .complete({
        model: namingModel,
        messages: [
          { role: 'system', content: nameMd },
          { role: 'user', content: userContent }
        ],
        json: true,
        reasoning: 'off',
        maxTokens: 400,
        signal: job.ac.signal,
        timeoutMs: NAME_TIMEOUT_MS
      })
      .then((text) => {
        // Small models sometimes wrap the JSON in fences or add text after it; take the object.
        const obj = firstJsonObject(text)
        if (!obj) throw new Error(`no JSON object in: ${text.slice(0, 120)}`)
        const j = obj as {
          name?: unknown
          color?: unknown
          scope?: unknown
          reason?: unknown
          smaller?: unknown
        }
        const rawName = typeof j.name === 'string' ? j.name.replace(/\s+/g, ' ').trim() : ''
        const name = rawName ? rawName.split(' ').slice(0, 4).join(' ').slice(0, 40) : ''
        const icon = formatIcon(isOrbColor(j.color) ? j.color : colorFor(prompt))
        const str = (v: unknown, max: number): string =>
          typeof v === 'string' ? oneLine(v, max) : ''
        // Anything but a clear 'big'/'no' builds as normal: a failed check must never block.
        const verdict: ScopeVerdict | null =
          j.scope === 'big' ? 'big' : j.scope === 'no' ? 'no' : null
        const scope = verdict
          ? { scope: verdict, reason: str(j.reason, 240), smaller: str(j.smaller, 300) }
          : undefined
        return done({ name: name || fallback.name, icon, scope })
      })
      .catch((err: unknown) => {
        if (!job.ac.signal.aborted) {
          console.warn(
            `[gen] ${job.id.slice(0, 8)} naming failed:`,
            err instanceof Error ? err.message : err
          )
        }
        return done(fallback)
      })
  }
}
