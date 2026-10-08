import type { EntityStore } from '../entity/store'
import type { TypeRegistry } from '../entity/typeRegistry'
import { isRelationship, type AnyEntity, type Relationship } from '../entity/types'

/** The whole browsable graph: every entity outside the `project` and `schema` categories, and the relationships among them. */
export function datasetGraph(store: EntityStore, registry: TypeRegistry, members?: Set<string>): { nodes: AnyEntity[]; edges: Relationship[] } {
  const nodes: AnyEntity[] = []
  for (const e of store.all()) {
    if (isRelationship(e)) continue
    if (members && !members.has(e.id)) continue
    const cat = registry.categoryOf(e.type)
    if (cat === 'project' || cat === 'schema') continue
    nodes.push(e)
  }
  const ids = new Set(nodes.map((n) => n.id))
  const edges = store.relationships().filter((r) => ids.has(r.source.id) && ids.has(r.target.id) && (!members || members.has(r.id)))
  return { nodes, edges }
}

/**
 * Order-independent fingerprint of a node/edge set, for dataset-scope
 * analysis staleness. Deliberately not the store version: editing a label
 * or saving a layout must not invalidate an analysis; adding or removing
 * nodes or edges must.
 */
export function datasetKeyOf(g: { nodes: { id: string }[]; edges: { id: string }[] }): string {
  let acc = 0
  const fold = (s: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    acc = (acc + h) >>> 0
  }
  for (const n of g.nodes) fold(n.id)
  for (const e of g.edges) fold(`e:${e.id}`)
  return `dataset:${g.nodes.length}:${g.edges.length}:${acc.toString(16)}`
}
