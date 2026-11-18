import { cubicIn } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'
import { ui } from './stores/ui.svelte'

/** Reads a duration token from design.css (e.g. --dur-fast) in milliseconds. */
function durToken(name: string, fallback: number): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = parseFloat(v)
  if (Number.isNaN(n)) return fallback
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n
}

/** A small horizontal shake, e.g. when a field's value is rejected. Restarts if called again. */
export function shake(el: Element | undefined): void {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(2px)' },
      { transform: 'translateX(0)' }
    ],
    { duration: durToken('--dur-slow', 220) * 1.4, easing: 'ease-out' }
  )
}

/**
 * Exit for menus and popovers: a quick shrink and fade toward the element's
 * transform-origin. It uses --dur-fast, so popovers close faster than they
 * open (they open with --dur-slow on --spring).
 */
export function popOut(_node: Element): TransitionConfig {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  return {
    duration: reduce ? 0 : durToken('--dur-fast', 110),
    easing: cubicIn,
    css: (t) => `opacity: ${t}; transform: scale(${0.95 + 0.05 * t});`
  }
}

/**
 * Exit for the New App screen's content: a quick fade when it closes because an
 * app was just built (so the marble's bloom shows through), instant otherwise.
 */
export function fadeAfterBuild(_node: Element): TransitionConfig {
  if (!ui.justBuilt || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { duration: 0 }
  }
  return { duration: 200, css: (t) => `opacity: ${t}` }
}
