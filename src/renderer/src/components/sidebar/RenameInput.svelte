<script lang="ts">
  import { getSidebar } from '../../lib/sidebar/context'

  const { rename } = getSidebar()
</script>

<!-- Styled by `.rename` in list.css. -->
<input
  class="rename"
  bind:this={rename.inputEl}
  bind:value={rename.draft}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => {
    e.stopPropagation()
    if (e.key === 'Enter') void rename.commit()
    if (e.key === 'Escape') rename.cancel()
  }}
  onblur={() => rename.commit(true)}
/>
