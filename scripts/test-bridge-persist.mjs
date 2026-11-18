/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Tests what keeps going after an app's page is unloaded: host.ai({ saveAs }) and host.notify.
//   node scripts/test-bridge-persist.mjs
import assert from 'node:assert/strict'
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
const nodeReq = createRequire(import.meta.url)
const cache = {}
function load(rel) {
  if (cache[rel]) return cache[rel]
  const out = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = { exports: {} }
  cache[rel] = mod.exports
  const req = (spec) =>
    spec.startsWith('.') ? load(path.join(path.dirname(rel), spec + '.ts')) : nodeReq(spec)
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
  cache[rel] = mod.exports
  return mod.exports
}
const { BridgeService } = load('src/main/services/bridge.ts')
const { NotifierService } = load('src/main/services/notifier.ts')

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// ---------- notifier ----------
{
  const shown = []
  const clicked = []
  const apps = { a: 'Timer', b: 'Other', c: 'Third' }
  const n = new NotifierService({
    appName: async (id) => apps[id] ?? null,
    show: (title, body, onClick) => shown.push({ title, body, onClick }),
    onClick: (id) => clicked.push(id)
  })

  // Shown now, titled with the app's name.
  const id = n.schedule('a', { message: '  Hello  ' })
  assert.match(id, /^n\d+$/)
  await tick(5)
  assert.deepEqual(
    shown.map((s) => [s.title, s.body]),
    [['Timer', 'Hello']]
  )
  shown[0].onClick()
  assert.deepEqual(clicked, ['a'])
  assert.deepEqual(n.list('a'), [])

  // Scheduled, replaced by id, cancelled.
  shown.length = 0
  n.schedule('a', { id: 't', at: Date.now() + 30, message: 'first' })
  n.schedule('a', { id: 't', at: Date.now() + 30, message: 'second' })
  assert.deepEqual(n.list('a'), ['t'])
  await tick(60)
  assert.deepEqual(
    shown.map((s) => s.body),
    ['second']
  )
  n.schedule('a', { id: 'c', at: Date.now() + 20, message: 'never' })
  n.cancel('a', 'c')
  await tick(40)
  assert.equal(shown.length, 1)
  // Cancelling an unknown id or another app's id does nothing.
  n.schedule('b', { id: 'x', at: Date.now() + 20, message: 'b only' })
  n.cancel('a', 'x')
  await tick(40)
  assert.deepEqual(
    shown.map((s) => s.title),
    ['Timer', 'Other']
  )

  // A deleted app shows nothing.
  shown.length = 0
  n.schedule('gone', { message: 'hi' })
  await tick(5)
  assert.equal(shown.length, 0)

  // Bad input.
  assert.throws(() => n.schedule('a', {}), /message/)
  assert.throws(() => n.schedule('a', { message: ' ' }), /message/)
  assert.throws(() => n.schedule('a', { message: 'x', at: 'soon' }), /at must/)
  assert.throws(() => n.schedule('a', { message: 'x', at: Date.now() + 8 * 864e5 }), /7 days/)
  assert.throws(() => n.schedule('a', { message: 'x', id: 5 }), /id must/)
  assert.throws(() => n.cancel('a', 5), /id must/)

  // Long messages are cut.
  n.schedule('a', { message: 'y'.repeat(1000) })
  await tick(5)
  assert.equal(shown.at(-1).body.length, 300)

  // Pending cap per app.
  for (let i = 0; i < 20; i++)
    n.schedule('b', { id: `p${i}`, at: Date.now() + 60_000, message: 'x' })
  assert.throws(
    () => n.schedule('b', { id: 'p20', at: Date.now() + 60_000, message: 'x' }),
    /at most 20/
  )
  n.schedule('b', { id: 'p3', at: Date.now() + 60_000, message: 'replace is fine' })
  for (const pid of n.list('b')) n.cancel('b', pid)
  assert.deepEqual(n.list('b'), [])

  // At most 6 shown per app per minute.
  shown.length = 0
  for (let i = 0; i < 9; i++) n.schedule('c', { message: `m${i}` })
  await tick(10)
  assert.equal(shown.length, 6)
}

// ---------- alarm, watched apps, fired events ----------
{
  const fired = []
  const shown = []
  let watched = null
  const n = new NotifierService({
    appName: async () => 'App',
    show: (title, body) => shown.push(body),
    onClick: () => undefined,
    isWatched: (id) => id === watched,
    onFired: (id, alarm) => fired.push([id, alarm])
  })
  n.schedule('a', { message: 'ring', alarm: true })
  n.schedule('a', { message: 'chime' })
  n.schedule('a', { message: 'odd', alarm: 'yes' })
  await tick(5)
  assert.deepEqual(fired, [
    ['a', true],
    ['a', false],
    ['a', false]
  ])
  // The app on screen handles it itself: nothing shown, nothing fired.
  watched = 'a'
  fired.length = shown.length = 0
  n.schedule('a', { message: 'x', alarm: true })
  await tick(5)
  assert.deepEqual([fired.length, shown.length], [0, 0])
  // A system without notifications still gets the window's dot and sound.
  const failing = new NotifierService({
    appName: async () => 'App',
    show: () => {
      throw new Error('no dbus')
    },
    onClick: () => undefined,
    onFired: (id) => fired.push([id])
  })
  failing.schedule('b', { message: 'x' })
  await tick(5)
  assert.deepEqual(fired, [['b']])
}

// ---------- host.ai({ saveAs }) ----------
{
  const store = { app1: {} }
  const library = {
    get: async (id) => (store[id] ? { id, name: id } : null),
    readStorage: async (id) => ({ ...store[id] }),
    writeStorage: async (id, data) => {
      if (!store[id]) throw new Error('gone')
      store[id] = { ...data }
    }
  }
  let release
  let fail = false
  const aiHandler = async () => {
    await new Promise((r) => (release = r))
    if (fail) throw new Error('model said no')
    return 'the answer'
  }
  const noop = () => undefined
  const notifier = new NotifierService({ appName: async () => 'x', show: noop, onClick: noop })
  const bridge = new BridgeService(library, async () => false, aiHandler, notifier)

  // Without saveAs nothing touches storage.
  const plain = bridge.call('app1', 'ai', [{ prompt: 'hi' }])
  await tick(5)
  release()
  assert.equal(await plain, 'the answer')
  assert.deepEqual(store.app1, {})

  // With saveAs: 'running' right away, 'done' with the text when it finishes. The caller still
  // gets the text, and nothing depends on the caller still being there.
  const p = bridge.call('app1', 'ai', [{ prompt: 'hi', saveAs: 'sum' }])
  await tick(5)
  assert.equal(store.app1.sum.status, 'running')
  assert.equal(typeof store.app1.sum.startedAt, 'number')
  const settled = bridge.settle()
  let settleDone = false
  void settled.then(() => (settleDone = true))
  await tick(5)
  assert.equal(settleDone, false, 'settle waits for the result to be written')
  release()
  assert.equal(await p, 'the answer')
  await settled
  assert.equal(store.app1.sum.status, 'done')
  assert.equal(store.app1.sum.text, 'the answer')
  assert.ok(store.app1.sum.finishedAt >= store.app1.sum.startedAt)

  // Errors are recorded too, and still reach the caller.
  fail = true
  const e = bridge.call('app1', 'ai', [{ prompt: 'hi', saveAs: 'sum' }])
  await tick(5)
  release()
  await assert.rejects(e, /model said no/)
  await bridge.settle()
  assert.deepEqual([store.app1.sum.status, store.app1.sum.error], ['error', 'model said no'])

  // App deleted mid-call: the answer still reaches a caller, the failed write is swallowed.
  fail = false
  const g = bridge.call('app1', 'ai', [{ prompt: 'hi', saveAs: 'sum' }])
  await tick(5)
  delete store.app1
  release()
  assert.equal(await g, 'the answer')

  // notify: shown when a saveAs call finishes, also when it fails; refused without saveAs.
  const notes = []
  const n2 = new NotifierService({
    appName: async () => 'App',
    show: (t, body) => notes.push(body),
    onClick: () => undefined
  })
  store.app1 = {}
  const b2 = new BridgeService(library, async () => false, aiHandler, n2)
  const q = b2.call('app1', 'ai', [{ prompt: 'hi', saveAs: 's', notify: 'Summary ready' }])
  await tick(5)
  release()
  await q
  await tick(5)
  fail = true
  const q2 = b2.call('app1', 'ai', [{ prompt: 'hi', saveAs: 's', notify: 'Summary ready' }])
  await tick(5)
  release()
  await assert.rejects(q2)
  await tick(5)
  fail = false
  assert.deepEqual(notes, ['Summary ready', 'Summary ready (failed)'])
  await assert.rejects(
    b2.call('app1', 'ai', [{ prompt: 'hi', notify: 'x' }]),
    /together with saveAs/
  )

  // Bad keys are refused before the model is called.
  store.app1 = {}
  await assert.rejects(bridge.call('app1', 'ai', [{ prompt: 'hi', saveAs: '' }]), /key/)
  await assert.rejects(bridge.call('app1', 'ai', [{ prompt: 'hi', saveAs: 7 }]), /key/)

  // notify goes through the bridge, scoped to the calling app.
  const nid = await bridge.call('app1', 'notify', [
    { id: 'z', at: Date.now() + 60_000, message: 'hi' }
  ])
  assert.equal(nid, 'z')
  assert.deepEqual(await bridge.call('app1', 'notify.list', []), ['z'])
  await bridge.call('app1', 'notify.cancel', ['z'])
  assert.deepEqual(await bridge.call('app1', 'notify.list', []), [])
  await assert.rejects(bridge.call('nope', 'notify', [{ message: 'hi' }]), /App not found/)
}

console.log('bridge persist tests passed')
