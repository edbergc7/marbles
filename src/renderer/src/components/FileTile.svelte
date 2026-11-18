<script lang="ts">
  import Icon from './Icon.svelte'
  import { fileLabel } from '../lib/attachments.svelte'

  /** A document's square: icon, type and a warning dot when only part of it is sent. */
  let { name, truncated = false }: { name: string; truncated?: boolean } = $props()
</script>

<div class="file-tile" title={truncated ? `${name} (only the beginning is sent)` : name}>
  <Icon name="file" size={18} />
  <span class="file-ext">{fileLabel(name)}</span>
  {#if truncated}<span class="file-cut" aria-label="Only the beginning is sent"></span>{/if}
</div>

<style>
  .file-tile {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--text-2);
    background: var(--surface-2);
  }
  .file-ext {
    font: 600 9px / 1 var(--font-mono);
    letter-spacing: 0.04em;
    color: var(--text-3);
  }
  .file-cut {
    position: absolute;
    left: 5px;
    bottom: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
