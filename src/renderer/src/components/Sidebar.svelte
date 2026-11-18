<script lang="ts">
  import { onDestroy } from 'svelte'
  import { slide } from 'svelte/transition'
  import type { AppMeta } from '../../../shared/types'
  import Icon from './Icon.svelte'
  import Menu from './Menu.svelte'
  import IconPicker from './IconPicker.svelte'
  import SidebarHead from './sidebar/SidebarHead.svelte'
  import SidebarFooter from './sidebar/SidebarFooter.svelte'
  import FoldHeader from './sidebar/FoldHeader.svelte'
  import AppRow from './sidebar/AppRow.svelte'
  import FolderSection from './sidebar/FolderSection.svelte'
  import MakingRow from './sidebar/MakingRow.svelte'
  import DragGhost from './sidebar/DragGhost.svelte'
  import './sidebar/list.css'
  import logo from '../assets/logo.png'
  import { library } from '../lib/stores/library.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { isMac } from '../lib/platform'
  import { SidebarView } from '../lib/sidebar/viewState.svelte'
  import { RenameController } from '../lib/sidebar/rename.svelte'
  import { MenuController } from '../lib/sidebar/menus.svelte'
  import { DragController } from '../lib/sidebar/dragDrop.svelte'
  import { setSidebar } from '../lib/sidebar/context'
  import { reduceMotion, slideMs } from '../lib/sidebar/motion'

  let { searchEl = $bindable() }: { searchEl?: HTMLInputElement } = $props()

  // State lives in small controllers under lib/sidebar; children reach them through context.
  const view = new SidebarView()
  const rename = new RenameController()

  async function newFolder(thenMove?: string): Promise<void> {
    const folder = await library.createFolder('New folder')
    if (thenMove) await library.setFolder(thenMove, folder.id)
    view.expand(folder.id)
    await rename.start('folder', folder.id, folder.name)
  }

  const menus = new MenuController({ view, rename, newFolder })
  const dnd = new DragController({ view, newFolder })
  setSidebar({ view, rename, menus, dnd, newFolder })

  onDestroy(() => {
    dnd.dispose()
    view.dispose()
    rename.dispose()
  })

  // ---------- sections ----------

  const query = $derived(ui.search.trim().toLowerCase())

  const searchResults = $derived(
    query ? view.sorted(library.apps.filter((a) => a.name.toLowerCase().includes(query))) : []
  )

  const pinnedApps = $derived.by(() => {
    const byId = new Map(library.apps.map((a) => [a.id, a]))
    return library.layout.pinned.map((id) => byId.get(id)).filter((a): a is AppMeta => !!a)
  })

  const folderSections = $derived(
    library.layout.folders.map((folder) => ({
      folder,
      apps: view.sorted(library.apps.filter((a) => a.folder === folder.id))
    }))
  )

  /** Not in any (existing) folder and not pinned. */
  const unfiled = $derived(
    view.sorted(library.apps.filter((a) => !library.folderOf(a) && !library.isPinned(a.id)))
  )

  const hasStructure = $derived(library.layout.folders.length > 0 || pinnedApps.length > 0)

  // A just-built app may land below the fold; bring its row into view.
  $effect(() => {
    if (!ui.landed || ui.landed.kind !== 'new' || !dnd.listEl) return
    const row = dnd.listEl.querySelector<HTMLElement>(`[data-app-id="${CSS.escape(ui.landed.id)}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  })
</script>

<div class="side-slot" class:open={ui.sidebarOpen} inert={!ui.sidebarOpen}>
  <aside class="side">
    <div class="brand" class:mac={isMac}>
      <img class="mark" src={logo} alt="" />
      <span class="brand-name">Marbles</span>
    </div>

    <SidebarHead bind:searchEl />

    <div class="lib-head">
      <span>Library</span>
      {#if library.apps.length}<span class="lib-count">{library.apps.length}</span>{/if}
      <div class="spacer"></div>
      <button
        class="act always"
        title="Sort"
        aria-label="Sort apps"
        class:is-menu={menus.menu?.key === 'sort'}
        onclick={(e) => menus.openAt(e, 'sort', menus.sortMenu)}
        ><Icon name="sort" size={14} /></button
      >
      <button
        class="act always"
        title="New folder"
        aria-label="New folder"
        onclick={() => newFolder()}><Icon name="folderPlus" size={14} /></button
      >
    </div>

    <div class="apps-list" bind:this={dnd.listEl}>
      {#if gen.runningCreates.length}
        <div class="group">Making</div>
        {#each gen.runningCreates as job (job.jobId)}
          <div transition:slide={{ duration: slideMs }}>
            <MakingRow {job} />
          </div>
        {/each}
      {/if}

      {#if !library.loaded}
        <div class="note"><span class="spinner"></span></div>
      {:else if library.apps.length === 0 && library.layout.folders.length === 0}
        <div class="note">
          <p class="muted">No apps yet.</p>
          <button class="btn btn-sm" onclick={() => gen.openNew()}
            ><Icon name="plus" size={14} />New app</button
          >
        </div>
      {:else if query}
        {#if searchResults.length === 0}
          <div class="note"><p class="muted">No apps match “{ui.search}”.</p></div>
        {:else}
          <div class="group">Results</div>
          {#each searchResults as app (app.id)}
            <AppRow {app} ctx="search" />
          {/each}
        {/if}
      {:else}
        <!-- Pinned -->
        {#if pinnedApps.length || dnd.active?.kind === 'app'}
          <FoldHeader collapseKey="pinned" label="Pinned" drop="pin:end" />
          {#if !view.isCollapsed('pinned')}
            <div class="kids" transition:slide={{ duration: slideMs }}>
              {#each pinnedApps as app (app.id)}
                <AppRow {app} ctx="pinned" drop={`pin:${app.id}`} />
              {:else}
                <div
                  class="hint-drop"
                  class:drop-into={dnd.dropKey === 'pin:end'}
                  data-drop="pin:end"
                >
                  Drop here to pin
                </div>
              {/each}
            </div>
          {/if}
        {/if}

        <!-- Folders -->
        {#if folderSections.length}
          <div class="group">Folders</div>
        {/if}
        {#if dnd.active?.kind === 'app'}
          <div
            class="hint-drop new-folder"
            class:drop-into={dnd.dropKey === 'newfolder'}
            data-drop="newfolder"
          >
            <Icon name="folderPlus" size={14} /><span>New folder</span>
          </div>
        {/if}
        {#each folderSections as { folder, apps } (folder.id)}
          <FolderSection {folder} {apps} />
        {/each}
        {#if dnd.active?.kind === 'folder'}
          <div
            class="hint-drop"
            class:drop-into={dnd.dropKey === 'folder:end'}
            data-drop="folder:end"
          >
            Move to end
          </div>
        {/if}

        <!-- Unfiled -->
        {#if unfiled.length || (dnd.active?.kind === 'app' && library.layout.folders.length)}
          {#if hasStructure}
            <FoldHeader
              collapseKey="unfiled"
              label={library.layout.folders.length ? 'Latest' : 'Apps'}
              drop="unfiled"
            />
          {/if}
          {#if !hasStructure || !view.isCollapsed('unfiled')}
            <div class="kids" transition:slide={{ duration: slideMs }}>
              {#each unfiled as app (app.id)}
                <AppRow {app} ctx="unfiled" drop="unfiled" />
              {:else}
                <div
                  class="hint-drop"
                  class:drop-into={dnd.dropKey === 'unfiled'}
                  data-drop="unfiled"
                >
                  Drop here to take out of its folder
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
    </div>

    <SidebarFooter />
  </aside>
</div>

{#if menus.menu}
  <!-- Keyed: a submenu (Move to folder…) replaces the menu, so it must remount to re-measure and refocus. -->
  {#key menus.menu}
    <Menu x={menus.menu.x} y={menus.menu.y} items={menus.menu.items} onClose={menus.close} />
  {/key}
{/if}
<DragGhost />
{#if menus.picker}
  {@const p = menus.picker}
  <IconPicker x={p.x} y={p.y} current={p.current} onPick={p.onPick} onClose={menus.closePicker} />
{/if}

<style>
  .side-slot {
    width: 0;
    overflow: hidden;
    flex: none;
    transition: width var(--dur-slow) var(--ease);
  }
  .side-slot.open {
    width: 248px;
  }
  .side {
    width: 248px;
    height: 100%;
    flex: none;
    background: var(--window);
    border-right: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .brand {
    height: var(--bar-h);
    flex: none;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 16px;
    -webkit-app-region: drag;
  }
  .brand.mac {
    padding-left: 84px;
  }
  .mark {
    width: 20px;
    height: 20px;
    flex: none;
    object-fit: contain;
    background: none;
    border-radius: 0;
  }
  .brand-name {
    font-size: var(--text-md);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .lib-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 6px 14px 0 22px;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
  }
  .lib-count {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .apps-list {
    flex: 1;
    overflow: auto;
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .note {
    padding: 32px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
  }
</style>
