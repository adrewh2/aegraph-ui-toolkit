import type { EntityId, Relationship } from '../entity/types'

/**
 * Small graph algorithms over the slice's own representation (a node id set
 * and a relationship list). Everything here is O(V+E) and allocation-light so
 * it can run on every filter change without a worker.
 */

export type Direction = 'out' | 'in' | 'both'

/** Adjacency lists restricted to `ids`; `both` treats every edge as undirected. */
export function adjacency(ids: Set<EntityId>, edges: Relationship[], direction: Direction = 'both'): Map<EntityId, EntityId[]> {
  const adj = new Map<EntityId, EntityId[]>()
  const push = (a: EntityId, b: EntityId) => {
    const list = adj.get(a)
    if (list) list.push(b)
    else adj.set(a, [b])
  }
  for (const e of edges) {
    const s = e.source.id
    const t = e.target.id
    if (!ids.has(s) || !ids.has(t) || s === t) continue
    const undirected = direction === 'both' || !e.directed
    if (undirected || direction === 'out') push(s, t)
    if (undirected || direction === 'in') push(t, s)
  }
  return adj
}

export function degreesOf(edges: Relationship[]): Map<EntityId, number> {
  const m = new Map<EntityId, number>()
  for (const r of edges) {
    m.set(r.source.id, (m.get(r.source.id) ?? 0) + 1)
    m.set(r.target.id, (m.get(r.target.id) ?? 0) + 1)
  }
  return m
}

/** Nodes surviving iterative peeling of everything with degree < k (the k-core). k ≤ 0 keeps all. */
export function kCore(ids: Set<EntityId>, edges: Relationship[], k: number): Set<EntityId> {
  if (k <= 0) return new Set(ids)
  const adj = adjacency(ids, edges)
  const degree = new Map<EntityId, number>()
  for (const id of ids) degree.set(id, adj.get(id)?.length ?? 0)
  const alive = new Set(ids)
  const queue: EntityId[] = []
  for (const [id, d] of degree) if (d < k) queue.push(id)
  while (queue.length) {
    const id = queue.pop()!
    if (!alive.has(id)) continue
    alive.delete(id)
    for (const n of adj.get(id) ?? []) {
      if (!alive.has(n)) continue
      const d = (degree.get(n) ?? 0) - 1
      degree.set(n, d)
      if (d < k) queue.push(n)
    }
  }
  return alive
}

/** Connected components (undirected), largest first. Isolated nodes are singleton components. */
export function connectedComponents(ids: Set<EntityId>, edges: Relationship[]): EntityId[][] {
  const adj = adjacency(ids, edges)
  const seen = new Set<EntityId>()
  const out: EntityId[][] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    const comp: EntityId[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const id = stack.pop()!
      comp.push(id)
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n)
          stack.push(n)
        }
      }
    }
    out.push(comp)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** Every node within `n` hops of the seeds (seeds included), restricted to `ids`. */
export function hopsFrom(seeds: Iterable<EntityId>, ids: Set<EntityId>, edges: Relationship[], n: number, direction: Direction = 'both'): Set<EntityId> {
  const keep = new Set<EntityId>()
  let frontier: EntityId[] = []
  for (const s of seeds) {
    if (ids.has(s) && !keep.has(s)) {
      keep.add(s)
      frontier.push(s)
    }
  }
  if (n <= 0 || frontier.length === 0) return keep
  const adj = adjacency(ids, edges, direction)
  for (let d = 0; d < n && frontier.length; d++) {
    const next: EntityId[] = []
    for (const id of frontier) {
      for (const o of adj.get(id) ?? []) {
        if (!keep.has(o)) {
          keep.add(o)
          next.push(o)
        }
      }
    }
    frontier = next
  }
  return keep
}
