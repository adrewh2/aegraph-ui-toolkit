import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { TypeCategory } from '../../core/entity/categories'

/**
 * The tag matrix behind the Ontology page's Tags tab: how tags are spread
 * over types. A tag is either plain (`topology`) or a `key:value` pair
 * (`tier:app`, `lang:typescript`); pairs group under their key, so the
 * matrix can show a type's coverage by facet (any `tier:*`) and, on request,
 * the values a facet takes within each type.
 */

export interface TagKey {
  key: string
  /** Distinct values, most common first; empty for a plain tag. */
  values: string[]
  /** Entities carrying the key (any value, or the plain tag). */
  count: number
  /** Entities per value. */
  valueCounts: Map<string, number>
  faceted: boolean
}

export interface MatrixType {
  type: string
  label: string
  color: string
  category: TypeCategory
  kind: 'entity' | 'relationship'
  count: number
  /** How many of its entities carry no tag at all. */
  untagged: number
}

export interface TagMatrix {
  types: MatrixType[]
  keys: TagKey[]
  /** type → key → entities of the type carrying the key. */
  byKey: Map<string, Map<string, number>>
  /** type → `key:value` → entities of the type carrying that exact tag. */
  byTag: Map<string, Map<string, number>>
  /** key → key → entities carrying both (the diagonal is the key's count). */
  cooccur: Map<string, Map<string, number>>
  totals: { entities: number; tagged: number; tags: number; keys: number }
}

/** `tier:app` → tier / app; `topology` → topology / undefined. The first colon splits, so a value may itself carry colons (URLs). */
export function splitTag(tag: string): { key: string; value?: string } {
  const i = tag.indexOf(':')
  if (i <= 0 || i === tag.length - 1) return { key: tag }
  return { key: tag.slice(0, i), value: tag.slice(i + 1) }
}

const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by)
const sub = <K, V>(m: Map<K, Map<V, number>>, k: K): Map<V, number> => {
  let s = m.get(k)
  if (!s) m.set(k, (s = new Map()))
  return s
}

export function tagMatrix(store: EntityStore, registry: TypeRegistry, opts: { categories?: TypeCategory[]; relationships?: boolean } = {}): TagMatrix {
  const keep = opts.categories ? new Set<string>(opts.categories) : null
  const typeCount = new Map<string, number>()
  const typeUntagged = new Map<string, number>()
  const typeKind = new Map<string, 'entity' | 'relationship'>()
  const keyCount = new Map<string, number>()
  const valueCount = new Map<string, Map<string, number>>()
  const byKey = new Map<string, Map<string, number>>()
  const byTag = new Map<string, Map<string, number>>()
  const cooccur = new Map<string, Map<string, number>>()
  let entities = 0
  let tagged = 0
  const allTags = new Set<string>()
  for (const e of store.all()) {
    if (e.kind === 'relationship' && !opts.relationships) continue
    const type = e.kind === 'relationship' ? `(${e.type})` : e.type
    if (keep && !keep.has(registry.get(e.type).category)) continue
    entities++
    inc(typeCount, type)
    typeKind.set(type, e.kind)
    if (!e.tags.length) {
      inc(typeUntagged, type)
      continue
    }
    tagged++
    const keys = new Set<string>()
    for (const tag of e.tags) {
      allTags.add(tag)
      const { key, value } = splitTag(tag)
      keys.add(key)
      inc(sub(byTag, type), tag)
      if (value !== undefined) inc(sub(valueCount, key), value)
    }
    for (const key of keys) {
      inc(keyCount, key)
      inc(sub(byKey, type), key)
      const row = sub(cooccur, key)
      for (const other of keys) inc(row, other)
    }
  }
  const types: MatrixType[] = [...typeCount]
    .map(([type, count]) => {
      const raw = type.startsWith('(') ? type.slice(1, -1) : type
      const def = registry.get(raw)
      return { type, label: typeKind.get(type) === 'relationship' ? `${def.label ?? raw} (link)` : (def.label ?? raw), color: def.color ?? '#8a8780', category: def.category, kind: typeKind.get(type) ?? 'entity', count, untagged: typeUntagged.get(type) ?? 0 }
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const keys: TagKey[] = [...keyCount]
    .map(([key, count]) => {
      const vc = valueCount.get(key) ?? new Map<string, number>()
      return { key, count, valueCounts: vc, values: [...vc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v), faceted: vc.size > 0 }
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return { types, keys, byKey, byTag, cooccur, totals: { entities, tagged, tags: allTags.size, keys: keys.length } }
}
