import { useLayoutEffect, useMemo, type RefObject } from 'react'

/**
 * Focus for anything modal — a dialog, the command palette: while it is open the keyboard stays in it, and when it
 * closes the keyboard is back where it was.
 *
 * - **In.** On open, focus moves inside: to what the dialog's own markup already focused (`autoFocus` — React focuses
 *   it as the element mounts, before this runs), else an element marked `data-autofocus`, else the first element Tab
 *   would reach, else the container itself (give it `tabIndex={-1}`).
 * - **Kept.** Tab from the last element goes to the first, Shift+Tab from the first to the last. Only keys pressed
 *   inside the container are its business: a dropdown or a picker opened from it lives in a portal of its own, with
 *   its own keys, and a dialog opened over it has its own trap.
 * - **Back.** On close, focus returns to the element that had it before opening — when it is still in the document and
 *   nothing else has taken focus meanwhile (a confirmation whose action moved the focus on keeps that move).
 */

/** What Tab can reach, before the checks a live element needs (disabled, hidden, `tabindex="-1"`). */
export const TABBABLE =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, audio[controls], video[controls], summary, [contenteditable]:not([contenteditable="false"]), [tabindex]'

/** The few things about an element that decide whether Tab stops on it — an interface, so tests need no DOM. */
export interface FocusCandidate {
  tabIndex: number
  hasAttribute(name: string): boolean
  getClientRects(): { length: number }
  closest?(selector: string): unknown
}

/** Whether Tab stops on an element: not disabled, not taken out of the order, rendered (a `display: none` element has no boxes). */
export function isTabbable(el: FocusCandidate): boolean {
  if (el.tabIndex < 0) return false
  if (el.hasAttribute('disabled') || el.hasAttribute('hidden') || el.hasAttribute('inert')) return false
  if (el.closest?.('[inert], fieldset[disabled]')) return false
  return el.getClientRects().length > 0
}

/** The elements Tab reaches inside `root`, in document order. */
export function tabbablesIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(isTabbable)
}

/**
 * Where Tab (or Shift+Tab) goes from `current` among `list`: the other end when it is at an end (or outside the list —
 * the container itself, a node that was removed), or `null` to let the browser take the ordinary step.
 * An empty list keeps the focus where it is: `'stay'`.
 */
export function wrapTab<T>(list: readonly T[], current: T | null, backwards: boolean): T | null | 'stay' {
  if (!list.length) return 'stay'
  const i = current === null ? -1 : list.indexOf(current)
  if (backwards) return i <= 0 ? list[list.length - 1] : null
  return i < 0 || i === list.length - 1 ? list[0] : null
}

/**
 * The element to focus when a trap opens: `null` when the focus is already inside (the markup's `autoFocus`), else
 * the one marked `data-autofocus`, else the first tabbable one, else the container.
 */
export function initialFocus<T>(container: T & { contains(n: unknown): boolean }, active: unknown, marked: T | null, tabbables: readonly T[]): T | null {
  if (active && active !== container && container.contains(active)) return null
  return marked ?? tabbables[0] ?? container
}

/**
 * Whether closing gives the focus back to `opener`: it is still in the document, and nothing else took the focus as
 * the trap closed — the focus is inside the container, or on the bare body the browser falls back to when the focused
 * node is removed.
 */
export function shouldRestore<T>(opener: (T & { isConnected: boolean }) | null, now: T | null, body: T | null, container: { contains(n: unknown): boolean }): opener is T & { isConnected: boolean } {
  if (!opener || opener === body || !opener.isConnected) return false
  return !now || now === body || container.contains(now)
}

/**
 * Keep the focus in `ref`'s element while `active`. Call it from the component that renders the container, with the
 * container mounted whenever `active` is true.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  // Who had the focus before: read while rendering the open state — by the time any effect runs, the markup's
  // `autoFocus` has already moved it.
  const opener = useMemo(() => (active && typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null), [active])

  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const target = initialFocus(el, document.activeElement, el.querySelector<HTMLElement>('[data-autofocus]'), tabbablesIn(el))
    target?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const next = wrapTab(tabbablesIn(el), document.activeElement as HTMLElement | null, e.shiftKey)
      if (next === null) return
      e.preventDefault()
      if (next !== 'stay') next.focus()
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (shouldRestore(opener, document.activeElement as HTMLElement | null, document.body, el)) opener.focus({ preventScroll: true })
    }
  }, [active, ref, opener])
}
