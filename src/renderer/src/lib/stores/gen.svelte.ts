import type {
  GenErrorCode,
  GenEvent,
  GenRequest,
  ModelInfo,
  ReasoningEffort,
  ScopeVerdict
} from '../../../../shared/types'
import { chat } from './chat.svelte'
import { key } from './key.svelte'
import { chatgpt } from './chatgpt.svelte'
import { library } from './library.svelte'
import { ui } from './ui.svelte'
import { errorText } from '../errors'
import type { PendingAttachment } from '../attachments.svelte'

interface JobBase {
  jobId: string
  kind: GenRequest['kind']
  prompt: string
  /** Files sent with the request; still staged in main until the build is saved. */
  attachments: PendingAttachment[]
  appId?: string
  /** Edit only: the version the change was built from. */
  baseVersion?: number
  /** Edit only: options kept so "Try again" after a failure repeats the same kind of build. */
  effort?: ReasoningEffort
  fresh?: boolean
  /** Edit only: the version this change will land as (highest existing + 1). */
  targetVersion?: number
  model: string
  name?: string
  icon?: string
  plan: string[] | null // null until the plan block arrives
  step: number // index of the step being written, -1 before the first marker
  chars: number
  thinking: boolean
  /** Images being described for a Builder that can't see them (0 = not doing that). */
  looking: number
  /** Tail of the live reasoning, shown faintly while thinking. */
  thought?: string
  startedAt: number
}

/**
 * A generation job, tracked as a state machine on `phase`:
 * starting → running → done | failed, with 'scoped' as a terminal stop for creates.
 * Only the matching phase carries `scope` / `error` / `appId`.
 */
type Job =
  | (JobBase & { phase: 'starting' }) // registered locally, before the IPC call resolves
  | (JobBase & { phase: 'running' }) // after the 'started' event
  | (JobBase & {
      phase: 'scoped' // the scope check stopped the request before building
      scope: { scope: ScopeVerdict; reason: string; smaller: string }
    })
  | (JobBase & { phase: 'failed'; error: { code: GenErrorCode; message: string; detail?: string } })
  | (JobBase & { phase: 'done'; appId: string })

/** Jobs the user can still act on: in flight, or finished/failed and not yet dismissed. */
function inFlight(j: Job): boolean {
  return j.phase === 'starting' || j.phase === 'running'
}

class GenStore {
  jobs = $state<Record<string, Job>>({})
  /** The create job shown in the New app view. */
  activeCreateId = $state<string | null>(null)
  models = $state<ModelInfo[]>([])

  activeCreate = $derived(this.activeCreateId ? (this.jobs[this.activeCreateId] ?? null) : null)
  runningCreates = $derived(
    Object.values(this.jobs).filter((j) => j.kind === 'create' && inFlight(j))
  )
  /** Per-app Builder model override for the next change (session only, not persisted). */
  modelFor = $state<Record<string, string>>({})

  /** True when the user is on the New app view looking at this job. */
  watching(jobId: string): boolean {
    return ui.view === 'new' && this.activeCreateId === jobId
  }

  /**
   * Go to the New app view. If the build on screen is in flight, let it run in the
   * Making list and show the composer; a failed or scope-stopped build stays on screen.
   */
  openNew(): void {
    const active = this.activeCreate
    if (!active || inFlight(active)) {
      // Show the composer, unless a build stopped in the background and was never looked at.
      const stopped = Object.values(this.jobs).find(
        (j) => j.kind === 'create' && (j.phase === 'failed' || j.phase === 'scoped')
      )
      this.activeCreateId = stopped?.jobId ?? null
    }
    ui.view = 'new'
  }

  /** Show a create job in the New app view. */
  watch(jobId: string): void {
    // A stale toast can point at a job that is gone; then this is just "open New app".
    if (!this.jobs[jobId]) return this.openNew()
    this.releaseInactiveActive(jobId)
    this.activeCreateId = jobId
    ui.view = 'new'
  }

  /** Drop the active create if it has stopped (failed/scoped), so replacing it orphans nothing. */
  private releaseInactiveActive(incoming: string): void {
    const id = this.activeCreateId
    if (!id || id === incoming) return
    const j = this.jobs[id]
    if (j && !inFlight(j)) delete this.jobs[id]
  }

  /** The edit job (any phase) for an app, if any. */
  editFor(appId: string | undefined | null): Job | null {
    if (!appId) return null
    return Object.values(this.jobs).find((j) => j.kind === 'edit' && j.appId === appId) ?? null
  }

  isEditing(appId: string): boolean {
    const j = this.editFor(appId)
    return !!j && inFlight(j)
  }

  async init(): Promise<void> {
    window.api.gen.onEvent((e) => this.onEvent(e))
    chatgpt.onChange(() => void this.loadModels())
    await Promise.all([key.refresh(), chatgpt.init()])
    void this.loadModels()
  }

  private async loadModels(): Promise<void> {
    try {
      this.models = await window.api.models.list()
    } catch {
      /* offline: autocomplete just stays empty */
    }
  }

  /** skipScope: build without the scope check (the user chose "Build anyway" or a suggestion). */
  async create(
    prompt: string,
    opts: { model?: string; skipScope?: boolean; attachments?: PendingAttachment[] } = {}
  ): Promise<void> {
    const text = prompt.trim()
    const attachments = opts.attachments ?? []
    if (!text && !attachments.length) return
    const jobId = crypto.randomUUID()
    this.jobs[jobId] = {
      jobId,
      kind: 'create',
      prompt: text,
      attachments,
      model: '',
      plan: null,
      step: -1,
      chars: 0,
      thinking: false,
      looking: 0,
      phase: 'starting',
      startedAt: Date.now()
    }
    // Show the building screen at once, so a second Enter can't start a second build.
    this.watch(jobId)
    try {
      await window.api.gen.start(jobId, {
        kind: 'create',
        prompt: text,
        model: opts.model,
        skipScope: opts.skipScope,
        attachments: attachments.map((a) => a.id)
      })
    } catch (e) {
      delete this.jobs[jobId]
      if (this.activeCreateId === jobId) this.activeCreateId = null
      ui.showToast(errorText(e))
    }
  }

  /**
   * Change an existing app. Builds from baseVersion (default: the version on screen), or with
   * `fresh`, from the prompt alone. Either way the result lands as the next version.
   */
  async edit(
    appId: string,
    prompt: string,
    baseVersion?: number,
    opts: { effort?: ReasoningEffort; fresh?: boolean; attachments?: PendingAttachment[] } = {}
  ): Promise<void> {
    if (opts.fresh) baseVersion = undefined
    const text = prompt.trim()
    const attachments = opts.attachments ?? []
    if ((!text && !attachments.length) || this.isEditing(appId)) return
    const old = this.editFor(appId)
    if (old) delete this.jobs[old.jobId]
    const model = this.modelFor[appId]?.trim() || undefined
    const meta = library.apps.find((a) => a.id === appId)
    const targetVersion = (meta ? Math.max(0, ...meta.versions.map((v) => v.n)) : 0) + 1
    const jobId = crypto.randomUUID()
    this.jobs[jobId] = {
      jobId,
      kind: 'edit',
      appId,
      prompt: text,
      attachments,
      baseVersion,
      effort: opts.effort,
      fresh: opts.fresh,
      targetVersion,
      model: model ?? '',
      plan: null,
      step: -1,
      chars: 0,
      thinking: false,
      looking: 0,
      phase: 'starting',
      startedAt: Date.now()
    }
    try {
      await window.api.gen.start(jobId, {
        kind: 'edit',
        appId,
        prompt: text,
        attachments: attachments.map((a) => a.id),
        baseVersion,
        model,
        effort: opts.effort,
        fresh: opts.fresh
      })
    } catch (e) {
      delete this.jobs[jobId]
      ui.showToast(errorText(e))
    }
  }

  /** Forget a finished/failed job (e.g. the user dismissed the error). */
  dismiss(jobId: string): void {
    const j = this.jobs[jobId]
    if (j && !inFlight(j)) delete this.jobs[jobId]
  }

  async stop(jobId: string): Promise<void> {
    await window.api.gen.stop(jobId)
  }

  /** Leave the error/building screen and go back to the prompt box. */
  dismissCreate(): void {
    const id = this.activeCreateId
    this.activeCreateId = null
    if (id) {
      const j = this.jobs[id]
      if (j && !inFlight(j)) delete this.jobs[id]
    }
  }

  /**
   * The job state machine: the only place a job changes. Returns the next job, or
   * null when the event is dropped (the job is already scoped, failed or done).
   */
  private apply(job: Job, e: GenEvent): Job | null {
    if (job.phase === 'scoped' || job.phase === 'failed' || job.phase === 'done') return null
    switch (e.type) {
      case 'started':
        return {
          ...job,
          phase: 'running',
          model: e.model,
          kind: e.kind,
          ...(e.appId ? { appId: e.appId } : {})
        }
      case 'looking':
        return { ...job, looking: e.count }
      case 'thinking':
        return { ...job, thinking: true, looking: 0, thought: e.text ?? job.thought }
      case 'named':
        return { ...job, name: e.name, icon: e.icon }
      case 'scope':
        return {
          ...job,
          phase: 'scoped',
          scope: { scope: e.scope, reason: e.reason, smaller: e.smaller }
        }
      case 'plan':
        return { ...job, plan: e.items, thinking: false, looking: 0 }
      case 'step':
        return { ...job, step: Math.max(job.step, e.index), thinking: false }
      case 'progress':
        return { ...job, chars: e.chars, thinking: false }
      case 'done':
        return { ...job, phase: 'done', appId: e.appId }
      case 'error':
        return {
          ...job,
          phase: 'failed',
          error: { code: e.code, message: e.message, detail: e.detail }
        }
    }
  }

  private onEvent(e: GenEvent): void {
    const job = this.jobs[e.jobId]
    if (!job) return // unknown job id: the event is stale or foreign
    const next = this.apply(job, e)
    if (!next) return
    this.jobs[e.jobId] = next
    if (e.type === 'done') void this.finish(next, e.appId)
    else if (e.type === 'error') {
      if (e.code === 'auth') key.markRejected(e.message)
      else if (e.code === 'no_key') void key.refresh()
      else if (e.code === 'signin') void chatgpt.refresh()
      this.onCreateStopped(next)
    } else if (e.type === 'scope') {
      this.onCreateStopped(next)
    }
  }

  /**
   * A create job stopped failed or scope-stopped while not the one on screen. Keep it
   * reachable: make it the active create when there is no other, and toast a way back to it.
   * 'aborted' means the user pressed Stop, so just drop it when it is not on screen.
   */
  private onCreateStopped(job: Job): void {
    if (job.kind !== 'create' || (job.phase !== 'failed' && job.phase !== 'scoped')) return
    if (job.phase === 'failed' && job.error.code === 'aborted') {
      if (this.activeCreateId !== job.jobId) delete this.jobs[job.jobId]
      return
    }
    const name = job.name ?? 'your app'
    const action = { label: 'Show', run: () => this.watch(job.jobId) }
    if (this.activeCreateId === job.jobId) return
    // Never swap the screen under the user (they may be typing a new request): if they are
    // elsewhere, queue it up as the active create; either way the toast leads back to it,
    // and openNew() picks it up later if the toast is missed.
    if (this.activeCreateId === null && ui.view !== 'new') this.activeCreateId = job.jobId
    ui.showToast(`Couldn’t make “${name}”`, action)
  }

  private async finish(job: Job, appId: string): Promise<void> {
    await library.refresh()
    if (job.kind === 'edit') await chat.reloadIf(appId)
    if (job.kind === 'create') {
      // The Making row is replaced by the real one; drop it into the library.
      ui.flashLanded(appId, 'new')
      if (this.watching(job.jobId)) {
        this.activeCreateId = null
        ui.markJustBuilt(appId)
        library.select(appId)
        ui.drawerOpen = true
      } else {
        if (this.activeCreateId === job.jobId) this.activeCreateId = null
        ui.showToast(`“${job.name ?? 'Your app'}” is ready`, {
          label: 'Open',
          run: () => library.select(appId)
        })
      }
    }
    // The files are saved with the app now; the chat shows them from there.
    for (const a of job.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    delete this.jobs[job.jobId]
  }
}

export const gen = new GenStore()
