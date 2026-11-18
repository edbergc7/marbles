/** Readable message from an error, without Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}

/** Build errors the user can only fix in Settings (missing, rejected or out-of-credit key, or a ChatGPT sign-in). */
export function needsSettings(code: string): boolean {
  return code === 'no_key' || code === 'auth' || code === 'credits' || code === 'signin'
}
