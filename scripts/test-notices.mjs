/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Tests update checks and announcements (src/main/services/notices.ts) without Electron.
//   node scripts/test-notices.mjs
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
function load(rel) {
  const out = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', out)(() => ({}), mod, mod.exports)
  return mod.exports
}
const {
  parseVersion,
  compareVersions,
  parseAnnouncements,
  parseLatestRelease,
  updateNotice,
  NoticesService
} = load('src/main/services/notices.ts')

// ---- versions ----
const cmp = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)))
assert.equal(cmp('1.0.0', '1.0.1'), -1)
assert.equal(cmp('v1.2.0', '1.1.9'), 1)
assert.equal(cmp('1.10.0', '1.9.0'), 1)
assert.equal(cmp('1.0.0', '1.0.0'), 0)
assert.equal(cmp('1.0.0-beta.1', '1.0.0'), -1)
assert.equal(cmp('1.0.0-beta.2', '1.0.0-beta.10'), -1)
assert.equal(cmp('1.0.0-alpha', '1.0.0-beta'), -1)
assert.equal(cmp('1.0.0-1', '1.0.0-alpha'), -1)
assert.equal(parseVersion('1.0'), null)
assert.equal(parseVersion('latest'), null)
assert.equal(parseVersion(42), null)

// ---- latest release ----
const REPO = 'me/marbles'
assert.deepEqual(
  parseLatestRelease(
    { tag_name: 'v1.2.0', html_url: 'https://github.com/me/marbles/releases/tag/v1.2.0' },
    REPO
  ),
  { version: '1.2.0', url: 'https://github.com/me/marbles/releases/tag/v1.2.0' }
)
// a link outside the repo's releases is replaced, never followed
assert.equal(
  parseLatestRelease({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x' }, REPO).url,
  'https://github.com/me/marbles/releases/latest'
)
assert.equal(
  parseLatestRelease(
    { tag_name: 'v1.2.0', html_url: 'https://github.com/me/marbles-evil/releases/x' },
    REPO
  ).url,
  'https://github.com/me/marbles/releases/latest'
)
assert.equal(parseLatestRelease({ tag_name: 'v2.0.0', prerelease: true }, REPO), null)
assert.equal(parseLatestRelease({ tag_name: 'v2.0.0', draft: true }, REPO), null)
assert.equal(parseLatestRelease({ tag_name: 'nightly' }, REPO), null)
assert.equal(parseLatestRelease(null, REPO), null)

const latest = { version: '1.2.0', url: 'https://github.com/me/marbles/releases/tag/v1.2.0' }
assert.equal(updateNotice(latest, '1.2.0'), null)
assert.equal(updateNotice(latest, '1.3.0'), null)
const un = updateNotice(latest, '1.0.0')
assert.equal(un.id, 'update:1.2.0')
assert.equal(un.kind, 'update')
assert.equal(un.url, latest.url)

// ---- announcements ----
const ctx = { version: '1.1.0', platform: 'linux', now: Date.parse('2026-11-14T00:00:00Z') }
const ann = (list) => parseAnnouncements({ announcements: list }, ctx)
assert.deepEqual(ann([]), [])
assert.deepEqual(parseAnnouncements(null, ctx), [])
assert.deepEqual(parseAnnouncements([{ id: 'a', title: 'x' }], ctx), []) // must be wrapped

const [a] = ann([{ id: 'eol', level: 'warning', title: 'Goodbye', body: 'No more updates.' }])
assert.equal(a.id, 'news:eol')
assert.equal(a.level, 'warning')
assert.equal(a.dismissible, true)
assert.equal(a.linkLabel, undefined)

// version range, platform, expiry
assert.equal(ann([{ id: 'a', title: 't', maxVersion: '1.0.9' }]).length, 0)
assert.equal(ann([{ id: 'a', title: 't', maxVersion: '1.1.0' }]).length, 1)
assert.equal(ann([{ id: 'a', title: 't', minVersion: '1.2.0' }]).length, 0)
assert.equal(ann([{ id: 'a', title: 't', platforms: ['win32'] }]).length, 0)
assert.equal(ann([{ id: 'a', title: 't', platforms: ['linux', 'win32'] }]).length, 1)
assert.equal(ann([{ id: 'a', title: 't', expires: '2026-11-01' }]).length, 0)
assert.equal(ann([{ id: 'a', title: 't', expires: '2027-01-01' }]).length, 1)

// bad entries are skipped, good ones kept
const mixed = ann([
  null,
  'nope',
  { title: 'no id' },
  { id: 'has space', title: 't' },
  { id: 'notitle' },
  { id: 'ok', title: 'fine' },
  { id: 'ok', title: 'duplicate' }
])
assert.deepEqual(
  mixed.map((n) => n.id),
  ['news:ok']
)

// only https links, unknown level → info, long text capped, control chars dropped
const [l] = ann([
  { id: 'l', title: 'a\u0007b', level: 'shout', url: 'javascript:alert(1)', linkLabel: 'Go' }
])
assert.equal(l.title, 'ab')
assert.equal(l.level, 'info')
assert.equal(l.url, undefined)
assert.equal(l.linkLabel, undefined)
const [h] = ann([{ id: 'h', title: 't', url: 'https://example.com/x', body: 'y'.repeat(2000) }])
assert.equal(h.url, 'https://example.com/x')
assert.equal(h.linkLabel, 'Read more')
assert.equal(h.body.length, 600)
assert.equal(ann([{ id: 'c', title: 't', url: 'http://example.com' }])[0].url, undefined)
assert.equal(ann([{ id: 'd', title: 't', dismissible: false }])[0].dismissible, false)
assert.equal(ann(Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: 't' }))).length, 5)

// ---- service ----
function makeService(over = {}) {
  const store = { enabled: true, dismissed: [] }
  const opened = []
  const emitted = []
  const responses = {
    rel: { tag_name: 'v1.2.0', html_url: 'https://github.com/me/marbles/releases/tag/v1.2.0' },
    news: {
      announcements: [
        { id: 'tip', title: 'A tip' },
        {
          id: 'bug',
          level: 'critical',
          title: 'Bug in 1.0',
          dismissible: false,
          url: 'https://example.com/bug'
        }
      ]
    }
  }
  let calls = 0
  const svc = new NoticesService({
    version: '1.0.0',
    platform: 'linux',
    repo: REPO,
    releasesUrl: 'rel',
    announcementsUrl: 'news',
    fetchJson: async (url) => {
      calls++
      const r = responses[url]
      if (r instanceof Error) throw r
      return r
    },
    isEnabled: async () => store.enabled,
    getDismissed: async () => store.dismissed,
    setDismissed: async (ids) => {
      store.dismissed = ids
    },
    openUrl: (u) => opened.push(u),
    emit: (s) => emitted.push(s),
    now: () => 1000,
    ...over
  })
  return { svc, store, opened, emitted, responses, calls: () => calls }
}

{
  const { svc, store, opened, emitted, responses, calls } = makeService()
  let s = await svc.state()
  assert.equal(s.available, true)
  assert.deepEqual(s.notices, [])

  s = await svc.check()
  assert.equal(s.lastCheck, 1000)
  assert.equal(s.lastError, null)
  assert.equal(s.latestVersion, '1.2.0')
  assert.equal(s.updateAvailable, true)
  // critical announcement first, update last
  assert.deepEqual(
    s.notices.map((n) => n.id),
    ['news:bug', 'news:tip', 'update:1.2.0']
  )
  assert.ok(
    s.notices.every((n) => !('url' in n)),
    'URLs stay in main'
  )
  assert.ok(emitted.length >= 1)

  // open goes through the stored URL, unknown ids do nothing
  svc.open('update:1.2.0')
  svc.open('news:tip')
  svc.open('nope')
  assert.deepEqual(opened, ['https://github.com/me/marbles/releases/tag/v1.2.0'])

  // dismiss
  s = await svc.dismiss('update:1.2.0')
  assert.deepEqual(store.dismissed, ['update:1.2.0'])
  assert.equal(s.updateAvailable, true, 'still known after the banner is closed')
  assert.ok(!s.notices.some((n) => n.id === 'update:1.2.0'))
  s = await svc.dismiss('news:bug') // not dismissible
  assert.ok(s.notices.some((n) => n.id === 'news:bug'))
  assert.deepEqual(store.dismissed, ['update:1.2.0'])

  // stale dismissed ids are pruned on the next dismiss
  store.dismissed = ['update:0.9.0', 'news:gone', 'update:1.2.0']
  await svc.dismiss('news:tip')
  assert.deepEqual(store.dismissed, ['update:1.2.0', 'news:tip'])

  // offline: keeps what it had, reports the error
  responses.rel = new Error('HTTP 503')
  responses.news = new Error('offline')
  s = await svc.check()
  assert.match(s.lastError, /releases: HTTP 503/)
  assert.match(s.lastError, /announcements: offline/)
  assert.deepEqual(
    s.notices.map((n) => n.id),
    ['news:bug']
  )
  assert.equal(s.latestVersion, '1.2.0')

  // concurrent checks share one run
  responses.rel = { tag_name: 'v1.0.0' }
  responses.news = { announcements: [] }
  const before = calls()
  await Promise.all([svc.check(), svc.check(), svc.check()])
  assert.equal(calls() - before, 2)
  s = await svc.state()
  assert.equal(s.updateAvailable, false)
  assert.deepEqual(s.notices, [])

  // turned off: nothing shown, no requests
  responses.news = { announcements: [{ id: 'x', title: 'x' }] }
  await svc.check()
  store.enabled = false
  const c2 = calls()
  s = await svc.check()
  assert.equal(calls(), c2)
  assert.equal(s.enabled, false)
  assert.deepEqual(s.notices, [])
}

// no repo configured: unavailable, never fetches
{
  const { svc, calls } = makeService({ repo: null, releasesUrl: null, announcementsUrl: null })
  const s = await svc.check()
  assert.equal(s.available, false)
  assert.equal(s.enabled, false)
  assert.equal(calls(), 0)
}

// local notices: shown with checks off and no repo, never dismissible away, link opens
{
  let local = []
  const opened = []
  const { svc, calls } = makeService({
    repo: null,
    releasesUrl: null,
    announcementsUrl: null,
    local: async () => local,
    openUrl: (u) => opened.push(u)
  })
  assert.deepEqual((await svc.state()).notices, [])
  local = [
    {
      id: 'local:x',
      kind: 'announcement',
      level: 'warning',
      title: 'Local',
      body: '',
      dismissible: false,
      linkLabel: 'Go',
      url: 'https://example.com/local'
    }
  ]
  let s = await svc.refresh()
  assert.equal(s.available, false)
  assert.deepEqual(
    s.notices.map((n) => n.id),
    ['local:x']
  )
  assert.equal('url' in s.notices[0], false)
  s = await svc.dismiss('local:x')
  assert.equal(s.notices.length, 1)
  svc.open('local:x')
  assert.deepEqual(opened, ['https://example.com/local'])
  assert.equal(calls(), 0)

  // a failing source doesn't break the state
  local = null
  const { svc: bad } = makeService({ local: async () => Promise.reject(new Error('disk')) })
  assert.deepEqual((await bad.state()).notices, [])
}

console.log('test-notices: all passed')
