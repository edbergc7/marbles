/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Dev fixtures: creates sample apps in the configured library.
//   pnpm seed                 -> uses libraryPath from the Electron userData settings.json
//   pnpm seed -- --dir <path> -> seed a specific library folder (or set SEED_LIBRARY)
// Idempotent: apps whose name already exists are skipped.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInt } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const samples = join(here, 'samples')

function userDataCandidates() {
  const names = ['Marbles']
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return names.map((n) => join(base, n))
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function resolveLibrary() {
  const argIdx = process.argv.indexOf('--dir')
  if (argIdx !== -1 && process.argv[argIdx + 1]) return resolve(process.argv[argIdx + 1])
  if (process.env.SEED_LIBRARY) return resolve(process.env.SEED_LIBRARY)
  const candidates = userDataCandidates()
  for (const dir of candidates) {
    try {
      const s = JSON.parse(await fs.readFile(join(dir, 'settings.json'), 'utf8'))
      if (s && typeof s.libraryPath === 'string' && s.libraryPath) return s.libraryPath
    } catch {
      // try next
    }
  }
  for (const dir of candidates) if (await exists(dir)) return join(dir, 'library')
  return join(candidates[0], 'library')
}

function slugify(name) {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'app'
  )
}
function makeId(name) {
  let s = ''
  for (let i = 0; i < 4; i++) s += randomInt(36).toString(36)
  return `${slugify(name)}-${s}`
}

const DAY = 24 * 60 * 60 * 1000
const ago = (days, hours = 0) => new Date(Date.now() - days * DAY - hours * 3600 * 1000)

// versions: [file, minutes-after-creation-offset (days ago), prompt]
const APPS = [
  {
    name: 'Notes',
    icon: '📝',
    dir: 'notes',
    updated: ago(0, 2),
    versions: [['v1', ago(0, 2), 'notes saved with host.storage']]
  },
  {
    name: 'Cropper',
    icon: '✂️',
    dir: 'cropper',
    updated: ago(0, 3),
    versions: [['v1', ago(0, 3), 'image cropper using Cropper.js from cdnjs']]
  },
  {
    name: 'Rates',
    icon: '💱',
    dir: 'rates',
    updated: ago(0, 4),
    versions: [['v1', ago(0, 4), 'USD exchange rates using host.fetch']]
  },
  {
    name: 'Broken',
    icon: '🐞',
    dir: 'broken',
    updated: ago(0, 5),
    versions: [['v1', ago(0, 5), 'throws errors to test error capture']]
  },
  {
    name: 'Text Case',
    icon: '🔠',
    dir: 'text-case',
    updated: ago(0, 1),
    versions: [
      ['v1', ago(2), 'text case converter'],
      ['v2', ago(1), 'add kebab-case, camelCase and a character/word count'],
      ['v3', ago(0, 1), 'add a copy button']
    ]
  },
  {
    name: 'Halftone Studio',
    icon: '🔘',
    dir: 'halftone',
    updated: ago(1),
    versions: [
      ['v1', ago(4), 'halftone dot pattern editor with size and angle'],
      ['v2', ago(1), 'add shape style and gain']
    ]
  },
  {
    name: 'Password Generator',
    icon: '🔐',
    dir: 'password',
    updated: ago(3),
    versions: [['v1', ago(3), 'password generator with length and character sets']]
  },
  {
    name: 'JSON Formatter',
    icon: '🧾',
    dir: 'json',
    updated: ago(10),
    versions: [['v1', ago(10), 'json formatter and validator']]
  }
]

async function main() {
  const library = await resolveLibrary()
  const appsDir = join(library, 'apps')
  await fs.mkdir(appsDir, { recursive: true })
  console.log(`Library: ${library}`)

  const existingNames = new Set()
  for (const d of await fs.readdir(appsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    try {
      const m = JSON.parse(await fs.readFile(join(appsDir, d.name, 'meta.json'), 'utf8'))
      if (m && typeof m.name === 'string') existingNames.add(m.name)
    } catch {
      // ignore
    }
  }

  for (const app of APPS) {
    if (existingNames.has(app.name)) {
      console.log(`skip   ${app.name} (already exists)`)
      continue
    }
    const id = makeId(app.name)
    const dir = join(appsDir, id)
    await fs.mkdir(dir, { recursive: true })
    const versions = []
    for (const [file, created, prompt] of app.versions) {
      await fs.copyFile(join(samples, app.dir, `${file}.html`), join(dir, `${file}.html`))
      versions.push({
        n: Number(file.slice(1)),
        createdAt: created.toISOString(),
        model: 'seed',
        prompt
      })
    }
    const meta = {
      id,
      name: app.name,
      icon: app.icon,
      createdAt: versions[0].createdAt,
      updatedAt: app.updated.toISOString(),
      currentVersion: versions[versions.length - 1].n,
      versions
    }
    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    await fs.writeFile(join(dir, 'chat.json'), '[]')
    await fs.writeFile(join(dir, 'storage.json'), '{}')
    console.log(`create ${app.name} -> ${id} (${versions.length} version(s))`)
  }

  // Hand-dropped folder: only v1.html, no meta.json (the library synthesizes meta on list()).
  const dropped = 'hand-dropped-demo'
  const droppedDir = join(appsDir, dropped)
  if (await exists(droppedDir)) {
    console.log(`skip   ${dropped} (already exists)`)
  } else {
    await fs.mkdir(droppedDir, { recursive: true })
    await fs.copyFile(join(samples, 'hand-dropped', 'v1.html'), join(droppedDir, 'v1.html'))
    console.log(`create ${dropped} (v1.html only, no meta.json)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
