import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { BASE_FIELDS } from '../../core/entity/schema'
import { datasetGraph } from '../../core/graph/dataset'
import { sliceKey } from '../../core/graph/metrics/serialize'
import type { AnalysisInput, SchemaType } from '../../analysis/types'

const BASE_KEYS = new Set(BASE_FIELDS.map((f) => f.key))

/**
 * One pass over the store into the columnar input the analyses read.
 * The store is already scoped to the open project, so the dataset is
 * whatever the graph views would show; graph/schema types stay out.
 */
export function buildAnalysisInput(store: EntityStore, registry: TypeRegistry): AnalysisInput {
  const { nodes, edges } = datasetGraph(store, registry)
  const n = nodes.length
  const index = new Map<string, number>()
  const ids = new Array<string>(n)
  const types = new Array<string>(n)
  const labels = new Array<string>(n)
  const tags = new Array<string[]>(n)
  const props = new Array<string[]>(n)
  const created = new Float64Array(n)
  const updated = new Float64Array(n)
  nodes.forEach((e, i) => {
    index.set(e.id, i)
    ids[i] = e.id
    types[i] = e.type
    labels[i] = displayLabel(e)
    tags[i] = e.tags
    const keys: string[] = []
    for (const k in e.data) {
      const v = e.data[k]
      if (v === undefined || v === null || v === '' || BASE_KEYS.has(k)) continue
      if (Array.isArray(v) && !v.length) continue
      keys.push(k)
    }
    props[i] = keys
    created[i] = stamp(e.meta.createdAt)
    updated[i] = stamp(e.meta.updatedAt)
  })
  const m = edges.length
  const src = new Uint32Array(m)
  const dst = new Uint32Array(m)
  const directed = new Uint8Array(m)
  const edgeTypes = new Array<string>(m)
  const edgeIds = new Array<string>(m)
  edges.forEach((r, j) => {
    src[j] = index.get(r.source.id)!
    dst[j] = index.get(r.target.id)!
    directed[j] = r.directed ? 1 : 0
    edgeTypes[j] = r.type
    edgeIds[j] = r.id
  })
  const schema: SchemaType[] = registry
    .all()
    .filter((t) => t.kind !== 'relationship' && t.category !== 'project' && t.category !== 'schema')
    .map((t) => ({ type: t.type, label: t.label, category: t.category, parent: t.parent, properties: [...new Set([...t.fields.map((f) => f.key).filter((k) => k.startsWith('data.')).map((k) => k.slice(5)), ...registry.propertiesOf(t.type).map((p) => p.key)])], declared: t.origin !== 'inferred' }))
  const project = store.scope ? store.get(store.scope) : undefined
  return { ids, types, labels, tags, props, created, updated, src, dst, directed, edgeTypes, edgeIds, schema, scope: { label: project ? displayLabel(project) : 'Library', projectId: project?.id }, key: sliceKey({ nodes, edges }) }
}

const stamp = (iso: string | undefined): number => {
  if (!iso) return NaN
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : NaN
}
