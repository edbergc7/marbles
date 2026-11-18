/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Tests the host.fetch local-network guard and redirect handling without Electron.
//   node scripts/test-netguard.mjs
import ts from 'typescript'
import fs from 'node:fs'
import http from 'node:http'
import zlib from 'node:zlib'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const req = createRequire(import.meta.url)
const cache = {}
function load(rel) {
  const file = path.join(root, rel)
  if (cache[file]) return cache[file]
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const mod = { exports: {} }
  cache[file] = mod.exports
  const r = (spec) =>
    spec.startsWith('./') ? load(path.join(path.dirname(rel), spec + '.ts')) : req(spec)
  new Function('require', 'module', 'exports', out)(r, mod, mod.exports)
  return (cache[file] = mod.exports)
}
const { isPrivateAddress, isLocalHostname, cleanRequestHeaders } = load(
  'src/main/services/netGuard.ts'
)
const { safeFetch, redirectHeaders } = load('src/main/services/safeFetch.ts')

// ---- address classification ----
const priv = [
  '127.0.0.1',
  '127.9.9.9',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  'fe80::1',
  'fd00::1',
  'fc00::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:192.168.0.1',
  '64:ff9b::a00:1',
  '[::1]',
  'fe80::1%eth0',
  'not-an-ip'
]
const pub = [
  '8.8.8.8',
  '1.1.1.1',
  '172.32.0.1',
  '100.128.0.1',
  '172.15.255.255',
  '93.184.216.34',
  '2606:4700::1111',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8'
]
for (const ip of priv) assert.equal(isPrivateAddress(ip), true, `should be private: ${ip}`)
for (const ip of pub) assert.equal(isPrivateAddress(ip), false, `should be public: ${ip}`)

// ---- app-frame image guard: hostnames that are local without a DNS lookup ----
for (const h of [
  'localhost',
  'LOCALHOST',
  'localhost.',
  'app.localhost',
  '127.0.0.1',
  '192.168.1.1',
  '10.0.0.5',
  '[::1]',
  '[fe80::1]',
  '[::ffff:192.168.0.1]',
  '0.0.0.0',
  '169.254.169.254'
]) {
  assert.equal(isLocalHostname(h), true, `should be local: ${h}`)
}
for (const h of [
  'example.com',
  '8.8.8.8',
  '[2606:4700::1111]',
  'localhost.example.com',
  'mylocalhost'
]) {
  assert.equal(isLocalHostname(h), false, `should not be local: ${h}`)
}

// ---- header cleaning ----
assert.deepEqual(
  cleanRequestHeaders({
    Host: 'x',
    Cookie: 'a',
    'Proxy-Authorization': 'b',
    'Accept-Encoding': 'zstd',
    'X-Api-Key': 'k',
    Accept: 'json'
  }),
  { 'X-Api-Key': 'k', Accept: 'json' }
)

// ---- headers across redirects ----
{
  const h = {
    Authorization: 'Bearer x',
    'X-Api-Key': 'k',
    Accept: 'json',
    'Content-Type': 'application/json'
  }
  const a = new URL('https://api.example.com/v1')
  const same = new URL('https://api.example.com/v2')
  const other = new URL('https://evil.example.net/')
  const downgrade = new URL('http://api.example.com/v1')
  assert.deepEqual(redirectHeaders(h, a, same, false), h, 'same origin keeps everything')
  assert.deepEqual(
    redirectHeaders(h, a, same, true),
    { Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'json' },
    'body headers dropped with the body'
  )
  assert.deepEqual(
    redirectHeaders(h, a, other, true),
    { Accept: 'json' },
    'cross-origin drops credentials'
  )
  assert.deepEqual(
    redirectHeaders(h, a, downgrade, true),
    { Accept: 'json' },
    'https to http counts as cross-origin'
  )
  assert.deepEqual(
    redirectHeaders(h, a, other, false),
    { Accept: 'json', 'Content-Type': 'application/json' },
    '307 cross-origin keeps body type only'
  )
}

// ---- safeFetch against local servers ----
// "public" = 127.0.0.1, "private" = 127.0.0.2 (test predicate), so redirects can be exercised.
const isBlocked = (ip) => ip === '127.0.0.2' || ip.endsWith(':127.0.0.2')
const target = http.createServer((q, s) => s.end('secret')).listen(0, '127.0.0.2')
await new Promise((r) => target.once('listening', r))
const tport = target.address().port
const other = http.createServer((q, s) => s.end(JSON.stringify(q.headers))).listen(0, '127.0.0.1')
await new Promise((r) => other.once('listening', r))
const front = http
  .createServer((q, s) => {
    if (q.url === '/to-private') s.writeHead(302, { location: `http://127.0.0.2:${tport}/` }).end()
    else if (q.url === '/hop2') s.writeHead(301, { location: '/hop1' }).end()
    else if (q.url === '/hop1') s.writeHead(302, { location: '/ok' }).end()
    else if (q.url === '/loop') s.writeHead(302, { location: '/loop' }).end()
    else if (q.url === '/file') s.writeHead(302, { location: 'file:///etc/passwd' }).end()
    else if (q.url === '/post303') s.writeHead(303, { location: '/echo' }).end()
    else if (q.url === '/echo') s.end(q.method)
    else if (q.url === '/to-other')
      s.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/` }).end()
    else if (q.url === '/to-same') s.writeHead(302, { location: '/headers' }).end()
    else if (q.url === '/headers') s.end(JSON.stringify(q.headers))
    else if (q.url === '/gz')
      s.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('zipped'))
    else if (q.url === '/big') s.end(Buffer.alloc(2048))
    else s.end('ok')
  })
  .listen(0, '127.0.0.1')
await new Promise((r) => front.once('listening', r))
const base = `http://127.0.0.1:${front.address().port}`
const opts = {
  method: 'GET',
  headers: {},
  guard: true,
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  maxRedirects: 5,
  isBlocked
}
const get = (p, o = {}) => safeFetch(new URL(p, base), { ...opts, ...o })
const text = async (p, o) => (await get(p, o)).body.toString()

assert.equal(await text('/'), 'ok')
assert.equal(await text('/hop2'), 'ok', 'relative redirects are followed')
await assert.rejects(get('/to-private'), /Blocked: /, 'redirect into a private address is refused')
await assert.rejects(
  get(`http://127.0.0.2:${tport}/`),
  /Blocked: /,
  'literal private IP is refused'
)
await assert.rejects(
  get(`http://localhost:${tport}/`),
  /Blocked: localhost/,
  'localhost is refused'
)
assert.equal(await text('/to-private', { guard: false }), 'secret', 'allowed when the guard is off')
await assert.rejects(get('/loop'), /Too many redirects/)
await assert.rejects(get('/file'), /non-http URL/)
assert.equal(
  await text('/post303', { method: 'POST', body: 'x' }),
  'GET',
  '303 turns POST into GET'
)
const gz = await get('/gz')
assert.equal(gz.body.toString(), 'zipped', 'gzip is decoded')
assert.equal(gz.headers['content-encoding'], undefined, 'content-encoding dropped after decoding')
await assert.rejects(get('/big', { maxBytes: 1000 }), /Response too large/)
// a name that resolves to a blocked address (default predicate: localhost.)
await assert.rejects(
  safeFetch(new URL(`http://localtest.me:${front.address().port}/`), {
    ...opts,
    isBlocked: undefined
  }),
  (e) => /Blocked: |resolve|ENOTFOUND|EAI_AGAIN/.test(e.message)
)

{
  const keyed = { headers: { 'X-Api-Key': 'k', Authorization: 'Bearer t', Accept: 'json' } }
  const cross = JSON.parse(await text('/to-other', keyed))
  assert.equal(cross['x-api-key'], undefined, 'API key not sent to another origin')
  assert.equal(cross.authorization, undefined, 'Authorization not sent to another origin')
  assert.equal(cross.accept, 'json')
  const same = JSON.parse(await text('/to-same', keyed))
  assert.equal(same['x-api-key'], 'k', 'API key kept on same-origin redirect')
  assert.equal(same.authorization, 'Bearer t')
}
other.close()
front.close()
target.close()
console.log('test-netguard: all passed')
