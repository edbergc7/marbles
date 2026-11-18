/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Generation benchmark: builds a set of prompts with the real builder prompt and records
// cost, tokens, time, validity and runtime errors. Spends real OpenRouter credit.
//   pnpm exec electron scripts/bench-gen.mjs [--only id,id] [--classify-only] [--out name]
// Results go to .bench/<id>.html and .bench/results.json (or .bench/<name>/ with --out).
// --smoke-dir <dir>: only smoke-test every <id>.html already in <dir> (e.g. from
// scripts/bench-app.mjs) and write <dir>/smoke.json. Spends nothing.
import { app, net, safeStorage, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const smokeDir = argOf('--smoke-dir')
// --sheet dirA,dirB,... [--ids a,b]: one PNG per 4 prompts, a row per prompt and a column per dir,
// from the <id>.png files --smoke-dir wrote. Written to .bench/sheet-<n>.png.
const sheetDirs = argOf('--sheet')?.split(',')
const out = smokeDir ?? join(root, '.bench', argOf('--out') ?? '')
const API = 'https://openrouter.ai/api/v1'

const PROMPTS = JSON.parse(await fs.readFile(join(root, 'scripts/bench-prompts.json'), 'utf8'))

app.setPath('userData', join(app.getPath('appData'), 'Marbles-bench'))
const realUserData = join(app.getPath('appData'), 'Marbles')

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null
const classifyOnly = args.includes('--classify-only')
const buildOnly = args.includes('--build-only')

async function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const raw = JSON.parse(await fs.readFile(join(realUserData, 'secrets.json'), 'utf8'))
  if (safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    safeStorage.setUsePlainTextEncryption(true)
  return safeStorage.decryptString(Buffer.from(raw.openrouter, 'base64'))
}

async function settings() {
  const s = JSON.parse(await fs.readFile(join(realUserData, 'settings.json'), 'utf8'))
  return {
    builderModel: 'moonshotai/kimi-k3',
    namingModel: 'google/gemini-2.5-flash-lite',
    reasoningEffort: 'low',
    ...s
  }
}

async function call(k, body) {
  const res = await net.fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      'X-Title': 'Marbles bench'
    },
    body: JSON.stringify({ ...body, usage: { include: true } })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res
}

async function build(k, s, p) {
  const builder = await fs.readFile(join(root, 'src/main/prompts/builder.md'), 'utf8')
  const createUser = await fs.readFile(join(root, 'src/main/prompts/create-user.md'), 'utf8')
  const css = await fs.readFile(join(root, 'design/design.css'), 'utf8')
  const t0 = Date.now()
  const res = await call(k, {
    model: s.builderModel,
    stream: true,
    max_tokens: 32000,
    temperature: 0.4,
    reasoning: { effort: s.reasoningEffort },
    messages: [
      { role: 'system', content: builder.split('{{DESIGN_CSS}}').join(css) },
      { role: 'user', content: createUser.split('{{PROMPT}}').join(p.prompt) }
    ]
  })
  let text = ''
  let reasoningChars = 0
  let usage = null
  let finish = null
  let tFirst = null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const d = line.slice(5).trim()
      if (d === '[DONE]') continue
      let j
      try {
        j = JSON.parse(d)
      } catch {
        continue
      }
      if (j.usage) usage = j.usage
      const c = j.choices?.[0]
      if (!c) continue
      if (c.delta?.reasoning) reasoningChars += c.delta.reasoning.length
      if (c.delta?.content) {
        if (tFirst === null) tFirst = Date.now() - t0
        text += c.delta.content
      }
      if (c.finish_reason) finish = c.finish_reason
    }
  }
  const html = text.match(/<html_app>([\s\S]*?)(<\/html_app>|$)/)?.[1] ?? ''
  const plan = text.match(/<plan>([\s\S]*?)<\/plan>/)?.[1]?.trim() ?? ''
  const closed = /<\/html_app>/.test(text)
  await fs.writeFile(join(out, `${p.id}.html`), html)
  await fs.writeFile(join(out, `${p.id}.raw.txt`), text)
  return {
    ms: Date.now() - t0,
    msToFirstText: tFirst,
    finish,
    closed,
    htmlChars: html.length,
    plan,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cost: usage?.cost,
    reasoningChars
  }
}

// Load the HTML in a hidden window with a stub bridge and collect errors for a few seconds.
async function smoke(id) {
  const html = await fs.readFile(join(out, `${id}.html`), 'utf8')
  if (html.length < 200) return { errors: ['no html'] }
  const stub = `<script>window.host={storage:{get:async()=>undefined,set:async()=>{},remove:async()=>{},keys:async()=>[]},ai:async()=>'stub',fetch:async()=>({status:200,headers:{},body:'{}'})};</script>`
  // The app injects design.css at render time; do the same so screenshots look real.
  const css = await fs.readFile(join(root, 'design/design.css'), 'utf8')
  const doc = html.replace(/<head[^>]*>/i, (m) => m + stub + `<style>${css}</style>`)
  const file = join(out, `${id}.smoke.html`)
  await fs.writeFile(file, doc)
  // Offscreen rendering: screenshots of a never-shown window can hang with no GPU.
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { offscreen: true }
  })
  const errors = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message.slice(0, 200))
  })
  await win.loadFile(file).catch((e) => errors.push('load: ' + e.message))
  await new Promise((r) => setTimeout(r, 3000))
  const info = await win.webContents
    .executeJavaScript(
      `({ buttons: document.querySelectorAll('button').length, inputs: document.querySelectorAll('input,textarea,select').length, text: document.body.innerText.length })`
    )
    .catch(() => null)
  const shot = await Promise.race([
    win.webContents.capturePage(),
    new Promise((r) => setTimeout(() => r(null), 5000))
  ]).catch(() => null)
  if (shot) await fs.writeFile(join(out, `${id}.png`), shot.toPNG())
  win.destroy()
  return { errors, dom: info }
}

const CLASSIFY_SYSTEM = await fs.readFile(join(root, 'src/main/prompts/name.md'), 'utf8')

async function classify(k, model, p) {
  const t0 = Date.now()
  const res = await call(k, {
    model,
    max_tokens: 400,
    reasoning: { enabled: false },
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: p.prompt }
    ]
  })
  const j = await res.json()
  const content = j.choices?.[0]?.message?.content ?? ''
  // Same lenient parse as generator.ts firstJsonObject.
  let parsed = null
  const start = content.indexOf('{')
  for (
    let end = content.indexOf('}', start);
    start !== -1 && end !== -1 && !parsed;
    end = content.indexOf('}', end + 1)
  ) {
    try {
      parsed = JSON.parse(content.slice(start, end + 1))
    } catch {
      // try the next brace
    }
  }
  return { ms: Date.now() - t0, cost: j.usage?.cost, parsed, raw: parsed ? undefined : content }
}

async function pool(items, n, fn) {
  const results = []
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const it = items[i++]
        results.push(await fn(it))
      }
    })
  )
  return results
}

// Smoke windows close one by one; don't let Electron quit when the last one does.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    if (sheetDirs) {
      const ids =
        argOf('--ids')?.split(',') ??
        (await fs.readdir(sheetDirs[0]))
          .filter((f) => f.endsWith('.png'))
          .map((f) => f.slice(0, -4))
      for (let i = 0; i < ids.length; i += 4) {
        const rows = ids.slice(i, i + 4)
        const cell = (d, id) =>
          `<figure><img src="file://${join(d, id + '.png')}"><figcaption>${d.split('/').pop()} · ${id}</figcaption></figure>`
        const page = `<!doctype html><style>body{margin:0;background:#fff;font:14px sans-serif}
          .g{display:grid;grid-template-columns:repeat(${sheetDirs.length},1fr);gap:8px;padding:8px}
          figure{margin:0}img{width:100%;border:1px solid #ccc;display:block}</style>
          <div class="g">${rows.map((id) => sheetDirs.map((d) => cell(d, id)).join('')).join('')}</div>`
        const file = join(root, '.bench', `sheet-${i / 4 + 1}.html`)
        await fs.writeFile(file, page)
        const w = new BrowserWindow({
          webPreferences: { offscreen: true },
          show: false,
          width: 600 * sheetDirs.length,
          height: 430 * rows.length + 20
        })
        await w.loadFile(file)
        await new Promise((r) => setTimeout(r, 800))
        const img = await w.webContents.capturePage()
        await fs.writeFile(join(root, '.bench', `sheet-${i / 4 + 1}.png`), img.toPNG())
        w.destroy()
        console.log(`[sheet] .bench/sheet-${i / 4 + 1}.png`)
      }
      app.quit()
      return
    }
    await fs.mkdir(out, { recursive: true })
    if (smokeDir) {
      const ids = (await fs.readdir(out))
        .filter((f) => f.endsWith('.html') && !f.endsWith('.smoke.html'))
        .map((f) => f.slice(0, -5))
      const smokes = {}
      for (const id of ids) {
        smokes[id] = await smoke(id)
        console.log(`[smoke] ${id}: ${smokes[id].errors.length} errors`)
      }
      await fs.writeFile(join(out, 'smoke.json'), JSON.stringify(smokes, null, 2))
      app.quit()
      return
    }
    const k = await key()
    const s = await settings()
    const prompts = PROMPTS.filter((p) => !only || only.includes(p.id))
    const resultsFile = join(out, 'results.json')
    let results = {}
    try {
      results = JSON.parse(await fs.readFile(resultsFile, 'utf8'))
    } catch {
      // fresh
    }
    const save = () => fs.writeFile(resultsFile, JSON.stringify(results, null, 2))

    if (!buildOnly) {
      await pool(prompts, 6, async (p) => {
        try {
          const c = await classify(k, s.namingModel, p)
          results[p.id] = { ...results[p.id], tier: p.tier, prompt: p.prompt, scope: c }
          console.log(`[scope] ${p.id}: ${JSON.stringify(c.parsed ?? c.raw)}`)
        } catch (e) {
          console.log(`[scope] ${p.id} failed: ${e.message}`)
        }
      })
      await save()
    }
    if (!classifyOnly) {
      await pool(
        prompts.filter((p) => p.build),
        4,
        async (p) => {
          try {
            console.log(`[build] ${p.id} start`)
            const b = await build(k, s, p)
            const sm = await smoke(p.id)
            results[p.id] = {
              ...results[p.id],
              tier: p.tier,
              prompt: p.prompt,
              build: b,
              smoke: sm
            }
            console.log(
              `[build] ${p.id} done ${Math.round(b.ms / 1000)}s cost=$${b.cost?.toFixed(3)} out=${b.completionTokens} (reasoning ${b.reasoningTokens}) finish=${b.finish} closed=${b.closed} errors=${sm.errors.length}`
            )
          } catch (e) {
            console.log(`[build] ${p.id} failed: ${e.message}`)
            results[p.id] = { ...results[p.id], build: { error: e.message } }
          }
          await save()
        }
      )
    }
    await save()
  } catch (e) {
    console.error(e)
  }
  app.quit()
})
