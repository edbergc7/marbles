<script lang="ts">
  import { icons, type IconName } from '../lib/icons'

  let { name, size = 16 }: { name: IconName; size?: number } = $props()
</script>

<!-- eslint-disable svelte/no-at-html-tags -- static icon markup from icons.ts -->
<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  style="flex:none;display:block">{@html icons[name]}</svg
>
