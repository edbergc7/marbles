<script lang="ts">
  import Icon from './Icon.svelte'
  import FileTile from './FileTile.svelte'
  import type { AttachTray } from '../lib/attachments.svelte'

  let { tray }: { tray: AttachTray } = $props()
</script>

{#if tray.items.length || tray.busy}
  <div class="attach-chips">
    {#each tray.items as a (a.id)}
      <div class="attach-chip" title={a.name}>
        {#if a.kind === 'image'}
          <img src={a.previewUrl} alt={a.name} />
        {:else}
          <FileTile name={a.name} truncated={a.truncated} />
        {/if}
        <button
          class="attach-x"
          title="Remove"
          aria-label={`Remove ${a.name}`}
          onclick={() => tray.remove(a.id)}><Icon name="x" size={10} /></button
        >
      </div>
    {/each}
    {#each Array.from({ length: tray.busy }, (_, k) => k) as i (i)}
      <div class="attach-chip loading" aria-label="Attaching…"></div>
    {/each}
  </div>
{/if}

<style>
  .attach-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 6px 0;
  }
  .attach-chip {
    position: relative;
    width: 52px;
    height: 52px;
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow: hidden;
    flex: none;
  }
  .attach-chip img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .attach-chip.loading {
    animation: attach-pulse 1.2s var(--ease) infinite alternate;
  }
  @keyframes attach-pulse {
    to {
      opacity: 0.5;
    }
  }
  .attach-x {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
    padding: 0;
    background: rgb(0 0 0 / 0.65);
    color: #fff;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .attach-chip:hover .attach-x,
  .attach-x:focus-visible {
    opacity: 1;
  }
</style>
