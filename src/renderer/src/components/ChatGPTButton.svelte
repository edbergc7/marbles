<script lang="ts">
  import logoWhite from '../assets/siwc/chatgpt-logo-white.svg'
  import logoBlack from '../assets/siwc/chatgpt-logo-black.svg'
  import { settings } from '../lib/stores/settings.svelte'

  /**
   * "Continue with ChatGPT" in one of OpenAI's approved formats (developers.openai.com/siwc):
   * white logo on a dark button in the light theme, black logo on a light button in the dark
   * theme, so it stands out either way. Logos are OpenAI's own assets, unmodified.
   */
  let {
    onclick,
    disabled = false,
    loading = false,
    size = 'md',
    wide = false
  }: {
    onclick: () => void
    disabled?: boolean
    loading?: boolean
    size?: 'sm' | 'md' | 'lg'
    /** Fill the container's width. */
    wide?: boolean
  } = $props()

  const onDark = $derived(settings.resolvedTheme === 'dark')
</script>

<button
  class="gpt-btn {size}"
  class:light={onDark}
  class:wide
  class:is-loading={loading}
  disabled={disabled || loading}
  {onclick}
>
  <img src={onDark ? logoBlack : logoWhite} alt="" width="21" height="21" />
  <span>Continue with ChatGPT</span>
</button>

<style>
  .gpt-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 36px;
    padding: 0 16px;
    border: 0;
    border-radius: 999px;
    background: #0d0d0d;
    color: #fff;
    font: inherit;
    font-size: var(--text-lg);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--dur-fast, 120ms),
      opacity var(--dur-fast, 120ms);
  }
  .gpt-btn:hover:not(:disabled) {
    background: #2a2a2a;
  }
  .gpt-btn.light {
    background: #fff;
    color: #0d0d0d;
  }
  .gpt-btn.light:hover:not(:disabled) {
    background: #e8e8e8;
  }
  .gpt-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .gpt-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .gpt-btn.sm {
    height: 28px;
    padding: 0 12px;
    gap: 8px;
    font-size: var(--text-md);
  }
  .gpt-btn.sm img {
    width: 16px;
    height: 16px;
  }
  .gpt-btn.lg {
    height: 44px;
    padding: 0 22px;
    font-size: var(--text-xl);
  }
  .gpt-btn.lg img {
    width: 22px;
    height: 22px;
  }
  .wide {
    width: 100%;
  }
  .is-loading span {
    opacity: 0.7;
  }
</style>
