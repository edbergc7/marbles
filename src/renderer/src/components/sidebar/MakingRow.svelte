<script lang="ts">
  import AppIcon from '../AppIcon.svelte'
  import { ui } from '../../lib/stores/ui.svelte'
  import { gen } from '../../lib/stores/gen.svelte'

  let { job }: { job: (typeof gen.runningCreates)[number] } = $props()
</script>

<button
  class="row building"
  class:is-active={ui.view === 'new' && gen.activeCreateId === job.jobId}
  onclick={() => gen.watch(job.jobId)}
>
  <!-- The marble rolls in place with a light sweeping over it until the app is
       built. Neutral until the app is named and gets its color. -->
  <span class="making-orb" class:named={!!job.icon}>
    {#key job.icon}<AppIcon icon={job.icon ?? '@neutral'} />{/key}
  </span>
  <span class="name making-name">{job.name ?? job.prompt}</span>
  {#if job.plan?.length}
    <span class="making-step" title="Step {Math.max(job.step + 1, 1)} of {job.plan.length}"
      >{Math.min(Math.max(job.step + 1, 1), job.plan.length)}/{job.plan.length}</span
    >
  {/if}
</button>

<style>
  /* ---- Making: the marble rolls and a light sweeps over it while the app is built ---- */
  .making-orb {
    position: relative;
    flex: none;
    display: grid;
    border-radius: 50%;
    overflow: hidden;
    animation: making-roll 2.4s ease-in-out infinite;
  }
  .making-orb::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      115deg,
      transparent 30%,
      rgb(255 255 255 / 0.75) 50%,
      transparent 70%
    );
    transform: translateX(-120%);
    animation: making-sweep 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  /* When the app is named, its colored marble pops in (keyframes live in list.css). */
  .making-orb.named :global(.orb) {
    animation: sb-orb-land 520ms var(--spring);
  }
  @keyframes making-roll {
    0%,
    100% {
      transform: translateX(-1.5px) rotate(-25deg);
    }
    50% {
      transform: translateX(1.5px) rotate(25deg);
    }
  }
  @keyframes making-sweep {
    0% {
      transform: translateX(-120%);
    }
    60%,
    100% {
      transform: translateX(120%);
    }
  }
  .making-name {
    color: transparent;
    background: linear-gradient(
        90deg,
        var(--text-3) 0%,
        var(--text-3) 35%,
        var(--text) 50%,
        var(--text-3) 65%,
        var(--text-3) 100%
      )
      0 0 / 250% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    animation: making-text 2.2s linear infinite;
  }
  @keyframes making-text {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: 0% 0;
    }
  }
  .making-step {
    flex: none;
    padding: 0 6px;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  @media (prefers-reduced-motion: reduce) {
    .making-orb,
    .making-orb::after,
    .making-orb.named :global(.orb) {
      animation: none;
    }
    /* Keep a gentle, non-moving "working" signal: the name stays dimmed. */
    .making-name {
      animation: none;
      color: var(--text-3);
      background: none;
    }
  }
</style>
