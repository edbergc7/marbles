<script lang="ts">
  import Icon from '../Icon.svelte'
  import AppIcon from '../AppIcon.svelte'
  import { getSidebar } from '../../lib/sidebar/context'

  const { dnd } = getSidebar()
  const ghost = dnd.ghost
</script>

{#if ghost.item}
  <!-- Positioned and tilted by GhostSpring; the inner card does the pick-up pop. -->
  <div class="drag-ghost" bind:this={ghost.el} aria-hidden="true">
    <div class="ghost-card" class:over-target={!!dnd.dropKey}>
      {#if ghost.item.kind === 'app'}<AppIcon icon={ghost.item.icon ?? null} />{:else}<span
          class="fico"><Icon name="folder" size={14} /></span
        >{/if}
      <span class="name">{ghost.item.label}</span>
    </div>
  </div>
{/if}

<style>
  .drag-ghost {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 100;
    pointer-events: none;
    will-change: transform;
    /* Swing around the grab point (the pointer sits 12px left, 8px above). */
    transform-origin: -12px -8px;
  }
  .ghost-card {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 220px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius);
    background: var(--pop-bg);
    box-shadow:
      var(--shadow-pop),
      0 18px 36px -14px rgb(0 0 0 / 0.35);
    color: var(--text);
    opacity: 0.97;
    animation: ghost-lift 320ms var(--spring) both;
    transition:
      box-shadow var(--dur) var(--ease),
      transform 200ms var(--spring);
  }
  /* Over a valid target the card leans in, ready to drop. */
  .ghost-card.over-target {
    transform: scale(0.96);
    box-shadow:
      0 0 0 1.5px var(--accent),
      0 10px 24px -12px rgb(0 0 0 / 0.35);
  }
  @keyframes ghost-lift {
    from {
      transform: scale(0.9);
      opacity: 0.4;
    }
    60% {
      transform: scale(1.05);
    }
    to {
      transform: scale(1);
    }
  }
  /* The ghost sits outside `.side`, so it carries its own copies of the row bits it shows. */
  .fico {
    width: 16px;
    display: grid;
    place-items: center;
    color: var(--text-3);
    flex: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(body.is-sidebar-dragging),
  :global(body.is-sidebar-dragging *) {
    cursor: grabbing !important;
  }
  :global(body.is-sidebar-dragging iframe) {
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost-card {
      animation: none;
    }
  }
</style>
