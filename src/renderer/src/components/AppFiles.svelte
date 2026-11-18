<script lang="ts">
  import Icon from './Icon.svelte'
  import FileTile from './FileTile.svelte'
  import HeadPopover from './HeadPopover.svelte'
  import { errorText } from '../lib/errors'
  import { ui } from '../lib/stores/ui.svelte'
  import { assetUrl, type AppFileInfo } from '../../../shared/types'

  /** The drawer's Files button and list: the files saved with this app. */
  let { appId }: { appId: string } = $props()

  let files = $state<AppFileInfo[]>([])
  let open = $state(false)

  async function load(id: string): Promise<void> {
    try {
      const list = await window.api.library.assets(id)
      if (id === appId) files = list
    } catch {
      if (id === appId) files = []
    }
  }

  $effect(() => {
    const id = appId
    void load(id)
    return window.api.library.onChanged((e) => {
      if (!e.ids.length || e.ids.includes(id)) void load(id)
    })
  })

  function size(bytes: number): string {
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  async function remove(f: AppFileInfo): Promise<void> {
    if (
      f.used &&
      !confirm(
        `This app still uses “${f.name}”. Without it, that part of the app will stop working. Remove it anyway?`
      )
    ) {
      return
    }
    try {
      await window.api.library.removeAsset(appId, f.name)
      await load(appId)
    } catch (e) {
      ui.showToast(`Couldn't remove “${f.name}”: ${errorText(e)}`)
    }
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#if files.length}
  <button
    class="files-btn"
    class:is-open={open}
    title="Files saved with this app"
    onclick={() => (open = !open)}><Icon name="paperclip" size={12} />{files.length}</button
  >
{/if}

{#if open}
  <HeadPopover scroll onclose={() => (open = false)}>
    <span class="label">Files saved with this app</span>
    <ul>
      {#each files as f (f.name)}
        <li>
          <span class="thumb">
            {#if f.mime.startsWith('image/')}
              <img src={assetUrl(appId, f.name)} alt="" loading="lazy" />
            {:else}
              <FileTile name={f.name} />
            {/if}
          </span>
          <span class="info">
            <span class="name truncate" title={f.name}>{f.name}</span>
            <span class="tiny faint"
              >{size(f.size)}{f.width ? ` · ${f.width}×${f.height}` : ''}{f.used
                ? ' · used in the app'
                : ''}</span
            >
          </span>
          <button
            class="btn btn-icon btn-ghost btn-sm"
            title="Remove from this app"
            aria-label={`Remove ${f.name}`}
            onclick={() => remove(f)}><Icon name="trash" size={14} /></button
          >
        </li>
      {/each}
    </ul>
    <span class="tiny faint"
      >Ask for a file in a change (“put the logo in the header”) to use it in the app.</span
    >
  </HeadPopover>
{/if}

<style>
  .files-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-2);
    font: 500 var(--text-xs) / 1 var(--font-sans);
    cursor: pointer;
  }
  .files-btn:hover,
  .files-btn.is-open {
    background: var(--surface-2);
    color: var(--text);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .thumb {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface-2);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-size: var(--text-sm);
  }
</style>
