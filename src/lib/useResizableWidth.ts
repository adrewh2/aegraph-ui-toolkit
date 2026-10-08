import { useState, type PointerEvent as ReactPointerEvent } from 'react'

interface Options {
  /** localStorage key the width is remembered under. */
  storageKey: string
  initial: number
  min: number
  max: number
  /** Which edge carries the handle: `end` for a left rail (drag right to grow), `start` for a right rail (drag left to grow). */
  edge: 'start' | 'end'
  /** `y` resizes a height (a top pane's bottom edge) instead of a width. */
  axis?: 'x' | 'y'
}

/**
 * Drag-to-resize for side panes. Returns the width, a pointer-down handler
 * for the grab handle, and a reset for double-click. The width persists in
 * localStorage; `body.is-resizing` is set during the drag so canvases and
 * iframes don't swallow the pointer.
 */
export function useResizableWidth({ storageKey, initial, min, max, edge, axis = 'x' }: Options) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey))
      return v >= min && v <= max ? v : initial
    } catch {
      return initial // no storage (server render, private mode)
    }
  })
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const start = axis === 'y' ? e.clientY : e.clientX
    const startWidth = width
    const sign = edge === 'end' ? 1 : -1
    const move = (ev: PointerEvent) => setWidth(Math.max(min, Math.min(max, startWidth + sign * ((axis === 'y' ? ev.clientY : ev.clientX) - start))))
    const cls = axis === 'y' ? 'is-resizing-y' : 'is-resizing'
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove(cls)
      setWidth((w) => (localStorage.setItem(storageKey, String(w)), w))
    }
    document.body.classList.add(cls)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reset = () => {
    setWidth(initial)
    localStorage.setItem(storageKey, String(initial))
  }
  /** A width from elsewhere (a saved scene), clamped and remembered like a drag. */
  const set = (w: number) => {
    const v = Math.max(min, Math.min(max, w))
    setWidth(v)
    localStorage.setItem(storageKey, String(v))
  }
  return { width, onPointerDown, reset, setWidth: set }
}
