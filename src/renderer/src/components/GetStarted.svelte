<script lang="ts">
  /**
   * "Get started" pop-up: connect an AI model, either the ChatGPT plan or an OpenRouter key.
   * Opens on first run and whenever someone tries to build with nothing connected
   * (ui.getStartedOpen). After a ChatGPT sign-in it shows OpenAI's required one-time
   * "you're using your plan" note itself, so the separate welcome dialog doesn't stack on top.
   */
  import { fade, scale } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import logo from '../assets/logo.png'
  import ChatGPTButton from './ChatGPTButton.svelte'
  import Icon from './Icon.svelte'
  import { chatgpt, USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { errorText } from '../lib/errors'

  type Step = 'choose' | 'key' | 'plan-ready'
  let step = $state<Step>('choose')
  let keyDraft = $state('')
  let saving = $state(false)
  let keyError = $state<string | null>(null)
  let copied = $state(false)
  let keyInput = $state<HTMLInputElement>()

  const signingIn = $derived(chatgpt.status?.state === 'signing_in')
  const testing = $derived(key.state.phase === 'testing')
  const notEligible = $derived(chatgpt.status?.state === 'signed_in' && !chatgpt.status.planOk)

  function close(): void {
    if (signingIn) void chatgpt.cancel()
    ui.getStartedOpen = false
    // Dismissing counts as seen: don't pop up again by itself on the next launch.
    if (!settings.value?.setupDone) void settings.set({ setupDone: true })
    step = 'choose'
    keyDraft = ''
    keyError = null
  }

  async function signIn(): Promise<void> {
    await chatgpt.signIn()
    if (chatgpt.usable) {
      step = 'plan-ready'
      void settings.set({ setupDone: true, chatgptWelcomed: true })
    }
  }

  async function saveKey(): Promise<void> {
    const k = keyDraft.trim()
    if (!k || saving) return
    saving = true
    keyError = null
    try {
      await key.save(k)
      if (key.state.phase === 'rejected') keyError = key.state.reason
      else close() // valid, or saved but untested (offline): good enough to start
    } catch (e) {
      keyError = errorText(e)
    } finally {
      saving = false
    }
  }

  async function copyLink(): Promise<void> {
    if (chatgpt.status?.state !== 'signing_in') return
    try {
      await navigator.clipboard.writeText(chatgpt.status.url)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // clipboard blocked
    }
  }

  function showKey(): void {
    step = 'key'
    keyError = null
    queueMicrotask(() => keyInput?.focus())
  }

  function onKeydown(e: KeyboardEvent): void {
    if (ui.getStartedOpen && e.key === 'Escape') {
      e.preventDefault()
      if (step === 'key') step = 'choose'
      else close()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if ui.getStartedOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 160 }} onclick={close}></div>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="gs-title"
    transition:scale={{ start: 0.96, duration: 220, easing: cubicOut }}
  >
    <button class="close btn btn-icon btn-ghost btn-sm" title="Close" onclick={close}
      ><Icon name="x" size={14} /></button
    >

    <div class="head">
      <img class="orb" class:spin={signingIn} src={logo} alt="" width="64" height="64" />
      {#if step === 'plan-ready'}
        <h2 id="gs-title">You're using your ChatGPT plan</h2>
        <p class="sub">
          Marbles now builds with your plan instead of a paid key. Tools that use AI draw on it too.
        </p>
      {:else if step === 'key'}
        <h2 id="gs-title">Add an OpenRouter key</h2>
        <p class="sub">Pay as you go, with hundreds of models to choose from.</p>
      {:else}
        <h2 id="gs-title">Get started</h2>
        <p class="sub">Connect an AI model and Marbles can start making tools for you.</p>
      {/if}
    </div>

    {#if step === 'choose'}
      <div class="actions">
        {#if signingIn}
          <div class="waiting">
            <span class="spinner"></span>
            <span>Finish signing in in your browser</span>
          </div>
          <div class="links">
            <button class="link" onclick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</button>
            <span class="dot">·</span>
            <button class="link" onclick={() => chatgpt.cancel()}>Cancel</button>
          </div>
        {:else}
          <ChatGPTButton size="lg" wide onclick={signIn} />
          <p class="note">Use your Plus or Pro plan. No API key needed.</p>
        {/if}
        {#if chatgpt.error}
          <p class="small bad center">{chatgpt.error}</p>
        {:else if notEligible}
          <p class="small bad center">
            You're signed in, but your plan can't be used in Marbles. Try an OpenRouter key.
          </p>
        {/if}

        <div class="or"><span>or</span></div>

        <button class="pill" onclick={showKey} disabled={signingIn}
          >Add an OpenRouter API key</button
        >
      </div>
    {:else if step === 'key'}
      <div class="actions">
        <div class="key-row">
          <input
            bind:this={keyInput}
            class="input mono"
            type="password"
            placeholder="sk-or-v1-…"
            autocomplete="off"
            spellcheck="false"
            aria-label="OpenRouter API key"
            bind:value={keyDraft}
            onkeydown={(e) => e.key === 'Enter' && saveKey()}
          />
          <button
            class="btn btn-primary"
            class:is-loading={saving || testing}
            disabled={!keyDraft.trim() || saving || testing}
            onclick={saveKey}><span>Save</span></button
          >
        </div>
        {#if keyError}
          <p class="small bad">{keyError}</p>
        {/if}
        <p class="note left">
          Get a key at
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer"
            >openrouter.ai/keys</a
          >. It stays on this computer and is only sent to OpenRouter.
        </p>
        <button class="link back" onclick={() => (step = 'choose')}
          ><Icon name="chevronLeft" size={12} />Back</button
        >
      </div>
    {:else}
      <div class="actions">
        <button class="pill primary" onclick={close}>Start making</button>
        <p class="note">
          You can cap how much Marbles uses in
          <a href={USAGE_URL} target="_blank" rel="noreferrer">ChatGPT's usage settings</a>.
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgb(0 0 0 / 0.35);
    backdrop-filter: blur(6px);
  }
  .card {
    position: fixed;
    z-index: 51;
    top: 50%;
    left: 50%;
    translate: -50% -50%;
    width: min(400px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 36px 32px 28px;
    border-radius: 16px;
    background: var(--bg);
    box-shadow:
      0 0 0 1px var(--border-strong),
      0 24px 60px -16px rgb(0 0 0 / 0.45);
  }
  .close {
    position: absolute;
    top: 12px;
    right: 12px;
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    margin-bottom: 26px;
  }
  .orb {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    box-shadow:
      0 8px 24px -6px rgb(0 0 0 / 0.35),
      inset 0 0 0 1px rgb(255 255 255 / 0.15);
    margin-bottom: 6px;
  }
  .orb.spin {
    animation: spin 6s linear infinite;
  }
  @keyframes spin {
    to {
      rotate: 1turn;
    }
  }
  h2 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .sub {
    margin: 0;
    max-width: 30ch;
    color: var(--text-2);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .note {
    margin: 0;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--text-3);
    line-height: 1.5;
  }
  .note.left {
    text-align: left;
  }
  .center {
    text-align: center;
    margin: 0;
  }
  .or {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .or::before,
  .or::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-strong);
  }
  .pill {
    height: 44px;
    border-radius: 999px;
    border: 0;
    box-shadow: inset 0 0 0 1px var(--border-strong);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-lg);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .pill:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pill.primary {
    background: var(--text);
    color: var(--bg);
    box-shadow: none;
  }
  .pill.primary:hover {
    opacity: 0.9;
    background: var(--text);
  }
  .pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .waiting {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .links {
    display: flex;
    justify-content: center;
    gap: 8px;
    font-size: var(--text-sm);
  }
  .dot {
    color: var(--text-3);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--text-2);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--text-3);
    text-underline-offset: 2px;
  }
  .link:hover {
    color: var(--text);
  }
  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    text-decoration: none;
    font-size: var(--text-sm);
    margin-top: 4px;
  }
  .key-row {
    display: flex;
    gap: 8px;
  }
  .key-row .input {
    flex: 1;
    min-width: 0;
  }
  p.small {
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .orb.spin {
      animation: none;
    }
  }
</style>
