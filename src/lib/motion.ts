/**
 * Whether the person has asked their system for less motion (`prefers-reduced-motion: reduce`). CSS transitions and
 * animations are cut to nothing by one rule in `src/index.css`; what moves from script — a camera's flight, a smooth
 * scroll — asks this and jumps instead. Read at the moment of the move, so a change of the setting applies to the
 * next one; false wherever there is no `matchMedia` (Node, the headless engine, tests).
 */
let query: MediaQueryList | null | undefined

export function prefersReducedMotion(): boolean {
  if (query === undefined) {
    try {
      query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    } catch {
      query = null
    }
  }
  return !!query?.matches
}

/** The `behavior` for `scrollBy` / `scrollIntoView`: smooth, unless less motion was asked for. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth')

/** Forget the cached query (tests). */
export function resetMotionQuery() {
  query = undefined
}
