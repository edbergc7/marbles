<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    appFrameUrl,
    type AppMeta,
    type FrameToHost,
    type HostToFrame
  } from '../../../shared/types'
  import Icon from './Icon.svelte'
  import ErrorBadge from './ErrorBadge.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { frame } from '../lib/stores/frame.svelte'
  import { errorText } from '../lib/errors'
  import { handleShortcut } from '../lib/shortcuts'

  let { app }: { app: AppMeta } = $props()

  // Version files are immutable, so app + version fully identify the document.
  // Theme/accent changes are pushed live via postMessage instead of reloading.
  const src = $derived(app.currentVersion > 0 ? appFrameUrl(app.id, app.currentVersion) : null)
  const frameKey = $derived(`${app.id}@${app.currentVersion}`)

  /**
   * One layer per version on screen. A new version loads under the current one and
   * crossfades in once loaded, so an edit never flashes an empty frame.
   */
  type Layer = { key: string; src: string; shown: boolean }
  let layers = $state<Layer[]>([])
  const els: Record<string, HTMLIFrameElement | undefined> = $state({})
  /** The newest layer's iframe: the one we talk to. */
  const iframe = $derived(layers.length ? els[layers[layers.length - 1].key] : undefined)
  /** Nothing has loaded yet (first open): hide the whole frame. */
  const loading = $derived(!layers.some((l) => l.shown))

  $effect(() => {
    frame.reset(frameKey)
  })

  $effect(() => {
    const s = src
    const k = frameKey
    untrack(() => {
      if (!s) {
        layers = []
        return
      }
      if (layers[layers.length - 1]?.key === k) return
      // Keep only the newest visible layer under the incoming one.
      const under = layers.filter((l) => l.shown).slice(-1)
      layers = [...under, { key: k, src: s, shown: false }]
    })
  })

  let pruneTimer: ReturnType<typeof setTimeout> | undefined

  function onLayerLoad(layer: Layer): void {
    const live = layers.find((l) => l.key === layer.key)
    if (!live) return
    live.shown = true
    if (live === layers[layers.length - 1]) pushTheme()
    // Drop older layers once the crossfade has finished.
    clearTimeout(pruneTimer)
    pruneTimer = setTimeout(() => {
      const i = layers.findIndex((l) => l.key === layer.key)
      if (i > 0) layers = layers.slice(i)
    }, 320)
  }

  function post(msg: HostToFrame): void {
    iframe?.contentWindow?.postMessage(msg, '*')
  }

  function pushTheme(): void {
    if (!settings.value) return
    post({
      __marbles: 1,
      kind: 'theme',
      theme: settings.resolvedTheme,
      accent: settings.value.accent
    })
  }

  // Live theme/accent sync.
  $effect(() => {
    void settings.resolvedTheme
    void settings.value?.accent
    pushTheme()
  })

  async function onCall(
    id: number,
    method: Extract<FrameToHost, { kind: 'call' }>['method'],
    args: unknown[]
  ): Promise<void> {
    const appId = app.id
    const key = frameKey
    try {
      const value = await window.api.bridge.call(appId, method, Array.isArray(args) ? args : [])
      if (key === frameKey) post({ __marbles: 1, kind: 'result', id, ok: true, value })
    } catch (err) {
      if (key === frameKey)
        post({ __marbles: 1, kind: 'result', id, ok: false, error: errorText(err) })
    }
  }

  onMount(() => {
    function onMessage(e: MessageEvent): void {
      // Only accept messages from our own app iframe.
      const fromNewest = !!iframe && e.source === iframe.contentWindow
      const fromAny = layers.some((l) => els[l.key]?.contentWindow === e.source)
      if (!fromAny) return
      const data = e.data as FrameToHost | undefined
      if (!data || data.__marbles !== 1) return
      // An outgoing layer may still forward shortcuts; everything else is the newest frame's.
      if (!fromNewest && data.kind !== 'key') return
      switch (data.kind) {
        case 'ready':
          pushTheme()
          break
        case 'call':
          if (typeof data.id === 'number' && typeof data.method === 'string') {
            void onCall(data.id, data.method, data.args)
          }
          break
        case 'error':
          if (data.error && typeof data.error.message === 'string') {
            frame.add(frameKey, { ...data.error, message: data.error.message.slice(0, 2000) })
          }
          break
        case 'open':
          if (typeof data.url === 'string') void window.api.bridge.openLink(data.url)
          break
        case 'key':
          if (typeof data.key === 'string') handleShortcut(data.key.toLowerCase(), !!data.shift)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(pruneTimer)
    }
  })
</script>

{#if src}
  <!-- `fresh`: the app was just built, so its first load fades in slowly instead of popping. -->
  <div class="frame-wrap" class:loading class:fresh={ui.justBuilt === app.id}>
    {#each layers as layer (layer.key)}
      <!-- No allow-popups: main treats every window.open as coming from the host UI, so the
           app must not reach it. The shim posts app links here and main prompts first. -->
      <iframe
        bind:this={els[layer.key]}
        class:shown={layer.shown}
        title={app.name}
        src={layer.src}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads"
        allow="clipboard-write"
        onload={() => onLayerLoad(layer)}
      ></iframe>
    {/each}
  </div>
  <ErrorBadge />
{:else}
  <div class="empty" style="height:100%">
    <span class="bracket"><Icon name="spark" size={18} /></span>
    <div class="medium">No versions yet</div>
    <p class="hint">Describe what this app should do in the chat.</p>
    <button class="btn btn-sm" style="margin-top:12px" onclick={() => (ui.drawerOpen = true)}
      ><Icon name="chat" size={14} />Open chat</button
    >
  </div>
{/if}

<style>
  .frame-wrap {
    position: absolute;
    inset: 0;
    transition: opacity 160ms var(--ease);
  }
  .frame-wrap.loading {
    opacity: 0;
  }
  .frame-wrap.fresh {
    transition:
      opacity 600ms var(--ease),
      transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1),
      filter 600ms var(--ease);
  }
  .frame-wrap.fresh.loading {
    transform: translateY(8px) scale(0.985);
    filter: blur(6px);
  }
  @media (prefers-reduced-motion: reduce) {
    .frame-wrap.fresh {
      transition: opacity 160ms var(--ease);
    }
    .frame-wrap.fresh.loading {
      transform: none;
      filter: none;
    }
  }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: var(--bg);
    opacity: 0;
    transform: scale(0.996);
    filter: blur(3px);
    transition:
      opacity 280ms var(--ease),
      transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1),
      filter 280ms var(--ease);
  }
  iframe.shown {
    opacity: 1;
    transform: none;
    filter: none;
  }
  @media (prefers-reduced-motion: reduce) {
    iframe {
      transform: none;
      filter: none;
      transition: opacity 160ms var(--ease);
    }
  }
</style>
