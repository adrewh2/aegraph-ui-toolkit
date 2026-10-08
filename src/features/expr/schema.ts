import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { isRelationship } from '../../core/entity/types'

/**
 * What the expression editor knows about the data, so it can complete
 * `e.data.` with the properties entities of a type actually carry (kind,
 * how many carry it, a sample), a relationship helper's argument with the
 * relationship types (and what they join), `e.type ===` with the types,
 * and tags. Built from a sample per type, so it is cheap even on a large
 * store; rebuilt when the store's data changes.
 */

export interface PropertyInfo {
  key: string
  /** The kind seen most (string, number, boolean, date, array, object) or the declared one. */
  kind: string
  /** Share of the type's entities carrying it, 0–1. */
  coverage: number
  sample?: string
  description?: string
  declared: boolean
  /** The distinct scalar values seen when there are few (a categorical property), most common first — plus the declared options. */
  values?: string[]
}

export interface RelTypeInfo {
  type: string
  count: number
  /** The (source → target) type pairs seen, most common first. */
  pairs: string[]
  /** The types seen at each end. */
  sources: string[]
  targets: string[]
}

export interface ExprSchema {
  types: { type: string; label: string; count: number; kind: 'entity' | 'relationship' }[]
  /** Properties by type — entity types, and relationship types for what their `data` carries. */
  properties: Map<string, PropertyInfo[]>
  relationshipTypes: RelTypeInfo[]
  tags: string[]
}

const SAMPLE = 300
/** A property with at most this many distinct values in the sample is categorical: its values are offered. */
const VALUES = 24
const ISO_LIKE = /^\d{4}-\d\d-\d\d(T|$)/

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'string' ? (ISO_LIKE.test(v) ? 'date' : 'string') : typeof v === 'object' ? 'object' : typeof v)
const brief = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? '' : s.length > 40 ? s.slice(0, 37) + '…' : s
}

export function buildExprSchema(store: EntityStore, registry: TypeRegistry): ExprSchema {
  const types: ExprSchema['types'] = []
  const properties = new Map<string, PropertyInfo[]>()
  for (const t of registry.all()) {
    if (t.type === 'schema:type') continue
    const all = store.ofType(t.type)
    const isRel = t.kind === 'relationship' || (all.length > 0 && all.every(isRelationship))
    if (!all.length && t.origin === 'inferred') continue
    types.push({ type: t.type, label: t.label, count: all.length, kind: isRel ? 'relationship' : 'entity' })
    const declared = new Map<string, { kind: string; description?: string; options?: string[] }>()
    for (const f of registry.fieldsFor(t.type)) if (f.key.startsWith('data.')) declared.set(f.key.slice(5), { kind: f.kind, description: f.description, options: f.options?.map((o) => o.value) })
    const acc = new Map<string, { count: number; kinds: Map<string, number>; sample?: string; values: Map<string, number> | null }>()
    const step = Math.max(1, Math.floor(all.length / SAMPLE))
    let n = 0
    for (let i = 0; i < all.length; i += step) {
      const e = all[i]
      n++
      for (const k in e.data) {
        const v = e.data[k]
        if (v === undefined) continue
        let a = acc.get(k)
        if (!a) acc.set(k, (a = { count: 0, kinds: new Map(), values: new Map() }))
        a.count++
        const kind = kindOf(v)
        a.kinds.set(kind, (a.kinds.get(kind) ?? 0) + 1)
        if (a.sample === undefined && v !== null && typeof v !== 'object') a.sample = brief(v)
        // Distinct scalar values, until there are too many to be a category.
        if (a.values && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
          const key = String(v)
          a.values.set(key, (a.values.get(key) ?? 0) + 1)
          if (a.values.size > VALUES) a.values = null
        } else if (a.values && v !== null) a.values = null
      }
    }
    const list: PropertyInfo[] = [...acc].map(([key, a]) => {
      const seen = [...a.kinds].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'string'
      const d = declared.get(key)
      const values = [...new Set([...(d?.options ?? []), ...(a.values ? [...a.values].sort((x, y) => y[1] - x[1]).map(([v]) => v) : [])])]
      return { key, kind: d?.kind ?? seen, coverage: n ? a.count / n : 0, sample: a.sample, description: d?.description, declared: !!d, ...(values.length && (a.values || d?.options?.length) ? { values } : {}) }
    })
    for (const [key, d] of declared) if (!acc.has(key)) list.push({ key, kind: d.kind, coverage: 0, description: d.description, declared: true, ...(d.options?.length ? { values: d.options } : {}) })
    list.sort((a, b) => b.coverage - a.coverage || a.key.localeCompare(b.key))
    properties.set(t.type, list)
  }
  types.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  // Relationship types with the type pairs they join, from a sample of each.
  const pairsBy = new Map<string, Map<string, number>>()
  const counts = new Map<string, number>()
  const rels = store.relationships()
  const rstep = Math.max(1, Math.floor(rels.length / 5000))
  for (const r of rels) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
  for (let i = 0; i < rels.length; i += rstep) {
    const r = rels[i]
    const s = store.get(r.source.id)?.type
    const t = store.get(r.target.id)?.type
    if (!s || !t) continue
    const m = pairsBy.get(r.type) ?? new Map<string, number>()
    const k = `${s} → ${t}`
    m.set(k, (m.get(k) ?? 0) + 1)
    pairsBy.set(r.type, m)
  }
  const relationshipTypes: RelTypeInfo[] = [...counts]
    .map(([type, count]) => {
      const sorted = [...(pairsBy.get(type) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([k]) => k)
      const ends = sorted.map((k) => k.split(' → '))
      return { type, count, pairs: sorted.slice(0, 4), sources: [...new Set(ends.map((e) => e[0]))], targets: [...new Set(ends.map((e) => e[1]))] }
    })
    .sort((a, b) => b.count - a.count)
  return { types, properties, relationshipTypes, tags: store.tags() }
}
