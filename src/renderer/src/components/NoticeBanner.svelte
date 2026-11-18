<script lang="ts">
  import Icon from './Icon.svelte'
  import { notices } from '../lib/stores/notices.svelte'

  const list = $derived(notices.state?.notices ?? [])
</script>

{#each list as n (n.id)}
  <div
    class="notice"
    class:warning={n.level === 'warning'}
    class:critical={n.level === 'critical'}
    role={n.level === 'info' ? 'status' : 'alert'}
  >
    <span class="ico"><Icon name={n.kind === 'update' ? 'download' : 'alert'} size={15} /></span>
    <div class="text">
      <span class="title">{n.title}</span>
      {#if n.body}<span class="body">{n.body}</span>{/if}
    </div>
    {#if n.linkLabel}
      <button class="btn btn-sm" onclick={() => notices.open(n.id)}>{n.linkLabel}</button>
    {/if}
    {#if n.dismissible}
      <button
        class="btn btn-sm btn-ghost btn-icon"
        aria-label="Dismiss"
        title="Dismiss"
        onclick={() => notices.dismiss(n.id)}><Icon name="x" size={14} /></button
      >
    {/if}
  </div>
{/each}

<style>
  .notice {
    --tone: var(--accent);
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--tone) 10%, var(--bg));
  }
  .notice.warning {
    --tone: var(--warning);
  }
  .notice.critical {
    --tone: var(--danger);
  }
  .ico {
    flex: none;
    display: grid;
    color: var(--tone);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 10px;
    row-gap: 2px;
    user-select: text;
  }
  .title {
    font-weight: 600;
  }
  .body {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .btn {
    flex: none;
  }
</style>
