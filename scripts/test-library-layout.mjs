// Tests sidebar folders and pins in LibraryService without Electron.
//   node scripts/test-library-layout.mjs
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
const { LibraryService, LIBRARY_FORMAT } = mod.exports

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marbles-layout-'))
const lib = new LibraryService(async () => dir)
const events = []
lib.setNotifier((ids) => events.push(ids))

try {
  // Empty library: empty layout, no file needed.
  assert.deepEqual(await lib.layout(), { folders: [], pinned: [] })

  const a = await lib.create({ name: 'Alpha', html: '<p>a</p>' })
  const b = await lib.create({ name: 'Beta', html: '<p>b</p>' })

  // Folders
  const work = await lib.createFolder('  Work  ', '💼')
  assert.match(work.id, /^f-[a-z0-9]+$/)
  assert.equal(work.name, 'Work')
  const home = await lib.createFolder('')
  assert.equal(home.name, 'New folder')
  await lib.updateFolder(home.id, { name: 'Home' })
  let layout = await lib.layout()
  assert.deepEqual(
    layout.folders.map((f) => f.name),
    ['Work', 'Home']
  )

  // Reorder
  layout = await lib.reorderFolders([home.id, work.id])
  assert.deepEqual(
    layout.folders.map((f) => f.id),
    [home.id, work.id]
  )
  layout = await lib.reorderFolders([work.id]) // unlisted ids keep order at the end
  assert.deepEqual(
    layout.folders.map((f) => f.id),
    [work.id, home.id]
  )

  // Filing an app does not bump updatedAt
  const before = (await lib.get(a.id)).updatedAt
  await new Promise((r) => setTimeout(r, 5))
  const filed = await lib.setFolder(a.id, work.id)
  assert.equal(filed.folder, work.id)
  assert.equal(filed.updatedAt, before)
  assert.equal((await lib.get(a.id)).folder, work.id)
  await assert.rejects(lib.setFolder(a.id, 'f-nope1234'), /Folder not found/)
  await assert.rejects(lib.setFolder(a.id, '../x'), /Invalid folder id/)

  // Unfile
  await lib.setFolder(b.id, home.id)
  assert.equal((await lib.setFolder(b.id, null)).folder, undefined)

  // Pins: dedupe, drop junk ids, keep order
  layout = await lib.setPinned([b.id, a.id, b.id, '../evil', 42])
  assert.deepEqual(layout.pinned, [b.id, a.id])

  // Deleting a folder moves its apps to the Trash (a is in work, b is not)
  layout = await lib.deleteFolder(work.id)
  assert.deepEqual(
    layout.folders.map((f) => f.id),
    [home.id]
  )
  assert.deepEqual(
    (await lib.list()).map((x) => x.id),
    [b.id]
  )
  assert.deepEqual(
    (await lib.listTrash()).map((x) => x.id),
    [a.id]
  )

  // Permanently delete one trashed app
  await assert.rejects(lib.deleteTrashed('../x'), /Invalid/)
  await assert.rejects(lib.deleteTrashed('nope-1234'), /Not in trash/)
  await lib.deleteTrashed(a.id)
  assert.deepEqual(await lib.listTrash(), [])
  assert.equal((await lib.list()).length, 1)

  // Corrupt library.json reads as empty instead of throwing
  fs.writeFileSync(path.join(dir, 'library.json'), '{not json')
  assert.deepEqual(await lib.layout(), { folders: [], pinned: [] })
  fs.writeFileSync(
    path.join(dir, 'library.json'),
    JSON.stringify({ folders: [{ id: 'bad' }, { id: 'f-good1', name: 7 }], pinned: 'x' })
  )
  assert.deepEqual(await lib.layout(), {
    folders: [{ id: 'f-good1', name: 'Folder' }],
    pinned: []
  })

  // Concurrent edits are serialized (none lost)
  fs.rmSync(path.join(dir, 'library.json'))
  await Promise.all(['A', 'B', 'C', 'D', 'E'].map((n) => lib.createFolder(n)))
  assert.equal((await lib.layout()).folders.length, 5)

  assert.ok(
    events.some((e) => e.length === 0),
    'layout writes notify'
  )
  // library.json is stamped with the format this build writes
  const stamped = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
  assert.equal(stamped.format, LIBRARY_FORMAT)
  assert.equal(await lib.tooNew(), false)

  // A library from a newer Marbles: readable, but every change is refused and nothing is written
  const newer = JSON.stringify({ ...stamped, format: LIBRARY_FORMAT + 1, future: { x: 1 } })
  fs.writeFileSync(path.join(dir, 'library.json'), newer)
  assert.equal(await lib.tooNew(), true)
  assert.equal((await lib.layout()).folders.length, 5)
  assert.ok((await lib.list()).some((m) => m.id === b.id))
  assert.equal(typeof (await lib.readVersion(b.id, 1)), 'string')
  for (const change of [
    () => lib.createFolder('Nope'),
    () => lib.create({ name: 'Gamma', html: '<p>g</p>' }),
    () => lib.rename(b.id, 'Renamed'),
    () => lib.trash(b.id),
    () => lib.writeStorage(b.id, { k: 1 })
  ]) {
    await assert.rejects(change(), { name: 'LibraryTooNewError' })
  }
  assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), newer)
  assert.equal((await lib.get(b.id)).name, 'Beta')

  // Junk in `format` counts as 1
  for (const format of ['2', 1.5, 0, -3, null]) {
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ ...stamped, format }))
    assert.equal(await lib.tooNew(), false)
  }

  // Linked files inside an app folder are never read: a linked storage.json would hand its
  // app any JSON file on the computer through host.storage.
  if (process.platform !== 'win32') {
    const secret = path.join(dir, 'outside.json')
    fs.writeFileSync(secret, JSON.stringify({ token: 'secret' }))
    const appDir = path.join(dir, 'apps', b.id)
    await lib.writeStorage(b.id, { mine: 1 })
    assert.deepEqual(await lib.readStorage(b.id), { mine: 1 })
    fs.rmSync(path.join(appDir, 'storage.json'))
    fs.symlinkSync(secret, path.join(appDir, 'storage.json'))
    assert.deepEqual(await lib.readStorage(b.id), {})
    fs.symlinkSync(secret, path.join(appDir, 'chat.json'))
    assert.deepEqual(await lib.readChat(b.id), [])
    fs.symlinkSync(secret, path.join(appDir, 'v9.html'))
    await assert.rejects(lib.readVersion(b.id, 9))
    assert.equal(await lib.readVersion(b.id, 1), '<p>b</p>')
    // Writing replaces the link instead of writing through it.
    await lib.writeStorage(b.id, { mine: 2 })
    assert.deepEqual(await lib.readStorage(b.id), { mine: 2 })
    assert.deepEqual(JSON.parse(fs.readFileSync(secret, 'utf8')), { token: 'secret' })
  }

  console.log('test-library-layout: all passed')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
