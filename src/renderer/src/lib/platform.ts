// `window.platform` is exposed by the preload (process.platform).
export const platform: string = (window as unknown as { platform?: string }).platform ?? 'win32'
export const isMac = platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'

/** True for Cmd on macOS, Ctrl elsewhere. */
export function isMod(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}
