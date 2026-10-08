import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'

export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

interface Options<T> {
  /** Scrollable container the rectangle is drawn in (content coordinates). */
  scrollRef: RefObject<HTMLElement | null>
  /** Selector for the selectable elements inside the container; each must carry `data-id`. */
  itemSelector: string
  selected: Set<T>
  onChange: (next: Set<T>) => void
  /** Elements the drag may start on (default: anything not interactive). */
  canStart?: (target: HTMLElement) => boolean
}

const THRESHOLD = 4
const EDGE = 28
const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable], [role=menuitem]'

/**
 * Rubber-band selection: press on empty space or a row and drag to draw a
 * shaded rectangle; everything it touches is selected. ⇧/⌘ keep the existing
 * selection. Drags shorter than a few pixels fall through as ordinary clicks.
 */
export function useMarquee<T extends string>({ scrollRef, itemSelector, selected, onChange, canStart }: Options<T>) {
  const [rect, setRect] = useState<MarqueeRect | null>(null)
  const drag = useRef<{ x: number; y: number; base: Set<T>; active: boolean; last: { cx: number; cy: number } } | null>(null)
  const suppressClick = useRef(false)
  const raf = useRef(0)
  const latest = useRef({ selected, onChange })
  useEffect(() => {
    latest.current = { selected, onChange }
  })

  const update = useCallback(
    (cx: number, cy: number) => {
      const el = scrollRef.current
      const d = drag.current
      if (!el || !d) return
      const bounds = el.getBoundingClientRect()
      // Content coordinates so the box stays put while the container scrolls.
      const px = cx - bounds.left + el.scrollLeft
      const py = cy - bounds.top + el.scrollTop
      const r = { left: Math.min(d.x, px), top: Math.min(d.y, py), width: Math.abs(px - d.x), height: Math.abs(py - d.y) }
      setRect(r)
      const next = new Set(d.base)
      const top = r.top - el.scrollTop + bounds.top
      const bottom = top + r.height
      const left = r.left - el.scrollLeft + bounds.left
      const right = left + r.width
      for (const item of el.querySelectorAll<HTMLElement>(itemSelector)) {
        const b = item.getBoundingClientRect()
        const id = item.dataset.id as T | undefined
        if (!id) continue
        if (b.bottom >= top && b.top <= bottom && b.right >= left && b.left <= right) next.add(id)
      }
      const cur = latest.current.selected
      if (next.size !== cur.size || [...next].some((id) => !cur.has(id))) latest.current.onChange(next)
    },
    [scrollRef, itemSelector],
  )

  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      const el = scrollRef.current
      if (!el || target.closest(INTERACTIVE) || (canStart && !canStart(target))) return
      const bounds = el.getBoundingClientRect()
      // Ignore presses on the scrollbars.
      if (e.clientX > bounds.left + el.clientWidth || e.clientY > bounds.top + el.clientHeight) return
      const keep = e.shiftKey || e.metaKey || e.ctrlKey
      drag.current = {
        x: e.clientX - bounds.left + el.scrollLeft,
        y: e.clientY - bounds.top + el.scrollTop,
        base: keep ? new Set(latest.current.selected) : new Set<T>(),
        active: false,
        last: { cx: e.clientX, cy: e.clientY },
      }
    },
    [scrollRef, canStart],
  )

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current
      const el = scrollRef.current
      if (!d || !el) return
      d.last = { cx: e.clientX, cy: e.clientY }
      if (!d.active) {
        const bounds = el.getBoundingClientRect()
        const dx = e.clientX - bounds.left + el.scrollLeft - d.x
        const dy = e.clientY - bounds.top + el.scrollTop - d.y
        if (Math.hypot(dx, dy) < THRESHOLD) return
        d.active = true
        suppressClick.current = true
        el.classList.add('is-marquee')
        // Auto-scroll while the pointer sits near (or past) an edge.
        const tick = () => {
          const dd = drag.current
          const c = scrollRef.current
          if (!dd?.active || !c) return
          const b = c.getBoundingClientRect()
          let sx = 0
          let sy = 0
          if (dd.last.cy > b.bottom - EDGE) sy = Math.min(24, (dd.last.cy - (b.bottom - EDGE)) / 2)
          else if (dd.last.cy < b.top + EDGE) sy = -Math.min(24, (b.top + EDGE - dd.last.cy) / 2)
          if (dd.last.cx > b.right - EDGE) sx = Math.min(24, (dd.last.cx - (b.right - EDGE)) / 2)
          else if (dd.last.cx < b.left + EDGE) sx = -Math.min(24, (b.left + EDGE - dd.last.cx) / 2)
          if (sx || sy) {
            c.scrollBy(sx, sy)
            update(dd.last.cx, dd.last.cy)
          }
          raf.current = requestAnimationFrame(tick)
        }
        raf.current = requestAnimationFrame(tick)
      }
      e.preventDefault()
      update(e.clientX, e.clientY)
    }
    const onUp = () => {
      const d = drag.current
      drag.current = null
      cancelAnimationFrame(raf.current)
      scrollRef.current?.classList.remove('is-marquee')
      if (d?.active) {
        setRect(null)
        // The click that follows mouseup would reset the selection; swallow it.
        setTimeout(() => (suppressClick.current = false), 0)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      cancelAnimationFrame(raf.current)
    }
  }, [scrollRef, update])

  /** True for the click that ends a drag; callers should ignore it. */
  const consumeClick = useCallback(() => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }, [])

  return { rect, onMouseDown, consumeClick }
}
