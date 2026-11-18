<script lang="ts" module>
  import type { IconName } from '../lib/icons'

  export type MenuItem =
    | {
        label: string
        icon?: IconName
        hint?: string
        danger?: boolean
        disabled?: boolean
        checked?: boolean
        onSelect: () => void
      }
    | 'separator'
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { popOut } from '../lib/motion'

  let {
    x,
    y,
    items,
    minWidth = 200,
    onClose
  }: { x: number; y: number; items: MenuItem[]; minWidth?: number; onClose: () => void } = $props()

  let el: HTMLDivElement
  let pos = $state<{ left: number; top: number } | null>(null)

  onMount(() => {
    // Keep the menu inside the window. offsetWidth/Height ignore the pop-in
    // scale(0.9) transform, which getBoundingClientRect would include.
    pos = {
      left: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8))
    }
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  })

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const btns = [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length
    btns[next]?.focus()
  }
</script>

<svelte:window onkeydown={onKey} onblur={onClose} onresize={onClose} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="scrim"
  onmousedown={onClose}
  oncontextmenu={(e) => (e.preventDefault(), onClose())}
></div>
<div
  class="menu"
  role="menu"
  bind:this={el}
  out:popOut|global
  style="left:{pos?.left ?? x}px; top:{pos?.top ??
    y}px; min-width:{minWidth}px; transform-origin:{x - (pos?.left ?? x)}px {y - (pos?.top ?? y)}px"
>
  {#each items as item, i (i)}
    {#if item === 'separator'}
      <div class="sep"></div>
    {:else}
      <button
        role="menuitem"
        class:danger={item.danger}
        disabled={item.disabled}
        onclick={() => {
          onClose()
          item.onSelect()
        }}
      >
        <span class="ic">
          {#if item.checked}<Icon name="check" size={14} />{:else if item.icon}<Icon
              name={item.icon}
              size={14}
            />{/if}
        </span>
        <span class="lbl">{item.label}</span>
        {#if item.hint}<span class="hint-r">{item.hint}</span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
  }
  .menu {
    position: fixed;
    z-index: 91;
    padding: 4px;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: pop var(--dur-slow) var(--spring);
    max-height: 70vh;
    overflow: auto;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
  }
  /* Don't let the flex column squash items when the menu hits max-height: scroll instead. */
  button,
  .sep {
    flex-shrink: 0;
  }
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 10px 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: 400 var(--text-md) / 1 var(--font-sans);
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--surface-2);
    box-shadow: none;
  }
  button:disabled {
    color: var(--text-3);
    cursor: default;
  }
  button.danger {
    color: var(--danger);
  }
  .ic {
    width: 16px;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .danger .ic {
    color: var(--danger);
  }
  .lbl {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hint-r {
    color: var(--text-3);
    font-size: var(--text-sm);
    font-weight: 400;
    padding-left: 16px;
    white-space: nowrap;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>
