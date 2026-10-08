import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntityStore, StoreEvent } from '../../core/entity/store'
import type { AnyEntity, EntityId } from '../../core/entity/types'

/**
 * A table's rows kept by the store's events instead of queried again after every write. Renaming one entity in a
 * million-entity project queried the whole project, filtered it and sorted it again — seconds, for one row. A write
 * that only replaces entities already in the rows now gives the previous rows with those entries swapped
 * (`patchRows`), and says so (`patchOf`) so the table can move just those rows in its own order. Anything else — a
 * new member, a removal, a scope switch, a write that takes a row out of the query — is the query again.
 */

/** A rows array made from `prev` by replacing entries in place: `index` is where, in both. */
export interface RowPatch {
  prev: readonly AnyEntity[]
  changed: { index: number; before: AnyEntity; after: AnyEntity }[]
}

const patches = new WeakMap<readonly AnyEntity[], RowPatch>()
/** How `rows` was made from the rows before it, when it was made by a patch. */
export const patchOf = (rows: readonly AnyEntity[]): RowPatch | undefined => patches.get(rows)
/** Record that `rows` was made from `patch.prev` by `patch` (the table's own rows, patched the same way). */
export const notePatch = (rows: readonly AnyEntity[], patch: RowPatch) => void patches.set(rows, patch)

/** Each rows array's positions by id, built the first time a write needs them and shared by the patches made from it. */
const positions = new WeakMap<readonly AnyEntity[], Map<EntityId, number>>()
function positionsOf(rows: readonly AnyEntity[]): Map<EntityId, number> {
  let m = positions.get(rows)
  if (!m) {
    m = new Map()
    for (let i = 0; i < rows.length; i++) m.set(rows[i].id, i)
    positions.set(rows, m)
  }
  return m
}

/** Up to this many entities in one write are looked for by a scan of the rows rather than an index of them. */
const SCAN_UP_TO = 8
/** Past this many entities in one write, the query again is as cheap as the patch and simpler. */
const PATCH_LIMIT = 5000

/**
 * The rows after a write: the same array (nothing in it changed), a patched copy, or `'query'` — the write may change
 * which entities belong, so query again. `belongs` says whether an entity is one the query would return now.
 */
export function patchRows(rows: readonly AnyEntity[], ev: StoreEvent, belongs: (e: AnyEntity) => boolean): readonly AnyEntity[] | 'query' {
  const written: AnyEntity[] = []
  const collect = (e: StoreEvent): boolean => {
    switch (e.type) {
      case 'upsert':
        for (const x of e.entities) written.push(x)
        return true
      case 'batch':
        return e.events.every(collect)
      case 'rejected':
      case 'tags':
        return true
      // A removal, a reset or a scope switch changes who belongs.
      default:
        return false
    }
  }
  if (!collect(ev) || written.length > PATCH_LIMIT) return 'query'
  if (!written.length) return rows
  // A few entities are found by a scan (a million references compared in a millisecond or two); many, by an index of
  // the rows built once and shared by the patches made from them — building it inside a single rename was the cost.
  const at = written.length > SCAN_UP_TO || positions.has(rows) ? positionsOf(rows) : undefined
  const find = (id: EntityId): number | undefined => {
    if (at) return at.get(id)
    for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return i
    return undefined
  }
  const changed: RowPatch['changed'] = []
  for (const after of written) {
    const index = find(after.id)
    if (index === undefined) {
      // Not in the rows: a new member makes the query again; anything else (another type, another project) is not ours.
      if (belongs(after)) return 'query'
      continue
    }
    const before = rows[index]
    if (before === after) continue
    if (!belongs(after)) return 'query'
    changed.push({ index, before, after })
  }
  if (!changed.length) return rows
  const next = rows.slice()
  for (const c of changed) next[c.index] = c.after
  if (at) positions.set(next, at)
  patches.set(next, { prev: rows, changed })
  return next
}

/**
 * `query()` once per `deps`, then kept by the store's events: a write that only replaces rows already there patches
 * them (`patchRows`), one that may change who belongs queries again. `belongs` is read at the time of each write.
 */
export function useLiveRows(store: EntityStore, query: () => AnyEntity[], deps: readonly unknown[], belongs: (e: AnyEntity) => boolean): readonly AnyEntity[] {
  const [again, setAgain] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queried = useMemo(query, [...deps, again])
  const [patched, setPatched] = useState<{ base: readonly AnyEntity[]; rows: readonly AnyEntity[] } | null>(null)
  const rows = patched && patched.base === queried ? patched.rows : queried
  const live = useRef({ rows, queried, belongs })
  live.current = { rows, queried, belongs }
  useEffect(
    () =>
      store.subscribe((ev) => {
        const { rows, queried, belongs } = live.current
        const next = patchRows(rows, ev, belongs)
        if (next === 'query') setAgain((n) => n + 1)
        else if (next !== rows) {
          live.current = { ...live.current, rows: next }
          setPatched({ base: queried, rows: next })
        }
      }),
    [store],
  )
  return rows
}
