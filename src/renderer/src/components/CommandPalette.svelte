<script lang="ts">
  /**
   * Command palette (Ctrl/Cmd+K): jump to an app or run an action from the keyboard.
   * Open state lives in ui.paletteOpen; the shortcut toggles it (see lib/shortcuts.ts).
   */
  import { tick } from 'svelte'
  import { fade } from 'svelte/transition'
  import AppIcon from './AppIcon.svelte'
  import Icon from './Icon.svelte'
  import type { IconName } from '../lib/icons'
  import { library } from '../lib/stores/library.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { exportApp } from '../lib/export'
  import { modKey } from '../lib/platform'
  import { popOut } from '../lib/motion'

  type Item = {
    key: string
    kind: 'app' | 'action'
    label: string
    /** Secondary text, e.g. the folder name. */
    note?: string
    icon?: IconName
    appIcon?: string
    /** Shortcut keys, drawn as separate keycaps. */
    keys?: string[]
    run: () => void
  }

  let query = $state('')
  let sel = $state(0)
  let inputEl = $state<HTMLInputElement>()
  let listEl = $state<HTMLDivElement>()
  let previous: HTMLElement | null = null
  let wasOpen = false

  const current = $derived(ui.view === 'app' ? library.selected : null)

  const actions = $derived.by((): Item[] => {
    const list: Item[] = [
      {
        key: 'a:new',
        kind: 'action',
        label: 'New app',
        icon: 'plus',
        keys: [modKey, 'N'],
        run: () => gen.openNew()
      },
      {
        key: 'a:settings',
        kind: 'action',
        label: 'Settings',
        icon: 'gear',
        keys: [modKey, ','],
        run: () => (ui.view = 'settings')
      },
      {
        key: 'a:trash',
        kind: 'action',
        label: 'Trash',
        icon: 'trash',
        run: () => (ui.view = 'trash')
      },
      {
        key: 'a:sidebar',
        kind: 'action',
        label: 'Toggle sidebar',
        icon: 'sidebar',
        keys: [modKey, 'B'],
        run: () => ui.toggleSidebar()
      }
    ]
    const app = current
    if (app) {
      list.push({
        key: 'a:chat',
        kind: 'action',
        label: 'Toggle chat',
        icon: 'chat',
        keys: [modKey, 'J'],
        run: () => ui.toggleDrawer()
      })
      if (app.currentVersion >= 1) {
        list.push({
          key: 'a:export',
          kind: 'action',
          label: 'Export HTML',
          note: app.name,
          icon: 'download',
          run: () => void exportApp(app)
        })
      }
      list.push({
        key: 'a:rename',
        kind: 'action',
        label: 'Rename',
        note: app.name,
        icon: 'edit',
        run: () => (ui.renameRequested = true)
      })
      list.push({
        key: 'a:duplicate',
        kind: 'action',
        label: 'Duplicate',
        note: app.name,
        icon: 'copy',
        run: () => void library.duplicate(app.id)
      })
      for (const v of [...app.versions].sort((a, b) => b.n - a.n)) {
        if (v.n === app.currentVersion) continue
        list.push({
          key: `a:v${v.n}`,
          kind: 'action',
          label: `Go to version v${v.n}`,
          note: app.name,
          icon: 'history',
          run: () => void library.setCurrent(app.id, v.n)
        })
      }
    }
    return list
  })

  const appItems = $derived.by((): Item[] =>
    library.apps.map((a) => ({
      key: `app:${a.id}`,
      kind: 'app',
      label: a.name,
      note: library.folderOf(a)?.name,
      appIcon: a.icon,
      run: () => library.select(a.id)
    }))
  )

  type Match = { s: number; hits: Set<number> }
  type Row = Item & { group: string; hits?: Set<number> }

  const range = (from: number, n: number): Set<number> =>
    new Set(Array.from({ length: n }, (_, i) => from + i))

  /** Lower score is better; null = no match. `hits` are the matched label indices. */
  function match(label: string, q: string): Match | null {
    const l = label.toLowerCase()
    if (l.startsWith(q)) return { s: 0, hits: range(0, q.length) }
    const at = l.indexOf(q)
    if (at > 0) return { s: /[\s\-_]/.test(l[at - 1]) ? 1 : 2, hits: range(at, q.length) }
    // Subsequence match ("cpal" -> "command palette").
    const hits: number[] = []
    for (let j = 0; j < l.length && hits.length < q.length; j++) {
      if (l[j] === q[hits.length]) hits.push(j)
    }
    return hits.length === q.length ? { s: 3, hits: new Set(hits) } : null
  }

  /** Split a label into runs so matched characters can be emphasised. */
  function segments(label: string, hits?: Set<number>): { t: string; hit: boolean }[] {
    if (!hits?.size) return [{ t: label, hit: false }]
    const out: { t: string; hit: boolean }[] = []
    for (let i = 0; i < label.length; i++) {
      const hit = hits.has(i)
      const last = out[out.length - 1]
      if (last && last.hit === hit) last.t += label[i]
      else out.push({ t: label[i], hit })
    }
    return out
  }

  const results = $derived.by((): Row[] => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const recent = [...library.apps]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6)
        .map((a) => ({ ...appItems.find((i) => i.key === `app:${a.id}`)!, group: 'Recent' }))
      return [...recent, ...actions.map((a) => ({ ...a, group: 'Actions' }))]
    }
    const rank = (items: Item[], group: string): { rows: Row[]; best: number } => {
      const scored: { row: Row; s: number }[] = []
      for (const item of items) {
        const m = match(item.label, q)
        if (m) scored.push({ row: { ...item, group, hits: m.hits }, s: m.s })
      }
      scored.sort((a, b) => a.s - b.s)
      return { rows: scored.map((x) => x.row), best: scored[0]?.s ?? Infinity }
    }
    // Groups stay together; the group with the better top match goes first (apps on ties).
    const apps = rank(appItems, 'Apps')
    const acts = rank(actions, 'Actions')
    return acts.best < apps.best ? [...acts.rows, ...apps.rows] : [...apps.rows, ...acts.rows]
  })

  // Reset and focus when it opens; restore focus when it is dismissed.
  $effect(() => {
    const open = ui.paletteOpen
    if (open && !wasOpen) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      query = ''
      sel = 0
      void tick().then(() => inputEl?.focus())
    }
    wasOpen = open
  })

  $effect(() => {
    void query
    sel = 0
  })

  function close(restore = true): void {
    ui.paletteOpen = false
    if (restore) {
      const el = previous
      void tick().then(() => el?.isConnected && el.focus())
    }
    previous = null
  }

  function choose(item: Item | undefined): void {
    if (!item) return
    close(false)
    item.run()
  }

  function scrollToSel(): void {
    listEl?.querySelector<HTMLElement>('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function onKey(e: KeyboardEvent): void {
    if (!ui.paletteOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = results.length
      if (!n) return
      sel = e.key === 'ArrowDown' ? (sel + 1) % n : (sel - 1 + n) % n
      void tick().then(scrollToSel)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[sel])
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 120 }} onmousedown={() => close()}></div>
  <div
    class="palette"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
    out:popOut|global
  >
    <div class="bar">
      <span class="search"><Icon name="search" size={16} /></span>
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[sel] ? `pal-${sel}` : undefined}
        placeholder="Search apps or type a command…"
        spellcheck="false"
        autocomplete="off"
      />
      {#if query}
        <button class="clear" type="button" onclick={() => ((query = ''), inputEl?.focus())}
          >Clear</button
        >
      {:else}
        <kbd>Esc</kbd>
      {/if}
    </div>
    <div class="results" id="palette-list" role="listbox" bind:this={listEl}>
      {#each results as item, i (item.key)}
        {#if i === 0 || results[i - 1].group !== item.group}
          <div class="group" class:first={i === 0} role="presentation">{item.group}</div>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="opt"
          id="pal-{i}"
          role="option"
          tabindex="-1"
          aria-selected={i === sel}
          data-sel={i === sel}
          class:sel={i === sel}
          onmousemove={() => (sel = i)}
          onclick={() => choose(item)}
        >
          <span class="ic">
            {#if item.appIcon}<AppIcon icon={item.appIcon} size={16} />{:else if item.icon}<Icon
                name={item.icon}
                size={15}
              />{/if}
          </span>
          <span class="lbl" class:searching={!!item.hits}
            >{#each segments(item.label, item.hits) as seg, j (j)}{#if seg.hit}<mark>{seg.t}</mark
                >{:else}{seg.t}{/if}{/each}</span
          >
          {#if item.note}<span class="note">{item.note}</span>{/if}
          {#if item.keys}
            <span class="keys"
              >{#each item.keys as k (k)}<kbd>{k}</kbd>{/each}</span
            >
          {/if}
        </div>
      {:else}
        <div class="none">No results for “{query.trim()}”</div>
      {/each}
    </div>
    <div class="foot" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.32);
  }
  .palette {
    position: fixed;
    z-index: 61;
    top: 14vh;
    left: 50%;
    translate: -50% 0;
    width: min(600px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    background: var(--pop-bg, var(--surface));
    border-radius: 10px;
    box-shadow:
      var(--shadow-pop),
      0 24px 60px -20px rgb(0 0 0 / 0.35);
    overflow: hidden;
    transform-origin: 50% 0;
    animation: pop var(--dur-slow) var(--spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97) translateY(-6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .palette {
      animation: none;
    }
  }

  /* Search field */
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 52px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--hairline);
  }
  .search {
    display: grid;
    color: var(--text-3);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--text);
    font: 400 15px / 1 var(--font-sans);
    text-align: left;
    outline: none;
  }
  input::placeholder {
    color: var(--text-3);
  }
  .clear {
    padding: 4px 6px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text-3);
    font: 400 var(--text-md) / 1 var(--font-sans);
    cursor: pointer;
  }
  .clear:hover {
    color: var(--text);
    background: var(--nav-hover);
  }

  /* Results */
  .results {
    max-height: min(400px, 56vh);
    overflow: auto;
    padding: 6px;
    scroll-padding: 6px;
  }
  .group {
    padding: 14px 10px 6px;
    color: var(--text-3);
    font: 500 var(--text-sm) / 1 var(--font-sans);
  }
  .group.first {
    padding-top: 8px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 36px;
    padding: 0 10px;
    border-radius: 6px;
    color: var(--text);
    font: 400 var(--text-lg) / 1 var(--font-sans);
    cursor: pointer;
  }
  .opt.sel {
    background: var(--nav-active);
  }
  .ic {
    flex: none;
    width: 18px;
    display: grid;
    place-items: center;
    color: var(--text-3);
  }
  .opt.sel .ic {
    color: var(--text-2);
  }
  .lbl {
    flex: none;
    max-width: 60%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* While searching, unmatched letters recede and the match stays full strength. */
  .lbl.searching {
    color: var(--text-2);
  }
  mark {
    background: none;
    color: var(--text);
    font-weight: 600;
  }
  .note {
    flex: 1;
    min-width: 0;
    color: var(--text-3);
    font-size: var(--text-md);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note::before {
    content: '·';
    margin-right: 8px;
  }
  .lbl:not(:has(+ .note)) {
    flex: 1;
  }
  .keys {
    display: flex;
    gap: 3px;
    margin-left: auto;
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 5px;
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text-2);
    font: 500 var(--text-sm) / 1 var(--font-sans);
    white-space: nowrap;
  }
  .none {
    padding: 28px 10px;
    text-align: center;
    color: var(--text-3);
    font-size: var(--text-lg);
  }

  /* Hint bar */
  .foot {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 40px;
    padding: 0 16px;
    border-top: 1px solid var(--hairline);
    color: var(--text-3);
    font: 400 var(--text-md) / 1 var(--font-sans);
  }
  .foot span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .foot kbd {
    margin-right: 3px;
  }
</style>
