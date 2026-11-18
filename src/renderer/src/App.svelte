<script lang="ts">
  import { onMount } from 'svelte'
  import TitleBar from './components/TitleBar.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import Drawer from './components/Drawer.svelte'
  import AppFrame from './components/AppFrame.svelte'
  import Icon from './components/Icon.svelte'
  import ChatGPTWelcome from './components/ChatGPTWelcome.svelte'
  import GetStarted from './components/GetStarted.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import NoticeBanner from './components/NoticeBanner.svelte'
  import NewApp from './views/NewApp.svelte'
  import Trash from './views/Trash.svelte'
  import Settings from './views/Settings.svelte'
  import { key } from './lib/stores/key.svelte'
  import { chatgpt } from './lib/stores/chatgpt.svelte'
  import { library } from './lib/stores/library.svelte'
  import { settings } from './lib/stores/settings.svelte'
  import { notices } from './lib/stores/notices.svelte'
  import { gen } from './lib/stores/gen.svelte'
  import { ui } from './lib/stores/ui.svelte'
  import { alerts } from './lib/stores/alerts.svelte'
  import { isMod } from './lib/platform'
  import { handleShortcut, registerSearchFocus } from './lib/shortcuts'

  let searchEl = $state<HTMLInputElement>()
  let ready = $state(false)

  onMount(async () => {
    await settings.init()
    await library.init()
    await gen.init()
    void notices.init()
    // A notification from an app (host.notify) was clicked: show that app.
    window.api.bridge.onOpenApp((id) => {
      if (library.apps.some((a) => a.id === id)) library.select(id)
    })
    alerts.init()
    if (library.apps.length === 0) ui.view = 'new'
    // First run: nothing connected yet, so offer ChatGPT sign-in or an OpenRouter key.
    const connected = key.isSet || chatgpt.status?.state === 'signed_in'
    if (!connected && !settings.value?.setupDone) {
      ui.view = 'new'
      ui.getStartedOpen = true
    }
    ready = true
  })

  // The app on screen: clear its notification dot, and tell main, which skips notifications
  // for an app the person is looking at (its page handles the moment itself).
  $effect(() => {
    const shown = ui.view === 'app' ? library.selectedId : null
    if (shown) alerts.seen(shown)
    void window.api.bridge.setShown(shown)
  })

  function isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  }

  registerSearchFocus(() => {
    searchEl?.focus()
    searchEl?.select()
  })

  function onKey(e: KeyboardEvent): void {
    if (!isMod(e)) return
    if (handleShortcut(e.key.toLowerCase(), e.shiftKey, isTyping())) e.preventDefault()
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="window">
  <Sidebar bind:searchEl />
  <div class="main">
    <TitleBar />
    <NoticeBanner />
    <div class="body">
      <main class="center">
        {#if !ready}
          <div class="center-note"><span class="spinner"></span></div>
        {:else if ui.view === 'new'}
          <NewApp />
        {:else if ui.view === 'trash'}
          <Trash />
        {:else if ui.view === 'settings'}
          <Settings />
        {:else if library.selected}
          {#key library.selected.id}
            <AppFrame app={library.selected} />
          {/key}
        {:else}
          <div class="empty" style="height:100%">
            <span class="bracket"><Icon name="grid" size={18} /></span>
            <div class="medium">No app selected</div>
            <p class="hint">Pick one from the sidebar or start a new one.</p>
            <button class="btn btn-sm" style="margin-top:12px" onclick={() => gen.openNew()}
              ><Icon name="plus" size={14} />New app</button
            >
          </div>
        {/if}
      </main>
      <Drawer />
    </div>
  </div>
</div>
<ChatGPTWelcome />
<GetStarted />
<CommandPalette />

{#if library.error}
  <div class="toast is-visible error has-action">
    <span>{library.error}</span>
    <button onclick={() => library.refresh()}>Retry</button>
    <button aria-label="Dismiss" title="Dismiss" onclick={() => library.dismissError()}>×</button>
  </div>
{:else}
  <div class="toast" class:is-visible={!!ui.toast} class:has-action={!!ui.toastAction}>
    <span>{ui.toast ?? ''}</span>
    {#if ui.toastAction}
      {@const a = ui.toastAction}
      <button
        onclick={() => {
          a.run()
          ui.toast = null
        }}>{a.label}</button
      >
    {/if}
  </div>
{/if}

<style>
  :global(html, body, #app) {
    height: 100%;
    overflow: hidden;
  }
  :global(body) {
    background: var(--window);
    user-select: none;
  }
  :global(input, textarea, .output) {
    user-select: text;
  }
  .window {
    height: 100%;
    display: flex;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .center {
    flex: 1;
    min-width: 0;
    position: relative;
    overflow: hidden;
  }
  .center-note {
    height: 100%;
    display: grid;
    place-items: center;
  }
  .toast.has-action {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-right: 6px;
  }
  .toast.has-action.is-visible {
    pointer-events: auto;
  }
  .toast button {
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: inherit;
    font: 600 var(--text-xs) / 1 var(--font-sans);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    cursor: pointer;
  }
  .toast button:hover {
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
  }
</style>
