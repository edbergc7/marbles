// Pure checks behind the main window's security guards, kept free of Electron so they can be tested.
import { posix } from 'path'
import type { Settings } from '../../shared/types'

/** The packaged renderer is served from app://marbles/ (see appScheme.ts), never file://. */
export const APP_SCHEME = 'app'
export const APP_HOST = 'marbles'
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** Where the trusted renderer page lives: the dev server's origin, or app://marbles. */
export type AppPage = { kind: 'origin'; origin: string } | { kind: 'app' }

export function appPageFor(devUrl: string | undefined): AppPage {
  if (devUrl) return { kind: 'origin', origin: new URL(devUrl).origin }
  return { kind: 'app' }
}

/**
 * True only for the app's own renderer page. Outside dev mode that is app://marbles, so a
 * local HTML file loaded into the window never gets the preload API. Query and hash are ignored.
 * (URL.origin is "null" for custom schemes in Node, so scheme and host are compared instead.)
 */
export function isAppPageUrl(url: string, page: AppPage): boolean {
  try {
    const u = new URL(url)
    if (page.kind === 'origin') return u.origin === page.origin
    return u.protocol === `${APP_SCHEME}:` && u.host.toLowerCase() === APP_HOST
  } catch {
    return false
  }
}

/**
 * Maps an app:// request path to a file path relative to the renderer folder, or null when
 * it would leave that folder. "/" means index.html.
 */
export function appRelativePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const rel = posix.normalize('/' + decoded).slice(1)
  if (!rel) return 'index.html'
  if (rel === '..' || rel.startsWith('../') || rel.endsWith('/')) return null
  return rel
}

interface FrameLike {
  url: string
  processId: number
  routingId: number
}

/** True when an IPC message came from the main frame of its window and that frame shows the app. */
export function isTrustedSender(
  senderFrame: FrameLike | null | undefined,
  mainFrame: FrameLike | null | undefined,
  isAppUrl: (url: string) => boolean
): boolean {
  try {
    if (!senderFrame || !mainFrame) return false
    if (senderFrame.processId !== mainFrame.processId) return false
    if (senderFrame.routingId !== mainFrame.routingId) return false
    return isAppUrl(senderFrame.url)
  } catch {
    // a disposed frame throws on access
    return false
  }
}

const SETTING_CHECKS: Partial<Record<keyof Settings, (v: unknown) => boolean>> = {
  builderModel: isModelId,
  utilityModel: isModelId,
  namingModel: isModelId,
  reasoningEffort: (v) => v === 'off' || v === 'low' || v === 'medium' || v === 'high',
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
  accent: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v),
  allowLocalNetwork: isBool,
  showAdvanced: isBool,
  chatgptWelcomed: isBool,
  setupDone: isBool,
  checkForUpdates: isBool
}

function isBool(v: unknown): boolean {
  return typeof v === 'boolean'
}

function isModelId(v: unknown): boolean {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\s]/.test(v)
}

/**
 * The part of a settings patch the window may apply. Keys main owns (format, libraryPath,
 * dismissedNotices), unknown keys and values of the wrong type are dropped: the library folder
 * only changes through the libraryLocation handlers, which check the target first.
 */
export function cleanSettingsPatch(patch: unknown): Partial<Settings> {
  const out: Record<string, unknown> = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const [key, check] of Object.entries(SETTING_CHECKS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    const value = (patch as Record<string, unknown>)[key]
    if (check(value)) out[key] = value
  }
  return out as Partial<Settings>
}

/** The only permission granted: writing to the clipboard (copy buttons in the UI and apps). */
export function isAllowedPermission(permission: string): boolean {
  return permission === 'clipboard-sanitized-write'
}

/** A URL we would hand to the system browser: http(s) only, and no user:pass@ part. */
export function parseOpenableUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (!u.hostname) return null
  return u
}

const MAX_URL_SHOWN = 300

/**
 * Text for the "open this link?" prompt. The host comes first so it can't be hidden in a long
 * URL; URL serialization already punycodes the host and percent-encodes non-ASCII elsewhere.
 */
export function linkPromptText(u: URL): { message: string; detail: string } {
  const href = u.href.length > MAX_URL_SHOWN ? u.href.slice(0, MAX_URL_SHOWN) + '…' : u.href
  return {
    message: 'Open this link in your browser?',
    detail: `${u.host}\n\n${href}`
  }
}

/**
 * Lets one link prompt show at a time, and none for a short while after one is cancelled,
 * so an app can't pile up dialogs.
 */
export interface PromptGate {
  tryOpen(): boolean
  close(cancelled: boolean): void
}

export function createPromptGate(cooldownMs = 1000, now: () => number = Date.now): PromptGate {
  let open = false
  let quietUntil = 0
  return {
    tryOpen(): boolean {
      if (open || now() < quietUntil) return false
      open = true
      return true
    },
    close(cancelled: boolean): void {
      open = false
      if (cancelled) quietUntil = now() + cooldownMs
    }
  }
}
