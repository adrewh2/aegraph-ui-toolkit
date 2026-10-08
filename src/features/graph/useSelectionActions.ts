import { browserHref, graphHref } from '../../app/openIn'
import { useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { displayLabel } from '../../core/entity/entity'
import { useOpenInTab } from '../workstation/paneContext'
import { useToast } from '../../components/ui/useToast'
import { parseTags } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { entitiesToDocument } from '../../core/exchange/subset'
import { downloadText } from '../../lib/download'
import { useExplorer } from './explorerState'

/**
 * Everything that can be done to a set of nodes, shared by the selection bar,
 * the selection panel, keyboard shortcuts, and the assistant handle so the
 * behaviour is identical wherever it's triggered.
 */
export function useSelectionActions() {
  const store = useEntityStore()
  const toast = useToast()
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const { mode } = useParams()
  const { state, dispatch, slice, selectOp, primary } = useExplorer()
  const ids = state.selectedIds

  const tag = useCallback(
    (targets: EntityId[], tags: string[], on: boolean) => {
      const clean = parseTags(tags)
      if (!clean.length || !targets.length) return 0
      let n = 0
      store.transaction(() => {
        for (const id of targets) {
          const e = store.get(id)
          if (!e) continue
          const next = on ? parseTags([...e.tags, ...clean]) : e.tags.filter((t) => !clean.includes(t))
          if (next.length !== e.tags.length || next.some((t, i) => t !== e.tags[i])) {
            store.update(id, { tags: next })
            n++
          }
        }
      })
      toast(`${on ? 'Tagged' : 'Untagged'} ${n} node${n === 1 ? '' : 's'}`)
      return n
    },
    [store, toast],
  )

  const hide = useCallback(
    (targets: EntityId[]) => {
      if (!targets.length) return
      const exclude = [...new Set([...(state.filter.exclude ?? []), ...targets])]
      dispatch({ type: 'patchFilter', patch: { exclude } })
      dispatch({ type: 'select', ids: targets, mode: 'remove' })
      toast(`Hid ${targets.length} node${targets.length === 1 ? '' : 's'} — Filter › Hidden to restore`)
    },
    [state.filter.exclude, dispatch, toast],
  )

  const unhide = useCallback(
    (targets?: EntityId[]) => {
      const exclude = targets ? (state.filter.exclude ?? []).filter((id) => !targets.includes(id)) : []
      dispatch({ type: 'patchFilter', patch: { exclude } })
    },
    [state.filter.exclude, dispatch],
  )

  const pin = useCallback((targets: EntityId[], on: boolean) => dispatch({ type: 'pin', ids: targets, on }), [dispatch])

  const focus = useCallback(
    (targets: EntityId[], depth?: number) => {
      if (!targets.length) return
      dispatch({ type: 'patchFilter', patch: { roots: targets, depth: depth ?? (state.filter.roots?.length ? state.filter.depth : 1) } })
      toast(targets.length === 1 ? 'Focused on neighbourhood' : `Focused on ${targets.length} nodes`)
    },
    [dispatch, state.filter.roots, state.filter.depth, toast],
  )

  const remove = useCallback(
    (targets: EntityId[]) => {
      if (!targets.length) return
      store.remove(targets)
      dispatch({ type: 'select', ids: targets, mode: 'remove' })
      toast(`Deleted ${targets.length} node${targets.length === 1 ? '' : 's'}`)
    },
    [store, dispatch, toast],
  )

  const exportJson = useCallback(
    (targets: EntityId[]) => {
      const rows = targets.map((id) => store.get(id)).filter((e): e is NonNullable<typeof e> => !!e)
      downloadText(`selection-${rows.length}.ae.json`, JSON.stringify(entitiesToDocument(store, rows), null, 2))
    },
    [store],
  )

  const addPathToSelection = useCallback(() => {
    if (state.path) dispatch({ type: 'select', ids: state.path.nodes, mode: 'add' })
  }, [state.path, dispatch])

  const open = useCallback(
    (id: EntityId) => {
      const e = store.get(id)
      if (e) navigate(browserHref(e))
    },
    [store, navigate],
  )

  /** A new Unigraph tab of just these entities: a fresh filter restricted to them, in the same 2D/3D mode. */
  const openInNewGraph = useCallback(
    (targets: EntityId[]) => {
      if (!targets.length) return
      const first = store.get(targets[0])
      const label = targets.length === 1 && first ? displayLabel(first) : `${targets.length} entities`
      openTab(graphHref(targets, label, mode === '3d' ? '3d' : '2d', true), label)
    },
    [store, openTab, mode],
  )

  /** Everything linked to these nodes that the view does not show: what “add linked entities” would bring in. */
  const linkedMissing = useCallback(
    (targets: EntityId[]) => {
      const shown = new Set(slice.nodes.map((n) => n.id))
      const hidden = new Set(state.filter.exclude ?? [])
      const out = new Set<EntityId>()
      for (const id of targets) {
        for (const r of store.relationshipsOf(id)) {
          const other = r.source.id === id ? r.target.id : r.source.id
          if (other !== id && !shown.has(other) && !hidden.has(other) && store.get(other)?.kind === 'entity') out.add(other)
        }
      }
      return [...out]
    },
    [store, slice.nodes, state.filter.exclude],
  )

  /** Bring the linked entities into the view: they go on the filter's include list, kept whatever the other criteria say. */
  const addLinked = useCallback(
    (targets: EntityId[]) => {
      const missing = linkedMissing(targets)
      if (!missing.length) {
        toast('Everything linked is already in view')
        return 0
      }
      const include = [...new Set([...(state.filter.include ?? []), ...missing])]
      dispatch({ type: 'patchFilter', patch: { include } })
      toast(`Added ${missing.length} linked entit${missing.length === 1 ? 'y' : 'ies'} — Filter › Added to remove`)
      return missing.length
    },
    [linkedMissing, state.filter.include, dispatch, toast],
  )

  return useMemo(
    () => ({
      ids,
      primary,
      count: ids.length,
      allPinned: ids.length > 0 && ids.every((id) => state.pinned.includes(id)),
      tag,
      hide,
      unhide,
      pin,
      focus,
      remove,
      exportJson,
      addPathToSelection,
      open,
      openInNewGraph,
      linkedMissing,
      addLinked,
      clear: () => dispatch({ type: 'select', ids: [], mode: 'replace' }),
      selectAll: () => selectOp({ op: 'all' }),
      invert: () => selectOp({ op: 'invert' }),
      neighbours: (hops = 1) => selectOp({ op: 'neighbours', hops }),
      byType: () => selectOp({ op: 'byType' }),
      byTag: () => selectOp({ op: 'byTag' }),
      visibleCount: slice.nodes.length,
    }),
    [ids, primary, state.pinned, tag, hide, unhide, pin, focus, remove, exportJson, addPathToSelection, open, openInNewGraph, linkedMissing, addLinked, dispatch, selectOp, slice.nodes.length],
  )
}
