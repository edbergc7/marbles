<script lang="ts">
  import Icon from './Icon.svelte'
  import ThoughtTicker from './ThoughtTicker.svelte'

  let {
    plan,
    step,
    thinking = false,
    thought = '',
    looking = 0,
    done = false
  }: {
    plan: string[] | null
    step: number
    thinking?: boolean
    thought?: string
    /** Images another model is describing first (the Builder can't see them). */
    looking?: number
    done?: boolean
  } = $props()

  function state(i: number): 'done' | 'active' | 'todo' {
    if (done || i < step) return 'done'
    if (i === step || (step === -1 && i === 0 && !thinking)) return 'active'
    return 'todo'
  }
</script>

<div class="plan" aria-live="polite">
  {#if plan === null}
    <div class="item is-active">
      <span class="dot"></span>
      <span class="shimmer"
        >{thinking
          ? 'Thinking it through…'
          : looking
            ? looking > 1
              ? 'Looking at your images…'
              : 'Looking at your image…'
            : 'Planning…'}</span
      >
    </div>
    {#if thinking && thought}
      <ThoughtTicker text={thought} />
    {/if}
  {:else if plan.length === 0}
    <div class="item is-active"><span class="dot"></span><span>Writing the app…</span></div>
  {:else}
    {#each plan as item, i (i)}
      {@const s = state(i)}
      <div class="item" class:is-done={s === 'done'} class:is-active={s === 'active'}>
        <span class="dot"
          >{#if s === 'done'}<Icon name="check" size={10} />{/if}</span
        >
        <span>{item}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .plan {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--card-ring);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-3);
    transition: color 200ms var(--ease);
    animation: in 220ms var(--ease) both;
  }
  .item:nth-child(2) {
    animation-delay: 40ms;
  }
  .item:nth-child(3) {
    animation-delay: 80ms;
  }
  .item:nth-child(4) {
    animation-delay: 120ms;
  }
  .item:nth-child(5) {
    animation-delay: 160ms;
  }
  .item:nth-child(6) {
    animation-delay: 200ms;
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1.5px solid var(--surface-3);
    flex: none;
    display: grid;
    place-items: center;
    color: var(--active-fg);
    transition:
      background 200ms var(--ease),
      border-color 200ms var(--ease);
  }
  .is-done {
    color: var(--text-2);
  }
  .is-done .dot {
    position: relative;
    background: var(--active);
    border-color: var(--active);
    animation: pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  /* ring that ripples outward as the step completes */
  .is-done .dot::after {
    content: '';
    position: absolute;
    inset: -1.5px;
    border-radius: 50%;
    border: 1.5px solid var(--active);
    pointer-events: none;
    animation: ripple 600ms var(--ease) 80ms both;
  }
  /* the tick draws itself in */
  .is-done .dot :global(path) {
    stroke-dasharray: 24;
    stroke-dashoffset: 24;
    animation: draw 280ms var(--ease) 140ms forwards;
  }
  .is-done > span:last-child {
    animation: settle 400ms var(--ease) both;
  }
  @keyframes pop {
    0% {
      transform: scale(0.6);
    }
    60% {
      transform: scale(1.25);
    }
    100% {
      transform: scale(1);
    }
  }
  @keyframes ripple {
    from {
      opacity: 0.55;
      transform: scale(1);
    }
    to {
      opacity: 0;
      transform: scale(2.3);
    }
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes settle {
    0% {
      transform: translateX(0);
    }
    40% {
      transform: translateX(3px);
    }
    100% {
      transform: translateX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .is-done .dot,
    .is-done .dot::after,
    .is-done .dot :global(path),
    .is-done > span:last-child {
      animation: none;
    }
    .is-done .dot :global(path) {
      stroke-dashoffset: 0;
    }
  }
  .is-active {
    color: var(--text);
  }
  .is-active .dot {
    border-color: var(--text);
    border-top-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  .shimmer {
    background: linear-gradient(90deg, var(--text-3) 0%, var(--text) 50%, var(--text-3) 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 1.6s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
</style>
