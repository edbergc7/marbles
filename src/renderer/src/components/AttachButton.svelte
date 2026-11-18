<script lang="ts">
  import Icon from './Icon.svelte'
  import { ATTACH_ACCEPT, type AttachTray } from '../lib/attachments.svelte'

  let { tray, disabled = false }: { tray: AttachTray; disabled?: boolean } = $props()
  let input = $state<HTMLInputElement>()

  function picked(): void {
    const files = input?.files
    if (files?.length) void tray.add(Array.from(files))
    if (input) input.value = ''
  }
</script>

<button
  class="btn btn-ghost btn-icon btn-sm"
  title="Attach images or documents"
  aria-label="Attach files"
  {disabled}
  onclick={() => input?.click()}><Icon name="paperclip" size={14} /></button
>
<input bind:this={input} type="file" accept={ATTACH_ACCEPT} multiple hidden onchange={picked} />
