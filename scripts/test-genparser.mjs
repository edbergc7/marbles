/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run: node scripts/test-genparser.mjs   (Node >= 22.18 strips TS types natively)
import assert from 'node:assert/strict'
import { GenParser } from '../src/main/services/genParser.ts'

const body = '<div class="app">' + 'x'.repeat(300) + '</div>'
const normal =
  'Sure!\n<plan>\n1. Drop zone\n- Crop box\n* Export\n\n</plan>\n<html_app>\n<!-- step:1 -->\n<!DOCTYPE html><html><body>' +
  body +
  '\n<!-- step:2 -->\n<p>b</p>\n<!-- step:3 -->\n<p>c</p></body></html>\n</html_app>\nbye'

function run(chunks, reason = 'stop') {
  const p = new GenParser()
  const events = []
  for (const c of chunks) events.push(...p.feed(c))
  return { events, result: p.finish(reason), p }
}
const split = (s, size) =>
  Array.from({ length: Math.ceil(s.length / size) }, (_, i) => s.slice(i * size, (i + 1) * size))

let n = 0
function t(name, fn) {
  fn()
  n++
  console.log('ok -', name)
}

t('normal output', () => {
  const { events, result } = run([normal])
  assert.deepEqual(events[0], { type: 'plan', items: ['Drop zone', 'Crop box', 'Export'] })
  assert.deepEqual(
    events.filter((e) => e.type === 'step').map((e) => e.index),
    [0, 1, 2]
  )
  assert.ok(result.ok)
  assert.ok(!result.html.includes('step:'))
  assert.ok(result.html.startsWith('<!DOCTYPE html>'))
  assert.ok(!result.html.includes('html_app'))
})

t('split at every single position (two chunks)', () => {
  for (let i = 1; i < normal.length; i++) {
    const { events, result } = run([normal.slice(0, i), normal.slice(i)])
    assert.equal(events.filter((e) => e.type === 'plan').length, 1, `plan at ${i}`)
    assert.deepEqual(
      events.filter((e) => e.type === 'step').map((e) => e.index),
      [0, 1, 2],
      `steps at split ${i}`
    )
    assert.ok(result.ok, `result at ${i}`)
  }
})

t('char-by-char and 3-char chunks', () => {
  for (const size of [1, 3, 7]) {
    const { events, result } = run(split(normal, size))
    assert.equal(events.filter((e) => e.type === 'plan').length, 1)
    assert.deepEqual(
      events.filter((e) => e.type === 'step').map((e) => e.index),
      [0, 1, 2]
    )
    assert.ok(result.ok)
  }
})

t('plan is emitted when </plan> arrives, before html', () => {
  const p = new GenParser()
  assert.deepEqual(p.feed('<plan>\n1. A\n2. B\n'), [])
  assert.deepEqual(p.feed('</plan>'), [{ type: 'plan', items: ['A', 'B'] }])
})

t('fenced html inside html_app', () => {
  const text =
    '<plan>\n1. A\n</plan>\n<html_app>\n```html\n<html><body>' +
    body +
    '</body></html>\n```\n</html_app>'
  const { result } = run(split(text, 5))
  assert.ok(result.ok)
  assert.ok(result.html.startsWith('<html>'))
  assert.ok(!result.html.includes('```'))
})

t('missing close tag -> invalid / cut off', () => {
  const text = '<plan>\n1. A\n</plan>\n<html_app>\n<html><body>' + body
  assert.equal(run([text]).result.ok, false)
  assert.match(run([text], 'length').result.message, /too big to finish/)
  assert.match(run([text], 'stop').result.message, /stopped before/)
})

t('no plan -> plan [] emitted when html starts', () => {
  const text = '<html_app><html><body>' + body + '</body></html></html_app>'
  const { events, result } = run(split(text, 4))
  assert.deepEqual(events[0], { type: 'plan', items: [] })
  assert.equal(events.filter((e) => e.type === 'plan').length, 1)
  assert.ok(result.ok)
})

t('too short / no tag / no html_app', () => {
  assert.equal(run(['<plan>1. a</plan><html_app><p>hi</p></html_app>']).result.ok, false)
  assert.equal(run(['<html_app>' + 'plain text '.repeat(40) + '</html_app>']).result.ok, false)
  assert.equal(run(['just chatting']).result.ok, false)
})

t('steps only increase; out-of-order markers ignored', () => {
  const text =
    '<plan>1. a\n2. b\n3. c</plan><html_app><!-- step:2 --><p>x</p><!-- step:1 --><!-- step:2 --><!-- step:3 -->' +
    body.repeat(1) +
    '</html_app>'
  const { events } = run(split(text, 6))
  assert.deepEqual(
    events.filter((e) => e.type === 'step').map((e) => e.index),
    [1, 2]
  )
})

t('next suggestions parsed after html', () => {
  const text =
    '<plan>1. a</plan><html_app><html><body>' +
    body +
    '</body></html></html_app>\n<next>\n- Add a copy button\n- Dark mode\n- Save history\n- Fourth one\n</next>'
  const { result } = run(split(text, 5))
  assert.ok(result.ok)
  assert.deepEqual(result.next, ['Add a copy button', 'Dark mode', 'Save history'])
})

t('no next block -> empty next', () => {
  const { result } = run([normal])
  assert.ok(result.ok)
  assert.deepEqual(result.next, [])
})

t('missing </html_app> but a finished document -> recovered, next still read', () => {
  const text =
    '<plan>1. a</plan><html_app><html><body>' +
    body +
    '</body></html>\n<next>\n- Add product photos\n- Track stock\n</next>'
  const { result } = run(split(text, 7))
  assert.ok(result.ok)
  assert.ok(result.html.endsWith('</html>'))
  assert.ok(!result.html.includes('<next>'))
  assert.deepEqual(result.next, ['Add product photos', 'Track stock'])
})

t('missing </html_app> and cut off by length -> still fails', () => {
  const text = '<plan>1. a</plan><html_app><html><body>' + body + '</body></html>'
  assert.equal(run([text], 'length').result.ok, false)
  // no </html> either: nothing to recover
  assert.equal(run(['<plan>1. a</plan><html_app><html><body>' + body]).result.ok, false)
})

console.log(`\n${n} test groups passed`)
