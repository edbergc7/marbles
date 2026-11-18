import type { Notice, NoticeLevel, NoticesState } from '../../shared/types'

/**
 * Update checks and announcements.
 *
 * Builds are unsigned, so there is no auto-install: Marbles only tells the person a new release
 * exists and links to its GitHub page. Announcements ("this version has a bug", "Marbles is no
 * longer maintained") come from announcements.json in the repo, so posting one needs no release.
 *
 * Both are plain GETs to GitHub with no identifiers, and Settings can turn them off.
 * Kept free of Electron imports so scripts/test-notices.mjs can run it under plain Node.
 */

/** A notice plus the link main opens for it. The renderer only ever sees the id. */
export type NoticeWithUrl = Notice & { url?: string }

interface Semver {
  major: number
  minor: number
  patch: number
  pre: string | null
}

export function parseVersion(v: unknown): Semver | null {
  if (typeof v !== 'string') return null
  const m = v
    .trim()
    .match(/^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+.*)?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
}

/** Negative when a < b, positive when a > b. A prerelease sorts before its release. */
export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const pa = a.pre.split('.')
  const pb = b.pre.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1
    if (pb[i] === undefined) return 1
    const na = /^\d+$/.test(pa[i]) ? +pa[i] : NaN
    const nb = /^\d+$/.test(pb[i]) ? +pb[i] : NaN
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb
    } else if (pa[i] !== pb[i]) {
      if (!isNaN(na)) return -1
      if (!isNaN(nb)) return 1
      return pa[i] < pb[i] ? -1 : 1
    }
  }
  return 0
}

/** Trims, drops control characters and caps length. Text is shown as plain text, never HTML. */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined
  } catch {
    return undefined
  }
}

const LEVELS: NoticeLevel[] = ['info', 'warning', 'critical']
const MAX_ANNOUNCEMENTS = 5

interface NoticeContext {
  /** The running app's version. */
  version: string
  platform: string
  now: number
}

/**
 * Turns announcements.json into the notices that apply to this build.
 *
 *   { "announcements": [ { "id": "2027-eol", "level": "warning", "title": "...", "body": "...",
 *       "url": "https://...", "linkLabel": "Read more", "minVersion": "1.0.0",
 *       "maxVersion": "1.9.9", "platforms": ["win32"], "expires": "2027-06-01",
 *       "dismissible": true } ] }
 *
 * Entries that don't parse are skipped, so one bad entry can't hide the others.
 */
export function parseAnnouncements(json: unknown, ctx: NoticeContext): NoticeWithUrl[] {
  const list = (json as { announcements?: unknown } | null)?.announcements
  if (!Array.isArray(list)) return []
  const current = parseVersion(ctx.version)
  const out: NoticeWithUrl[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    const id = typeof a.id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(a.id) ? a.id : null
    const title = cleanText(a.title, 120)
    if (!id || !title || seen.has(id)) continue

    if (current) {
      const min = parseVersion(a.minVersion)
      const max = parseVersion(a.maxVersion)
      if (min && compareVersions(current, min) < 0) continue
      if (max && compareVersions(current, max) > 0) continue
    }
    if (Array.isArray(a.platforms) && !a.platforms.includes(ctx.platform)) continue
    if (typeof a.expires === 'string') {
      const t = Date.parse(a.expires)
      if (!isNaN(t) && t <= ctx.now) continue
    }

    const url = httpsUrl(a.url)
    const level = LEVELS.includes(a.level as NoticeLevel) ? (a.level as NoticeLevel) : 'info'
    seen.add(id)
    out.push({
      id: `news:${id}`,
      kind: 'announcement',
      level,
      title,
      body: cleanText(a.body, 600),
      linkLabel: url ? cleanText(a.linkLabel, 30) || 'Read more' : undefined,
      url,
      dismissible: a.dismissible !== false
    })
    if (out.length >= MAX_ANNOUNCEMENTS) break
  }
  return out
}

/** Reads GitHub's /releases/latest response. Returns the newer version and its page, or null. */
export function parseLatestRelease(
  json: unknown,
  repo: string
): { version: string; url: string } | null {
  const r = json as {
    tag_name?: unknown
    html_url?: unknown
    draft?: unknown
    prerelease?: unknown
  }
  if (!r || r.draft || r.prerelease) return null
  const v = parseVersion(r.tag_name)
  if (!v) return null
  const url = httpsUrl(r.html_url)
  // Only ever link to this repo's own release pages.
  const page = url?.startsWith(`https://github.com/${repo}/releases/`)
    ? url
    : `https://github.com/${repo}/releases/latest`
  return { version: `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`, url: page }
}

export function updateNotice(
  latest: { version: string; url: string },
  current: string
): NoticeWithUrl | null {
  const a = parseVersion(latest.version)
  const b = parseVersion(current)
  if (!a || !b || compareVersions(a, b) <= 0) return null
  return {
    id: `update:${latest.version}`,
    kind: 'update',
    level: 'info',
    title: `Marbles ${latest.version} is available`,
    body: `You have ${current}. Download the new version from GitHub and install it over this one. Your apps and settings stay.`,
    linkLabel: 'Download',
    url: latest.url,
    dismissible: true
  }
}

export interface NoticesDeps {
  version: string
  platform: string
  /** "owner/name", or null when checks are off for this build. */
  repo: string | null
  releasesUrl: string | null
  announcementsUrl: string | null
  /** GETs a URL and parses it as JSON. Rejects on network errors and non-2xx responses. */
  fetchJson: (url: string) => Promise<unknown>
  isEnabled: () => Promise<boolean>
  getDismissed: () => Promise<string[]>
  setDismissed: (ids: string[]) => Promise<void>
  openUrl: (url: string) => void
  emit: (state: NoticesState) => void
  /**
   * Notices about this computer (e.g. a library from a newer Marbles). Involve no network,
   * so they show even when checks are off or the build has no repo.
   */
  local?: () => Promise<NoticeWithUrl[]>
  now?: () => number
}

export class NoticesService {
  private update: NoticeWithUrl | null = null
  private news: NoticeWithUrl[] = []
  private latestVersion: string | null = null
  private lastCheck: number | null = null
  private lastError: string | null = null
  private checking: Promise<void> | null = null
  private local: NoticeWithUrl[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: NoticesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  get available(): boolean {
    return !!this.deps.repo && (!!this.deps.releasesUrl || !!this.deps.announcementsUrl)
  }

  private all(): NoticeWithUrl[] {
    // Announcements first: a "stop using this version" warning matters more than an update.
    const order = { critical: 0, warning: 1, info: 2 }
    const news = [...this.news].sort((a, b) => order[a.level] - order[b.level])
    return this.update ? [...news, this.update] : news
  }

  async state(): Promise<NoticesState> {
    const enabled = this.available && (await this.deps.isEnabled())
    const dismissed = new Set(await this.deps.getDismissed())
    this.local = (await this.deps.local?.().catch(() => [])) ?? []
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const strip = ({ url, ...n }: NoticeWithUrl): Notice => n
    return {
      appVersion: this.deps.version,
      available: this.available,
      enabled,
      checking: !!this.checking,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      latestVersion: this.latestVersion,
      updateAvailable: enabled && !!this.update,
      notices: [
        ...this.local,
        ...(enabled ? this.all().filter((n) => !(n.dismissible && dismissed.has(n.id))) : [])
      ].map(strip)
    }
  }

  /** Re-reads the local notices and tells the windows. */
  refresh(): Promise<NoticesState> {
    return this.broadcast()
  }

  private async broadcast(): Promise<NoticesState> {
    const s = await this.state()
    this.deps.emit(s)
    return s
  }

  /** Runs one check; concurrent calls share it. Never rejects. */
  async check(): Promise<NoticesState> {
    if (!this.available || !(await this.deps.isEnabled())) return this.broadcast()
    if (!this.checking) {
      this.checking = this.run().finally(() => {
        this.checking = null
      })
      void this.broadcast()
    }
    await this.checking
    return this.broadcast()
  }

  private async run(): Promise<void> {
    const { repo, releasesUrl, announcementsUrl } = this.deps
    const ctx = { version: this.deps.version, platform: this.deps.platform, now: this.now() }
    const errors: string[] = []
    // A failed source keeps its last result, so going offline doesn't hide a notice.
    await Promise.all([
      releasesUrl && repo
        ? this.deps.fetchJson(releasesUrl).then(
            (json) => {
              const latest = parseLatestRelease(json, repo)
              this.latestVersion = latest?.version ?? null
              this.update = latest ? updateNotice(latest, ctx.version) : null
            },
            (err) => errors.push(`releases: ${errMsg(err)}`)
          )
        : null,
      announcementsUrl
        ? this.deps.fetchJson(announcementsUrl).then(
            (json) => {
              this.news = parseAnnouncements(json, ctx)
            },
            (err) => errors.push(`announcements: ${errMsg(err)}`)
          )
        : null
    ])
    this.lastCheck = this.now()
    this.lastError = errors.length ? errors.join('; ') : null
    if (errors.length) console.warn('[notices] check failed:', this.lastError)
  }

  async dismiss(id: string): Promise<NoticesState> {
    const n = this.all().find((x) => x.id === id)
    if (n?.dismissible) {
      // Keep only ids that still exist, plus this one, so the list can't grow forever.
      const live = new Set(this.all().map((x) => x.id))
      const kept = (await this.deps.getDismissed()).filter((d) => live.has(d) && d !== id)
      await this.deps.setDismissed([...kept, id])
    }
    return this.broadcast()
  }

  open(id: string): void {
    const n = [...this.local, ...this.all()].find((x) => x.id === id)
    if (n?.url) this.deps.openUrl(n.url)
  }

  /** Clears what was found, e.g. after checks are turned off. */
  async reset(): Promise<NoticesState> {
    this.update = null
    this.news = []
    this.latestVersion = null
    this.lastError = null
    return this.broadcast()
  }

  /** First check after `delayMs`, then every `everyMs`. */
  start(delayMs: number, everyMs: number): void {
    if (!this.available || this.timer) return
    setTimeout(() => void this.check(), delayMs)
    this.timer = setInterval(() => void this.check(), everyMs)
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
