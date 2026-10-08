import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { TypeCategory } from '../../core/entity/categories'

/**
 * The schema network: what the data is made of, ignoring the instances.
 * Types are the nodes; every relationship between two entities counts once
 * for the pair (source type, relationship type, target type). One pass
 * over the relationships, so it is cheap to recompute when the store
 * changes.
 */

export interface SchemaType {
  type: string
  label: string
  category: TypeCategory
  color?: string
  /** Entities of the type. */
  count: number
  /** Relationships touching entities of the type, either end. */
  degree: number
  /** How the type came to be: built in, defined by a schema:type entity, or inferred from the data. */
  origin: string
  /** `data` keys seen on the type's entities (most common first), with how many carry each. */
  properties: { key: string; count: number }[]
}

/** One (source type → relationship type → target type) triple with its count. */
export interface SchemaTriple {
  source: string
  rel: string
  target: string
  count: number
  /** Whether every relationship in the triple was directed. */
  directed: boolean
}

/** Types linked, whatever the relationship type: one line in the graph, its triples underneath. */
export interface SchemaLink {
  a: string
  b: string
  count: number
  triples: SchemaTriple[]
}

export interface SchemaNetwork {
  types: SchemaType[]
  triples: SchemaTriple[]
  links: SchemaLink[]
  /** Relationship types, with the number of triples and relationships each carries. */
  predicates: { rel: string; label: string; color?: string; triples: number; count: number }[]
  totals: { entities: number; relationships: number; types: number; predicates: number; triples: number; danglingRelationships: number }
}

const TYPE_TYPE = 'schema:type'
const SEP = ' :: '

// The last network per store, by what it was built from: a page revisited (or mounted twice, as dev does) reads it back
// instead of walking every relationship again — a city's worth is a quarter of a second each time.
const networkCache = new WeakMap<EntityStore, { key: string; registry: TypeRegistry; net: SchemaNetwork }>()

export function schemaNetwork(store: EntityStore, registry: TypeRegistry, opts: { maxProperties?: number; /** Only these categories (default: all). Presentation types — layouts, scenes, plots — are usually noise in an ontology. */ categories?: TypeCategory[] } = {}): SchemaNetwork {
  const key = `${store.dataVersion}|${store.scope ?? ''}|${opts.maxProperties ?? ''}|${opts.categories?.join(',') ?? '*'}`
  const hit = networkCache.get(store)
  if (hit && hit.key === key && hit.registry === registry) return hit.net
  const net = computeSchemaNetwork(store, registry, opts)
  networkCache.set(store, { key, registry, net })
  return net
}

function computeSchemaNetwork(store: EntityStore, registry: TypeRegistry, opts: { maxProperties?: number; categories?: TypeCategory[] }): SchemaNetwork {
  const keep = opts.categories ? new Set<string>(opts.categories) : null
  const kept = (type: string) => !keep || keep.has(registry.get(type).category)
  const tripleMap = new Map<string, SchemaTriple>()
  const degree = new Map<string, number>()
  const typeOf = new Map<string, string>()
  const kindOf = (id: string) => {
    let t = typeOf.get(id)
    if (t === undefined) {
      const e = store.get(id)
      t = e ? (e.kind === 'relationship' ? `(${e.type})` : e.type) : ''
      typeOf.set(id, t)
    }
    return t
  }
  let dangling = 0
  let relationships = 0
  for (const r of store.relationships()) {
    relationships++
    const s = kindOf(r.source.id)
    const t = kindOf(r.target.id)
    if (!s || !t) {
      dangling++
      continue
    }
    if (!kept(s) || !kept(t)) continue
    degree.set(s, (degree.get(s) ?? 0) + 1)
    if (t !== s) degree.set(t, (degree.get(t) ?? 0) + 1)
    const key = s + SEP + r.type + SEP + t
    const cur = tripleMap.get(key)
    if (cur) {
      cur.count++
      cur.directed &&= r.directed
    } else tripleMap.set(key, { source: s, rel: r.type, target: t, count: 1, directed: r.directed })
  }
  const triples = [...tripleMap.values()].sort((x, y) => y.count - x.count)

  // Properties: the keys the type's entities carry, counted.
  const props = new Map<string, Map<string, number>>()
  let entities = 0
  for (const e of store.all()) {
    if (e.kind !== 'entity' || e.type === TYPE_TYPE || !kept(e.type)) continue
    entities++
    const m = props.get(e.type) ?? new Map<string, number>()
    for (const k of Object.keys(e.data)) m.set(k, (m.get(k) ?? 0) + 1)
    props.set(e.type, m)
  }
  const inTriples = new Set(triples.flatMap((t) => [t.source, t.target]))
  const types: SchemaType[] = registry
    .all()
    .filter((t) => t.kind !== 'relationship' && t.type !== TYPE_TYPE && kept(t.type) && (t.count > 0 || inTriples.has(t.type)))
    .map((t) => ({
      type: t.type,
      label: t.label,
      category: t.category,
      color: t.color,
      count: t.count,
      degree: degree.get(t.type) ?? 0,
      origin: t.origin,
      properties: [...(props.get(t.type) ?? new Map<string, number>())]
        .map(([key, count]) => ({ key, count }))
        .sort((x, y) => y.count - x.count || x.key.localeCompare(y.key))
        .slice(0, opts.maxProperties ?? 40),
    }))
  // Relationships whose ends are relationships (annotations on links) show as pseudo-types in parentheses.
  for (const t of inTriples) if (!types.some((x) => x.type === t)) types.push({ type: t, label: t, category: 'project', count: 0, degree: degree.get(t) ?? 0, origin: 'inferred', properties: [] })
  types.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label))

  const linkMap = new Map<string, SchemaLink>()
  for (const tr of triples) {
    const [a, b] = [tr.source, tr.target].sort()
    const key = a + SEP + b
    const cur = linkMap.get(key) ?? { a, b, count: 0, triples: [] }
    cur.count += tr.count
    cur.triples.push(tr)
    linkMap.set(key, cur)
  }
  const links = [...linkMap.values()].sort((x, y) => y.count - x.count)

  const predMap = new Map<string, { triples: number; count: number }>()
  for (const tr of triples) {
    const cur = predMap.get(tr.rel) ?? { triples: 0, count: 0 }
    cur.triples++
    cur.count += tr.count
    predMap.set(tr.rel, cur)
  }
  const predicates = [...predMap]
    .map(([rel, v]) => {
      const def = registry.get(rel)
      return { rel, label: def.label, color: def.color, ...v }
    })
    .sort((x, y) => y.count - x.count)

  return { types, triples, links, predicates, totals: { entities, relationships, types: types.length, predicates: predicates.length, triples: triples.length, danglingRelationships: dangling } }
}

/** A plain-text query over the network: matches type labels/keys, relationship types, and "a → b" / "a rel b" phrases. */
export function searchTriples(net: SchemaNetwork, query: string): SchemaTriple[] {
  const q = query.trim().toLowerCase()
  if (!q) return net.triples
  const labelOf = (t: string) => (net.types.find((x) => x.type === t)?.label ?? t).toLowerCase()
  const hit = (tr: SchemaTriple, word: string) => tr.source.toLowerCase().includes(word) || tr.target.toLowerCase().includes(word) || tr.rel.toLowerCase().includes(word) || labelOf(tr.source).includes(word) || labelOf(tr.target).includes(word)
  // "person → paper" or "person paper": every word must hit somewhere in the triple.
  const words = q.split(/\s*(?:→|->|>)\s*|\s+/).filter(Boolean)
  return net.triples.filter((tr) => words.every((w) => hit(tr, w)))
}

/**
 * Positions for the schema graph: a small force layout (repulsion between
 * every pair, springs along links, a pull to the centre), run to rest at
 * build time — a few dozen types converge in a few hundred steps.
 */
export function layoutSchema(net: SchemaNetwork, width: number, height: number, steps = 300): Map<string, { x: number; y: number }> {
  const nodes = net.types.map((t, i) => {
    const a = (i / Math.max(1, net.types.length)) * Math.PI * 2
    const r = Math.min(width, height) * 0.35
    return { id: t.type, x: width / 2 + r * Math.cos(a), y: height / 2 + r * Math.sin(a), vx: 0, vy: 0, w: 1 + Math.log2(1 + t.count) }
  })
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const links = net.links.map((l) => ({ a: idx.get(l.a)!, b: idx.get(l.b)!, w: Math.log2(1 + l.count) })).filter((l) => l.a !== undefined && l.b !== undefined && l.a !== l.b)
  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 1.15
  for (let s = 0; s < steps; s++) {
    const temp = 1 - s / steps
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      let fx = 0
      let fy = 0
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue
        const m = nodes[j]
        let dx = n.x - m.x
        let dy = n.y - m.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (Math.random() - 0.5) * 2
          dy = (Math.random() - 0.5) * 2
          d2 = 1
        }
        const f = (k * k) / d2
        fx += (dx / Math.sqrt(d2)) * f * 0.5
        fy += (dy / Math.sqrt(d2)) * f * 0.5
      }
      fx += (width / 2 - n.x) * 0.01
      fy += (height / 2 - n.y) * 0.01
      n.vx = fx
      n.vy = fy
    }
    for (const l of links) {
      const a = nodes[l.a]
      const b = nodes[l.b]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = ((d - k) / d) * 0.025 * (1 + l.w * 0.15)
      a.vx += dx * f
      a.vy += dy * f
      b.vx -= dx * f
      b.vy -= dy * f
    }
    for (const n of nodes) {
      const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1
      const cap = k * 0.5 * temp + 1
      const step = Math.min(v, cap) / v
      n.x = Math.max(40, Math.min(width - 40, n.x + n.vx * step))
      n.y = Math.max(40, Math.min(height - 40, n.y + n.vy * step))
    }
  }
  return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
}

/**
 * A radial arrangement: the types around a circle, grouped by category (each
 * category an arc, a small gap between arcs), so the links between them —
 * drawn as curves through the middle — read like a chord diagram with
 * branches. Angles in radians; the caller places the circle.
 */
export interface RadialSlot {
  type: string
  angle: number
  category: TypeCategory
}
export interface RadialArc {
  category: TypeCategory
  start: number
  end: number
  types: number
}
export function radialSchema(net: SchemaNetwork, order: readonly TypeCategory[]): { slots: RadialSlot[]; arcs: RadialArc[] } {
  const groups = order.map((c) => ({ category: c, types: net.types.filter((t) => t.category === c).sort((x, y) => y.degree - x.degree || x.label.localeCompare(y.label)) })).filter((g) => g.types.length)
  const n = net.types.length
  if (!n) return { slots: [], arcs: [] }
  // The gap between categories costs one slot's width; a lone category has none.
  const gap = groups.length > 1 ? (Math.PI * 2 * 0.04) / groups.length : 0
  const usable = Math.PI * 2 - gap * groups.length
  const step = usable / n
  const slots: RadialSlot[] = []
  const arcs: RadialArc[] = []
  let a = -Math.PI / 2
  for (const g of groups) {
    const start = a
    for (const t of g.types) {
      slots.push({ type: t.type, angle: a + step / 2, category: g.category })
      a += step
    }
    arcs.push({ category: g.category, start, end: a, types: g.types.length })
    a += gap
  }
  return { slots, arcs }
}
