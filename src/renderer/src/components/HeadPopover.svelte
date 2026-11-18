<script lang="ts">
  import type { Snippet } from 'svelte'
  import { popOut } from '../lib/motion'

  /**
   * A small pop-over that drops from the drawer header, with a click-away scrim.
   * Place it inside a `position: relative` header.
   */
  let {
    onclose,
    scroll = false,
    children
  }: { onclose: () => void; scroll?: boolean; children: Snippet } = $props()
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onmousedown={onclose}></div>
<div class="head-pop" class:scroll out:popOut|global>
  {@render children()}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
  }
  .head-pop {
    position: absolute;
    top: 44px;
    right: 8px;
    left: 8px;
    z-index: 31;
    transform-origin: top right;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border-radius: var(--radius);
    background: var(--pop-bg);
    box-shadow: var(--shadow-pop);
    animation: pop var(--dur-slow) var(--spring);
  }
  .head-pop.scroll {
    max-height: 60vh;
    overflow: auto;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
  }
</style>
