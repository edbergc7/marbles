// Tests writeAtomic's file mode handling without Electron.
//   node scripts/test-secrets.mjs
import ts from 'typescript'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const req = createRequire(import.meta.url)
const file = path.join(root, 'src/main/services/library.ts')
const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', out)(req, mod, mod.exports)
const { writeAtomic } = mod.exports

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marbles-secrets-'))
try {
  const a = path.join(dir, 'a.json')
  await writeAtomic(a, '{"x":1}', { mode: 0o600 })
  assert.equal(fs.readFileSync(a, 'utf8'), '{"x":1}')
  // Replacing a looser existing file must give the new one the tight mode.
  const b = path.join(dir, 'b.json')
  fs.writeFileSync(b, 'old', { mode: 0o644 })
  await writeAtomic(b, 'new', { mode: 0o600 })
  assert.equal(fs.readFileSync(b, 'utf8'), 'new')
  // No mode: still works.
  const c = path.join(dir, 'c.json')
  await writeAtomic(c, 'plain')
  assert.equal(fs.readFileSync(c, 'utf8'), 'plain')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(a).mode & 0o777, 0o600)
    assert.equal(fs.statSync(b).mode & 0o777, 0o600)
  }
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    []
  )
  console.log('ok - writeAtomic mode')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
