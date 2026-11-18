<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { chatgpt } from '../lib/stores/chatgpt.svelte'
  import { chat } from '../lib/stores/chat.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { pairTurns } from '../lib/chatTurns'
  import { AttachTray } from '../lib/attachments.svelte'
  import AttachButton from './AttachButton.svelte'
  import AppFiles from './AppFiles.svelte'
  import ChatLog from './ChatLog.svelte'
  import ComposerBox from './ComposerBox.svelte'
  import ComposerHint from './ComposerHint.svelte'
  import ModelPicker from './ModelPicker.svelte'

  const app = $derived(library.selected)
  const open = $derived(ui.drawerOpen && ui.view === 'app')
  const job = $derived(gen.editFor(app?.id))
  const running = $derived(!!job && (job.phase === 'starting' || job.phase === 'running'))
  const hasKey = $derived(key.usable || chatgpt.usable)
  const latest = $derived(app ? Math.max(0, ...app.versions.map((v) => v.n)) : 0)
  const shown = $derived(app?.currentVersion ?? 0)
  const branching = $derived(!!app && shown > 0 && shown < latest)
  const override = $derived(app ? (gen.modelFor[app.id] ?? '') : '')
  const model = $derived(override.trim() || settings.value?.builderModel || '')
  const advanced = $derived(settings.value?.showAdvanced ?? false)
  /** What this app has cost so far, and the cost of its latest build (the best guess for the next). */
  const spent = $derived.by(() => {
    const costed = (app?.versions ?? []).filter((v) => typeof v.cost === 'number')
    if (!costed.length) return null
    const total = costed.reduce((sum, v) => sum + (v.cost ?? 0), 0)
    const last = costed.reduce((a, b) => (b.n > a.n ? b : a)).cost ?? 0
    return { total, last }
  })

  let draft = $state('')
  /** Unsent drafts per app id, so switching apps keeps each half-typed change. */
  const drafts: Record<string, string> = {}
  let draftFor: string | null = null
  /** Attached files per app, kept like drafts when switching apps. */
  const trays: Record<string, AttachTray> = {}
  let tray = $state(new AttachTray())
  let inputEl = $state<HTMLTextAreaElement>()
  let listEl = $state<HTMLDivElement>()
  let resizing = $state(false)
  let dragStartX = 0
  let dragStartW = 0

  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizing = true
    dragStartX = e.clientX
    dragStartW = ui.drawerWidth
  }

  function moveResize(e: PointerEvent): void {
    if (!resizing) return
    // The drawer sits on the right, so dragging left makes it wider.
    ui.setDrawerWidth(dragStartW + (dragStartX - e.clientX))
  }

  function endResize(): void {
    if (!resizing) return
    resizing = false
    ui.saveDrawerWidth()
  }

  const turns = $derived(pairTurns(chat.messages))

  // Load the chat for whichever app is on screen.
  $effect(() => {
    void chat.load(app?.id ?? null)
  })

  // Swap the composer draft when the app on screen changes.
  $effect(() => {
    const id = app?.id ?? null
    if (id === draftFor) return
    if (draftFor) {
      const current = untrack(() => draft)
      if (current.trim()) drafts[draftFor] = current
      else delete drafts[draftFor]
    }
    draftFor = id
    draft = id ? (drafts[id] ?? '') : ''
    tray = id ? (trays[id] ??= new AttachTray()) : new AttachTray()
    if (untrack(() => open)) void tick().then(() => inputEl?.focus({ preventScroll: true }))
  })

  // Keep the newest content in view.
  $effect(() => {
    void turns.length
    void job?.plan?.length
    void job?.step
    void job?.phase
    void tick().then(() => listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' }))
  })

  // Focus the composer when the drawer opens.
  $effect(() => {
    if (open) void tick().then(() => inputEl?.focus({ preventScroll: true }))
  })

  function send(text = draft): void {
    if (!app || running || !hasKey) return
    const t = text.trim()
    const sendFiles = text === draft
    if ((!t && !(sendFiles && tray.items.length)) || tray.busy) return
    void gen.edit(app.id, t, shown || undefined, {
      attachments: sendFiles ? tray.take() : []
    })
    if (text === draft) {
      draft = ''
      if (app) delete drafts[app.id]
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  }

  function retry(): void {
    if (!job || !app) return
    const p = job.prompt
    const attachments = job.attachments
    gen.dismiss(job.jobId)
    void gen.edit(app.id, p, job.baseVersion, {
      effort: job.effort,
      fresh: job.fresh,
      attachments
    })
  }

  /**
   * Redo the last change, reasoning as hard as possible: from the same starting version, or
   * with no base (the first build, or a rebuild of it) from the prompt alone, as the next version.
   */
  function tryHarder(prompt: string, base: number | undefined): void {
    if (!app || running) return
    void gen.edit(app.id, prompt, base, { effort: 'high', fresh: !base })
  }

  function editAgain(): void {
    if (!job) return
    draft = job.prompt
    tray.restore(job.attachments)
    gen.dismiss(job.jobId)
    void tick().then(() => inputEl?.focus())
  }

  /** Put a suggested change in the composer so the user can tweak it before sending. */
  function useSuggestion(s: string): void {
    draft = s
    void tick().then(() => {
      inputEl?.focus()
      inputEl?.setSelectionRange(s.length, s.length)
    })
  }
</script>

<div
  class="drawer-slot"
  class:open
  class:resizing
  style:--drawer-w="{ui.drawerWidth}px"
  aria-hidden={!open}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="resizer"
    title="Drag to resize"
    onpointerdown={startResize}
    onpointermove={moveResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    ondblclick={() => {
      ui.setDrawerWidth(360)
      ui.saveDrawerWidth()
    }}
  ></div>
  <aside class="drawer">
    <div class="head">
      <h3 class="caps">Chat</h3>
      {#if advanced}<ModelPicker appId={app?.id} {model} />{/if}
      {#if app}<AppFiles appId={app.id} />{/if}
      <button
        class="btn btn-icon btn-ghost btn-sm"
        title="Close"
        onclick={() => (ui.drawerOpen = false)}><Icon name="x" size={14} /></button
      >
    </div>

    <ChatLog
      bind:el={listEl}
      appId={app?.id}
      appName={app?.name}
      {turns}
      {job}
      {shown}
      {latest}
      {advanced}
      {model}
      onsuggest={useSuggestion}
      ontryharder={tryHarder}
      oneditagain={editAgain}
      onretry={retry}
    />

    {#if branching && !running}
      <div class="branch">
        <Icon name="history" size={12} />
        <span>Showing v{shown}. Your next change builds on it as v{latest + 1}.</span>
      </div>
    {/if}

    <ComposerBox {tray}>
      <textarea
        bind:this={inputEl}
        bind:value={draft}
        onkeydown={onKey}
        onpaste={tray.onPaste}
        placeholder={running ? 'Working on your change…' : 'Describe a change…'}
        disabled={!app || !hasKey}
        rows="2"></textarea>
      <div class="row">
        {#if app && hasKey}<AttachButton {tray} />{/if}
        <ComposerHint {model} {advanced} {spent} />
        <div class="spacer"></div>
        {#if running && job}
          <button class="btn btn-sm btn-stop" title="Stop" onclick={() => gen.stop(job.jobId)}
            ><span class="stop-sq"></span>Stop</button
          >
        {:else}
          <button
            class="btn btn-primary btn-icon btn-sm"
            title="Send"
            disabled={(!draft.trim() && !tray.items.length) || tray.busy > 0 || !hasKey || !app}
            onclick={() => send()}><Icon name="send" size={14} /></button
          >
        {/if}
      </div>
    </ComposerBox>
  </aside>
</div>

<style>
  .drawer-slot {
    width: 0;
    position: relative;
    overflow: hidden;
    flex: none;
    transition:
      width var(--dur-slow) var(--ease),
      margin-left var(--dur-slow) var(--ease);
  }
  .drawer-slot.open {
    width: var(--drawer-w, 360px);
  }
  .drawer-slot.resizing {
    transition: none;
    user-select: none;
  }
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    z-index: 2;
    cursor: col-resize;
  }
  .resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    transition: background var(--dur-fast) var(--ease);
  }
  .resizer:hover::after,
  .drawer-slot.resizing .resizer::after {
    background: var(--accent);
  }
  .drawer {
    width: var(--drawer-w, 360px);
    height: 100%;
    background: var(--bg);
    border-left: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
  }

  /* ---- header ---- */
  .head {
    position: relative;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--hairline);
    flex: none;
  }
  .head h3 {
    flex: 1;
  }

  /* ---- composer ---- */
  .branch {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 16px 8px;
    color: var(--text-3);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .drawer > :global(.composer) {
    margin: 0 12px 12px;
  }
  textarea {
    font: inherit;
    line-height: 1.5;
    min-height: 52px;
    max-height: 200px;
    field-sizing: content;
  }
  textarea:disabled {
    cursor: not-allowed;
  }
  .stop-sq {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    background: currentColor;
  }
</style>
