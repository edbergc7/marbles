/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Builds benchmark prompts through a RUNNING Marbles dev app, so any model the app can call
// (including chatgpt:<slug> on the signed-in ChatGPT plan) goes through the real pipeline:
// builder prompt, streaming, parser, saving, token refresh. Uses the plan's usage.
//
// 1. Start the app with a debugging port (a throwaway data folder keeps the real library clean):
//      MARBLES_USER_DATA=/tmp/marbles-bench pnpm exec electron-vite dev -- --remote-debugging-port=9223
// 2. Sign in / add a key in that window.
// 3. node scripts/bench-app.mjs --models chatgpt:gpt-6.1-terra,chatgpt:gpt-6.1-sol [--only id,id] [--jobs 2]
// 4. Smoke-test the results: pnpm exec electron scripts/bench-gen.mjs --smoke-dir .bench/<model>
//
// Results: .bench/<model>/<id>.html and .bench/<model>/results.json.
// Token counts are in the app's own log ("[gen] <jobId8> ... prompt_tokens=… completion_tokens=…").
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const models = (argOf('--models') ?? '').split(',').filter(Boolean)
const only = argOf('--only')?.split(',') ?? null
const jobs = Number(argOf('--jobs') ?? 2)
const port = Number(argOf('--port') ?? 9223)
const BUILD_TIMEOUT_MS = 8 * 60_000

if (!models.length) {
  console.error('Usage: node scripts/bench-app.mjs --models a,b [--only id,id] [--jobs 2]')
  process.exit(2)
}

const PROMPTS = JSON.parse(await fs.readFile(join(root, 'scripts/bench-prompts.json'), 'utf8'))
const prompts = PROMPTS.filter((p) => p.build && (!only || only.includes(p.id)))

/** Minimal Chrome DevTools Protocol client for the app's renderer page. */
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = list.find((p) => p.type === 'page' && /^http:\/\/localhost:\d+\/?$/.test(p.url))
  if (!page) throw new Error(`No Marbles window on port ${port}. Is the app running with it?`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data)
    if (waiting.has(j.id)) {
      waiting.get(j.id)(j)
      waiting.delete(j.id)
    }
  }
  return {
    async evaluate(expression) {
      const my = ++id
      const reply = new Promise((r) => waiting.set(my, r))
      ws.send(
        JSON.stringify({
          id: my,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
      const j = await reply
      if (j.result?.exceptionDetails) {
        throw new Error(j.result.exceptionDetails.exception?.description ?? 'evaluate failed')
      }
      return j.result?.result?.value
    },
    close: () => ws.close()
  }
}

/** Runs in the page: starts one create job and resolves when it ends. */
const BUILD_IN_PAGE = `async (prompt, model, timeoutMs) => {
  const jobId = crypto.randomUUID()
  const t0 = performance.now()
  let planMs = null
  return await new Promise((resolve) => {
    const finish = (r) => { off(); clearTimeout(timer); resolve({ jobId, ...r, ms: Math.round(performance.now() - t0), planMs }) }
    const timer = setTimeout(() => { window.api.gen.stop(jobId); finish({ ok: false, code: 'timeout' }) }, timeoutMs)
    const off = window.api.gen.onEvent((e) => {
      if (e.jobId !== jobId) return
      if (e.type === 'plan' && planMs === null) planMs = Math.round(performance.now() - t0)
      if (e.type === 'done') finish({ ok: true, appId: e.appId, version: e.version, model: e.meta?.versions?.at(-1)?.model })
      if (e.type === 'error') finish({ ok: false, code: e.code, message: e.message, detail: e.detail })
      if (e.type === 'scope') finish({ ok: false, code: 'scope' })
    })
    window.api.gen.start(jobId, { kind: 'create', prompt, model, skipScope: true })
  })
}`

const cdp = await connect()
const { libraryPath } = await cdp.evaluate('window.api.settings.get()')

for (const model of models) {
  const dir = join(root, '.bench', model.replace(/[^a-z0-9.-]+/gi, '_'))
  await fs.mkdir(dir, { recursive: true })
  const resultsFile = join(dir, 'results.json')
  let results = {}
  try {
    results = JSON.parse(await fs.readFile(resultsFile, 'utf8'))
  } catch {
    // fresh
  }
  const queue = [...prompts]
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        console.log(`[${model}] ${p.id} start`)
        const expr = `(${BUILD_IN_PAGE})(${JSON.stringify(p.prompt)}, ${JSON.stringify(model)}, ${BUILD_TIMEOUT_MS})`
        let r
        try {
          r = await cdp.evaluate(expr)
        } catch (e) {
          r = { ok: false, code: 'driver', message: e.message }
        }
        if (r.ok) {
          const html = await fs.readFile(
            join(libraryPath, 'apps', r.appId, `v${r.version}.html`),
            'utf8'
          )
          await fs.writeFile(join(dir, `${p.id}.html`), html)
          r.htmlChars = html.length
        }
        results[p.id] = { tier: p.tier, prompt: p.prompt, build: r }
        await fs.writeFile(resultsFile, JSON.stringify(results, null, 2))
        console.log(
          `[${model}] ${p.id} ${r.ok ? 'done' : `FAILED ${r.code}`} ${Math.round(r.ms / 1000)}s` +
            (r.ok ? ` html=${r.htmlChars}` : ` ${r.message ?? ''}`) +
            ` job=${r.jobId?.slice(0, 8)}`
        )
      }
    })
  )
}
cdp.close()
