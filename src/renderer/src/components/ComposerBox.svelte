<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { AttachTray } from '../lib/attachments.svelte'
  import AttachChips from './AttachChips.svelte'

  /**
   * The rounded message box shared by the drawer and the New App view: a drop target for
   * files, the attached-file chips, then whatever the caller puts inside (textarea and row).
   * Callers size and place it, and set the textarea's font, with their own `:global(.composer)` rules.
   */
  let { tray, children }: { tray: AttachTray; children: Snippet } = $props()
</script>

<div
  class="composer"
  class:is-over={tray.over}
  role="group"
  ondragover={tray.onDragOver}
  ondragleave={tray.onDragLeave}
  ondrop={tray.onDrop}
>
  <AttachChips {tray} />
  {@render children()}
</div>

<style>
  .composer {
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--composer-ring);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: box-shadow var(--dur) var(--ease);
  }
  .composer:focus-within,
  .composer.is-over {
    box-shadow: var(--composer-ring-focus);
  }
  .composer :global(textarea),
  .composer :global(textarea:focus-visible) {
    box-shadow: none;
  }
  .composer :global(textarea) {
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--text);
    padding: 8px;
  }
  .composer :global(textarea::placeholder) {
    color: var(--text-3);
  }
</style>
