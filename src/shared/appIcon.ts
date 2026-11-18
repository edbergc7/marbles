// App icons: a colored orb, stored in the app's `icon` string as "@<color>". Older libraries
// may hold "@<color>/<glyph>" or an emoji; the glyph is ignored and an emoji gets a color
// derived from the string, so they need no migration.

/** Orb colors, one per image in the renderer's assets/orbs/. Order is the picker's order. */
export const ORB_COLOR_NAMES = [
  'neutral',
  'sunset',
  'ember',
  'lemon',
  'mint',
  'teal',
  'ocean',
  'violet',
  'rose'
] as const

export type OrbColor = (typeof ORB_COLOR_NAMES)[number]

/** Colors handed out automatically. Neutral is only ever picked by hand. */
const AUTO_COLORS = ORB_COLOR_NAMES.filter((c) => c !== 'neutral')

/** Retired colors that may still be stored in older libraries, mapped to the nearest orb. */
const LEGACY_COLORS: Record<string, OrbColor> = { dusk: 'ocean', graphite: 'neutral' }

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function isOrbColor(v: unknown): v is OrbColor {
  return typeof v === 'string' && (ORB_COLOR_NAMES as readonly string[]).includes(v)
}

/** Deterministic color for any seed (legacy emoji, prompt text…). */
export function colorFor(seed: string): OrbColor {
  return AUTO_COLORS[hash(seed) % AUTO_COLORS.length]
}

/** The orb color of a stored icon string. */
export function parseIcon(icon: string | null | undefined): OrbColor {
  const m = /^@([a-z]+)(?:\/[a-z]+)?$/.exec(icon ?? '')
  return (m && (isOrbColor(m[1]) ? m[1] : LEGACY_COLORS[m[1]])) || colorFor(icon || '')
}

export function formatIcon(color: OrbColor): string {
  return `@${color}`
}
