<script lang="ts">
  import type { AppMeta } from '../../../../shared/types'
  import Icon from '../Icon.svelte'
  import AppIcon from '../AppIcon.svelte'
  import RenameInput from './RenameInput.svelte'
  import { library } from '../../lib/stores/library.svelte'
  import { ui } from '../../lib/stores/ui.svelte'
  import { gen } from '../../lib/stores/gen.svelte'
  import { alerts } from '../../lib/stores/alerts.svelte'
  import { getSidebar } from '../../lib/sidebar/context'
  import type { Ctx } from '../../lib/sidebar/types'

  let { app, ctx, drop }: { app: AppMeta; ctx: Ctx; drop?: string } = $props()

  const { view, rename, menus, dnd } = getSidebar()

  const active = $derived(app.id === library.selectedId && ui.view === 'app')
  const pinned = $derived(library.isPinned(app.id))
  const editingThis = $derived(rename.isEditing('app', app.id, ctx))
  /** The row that just received a drop, or a just-built app; it gets a short highlight. */
  const landed = $derived(ui.landed?.id === app.id)
  const landedNew = $derived(ui.landed?.kind === 'new')

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'F2') {
      e.preventDefault()
      void rename.start('app', app.id, app.name, ctx)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      void library.moveToTrash(app.id)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const rows = [...document.querySelectorAll<HTMLElement>('.apps-list [data-app-id]')]
      const i = rows.indexOf(e.currentTarget as HTMLElement)
      const next = rows[e.key === 'ArrowDown' ? i + 1 : i - 1]
      if (next) {
        library.select(next.dataset.appId!)
        next.focus()
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="row"
  class:indent={ctx === 'folder'}
  class:is-active={active}
  class:is-menu={menus.menu?.key === `app:${app.id}`}
  class:is-dragging={dnd.active?.kind === 'app' && dnd.active.id === app.id}
  class:drop-before={ctx === 'pinned' && dnd.dropKey === `pin:${app.id}`}
  class:just-landed={landed}
  class:just-built={landed && landedNew}
  data-app-id={app.id}
  data-drop={drop}
  tabindex="0"
  role="button"
  aria-current={active ? 'page' : undefined}
  ondragstart={(e) => e.preventDefault()}
  onpointerdown={(e) => {
    if (!editingThis && ctx !== 'search')
      dnd.onRowPointerDown(e, { kind: 'app', id: app.id, label: app.name, icon: app.icon })
  }}
  onclick={() => {
    if (!editingThis) library.select(app.id)
  }}
  oncontextmenu={(e) => menus.openAt(e, `app:${app.id}`, (x, y) => menus.appMenu(app, ctx, x, y))}
  onkeydown={(e) => (e.key === 'Enter' && !editingThis ? library.select(app.id) : onKey(e))}
>
  <AppIcon icon={app.icon} />
  {#if editingThis}
    <RenameInput />
  {:else}
    <span class="name">
      {app.name}
      {#if ctx === 'search' && library.folderOf(app)}
        <span class="where">{library.folderOf(app)?.name}</span>
      {/if}
    </span>
    {#if rename.renamed === `app:${app.id}`}<span class="renamed" aria-label="Renamed"
        ><Icon name="check" size={12} /></span
      >{/if}
    {#if gen.isEditing(app.id)}<span class="spinner" title="Changing…"></span>{/if}
    {#if alerts.unread.has(app.id)}<span
        class="dot"
        class:ringing={alerts.ringing === app.id}
        title="New notification"
        aria-label="New notification"
      ></span>{/if}
    <button
      class="act pin"
      class:on={pinned}
      class:pop={view.poppedPin === app.id}
      title={pinned ? 'Unpin' : 'Pin'}
      aria-label={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
      aria-pressed={pinned}
      tabindex="-1"
      onclick={(e) => {
        e.stopPropagation()
        if (!pinned) view.popPin(app.id)
        void library.togglePin(app.id)
      }}><Icon name="star" size={14} /></button
    >
    <button
      class="act"
      title="More"
      tabindex="-1"
      onclick={(e) => menus.openAt(e, `app:${app.id}`, (x, y) => menus.appMenu(app, ctx, x, y))}
      ><Icon name="more" size={14} /></button
    >
  {/if}
</div>

<style>
  .where {
    margin-left: 6px;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-weight: 400;
  }
  .row > .spinner {
    width: 11px;
    height: 11px;
    margin-right: 6px;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    margin: 0 8px 0 4px;
    border-radius: 50%;
    background: var(--accent);
  }
  .row:hover .dot,
  .row.is-menu .dot {
    margin-right: 2px;
  }
  .dot.ringing {
    animation: dot-ring 1.6s ease-in-out infinite;
  }
  @keyframes dot-ring {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }
  .act.pin.pop :global(svg) {
    animation: star-pop 480ms var(--spring);
  }
  @keyframes star-pop {
    0% {
      transform: scale(0.4) rotate(-40deg);
    }
    55% {
      transform: scale(1.45) rotate(12deg);
    }
    100% {
      transform: scale(1) rotate(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .act.pin.pop :global(svg),
    .dot.ringing {
      animation: none;
    }
  }
</style>
