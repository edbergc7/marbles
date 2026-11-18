import { app, net, safeStorage, shell } from 'electron'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { writeAtomic } from '../library'
import {
  allowSafeStorageFallback,
  canPersistSecrets,
  safeStorageInsecure,
  tightenPermissions
} from '../secrets'
import type { ChatGPTStatus } from '../../../shared/types'
import {
  CALLBACK_PATH,
  DEFAULT_PORT,
  DISCOVERY_URL,
  PLAN_SCOPE,
  RESOURCE,
  buildAuthorizeUrl,
  errorCodeOf,
  isReauthCode,
  needsRefresh,
  newHostId,
  parseCallback,
  parseTokenResponse,
  pkcePair,
  randomToken,
  validateDiscovery,
  verifyIdToken,
  type Discovery,
  type IdClaims,
  type TokenSet
} from './protocol'

const APP_NAME = 'Marbles'
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const HTTP_TIMEOUT_MS = 20_000

/** Thrown when there is no usable session; `reauth` means the person must sign in again. */
export class ChatGPTAuthError extends Error {
  constructor(
    message: string,
    public reauth: boolean,
    public transient = false
  ) {
    super(message)
    this.name = 'ChatGPTAuthError'
  }
}

interface Session {
  tokens: TokenSet
  identity: IdClaims
}

/** On disk: registration and host id in the clear (not secret), session encrypted. */
interface StoredFile {
  v: 1
  hostId: string
  clientId?: string
  /** safeStorage-encrypted JSON of Session, base64. */
  session?: string
  /** Kept after the session ends, for the login hint and the "sign in again" text. */
  lastEmail?: string
  reauthRequired?: boolean
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? HTTP_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, { ...init, signal: ac.signal, redirect: 'error' })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { detail: text.slice(0, 200) }
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString()
  }
}

const DONE_PAGE = (ok: boolean, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Marbles</title>` +
  `<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
  `<div style="text-align:center"><h2>${ok ? 'Signed in' : 'Sign-in stopped'}</h2>` +
  `<p>${text}</p></div></body>`

export class ChatGPTAuth {
  private stored: StoredFile | null = null
  private session: Session | null = null
  private discovery: Discovery | null = null
  private jwks: unknown = null
  private refreshing: Promise<Session> | null = null
  private signIn_: { server: Server; abort: (reason: Error) => void; url: string } | null = null
  private listeners = new Set<(s: ChatGPTStatus) => void>()

  private get file(): string {
    return join(app.getPath('userData'), 'chatgpt.json')
  }

  // ---------- storage ----------

  private async load(): Promise<StoredFile> {
    if (this.stored) return this.stored
    let s: StoredFile | null = null
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<StoredFile>
      await tightenPermissions(this.file)
      if (raw.v === 1 && typeof raw.hostId === 'string') s = raw as StoredFile
    } catch {
      // first run or unreadable: start fresh
    }
    if (!s) s = { v: 1, hostId: newHostId() }
    if (s.session) {
      try {
        allowSafeStorageFallback()
        const json = safeStorage.decryptString(Buffer.from(s.session, 'base64'))
        this.session = JSON.parse(json) as Session
      } catch {
        // Undecryptable (keyring changed): treat as signed out but keep the registration.
        s.session = undefined
        this.session = null
      }
    }
    this.stored = s
    return s
  }

  private async save(): Promise<void> {
    const s = await this.load()
    if (this.session && (await canPersistSecrets())) {
      allowSafeStorageFallback()
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this system')
      }
      s.session = safeStorage.encryptString(JSON.stringify(this.session)).toString('base64')
    } else {
      // Signed out, or session only (no keyring): nothing secret goes to disk.
      s.session = undefined
    }
    await fs.mkdir(dirname(this.file), { recursive: true })
    await writeAtomic(this.file, JSON.stringify(s), { mode: 0o600 })
  }

  // ---------- status ----------

  async status(): Promise<ChatGPTStatus> {
    const s = await this.load()
    if (this.signIn_) return { state: 'signing_in', url: this.signIn_.url }
    if (this.session) {
      return {
        state: 'signed_in',
        email: this.session.identity.email,
        name: this.session.identity.name,
        planOk: this.session.tokens.scopes.includes(PLAN_SCOPE),
        insecureStorage: safeStorageInsecure()
      }
    }
    if (s.reauthRequired) return { state: 'reauth_required', email: s.lastEmail }
    return { state: 'signed_out' }
  }

  onStatus(cb: (s: ChatGPTStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private async emit(): Promise<void> {
    const st = await this.status()
    for (const cb of this.listeners) {
      try {
        cb(st)
      } catch {
        // a listener's problem is not ours
      }
    }
  }

  /** Account id for cache keys (models list). Null when signed out. */
  accountId(): string | null {
    return this.session?.identity.sub ?? null
  }

  // ---------- discovery ----------

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const { status, body } = await fetchJson(DISCOVERY_URL)
    if (status !== 200)
      throw new Error(`Couldn't load the ChatGPT sign-in settings (HTTP ${status})`)
    this.discovery = validateDiscovery(body)
    return this.discovery
  }

  private async getJwks(force = false): Promise<unknown> {
    if (this.jwks && !force) return this.jwks
    const d = await this.getDiscovery()
    const { status, body } = await fetchJson(d.jwks_uri)
    if (status !== 200) throw new Error(`Couldn't load ChatGPT's signing keys (HTTP ${status})`)
    this.jwks = body
    return body
  }

  private async verify(idToken: string, clientId: string, nonce?: string): Promise<IdClaims> {
    const opts = { clientId, nonce, now: Date.now() }
    try {
      return verifyIdToken(idToken, await this.getJwks(), opts)
    } catch (err) {
      // Keys rotate: retry once with a fresh key set before giving up.
      if (err instanceof Error && err.message === 'No signing key for the ID token') {
        return verifyIdToken(idToken, await this.getJwks(true), opts)
      }
      throw err
    }
  }

  // ---------- sign in ----------

  /**
   * Opens the browser for ChatGPT sign-in and waits for the loopback callback.
   * Resolves with the new status; rejects if cancelled, timed out or refused.
   */
  async signIn(): Promise<ChatGPTStatus> {
    if (this.signIn_) this.signIn_.abort(new Error('Sign-in restarted'))
    const s = await this.load()
    const d = await this.getDiscovery()
    const { verifier, challenge } = pkcePair()
    const state = randomToken()
    const nonce = randomToken()

    // When developing inside a container or VM, the listener port and the port the browser reaches
    // can differ, and a mapped port can't reach 127.0.0.1 inside it. Development only.
    const dev = !app.isPackaged
    const envPort = dev ? Number(process.env['MARBLES_OAUTH_PORT']) : NaN
    const envRedirect = dev ? Number(process.env['MARBLES_OAUTH_REDIRECT_PORT']) : NaN
    const listenHost = (dev && process.env['MARBLES_OAUTH_LISTEN_HOST']) || '127.0.0.1'
    const server = createServer()
    const port = await listen(
      server,
      Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT,
      listenHost
    )
    const redirectPort = Number.isInteger(envRedirect) && envRedirect > 0 ? envRedirect : port
    const redirectUri = `http://127.0.0.1:${redirectPort}${CALLBACK_PATH}`
    const pendingClientId = s.clientId

    const url = buildAuthorizeUrl({
      authorizationEndpoint: d.authorization_endpoint,
      redirectUri,
      state,
      nonce,
      challenge,
      clientId: pendingClientId,
      appName: APP_NAME,
      hostId: s.hostId,
      loginHint: s.lastEmail
    })

    const callback = new Promise<{ code: string; clientId?: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Sign-in timed out. Please try again.')),
        SIGN_IN_TIMEOUT_MS
      )
      const finish = (err: Error | null, value?: { code: string; clientId?: string }): void => {
        clearTimeout(timer)
        server.close()
        server.closeAllConnections?.()
        if (this.signIn_?.server === server) this.signIn_ = null
        if (err) reject(err)
        else resolve(value!)
      }
      server.on('request', (req, res) => {
        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${redirectPort}`)
        const hostOk = req.headers.host === `127.0.0.1:${redirectPort}`
        if (req.method !== 'GET' || reqUrl.pathname !== CALLBACK_PATH || !hostOk) {
          res.writeHead(404).end()
          return
        }
        const r = parseCallback(reqUrl.searchParams, state)
        if (r.kind === 'ignore') {
          res.writeHead(400).end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        if (r.kind === 'error') {
          res.end(DONE_PAGE(false, 'You can close this tab and go back to Marbles.'))
          const msg =
            r.error === 'access_denied'
              ? 'Sign-in was cancelled.'
              : `ChatGPT sign-in failed (${r.error}${r.description ? `: ${r.description}` : ''}).`
          finish(new Error(msg))
          return
        }
        res.end(DONE_PAGE(true, 'You can close this tab and go back to Marbles.'))
        finish(null, { code: r.code, clientId: r.clientId })
      })
      this.signIn_ = { server, url, abort: (e) => finish(e) }
    })

    void this.emit()
    void shell.openExternal(url).catch(() => {
      // No browser opened: the UI shows the link to copy.
    })

    try {
      const cb = await callback
      // Registration returns the issued id on the callback; a reauthorization may omit it.
      const clientId = pendingClientId ?? cb.clientId
      if (!clientId)
        throw new Error('ChatGPT sign-in did not finish registering Marbles. Try again.')
      if (pendingClientId && cb.clientId && cb.clientId !== pendingClientId) {
        throw new Error('ChatGPT sign-in returned a different app id. Try again.')
      }

      const { status, body } = await fetchJson(
        d.token_endpoint,
        form({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: cb.code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE
        })
      )
      if (status !== 200) {
        const e = errorCodeOf(body)
        throw new Error(
          `ChatGPT sign-in failed (${e.code ?? `HTTP ${status}`}${e.message ? `: ${e.message}` : ''}).`
        )
      }
      const tokens = parseTokenResponse(body, Date.now())
      if (!tokens.idToken) throw new Error('ChatGPT sign-in sent no ID token.')
      const identity = await this.verify(tokens.idToken, clientId, nonce)

      s.clientId = clientId
      s.lastEmail = identity.email
      s.reauthRequired = false
      this.session = { tokens, identity }
      await this.save()
      return await this.status()
    } finally {
      void this.emit()
    }
  }

  cancelSignIn(): void {
    this.signIn_?.abort(new Error('Sign-in was cancelled.'))
  }

  // ---------- tokens ----------

  /** A valid access token, refreshed if needed. Concurrent callers share one refresh. */
  async accessToken(): Promise<string> {
    await this.load()
    const cur = this.session
    if (!cur) {
      const reauth = !!this.stored?.reauthRequired
      throw new ChatGPTAuthError(
        reauth
          ? 'Sign in to ChatGPT again to keep using your plan.'
          : 'Sign in with ChatGPT first.',
        reauth
      )
    }
    if (!needsRefresh(cur.tokens, Date.now())) return cur.tokens.accessToken
    this.refreshing ??= this.refresh(cur).finally(() => {
      this.refreshing = null
    })
    return (await this.refreshing).tokens.accessToken
  }

  /** Forces the next accessToken() to refresh (after a 401 that may be a stale token). */
  invalidateAccessToken(): void {
    if (this.session) this.session.tokens.expiresAt = 0
  }

  private async refresh(cur: Session): Promise<Session> {
    const s = await this.load()
    const d = await this.getDiscovery()
    if (!s.clientId)
      throw await this.endSession('Sign in to ChatGPT again to keep using your plan.')
    let res: { status: number; body: unknown }
    try {
      res = await fetchJson(
        d.token_endpoint,
        form({
          grant_type: 'refresh_token',
          client_id: s.clientId,
          refresh_token: cur.tokens.refreshToken,
          resource: RESOURCE
        })
      )
    } catch {
      throw new ChatGPTAuthError(
        "Couldn't reach ChatGPT. Check your internet connection and try again.",
        false,
        true
      )
    }
    if (res.status !== 200) {
      const e = errorCodeOf(res.body)
      if (e.code === 'invalid_client') {
        // Our registration is no longer accepted: register again on the next sign-in.
        s.clientId = undefined
        throw await this.endSession('Sign in to ChatGPT again to keep using your plan.')
      }
      if (isReauthCode(e.code) || (res.status === 401 && !e.code)) {
        throw await this.endSession(
          'Your ChatGPT sign-in expired. Sign in again to keep using your plan.'
        )
      }
      // Temporary trouble (or something unexpected): keep the session so a later try can work.
      throw new ChatGPTAuthError(
        res.status >= 500
          ? 'ChatGPT is having trouble right now. Try again in a minute.'
          : `ChatGPT refused to renew the sign-in (${e.code ?? `HTTP ${res.status}`}).`,
        false,
        res.status >= 500
      )
    }
    const tokens = parseTokenResponse(res.body, Date.now(), cur.tokens)
    let identity = cur.identity
    if (tokens.idToken && tokens.idToken !== cur.tokens.idToken) {
      const claims = await this.verify(tokens.idToken, s.clientId)
      if (claims.sub !== cur.identity.sub) {
        throw await this.endSession('ChatGPT returned a different account. Sign in again.')
      }
      identity = { ...cur.identity, ...claims }
    }
    const next: Session = { tokens, identity }
    // Persist the rotated refresh token before anyone uses the new access token.
    this.session = next
    await this.save()
    return next
  }

  /** Drops the local session after a terminal error and returns the error to throw. */
  private async endSession(message: string): Promise<ChatGPTAuthError> {
    const s = await this.load()
    this.session = null
    s.reauthRequired = true
    await this.save().catch(() => {})
    void this.emit()
    return new ChatGPTAuthError(message, true)
  }

  // ---------- sign out ----------

  /** Revokes the session at OpenAI, then forgets it locally (even if revoking failed). */
  async signOut(): Promise<{ revoked: boolean }> {
    const s = await this.load()
    const cur = this.session
    let revoked = !cur
    if (cur && s.clientId) {
      try {
        const d = await this.getDiscovery()
        if (d.revocation_endpoint) {
          const body = form({
            token: cur.tokens.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: s.clientId
          })
          for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
            try {
              const r = await fetchJson(d.revocation_endpoint, body)
              if (r.status === 200) revoked = true
              else if (r.status < 500) break
            } catch {
              // network: retry once
            }
            if (!revoked && attempt === 0) await new Promise((r) => setTimeout(r, 300))
          }
        }
      } catch {
        // discovery failed: still sign out locally
      }
    }
    this.session = null
    s.reauthRequired = false
    await this.save()
    void this.emit()
    return { revoked }
  }
}

/** Listens on host:preferred (127.0.0.1 normally), or any free port if that one is taken. */
function listen(server: Server, preferred: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, fallback: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (fallback && err.code === 'EADDRINUSE') tryPort(0, false)
        else reject(err)
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve((server.address() as AddressInfo).port)
      })
    }
    tryPort(preferred, true)
  })
}
