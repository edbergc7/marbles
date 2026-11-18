import type { IpcApi } from '../shared/types'

declare global {
  interface Window {
    api: IpcApi
    /** process.platform of the main process ('win32' | 'darwin' | 'linux' …). */
    platform: string
  }
}
