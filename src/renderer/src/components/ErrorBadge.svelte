<script lang="ts">
  import Icon from './Icon.svelte'
  import { popOut } from '../lib/motion'
  import { frame, errorReport, shortSource } from '../lib/stores/frame.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { chatgpt } from '../lib/stores/chatgpt.svelte'

  let open = $state(false)
  const count = $derived(frame.errors.length)
  const app = $derived(library.selected)
  const busy = $derived(!!app && gen.isEditing(app.id))
  const canFix = $derived(!!app && !busy && (key.usable || chatgpt.usable))

  function fix(): void {
    if (!app || !canFix) return
    const n = frame.errors.length
    const prompt =
      `Fix these errors (${n} captured while running v${app.currentVersion}):

` + errorReport(frame.errors)
    open = false
    ui.view = 'app'
    ui.drawerOpen = true
    void gen.edit(app.id, prompt, app.currentVersion)
  }

  $effect(() => {
    if (count === 0) open = false
  })

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(errorReport(frame.errors))
    ui.showToast('Errors copied')
  }

  const KIND: Record<string, string> = {
    error: 'Error',
    unhandledrejection: 'Unhandled promise',
    resource: 'Failed to load',
    console: 'console.error'
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#if count > 0}
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim" onmousedown={() => (open = false)}></div>
    <div class="panel" role="dialog" aria-label="App errors" out:popOut|global>
      <div class="head">
        <Icon name="alert" size={16} />
        <strong class="grow">{count} {count === 1 ? 'error' : 'errors'}</strong>
        <button class="btn btn-ghost btn-sm" onclick={copy}
          ><Icon name="copy" size={14} />Copy</button
        >
        <button class="btn btn-ghost btn-sm" onclick={() => frame.clear()}>Clear</button>
      </div>
      <ol class="errs">
        {#each frame.errors as e, i (i)}
          <li>
            <div class="row" style="gap:6px">
              <span class="badge badge-danger">{KIND[e.kind] ?? e.kind}</span>
              {#if e.source}<span class="tiny faint mono truncate"
                  >{shortSource(e.source)}{e.line ? `:${e.line}` : ''}</span
                >{/if}
            </div>
            <div class="msg mono">{e.message}</div>
          </li>
        {/each}
      </ol>
      <div class="foot">
        <span class="tiny faint grow">The AI can read these and fix the app.</span>
        <button
          class="btn btn-primary btn-sm"
          disabled={!canFix}
          title={busy ? 'A change is already in progress' : 'Ask the AI to fix these errors'}
          onclick={fix}><Icon name="spark" size={14} />{busy ? 'Fixing…' : 'Fix'}</button
        >
      </div>
    </div>
  {/if}

  <button class="pill" class:is-open={open} onclick={() => (open = !open)} title="Show errors">
    <Icon name="alert" size={14} />
    <span>{count} {count === 1 ? 'error' : 'errors'}</span>
    <span class="dot">·</span>
    <span class="fix">Fix</span>
  </button>
{/if}

<style>
  .pill {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 20;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text-2);
    font: 500 var(--text-sm) / 1 var(--font-sans);
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    animation: rise var(--dur-slow) var(--spring);
  }
  .pill :global(svg) {
    color: var(--warning);
  }
  .pill:hover,
  .pill.is-open {
    background: var(--surface-2);
    color: var(--text);
  }
  .dot {
    color: var(--text-3);
  }
  .fix {
    color: var(--text);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 19;
  }
  .panel {
    position: absolute;
    right: 12px;
    bottom: 50px;
    z-index: 21;
    transform-origin: bottom right;
    width: min(440px, calc(100% - 24px));
    max-height: min(420px, calc(100% - 70px));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    animation: rise var(--dur-slow) var(--spring);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 10px 14px;
  }
  .head :global(svg) {
    color: var(--warning);
  }
  .errs {
    list-style: none;
    margin: 0;
    padding: 0 8px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .errs li {
    padding: 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 6px;
    user-select: text;
  }
  .msg {
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text);
    word-break: break-word;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 14px;
  }
</style>
