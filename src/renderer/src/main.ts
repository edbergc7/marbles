import { mount } from 'svelte'

import '@fontsource-variable/inter'
import '../../../design/design.css'
import './shell.css'

import App from './App.svelte'

// Dropping a file or link on the window would navigate it away from the app. Nothing here
// takes native drops (the sidebar drags with pointer events), so cancel the default, but let
// text drops into fields through. Don't stop propagation.
function blockDropNavigation(e: DragEvent): void {
  const files = e.dataTransfer?.types.includes('Files') ?? false
  const t = e.target as HTMLElement | null
  const editable = !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
  if (files || !editable) e.preventDefault()
}
window.addEventListener('dragover', blockDropNavigation)
window.addEventListener('drop', blockDropNavigation)

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
