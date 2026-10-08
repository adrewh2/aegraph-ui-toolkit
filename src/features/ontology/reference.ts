import { CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { BASE_FIELDS, type FieldDef, type FieldKind } from '../../core/entity/schema'
import type { EntityStore } from '../../core/entity/store'
import type { ResolvedType, TypeRegistry } from '../../core/entity/typeRegistry'
import type { EntityId } from '../../core/entity/types'

/**
 * The schema reference: the whole vocabulary of the open dataset, written
 * out — every entity type the registry knows (built in, defined in the
 * data, or inferred), with or without instances, its properties declared
 * and observed; and every relationship type with the enumeration of the
 * type pairs it connects and the cardinality each pair shows in the data.
 *
 * Cardinality is observed, not declared (nothing declares it yet): for a
 * (source type, relationship, target type) triple, if no source instance
 * has more than one such target it is "one" on that side, else "many"; the
 * same for targets. So `person —worksAt→ organization` reads N:1 when
 * every person works at one organisation and organisations employ many.
 */

export type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M'

export interface PropertyRef {
  key: string
  label: string
  kind?: FieldKind
  required?: boolean
  options?: string[]
  description?: string
  /** Declared on this type, on a parent (named), or only seen in the data. */
  declaredOn?: string
  /** Entities of the type carrying the key. */
  count: number
}

export interface TypeRef {
  type: string
  label: string
  pluralLabel: string
  category: TypeCategory
  color?: string
  description?: string
  origin: ResolvedType['origin']
  parent?: string
  children: string[]
  count: number
  properties: PropertyRef[]
}

export interface PairRef {
  source: string
  target: string
  count: number
  /** Every relationship in the pair was directed. */
  directed: boolean
  /** Distinct source / target instances taking part. */
  sources: number
  targets: number
  /** The most targets one source has, and the most sources one target has. */
  maxOut: number
  maxIn: number
  cardinality: Cardinality
}

export interface RelationshipRef {
  rel: string
  label: string
  color?: string
  description?: string
  origin: ResolvedType['origin']
  count: number
  pairs: PairRef[]
}

export interface SchemaReference {
  types: TypeRef[]
  relationships: RelationshipRef[]
  byCategory: { category: TypeCategory; types: TypeRef[] }[]
  totals: { types: number; withInstances: number; relationshipTypes: number; pairs: number; entities: number; relationships: number }
}

const TYPE_TYPE = 'schema:type'
const SEP = ' :: '
const BASE_KEYS = new Set(BASE_FIELDS.map((f) => f.key))

const propKey = (f: FieldDef) => (f.key.startsWith('data.') ? f.key.slice(5) : f.key)

// The last reference per store: the panel revisited reads it back rather than counting every entity's keys again.
const referenceCache = new WeakMap<EntityStore, { key: string; registry: TypeRegistry; ref: SchemaReference }>()

export function schemaReference(store: EntityStore, registry: TypeRegistry): SchemaReference {
  const key = `${store.dataVersion}|${store.scope ?? ''}`
  const hit = referenceCache.get(store)
  if (hit && hit.key === key && hit.registry === registry) return hit.ref
  const ref = computeSchemaReference(store, registry)
  referenceCache.set(store, { key, registry, ref })
  return ref
}

function computeSchemaReference(store: EntityStore, registry: TypeRegistry): SchemaReference {
  // ── Properties observed per type ──
  const observed = new Map<string, Map<string, number>>()
  let entities = 0
  for (const e of store.all()) {
    if (e.kind !== 'entity' || e.type === TYPE_TYPE) continue
    entities++
    let m = observed.get(e.type)
    if (!m) observed.set(e.type, (m = new Map()))
    for (const k of Object.keys(e.data)) if (e.data[k] !== undefined) m.set(k, (m.get(k) ?? 0) + 1)
  }

  // ── Entity types: everything the registry knows, instances or not ──
  const all = registry.all().filter((t) => t.kind !== 'relationship' && t.type !== TYPE_TYPE && t.type !== '__relationship__')
  const childrenOf = new Map<string, string[]>()
  for (const t of all) if (t.parent) childrenOf.set(t.parent, [...(childrenOf.get(t.parent) ?? []), t.type])
  const types: TypeRef[] = all.map((t) => {
    const seen = observed.get(t.type) ?? new Map<string, number>()
    const props = new Map<string, PropertyRef>()
    // Declared: the type's own fields, then each ancestor's (first declaration wins, as in the registry).
    let cur: ResolvedType | undefined = t
    const walked = new Set<string>()
    while (cur && !walked.has(cur.type)) {
      walked.add(cur.type)
      for (const f of cur.fields) {
        if (BASE_KEYS.has(f.key)) continue
        const key = propKey(f)
        if (props.has(key)) continue
        props.set(key, { key, label: f.label, kind: f.kind, required: f.required, options: f.options?.map((o) => o.value), description: f.description, declaredOn: cur.type, count: seen.get(key) ?? 0 })
      }
      cur = cur.parent ? registry.get(cur.parent) : undefined
    }
    // Observed only: keys the entities carry that nothing declares.
    for (const [key, count] of seen) if (!props.has(key)) props.set(key, { key, label: key, count })
    const properties = [...props.values()].sort((a, b) => Number(!a.declaredOn) - Number(!b.declaredOn) || b.count - a.count || a.key.localeCompare(b.key))
    return { type: t.type, label: t.label, pluralLabel: t.pluralLabel, category: t.category, color: t.color, description: t.description, origin: t.origin, parent: t.parent, children: (childrenOf.get(t.type) ?? []).sort(), count: t.count, properties }
  })
  types.sort((a, b) => a.label.localeCompare(b.label))

  // ── Relationship types: every pair of types each connects, with cardinality ──
  const typeOf = new Map<EntityId, string>()
  const kindOf = (id: EntityId) => {
    let t = typeOf.get(id)
    if (t === undefined) {
      const e = store.get(id)
      t = e ? (e.kind === 'relationship' ? `(${e.type})` : e.type) : ''
      typeOf.set(id, t)
    }
    return t
  }
  interface Acc {
    source: string
    target: string
    count: number
    directed: boolean
    out: Map<EntityId, number>
    in: Map<EntityId, number>
  }
  const byRel = new Map<string, Map<string, Acc>>()
  let relationships = 0
  for (const r of store.relationships()) {
    const s = kindOf(r.source.id)
    const t = kindOf(r.target.id)
    if (!s || !t) continue
    relationships++
    let pairs = byRel.get(r.type)
    if (!pairs) byRel.set(r.type, (pairs = new Map()))
    const key = s + SEP + t
    let acc = pairs.get(key)
    if (!acc) pairs.set(key, (acc = { source: s, target: t, count: 0, directed: true, out: new Map(), in: new Map() }))
    acc.count++
    acc.directed &&= r.directed
    acc.out.set(r.source.id, (acc.out.get(r.source.id) ?? 0) + 1)
    acc.in.set(r.target.id, (acc.in.get(r.target.id) ?? 0) + 1)
  }
  const relNames = new Set<string>([...byRel.keys(), ...registry.relationshipTypes().map((t) => t.type)])
  const relationshipRefs: RelationshipRef[] = [...relNames].map((rel) => {
    const def = registry.get(rel)
    const pairs: PairRef[] = [...(byRel.get(rel)?.values() ?? [])]
      .map((a) => {
        const maxOut = Math.max(0, ...a.out.values())
        const maxIn = Math.max(0, ...a.in.values())
        const cardinality: Cardinality = maxOut <= 1 && maxIn <= 1 ? '1:1' : maxOut > 1 && maxIn <= 1 ? '1:N' : maxOut <= 1 && maxIn > 1 ? 'N:1' : 'N:M'
        return { source: a.source, target: a.target, count: a.count, directed: a.directed, sources: a.out.size, targets: a.in.size, maxOut, maxIn, cardinality }
      })
      .sort((x, y) => y.count - x.count)
    return { rel, label: def.label, color: def.color, description: def.description, origin: def.origin, count: pairs.reduce((n, p) => n + p.count, 0), pairs }
  })
  relationshipRefs.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const byCategory = CATEGORY_ORDER.map((category) => ({ category, types: types.filter((t) => t.category === category) })).filter((g) => g.types.length)
  return {
    types,
    relationships: relationshipRefs,
    byCategory,
    totals: { types: types.length, withInstances: types.filter((t) => t.count > 0).length, relationshipTypes: relationshipRefs.length, pairs: relationshipRefs.reduce((n, r) => n + r.pairs.length, 0), entities, relationships },
  }
}

/** The reference as a portable document: what a schema file for this dataset would say. */
export function schemaReferenceJson(ref: SchemaReference) {
  return {
    $schema: 'aegraph/schema-reference/v1',
    types: ref.types.map((t) => ({ type: t.type, label: t.label, pluralLabel: t.pluralLabel, category: t.category, ...(t.parent ? { parent: t.parent } : {}), ...(t.color ? { color: t.color } : {}), ...(t.description ? { description: t.description } : {}), origin: t.origin, instances: t.count, properties: t.properties.map((p) => ({ key: p.key, ...(p.declaredOn ? { label: p.label, kind: p.kind, ...(p.required ? { required: true } : {}), ...(p.options ? { options: p.options } : {}), ...(p.description ? { description: p.description } : {}), declaredOn: p.declaredOn } : { observed: true }), onEntities: p.count })) })),
    relationships: ref.relationships.map((r) => ({ type: r.rel, label: r.label, ...(r.description ? { description: r.description } : {}), origin: r.origin, count: r.count, pairs: r.pairs.map((p) => ({ source: p.source, target: p.target, count: p.count, directed: p.directed, cardinality: p.cardinality, maxTargetsPerSource: p.maxOut, maxSourcesPerTarget: p.maxIn })) })),
  }
}
