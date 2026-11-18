// Incremental parser for the builder output format:
//   <plan>1. …</plan><html_app><!-- step:1 -->…</html_app>
// Optionally followed by a <next> block with up to 3 suggestions for the next change.
// Dependency-free so it can be unit-tested directly with node.

export type ParserEvent = { type: 'plan'; items: string[] } | { type: 'step'; index: number } // 0-based

export type ParseResult =
  { ok: true; html: string; plan: string[]; next: string[] } | { ok: false; message: string }

const PLAN_OPEN = '<plan>'
const PLAN_CLOSE = '</plan>'
const HTML_OPEN = '<html_app>'
const HTML_CLOSE = '</html_app>'
const NEXT_OPEN = '<next>'
const NEXT_CLOSE = '</next>'
const STEP_RE = /<!--\s*step:(\d+)\s*-->/g
const MIN_HTML_CHARS = 200

function parsePlanItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+\s*[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0)
}

/** Strips ``` fences the model may wrap around the document. */
function stripFences(s: string): string {
  let t = s.trim()
  t = t.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n?/, '')
  t = t.replace(/\r?\n?[ \t]*```\s*$/, '')
  return t.trim()
}

function removeStepMarkers(html: string): string {
  return html
    .replace(/^[ \t]*<!--\s*step:\d+\s*-->[ \t]*\r?\n/gm, '')
    .replace(/<!--\s*step:\d+\s*-->/g, '')
}

export class GenParser {
  private buf = ''
  private planEmitted = false
  private plan: string[] = []
  private htmlStart = -1 // index in buf of first char after <html_app>
  private htmlEnd = -1 // index in buf of </html_app>, if seen
  private scanFrom = 0 // offset within html content for step-marker scanning
  private lastStep = -1
  private searchedFrom = 0

  /** Characters of HTML received so far (raw, excluding tags). */
  get htmlChars(): number {
    if (this.htmlStart === -1) return 0
    const end = this.htmlEnd !== -1 ? this.htmlEnd : this.buf.length
    return Math.max(0, end - this.htmlStart)
  }

  get opened(): boolean {
    return this.htmlStart !== -1
  }

  feed(chunk: string): ParserEvent[] {
    const events: ParserEvent[] = []
    if (!chunk) return events
    const prevLen = this.buf.length
    this.buf += chunk

    // Locate <html_app> (search a little before the new text for split tags).
    if (this.htmlStart === -1) {
      const from = Math.max(0, Math.min(this.searchedFrom, prevLen) - HTML_OPEN.length)
      const i = this.buf.indexOf(HTML_OPEN, from)
      if (i !== -1) this.htmlStart = i + HTML_OPEN.length
      else this.searchedFrom = this.buf.length
    }

    // Plan: emit once, when </plan> arrives, or when html starts without a closed plan.
    if (!this.planEmitted) {
      const limit = this.htmlStart !== -1 ? this.htmlStart - HTML_OPEN.length : this.buf.length
      const head = this.buf.slice(0, limit)
      const open = head.indexOf(PLAN_OPEN)
      const close = open !== -1 ? head.indexOf(PLAN_CLOSE, open + PLAN_OPEN.length) : -1
      if (open !== -1 && close !== -1) {
        this.emitPlan(parsePlanItems(head.slice(open + PLAN_OPEN.length, close)), events)
      } else if (this.htmlStart !== -1) {
        // html began without a complete plan
        this.emitPlan(
          open !== -1 ? parsePlanItems(head.slice(open + PLAN_OPEN.length)) : [],
          events
        )
      }
    }

    if (this.htmlStart !== -1) {
      if (this.htmlEnd === -1) {
        const from = Math.max(this.htmlStart, prevLen - HTML_CLOSE.length)
        const c = this.buf.indexOf(HTML_CLOSE, from)
        if (c !== -1) this.htmlEnd = c
      }
      const end = this.htmlEnd !== -1 ? this.htmlEnd : this.buf.length
      const content = this.buf.slice(this.htmlStart, end)
      STEP_RE.lastIndex = this.scanFrom
      let m: RegExpExecArray | null
      while ((m = STEP_RE.exec(content)) !== null) {
        const idx = Number(m[1]) - 1
        if (idx > this.lastStep && idx >= 0) {
          this.lastStep = idx
          events.push({ type: 'step', index: idx })
        }
      }
      // Re-scan the tail next time in case a marker is split across chunks.
      this.scanFrom = Math.max(this.scanFrom, content.length - 40)
    }
    return events
  }

  private emitPlan(items: string[], events: ParserEvent[]): void {
    this.planEmitted = true
    this.plan = items
    events.push({ type: 'plan', items })
  }

  /** Final validation. Call once the stream has ended. */
  finish(finishReason: string | null): ParseResult {
    if (this.htmlStart === -1) {
      if (finishReason === 'length') {
        return {
          ok: false,
          message:
            'This app came out too big to finish in one go. Try asking for something smaller, or build it up in steps.'
        }
      }
      return { ok: false, message: "The AI didn't send back an app this time. Please try again." }
    }
    // Models sometimes go straight from </html> to <next> and forget </html_app>. The app is
    // complete, so take it up to its own </html> instead of failing the build.
    let closeLen = HTML_CLOSE.length
    if (this.htmlEnd === -1 && finishReason !== 'length') {
      const m = /<\/html\s*>/gi
      m.lastIndex = this.htmlStart
      let last: RegExpExecArray | null = null
      for (let x = m.exec(this.buf); x; x = m.exec(this.buf)) last = x
      if (last) {
        this.htmlEnd = last.index + last[0].length
        closeLen = 0
      }
    }
    if (this.htmlEnd === -1) {
      return {
        ok: false,
        message:
          finishReason === 'length'
            ? 'This app came out too big to finish in one go. Try asking for something smaller, or build it up in steps.'
            : 'The AI stopped before the app was finished. Please try again.'
      }
    }
    const raw = this.buf.slice(this.htmlStart, this.htmlEnd)
    const html = removeStepMarkers(stripFences(raw)).trim()
    if (html.length < MIN_HTML_CHARS || !/<[a-zA-Z!][^>]*>/.test(html)) {
      return { ok: false, message: 'The AI sent back an app that was empty. Please try again.' }
    }
    const tail = this.buf.slice(this.htmlEnd + closeLen)
    const no = tail.indexOf(NEXT_OPEN)
    const nc = no !== -1 ? tail.indexOf(NEXT_CLOSE, no + NEXT_OPEN.length) : -1
    const next =
      no === -1
        ? []
        : parsePlanItems(tail.slice(no + NEXT_OPEN.length, nc === -1 ? undefined : nc))
            .map((s) => s.slice(0, 80))
            .slice(0, 3)
    return { ok: true, html, plan: this.plan, next }
  }
}
