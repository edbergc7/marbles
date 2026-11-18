<script lang="ts">
  import type { AppMeta, LibraryFolder } from '../../../../shared/types'
  import { slide } from 'svelte/transition'
  import Icon from '../Icon.svelte'
  import AppRow from './AppRow.svelte'
  import RenameInput from './RenameInput.svelte'
  import { ui } from '../../lib/stores/ui.svelte'
  import { getSidebar } from '../../lib/sidebar/context'
  import { slideMs } from '../../lib/sidebar/motion'

  let { folder, apps }: { folder: LibraryFolder; apps: AppMeta[] } = $props()

  const { view, rename, menus, dnd } = getSidebar()

  const open = $derived(!view.isCollapsed(folder.id))
  const drop = $derived(`folder:${folder.id}`)
  const editingThis = $derived(rename.isEditing('folder', folder.id))
</script>

<!-- No double-click rename here: two quick clicks to open and close a folder
     would start a rename. Use F2 or the menu. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="row folder"
  class:is-menu={menus.menu?.key === `folder:${folder.id}`}
  class:is-dragging={dnd.active?.kind === 'folder' && dnd.active.id === folder.id}
  class:drop-into={dnd.dropKey === drop && dnd.active?.kind === 'app'}
  class:drop-before={dnd.dropKey === drop && dnd.active?.kind === 'folder'}
  class:just-landed={ui.landed?.id === folder.id}
  data-drop={drop}
  tabindex="0"
  role="button"
  aria-expanded={open}
  ondragstart={(e) => e.preventDefault()}
  onpointerdown={(e) => {
    if (!editingThis) dnd.onRowPointerDown(e, { kind: 'folder', id: folder.id, label: folder.name })
  }}
  onclick={() => {
    if (!editingThis) view.toggleCollapsed(folder.id)
  }}
  oncontextmenu={(e) => menus.openAt(e, `folder:${folder.id}`, () => menus.folderMenu(folder))}
  onkeydown={(e) => {
    if (editingThis) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      view.toggleCollapsed(folder.id)
    } else if (e.key === 'F2') {
      e.preventDefault()
      void rename.start('folder', folder.id, folder.name)
    }
  }}
>
  <span class="chev" class:open><Icon name="chevronRight" size={12} /></span>
  <span class="fico"><Icon name="folder" size={14} /></span>
  {#if editingThis}
    <RenameInput />
  {:else}
    <span class="name">{folder.name}</span>
    {#if rename.renamed === `folder:${folder.id}`}<span class="renamed" aria-label="Renamed"
        ><Icon name="check" size={12} /></span
      >{/if}
    <span class="count">{apps.length}</span>
    <button
      class="act"
      title="More"
      tabindex="-1"
      onclick={(e) => menus.openAt(e, `folder:${folder.id}`, () => menus.folderMenu(folder))}
      ><Icon name="more" size={14} /></button
    >
  {/if}
</div>
{#if open}
  <div class="kids" transition:slide={{ duration: slideMs }}>
    {#each apps as app (app.id)}
      <AppRow {app} ctx="folder" {drop} />
    {:else}
      <div class="hint-drop indent" class:drop-into={dnd.dropKey === drop} data-drop={drop}>
        Empty. Drag apps here.
      </div>
    {/each}
  </div>
{/if}
