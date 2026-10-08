import { CONSTRAINT_TYPE } from '../../core/constraints/constraint'
import type { FieldKind } from '../../core/entity/schema'
import type { EntityStore } from '../../core/entity/store'
import type { ResolvedType, TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'

/**
 * Everything about one entity type, computed from its definition and its
 * instances: the properties it declares and the ones its entities actually
 * carry (with coverage, value kinds, ranges and top values), how it is
 * related to other types in each direction (with cardinality), the tags
 * on its entities, its place in the type hierarchy, and a few recent
 * entities. One pass over the instances and their relationships; a type
 * with thousands of entities and dozens of properties profiles in a few
 * milliseconds.
 */

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'date'

export interface PropertyProfile {
  key: string
  /** The declared definition, when the type (or a parent) has one. */
  declared?: { label: string; kind: FieldKind; required?: boolean; options?: string[]; description?: string }
  /** Entities carrying the key (with a non-undefined value). */
  count: number
  /** count / instances. */
  coverage: number
  kinds: Partial<Record<ValueKind, number>>
  /** Distinct scalar values seen, capped (see `distinctCapped`). */
  distinct: number
  distinctCapped: boolean
  /** The most common scalar values, for low-cardinality properties. */
  top: { value: string; count: number }[]
  /** Numeric / date ranges when the values are such. */
  min?: number
  max?: number
  dateMin?: string
  dateMax?: string
  /** Mean length of string values. */
  meanLength?: number
  sample?: string
}

export interface RelationProfile {
  rel: string
  /** The type at the other end. */
  other: string
  direction: 'out' | 'in' | 'both'
  count: number
  /** Instances of this type taking part at least once. */
  instances: number
  /** Relationships per participating instance. */
  perInstance: number
  maxPerInstance: number
  /** Whether every such relationship was directed. */
  directed: boolean
}

export interface TypeProfile {
  type: string
  def: ResolvedType
  instances: number
  parent?: ResolvedType
  children: ResolvedType[]
  properties: PropertyProfile[]
  /** Declared properties no entity carries. */
  declaredUnused: string[]
  relations: RelationProfile[]
  tags: { tag: string; count: number }[]
  created: { first?: string; last?: string }
  updated: { last?: string }
  recent: AnyEntity[]
  /** Labels shared by more than one entity of the type. */
  duplicateLabels: number
  /** Constraints that watch this type (by name, or every type). */
  constraints: number
  ms: number
}

const DISTINCT_CAP = 2000
const TOP_VALUES = 8
const ISO_LIKE = /^\d{4}-\d\d-\d\d(T|$)/

const kindOf = (v: unknown): ValueKind => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  switch (typeof v) {
    case 'string':
      return ISO_LIKE.test(v) && !Number.isNaN(Date.parse(v)) ? 'date' : 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'object'
  }
}

const brief = (v: unknown): string => {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v
  if (v === null || typeof v !== 'object') return String(v)
  const s = JSON.stringify(v)
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

export function typeProfile(store: EntityStore, registry: TypeRegistry, type: string, opts: { recent?: number } = {}): TypeProfile {
  const t0 = performance.now()
  const def = registry.get(type)
  const all = registry.all()
  const parent = def.parent ? all.find((t) => t.type === def.parent) : undefined
  const children = all.filter((t) => t.parent === type).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const instances = store.ofType(type).filter((e) => e.kind === 'entity')

  // Declared fields under data.*: the type's own and the parent chain's.
  const declared = new Map<string, PropertyProfile['declared']>()
  for (const f of registry.fieldsFor(type)) {
    if (!f.key.startsWith('data.')) continue
    declared.set(f.key.slice(5), { label: f.label, kind: f.kind, required: f.required, options: f.options?.map((o) => o.value) })
  }
  for (const p of registry.propertiesOf(type)) {
    const d = declared.get(p.key)
    if (d && p.description) d.description = p.description
  }

  // Properties, one pass.
  type Acc = { count: number; kinds: Partial<Record<ValueKind, number>>; values: Map<string, number>; capped: boolean; min: number; max: number; dateMin?: string; dateMax?: string; lengths: number; strings: number; sample?: string }
  const props = new Map<string, Acc>()
  const tags = new Map<string, number>()
  const labels = new Map<string, number>()
  let first: string | undefined
  let last: string | undefined
  let updatedLast: string | undefined
  for (const e of instances) {
    for (const k in e.data) {
      const v = e.data[k]
      if (v === undefined) continue
      let a = props.get(k)
      if (!a) props.set(k, (a = { count: 0, kinds: {}, values: new Map(), capped: false, min: Infinity, max: -Infinity, lengths: 0, strings: 0 }))
      a.count++
      const kind = kindOf(v)
      a.kinds[kind] = (a.kinds[kind] ?? 0) + 1
      if (a.sample === undefined) a.sample = brief(v)
      if (kind === 'number') {
        const n = v as number
        if (n < a.min) a.min = n
        if (n > a.max) a.max = n
      } else if (kind === 'date') {
        const s = v as string
        if (!a.dateMin || s < a.dateMin) a.dateMin = s
        if (!a.dateMax || s > a.dateMax) a.dateMax = s
      } else if (kind === 'string') {
        a.strings++
        a.lengths += (v as string).length
      }
      if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'date') {
        const key = String(v)
        const n = a.values.get(key)
        if (n !== undefined) a.values.set(key, n + 1)
        else if (a.values.size < DISTINCT_CAP) a.values.set(key, 1)
        else a.capped = true
      }
    }
    for (const tag of e.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
    if (e.label) labels.set(e.label, (labels.get(e.label) ?? 0) + 1)
    const c = e.meta.createdAt
    if (c) {
      if (!first || c < first) first = c
      if (!last || c > last) last = c
    }
    const u = e.meta.updatedAt
    if (u && (!updatedLast || u > updatedLast)) updatedLast = u
  }
  const properties: PropertyProfile[] = [...props]
    .map(([key, a]) => {
      const top = [...a.values].sort((x, y) => y[1] - x[1]).slice(0, TOP_VALUES).map(([value, count]) => ({ value: value.length > 60 ? value.slice(0, 57) + '…' : value, count }))
      return {
        key,
        declared: declared.get(key),
        count: a.count,
        coverage: instances.length ? a.count / instances.length : 0,
        kinds: a.kinds,
        distinct: a.values.size,
        distinctCapped: a.capped,
        top,
        ...(a.min !== Infinity ? { min: a.min, max: a.max } : {}),
        ...(a.dateMin ? { dateMin: a.dateMin, dateMax: a.dateMax } : {}),
        ...(a.strings ? { meanLength: a.lengths / a.strings } : {}),
        sample: a.sample,
      }
    })
    .sort((x, y) => y.count - x.count || x.key.localeCompare(y.key))
  const declaredUnused = [...declared.keys()].filter((k) => !props.has(k)).sort()

  // Relationships: (rel, other type, direction) with per-instance counts.
  type RAcc = { count: number; per: Map<EntityId, number>; directed: boolean }
  const rels = new Map<string, RAcc>()
  const typeOf = new Map<EntityId, string>()
  const kindAt = (id: EntityId) => {
    let t = typeOf.get(id)
    if (t === undefined) {
      const e = store.get(id)
      t = e ? (e.kind === 'relationship' ? `(${e.type})` : e.type) : ''
      typeOf.set(id, t)
    }
    return t
  }
  for (const e of instances) {
    for (const r of store.relationshipsOf(e.id)) {
      const out = r.source.id === e.id
      const otherId = out ? r.target.id : r.source.id
      const other = kindAt(otherId)
      if (!other) continue
      // A self-typed undirected link counts once per instance, from the instance's side.
      const direction: RelationProfile['direction'] = r.directed ? (out ? 'out' : 'in') : 'both'
      const key = `${r.type}${other}${direction}`
      let a = rels.get(key)
      if (!a) rels.set(key, (a = { count: 0, per: new Map(), directed: true }))
      a.count++
      a.directed &&= r.directed
      a.per.set(e.id, (a.per.get(e.id) ?? 0) + 1)
    }
  }
  const relations: RelationProfile[] = [...rels]
    .map(([key, a]) => {
      const [rel, other, direction] = key.split('') as [string, string, RelationProfile['direction']]
      let max = 0
      for (const n of a.per.values()) if (n > max) max = n
      return { rel, other, direction, count: a.count, instances: a.per.size, perInstance: a.per.size ? a.count / a.per.size : 0, maxPerInstance: max, directed: a.directed }
    })
    .sort((x, y) => y.count - x.count || x.rel.localeCompare(y.rel))

  const recent = [...instances].sort((a, b) => (b.meta.updatedAt ?? '').localeCompare(a.meta.updatedAt ?? '')).slice(0, opts.recent ?? 6)
  let duplicateLabels = 0
  for (const n of labels.values()) if (n > 1) duplicateLabels++

  return {
    type,
    def,
    instances: instances.length,
    parent,
    children,
    properties,
    declaredUnused,
    relations,
    tags: [...tags]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    created: { first, last },
    updated: { last: updatedLast },
    recent,
    duplicateLabels,
    constraints: store.library.ofType(CONSTRAINT_TYPE).filter((c) => c.kind === 'entity' && (c.data as { enabled?: boolean }).enabled !== false && (!(c.data as { applies?: { types?: string[] } }).applies?.types?.length || (c.data as { applies: { types: string[] } }).applies.types.includes(type))).length,
    ms: performance.now() - t0,
  }
}

/** Search over a profile's properties and relations: every word must hit the key / relationship / other type. */
export const matchesWords = (text: string, q: string) => {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = text.toLowerCase()
  return words.every((w) => hay.includes(w))
}
