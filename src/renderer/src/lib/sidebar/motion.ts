export const reduceMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
export const slideMs = reduceMotion ? 0 : 180
