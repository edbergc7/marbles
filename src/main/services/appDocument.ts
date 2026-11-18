// Shared by the in-app frame (appframe.ts) and the standalone export (exporter.ts).
// Dependency-free so it can be tested directly with node.

/** Strips characters that could break out of a <style> block. */
function safeCssValue(s: string): string {
  return s.replace(/[<>{};"'\\]/g, '')
}

/** design.css plus the accent color, as <style> tags that generated CSS cannot close early. */
export function styleTags(css: string, accent: string): string {
  return (
    `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>` +
    `<style>:root{--accent:${safeCssValue(accent)}}</style>`
  )
}

export function scriptTag(js: string): string {
  return `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
}

/**
 * Puts `head` ahead of everything in the generated HTML, inside an <html><head> of our own.
 * The generated HTML is never searched for a place to put it: a "<head>" inside a comment or
 * a string would otherwise swallow the shim, and the app would run without it. The parser
 * merges the app's own <html> attributes into ours and moves its <head> content into our head.
 * `theme` replaces any data-theme on <html>; null removes it, so design.css follows
 * prefers-color-scheme.
 */
export function wrapAppDocument(
  html: string,
  head: string,
  theme: 'light' | 'dark' | null
): string {
  const themeAttr = theme ? ` data-theme="${theme}"` : ''
  const rest = html
    // Ours comes first; a second doctype would only be a parse error.
    .replace(/^\uFEFF?\s*<!doctype[^>]*>/i, '')
    // Cosmetic only: without this an app's own data-theme would apply when `theme` is null.
    .replace(/<html(\s[^>]*)?>/i, (_m, attrs: string | undefined) => {
      const kept = (attrs ?? '').replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      return `<html${kept}>`
    })
  return `<!doctype html><html${themeAttr}><head>${head}</head>${rest}`
}
