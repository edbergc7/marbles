import {
  ATTACH_DOC_EXTS,
  ATTACH_IMAGE_TYPES,
  ATTACH_MAX_BYTES,
  ATTACH_MAX_CHARS,
  ATTACH_TEXT_EXTS,
  ATTACH_MAX_FILES,
  type StagedAttachment
} from '../../../shared/types'
import { errorText } from './errors'
import { ui } from './stores/ui.svelte'

/** A staged file plus a local preview for its chip ('' for documents). */
export interface PendingAttachment extends StagedAttachment {
  previewUrl: string
}

export const ATTACH_ACCEPT = [
  ...Object.keys(ATTACH_IMAGE_TYPES),
  ...ATTACH_TEXT_EXTS,
  ...ATTACH_DOC_EXTS
].join(',')

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

/** Short label for a document tile: "PDF", "CSV", "DOCX"… */
export function fileLabel(name: string): string {
  return extOf(name).slice(1).toUpperCase().slice(0, 4) || 'FILE'
}

/** Longest edge of the copy the AI gets. The saved original is never changed. */
const MAX_EDGE = 2000
/** Smaller images are sent as they are. */
const SEND_AS_IS_BYTES = 4 * 1024 * 1024
const MAX_COPY_BYTES = 7.5 * 1024 * 1024

/**
 * A smaller copy for the AI when the image is large, or a PNG of a GIF's first frame (not all
 * providers take GIFs). undefined when the original can be sent as is.
 */
async function modelCopy(
  file: File,
  mime: string
): Promise<{ mime: string; data: Uint8Array } | undefined> {
  const bmp = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
    if (scale === 1 && mime !== 'image/gif' && file.size <= SEND_AS_IS_BYTES) return undefined
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not read that image.')
    ctx.drawImage(bmp, 0, 0, w, h)
    let blob = await canvas.convertToBlob({
      type: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      quality: 0.9
    })
    if (blob.size > MAX_COPY_BYTES) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    }
    return { mime: blob.type, data: new Uint8Array(await blob.arrayBuffer()) }
  } finally {
    bmp.close()
  }
}

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/** The files attached to one composer, before they're sent. */
export class AttachTray {
  items = $state<PendingAttachment[]>([])
  /** Files still being read and staged. */
  busy = $state(0)
  /** A file is being dragged over the composer. */
  over = $state(false)

  get count(): number {
    return this.items.length + this.busy
  }

  async add(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      if (this.count >= ATTACH_MAX_FILES) {
        ui.showToast(`You can attach up to ${ATTACH_MAX_FILES} files at a time.`)
        return
      }
      const mime = file.type
      const ext = extOf(file.name)
      const isImage = !!ATTACH_IMAGE_TYPES[mime]
      if (!isImage && !ATTACH_TEXT_EXTS.includes(ext) && !ATTACH_DOC_EXTS.includes(ext)) {
        ui.showToast(
          `Can't attach “${file.name}”. Attach images, PDFs, Word or Excel files, or text files like .txt, .md, .csv and .json.`
        )
        continue
      }
      if (file.size > ATTACH_MAX_BYTES) {
        ui.showToast(`“${file.name}” is too big (max ${ATTACH_MAX_BYTES / 1024 / 1024} MB).`)
        continue
      }
      this.busy++
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const copy = isImage ? await modelCopy(file, mime) : undefined
        const staged = await window.api.attachments.stage(file.name, mime, data, copy)
        this.items.push({
          ...staged,
          previewUrl: staged.kind === 'image' ? URL.createObjectURL(file) : ''
        })
        if (staged.truncated) {
          ui.showToast(
            `“${staged.name}” is long: only the first ${ATTACH_MAX_CHARS.toLocaleString()} characters will be sent.`
          )
        }
      } catch (e) {
        ui.showToast(`Couldn't attach “${file.name}”: ${errorText(e)}`)
      } finally {
        this.busy--
      }
    }
  }

  remove(id: string): void {
    const item = this.items.find((a) => a.id === id)
    if (!item) return
    this.items = this.items.filter((a) => a.id !== id)
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    void window.api.attachments.discard(id)
  }

  /** Hands the files to a request: they leave the tray but stay staged in main. */
  take(): PendingAttachment[] {
    const out = this.items
    this.items = []
    return out
  }

  /** Puts a request's files back (Edit after a failure). */
  restore(items: PendingAttachment[]): void {
    const have = this.items.map((a) => a.id)
    this.items = [...this.items, ...items.filter((a) => !have.includes(a.id))]
  }

  /** Drops everything in the tray (not files already handed to a request). */
  clear(): void {
    for (const a of this.items) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      void window.api.attachments.discard(a.id)
    }
    this.items = []
  }

  /** Pasted screenshots. Text pastes (even with an image alongside) stay plain text. */
  onPaste = (e: ClipboardEvent): void => {
    const cd = e.clipboardData
    if (!cd || !cd.files.length || cd.types.includes('text/plain')) return
    e.preventDefault()
    void this.add(Array.from(cd.files))
  }

  onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.over = true
  }

  onDragLeave = (e: DragEvent): void => {
    const to = e.relatedTarget as Node | null
    if (to && (e.currentTarget as Node).contains(to)) return
    this.over = false
  }

  onDrop = (e: DragEvent): void => {
    this.over = false
    if (!hasFiles(e) || !e.dataTransfer) return
    e.preventDefault()
    void this.add(Array.from(e.dataTransfer.files))
  }
}
