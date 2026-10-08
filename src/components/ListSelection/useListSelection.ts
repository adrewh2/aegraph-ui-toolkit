import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useViewActiveRef } from '../../features/workstation/paneContext'
import type { EntityId } from '../../core/entity/types'
import { useMarquee } from '../../features/resources/useMarquee'

/**
 * Multi-selection for the card and list indexes (Documents, Images, Videos,
 * Audio, Diagrams), matching the Library table: drag on empty space or across
 * items to rubber-band, ⌘/Ctrl-click to toggle, ⇧-click to extend, a press on
 * empty space or Esc to clear, ⌘A to select all, Delete to delete. A plain click still opens the
 * item. Items carry `data-id`; the page root carries `ref` and `onMouseDown`.
 */
/** Where a rubber band may start and a press lets the selection go: inside the page, off its header and filters. */
const onEmptySpace = (t: HTMLElement) => !!t.closest('[data-sel-root]') && !t.closest('.di__head, .di__filters, .di__crumbs, .di__layout, .di__search')
const INTERACTIVE = 'input, textarea, select, button, a, label, [contenteditable], [role=menuitem], [role=dialog]'

export function useListSelection(ids: EntityId[], onDeleteRequest?: (ids: EntityId[]) => void) {
  const rootRef = useRef<HTMLDivElement>(null)
  // The scroll container is state, not a ref, so the returned bundle holds no refs (the compiler lint would
  // otherwise flag every `sel.x` read during render).
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const scrollRef = useMemo(() => ({ current: scrollEl }), [scrollEl])
  const [rawSelected, setSelected] = useState<Set<EntityId>>(() => new Set())
  const lastIndex = useRef<number | null>(null)

  // The marquee draws in the coordinates of whatever scrolls this page: the app main, or a workstation pane.
  useLayoutEffect(() => {
    let el: HTMLElement | null = rootRef.current
    while (el && el !== document.body) {
      const o = getComputedStyle(el).overflowY
      if (o === 'auto' || o === 'scroll') break
      el = el.parentElement
    }
    setScrollEl(el ?? document.documentElement)
  }, [])

  // Drop selections for items that disappeared (deleted, filtered out) — derived during render, no extra pass.
  const present = useMemo(() => new Set(ids), [ids])
  const live = useMemo(() => {
    if (!rawSelected.size) return rawSelected
    const kept = [...rawSelected].filter((id) => present.has(id))
    return kept.length === rawSelected.size ? rawSelected : new Set(kept)
  }, [rawSelected, present])
  const selected = live
  const latest = useRef({ ids, selected, onDeleteRequest })
  useEffect(() => {
    latest.current = { ids, selected, onDeleteRequest }
  })

  const marquee = useMarquee<EntityId>({
    scrollRef,
    itemSelector: '[data-sel-root] [data-id]',
    selected,
    onChange: setSelected,
    canStart: onEmptySpace,
  })

  // A plain press on empty space — not a row, not a control, not the page's header or filters — lets the selection
  // go, at once: without it a selection made by dragging had no way back but Esc. A drag from there still draws a
  // fresh rubber band; ⇧ or ⌘ keep what is selected.
  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      const t = e.target as HTMLElement
      if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && latest.current.selected.size && onEmptySpace(t) && !t.closest('[data-id]') && !t.closest(INTERACTIVE)) setSelected(new Set())
      marquee.onMouseDown(e)
    },
    [marquee],
  )

  /** Call from an item's click handler. Returns true when the click was a selection gesture (so the caller should not open). */
  const click = useCallback(
    (e: ReactMouseEvent, id: EntityId, index: number): boolean => {
      if (marquee.consumeClick()) return true
      const cur = latest.current.selected
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(cur)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        lastIndex.current = index
        setSelected(next)
        return true
      }
      if (e.shiftKey) {
        const next = new Set(cur)
        const from = lastIndex.current ?? index
        const [a, b] = [from, index].sort((x, y) => x - y)
        for (let i = a; i <= b; i++) if (latest.current.ids[i]) next.add(latest.current.ids[i])
        setSelected(next)
        return true
      }
      lastIndex.current = index
      if (cur.size) setSelected(new Set())
      return false
    },
    [marquee],
  )

  const viewActive = useViewActiveRef()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      if (t && (t.closest('input, textarea, select, [contenteditable]') || t.closest('[role=dialog]'))) return
      const { selected: cur, ids: all, onDeleteRequest: del } = latest.current
      const inside = !!rootRef.current && (rootRef.current.contains(t) || t === document.body)
      if (e.key === 'Escape' && cur.size) {
        setSelected(new Set())
        e.preventDefault()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && inside && (cur.size || t === document.body || rootRef.current?.contains(t))) {
        setSelected(new Set(all))
        e.preventDefault()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && cur.size && del) {
        del([...cur])
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const clear = useCallback(() => setSelected(new Set()), [])
  const isSelected = useCallback((id: EntityId) => selected.has(id), [selected])

  const sel = { scrollEl, selected, setSelected, clear, isSelected, click, onMouseDown, marqueeRect: marquee.rect }
  return { rootRef, sel }
}

export type ListSelection = ReturnType<typeof useListSelection>['sel']
