<script lang="ts">
  // One-line live reasoning ticker. When the text changes, the old words blur
  // out left to right while the new words blur in over them (staggered
  // crossfade). Swaps are throttled so the rolling window stays readable.
  let { text }: { text: string } = $props()

  type Layer = { id: number; words: string[]; leaving: boolean }

  const MIN_MS = 2400
  const LEAVE_MS = 1100

  let layers = $state<Layer[]>([])
  let shown = ''
  let lastSwap = 0
  let nextId = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function swap(t: string): void {
    shown = t
    lastSwap = Date.now()
    const id = nextId++
    layers = [
      ...layers.map((l) => ({ ...l, leaving: true })),
      { id, words: t.split(/(?<= )/), leaving: false }
    ]
    setTimeout(() => {
      layers = layers.filter((l) => !l.leaving)
    }, LEAVE_MS)
  }

  $effect(() => {
    const t = text
    if (!t || t === shown) return undefined
    const wait = shown ? Math.max(0, MIN_MS - (Date.now() - lastSwap)) : 0
    timer = setTimeout(() => swap(t), wait)
    return () => clearTimeout(timer)
  })
</script>

<div class="thought" aria-hidden="true">
  {#each layers as layer (layer.id)}
    {@const step = Math.min(35, 600 / Math.max(layer.words.length, 1))}
    <div class="layer" class:leaving={layer.leaving}>
      {#each layer.words as w, k (k)}
        <span class="w" style:--d="{Math.round(k * step)}ms">{w}</span>
      {/each}
    </div>
  {/each}
</div>

<style>
  .thought {
    position: relative;
    margin: 0 0 0 28px;
    height: 1.5em;
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: 1.5;
    overflow: hidden;
    mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
  }
  .layer {
    position: absolute;
    inset: 0 auto 0 0;
    white-space: nowrap;
  }
  .w {
    display: inline-block;
    white-space: pre;
    animation: blur-in 500ms var(--ease) var(--d) both;
  }
  .leaving .w {
    animation: blur-out 350ms var(--ease) var(--d) both;
  }
  @keyframes blur-in {
    from {
      opacity: 0;
      filter: blur(6px);
      transform: translateY(3px);
    }
  }
  @keyframes blur-out {
    to {
      opacity: 0;
      filter: blur(6px);
      transform: translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .w,
    .leaving .w {
      animation-duration: 150ms;
      animation-delay: 0ms;
      filter: none;
      transform: none;
    }
    @keyframes blur-in {
      from {
        opacity: 0;
      }
    }
    @keyframes blur-out {
      to {
        opacity: 0;
      }
    }
  }
</style>
