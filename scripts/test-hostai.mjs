/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run: node scripts/test-hostai.mjs
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
const { createAiHandler, mediaParts } = load('src/main/services/hostAi.ts')

const cfg = { builderModel: 'b/model', utilityModel: 'u/model', namingModel: 'n/model' }
const used = []
const sent = []
const vision = new Set(['u/model', 'n/model'])
const llm = {
  complete: async (o) => (used.push(o.model), sent.push(o.messages), 'ok'),
  supportsImages: async (m) => vision.has(m)
}
const handler = createAiHandler(llm, { get: async () => ({ ...cfg }) })

let n = 0
async function modelFor(model) {
  used.length = 0
  await handler(`app${n++}`, { prompt: 'hi', ...(model === undefined ? {} : { model }) })
  return used[0]
}

assert.equal(await modelFor(undefined), 'u/model')
assert.equal(await modelFor('b/model'), 'u/model') // Builder model is never offered to apps
assert.equal(await modelFor('n/model'), 'n/model')
assert.equal(await modelFor('u/model'), 'u/model')
assert.equal(await modelFor('anthropic/claude-opus-max'), 'u/model')
assert.equal(await modelFor(' b/model '), 'u/model')
assert.equal(await modelFor(42), 'u/model')
// Rolling per-app rate limit: 30 calls a minute, counted separately per app.
const limited = createAiHandler(llm, { get: async () => ({ ...cfg }) })
for (let i = 0; i < 30; i++) await limited('busy', { prompt: 'hi' })
await assert.rejects(limited('busy', { prompt: 'hi' }), /too often/)
await limited('other', { prompt: 'hi' })
// ---- images and PDFs ----
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const png = `data:image/png;base64,${PNG.toString('base64')}`
const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 x').toString('base64')}`
const parts = mediaParts({ images: [png], files: [{ name: 'Spec v2.pdf', data: pdf }] })
assert.deepEqual(
  parts.map((p) => p.type),
  ['image', 'file']
)
assert.equal(parts[1].name, 'Spec v2.pdf')
// The real type wins: a PNG claimed as JPEG goes out as PNG.
assert.ok(
  mediaParts({ images: [png.replace('image/png', 'image/jpeg')] })[0].dataUrl.startsWith(
    'data:image/png;'
  )
)
assert.equal(mediaParts({ files: [{ name: '../x', data: pdf }] })[0].name, 'document.pdf')
assert.deepEqual(mediaParts({}), [])
assert.throws(() => mediaParts({ images: 'x' }), /must be an array/)
assert.throws(() => mediaParts({ images: ['https://example.com/a.png'] }), /isn't a PNG/)
assert.throws(
  () =>
    mediaParts({ images: [`data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`] }),
  /isn't a PNG/
)
assert.throws(() => mediaParts({ files: [{ data: png }] }), /isn't a PDF/)
assert.throws(() => mediaParts({ images: [png, png, png, png, png] }), /at most 4 images/)
assert.throws(
  () => mediaParts({ files: [{ data: pdf }, { data: pdf }, { data: pdf }] }),
  /at most 2/
)
const big = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]).toString('base64')}`
assert.throws(() => mediaParts({ images: [big] }), /under 20 MB/)

// Media goes with the last user message.
sent.length = 0
await handler('media1', {
  system: 's',
  messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'what is this?' }
  ],
  images: [png]
})
const msgs = sent[0]
assert.equal(msgs[1].content, 'first')
assert.deepEqual(
  msgs[3].content.map((p) => p.type),
  ['text', 'image']
)
assert.equal(msgs[3].content[0].text, 'what is this?')

// A Utility model that can't see images: the Naming model is used instead.
vision.delete('u/model')
used.length = 0
await handler('media2', { prompt: 'look', images: [png] })
assert.equal(used[0], 'n/model')
// A PDF alone doesn't need an image-capable model.
used.length = 0
await handler('media3', { prompt: 'read', files: [{ data: pdf }] })
assert.equal(used[0], 'u/model')
vision.clear()
await assert.rejects(handler('media4', { prompt: 'look', images: [png] }), /can't see images/)

console.log('hostAi tests passed')
