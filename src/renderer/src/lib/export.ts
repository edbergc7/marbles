import type { AppMeta } from '../../../shared/types'
import { ui } from './stores/ui.svelte'
import { errorText } from './errors'

const inFlight = new Set<string>()

/** Save the app's current version as a standalone HTML file and toast the result. */
export async function exportApp(app: AppMeta): Promise<void> {
  if (app.currentVersion < 1 || inFlight.has(app.id)) return
  inFlight.add(app.id)
  try {
    const r = await window.api.exporter.saveHtml(app.id, app.currentVersion)
    if (r) {
      const kb = Math.max(1, Math.round(r.bytes / 1024))
      const file = r.path.split(/[\\/]/).pop()
      ui.showToast(`Exported ${file} · ${kb} KB`, {
        label: 'Show in folder',
        run: () => void window.api.exporter.reveal(r.path)
      })
    }
  } catch (e) {
    ui.showToast(errorText(e))
  } finally {
    inFlight.delete(app.id)
  }
}
