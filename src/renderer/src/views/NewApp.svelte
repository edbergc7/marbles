<script lang="ts">
  import AppIcon from '../components/AppIcon.svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import MarbleBackground from '../components/MarbleBackground.svelte'
  import PlanChecklist from '../components/PlanChecklist.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { chatgpt, USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { relativeTime, shortModel } from '../lib/time'
  import { fadeAfterBuild } from '../lib/motion'
  import { needsSettings } from '../lib/errors'
  import { AttachTray } from '../lib/attachments.svelte'
  import AttachButton from '../components/AttachButton.svelte'
  import ComposerBox from '../components/ComposerBox.svelte'

  // Everyday work and school helpers: the kind of thing Marbles is for.
  const EXAMPLES = [
    { label: 'Citation maker', prompt: "Turn a book or website's details into an APA 7 citation" },
    {
      label: 'Grade I need',
      prompt: 'Work out what I need on the final to get the grade I want, with weighted categories'
    },
    { label: 'Flashcards', prompt: 'Paste a vocab list and quiz me with flashcards' },
    {
      label: 'Polish an email',
      prompt: 'Paste a rough email and rewrite it to sound clear and professional'
    },
    {
      label: 'Clean up a CSV',
      prompt: 'Drop a CSV, remove duplicate rows and empty columns, and download the cleaned file'
    }
  ]

  let prompt = $state('')
  let el = $state<HTMLTextAreaElement>()
  let now = $state(Date.now())
  const tray = new AttachTray()
  // Files left in the box when leaving the view are dropped (sent ones belong to their build).
  onDestroy(() => tray.clear())

  const job = $derived(gen.activeCreate)
  const hasKey = $derived(key.usable || chatgpt.usable)
  const usingPlan = $derived(
    chatgpt.usable && (settings.value?.builderModel ?? '').startsWith('chatgpt:')
  )
  // With nothing connected, Make still works: it opens the Get started pop-up and keeps the prompt.
  const canBuild = $derived((prompt.trim().length > 0 || tray.items.length > 0) && !tray.busy)
  const elapsed = $derived(job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0)
  const recent = $derived(
    [...library.apps].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4)
  )

  onMount(() => {
    el?.focus()
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  function useExample(p: string): void {
    prompt = p
    el?.focus()
  }

  function build(): void {
    if (!canBuild) return
    if (!hasKey) {
      ui.getStartedOpen = true
      return
    }
    void gen.create(prompt, { attachments: tray.take() })
  }

  async function editPrompt(): Promise<void> {
    if (job) {
      prompt = job.prompt
      tray.restore(job.attachments)
    }
    gen.dismissCreate()
    await tick()
    el?.focus()
  }

  function retry(): void {
    if (!job) return
    const p = job.prompt
    const attachments = job.attachments
    gen.dismissCreate()
    void gen.create(p, { attachments })
  }

  /** Build despite the scope check, or build the suggested smaller tool. */
  function buildScoped(p: string): void {
    const attachments = job?.attachments ?? []
    gen.dismissCreate()
    void gen.create(p, { skipScope: true, attachments })
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      build()
    }
  }

  function fmtTime(s: number): string {
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  }
</script>

<MarbleBackground active={!!job && (job.phase === 'starting' || job.phase === 'running')} />

{#if job?.phase === 'scoped' && job.scope}
  {@const sc = job.scope}
  {@const original = job.prompt}
  <div class="hero" out:fadeAfterBuild|global>
    <div class="building">
      <div class="scope-head">
        <div class="medium">
          {sc.scope === 'no' ? "Marbles can't make this one" : 'This is a big one'}
        </div>
        <p class="hint">
          {sc.reason}
          {#if sc.scope === 'no'}
            It makes small helpers that run on this computer, just for you.
          {:else}
            Marbles works best on small tools that do one job. A big app tends to come out
            half-finished, and every change rewrites all of it, so changes cost more.
          {/if}
        </p>
      </div>
      <p class="prompt hint">“{job.prompt}”</p>
      {#if sc.smaller}
        <div class="suggestion">
          <div class="label">Try this instead</div>
          <div>{sc.smaller}</div>
        </div>
      {/if}
      <div class="row">
        <button class="btn btn-ghost" onclick={editPrompt}>Edit my request</button>
        <div class="spacer"></div>
        <button class="btn {sc.smaller ? 'btn-ghost' : ''}" onclick={() => buildScoped(original)}
          >{sc.scope === 'no' ? 'Try anyway' : 'Make it anyway'}</button
        >
        {#if sc.smaller}
          <button class="btn btn-primary" onclick={() => buildScoped(sc.smaller)}
            ><Icon name="spark" size={14} />Make this instead</button
          >
        {/if}
      </div>
    </div>
  </div>
{:else if job}
  <div class="hero" out:fadeAfterBuild|global>
    <div class="building">
      <div class="who">
        <AppIcon icon={job.icon ?? null} size={40} pending={!job.icon} />
        <div class="grow" style="min-width:0">
          <div class="medium truncate">{job.name ?? 'Naming…'}</div>
          <div class="small faint truncate">
            {#if job.phase === 'failed'}
              Stopped
            {:else if settings.value?.showAdvanced}
              Making with {shortModel(job.model || settings.value?.builderModel || '')}
            {:else}
              Making your app…
            {/if}
            · {fmtTime(elapsed)}
          </div>
        </div>
        {#if job.phase === 'starting' || job.phase === 'running'}
          <button class="btn btn-ghost btn-sm btn-stop" onclick={() => gen.stop(job.jobId)}
            >Stop</button
          >
        {/if}
      </div>

      {#if job.phase === 'failed' && job.error}
        <div class="callout {job.error.code === 'aborted' ? '' : 'callout-danger'}">
          {job.error.code === 'aborted' ? 'Stopped. Nothing was saved.' : job.error.message}
        </div>
        {#if settings.value?.showAdvanced && job.error.detail}<p class="tiny faint mono detail">
            {job.error.detail}
          </p>{/if}
        <div class="row">
          <button class="btn btn-ghost" onclick={editPrompt}>Edit prompt</button>
          <div class="spacer"></div>
          {#if job.error.code === 'plan_limit'}
            <a class="btn btn-primary" href={USAGE_URL} target="_blank" rel="noreferrer"
              >Manage usage</a
            >
          {:else if needsSettings(job.error.code)}
            <button
              class="btn btn-primary"
              onclick={() => {
                ui.view = 'settings'
                gen.dismissCreate()
              }}>Open settings</button
            >
          {:else}
            <button class="btn btn-primary" onclick={retry}
              ><Icon name="restore" size={14} />Try again</button
            >
          {/if}
        </div>
      {:else}
        <PlanChecklist
          plan={job.plan}
          step={job.step}
          thinking={job.thinking}
          thought={job.thought}
          looking={job.looking}
        />
      {/if}
    </div>
  </div>
{:else}
  <div class="hero" out:fadeAfterBuild|global>
    <div class="box">
      <div class="intro">
        <h1 class="title">What do you need a hand with?</h1>
        <p class="hint">
          Small helpers for work and school. They run on this computer, just for you.
        </p>
      </div>
      <ComposerBox {tray}>
        <textarea
          bind:this={el}
          bind:value={prompt}
          onkeydown={onKey}
          onpaste={tray.onPaste}
          placeholder="Split a bill between friends, with tip and who had what…"
          rows="3"></textarea>
        <div class="row">
          <AttachButton {tray} />
          {#if settings.value?.showAdvanced}
            <span class="badge">{shortModel(settings.value?.builderModel ?? '')}</span>
          {/if}
          {#if usingPlan}
            <span class="tiny faint"
              >Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer"
                >Manage usage</a
              ></span
            >
          {/if}
          <div class="spacer"></div>
          <span class="tiny faint">Enter to make · Shift+Enter for a new line</span>
          <button class="btn btn-primary btn-sm" disabled={!canBuild} onclick={build}
            ><Icon name="spark" size={14} />Make</button
          >
        </div>
      </ComposerBox>
      {#if !chatgpt.usable && key.state.phase === 'rejected'}
        <div class="callout row" style="text-align:left">
          <span class="grow">Your OpenRouter API key isn't working.</span>
          <button class="btn btn-sm" onclick={() => (ui.view = 'settings')}>Open settings</button>
        </div>
      {/if}
      <div class="chips">
        {#each EXAMPLES as ex (ex.label)}
          <button class="chip" onclick={() => useExample(ex.prompt)}>{ex.label}</button>
        {/each}
      </div>
      {#if recent.length}
        <div class="recent">
          <div class="recent-label">Recent</div>
          {#each recent as app (app.id)}
            <button class="recent-row" onclick={() => library.select(app.id)}>
              <AppIcon icon={app.icon} />
              <span class="recent-name truncate">{app.name}</span>
              <span class="tiny faint">{relativeTime(app.updatedAt)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .detail {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .hero {
    position: relative;
    z-index: 1;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 32px;
    overflow: auto;
  }
  .box {
    width: min(600px, 100%);
    display: flex;
    flex-direction: column;
    gap: 20px;
    text-align: center;
    margin-top: -6vh;
  }
  .building {
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: -6vh;
    animation: in 240ms var(--ease);
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  /* the header sits on the gradient, so give it a card like the checklist below */
  .who {
    padding: 12px 16px;
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--card-ring);
  }
  /* equal-width digits so the ticking timer doesn't shift the layout */
  .who :global(.faint) {
    font-variant-numeric: tabular-nums;
  }
  .who :global(.btn-ghost) {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .who :global(.btn-ghost:hover) {
    color: var(--text);
  }
  .scope-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: center;
  }
  .suggestion {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3);
    border-radius: var(--radius);
    background: var(--surface-2);
    font-size: var(--text-md);
    line-height: 1.5;
  }
  .prompt {
    text-align: center;
    padding: 0 16px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .intro {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-size: 24px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.022em;
    color: var(--text);
    text-wrap: balance;
  }
  .intro .hint {
    max-width: 60ch;
    font-size: var(--text-lg);
    line-height: 1.5;
    letter-spacing: -0.003em;
    color: var(--text-2);
    text-wrap: pretty;
  }
  .box > :global(.composer) {
    text-align: left;
  }
  textarea {
    font: 400 var(--text-md) / 1.55 var(--font-sans);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .chip {
    height: 26px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 0;
    background: var(--btn);
    color: var(--text-2);
    font: 500 var(--text-xs) / 1 var(--font-sans);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    cursor: pointer;
    transition:
      background var(--dur) var(--ease),
      color var(--dur) var(--ease);
  }
  .chip:hover {
    color: var(--text);
    background: var(--btn-hover);
  }
  .recent {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin-top: 12px;
    text-align: left;
    border-top: 1px solid var(--hairline);
    /* The marble background rises behind this list; keep the rows readable. */
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    border-radius: 0 0 var(--radius) var(--radius);
  }
  .recent-label {
    padding: 14px 10px 6px;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
  }
  .recent-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border: 0;
    border-bottom: 1px solid var(--hairline);
    border-radius: 0;
    background: transparent;
    color: var(--text-2);
    font: 400 var(--text-md) / 1 var(--font-sans);
    text-align: left;
    cursor: pointer;
  }
  .recent-row:hover {
    background: var(--nav-hover);
    color: var(--text);
  }
  .recent-name {
    flex: 1;
    min-width: 0;
  }
</style>
