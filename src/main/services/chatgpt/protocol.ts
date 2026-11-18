/**
 * Sign in with ChatGPT: protocol constants and pure helpers (no Electron imports, so the
 * node test scripts can load this file directly).
 *
 * Written from OpenAI's public SIWC docs (developers.openai.com/siwc), not from the DevKit,
 * whose license is noncommercial.
 */
import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto'
import type { GenErrorCode } from '../../../shared/types'

const ISSUER = 'https://auth.openai.com'
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
export const API_BASE = 'https://api.openai.com/v1'
export const RESOURCE = API_BASE
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
/** Without this scope the person is signed in but their plan can't pay for requests here. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CALLBACK_PATH = '/auth/callback'
export const DEFAULT_PORT = 1455
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 60_000

/** Model ids in settings, the switcher and version records carry this prefix. */
export const CHATGPT_PREFIX = 'chatgpt:'
export function isChatGPTModel(id: string): boolean {
  return id.startsWith(CHATGPT_PREFIX)
}

const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/

// ---------- PKCE, state, host id ----------

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes))
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32)
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Opaque per-install id (not tied to the person). */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`
}

// ---------- discovery ----------

export interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  revocation_endpoint?: string
}

/** Checks the discovery document belongs to OpenAI's issuer and every endpoint stays on it. */
export function validateDiscovery(j: unknown): Discovery {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
  if (o.issuer !== ISSUER) throw new Error('Unexpected sign-in issuer')
  const same = (k: string, required: boolean): string | undefined => {
    const v = o[k]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'string') throw new Error(`Sign-in configuration is missing ${k}`)
    if (new URL(v).origin !== ISSUER) throw new Error(`Sign-in ${k} is on an unexpected host`)
    return v
  }
  return {
    authorization_endpoint: same('authorization_endpoint', true)!,
    token_endpoint: same('token_endpoint', true)!,
    jwks_uri: same('jwks_uri', true)!,
    revocation_endpoint: same('revocation_endpoint', false)
  }
}

// ---------- authorize ----------

export interface AuthorizeParams {
  authorizationEndpoint: string
  redirectUri: string
  state: string
  nonce: string
  challenge: string
  /** Issued client id; omit on first sign-in to register this install. */
  clientId?: string
  appName: string
  hostId: string
  loginHint?: string
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const u = new URL(p.authorizationEndpoint)
  const q = u.searchParams
  q.set('client_id', p.clientId ?? REGISTRATION_CLIENT_ID)
  q.set('response_type', 'code')
  q.set('redirect_uri', p.redirectUri)
  q.set('scope', SCOPES)
  q.set('resource', RESOURCE)
  q.set('state', p.state)
  q.set('nonce', p.nonce)
  q.set('code_challenge_method', 'S256')
  q.set('code_challenge', p.challenge)
  q.set('ext_agent_host_id', p.hostId)
  // Docs: the name hint only goes with the registration request.
  if (!p.clientId) q.set('agent_name_hint', p.appName)
  if (p.clientId && p.loginHint) q.set('login_hint', p.loginHint)
  return u.toString()
}

export type CallbackResult =
  | { kind: 'ok'; code: string; clientId?: string; scope?: string }
  | { kind: 'error'; error: string; description?: string }
  /** Not for us (wrong state): ignore without ending the attempt. */
  | { kind: 'ignore' }

/** Reads the loopback callback query. State is checked before anything else. */
export function parseCallback(search: URLSearchParams, expectedState: string): CallbackResult {
  if (search.get('state') !== expectedState) return { kind: 'ignore' }
  const error = search.get('error')
  if (error) {
    return { kind: 'error', error, description: search.get('error_description') ?? undefined }
  }
  const codes = search.getAll('code')
  if (codes.length !== 1 || !codes[0]) {
    return { kind: 'error', error: 'invalid_callback', description: 'No sign-in code' }
  }
  const clientId = search.get('client_id') ?? undefined
  if (
    clientId !== undefined &&
    (!CLIENT_ID_RE.test(clientId) || clientId === REGISTRATION_CLIENT_ID)
  ) {
    return { kind: 'error', error: 'invalid_callback', description: 'Bad client id' }
  }
  return { kind: 'ok', code: codes[0], clientId, scope: search.get('scope') ?? undefined }
}

// ---------- tokens ----------

export interface TokenSet {
  accessToken: string
  refreshToken: string
  idToken?: string
  /** ms epoch */
  expiresAt: number
  /** ms epoch; before this a refresh is pointless unless the token expired. */
  earliestRefreshAt?: number
  scopes: string[]
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return toMs(n)
    const d = Date.parse(v)
    if (Number.isFinite(d)) return d
  }
  return undefined
}

/** Validates a token endpoint response. `prev` fills in what a refresh may leave out. */
export function parseTokenResponse(j: unknown, now: number, prev?: TokenSet): TokenSet {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
  if (typeof o.access_token !== 'string' || !o.access_token) {
    throw new Error('The sign-in server sent no access token')
  }
  if (typeof o.token_type === 'string' && o.token_type.toLowerCase() !== 'bearer') {
    throw new Error('Unexpected token type')
  }
  const refresh =
    typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : prev?.refreshToken
  if (!refresh) throw new Error('The sign-in server sent no refresh token')
  const expiresIn = typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : 3600
  const scopes =
    typeof o.scope === 'string' ? o.scope.split(/\s+/).filter(Boolean) : (prev?.scopes ?? [])
  return {
    accessToken: o.access_token,
    refreshToken: refresh,
    idToken: typeof o.id_token === 'string' ? o.id_token : prev?.idToken,
    expiresAt: now + expiresIn * 1000,
    earliestRefreshAt: toMs(o.earliest_refresh_at),
    scopes
  }
}

export function needsRefresh(t: TokenSet, now: number): boolean {
  if (t.expiresAt - now > REFRESH_MARGIN_MS) return false
  // Still valid but the server asked us to wait: keep using it.
  if (t.earliestRefreshAt && now < t.earliestRefreshAt && now < t.expiresAt) return false
  return true
}

/** Refresh errors after which only a new sign-in helps (per the SIWC errors doc). */
const REAUTH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused'
])

export function isReauthCode(code: string | undefined): boolean {
  return !!code && REAUTH_CODES.has(code)
}

/** Pulls an error code out of OAuth (`{error}`) or API (`{error:{code}}`, `{detail}`) bodies. */
export function errorCodeOf(body: unknown): { code?: string; message?: string; param?: string } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof o.error === 'string') {
    return {
      code: o.error,
      message: typeof o.error_description === 'string' ? o.error_description : undefined
    }
  }
  if (o.error && typeof o.error === 'object') {
    const e = o.error as Record<string, unknown>
    return {
      code: typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      param: typeof e.param === 'string' ? e.param : undefined
    }
  }
  if (typeof o.code === 'string') {
    return {
      code: o.code,
      message: typeof o.message === 'string' ? o.message : undefined,
      param: typeof o.param === 'string' ? o.param : undefined
    }
  }
  if (typeof o.detail === 'string') return { message: o.detail }
  return {}
}

// ---------- ID token ----------

export interface IdClaims {
  sub: string
  email?: string
  name?: string
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

/**
 * Verifies an RS256 ID token against the issuer's JWKS: signature, iss, aud, exp/iat and
 * (on sign-in) nonce. Returns the identity claims.
 */
export function verifyIdToken(
  token: string,
  jwks: unknown,
  opts: { clientId: string; nonce?: string; now: number }
): IdClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed ID token')
  const header = decodePart(parts[0])
  const claims = decodePart(parts[1])
  if (header.alg !== 'RS256') throw new Error('Unexpected ID token algorithm')
  const keys = ((jwks && typeof jwks === 'object' ? (jwks as { keys?: unknown }).keys : null) ??
    []) as Record<string, unknown>[]
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined)
  if (!jwk) throw new Error('No signing key for the ID token')
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })
  const ok = createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(key, Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new Error('ID token signature is invalid')

  const skew = 5
  const nowS = Math.floor(opts.now / 1000)
  if (claims.iss !== ISSUER) throw new Error('ID token issuer mismatch')
  const aud = claims.aud
  const audOk = Array.isArray(aud) ? aud.includes(opts.clientId) : aud === opts.clientId
  if (!audOk) throw new Error('ID token audience mismatch')
  if (claims.azp !== undefined && claims.azp !== opts.clientId) {
    throw new Error('ID token azp mismatch')
  }
  if (typeof claims.exp !== 'number' || claims.exp + skew < nowS)
    throw new Error('ID token expired')
  if (typeof claims.iat !== 'number' || claims.iat - skew > nowS)
    throw new Error('ID token not yet valid')
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce)
    throw new Error('ID token nonce mismatch')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject')
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name: typeof claims.name === 'string' ? claims.name : undefined
  }
}

// ---------- API errors → app errors ----------

export interface MappedError {
  code: GenErrorCode
  message: string
  detail: string
  transient: boolean
}

/** Maps a ChatGPT-plan API failure (HTTP or in-stream) to the app's error codes and wording. */
export function mapApiError(
  status: number | undefined,
  code: string | undefined,
  message: string | undefined,
  param?: string
): MappedError {
  const detail = [status ? `HTTP ${status}` : 'in stream', code, param && `param=${param}`, message]
    .filter(Boolean)
    .join(': ')
  const m = (c: GenErrorCode, text: string, transient = false): MappedError => ({
    code: c,
    message: text,
    detail,
    transient
  })
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return m('plan_limit', "You've reached your ChatGPT plan's limit for Marbles.")
    case 'subscription_sharing_usage_unavailable':
      return m('model', 'ChatGPT is having trouble right now. Try again in a minute.', true)
    case 'subscription_sharing_user_not_eligible':
      return m('signin', "Your ChatGPT plan can't be used in other apps.")
    case 'subscription_sharing_invalid_user':
      return m('signin', 'Sign in to ChatGPT again to keep using your plan.')
    case 'subscription_sharing_unsupported_capability':
      return m('model', "ChatGPT couldn't handle this request with your plan.")
  }
  switch (status) {
    case 401:
      return m('signin', 'Sign in to ChatGPT again to keep using your plan.')
    case 403:
      return m('signin', "Your ChatGPT plan can't be used here right now.")
    case 429:
      return m('plan_limit', "You've reached your ChatGPT plan's limit for Marbles.")
    case 400:
    case 404:
    case 413:
    case 422:
      return m(
        'model',
        "The AI couldn't handle this request. Try rewording it, or ask for something smaller."
      )
    case 408:
    case 500:
    case 502:
    case 503:
    case 504:
      return m('model', 'ChatGPT is having trouble right now. Try again in a minute.', true)
  }
  if (status === undefined) {
    return m('model', 'The AI ran into a problem. Please try again.', true)
  }
  return m(
    'unknown',
    "Something went wrong on ChatGPT's side. Try again in a minute.",
    status >= 500
  )
}
