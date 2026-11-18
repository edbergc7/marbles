<script lang="ts">
  import { chatgpt, USAGE_URL } from '../lib/stores/chatgpt.svelte'
  import { settings } from '../lib/stores/settings.svelte'
  import { ui } from '../lib/stores/ui.svelte'

  /** Shown once, the first time Marbles sees a usable ChatGPT sign-in (per OpenAI's SIWC guidelines). */
  // The Get started pop-up shows its own version of this note.
  const show = $derived(
    chatgpt.usable && !!settings.value && !settings.value.chatgptWelcomed && !ui.getStartedOpen
  )

  function done(): void {
    void settings.set({ chatgptWelcomed: true })
  }
</script>

{#if show}
  <div class="scrim"></div>
  <div class="welcome" role="dialog" aria-modal="true" aria-labelledby="gpt-welcome-title">
    <h3 id="gpt-welcome-title">You're using your ChatGPT plan</h3>
    <p class="muted">
      Models marked "ChatGPT plan" use your plan's usage instead of OpenRouter credit. Tools that
      use AI draw on it too. You can limit how much Marbles may use in
      <a href={USAGE_URL} target="_blank" rel="noreferrer">ChatGPT's usage settings</a>.
    </p>
    <div class="row">
      <div class="spacer"></div>
      <button class="btn btn-primary" onclick={done}>Got it</button>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgb(0 0 0 / 0.45);
  }
  .welcome {
    position: fixed;
    z-index: 41;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    border-radius: var(--radius-lg);
    background: var(--pop-bg);
    box-shadow: var(--shadow-pop);
  }
  h3 {
    margin: 0;
    font-size: var(--text-xl);
  }
  p {
    margin: 0;
    line-height: 1.5;
  }
</style>
