<script lang="ts">
  import AppIcon from '../components/AppIcon.svelte'
  import Icon from '../components/Icon.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { relativeTime } from '../lib/time'

  let emptying = $state(false)

  async function emptyAll(): Promise<void> {
    emptying = true
    try {
      await library.emptyTrash()
    } finally {
      emptying = false
    }
  }
</script>

<div class="scroll">
  <div class="page">
    <div class="row head">
      <p class="muted grow">
        Deleted apps are kept here with all their versions. Restore puts them back in the library.
      </p>
      {#if library.trash.length > 0}
        <button
          class="btn btn-sm btn-danger"
          class:is-loading={emptying}
          disabled={emptying}
          onclick={emptyAll}><Icon name="trash" size={14} /><span>Empty trash</span></button
        >
      {/if}
    </div>

    {#if library.trash.length === 0}
      <div class="empty">
        <span class="bracket"><Icon name="trash" size={18} /></span>
        <div class="medium">Trash is empty</div>
      </div>
    {:else}
      <ul class="list">
        {#each library.trash as t (t.id)}
          <li class="list-item">
            <AppIcon icon={t.icon} />
            <span class="grow truncate medium">{t.name}</span>
            <span class="small faint">Deleted {relativeTime(t.trashedAt)}</span>
            <button class="btn btn-sm" onclick={() => library.restore(t.id)}
              ><Icon name="restore" size={14} />Restore</button
            >
            <button
              class="btn btn-icon btn-sm btn-ghost btn-danger"
              title="Delete forever"
              aria-label="Delete {t.name} forever"
              onclick={() => library.deleteForever(t.id)}><Icon name="trash" size={14} /></button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    width: 100%;
    overflow: auto;
  }
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px 24px 48px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .list-item {
    min-height: 48px;
  }
  .head {
    align-items: flex-start;
    gap: 16px;
  }
  .head p {
    margin: 0;
  }
</style>
