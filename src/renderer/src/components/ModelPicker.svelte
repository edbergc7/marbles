<script lang="ts">
  import Icon from './Icon.svelte'
  import HeadPopover from './HeadPopover.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { shortModel } from '../lib/time'

  /**
   * The drawer header's model chip and its pop-over: pick the model for changes to one app.
   * Renders into the header's flex row, so it needs a `position: relative` parent.
   */
  let { appId, model }: { appId: string | undefined; model: string } = $props()

  const override = $derived(appId ? (gen.modelFor[appId] ?? '') : '')

  let open = $state(false)
  let draft = $state('')

  function toggle(): void {
    draft = override || settings.value?.builderModel || ''
    open = !open
  }

  function save(v: string): void {
    if (!appId) return
    const id = v.trim()
    if (!id || id === settings.value?.builderModel) delete gen.modelFor[appId]
    else gen.modelFor[appId] = id
    open = false
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

<button class="model" class:custom={!!override} title="Model for the next change" onclick={toggle}
  >{shortModel(model)}<Icon name="chevronDown" size={12} /></button
>
{#if open}
  <HeadPopover onclose={() => (open = false)}>
    <span class="label">Model for changes to this app</span>
    <input
      class="input mono"
      list="drawer-model-ids"
      bind:value={draft}
      spellcheck="false"
      onkeydown={(e) => e.key === 'Enter' && save(draft)}
    />
    <datalist id="drawer-model-ids">
      {#each gen.models as m (m.id)}<option value={m.id}
          >{m.id.startsWith('chatgpt:') ? `${m.name} · ChatGPT plan` : m.name}</option
        >{/each}
    </datalist>
    <div class="row">
      <button class="btn btn-ghost btn-sm" onclick={() => save('')}>Use default</button>
      <div class="spacer"></div>
      <button class="btn btn-primary btn-sm" onclick={() => save(draft)}>Apply</button>
    </div>
    <span class="tiny faint">Until you restart. The default is set in Settings.</span>
  </HeadPopover>
{/if}

<style>
  .model {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 22px;
    padding: 0 4px 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    font: 500 var(--text-xs) / 1 var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .model :global(svg) {
    opacity: 0.6;
    transition: opacity var(--dur-fast) var(--ease);
  }
  .model:hover {
    color: var(--text);
  }
  .model:hover :global(svg) {
    opacity: 1;
  }
  .model.custom {
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--text);
  }
</style>
