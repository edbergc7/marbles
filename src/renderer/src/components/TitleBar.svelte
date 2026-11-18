<script lang="ts">
  import Icon from './Icon.svelte'
  import Menu, { type MenuItem } from './Menu.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { isMac, modKey } from '../lib/platform'
  import { relativeTimeLong } from '../lib/time'
  import { tick } from 'svelte'

  const app = $derived(ui.view === 'app' ? library.selected : null)
  const nb = $derived(app ? library.neighbours(app) : { prev: null, next: null })

  const viewTitle: Record<string, string> = {
    new: 'New app',
    trash: 'Trash',
    settings: 'Settings'
  }

  let versionsMenu = $state<{ x: number; y: number } | null>(null)

  const latest = $derived(app ? Math.max(0, ...app.versions.map((v) => v.n)) : 0)

  function versionItems(): MenuItem[] {
    if (!app) return []
    return [...app.versions]
      .sort((a, b) => b.n - a.n)
      .map((v) => ({
        label: `v${v.n}`,
        hint: relativeTimeLong(v.createdAt),
        checked: v.n === app.currentVersion,
        onSelect: () => library.setCurrent(app.id, v.n)
      }))
  }

  function openVersions(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    versionsMenu = { x: r.left, y: r.bottom + 6 }
  }

  // ---------- inline rename (double-click the app name) ----------

  let editing = $state<{ id: string } | null>(null)
  let draft = $state('')
  let editWidth = $state(0)
  let renameEl = $state<HTMLInputElement>()

  let titleEl = $state<HTMLElement>()

  async function startRename(): Promise<void> {
    if (!app) return
    editWidth = titleEl?.offsetWidth ?? 0
    draft = app.name
    editing = { id: app.id }
    await tick()
    renameEl?.focus()
    renameEl?.select()
  }

  // The command palette's Rename action.
  $effect(() => {
    if (!ui.renameRequested) return
    ui.renameRequested = false
    if (app && !editing) void startRename()
  })

  // Clearing `editing` first means the blur that follows removal is a no-op.
  function cancelRename(): void {
    editing = null
  }

  async function commitRename(): Promise<void> {
    const e = editing
    if (!e) return
    editing = null
    const name = draft.trim()
    const current = library.apps.find((a) => a.id === e.id)
    if (!name || !current || name === current.name) return
    try {
      await library.rename(e.id, name)
    } catch (err) {
      ui.showToast(`Couldn't rename app: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
</script>

<header class="bar" class:mac={isMac} class:side-closed={!ui.sidebarOpen}>
  <div class="lead">
    <button
      class="btn btn-icon btn-ghost btn-sm"
      title="Toggle sidebar ({modKey}+B)"
      aria-label="Toggle sidebar"
      onclick={() => ui.toggleSidebar()}><Icon name="sidebar" size={15} /></button
    >
    <span class="sep"></span>
  </div>
  {#if app}
    {#if editing}
      <input
        class="title-input"
        bind:this={renameEl}
        bind:value={draft}
        style:width="{editWidth}px"
        aria-label="App name"
        onkeydown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commitRename()
          }
          if (e.key === 'Escape') cancelRename()
        }}
        onblur={() => void commitRename()}
      />
    {:else}
      <span
        class="title"
        bind:this={titleEl}
        title="Double-click to rename"
        ondblclick={startRename}
        role="button"
        tabindex="-1">{app.name}</span
      >
    {/if}
    {#if app.currentVersion > 0}
      {@const multi = latest > 1}
      <div class="vgroup">
        {#if multi}
          <button
            class="vnav"
            title="Previous version ({modKey}+Z)"
            aria-label="Previous version"
            disabled={nb.prev === null}
            onclick={() => nb.prev !== null && library.setCurrent(app.id, nb.prev)}
            ><Icon name="chevronLeft" size={12} /></button
          >
        {/if}
        <button class="vbadge" title="Version history" onclick={openVersions}>
          {multi ? `v${app.currentVersion} / ${latest}` : `v${app.currentVersion}`}<Icon
            name="chevronDown"
            size={12}
          />
        </button>
        {#if multi}
          <button
            class="vnav"
            title="Next version ({modKey}+Shift+Z)"
            aria-label="Next version"
            disabled={nb.next === null}
            onclick={() => nb.next !== null && library.setCurrent(app.id, nb.next)}
            ><Icon name="chevronRight" size={12} /></button
          >
        {/if}
      </div>
    {/if}
  {:else if ui.view !== 'app'}
    <span class="title">{viewTitle[ui.view]}</span>
  {/if}

  <div class="drag"></div>

  {#if app}
    <div class="actions">
      <button
        class="btn btn-sm"
        class:btn-ghost={!ui.drawerOpen}
        class:is-active={ui.drawerOpen}
        title="Toggle chat ({modKey}+J)"
        onclick={() => ui.toggleDrawer()}><Icon name="chat" size={14} />Chat</button
      >
    </div>
  {/if}
</header>

{#if versionsMenu}
  <Menu
    x={versionsMenu.x}
    y={versionsMenu.y}
    minWidth={180}
    items={versionItems()}
    onClose={() => (versionsMenu = null)}
  />
{/if}

<style>
  .bar {
    height: var(--bar-h);
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    /* Room for native window controls (Windows/Linux overlay on the right). */
    padding: 0 150px 0 10px;
    border-bottom: 1px solid var(--hairline);
    -webkit-app-region: drag;
    user-select: none;
  }
  .bar.mac {
    padding: 0 12px 0 10px;
    transition: padding-left var(--dur-slow) var(--ease);
  }
  /* With the sidebar shut, clear the macOS traffic lights. */
  .bar.mac.side-closed {
    padding-left: 84px;
  }
  .lead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--border-strong);
  }
  .bar :global(button),
  .bar .actions {
    -webkit-app-region: no-drag;
  }
  .drag {
    flex: 1;
    align-self: stretch;
  }
  .title {
    font-size: var(--text-md);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40vw;
    -webkit-app-region: no-drag;
  }
  .title-input {
    flex: none;
    min-width: 160px;
    max-width: 40vw;
    height: 24px;
    margin: 0 -6px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--field);
    color: var(--text);
    font: 500 var(--text-md) / 1 var(--font-sans);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    outline: none;
    box-shadow: var(--focus-ring);
    -webkit-app-region: no-drag;
  }
  .vgroup {
    display: inline-flex;
    align-items: center;
    height: 20px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    overflow: hidden;
    flex: none;
  }
  .vbadge,
  .vnav {
    display: inline-flex;
    align-items: center;
    height: 100%;
    border: 0;
    background: transparent;
    color: var(--accent-text);
    font: 500 var(--text-xs) / 1 var(--font-sans);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .vbadge {
    gap: 2px;
    padding: 0 4px 0 8px;
  }
  .vnav {
    justify-content: center;
    width: 20px;
    padding: 0;
  }
  .vbadge:hover,
  .vnav:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
  }
  .vnav:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>
