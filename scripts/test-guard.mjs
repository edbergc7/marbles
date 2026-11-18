/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Tests the main window's security guards (app page check, IPC sender, permissions, link prompts).
//   node scripts/test-guard.mjs
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const req = createRequire(import.meta.url)
function load(rel) {
  const out = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
  return mod.exports
}
const {
  appPageFor,
  appRelativePath,
  isAppPageUrl,
  isTrustedSender,
  isAllowedPermission,
  parseOpenableUrl,
  linkPromptText,
  createPromptGate,
  cleanSettingsPatch
} = load('src/main/services/guard.ts')

// ---- app page: packaged build, served from app://marbles ----
const linux = appPageFor(undefined)
assert.equal(linux.kind, 'app')
const linuxUrl = 'app://marbles/index.html'
assert.ok(isAppPageUrl(linuxUrl, linux))
assert.ok(isAppPageUrl(linuxUrl + '?x=1#/settings', linux), 'query and hash are ignored')
assert.ok(isAppPageUrl('app://MARBLES/index.html', linux), 'host is case-insensitive')
for (const bad of [
  'file:///opt/Marbles/resources/app.asar/out/renderer/index.html',
  'file:///home/me/Downloads/evil.html',
  'app://evil/index.html',
  'app://marbles.evil/index.html',
  'app://marbles:8080/index.html',
  'appx://marbles/index.html',
  'http://marbles/index.html',
  'http://localhost:5173/',
  'appframe://app/x',
  'data:text/html,hi',
  'about:blank',
  'not a url',
  ''
]) {
  assert.equal(isAppPageUrl(bad, linux), false, bad)
}

// ---- app:// request paths stay inside the renderer folder ----
assert.equal(appRelativePath('/'), 'index.html')
assert.equal(appRelativePath(''), 'index.html')
assert.equal(appRelativePath('/index.html'), 'index.html')
assert.equal(appRelativePath('/assets/index-abc.js'), 'assets/index-abc.js')
assert.equal(appRelativePath('/assets/a%20b.css'), 'assets/a b.css')
assert.equal(appRelativePath('/assets/../index.html'), 'index.html', 'normalized inside')
for (const bad of [
  '/..',
  '/../main/index.js',
  '/%2e%2e/main/index.js',
  '/assets/%2e%2e%2f%2e%2e/x',
  '/..%5cmain%5cindex.js',
  '/assets%5c..%5c..%5cx',
  '/a%00b',
  '/%E0%A4%A',
  '/assets/'
]) {
  // Normalizing "/.." from the root stays at the root, so the first two map back inside;
  // what matters is that nothing resolves outside the folder.
  const r = appRelativePath(bad)
  assert.ok(r === null || !r.startsWith('..'), bad)
}
assert.equal(appRelativePath('/..%5cmain%5cindex.js'), null, 'backslash rejected')
assert.equal(appRelativePath('/a%00b'), null, 'NUL rejected')
assert.equal(appRelativePath('/%E0%A4%A'), null, 'bad escape rejected')
assert.equal(appRelativePath('/assets/'), null, 'directory rejected')

// ---- app page: dev server ----
const dev = appPageFor('http://localhost:5173/')
assert.ok(isAppPageUrl('http://localhost:5173/#/x', dev))
assert.equal(isAppPageUrl('http://localhost:5174/', dev), false)
assert.equal(isAppPageUrl('http://127.0.0.1:5173/', dev), false)
assert.equal(isAppPageUrl(linuxUrl, dev), false)

// ---- IPC sender ----
const isApp = (u) => isAppPageUrl(u, linux)
const main = { url: linuxUrl, processId: 4, routingId: 1 }
assert.ok(isTrustedSender(main, main, isApp))
assert.ok(isTrustedSender({ ...main }, main, isApp), 'compared by ids, not identity')
assert.equal(isTrustedSender({ ...main, routingId: 7 }, main, isApp), false, 'subframe')
assert.equal(isTrustedSender({ ...main, processId: 9 }, main, isApp), false, 'other process')
assert.equal(
  isTrustedSender(
    { ...main, url: 'file:///tmp/x.html' },
    { ...main, url: 'file:///tmp/x.html' },
    isApp
  ),
  false,
  'main frame showing another page'
)
assert.equal(isTrustedSender(null, main, isApp), false)
assert.equal(isTrustedSender(main, null, isApp), false)
const disposed = {
  get url() {
    throw new Error('Render frame was disposed')
  },
  processId: 4,
  routingId: 1
}
assert.equal(isTrustedSender(disposed, main, isApp), false)

// ---- permissions ----
assert.ok(isAllowedPermission('clipboard-sanitized-write'))
for (const p of [
  'clipboard-read',
  'notifications',
  'openExternal',
  'media',
  'geolocation',
  'fullscreen',
  'local-network-access',
  'unknown',
  ''
]) {
  assert.equal(isAllowedPermission(p), false, p)
}

// ---- openable URLs ----
assert.equal(parseOpenableUrl('https://example.com/a?b=1#c')?.href, 'https://example.com/a?b=1#c')
assert.ok(parseOpenableUrl('http://example.com'))
for (const bad of [
  'javascript:alert(1)',
  'file:///etc/passwd',
  'appframe://app/x',
  'mailto:a@b.c',
  'ms-settings:',
  'https://user:pass@example.com/',
  'https://user@example.com/',
  'https://:pass@example.com/',
  'not a url',
  ''
]) {
  assert.equal(parseOpenableUrl(bad), null, bad)
}

// ---- prompt text ----
{
  const { message, detail } = linkPromptText(new URL('https://example.com/path'))
  assert.equal(message, 'Open this link in your browser?')
  assert.equal(detail, 'example.com\n\nhttps://example.com/path')
  const long = linkPromptText(new URL('https://example.com/' + 'a'.repeat(1000)))
  const shownUrl = long.detail.split('\n\n')[1]
  assert.equal(shownUrl.length, 301)
  assert.ok(shownUrl.endsWith('…'))
  assert.ok(long.detail.startsWith('example.com\n'))
  // Look-alike hosts show as punycode; bidi controls in the path are percent-encoded.
  const tricky = linkPromptText(new URL('https://exаmple.com/\u202Egnp.exe'))
  assert.ok(tricky.detail.startsWith('xn--'), tricky.detail)
  assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(tricky.detail))
  assert.ok(
    linkPromptText(new URL('https://example.com:8443/')).detail.startsWith('example.com:8443')
  )
}

// ---- prompt gate ----
{
  let t = 0
  const gate = createPromptGate(1000, () => t)
  assert.ok(gate.tryOpen())
  assert.equal(gate.tryOpen(), false, 'one prompt at a time')
  gate.close(true)
  t = 500
  assert.equal(gate.tryOpen(), false, 'cooldown after cancel')
  t = 1001
  assert.ok(gate.tryOpen())
  gate.close(false)
  assert.ok(gate.tryOpen(), 'no cooldown after opening a link')
  gate.close(false)
}

// ---- settings patch from the window ----
{
  assert.deepEqual(cleanSettingsPatch(null), {})
  assert.deepEqual(cleanSettingsPatch('x'), {})
  assert.deepEqual(cleanSettingsPatch([{ theme: 'dark' }]), {})
  assert.deepEqual(
    cleanSettingsPatch({
      theme: 'light',
      accent: '#4aa3ff',
      allowLocalNetwork: true,
      builderModel: 'chatgpt:gpt-5',
      reasoningEffort: 'high'
    }),
    {
      theme: 'light',
      accent: '#4aa3ff',
      allowLocalNetwork: true,
      builderModel: 'chatgpt:gpt-5',
      reasoningEffort: 'high'
    }
  )
  assert.deepEqual(
    cleanSettingsPatch({
      libraryPath: '/home/someone/.ssh',
      format: 99,
      dismissedNotices: ['x'],
      made_up: 1
    }),
    {},
    'main-owned and unknown keys are dropped'
  )
  assert.deepEqual(
    cleanSettingsPatch({
      theme: 'pink',
      accent: 'red;}body{display:none',
      allowLocalNetwork: 'yes',
      builderModel: '',
      utilityModel: 'a b',
      namingModel: 'x'.repeat(201),
      reasoningEffort: 5
    }),
    {},
    'wrong types and values are dropped'
  )
  assert.deepEqual(cleanSettingsPatch(JSON.parse('{"__proto__":{"theme":"light"}}')), {})
}

console.log('guard: all tests passed')
