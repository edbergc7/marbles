<script lang="ts">
  import { chatgpt, USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { formatCost, PRICEY_CHANGE_USD } from '../lib/cost'

  /** The drawer composer's status line: what to fix to connect, or the plan, cost or key hints. */
  let {
    model,
    advanced,
    spent
  }: {
    model: string
    advanced: boolean
    /** Total cost of the app so far, and of its latest build; null when nothing is costed yet. */
    spent: { total: number; last: number } | null
  } = $props()
</script>

{#if !chatgpt.usable && key.state.phase === 'missing'}
  <button class="btn btn-ghost btn-sm" onclick={() => (ui.getStartedOpen = true)}
    >Connect an AI model to make changes</button
  >
{:else if !chatgpt.usable && key.state.phase === 'rejected'}
  <button class="btn btn-ghost btn-sm" onclick={() => (ui.view = 'settings')}
    >Your API key isn't working. Open settings</button
  >
{:else if model.startsWith('chatgpt:')}
  <span class="tiny faint hint-keys"
    >Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a
    ></span
  >
{:else if spent && (advanced || spent.last >= PRICEY_CHANGE_USD)}
  <span
    class="tiny hint-keys"
    class:faint={spent.last < PRICEY_CHANGE_USD}
    class:pricey={spent.last >= PRICEY_CHANGE_USD}
    title="Each change rewrites the whole app, so bigger apps cost more per change."
    >{spent.last >= PRICEY_CHANGE_USD
      ? `Changes cost about ${formatCost(spent.last)} each`
      : `Last change ${formatCost(spent.last)}`} · {formatCost(spent.total)} so far</span
  >
{:else}
  <span class="tiny faint hint-keys">Enter to send · Shift+Enter for a new line</span>
{/if}

<style>
  .hint-keys {
    padding-left: 8px;
  }
  .pricey {
    color: var(--text-2);
  }
</style>
