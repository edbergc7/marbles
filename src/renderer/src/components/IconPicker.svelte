<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import AppIcon from './AppIcon.svelte'
  import { popOut } from '../lib/motion'
  import { ORB_COLOR_NAMES, formatIcon, parseIcon, type OrbColor } from '../../../shared/appIcon'

  let {
    x,
    y,
    current,
    onPick,
    onClose
  }: {
    x: number
    y: number
    current: string
    onPick: (icon: string) => void
    onClose: () => void
  } = $props()

  const color = untrack(() => parseIcon(current))

  let el: HTMLDivElement
  let pos = $state<{ left: number; top: number } | null>(null)

  onMount(() => {
    // offsetWidth/Height ignore the pop-in scale transform.
    pos = {
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8))
    }
    el.querySelector<HTMLButtonElement>('.swatch.is-active')?.focus()
  })

  function pick(c: OrbColor): void {
    if (c !== color) onPick(formatIcon(c))
    onClose()
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} onblur={onClose} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onmousedown={onClose}></div>
<div
  class="picker"
  role="dialog"
  aria-label="Icon color"
  bind:this={el}
  out:popOut|global
  style="left:{pos?.left ?? x}px; top:{pos?.top ?? y}px; transform-origin:{x -
    (pos?.left ?? x)}px {y - (pos?.top ?? y)}px"
>
  <div class="label">Color</div>
  <div class="colors">
    {#each ORB_COLOR_NAMES as c (c)}
      <button
        class="swatch"
        class:is-active={c === color}
        title={c[0].toUpperCase() + c.slice(1)}
        aria-label={c}
        aria-pressed={c === color}
        onclick={() => pick(c)}><AppIcon color={c} size={28} /></button
      >
    {/each}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
  }
  .picker {
    position: fixed;
    z-index: 91;
    padding: 10px 12px 12px;
    background: var(--pop-bg);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: pop var(--dur-slow) var(--spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
  }
  .label {
    padding: 0 2px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-3);
  }
  .colors {
    display: grid;
    grid-template-columns: repeat(3, 34px);
    gap: 6px;
  }
  .swatch {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    outline: none;
    transition: transform var(--dur) var(--ease);
  }
  .swatch:hover {
    transform: scale(1.08);
  }
  .swatch.is-active,
  .swatch:focus-visible {
    box-shadow:
      0 0 0 2px var(--pop-bg),
      0 0 0 3.5px var(--text);
  }
</style>
