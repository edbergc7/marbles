<script lang="ts">
  import Icon from '../Icon.svelte'
  import { library } from '../../lib/stores/library.svelte'
  import { ui } from '../../lib/stores/ui.svelte'
</script>

<div class="foot">
  <button
    class="nav-item"
    class:is-active={ui.view === 'trash'}
    onclick={() => (ui.view = 'trash')}
  >
    <Icon name="trash" size={15} />Trash
    {#if library.trash.length}<span class="foot-count">{library.trash.length}</span>{/if}
  </button>
  <button
    class="nav-item"
    class:is-active={ui.view === 'settings'}
    onclick={() => (ui.view = 'settings')}><Icon name="gear" size={15} />Settings</button
  >
</div>

<style>
  .foot {
    flex: none;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-top: 1px solid var(--hairline);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-2);
    font: 400 var(--text-md) / 1 var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition:
      background var(--dur) var(--ease),
      color var(--dur) var(--ease);
  }
  .nav-item:hover {
    background: var(--nav-hover);
    color: var(--text);
  }
  .nav-item.is-active {
    background: var(--nav-active);
    color: var(--text);
  }
  .foot-count {
    margin-left: auto;
    color: var(--accent);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
