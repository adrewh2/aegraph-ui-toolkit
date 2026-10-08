import type { EntityId } from '../entity/types'
import { hopsFrom, type Direction } from './algorithms'
import type { GraphSlice } from './filter'

/**
 * The explorer's selection is an ordered id list: the last id is the
 * "primary" node (the one the inspector shows). All operations return a
 * new deduplicated list so React state stays immutable.
 */

export type SelectMode = 'replace' | 'add' | 'remove' | 'toggle'

export function applySelect(current: EntityId[], ids: EntityId[], mode: SelectMode = 'replace'): EntityId[] {
  if (!Array.isArray(ids)) ids = ids == null ? [] : [String(ids)]
  // `add` and `toggle` look ids up in the incoming list: a Set keeps a big selection linear, not quadratic.
  switch (mode) {
    case 'replace':
      return dedupe(ids)
    case 'add': {
      const incoming = new Set(ids)
      return dedupe([...current.filter((id) => !incoming.has(id)), ...ids])
    }
    case 'remove': {
      const drop = new Set(ids)
      return current.filter((id) => !drop.has(id))
    }
    case 'toggle': {
      // One pass: ids already selected leave, the rest join at the end (in the order given).
      const flip = new Set(ids)
      const kept = current.filter((id) => !flip.has(id))
      const had = new Set(current)
      return dedupe([...kept, ...ids.filter((id) => !had.has(id))])
    }
  }
}

export type SelectionOp =
  | { op: 'all' }
  | { op: 'none' }
  | { op: 'invert' }
  | { op: 'neighbours'; hops?: number; direction?: Direction }
  | { op: 'byType' }
  | { op: 'byTag' }

/** Derive a new selection from the current one and what is visible. */
export function selectionOp(current: EntityId[], slice: GraphSlice, op: SelectionOp): EntityId[] {
  const visible = slice.nodes
  switch (op.op) {
    case 'all':
      return visible.map((n) => n.id)
    case 'none':
      return []
    case 'invert': {
      const cur = new Set(current)
      return visible.filter((n) => !cur.has(n.id)).map((n) => n.id)
    }
    case 'neighbours': {
      const ids = new Set(visible.map((n) => n.id))
      const grown = hopsFrom(current, ids, slice.edges, op.hops ?? 1, op.direction ?? 'both')
      // Keep the current order first so the primary node stays put.
      return dedupe([...current.filter((id) => grown.has(id)), ...visible.filter((n) => grown.has(n.id)).map((n) => n.id)])
    }
    case 'byType': {
      const cur = new Set(current)
      const types = new Set(visible.filter((n) => cur.has(n.id)).map((n) => n.type))
      return visible.filter((n) => types.has(n.type)).map((n) => n.id)
    }
    case 'byTag': {
      const cur = new Set(current)
      const tags = new Set(visible.filter((n) => cur.has(n.id)).flatMap((n) => n.tags))
      if (tags.size === 0) return current
      return visible.filter((n) => n.tags.some((t) => tags.has(t))).map((n) => n.id)
    }
    default:
      // An op this version does not know (a script, the assistant): the selection stands rather than the view falling over.
      return current
  }
}

/** Drop ids that are no longer visible, keeping order. */
export function pruneSelection(ids: EntityId[], visible: Set<EntityId>): EntityId[] {
  let changed = false
  const out = ids.filter((id) => visible.has(id) || ((changed = true), false))
  return changed ? out : ids
}

function dedupe(ids: EntityId[]): EntityId[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<EntityId>()
  const out: EntityId[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
