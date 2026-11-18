/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run: node scripts/test-chatgpt.mjs   (Node >= 22.18 strips TS types natively)
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, createSign } from 'node:crypto'
import { ResponsesStreamParser } from '../src/main/services/chatgpt/responsesStream.ts'
import {
  buildAuthorizeUrl,
  parseCallback,
  parseTokenResponse,
  needsRefresh,
  pkcePair,
  validateDiscovery,
  verifyIdToken,
  mapApiError,
  errorCodeOf,
  isReauthCode
} from '../src/main/services/chatgpt/protocol.ts'
import { chatgptRoleDefaults } from '../src/main/services/chatgpt/roles.ts'

let n = 0
function t(name, fn) {
  fn()
  n++
  console.log('ok -', name)
}

const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
const run = (text, size = text.length) => {
  const p = new ResponsesStreamParser()
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(...p.feed(text.slice(i, i + size)))
  out.push(...p.end())
  return out
}

// ---------- stream parser ----------

const happy =
  sse({ type: 'response.created', response: {} }) +
  sse({ type: 'response.output_text.delta', delta: 'Hel' }) +
  sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }) +
  sse({ type: 'response.output_text.delta', delta: 'lo' }) +
  sse({
    type: 'response.completed',
    response: { usage: { input_tokens: 10, output_tokens: 2 } }
  })

t('deltas, reasoning and completed with usage', () => {
  assert.deepEqual(run(happy), [
    { type: 'text', text: 'Hel' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'lo' },
    { type: 'completed', usage: { inputTokens: 10, outputTokens: 2 } }
  ])
})

t('same result when split into tiny chunks and CRLF lines', () => {
  assert.deepEqual(run(happy, 3), run(happy))
  assert.deepEqual(run(happy.replace(/\n/g, '\r\n'), 7), run(happy))
})

t('completed without usage', () => {
  assert.deepEqual(run(sse({ type: 'response.completed', response: {} })), [
    { type: 'completed', usage: null }
  ])
})

t('incomplete carries the reason', () => {
  const s = sse({
    type: 'response.incomplete',
    response: { incomplete_details: { reason: 'max_output_tokens' } }
  })
  assert.deepEqual(run(s), [{ type: 'incomplete', reason: 'max_output_tokens' }])
})

t('usage limit failure after text has started', () => {
  const s =
    sse({ type: 'response.output_text.delta', delta: 'partial' }) +
    sse({
      type: 'response.failed',
      response: {
        error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' }
      }
    })
  assert.deepEqual(run(s), [
    { type: 'text', text: 'partial' },
    {
      type: 'failed',
      code: 'subscription_sharing_usage_limit_exceeded',
      message: 'limit',
      param: undefined
    }
  ])
})

t('error event, flat and nested', () => {
  assert.deepEqual(run(sse({ type: 'error', code: 'x', message: 'm' })), [
    { type: 'failed', code: 'x', message: 'm', param: undefined }
  ])
  assert.deepEqual(run(sse({ type: 'error', error: { code: 'y', param: 'reasoning' } })), [
    { type: 'failed', code: 'y', message: undefined, param: 'reasoning' }
  ])
})

t('stream cut off: no terminal event, last unterminated data still read', () => {
  const s =
    sse({ type: 'response.output_text.delta', delta: 'a' }) +
    'data: ' +
    JSON.stringify({ type: 'response.output_text.delta', delta: 'b' })
  const ev = run(s)
  assert.deepEqual(ev, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' }
  ])
  assert.ok(!ev.some((e) => e.type === 'completed'))
})

t('ignores comments, [DONE], junk and unknown events', () => {
  const s = ': ping\n\ndata: [DONE]\n\ndata: {not json\n\n' + sse({ type: 'response.in_progress' })
  assert.deepEqual(run(s), [])
})

t('bare JSON lines without data: prefix', () => {
  const s =
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }) +
    '\n' +
    JSON.stringify({ type: 'response.completed', response: {} }) +
    '\n'
  assert.deepEqual(run(s), [
    { type: 'text', text: 'x' },
    { type: 'completed', usage: null }
  ])
})

// ---------- OAuth helpers ----------

t('PKCE challenge is base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = pkcePair()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

const base = {
  authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
  redirectUri: 'http://127.0.0.1:1455/auth/callback',
  state: 'S',
  nonce: 'N',
  challenge: 'C',
  appName: 'Marbles',
  hostId: 'urn:uuid:1'
}

t('first sign-in registers with the name hint', () => {
  const q = new URL(buildAuthorizeUrl({ ...base, loginHint: 'a@b.c' })).searchParams
  assert.equal(q.get('client_id'), 'dynamic_agent_client')
  assert.equal(q.get('agent_name_hint'), 'Marbles')
  assert.equal(q.get('login_hint'), null)
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('resource'), 'https://api.openai.com/v1')
  assert.ok(q.get('scope').split(' ').includes('chatgpt.tokens.use.direct'))
  assert.equal(q.get('ext_agent_host_id'), 'urn:uuid:1')
})

t('later sign-in uses the issued id, no name hint', () => {
  const q = new URL(buildAuthorizeUrl({ ...base, clientId: 'oaiapp_1', loginHint: 'a@b.c' }))
    .searchParams
  assert.equal(q.get('client_id'), 'oaiapp_1')
  assert.equal(q.get('agent_name_hint'), null)
  assert.equal(q.get('login_hint'), 'a@b.c')
})

t('callback: state checked first, then error, code, client id', () => {
  const p = (s) => parseCallback(new URLSearchParams(s), 'S')
  assert.deepEqual(p('state=X&code=1'), { kind: 'ignore' })
  assert.equal(p('state=S&error=access_denied').kind, 'error')
  assert.equal(p('state=S').kind, 'error')
  assert.equal(p('state=S&code=1&code=2').kind, 'error')
  assert.equal(p('state=S&code=1&client_id=dynamic_agent_client').kind, 'error')
  assert.equal(p('state=S&code=1&client_id=bad%20id').kind, 'error')
  assert.deepEqual(p('state=S&code=1&client_id=oaiapp_1&scope=a+b'), {
    kind: 'ok',
    code: '1',
    clientId: 'oaiapp_1',
    scope: 'a b'
  })
})

t('discovery must stay on auth.openai.com', () => {
  const good = {
    issuer: 'https://auth.openai.com',
    authorization_endpoint: 'https://auth.openai.com/a',
    token_endpoint: 'https://auth.openai.com/t',
    jwks_uri: 'https://auth.openai.com/j'
  }
  assert.equal(validateDiscovery(good).revocation_endpoint, undefined)
  assert.throws(() => validateDiscovery({ ...good, issuer: 'https://evil.example' }))
  assert.throws(() => validateDiscovery({ ...good, token_endpoint: 'https://evil.example/t' }))
})

t('token response parsing and refresh timing', () => {
  const now = 1_000_000
  const tk = parseTokenResponse(
    {
      access_token: 'a',
      refresh_token: 'r',
      id_token: 'i',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'x y'
    },
    now
  )
  assert.equal(tk.expiresAt, now + 3_600_000)
  assert.deepEqual(tk.scopes, ['x', 'y'])
  assert.ok(!needsRefresh(tk, now))
  assert.ok(needsRefresh(tk, now + 3_600_000 - 30_000))
  // refresh keeps the old refresh token and scopes when left out
  const r = parseTokenResponse({ access_token: 'b', expires_in: 3600 }, now, tk)
  assert.equal(r.refreshToken, 'r')
  assert.deepEqual(r.scopes, ['x', 'y'])
  assert.throws(() => parseTokenResponse({ access_token: 'a' }, now))
  assert.throws(() =>
    parseTokenResponse({ access_token: 'a', refresh_token: 'r', token_type: 'mac' }, now)
  )
  // earliest_refresh_at in the future holds off a refresh while the token is still valid
  const held = { ...tk, earliestRefreshAt: now + 3_600_000 }
  assert.ok(!needsRefresh(held, now + 3_600_000 - 30_000))
  assert.ok(needsRefresh(held, now + 3_600_001))
})

t('reauth codes and error body shapes', () => {
  assert.ok(isReauthCode('invalid_grant'))
  assert.ok(isReauthCode('refresh_token_reused'))
  assert.ok(!isReauthCode('invalid_client'))
  assert.ok(!isReauthCode(undefined))
  assert.deepEqual(errorCodeOf({ error: 'invalid_grant', error_description: 'd' }), {
    code: 'invalid_grant',
    message: 'd'
  })
  assert.deepEqual(errorCodeOf({ error: { code: 'c', message: 'm', param: 'p' } }), {
    code: 'c',
    message: 'm',
    param: 'p'
  })
  assert.deepEqual(errorCodeOf({ detail: 'nope' }), { message: 'nope' })
})

t('API errors map to app error codes', () => {
  assert.equal(mapApiError(429, 'subscription_sharing_usage_limit_exceeded').code, 'plan_limit')
  assert.equal(
    mapApiError(undefined, 'subscription_sharing_usage_limit_exceeded').code,
    'plan_limit'
  )
  const u = mapApiError(503, 'subscription_sharing_usage_unavailable')
  assert.equal(u.code, 'model')
  assert.ok(u.transient)
  assert.equal(mapApiError(403, 'subscription_sharing_user_not_eligible').code, 'signin')
  assert.equal(mapApiError(401, undefined).code, 'signin')
  assert.equal(
    mapApiError(
      400,
      'subscription_sharing_unsupported_capability',
      'x',
      'temperature'
    ).detail.includes('param=temperature'),
    true
  )
  assert.ok(mapApiError(502, undefined).transient)
})

// ---------- ID token ----------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const jwks = { keys: [jwk] }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims, header = { alg: 'RS256', kid: 'k1' }) {
  const head = `${b64(header)}.${b64(claims)}`
  const sig = createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')
  return `${head}.${sig}`
}
const nowMs = 1_700_000_000_000
const nowS = nowMs / 1000
const good = {
  iss: 'https://auth.openai.com',
  aud: 'oaiapp_1',
  sub: 'user-1',
  email: 'a@b.c',
  iat: nowS - 10,
  exp: nowS + 3600,
  nonce: 'N'
}
const opts = { clientId: 'oaiapp_1', nonce: 'N', now: nowMs }

t('ID token: valid one verifies and returns identity', () => {
  assert.deepEqual(verifyIdToken(idToken(good), jwks, opts), {
    sub: 'user-1',
    email: 'a@b.c',
    name: undefined
  })
})

t('ID token: rejects bad signature, issuer, audience, nonce, expiry, alg, unknown key', () => {
  const tok = idToken(good)
  const tampered = tok.split('.')
  tampered[1] = b64({ ...good, sub: 'other' })
  assert.throws(() => verifyIdToken(tampered.join('.'), jwks, opts), /signature/)
  assert.throws(() => verifyIdToken(idToken({ ...good, iss: 'https://x' }), jwks, opts), /issuer/)
  assert.throws(() => verifyIdToken(idToken({ ...good, aud: 'other' }), jwks, opts), /audience/)
  assert.throws(() => verifyIdToken(idToken({ ...good, nonce: 'Z' }), jwks, opts), /nonce/)
  assert.throws(() => verifyIdToken(idToken({ ...good, exp: nowS - 60 }), jwks, opts), /expired/)
  assert.throws(
    () => verifyIdToken(idToken(good, { alg: 'HS256', kid: 'k1' }), jwks, opts),
    /algorithm/
  )
  assert.throws(
    () =>
      verifyIdToken(
        idToken(good, { alg: 'RS256', kid: 'k9' }),
        { keys: [jwk, { ...jwk, kid: 'k2' }] },
        opts
      ),
    /No signing key/
  )
  // nonce is not checked on refresh
  assert.ok(
    verifyIdToken(idToken({ ...good, nonce: undefined }), jwks, { ...opts, nonce: undefined })
  )
})

// ---------- role defaults ----------

const m = (id, name = id) => ({
  id,
  name,
  contextLength: null,
  promptPrice: null,
  completionPrice: null
})

t('role defaults: Sol builds, Luna names and serves host.ai, whatever the order', () => {
  assert.deepEqual(
    chatgptRoleDefaults([
      m('chatgpt:gpt-6-astra', 'GPT-6 Astra'),
      m('chatgpt:gpt-6.1-sol', 'GPT-6.1 Sol'),
      m('chatgpt:gpt-6.1-terra', 'GPT-6.1 Terra'),
      m('chatgpt:gpt-6-luna', 'GPT-6 Luna')
    ]),
    {
      builderModel: 'chatgpt:gpt-6.1-sol',
      utilityModel: 'chatgpt:gpt-6-luna',
      namingModel: 'chatgpt:gpt-6-luna'
    }
  )
  // no Sol: Terra builds
  assert.equal(
    chatgptRoleDefaults([m('chatgpt:gpt-6-astra'), m('chatgpt:gpt-6.1-terra')]).builderModel,
    'chatgpt:gpt-6.1-terra'
  )
  // "sol" must be a word: "console" doesn't count
  assert.equal(
    chatgptRoleDefaults([m('chatgpt:console-x', 'Console'), m('chatgpt:y', 'Y')]).builderModel,
    'chatgpt:console-x'
  )
})

t('role defaults: unknown names fall back to list order', () => {
  assert.deepEqual(
    chatgptRoleDefaults([
      m('openai/gpt-x'),
      m('chatgpt:big', 'GPT Big'),
      m('chatgpt:fast', 'GPT Mini')
    ]),
    { builderModel: 'chatgpt:big', utilityModel: 'chatgpt:fast', namingModel: 'chatgpt:fast' }
  )
  assert.deepEqual(chatgptRoleDefaults([m('chatgpt:only', 'Only')]), {
    builderModel: 'chatgpt:only',
    utilityModel: 'chatgpt:only',
    namingModel: 'chatgpt:only'
  })
  assert.equal(chatgptRoleDefaults([m('openai/gpt-x')]), null)
  // "mini" must be a word, not part of one
  assert.equal(
    chatgptRoleDefaults([m('chatgpt:a', 'Gemini Pro'), m('chatgpt:b', 'Terminus')]).utilityModel,
    'chatgpt:a'
  )
})

console.log(`\n${n} passed`)
