/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-empty-function */
// Tests the main-process export + library-location logic without launching Electron.
// TS sources are transpiled with the project's TypeScript and loaded with stubbed
// 'electron', '?raw' and '?asset' imports.
//   node scripts/test-export.mjs
import ts from 'typescript'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const plain = (x) => JSON.parse(JSON.stringify(x))
const root = path.resolve(import.meta.dirname, '..')
const req = createRequire(import.meta.url)

const electronStub = {
  app: { getPath: () => os.tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {}
}

function load(rel) {
  const file = path.join(root, rel)
  const src = fs.readFileSync(file, 'utf8')
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mod = { exports: {} }
  const customRequire = (spec) => {
    if (spec === 'electron') return electronStub
    if (spec.endsWith('?raw'))
      return {
        default: fs.readFileSync(path.resolve(path.dirname(file), spec.slice(0, -4)), 'utf8')
      }
    if (spec.endsWith('?asset'))
      return { default: path.resolve(path.dirname(file), spec.slice(0, -6)) }
    if (spec === './library') return { writeAtomic: async (f, d) => fs.promises.writeFile(f, d) }
    if (spec.startsWith('./') || spec.startsWith('../'))
      return load(path.join(path.dirname(rel), spec + '.ts'))
    return req(spec)
  }
  new Function('require', 'module', 'exports', out)(customRequire, mod, mod.exports)
  return mod.exports
}

const { buildStandaloneDocument, embedAssets, ExporterService } = load(
  'src/main/services/exporter.ts'
)
const { LibraryLocationService } = load('src/main/services/libraryLocation.ts')

const shim = fs.readFileSync(path.join(root, 'src/main/appframe/export-shim.js'), 'utf8')
const base = {
  css: 'body{color:red}</style>x',
  accent: '#abc123',
  title: 'My <App>',
  shim,
  appId: 'demo-1'
}

// ---- buildStandaloneDocument ----
{
  const bare = buildStandaloneDocument('<h1>Hi</h1>', base)
  assert.match(bare, /^<!doctype html><html><head>/)
  assert.match(bare, /<title>My &lt;App&gt;<\/title>/)
  assert.match(bare, /--accent:#abc123/)
  assert.ok(!bare.includes('data-theme'))
  assert.ok(!bare.includes('</style>x'), 'css </style escaped')
  assert.ok(!bare.includes('__APP_ID__'))
  assert.ok(bare.includes("'marbles:demo-1:'"))

  const full = buildStandaloneDocument(
    '<!DOCTYPE html><html lang="en" data-theme="dark"><head><title>Mine</title><script src="https://cdn.jsdelivr.net/npm/x@1/x.js"></script></head><body></body></html>',
    base
  )
  assert.ok(!full.includes('data-theme'))
  assert.equal((full.match(/<title/g) || []).length, 1, 'keeps existing title only')
  assert.ok(full.includes('https://cdn.jsdelivr.net/npm/x@1/x.js'), 'cdn url untouched')
  assert.ok(!full.includes('cdn://'))
  assert.match(full, /<html lang="en">/)
  assert.equal((full.match(/<!doctype/gi) || []).length, 1)

  const bodyOnly = buildStandaloneDocument("<body data-theme='x'><p>a</p></body>", base)
  assert.match(bodyOnly, /<head>.*<\/head><body/s)

  // The shim always comes first: a "<head>" in a comment can't swallow it, and no app script
  // runs before it.
  const hidden = buildStandaloneDocument(
    '<!-- <head> --><script>early()</script><html><head></head><body></body></html>',
    base
  )
  assert.match(hidden, /^<!doctype html><html><head><meta charset="utf-8">/)
  assert.ok(hidden.indexOf('__marblesShim') < hidden.indexOf('<!-- <head> -->'))
  assert.ok(hidden.indexOf('__marblesShim') < hidden.indexOf('early()'))

  const withFont = buildStandaloneDocument('<p>a</p>', {
    ...base,
    fontDataUrl: 'data:font/woff2;base64,AAAA'
  })
  assert.match(withFont, /@font-face\{font-family:"Inter Variable".*base64,AAAA/s)
}

// ---- export shim in a fake browser ----
async function runShim(localStorageImpl, assets = []) {
  const listeners = {}
  const win = { localStorage: localStorageImpl }
  const doc = {
    readyState: 'complete',
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: (t, f) => (listeners[t] = f)
  }
  const ctx = vm.createContext({
    window: win,
    document: doc,
    HTMLInputElement: function () {},
    MutationObserver: class {
      observe() {}
    },
    Object,
    Promise,
    Error,
    TypeError,
    JSON,
    Map,
    Array,
    get localStorage() {
      if (localStorageImpl === 'throw') throw new Error('denied')
      return localStorageImpl
    }
  })
  ctx.HTMLInputElement.prototype = {}
  vm.runInContext(
    shim.replaceAll('__APP_ID__', 'a1').replace('__ASSETS__', JSON.stringify(assets)),
    ctx
  )
  return win.host
}
{
  const store = new Map()
  const ls = {
    get length() {
      return store.size
    },
    key: (i) => [...store.keys()][i],
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  }
  const host = await runShim(ls)
  await host.storage.set('k', { a: 1 })
  assert.deepEqual(plain(await host.storage.get('k')), { a: 1 })
  assert.ok(store.has('marbles:a1:k'))
  store.set('other', 'x')
  assert.deepEqual(plain(await host.storage.keys()), ['k'])
  await host.storage.remove('k')
  assert.equal(await host.storage.get('k'), undefined)
  await assert.rejects(host.storage.set('x', undefined), /JSON-serializable/)
  await assert.rejects(host.fetch('http://x'), {
    message: 'host.fetch is not available outside the Marbles app'
  })
  await assert.rejects(host.ai('hi'), {
    message: 'host.ai is not available outside the Marbles app'
  })

  const bad = await runShim('throw')
  await bad.storage.set('m', [1])
  assert.deepEqual(plain(await bad.storage.get('m')), [1])
  assert.deepEqual(plain(await bad.storage.keys()), ['m'])
}

// ---- embedding app files ----
{
  const png = { name: 'logo.png', mime: 'image/png', data: Buffer.from([1, 2, 3]) }
  const csv = {
    name: 'data.csv',
    mime: 'text/csv',
    data: Buffer.from('a</script>'),
    text: 'a</script>'
  }
  const { html, embedded } = embedAssets(
    `<img src="assets/logo.png"><div style="background:url(./assets/logo.png)"></div>` +
      `<img src='assets/logo.png?x'><p>assets/logo.png.bak</p><script>host.assets.text('data.csv')</script>`,
    [png, csv, { name: 'other.png', mime: 'image/png', data: Buffer.from([9]) }]
  )
  assert.equal((html.match(/data:image\/png;base64,AQID/g) ?? []).length, 3)
  // Not a reference: a longer name that only starts with it.
  assert.ok(html.includes('assets/logo.png.bak'))
  // logo.png is still named (in the .bak text), so it is also in the list; data.csv is.
  assert.deepEqual(
    embedded.map((e) => e.name),
    ['logo.png', 'data.csv']
  )
  const doc = buildStandaloneDocument(`<p>x</p><script>host.assets.text('data.csv')</script>`, {
    ...base,
    assets: [csv]
  })
  // File text can't close the shim's script tag.
  assert.ok(!doc.includes('a</script>"'))
  assert.ok(doc.includes('a\\u003c/script>'))
  // With no files the shim still parses.
  assert.ok(buildStandaloneDocument('<p>x</p>', base).includes('var ASSETS = []'))
  const host = await runShim(null, [
    { name: 'data.csv', mime: 'text/csv', size: 3, base64: 'YSxi', text: 'a,b' },
    { name: 'pic.png', mime: 'image/png', size: 3, width: 2, height: 1, base64: 'AQID' }
  ])
  assert.equal(await host.assets.text('data.csv'), 'a,b')
  assert.equal(await host.assets.text('assets/data.csv'), 'a,b')
  assert.equal(await host.assets.base64('pic.png'), 'AQID')
  await assert.rejects(host.assets.text('pic.png'), /isn't text/)
  await assert.rejects(host.assets.text('nope.csv'), /no file called nope\.csv/)
  assert.deepEqual(plain(await host.assets.list()), [
    { name: 'data.csv', mime: 'text/csv', size: 3 },
    { name: 'pic.png', mime: 'image/png', size: 3, width: 2, height: 1 }
  ])
}

// ---- ExporterService.exportToFile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marbles-export-test-'))
{
  const meta = { id: 'demo-1', name: 'Demo', currentVersion: 2, versions: [{ n: 1 }, { n: 2 }] }
  const library = {
    get: async (id) => (id === 'demo-1' ? meta : null),
    readVersion: async (_id, n) =>
      n === 2
        ? '<h1>v2</h1><img src="assets/dot.png"><script>host.assets.text("data.csv")</script>'
        : `<h1>v${n}</h1>`,
    listAssets: async () => [
      { name: 'dot.png', size: 3 },
      { name: 'data.csv', size: 4 },
      { name: 'unused.png', size: 3 }
    ],
    readAsset: async (_id, name) =>
      name === 'data.csv' ? Buffer.from('a,b\n') : Buffer.from([0x89, 0x50, 0x4e])
  }
  const settings = { get: async () => ({ accent: '#112233' }) }
  const ex = new ExporterService({ library, settings })
  const out = path.join(tmp, 'out.html')
  const r = await ex.exportToFile('demo-1', undefined, out)
  const html = fs.readFileSync(out, 'utf8')
  assert.equal(r.bytes, Buffer.byteLength(html))
  assert.ok(html.includes('<h1>v2</h1>') && html.includes('--accent:#112233'))
  // Its image is inlined, its data file embedded for host.assets, the unused file left out.
  assert.ok(html.includes('<img src="data:image/png;base64,iVBO">'))
  assert.ok(html.includes('"name":"data.csv"') && html.includes('"text":"a,b\\n"'))
  assert.ok(!html.includes('unused.png'))
  assert.ok(html.includes('data:font/woff2;base64,'))
  assert.ok(fs.readFileSync(out, 'utf8').includes('Demo'))
  await ex.exportToFile('demo-1', 1, out)
  assert.ok(fs.readFileSync(out, 'utf8').includes('<h1>v1</h1>'))
  await assert.rejects(ex.exportToFile('demo-1', 9, out), /doesn't exist/)
  await assert.rejects(ex.exportToFile('nope', undefined, out), /App not found/)
}

// ---- LibraryLocationService ----
{
  const cur = path.join(tmp, 'cur')
  const mkApp = (lib, id) => {
    fs.mkdirSync(path.join(lib, 'apps', id), { recursive: true })
    fs.writeFileSync(path.join(lib, 'apps', id, 'meta.json'), '{}')
    fs.writeFileSync(path.join(lib, 'apps', id, 'v1.html'), 'x')
  }
  mkApp(cur, 'a')
  mkApp(cur, 'b')
  fs.mkdirSync(path.join(cur, 'trash', 't'), { recursive: true })
  const def = path.join(tmp, 'default')
  let state = { libraryPath: cur }
  const settings = { get: async () => ({ ...state }), defaults: () => ({ libraryPath: def }) }
  let busy = false
  let applied = 0
  const svc = new LibraryLocationService({
    settings,
    applySettings: async (p) => (applied++, (state = { ...state, ...p })),
    isBusy: () => busy,
    settle: async () => {}
  })

  const dest = path.join(tmp, 'dest')
  busy = true
  await assert.rejects(svc.moveTo(dest), { message: 'Wait for builds and changes to finish first' })
  await assert.rejects(svc.useExisting(dest), /Wait for builds/)
  await assert.rejects(svc.reset(), /Wait for builds/)
  busy = false

  await assert.rejects(svc.moveTo(path.join(cur, 'inner')), /inside the current library/)
  await assert.rejects(svc.moveTo(path.dirname(cur)), /inside the current library|contain it/)
  // Paths only fold case on Windows and macOS.
  const same = process.platform === 'linux' ? cur : cur.toUpperCase()
  await assert.rejects(svc.moveTo(same), /already your library/)

  const full = path.join(tmp, 'full')
  fs.mkdirSync(full)
  fs.writeFileSync(path.join(full, 'x.txt'), 'x')
  await assert.rejects(svc.moveTo(full), /empty folder/)
  await assert.rejects(svc.useExisting(full), {
    message: "That folder isn't a Marbles library and isn't empty"
  })
  assert.equal(applied, 0)

  const s = await svc.moveTo(dest)
  assert.equal(s.libraryPath, path.resolve(dest))
  assert.ok(fs.existsSync(path.join(dest, 'apps', 'a', 'meta.json')))
  assert.ok(fs.existsSync(path.join(dest, 'trash', 't')))
  assert.ok(fs.existsSync(path.join(cur, 'apps', 'a', 'meta.json')), 'old folder intact')

  // useExisting: library with apps, then an empty folder (gets apps/)
  const empty = path.join(tmp, 'empty')
  fs.mkdirSync(empty)
  fs.writeFileSync(path.join(empty, '.hidden'), '')
  await svc.useExisting(empty)
  assert.ok(fs.existsSync(path.join(empty, 'apps')))
  await svc.useExisting(cur)
  assert.equal(state.libraryPath, path.resolve(cur))

  await svc.reset()
  assert.equal(state.libraryPath, def)
  assert.ok(fs.existsSync(path.join(def, 'apps')))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('test-export: all passed')
