import { SCHEMA_TYPE } from '../entity/categories'
import { createEntity, createRelationship, displayLabel, uniqueTags } from '../entity/entity'
import type { EntityStore } from '../entity/store'
import { humanizeType } from '../entity/schema'
import type { AnyEntity, Entity, EntityId, Relationship } from '../entity/types'
import { GRAPH_TYPES } from '../graph/types'
import { RELATIONSHIP_TYPES } from '../resources/types'
import type { DEdge, DNode, ParsedDiagram } from './model'

/**
 * Mapping workflow: how a parsed diagram becomes entities and relationships.
 *
 * The user picks what a node's *type* comes from (its subgraph, class, shape,
 * or one fixed type) and what an edge's *relationship type* comes from (its
 * label, arrow style, or one fixed type), then edits the per-key table. Ids
 * are derived from the diagram + node id, so importing again updates the
 * same entities instead of duplicating them.
 */

export type NodeTypeBy = 'group' | 'class' | 'shape' | 'fixed'
export type EdgeTypeBy = 'label' | 'style' | 'fixed'

/**
 * A mapping's tables are keyed by what the diagram says — a class, a group, an edge label — so `__proto__` or
 * `constructor` is a key like any other: they are read as own properties only (`typeIn`), and a type that is not a
 * non-empty string falls back to the fixed one. A mapping is also data (a diagram keeps it in `data.mapping`, a tool
 * call passes one), so its values are checked where they are read, not trusted where they are written.
 */
export interface MappingSpec {
  nodeTypeBy: NodeTypeBy
  /** key (group id / class / shape) → entity type. Missing keys fall back to `fixedNodeType`. */
  nodeTypes: Record<string, string>
  fixedNodeType: string
  edgeTypeBy: EdgeTypeBy
  /** key (label / style; '' = none) → relationship type. Missing keys fall back to `fixedEdgeType`. */
  edgeTypes: Record<string, string>
  fixedEdgeType: string
  /** Tags added to everything imported. */
  tags: string[]
  /** Reuse an existing entity when one has the same label (case-insensitive). */
  mergeByLabel: boolean
  /** Add a `derived-from` relationship from each imported entity to the diagram. */
  linkToDiagram: boolean
  /** Copy node attributes into `data`. */
  attrsToData: boolean
}

export const slugType = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^cluster_?/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'entity'

const IRREGULAR: Record<string, string> = { people: 'person', children: 'child', men: 'man', women: 'woman', teeth: 'tooth', feet: 'foot', mice: 'mouse', geese: 'goose' }
/**
 * A cluster is usually labelled in the plural ("Services", "Major works") while aegraph types are singular, and a
 * type's own cluster label is its plural (`diagramFromEntities`), so the last word of an inferred type is put back
 * into the singular with a conservative rule: words that are not plural, and short words, are left alone.
 */
export function singularType(type: string): string {
  const words = type.split(' ')
  const last = words[words.length - 1]
  const one = IRREGULAR[last] ?? singularWord(last)
  words[words.length - 1] = one
  return words.join(' ')
}
function singularWord(w: string): string {
  if (w.length < 4 || !w.endsWith('s') || w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2)
  return w.slice(0, -1)
}

export function nodeKey(n: DNode, by: NodeTypeBy): string {
  if (by === 'group') return n.group ?? ''
  if (by === 'class') return n.classes[0] ?? ''
  if (by === 'shape') return n.shape ?? ''
  return ''
}

export function edgeKey(e: DEdge, by: EdgeTypeBy): string {
  if (by === 'label') return e.label?.trim() ?? ''
  if (by === 'style') return e.style ?? ''
  return ''
}

/** Distinct keys with counts and a few sample labels, for the mapping table. */
export function keyStats<T>(items: T[], keyOf: (x: T) => string, labelOf: (x: T) => string): { key: string; count: number; samples: string[] }[] {
  const m = new Map<string, { count: number; samples: string[] }>()
  for (const it of items) {
    const k = keyOf(it)
    const s = m.get(k) ?? { count: 0, samples: [] }
    s.count++
    if (s.samples.length < 3) s.samples.push(labelOf(it))
    m.set(k, s)
  }
  return [...m.entries()].map(([key, s]) => ({ key, ...s })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** A default mapping: prefer the richest signal the diagram actually has. */
export function inferMapping(d: ParsedDiagram, diagramLabel?: string): MappingSpec {
  const hasGroups = d.nodes.some((n) => n.group)
  const hasClasses = d.nodes.some((n) => n.classes.length)
  const shapes = new Set(d.nodes.map((n) => n.shape).filter(Boolean))
  const nodeTypeBy: NodeTypeBy = hasGroups ? 'group' : hasClasses ? 'class' : shapes.size > 1 ? 'shape' : 'fixed'
  const fixedNodeType = d.kind === 'classDiagram' ? 'class' : d.kind === 'erDiagram' ? 'entity' : d.kind === 'stateDiagram' ? 'state' : 'concept'
  const nodeTypes: Record<string, string> = Object.create(null)
  for (const { key } of keyStats(d.nodes, (n) => nodeKey(n, nodeTypeBy), (n) => n.label)) {
    if (!key) continue
    const group = d.groups.find((g) => g.id === key)
    nodeTypes[key] = singularType(slugType(group?.label ?? key))
  }
  const hasLabels = d.edges.some((e) => e.label)
  const hasStyles = new Set(d.edges.map((e) => e.style).filter(Boolean)).size > 1
  const edgeTypeBy: EdgeTypeBy = hasLabels ? 'label' : hasStyles ? 'style' : 'fixed'
  const edgeTypes: Record<string, string> = Object.create(null)
  for (const { key } of keyStats(d.edges, (e) => edgeKey(e, edgeTypeBy), () => '')) if (key) edgeTypes[key] = slugType(key)
  const fixedEdgeType = d.kind === 'mindmap' ? RELATIONSHIP_TYPES.contains : d.kind === 'stateDiagram' ? 'transitions to' : d.kind === 'classDiagram' ? 'associated with' : RELATIONSHIP_TYPES.related
  return {
    nodeTypeBy,
    nodeTypes,
    fixedNodeType,
    edgeTypeBy,
    edgeTypes,
    fixedEdgeType,
    tags: diagramLabel ? [slugType(diagramLabel).replace(/\s+/g, '-')] : [],
    mergeByLabel: true,
    linkToDiagram: true,
    attrsToData: true,
  }
}

/** A table's type for a key: an own, non-empty string, or undefined — never what `Object.prototype` answers to the key. */
export function typeIn(table: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!table || typeof table !== 'object' || !Object.hasOwn(table, key)) return undefined
  const v = table[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}
const typeOr = (t: unknown, fallback: string) => (typeof t === 'string' && t.trim() ? t : fallback)

export const nodeTypeFor = (n: DNode, m: MappingSpec): string => typeOr((m.nodeTypeBy === 'fixed' ? undefined : typeIn(m.nodeTypes, nodeKey(n, m.nodeTypeBy))) ?? m.fixedNodeType, 'concept')
export const edgeTypeFor = (e: DEdge, m: MappingSpec): string => typeOr((m.edgeTypeBy === 'fixed' ? undefined : typeIn(m.edgeTypes, edgeKey(e, m.edgeTypeBy))) ?? m.fixedEdgeType, RELATIONSHIP_TYPES.related)

// ── Planning & applying ────────────────────────────────────────────────

export interface ImportPlan {
  entities: Entity[]
  relationships: Relationship[]
  /** Entities matched to existing ones by label (their ids are reused). */
  reused: { nodeId: string; entity: AnyEntity }[]
  created: number
  updated: number
  /** Node ids that resolved to the same entity (label collisions inside the diagram). */
  collapsed: number
  /** Edges left out because an end is not a node (a cluster, or nothing). */
  skippedEdges: number
  /** Diagram node id → entity id, and diagram edge id → relationship id, for carrying geometry across. */
  nodeIds: Record<string, EntityId>
  edgeIds: Record<string, EntityId>
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const slugId = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80)
/** An entity an import may reuse or merge into: never a type definition, a graph object (layout, view, project…) or a diagram. */
const NEVER_MERGED = new Set<string>([SCHEMA_TYPE, ...Object.values(GRAPH_TYPES), 'diagram'])
const mergeable = (e: AnyEntity | undefined): e is Entity => !!e && e.kind === 'entity' && !e.type.startsWith('schema:') && !NEVER_MERGED.has(e.type)
export const importedEntityId = (diagramId: EntityId, nodeId: string) => `dg-${diagramId.slice(0, 8)}-n-${slugId(nodeId)}`
export const importedRelationshipId = (diagramId: EntityId, source: EntityId, type: string, target: EntityId, n: number) => `dg-${diagramId.slice(0, 8)}-r-${slugId(`${source}|${type}|${target}`)}${n ? `-${n}` : ''}`

/**
 * Work out exactly what an import would write, without writing it. The
 * wizard shows this as a preview; `applyPlan` commits it.
 */
export function planImport(store: EntityStore, diagram: AnyEntity, d: ParsedDiagram, m: MappingSpec): ImportPlan {
  const now = new Date().toISOString()
  const idFor = new Map<string, EntityId>()
  const reused: ImportPlan['reused'] = []
  const entities: Entity[] = []
  let created = 0
  let updated = 0
  let collapsed = 0

  // Existing entities by lowercase label (excluding graph/schema kinds we'd never merge into).
  const byLabel = new Map<string, AnyEntity>()
  if (m.mergeByLabel) {
    for (const e of store.all()) {
      if (!mergeable(e)) continue
      const k = displayLabel(e).trim().toLowerCase()
      if (k && !byLabel.has(k)) byLabel.set(k, e)
    }
  }

  for (const n of d.nodes) {
    const type = nodeTypeFor(n, m)
    const label = n.label.trim() || n.id
    const ownId = importedEntityId(diagram.id, n.id)
    // Precedence: an entity this diagram created before → an entity whose id the node names
    // (diagrams exported from the dataset keep entity ids) → an entity with the same label.
    const byId = store.get(n.id)
    const existing = store.get(ownId) ?? (mergeable(byId) ? byId : undefined) ?? (m.mergeByLabel ? byLabel.get(label.toLowerCase()) : undefined)
    const data: Record<string, unknown> = {}
    if (m.attrsToData) {
      if (n.shape) data.shape = n.shape
      if (n.classes.length) data.classes = n.classes
      if (n.group) data.group = n.group
      for (const [k, v] of Object.entries(n.attrs)) if (!UNSAFE_KEYS.has(k)) data[k] = v
    }
    data.diagramNodeId = n.id
    if (existing && existing.kind === 'entity') {
      if (idFor.has(n.id) || [...idFor.values()].includes(existing.id)) collapsed++
      idFor.set(n.id, existing.id)
      const isOwn = existing.id === ownId
      if (!isOwn) reused.push({ nodeId: n.id, entity: existing })
      // Own entities get refreshed; merged ones only gain tags and missing data.
      const next: Entity = {
        ...(existing as Entity),
        ...(isOwn ? { label, type, description: existing.description } : {}),
        tags: uniqueTags([...existing.tags, ...m.tags]),
        data: isOwn ? { ...existing.data, ...data } : { ...data, ...existing.data },
        meta: { ...existing.meta, updatedAt: now },
      }
      entities.push(next)
      updated++
      continue
    }
    const e = createEntity({ id: ownId, type, label, tags: m.tags, data, meta: { source: `import:${d.format}`, derivedFrom: { id: diagram.id } } })
    idFor.set(n.id, e.id)
    entities.push(e)
    created++
  }

  const relationships: Relationship[] = []
  const seen = new Map<string, number>()
  const edgeIds: Record<string, EntityId> = {}
  let skippedEdges = 0
  for (const e of d.edges) {
    const s = idFor.get(e.source)
    const t = idFor.get(e.target)
    if (!s || !t) {
      skippedEdges++
      continue
    }
    const type = edgeTypeFor(e, m)
    // A label that named the type is spent; one that did not (typing by style, or unmapped) stays as the label.
    const fromLabel = m.edgeTypeBy === 'label' && typeIn(m.edgeTypes, edgeKey(e, 'label')) !== undefined
    const base = `${s}|${type}|${t}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const data: Record<string, unknown> = {}
    if (m.attrsToData) {
      if (e.style) data.style = e.style
      if (e.label && edgeKey(e, m.edgeTypeBy) !== e.label) data.label = e.label
      for (const [k, v] of Object.entries(e.attrs)) if (!UNSAFE_KEYS.has(k)) data[k] = v
    }
    const id = importedRelationshipId(diagram.id, s, type, t, n)
    edgeIds[e.id] = id
    const prev = store.get(id)
    relationships.push(createRelationship({ id, type, source: s, target: t, directed: e.directed, label: e.label && !fromLabel ? e.label : undefined, tags: m.tags, data, meta: { ...(prev?.meta ?? {}), source: `import:${d.format}`, updatedAt: now } }))
  }

  if (m.linkToDiagram) {
    for (const e of entities) {
      const id = importedRelationshipId(diagram.id, e.id, RELATIONSHIP_TYPES.derivedFrom, diagram.id, 0)
      if (!store.get(id)) relationships.push(createRelationship({ id, type: RELATIONSHIP_TYPES.derivedFrom, source: e.id, target: diagram.id, tags: m.tags, meta: { source: `import:${d.format}` } }))
    }
  }

  return { entities, relationships, reused, created, updated, collapsed, skippedEdges, nodeIds: Object.fromEntries(idFor), edgeIds }
}

export function applyPlan(store: EntityStore, plan: ImportPlan) {
  store.transaction(() => store.upsertMany([...plan.entities, ...plan.relationships]))
}

/** Remove everything a previous import of this diagram created (not merged entities). */
export function removeImported(store: EntityStore, diagramId: EntityId): number {
  const prefix = `dg-${diagramId.slice(0, 8)}-`
  // Library-wide: an earlier run's entities are replaced whichever project is open.
  const ids = store.library.all().filter((e) => e.id.startsWith(prefix)).map((e) => e.id)
  store.remove(ids)
  return ids.length
}

export const describeMapping = (m: MappingSpec) => {
  const nodes = m.nodeTypeBy === 'fixed' ? `all nodes → ${humanizeType(typeOr(m.fixedNodeType, 'concept'))}` : `node type from ${m.nodeTypeBy} (${Object.keys(m.nodeTypes ?? {}).length} mapped)`
  const edges = m.edgeTypeBy === 'fixed' ? `all edges → ${typeOr(m.fixedEdgeType, RELATIONSHIP_TYPES.related)}` : `edge type from ${m.edgeTypeBy} (${Object.keys(m.edgeTypes ?? {}).length} mapped)`
  return `${nodes}; ${edges}`
}
