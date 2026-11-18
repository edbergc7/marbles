<script lang="ts">
  import Icon from '../Icon.svelte'
  import { ui } from '../../lib/stores/ui.svelte'
  import { gen } from '../../lib/stores/gen.svelte'
  import { modKey } from '../../lib/platform'

  /** The New button and the search field. `searchEl` is bound by App.svelte via Sidebar. */
  let { searchEl = $bindable() }: { searchEl?: HTMLInputElement } = $props()
</script>

<div class="head">
  <button
    class="new"
    class:is-active={ui.view === 'new'}
    title="New app ({modKey}+N)"
    aria-label="New app"
    onclick={() => gen.openNew()}
    onpointermove={(e) => {
      const b = e.currentTarget.getBoundingClientRect()
      e.currentTarget.style.setProperty('--mx', `${((e.clientX - b.left) / b.width) * 100}%`)
    }}
    ><span class="swirl" aria-hidden="true"></span><span class="swirl shade" aria-hidden="true"
    ></span><span class="new-label"><Icon name="plus" size={13} />New</span></button
  >
  <label class="search">
    <Icon name="search" size={13} />
    <input
      placeholder="Search"
      bind:this={searchEl}
      bind:value={ui.search}
      onkeydown={(e) => e.key === 'Escape' && ((ui.search = ''), searchEl?.blur())}
    />
    {#if !ui.search}<span class="keys"><kbd class="kbd">{modKey}</kbd><kbd class="kbd">K</kbd></span
      >{/if}
  </label>
</div>

<style>
  .head {
    padding: 2px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-bottom: 1px solid var(--hairline);
  }
  .keys {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
  .kbd {
    background: transparent;
    color: inherit;
    box-shadow: 0 0 0 1px currentColor;
    opacity: 0.45;
  }
  /* Primary action: the same flat grey as the other shell buttons. On hover
     it lifts off the sidebar and the New-app marble rises from its bottom edge:
     two blurred conic swirls in the logo colours turning opposite ways, masked
     to a soft semicircle that grows, with a glint that follows the pointer.
     Plain CSS, so it costs nothing without a GPU and only animates on hover. */
  @property --swirl-r {
    syntax: '<percentage>';
    inherits: true;
    initial-value: 0%;
  }
  .new {
    --mx: 50%;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: var(--btn);
    color: var(--text);
    font: 500 var(--text-sm) / 1 var(--font-sans);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    cursor: pointer;
    transition:
      background var(--dur) var(--ease),
      transform 260ms var(--spring),
      box-shadow 260ms var(--ease);
  }
  .new:hover,
  .new.is-active {
    background: var(--btn-hover);
  }
  .new:hover {
    transform: translateY(-1.5px);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.7),
      inset 0 -1px 0 rgb(0 0 0 / 0.08),
      0 1px 2px rgb(0 0 0 / 0.1),
      0 6px 14px -6px rgb(0 0 0 / 0.3);
  }
  .new:active {
    transform: translateY(0) scale(0.985);
    box-shadow:
      inset 0 1px 2px rgb(0 0 0 / 0.12),
      0 1px 1px rgb(0 0 0 / 0.08);
    transition-duration: 80ms;
  }
  .new-label {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  /* The + is in the text colour: the marble glow is the accent now. */
  .new-label :global(svg) {
    flex: none;
  }
  .swirl {
    --swirl-r: 0%;
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* At rest only a thin glow of the marble shows along the bottom edge, so
       the button still reads as the place to start; on hover it rises. */
    mask-image:
      radial-gradient(
        var(--swirl-r) calc(var(--swirl-r) * 1.6) at 50% 135%,
        #000 45%,
        transparent 100%
      ),
      linear-gradient(to top, rgb(0 0 0 / 0.9), transparent 5px);
    transition: --swirl-r 700ms var(--ease);
  }
  .new:hover .swirl,
  .new:focus-visible .swirl {
    --swirl-r: 76%;
  }
  .swirl:not(.shade)::before,
  .swirl:not(.shade)::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 260px;
    height: 260px;
    margin: -130px 0 0 -130px;
    border-radius: 50%;
    filter: blur(9px) saturate(1.2);
    animation: swirl-spin 9s linear infinite paused;
  }
  .swirl:not(.shade)::before {
    background: conic-gradient(
      from 20deg,
      rgb(77 143 64),
      rgb(148 148 77),
      rgb(242 148 171),
      rgb(214 194 138),
      rgb(240 224 207),
      rgb(242 148 171),
      rgb(77 143 64)
    );
  }
  .swirl:not(.shade)::after {
    width: 180px;
    height: 180px;
    margin: -90px 0 0 -90px;
    background: conic-gradient(
      from 200deg,
      transparent,
      rgb(242 148 171 / 0.8),
      transparent 30%,
      rgb(77 143 64 / 0.7),
      transparent 60%,
      rgb(214 194 138 / 0.8),
      transparent
    );
    animation-duration: 6s;
    animation-direction: reverse;
  }
  .new:hover .swirl::before,
  .new:hover .swirl::after {
    animation-play-state: running;
  }
  /* Shading that makes the swirl read as the top of a marble: a soft glint
     under the pointer and a shadow where it sinks into the bottom edge. */
  .swirl.shade {
    background:
      radial-gradient(30% 70% at var(--mx) 85%, rgb(255 255 255 / 0.3), transparent 70%),
      linear-gradient(to top, rgb(30 20 10 / 0.22), transparent 45%);
  }
  @keyframes swirl-spin {
    to {
      transform: rotate(1turn);
    }
  }
  /* Dark: dimmer colour, deeper shadow, and a text shadow to lift the label off the colour. */
  :global([data-theme='dark']) .swirl {
    opacity: 0.75;
  }
  :global([data-theme='dark']) .new:hover {
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.12),
      inset 0 -1px 0 rgb(0 0 0 / 0.4),
      0 1px 2px rgb(0 0 0 / 0.4),
      0 8px 16px -6px rgb(0 0 0 / 0.6);
  }
  :global([data-theme='dark']) .new-label {
    text-shadow: 0 1px 1px rgb(0 0 0 / 0.5);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .swirl {
      opacity: 0.75;
    }
    :global(:root:not([data-theme='light'])) .new:hover {
      box-shadow:
        inset 0 1px 0 rgb(255 255 255 / 0.12),
        inset 0 -1px 0 rgb(0 0 0 / 0.4),
        0 1px 2px rgb(0 0 0 / 0.4),
        0 8px 16px -6px rgb(0 0 0 / 0.6);
    }
    :global(:root:not([data-theme='light'])) .new-label {
      text-shadow: 0 1px 1px rgb(0 0 0 / 0.5);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .new:hover {
      transform: none;
    }
    .swirl::before,
    .swirl::after {
      animation: none;
    }
  }
  /* Search reads as a quiet row until it is used. */
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 8px 0 11px;
    border-radius: var(--radius);
    color: var(--text-3);
    cursor: text;
    transition:
      background var(--dur) var(--ease),
      box-shadow var(--dur) var(--ease);
  }
  .search:hover {
    background: var(--nav-hover);
  }
  .search:focus-within {
    background: var(--field);
    box-shadow: 0 0 0 1px var(--border-strong);
    color: var(--text-2);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font: 400 var(--text-md) / 1 var(--font-sans);
  }
  .search input:focus-visible {
    box-shadow: none;
  }
  .search input::placeholder {
    color: var(--text-2);
  }
  .search .keys {
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .search:hover .keys {
    opacity: 1;
  }
  .search:focus-within input::placeholder {
    color: var(--text-3);
  }
</style>
