<script lang="ts">
  import Icon from '../Icon.svelte'
  import { getSidebar } from '../../lib/sidebar/context'

  /** A collapsible section label that is also a drop target. Styled by list.css. */
  let { collapseKey, label, drop }: { collapseKey: string; label: string; drop: string } = $props()

  const { view, dnd } = getSidebar()
  const open = $derived(!view.isCollapsed(collapseKey))
</script>

<div class="group group-btn" class:drop-into={dnd.dropKey === drop} data-drop={drop}>
  <button class="fold" onclick={() => view.toggleCollapsed(collapseKey)} aria-expanded={open}>
    <span class="chev" class:open><Icon name="chevronRight" size={12} /></span>
    {label}
  </button>
</div>
