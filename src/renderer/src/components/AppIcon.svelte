<script lang="ts" module>
  import type { OrbColor } from '../../../shared/appIcon'
  import neutral from '../assets/orbs/neutral.png'
  import sunset from '../assets/orbs/sunset.png'
  import ember from '../assets/orbs/ember.png'
  import lemon from '../assets/orbs/lemon.png'
  import mint from '../assets/orbs/mint.png'
  import teal from '../assets/orbs/teal.png'
  import ocean from '../assets/orbs/ocean.png'
  import violet from '../assets/orbs/violet.png'
  import rose from '../assets/orbs/rose.png'

  const ORB_IMAGES: Record<OrbColor, string> = {
    neutral,
    sunset,
    ember,
    lemon,
    mint,
    teal,
    ocean,
    violet,
    rose
  }
</script>

<script lang="ts">
  import { parseIcon } from '../../../shared/appIcon'

  let {
    icon = null,
    color: colorProp,
    size = 13,
    pending = false
  }: {
    /** Stored icon string ("@violet", or a legacy emoji). */
    icon?: string | null
    /** Explicit color, overrides `icon` (used by the picker). */
    color?: OrbColor
    size?: number
    pending?: boolean
  } = $props()

  const color = $derived(colorProp ?? parseIcon(icon))
</script>

<span
  class="orb"
  class:pending
  style:--s="{size}px"
  style:background-image="url({ORB_IMAGES[color]})"
  aria-hidden="true"
></span>

<style>
  .orb {
    width: var(--s);
    height: var(--s);
    flex: none;
    display: block;
    border-radius: 50%;
    background-size: cover;
    background-position: center;
  }
  .pending {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
</style>
