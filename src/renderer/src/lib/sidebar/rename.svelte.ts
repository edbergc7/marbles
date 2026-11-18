import { tick } from 'svelte'
import { library } from '../stores/library.svelte'
import { shake } from '../motion'
import type { Ctx } from './types'

/** Inline rename (apps and folders) and the checkmark shown after a rename. */
export class RenameController {
  editing = $state<{ kind: 'app' | 'folder'; id: string; ctx?: Ctx } | null>(null)
  draft = $state('')
  inputEl = $state<HTMLInputElement>()
  /** Briefly shows a checkmark on a row after it was renamed. Key is `app:<id>` or `folder:<id>`. */
  renamed = $state<string | null>(null)

  #renamedTimer: ReturnType<typeof setTimeout> | undefined

  start = async (kind: 'app' | 'folder', id: string, name: string, ctx?: Ctx): Promise<void> => {
    this.editing = { kind, id, ctx }
    this.draft = name
    await tick()
    this.inputEl?.focus()
    this.inputEl?.select()
  }

  #flashRenamed(key: string): void {
    clearTimeout(this.#renamedTimer)
    this.renamed = key
    this.#renamedTimer = setTimeout(() => (this.renamed = null), 1400)
  }

  commit = async (fromBlur = false): Promise<void> => {
    const e = this.editing
    if (!e) return
    const name = this.draft.trim()
    if (!name) {
      // Leaving the field with an empty name just cancels. Pressing Enter on it is rejected.
      if (fromBlur) {
        this.editing = null
        return
      }
      shake(this.inputEl)
      this.inputEl?.focus()
      return
    }
    this.editing = null
    if (e.kind === 'app') {
      const app = library.apps.find((a) => a.id === e.id)
      if (app && name !== app.name) {
        await library.rename(e.id, name)
        this.#flashRenamed(`app:${e.id}`)
      }
    } else {
      const f = library.layout.folders.find((x) => x.id === e.id)
      if (f && name !== f.name) {
        await library.updateFolder(e.id, { name })
        this.#flashRenamed(`folder:${e.id}`)
      }
    }
  }

  cancel = (): void => {
    this.editing = null
  }

  isEditing = (kind: 'app' | 'folder', id: string, ctx?: Ctx): boolean => {
    const editing = this.editing
    return editing?.kind === kind && editing.id === id && (kind === 'folder' || editing.ctx === ctx)
  }

  dispose(): void {
    clearTimeout(this.#renamedTimer)
  }
}
