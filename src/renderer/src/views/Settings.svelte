<script lang="ts">
  import { settings } from '../lib/stores/settings.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { key } from '../lib/stores/key.svelte'
  import { chatgpt, USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { notices } from '../lib/stores/notices.svelte'
  import { relativeTimeLong } from '../lib/time'
  import { formatCost } from '../lib/cost'
  import { errorText } from '../lib/errors'
  import Icon from '../components/Icon.svelte'
  import ChatGPTButton from '../components/ChatGPTButton.svelte'
  import type { ReasoningEffort, ThemeSetting } from '../../../shared/types'

  const THEMES: { value: ThemeSetting; label: string }[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' }
  ]
  const EFFORTS: { value: ReasoningEffort; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ]
  const ACCENTS = ['#ff6b2c', '#4aa3ff', '#5fcf8a', '#9b7bff', '#ff5a8a', '#f2b544']

  let builder = $state(settings.value?.builderModel ?? '')
  let utility = $state(settings.value?.utilityModel ?? '')
  let naming = $state(settings.value?.namingModel ?? '')

  const ns = $derived(notices.state)
  const updateLine = $derived.by(() => {
    if (!ns?.enabled) return ''
    if (ns.checking) return 'Checking…'
    if (ns.lastCheck === null) return ''
    const when = relativeTimeLong(new Date(ns.lastCheck).toISOString())
    if (ns.lastError && !ns.latestVersion) return `Couldn't reach GitHub. Last tried ${when}.`
    if (ns.updateAvailable) return `Version ${ns.latestVersion} is available. Checked ${when}.`
    return `You're up to date. Checked ${when}.`
  })

  let signingIn = $state(false)
  let copied = $state(false)

  async function signInChatGPT(): Promise<void> {
    signingIn = true
    try {
      await chatgpt.signIn()
      // Sign-in may have pointed the model roles at ChatGPT.
      builder = settings.value?.builderModel ?? builder
      utility = settings.value?.utilityModel ?? utility
      naming = settings.value?.namingModel ?? naming
    } finally {
      signingIn = false
    }
  }

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // clipboard blocked: the link is still visible to select by hand
    }
  }

  let keyDraft = $state('')
  let saving = $state(false)
  /** A setKey validation error; the store's state is untouched, so this is shown on its own. */
  let keyError = $state<string | null>(null)

  const spentThisMonth = $derived.by(() => {
    const now = new Date()
    let total = 0
    let any = false
    for (const app of library.apps) {
      for (const v of app.versions) {
        const d = new Date(v.createdAt)
        if (
          typeof v.cost === 'number' &&
          d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth()
        ) {
          total += v.cost
          any = true
        }
      }
    }
    return any ? total : null
  })

  const isEnv = $derived(
    key.state.phase !== 'loading' && key.state.phase !== 'missing' && key.state.source === 'env'
  )
  const isStored = $derived(
    key.state.phase !== 'loading' && key.state.phase !== 'missing' && key.state.source === 'stored'
  )

  const keyLabel = $derived.by(() => {
    const s = key.state
    if (s.phase === 'loading' || s.phase === 'missing') return 'Not set'
    if (s.phase === 'rejected') {
      return s.source === 'env'
        ? 'From the OPENROUTER_API_KEY environment variable, but OpenRouter rejected it'
        : 'Saved, but OpenRouter rejected it'
    }
    if (s.source === 'env') return 'From the OPENROUTER_API_KEY environment variable'
    return s.insecureStorage
      ? 'Saved (no OS keyring found, stored obfuscated only)'
      : 'Saved, encrypted with the OS keychain'
  })

  const validText = $derived.by(() => {
    const s = key.state
    if (s.phase !== 'valid') return ''
    const credit = s.creditsLeft != null ? ` · $${s.creditsLeft.toFixed(2)} credit left` : ''
    return `Key works${s.label ? ` (${s.label})` : ''}${credit}`
  })

  async function saveKey(): Promise<void> {
    const v = keyDraft.trim()
    if (!v || saving) return
    saving = true
    keyError = null
    try {
      await key.save(v)
      keyDraft = ''
    } catch (e) {
      keyError = errorText(e)
    } finally {
      saving = false
    }
  }

  function modelLabel(m: { id: string; name: string }): string {
    return m.id.startsWith('chatgpt:') ? `${m.name} · ChatGPT plan` : m.name
  }

  function priceHint(id: string): string {
    const m = gen.models.find((x) => x.id === id.trim())
    if (!m) return gen.models.length ? 'not found in the model list' : ''
    if (m.id.startsWith('chatgpt:')) return `${m.name} · uses your ChatGPT plan`
    const p = (n: number | null): string => (n == null ? '?' : `$${n.toFixed(2)}`)
    return `${m.name} · ${p(m.promptPrice)} in / ${p(m.completionPrice)} out per 1M tokens`
  }

  let libBusy = $state<'move' | 'open' | 'reset' | null>(null)
  let libResult = $state<{ ok: boolean; text: string } | null>(null)

  async function runLib(kind: 'move' | 'open' | 'reset'): Promise<void> {
    if (libBusy) return
    libResult = null
    try {
      if (kind === 'reset') {
        libBusy = 'reset'
        settings.value = await window.api.libraryLocation.reset()
        libResult = { ok: true, text: 'Back to the default location.' }
        return
      }
      const info = await window.api.libraryLocation.pick()
      if (!info) return
      if (info.isCurrent) {
        libResult = { ok: false, text: 'That is already your library.' }
        return
      }
      libBusy = kind
      if (kind === 'move') {
        if (!info.empty) {
          libResult = {
            ok: false,
            text: info.isLibrary
              ? 'That folder already holds a library. Use “Open existing” to switch to it.'
              : 'Choose an empty folder to move your library into.'
          }
          return
        }
        const n = library.apps.length
        settings.value = await window.api.libraryLocation.moveTo(info.path)
        libResult = {
          ok: true,
          text: `Moved ${n} ${n === 1 ? 'app' : 'apps'}. The old folder was left in place.`
        }
      } else {
        if (!info.empty && !info.isLibrary) {
          libResult = { ok: false, text: 'That folder isn’t a library and isn’t empty.' }
          return
        }
        settings.value = await window.api.libraryLocation.useExisting(info.path)
        libResult = {
          ok: true,
          text: info.isLibrary
            ? `Switched to a library with ${info.appCount} ${info.appCount === 1 ? 'app' : 'apps'}.`
            : 'Started a new, empty library there.'
        }
      }
      await library.refresh()
    } catch (e) {
      libResult = { ok: false, text: errorText(e) }
    } finally {
      libBusy = null
    }
  }

  function saveModel(key: 'builderModel' | 'utilityModel' | 'namingModel', v: string): void {
    const value = v.trim()
    if (value && value !== settings.value?.[key]) void settings.set({ [key]: value })
  }
</script>

<div class="scroll">
  <div class="page">
    {#if settings.value}
      <section class="panel">
        <h3 class="card-title">ChatGPT plan</h3>
        {#if chatgpt.status?.state === 'signed_in'}
          <div class="row">
            <span class="status-dot" class:on={chatgpt.status.planOk}></span>
            <span class="muted grow"
              >Signed in{chatgpt.status.email ? ` as ${chatgpt.status.email}` : ''}</span
            >
            <a class="btn btn-sm" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
            <button class="btn btn-sm" onclick={() => chatgpt.signOut()}>Sign out</button>
          </div>
          {#if chatgpt.status.planOk}
            <p class="hint">
              Models starting with "chatgpt:" use your ChatGPT plan instead of OpenRouter credit.
              Tools that use AI draw on your plan too.
            </p>
          {:else}
            <p class="small bad">Your ChatGPT plan can't be used in Marbles.</p>
          {/if}
        {:else if chatgpt.status?.state === 'signing_in'}
          <div class="row">
            <span class="muted grow">Finish signing in in your browser.</span>
            <button class="btn btn-sm" onclick={() => chatgpt.cancel()}>Cancel</button>
          </div>
          <div class="row">
            <input class="input mono grow" readonly value={chatgpt.status.url} />
            <button
              class="btn btn-sm"
              onclick={() => chatgpt.status?.state === 'signing_in' && copyLink(chatgpt.status.url)}
              >{copied ? 'Copied' : 'Copy link'}</button
            >
          </div>
          <p class="hint">No browser opened? Copy the link into one.</p>
        {:else}
          <div class="row">
            <ChatGPTButton loading={signingIn} disabled={!chatgpt.status} onclick={signInChatGPT} />
            {#if chatgpt.status?.state === 'reauth_required'}
              <span class="small bad"
                >Your sign-in ended. Sign in again to keep using your plan.</span
              >
            {/if}
          </div>
          <p class="hint">
            Use your ChatGPT Plus or Pro plan to build, instead of an OpenRouter key.
          </p>
        {/if}
        {#if chatgpt.error}
          <p class="small bad">{chatgpt.error}</p>
        {/if}
      </section>

      <section class="panel">
        <h3 class="card-title">OpenRouter API key</h3>
        <div class="row">
          <span class="status-dot" class:on={key.isSet}></span>
          <span class="muted">{keyLabel}</span>
        </div>
        {#if !isEnv}
          <div class="row">
            <input
              class="input mono grow"
              type="password"
              placeholder={key.isSet ? 'Paste a new key to replace it' : 'sk-or-v1-…'}
              autocomplete="off"
              spellcheck="false"
              bind:value={keyDraft}
              onkeydown={(e) => e.key === 'Enter' && saveKey()}
            />
            <button
              class="btn btn-primary"
              disabled={!keyDraft.trim() || saving || key.state.phase === 'testing'}
              onclick={saveKey}>Save</button
            >
          </div>
        {/if}
        <div class="row">
          <button
            class="btn btn-sm"
            class:is-loading={key.state.phase === 'testing'}
            disabled={!key.isSet || key.state.phase === 'testing'}
            onclick={() => {
              keyError = null
              void key.test()
            }}><span>Test key</span></button
          >
          {#if isStored}
            <button
              class="btn btn-sm btn-danger"
              onclick={() => {
                keyError = null
                void key.clear()
              }}><Icon name="trash" size={14} />Remove</button
            >
          {/if}
          <div class="spacer"></div>
          {#if keyError}
            <span class="small bad">{keyError}</span>
          {:else if key.state.phase === 'valid'}
            <span class="small ok">{validText}</span>
          {:else if key.state.phase === 'rejected'}
            <span class="small bad">{key.state.reason}</span>
          {:else if key.state.phase === 'unverified' && key.state.lastError}
            <span class="small bad">{key.state.lastError}</span>
          {/if}
        </div>
        {#if spentThisMonth !== null}
          <p class="small muted">Building apps this month: {formatCost(spentThisMonth)}</p>
        {/if}
        <p class="hint">
          The key stays on this computer and is only sent to openrouter.ai. Get one at
          openrouter.ai/keys.
        </p>
      </section>

      <section class="panel">
        <h3 class="card-title">Appearance</h3>
        <div class="prop">
          <span class="prop-label">Theme</span>
          <div class="segmented" style="grid-column:2/-1;justify-self:start">
            {#each THEMES as t (t.value)}
              <button
                class:is-active={settings.value.theme === t.value}
                onclick={() => settings.set({ theme: t.value })}>{t.label}</button
              >
            {/each}
          </div>
        </div>
        <div class="prop">
          <span class="prop-label">Accent</span>
          <div class="tiles tiles-sm" style="grid-column:2/-1;grid-template-columns:repeat(6,32px)">
            {#each ACCENTS as c (c)}
              <button
                class="tile"
                class:is-active={settings.value.accent.toLowerCase() === c}
                style="background:{c}"
                title={c}
                aria-label="Accent {c}"
                onclick={() => settings.set({ accent: c })}
              ></button>
            {/each}
          </div>
        </div>
        <p class="hint">Theme and accent apply to the app shell and every generated app.</p>
      </section>

      <section class="panel">
        <h3 class="card-title">Library</h3>
        {#if settings.value.showAdvanced}
          <div class="lib-path">
            <Icon name="folder" size={16} />
            <span class="mono truncate grow" title={settings.value.libraryPath}
              >{settings.value.libraryPath}</span
            >
            <button
              class="btn btn-ghost btn-sm"
              onclick={() =>
                settings.value && window.api.exporter.reveal(settings.value.libraryPath)}
              >Show</button
            >
          </div>
          <div class="row">
            <button
              class="btn btn-sm"
              class:is-loading={libBusy === 'move'}
              disabled={!!libBusy}
              onclick={() => runLib('move')}><span>Move…</span></button
            >
            <button
              class="btn btn-sm"
              class:is-loading={libBusy === 'open'}
              disabled={!!libBusy}
              onclick={() => runLib('open')}><span>Open existing…</span></button
            >
            <div class="spacer"></div>
            <button
              class="btn btn-ghost btn-sm"
              class:is-loading={libBusy === 'reset'}
              disabled={!!libBusy}
              onclick={() => runLib('reset')}><span>Use default</span></button
            >
          </div>
        {:else}
          <div class="row">
            <button
              class="btn btn-sm"
              onclick={() =>
                settings.value && window.api.exporter.reveal(settings.value.libraryPath)}
              ><Icon name="folder" size={14} />Open folder</button
            >
            <button
              class="btn btn-sm"
              class:is-loading={libBusy === 'move'}
              disabled={!!libBusy}
              onclick={() => runLib('move')}><span>Move…</span></button
            >
          </div>
        {/if}
        {#if libResult}
          <p class="small" class:ok={libResult.ok} class:bad={!libResult.ok}>{libResult.text}</p>
        {/if}
        <p class="hint">
          One folder per app, as plain files. Point this at a synced folder (Dropbox, iCloud,
          OneDrive) to use your apps on several computers.
        </p>
      </section>

      <section class="panel">
        <h3 class="card-title">Updates</h3>
        <div class="row">
          <span class="muted grow">Marbles {ns?.appVersion ?? ''}</span>
          {#if ns?.enabled}
            <button class="btn btn-sm" disabled={ns.checking} onclick={() => notices.check()}
              >Check now</button
            >
          {/if}
        </div>
        {#if ns?.available}
          <label class="check net-row">
            <span class="grow">
              <span class="medium">Check for updates and news</span>
              <span class="hint"
                >At startup and twice a day, Marbles asks GitHub for the newest release and a short
                news file, for things like bug warnings. Nothing about you or your apps is sent.
                Updates aren't installed for you: you'll get a link to download them.</span
              >
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.value.checkForUpdates ?? true}
              onchange={(e) => settings.set({ checkForUpdates: e.currentTarget.checked })}
            />
          </label>
          {#if updateLine}<p class="hint">{updateLine}</p>{/if}
        {:else}
          <p class="hint">This build doesn't check for updates.</p>
        {/if}
      </section>

      <section class="panel">
        <h3 class="card-title">Advanced</h3>
        <label class="check net-row">
          <span class="grow">
            <span class="medium">Show advanced options</span>
            <span class="hint"
              >Shows which AI models are used and what each change cost, and adds settings for
              models, the library folder and network access.</span
            >
          </span>
          <input
            type="checkbox"
            class="switch"
            checked={settings.value.showAdvanced ?? false}
            onchange={(e) => settings.set({ showAdvanced: e.currentTarget.checked })}
          />
        </label>
      </section>

      {#if settings.value.showAdvanced}
        <section class="panel">
          <h3 class="card-title">Models</h3>
          <label class="field"
            ><span class="label">Builder: creates and edits apps</span>
            <input
              class="input mono"
              list="model-ids"
              bind:value={builder}
              onblur={() => saveModel('builderModel', builder)}
              onkeydown={(e) => e.key === 'Enter' && saveModel('builderModel', builder)}
            />
          </label>
          <label class="field"
            ><span class="label">In-app AI: default for host.ai() in your apps</span>
            <input
              class="input mono"
              list="model-ids"
              bind:value={utility}
              onblur={() => saveModel('utilityModel', utility)}
              onkeydown={(e) => e.key === 'Enter' && saveModel('utilityModel', utility)}
            />
          </label>
          <label class="field"
            ><span class="label">Naming: names new apps (reasoning off)</span>
            <input
              class="input mono"
              list="model-ids"
              bind:value={naming}
              onblur={() => saveModel('namingModel', naming)}
              onkeydown={(e) => e.key === 'Enter' && saveModel('namingModel', naming)}
            />
          </label>
          <div class="field">
            <span class="label">Builder reasoning</span>
            <div class="segmented" style="justify-self:start;width:max-content">
              {#each EFFORTS as r (r.value)}
                <button
                  class:is-active={(settings.value.reasoningEffort ?? 'low') === r.value}
                  onclick={() => settings.set({ reasoningEffort: r.value })}>{r.label}</button
                >
              {/each}
            </div>
            <span class="hint"
              >How long the builder thinks before writing. Higher is slower and costs more.</span
            >
          </div>
          <datalist id="model-ids">
            {#each gen.models as m (m.id)}<option value={m.id}>{modelLabel(m)}</option>{/each}
          </datalist>
          <p class="hint">Builder: {priceHint(builder)}</p>
          <p class="hint">In-app AI: {priceHint(utility)}</p>
          <p class="hint">Naming: {priceHint(naming)}</p>
        </section>

        <section class="panel">
          <h3 class="card-title">Network</h3>
          <label class="check net-row">
            <span class="grow">
              <span class="medium">Let apps reach your local network</span>
              <span class="hint"
                >Off: apps can only fetch from the public internet. Turn on for tools that talk to
                something on this computer or your network, like a local model server or a home
                device.</span
              >
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.value.allowLocalNetwork ?? false}
              onchange={(e) => settings.set({ allowLocalNetwork: e.currentTarget.checked })}
            />
          </label>
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    width: 100%;
    overflow: auto;
  }
  .page {
    max-width: 640px;
    margin: 0 auto;
    padding: 24px 24px 48px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .panel {
    background: var(--surface);
    flex: none;
  }
  .prop {
    grid-template-columns: 88px 1fr;
  }
  .net-row {
    align-items: flex-start;
    gap: 16px;
    cursor: pointer;
  }
  .net-row .grow {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .net-row .switch {
    margin-top: 2px;
  }
  .lib-path {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--control-h);
    padding: 0 4px 0 12px;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    background: var(--field);
    color: var(--text-2);
    min-width: 0;
  }
  .lib-path :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-3);
    flex: none;
  }
  .status-dot.on {
    background: var(--success);
  }
  .ok {
    color: var(--success);
  }
  .bad {
    color: var(--danger);
  }
</style>
