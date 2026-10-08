import type { EntityStore } from '../../core/entity/store'
import type { Relationship } from '../../core/entity/types'
import type { ProjectionData } from '../../core/graph/projection'

/** Every relationship between the entities a projection places. */
export function relsAmong(store: EntityStore, data: ProjectionData): Relationship[] {
  const placed = new Set(Object.keys(data.nodes))
  const out: Relationship[] = []
  const seen = new Set<string>()
  for (const id of placed)
    for (const r of store.relationshipsOf(id)) {
      if (seen.has(r.id) || !placed.has(r.source.id) || !placed.has(r.target.id)) continue
      seen.add(r.id)
      out.push(r)
    }
  return out
}
