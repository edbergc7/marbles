export interface VersionInfo {
  n: number
  createdAt: string
  model: string
  prompt: string
  /** What building this version cost on OpenRouter, in USD. Missing for old or hand-made versions. */
  cost?: number
}

export interface AppMeta {
  id: string // folder name, e.g. "image-cropper-a1b2"
  name: string
  icon: string // "@<color>" (see appIcon.ts); older libraries may hold an emoji
  createdAt: string // ISO
  updatedAt: string // ISO, bumped on any change (rename, new version, version switch)
  currentVersion: number // 0 = no versions yet
  versions: VersionInfo[]
  /** Sidebar folder id (see LibraryLayout). Missing or unknown = Unfiled. */
  folder?: string
}

/** A sidebar folder. One level only; an app sits in at most one folder. */
export interface LibraryFolder {
  id: string // "f-xxxxxx"
  name: string
}

/** Library-wide sidebar layout, stored in <library>/library.json. */
export interface LibraryLayout {
  folders: LibraryFolder[] // in display order
  pinned: string[] // app ids, in display order (may contain ids of apps that no longer exist)
}

/** What an attached file is, which decides how it reaches the AI. */
export type AttachKind = 'image' | 'text' | 'pdf' | 'docx' | 'xlsx'

/** A file attached to a request, as kept in chat.json. The file is <app>/assets/<name>. */
export interface ChatAttachment {
  name: string
  mime: string
  size: number
  /** Missing on entries saved before documents were supported: those are images. */
  kind?: AttachKind
}

/** Images the person can attach to a build or change. */
export const ATTACH_IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}
/** Plain-text files, read as UTF-8 and sent as text. */
export const ATTACH_TEXT_EXTS = [
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.log'
]
/** Documents: PDFs go to the AI as files; Word and Excel are turned into text first. */
export const ATTACH_DOC_EXTS = ['.pdf', '.docx', '.xlsx']
export const ATTACH_MAX_FILES = 8
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024
/** Text sent per document; longer ones are cut and marked. */
export const ATTACH_MAX_CHARS = 100_000

/** A file held in main until the request it is attached to finishes building. */
export interface StagedAttachment {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachKind
  /** Text documents: only the first ATTACH_MAX_CHARS characters will be sent. */
  truncated?: boolean
}

/** Asset URL for an app's file, for the host window (the app frame can't load these yet). */
export function assetUrl(appId: string, name: string): string {
  return `appframe://app/${encodeURIComponent(appId)}/assets/${encodeURIComponent(name)}`
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** User turns: files attached to this request. */
  attachments?: ChatAttachment[]
  version?: number
  plan?: string[]
  model?: string
  /** Assistant turns of an edit: the version this change was built from. */
  baseVersion?: number
  /** Assistant turns: rebuilt from the prompt alone, not from an earlier version. */
  fresh?: boolean
  /** Assistant turns: what the build cost in USD, when known. */
  cost?: number
  /** Assistant turns: short ideas for the next change, shown as chips. */
  next?: string[]
  ts: string
}

export interface TrashedApp {
  id: string
  name: string
  icon: string
  trashedAt: string
}

export type ThemeSetting = 'system' | 'light' | 'dark'
/** How hard the Builder model reasons before writing (OpenRouter `reasoning.effort`). */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

export interface Settings {
  /** Version of settings.json (see SETTINGS_FORMAT in main). Set by main only. */
  format: number
  builderModel: string
  /** Default model for host.ai() inside generated apps. */
  utilityModel: string
  /** Cheap model that names new apps; called with reasoning off. */
  namingModel: string
  reasoningEffort: ReasoningEffort
  /** host.fetch may reach localhost / private network addresses (off by default). */
  allowLocalNetwork: boolean
  /** Shows model names, costs and model/reasoning controls (off by default, for non-technical users). */
  showAdvanced: boolean
  theme: ThemeSetting
  accent: string
  libraryPath: string
  /** The one-time "You're using your ChatGPT plan" note has been seen. */
  chatgptWelcomed: boolean
  /** First-run setup was finished or skipped; it isn't shown again. */
  setupDone: boolean
  /** Ask GitHub for new releases and announcements (on by default). */
  checkForUpdates: boolean
  /** Ids of notices the person closed. */
  dismissedNotices: string[]
}

export type NoticeLevel = 'info' | 'warning' | 'critical'

/** A new release or an announcement, shown as a banner. */
export interface Notice {
  id: string
  kind: 'update' | 'announcement'
  level: NoticeLevel
  title: string
  body: string
  /** Button text when the notice has a link; main holds the URL itself. */
  linkLabel?: string
  dismissible: boolean
}

export interface NoticesState {
  appVersion: string
  /** This build knows which repo to check. */
  available: boolean
  /** available and turned on in Settings. */
  enabled: boolean
  checking: boolean
  lastCheck: number | null
  lastError: string | null
  /** Newest release on GitHub, when known. */
  latestVersion: string | null
  /** latestVersion is newer than this build (even if its banner was dismissed). */
  updateAvailable: boolean
  /** Notices to show now (dismissed ones left out). */
  notices: Notice[]
}

export interface CreateAppInput {
  name: string
  icon?: string
  html?: string // if given, saved as v1
  model?: string
  prompt?: string
  cost?: number
}

/** Pushed from main when the library folder changes (our own writes or external edits). */
export interface LibraryChangedEvent {
  ids: string[] // affected app ids; empty = unknown, reload everything
}

export interface IpcApi {
  library: {
    /** All apps, sorted by updatedAt desc. Folders without a valid meta.json are skipped. */
    list(): Promise<AppMeta[]>
    rename(id: string, name: string): Promise<AppMeta>
    setIcon(id: string, icon: string): Promise<AppMeta>
    /** Copies the folder (all versions, chat, storage) as "<name> copy". */
    duplicate(id: string): Promise<AppMeta>
    /** Moves the folder to <library>/trash/; returns the id it landed under (may be suffixed). */
    trash(id: string): Promise<string>
    listTrash(): Promise<TrashedApp[]>
    restore(id: string): Promise<AppMeta>
    /** Asks the user to confirm, then permanently deletes everything in the Trash. Resolves with the number deleted, or null if cancelled. */
    emptyTrash(): Promise<number | null>
    /** Asks the user to confirm, then permanently deletes one trashed app. Resolves true if deleted, false if cancelled. */
    deleteTrashed(id: string): Promise<boolean>
    /** Folders and pins. */
    layout(): Promise<LibraryLayout>
    createFolder(name: string): Promise<LibraryFolder>
    updateFolder(id: string, patch: { name?: string }): Promise<LibraryLayout>
    /** Moves the folder's apps to the Trash, then removes the folder. */
    deleteFolder(id: string): Promise<LibraryLayout>
    /** Sets folder order; ids not listed keep their relative order at the end. */
    reorderFolders(ids: string[]): Promise<LibraryLayout>
    /** Replaces the ordered list of pinned app ids. */
    setPinned(ids: string[]): Promise<LibraryLayout>
    /** The app's files (<app>/assets/), and whether its current version mentions each one. */
    assets(id: string): Promise<AppFileInfo[]>
    /** Takes a file out of the app (moved aside to <app>/removed-assets/, not deleted). */
    removeAsset(id: string, name: string): Promise<void>
    /** Moves an app into a folder (null = Unfiled). Does not bump updatedAt. */
    setFolder(appId: string, folderId: string | null): Promise<AppMeta>
    /** Subscribe to change events; returns an unsubscribe function. */
    onChanged(cb: (e: LibraryChangedEvent) => void): () => void
  }
  versions: {
    /** Switches currentVersion (undo/redo/picker). */
    setCurrent(id: string, n: number): Promise<AppMeta>
  }
  chat: {
    read(id: string): Promise<ChatMessage[]>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  exporter: {
    /** Save dialog → standalone .html of that version (default: current). Null if cancelled. */
    saveHtml(appId: string, version?: number): Promise<ExportResult | null>
    /** Reveal a file or folder in the OS file manager. */
    reveal(path: string): Promise<void>
  }
  libraryLocation: {
    /** Folder picker. Null if cancelled. Never changes anything by itself. */
    pick(): Promise<LibraryFolderInfo | null>
    /** Copy the current library into an empty folder, then switch to it. Old folder is left intact. */
    moveTo(path: string): Promise<Settings>
    /** Switch to a folder that is empty or already holds a library (has apps/). */
    useExisting(path: string): Promise<Settings>
    /** Back to <userData>/library. */
    reset(): Promise<Settings>
  }
  secrets: {
    /** Where the OpenRouter key comes from. Never returns the key itself. */
    status(): Promise<KeyStatus>
    setKey(key: string): Promise<KeyStatus>
    clearKey(): Promise<KeyStatus>
    /** Calls OpenRouter's key endpoint. */
    testKey(): Promise<{
      ok: boolean
      error?: string
      label?: string
      creditsLeft?: number | null
      rejected?: boolean
    }>
  }
  models: {
    /** ChatGPT plan models (`chatgpt:` ids, when signed in) then OpenRouter's (cached ~24h). */
    list(): Promise<ModelInfo[]>
  }
  chatgpt: {
    status(): Promise<ChatGPTStatus>
    /** Opens the browser and resolves once signed in; rejects if cancelled, timed out or refused. */
    signIn(): Promise<ChatGPTStatus>
    cancelSignIn(): Promise<void>
    /** Revokes at OpenAI, then forgets locally even if revoking failed. */
    signOut(): Promise<{ revoked: boolean }>
    onStatus(cb: (s: ChatGPTStatus) => void): () => void
  }
  attachments: {
    /**
     * Holds a file in main for a request about to be sent. `model` is a smaller copy for the AI
     * (images over 2000 px, GIFs); the original is what gets saved with the app.
     */
    stage(
      name: string,
      mime: string,
      data: Uint8Array,
      model?: { mime: string; data: Uint8Array }
    ): Promise<StagedAttachment>
    discard(id: string): Promise<void>
  }
  gen: {
    /** Starts a generation job with a renderer-chosen id; progress arrives via onEvent. */
    start(jobId: string, req: GenRequest): Promise<void>
    stop(jobId: string): Promise<void>
    onEvent(cb: (e: GenEvent) => void): () => void
  }
  notices: {
    get(): Promise<NoticesState>
    /** Checks GitHub now. Never rejects: errors land in lastError. */
    check(): Promise<NoticesState>
    dismiss(id: string): Promise<NoticesState>
    /** Opens the notice's link in the browser. */
    open(id: string): Promise<void>
    onChanged(cb: (s: NoticesState) => void): () => void
  }
  bridge: {
    /**
     * Executes a host.* call on behalf of the app currently shown in the frame.
     * The renderer supplies appId (it knows which app the iframe shows); main scopes
     * storage to that app. Rejects with an Error whose message is shown to the app.
     */
    call(appId: string, method: BridgeMethod, args: unknown[]): Promise<unknown>
    /** A link clicked (or window.open called) in the app: main prompts before opening it. */
    openLink(url: string): Promise<void>
    /** The person clicked a notification from this app (host.notify). */
    onOpenApp(cb: (appId: string) => void): () => void
    /** A notification from an app was shown: add its dot and play the sound. */
    onNotified(cb: (e: NotifiedEvent) => void): () => void
    /** The app on screen (null: none), so main skips notifications the app handles itself. */
    setShown(appId: string | null): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface KeyStatus {
  set: boolean
  source: 'env' | 'stored' | null
  /** true when safeStorage has no OS keyring (Linux without libsecret) and the key is only obfuscated. */
  insecureStorage: boolean
}

/** Sign in with ChatGPT. Tokens never leave the main process; this is all the renderer sees. */
export type ChatGPTStatus =
  | { state: 'signed_out' }
  /** Waiting for the browser; `url` is shown with a Copy button in case no browser opened. */
  | { state: 'signing_in'; url: string }
  | {
      state: 'signed_in'
      email?: string
      name?: string
      /** false: signed in, but the plan can't pay for requests in Marbles (scope not granted). */
      planOk: boolean
      insecureStorage: boolean
    }
  /** The session ended (expired, revoked or rejected); sign in again. */
  | { state: 'reauth_required'; email?: string }

export interface ModelInfo {
  id: string
  name: string
  contextLength: number | null
  /** USD per 1M tokens */
  promptPrice: number | null
  completionPrice: number | null
  /** Input kinds beyond text the model accepts. Missing = unknown. */
  inputs?: ('image' | 'file')[]
}

export type GenRequest =
  /** New app: on success main creates the app folder with v1 (nothing is written on failure). */
  /** skipScope: build even if the scope check says the request is too big or not possible. */
  /** attachments: ids from attachments.stage(). */
  | { kind: 'create'; prompt: string; model?: string; skipScope?: boolean; attachments?: string[] }
  /** Change an existing app: builds from baseVersion (default currentVersion), saves v(max+1). */
  | {
      kind: 'edit'
      appId: string
      prompt: string
      attachments?: string[]
      baseVersion?: number
      model?: string
      /** Overrides Settings.reasoningEffort for this one build ("Try harder"). */
      effort?: ReasoningEffort
      /**
       * Rebuild from the prompt alone, as a create would: no current code, no chat history,
       * so the model can't just copy the version it is replacing ("Try harder" on v1).
       * Still saves as v(max+1) of this app; baseVersion is ignored.
       */
      fresh?: boolean
    }

export type GenErrorCode =
  | 'no_key'
  | 'auth' // 401
  | 'credits' // 402
  | 'rate_limit' // 429
  | 'model' // 400/404 bad model id, context too long, provider error
  | 'network'
  | 'invalid_output' // missing/unclosed <html_app>, too short, truncated
  | 'plan_limit' // ChatGPT plan usage limit reached for this app
  | 'signin' // ChatGPT sign-in needed again, or the plan can't be used here
  | 'aborted'
  | 'unknown'

export type ScopeVerdict = 'big' | 'no'

export type GenEvent = { jobId: string } & (
  | { type: 'started'; kind: GenRequest['kind']; appId?: string; model: string }
  /** The Builder can't see images: another model is describing the attached ones first. */
  | { type: 'looking'; count: number }
  /** Model is reasoning before writing (reasoning tokens streaming). */
  | { type: 'thinking'; text?: string }
  /** Create only: name + icon from the Naming model (may arrive before or after plan). */
  | { type: 'named'; name: string; icon: string }
  /**
   * Create only, ends the job: the scope check found the request too big ('big') or needing
   * something Marbles can't do ('no'). Nothing was built or saved.
   */
  | { type: 'scope'; scope: ScopeVerdict; reason: string; smaller: string }
  | { type: 'plan'; items: string[] }
  /** 0-based index of the plan step now being written; earlier steps are complete. */
  | { type: 'step'; index: number }
  /** Characters of HTML received so far (throttled ~4/s). */
  | { type: 'progress'; chars: number }
  | { type: 'done'; appId: string; version: number; meta: AppMeta }
  | {
      type: 'error'
      code: GenErrorCode
      message: string
      /** Technical text, shown only with advanced options on. */
      detail?: string
    }
)

// ---------------------------------------------------------------------------
// Bridge protocol: sandboxed app iframe  <->  host renderer  <->  main
// Every message carries `__marbles: 1` so unrelated postMessages are ignored.
// ---------------------------------------------------------------------------

export type BridgeMethod =
  | 'storage.get' // (key: string) => unknown | undefined
  | 'storage.set' // (key: string, value: JSON) => void
  | 'storage.remove' // (key: string) => void
  | 'storage.keys' // () => string[]
  | 'ai' // (opts: AiCallOptions) => string
  | 'fetch' // (url: string, init?: BridgeFetchInit) => BridgeFetchResult
  | 'assets.list' // () => AppAssetInfo[]
  | 'assets.text' // (name: string) => string
  | 'assets.base64' // (name: string) => string
  | 'notify' // (opts: NotifyOptions) => string (the notification's id)
  | 'notify.cancel' // (id: string) => void
  | 'notify.list' // () => string[] (ids still waiting to fire)

/** One of an app's files (<app>/assets/), as host.assets.list() and the Files list show it. */
export interface AppAssetInfo {
  name: string
  mime: string
  size: number
  width?: number
  height?: number
}

export interface AppFileInfo extends AppAssetInfo {
  /** The app's current version mentions this file. */
  used: boolean
}

export interface AiCallOptions {
  prompt?: string
  messages?: { role: 'user' | 'assistant' | 'system'; content: string }[]
  system?: string
  model?: string
  json?: boolean
  /** data: URLs of PNG/JPEG/WebP/GIF images (the shim converts Files, Blobs and canvases). */
  images?: string[]
  /** PDFs as data: URLs, with an optional file name. */
  files?: { name?: string; data: string }[]
  /**
   * Storage key: main records the call's progress there ({ status: 'running' }, then 'done'
   * with the text or 'error'), and finishes it even if the app is closed meanwhile.
   */
  saveAs?: string
  /** With saveAs: a notification shown when the call finishes, for when the app is closed. */
  notify?: string
}

/** What host.ai({ saveAs }) keeps under that storage key. */
export type SavedAiResult =
  | { status: 'running'; startedAt: number }
  | { status: 'done'; text: string; startedAt: number; finishedAt: number }
  | { status: 'error'; error: string; startedAt: number; finishedAt: number }

export interface NotifyOptions {
  /** The notification's text. Its title is always the app's name. */
  message: string
  /** When to show it, in ms since the epoch (Date.now() + …). Omitted or past: now. */
  at?: number
  /** The app's own id, to replace or cancel it later. */
  id?: string
  /** Marbles rings until the person opens the app (or for a minute), instead of one chime. */
  alarm?: boolean
}

/** A host.notify notification was shown (main → window). */
export interface NotifiedEvent {
  appId: string
  alarm: boolean
}

export interface BridgeFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 'text' (default) or 'base64' for binary responses. */
  as?: 'text' | 'base64'
}

export interface BridgeFetchResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string // text, or base64 when init.as === 'base64'
}

export interface FrameError {
  kind: 'error' | 'unhandledrejection' | 'resource' | 'console'
  message: string
  source?: string
  line?: number
  col?: number
  stack?: string
  ts: string
}

/** Messages the shim inside the iframe posts to the host renderer. */
export type FrameToHost =
  | { __marbles: 1; kind: 'ready' }
  | { __marbles: 1; kind: 'call'; id: number; method: BridgeMethod; args: unknown[] }
  | { __marbles: 1; kind: 'error'; error: FrameError }
  /** Host shortcuts pressed while the iframe has focus (mod+N, mod+J, mod+K, mod+,). */
  | { __marbles: 1; kind: 'key'; key: string; shift: boolean }
  /** A link or window.open in the app: main asks the person before opening it. */
  | { __marbles: 1; kind: 'open'; url: string }

/** Messages the host renderer posts into the iframe. */
export type HostToFrame =
  | { __marbles: 1; kind: 'result'; id: number; ok: true; value: unknown }
  | { __marbles: 1; kind: 'result'; id: number; ok: false; error: string }
  | { __marbles: 1; kind: 'theme'; theme: 'dark' | 'light'; accent: string }

/** URL the renderer puts in the app iframe's src. Served by main via the appframe:// protocol. */
export function appFrameUrl(id: string, n: number, bust?: string | number): string {
  const q = bust !== undefined ? `?t=${encodeURIComponent(String(bust))}` : ''
  return `appframe://app/${encodeURIComponent(id)}/${n}${q}`
}

export interface ExportResult {
  path: string
  bytes: number
}

export interface LibraryFolderInfo {
  path: string
  /** Folder has no entries (or only hidden dotfiles). */
  empty: boolean
  /** Folder already contains a Marbles library (an apps/ dir). */
  isLibrary: boolean
  /** Number of app folders found in apps/ when isLibrary. */
  appCount: number
  /** Same as the current library path. */
  isCurrent: boolean
}
