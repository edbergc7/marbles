<script lang="ts">
  import Icon from './Icon.svelte'
  import FileTile from './FileTile.svelte'
  import PlanChecklist from './PlanChecklist.svelte'
  import { library } from '../lib/stores/library.svelte'
  import { gen } from '../lib/stores/gen.svelte'
  import { ui } from '../lib/stores/ui.svelte'
  import { USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { relativeTime, shortModel } from '../lib/time'
  import { formatCost } from '../lib/cost'
  import { needsSettings } from '../lib/errors'
  import type { Turn } from '../lib/chatTurns'
  import { assetUrl } from '../../../shared/types'

  /** The drawer's scrolling conversation: past turns, the change being built, and the image viewer. */
  let {
    el = $bindable(),
    appId,
    appName,
    turns,
    job,
    shown,
    latest,
    advanced,
    model,
    onsuggest,
    ontryharder,
    oneditagain,
    onretry
  }: {
    /** The scrolling element, so the drawer can keep the newest content in view. */
    el?: HTMLDivElement
    appId: string | undefined
    appName: string | undefined
    turns: Turn[]
    job: ReturnType<typeof gen.editFor>
    shown: number
    latest: number
    advanced: boolean
    model: string
    onsuggest: (text: string) => void
    ontryharder: (prompt: string, base: number | undefined) => void
    oneditagain: () => void
    onretry: () => void
  } = $props()

  type MsgFile = {
    key: string
    name: string
    src: string
    image: boolean
    lazy: boolean
    truncated?: boolean
  }

  let viewer = $state<HTMLDialogElement>()
  let viewing = $state<{ src: string; name: string } | null>(null)

  function view(src: string, name: string): void {
    viewing = { src, name }
    viewer?.showModal()
  }

  const isErrorReport = (s: string): boolean => s.startsWith('Fix these errors')

  function turnFiles(t: Turn, id: string): MsgFile[] {
    return (t.user?.attachments ?? []).map((a) => ({
      key: a.name,
      name: a.name,
      src: assetUrl(id, a.name),
      image: (a.kind ?? 'image') === 'image',
      lazy: true
    }))
  }
</script>

{#snippet userMsg(files: MsgFile[], text: string)}
  {#if files.length}
    <div class="msg-files">
      {#each files as a (a.key)}
        {#if a.image}
          <button class="msg-file" title={a.name} onclick={() => view(a.src, a.name)}
            ><img src={a.src} alt={a.name} loading={a.lazy ? 'lazy' : undefined} /></button
          >
        {:else}
          <div class="msg-file"><FileTile name={a.name} truncated={a.truncated} /></div>
        {/if}
      {/each}
    </div>
  {/if}
  {#if text}
    <div class="msg-user" class:report={isErrorReport(text)}>{text}</div>
  {/if}
{/snippet}

<div class="chat" bind:this={el}>
  {#if turns.length === 0 && !job}
    <div class="empty">
      <span class="bracket"><Icon name="chat" size={16} /></span>
      <div class="medium">Change {appName ?? 'this app'}</div>
      <p class="hint">
        Describe what to add or fix. Each change becomes a new version you can undo.
      </p>
    </div>
  {:else}
    {#each turns as t, i (i)}
      {#if t.user}
        {@render userMsg(appId ? turnFiles(t, appId) : [], t.user.content)}
      {/if}
      {#if t.reply}
        {@const v = t.reply.version}
        <div class="msg-ai">
          <div class="meta">
            {#if v}
              <button
                class="ver"
                class:is-active={v === shown}
                title={v === shown ? 'Showing this version' : `Show v${v}`}
                onclick={() => appId && library.setCurrent(appId, v)}>v{v}</button
              >
            {/if}
            <span class="tiny faint truncate"
              >{#if advanced}{shortModel(t.reply.model ?? '')}{typeof t.reply.cost === 'number'
                  ? ` · ${formatCost(t.reply.cost)}`
                  : ''} ·
              {/if}{relativeTime(t.reply.ts)}</span
            >
          </div>
          {#if t.reply.plan?.length}
            <ul class="done-list">
              {#each t.reply.plan as item, k (k)}
                <li><Icon name="check" size={12} />{item}</li>
              {/each}
            </ul>
          {:else}
            <p class="small muted">{t.reply.content}</p>
          {/if}
          {#if i === turns.length - 1 && !job && t.reply.next?.length}
            <div class="next">
              {#each t.reply.next as s (s)}
                <button
                  class="next-chip"
                  title="Use as your next change"
                  onclick={() => onsuggest(s)}><Icon name="spark" size={12} />{s}</button
                >
              {/each}
            </div>
          {/if}
          {#if i === turns.length - 1 && !job && t.user?.content && (t.reply.baseVersion || t.reply.fresh || t.reply.version === 1)}
            <div class="row">
              <button
                class="btn btn-ghost btn-sm"
                title={t.reply.baseVersion
                  ? 'Not quite right? Redo this change and think it through more carefully. Slower, and costs a bit more.'
                  : 'Not quite right? Build it again from your request, thinking it through more carefully. The current version stays in the history. Slower, and costs a bit more.'}
                onclick={() => t.user && ontryharder(t.user.content, t.reply?.baseVersion)}
                ><Icon name="restore" size={14} />Try harder</button
              >
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if job}
      {@render userMsg(
        job.attachments.map((a) => ({
          key: a.id,
          name: a.name,
          src: a.previewUrl,
          image: a.kind === 'image',
          lazy: false,
          truncated: a.truncated
        })),
        job.prompt
      )}
      <div class="msg-ai live">
        {#if job.phase === 'failed'}
          <div class="callout {job.error.code === 'aborted' ? '' : 'callout-danger'}">
            {job.error.code === 'aborted' ? 'Stopped. Nothing changed.' : job.error.message}
          </div>
          {#if advanced && job.error.detail}<p class="tiny faint mono detail">
              {job.error.detail}
            </p>{/if}
          <div class="row">
            <button class="btn btn-ghost btn-sm" onclick={oneditagain}>Edit</button>
            <div class="spacer"></div>
            {#if job.error.code === 'plan_limit'}
              <a class="btn btn-sm" href={USAGE_URL} target="_blank" rel="noreferrer"
                >Manage usage</a
              >
            {:else if needsSettings(job.error.code)}
              <button class="btn btn-sm" onclick={() => (ui.view = 'settings')}
                >Open settings</button
              >
            {:else}
              <button class="btn btn-sm" onclick={onretry}
                ><Icon name="restore" size={14} />Try again</button
              >
            {/if}
          </div>
        {:else}
          <div class="meta">
            <span class="ver pending">v{job.targetVersion ?? latest + 1}</span>
            <span class="tiny faint truncate"
              >{#if advanced}{shortModel(job.model || model)}{:else}Working…{/if}{job.baseVersion &&
              job.baseVersion < latest
                ? ` · from v${job.baseVersion}`
                : ''}</span
            >
          </div>
          <PlanChecklist
            plan={job.plan}
            step={job.step}
            thinking={job.thinking}
            thought={job.thought}
            looking={job.looking}
          />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={viewer}
  class="viewer"
  aria-label={viewing?.name ?? 'Image'}
  onclick={() => viewer?.close()}
  onclose={() => (viewing = null)}
>
  {#if viewing}<img src={viewing.src} alt={viewing.name} />{/if}
</dialog>

<style>
  .detail {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .chat {
    flex: 1;
    overflow: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .chat .empty {
    flex: 1;
  }
  /* body turns selection off app-wide; chat text should be copyable */
  .msg-user,
  .msg-ai {
    user-select: text;
  }
  .msg-ai :global(button),
  .msg-ai :global(.btn) {
    user-select: none;
  }
  .msg-user {
    align-self: flex-end;
    max-width: 88%;
    padding: 8px 11px;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .msg-files {
    align-self: flex-end;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    max-width: 88%;
  }
  .msg-file {
    width: 72px;
    height: 72px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--surface-2);
  }
  button.msg-file {
    cursor: zoom-in;
  }
  .msg-file img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .viewer {
    border: 0;
    padding: 0;
    background: transparent;
    max-width: 90vw;
    max-height: 90vh;
    cursor: zoom-out;
  }
  .viewer::backdrop {
    background: rgb(0 0 0 / 0.7);
  }
  .viewer img {
    display: block;
    max-width: 90vw;
    max-height: 90vh;
    border-radius: var(--radius);
  }
  .msg-user.report {
    font: 400 var(--text-xs) / 1.5 var(--font-mono);
    color: var(--text-2);
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, #000 65%, transparent);
  }
  .msg-ai {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 12px;
  }
  .msg-ai.live :global(.plan) {
    padding: 12px 14px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ver {
    flex: none;
    height: 18px;
    min-width: 26px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    font: 600 var(--text-xs) / 18px var(--font-sans);
    letter-spacing: 0.04em;
    text-align: center;
    cursor: pointer;
  }
  button.ver:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .ver.is-active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .ver.pending {
    cursor: default;
    color: var(--text-3);
    box-shadow: inset 0 0 0 1px var(--surface-3);
    background: none;
  }
  .done-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .done-list li {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .done-list :global(svg) {
    flex: none;
    color: var(--text-3);
    transform: translateY(1px);
  }
  .next {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
    animation: next-in 240ms var(--ease) both;
  }
  .next-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 26px;
    padding: 4px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--btn);
    color: var(--text-2);
    font: 500 var(--text-xs) / 1.3 var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition:
      background var(--dur) var(--ease),
      color var(--dur) var(--ease);
  }
  .next-chip:hover {
    color: var(--text);
    background: var(--btn-hover);
  }
  .next-chip :global(svg) {
    flex: none;
    color: var(--accent-text);
  }
  @keyframes next-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .next {
      animation: none;
    }
  }
</style>
