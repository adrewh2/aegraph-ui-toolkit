import { SCHEMA_TYPE } from '../../entity/categories'
import { createEntity, createRelationship, parseTags } from '../../entity/entity'
import type { EntityStore } from '../../entity/store'
import type { AnyEntity, Entity, EntityId, Relationship } from '../../entity/types'
import type { Positions } from '../../graph/layouts'
import { GRAPH_TYPES, type LayoutData } from '../../graph/types'
import { cyrb53 } from '../../projects/versioning'
import { isGraphFormatId } from './graphFormats'
import { isUnsafeKey, type GEdge, type GNode, type ParsedGraph } from './model'
import { isCssColor } from '../../../lib/cssColor'

/**
 * How a parsed graph becomes entities. Ids are deterministic per import key
 * (`gi-<key>-n-<nodeId>`) so re-importing the same file updates rather than
 * duplicates; node ids that already name entities can be reused for
 * round-trips through Gephi when asked (`reuseExistingIds`, off unless
 * chosen). Mirrors the diagram importer's plan/apply.
 *
 * A file is someone else's words about ids, so what it may touch is narrow:
 * an import updates in place only what an import made — its own keyed ids,
 * or (verbatim ids) an entity a graph import wrote — and reuses anything
 * else only when asked, never a type definition, a graph object (layout,
 * view, project…) or a diagram, and never changing its type. A relationship
 * id in the file is reused only when asked and only for the relationship
 * between the same two entities: a file cannot rewire what is there.
 */
export interface GraphMappingSpec {
  /** 8-char key; defaults to a hash of the file name. */
  importKey: string
  /** keyed: entity ids are `gi-<key>-n-<node>` (a file's nodes stay its own); verbatim: the node id is the entity id (IRIs — the same thing in two files is one entity) unless something that is not an import's holds it. */
  idMode?: 'keyed' | 'verbatim'
  labelAttr?: string
  descriptionAttr?: string
  typeBy: 'attr' | 'fixed'
  typeAttr?: string
  fixedType: string
  tagsAttr?: string
  edgeTypeBy: 'attr' | 'label' | 'fixed'
  edgeTypeAttr?: string
  fixedEdgeType: string
  directed: 'file' | 'directed' | 'undirected'
  attrsToData: boolean
  importLayout: boolean
  importColors: boolean
  /** A node id that names an entity already in the Library updates that entity (its type stays). Off unless chosen. */
  reuseExistingIds: boolean
  tags: string[]
}

export const slugType = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'node'

export function importKeyFor(name: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const firstPresent = (keys: string[], candidates: string[]) => candidates.find((c) => keys.some((k) => k.toLowerCase() === c))

export function inferGraphMapping(p: ParsedGraph, filename = 'graph'): GraphMappingSpec {
  const nk = p.attributeKeys.nodes
  const ek = p.attributeKeys.edges
  // A type is a word: an attribute whose values are all numbers (d3's `group`, a community id) stays an attribute —
  // something to colour by — rather than making types called "1", "2", "3".
  const actual = (c: string) => nk.find((k) => k.toLowerCase() === c)
  const names = (key: string) => p.nodes.some((n) => {
    const v = n.attrs[key]
    return typeof v === 'string' && v.trim() !== '' && !Number.isFinite(Number(v))
  })
  const typeAttr = ['type', 'category', 'kind', 'class', 'entitytype', 'group'].find((c) => {
    const k = actual(c)
    return k !== undefined && names(k)
  })
  const labelAttr = p.nodes.some((n) => n.label) ? undefined : firstPresent(nk, ['label', 'name', 'title'])
  const tagsAttr = firstPresent(nk, ['tags', 'labels', 'keywords'])
  const edgeTypeAttr = firstPresent(ek, ['type', 'relationshiptype', 'kind', 'relation', 'predicate'])
  const descriptionAttr = firstPresent(nk, ['description', 'comment', 'abstract', 'summary'])
  // RDF nodes carry their IRI: ids are global, so the entity id is the node id.
  const linked = nk.some((k) => k === 'iri')
  return {
    importKey: importKeyFor(filename.replace(/\.[^.]+$/, '')),
    idMode: linked ? 'verbatim' : 'keyed',
    descriptionAttr,
    labelAttr,
    typeBy: typeAttr ? 'attr' : 'fixed',
    typeAttr: nk.find((k) => k.toLowerCase() === typeAttr),
    fixedType: 'node',
    tagsAttr: nk.find((k) => k.toLowerCase() === tagsAttr),
    edgeTypeBy: edgeTypeAttr ? 'attr' : p.edges.some((e) => e.label) ? 'label' : 'fixed',
    edgeTypeAttr: ek.find((k) => k.toLowerCase() === edgeTypeAttr),
    fixedEdgeType: 'related',
    directed: 'file',
    attrsToData: true,
    importLayout: p.nodes.some((n) => n.viz?.x !== undefined),
    importColors: p.nodes.some((n) => n.viz?.color),
    reuseExistingIds: false,
    tags: [],
  }
}

const slugId = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80)
export const importedNodeId = (key: string, nodeId: string) => `gi-${key}-n-${slugId(nodeId)}`
/**
 * The id for a node whose slugged id another node in the file already has — `a b` and `a/b`, or two titles sharing
 * their first 80 characters — which would otherwise overwrite it: the slug, shortened, with a hash of the whole id.
 * Only the second and later of such a set get it, so a file whose ids never collide keeps the ids it always had.
 */
export const distinctNodeId = (key: string, nodeId: string) => `gi-${key}-n-${slugId(nodeId).slice(0, 64)}~${cyrb53(nodeId).toString(36)}`
export const importedEdgeId = (key: string, edgeId: string, n = 0) => `gi-${key}-r-${slugId(edgeId)}${n ? `-${n}` : ''}`
export const importedLayoutId = (key: string) => `gi-${key}-layout`

export interface GraphImportPlan {
  entities: Entity[]
  relationships: Relationship[]
  layout?: Entity<LayoutData>
  created: number
  updated: number
  reused: number
  skippedEdges: number
  warnings: string[]
}

/** An entity an import may update or reuse: never a type definition, a graph object (layout, view, project…) or a diagram. */
const NEVER_MERGED = new Set<string>([SCHEMA_TYPE, ...Object.values(GRAPH_TYPES), 'diagram'])
const mergeable = (e: AnyEntity | undefined): e is Entity => !!e && e.kind === 'entity' && typeof e.type === 'string' && !e.type.startsWith('schema:') && !NEVER_MERGED.has(e.type)
/** Written by a graph import (`import:<format>`, or the default `import:graph`): what a verbatim id may update in place. */
const byGraphImport = (e: AnyEntity) => {
  const src = e.meta?.source
  return typeof src === 'string' && (src === 'import:graph' || (src.startsWith('import:') && isGraphFormatId(src.slice(7))))
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))
/** A coordinate is only a coordinate when it is a real number: a NaN from a half-read cell must not reach a layout. */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const splitTags = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[;,|]/) : [])

function nodeType(n: GNode, m: GraphMappingSpec): string {
  if (m.typeBy === 'attr' && m.typeAttr) {
    const v = str(n.attrs[m.typeAttr])
    if (v) return slugType(v)
  }
  return typeof m.fixedType === 'string' && m.fixedType.trim() ? m.fixedType : 'node'
}
function edgeType(e: GEdge, m: GraphMappingSpec): string {
  if (m.edgeTypeBy === 'attr' && m.edgeTypeAttr) {
    const v = str(e.attrs[m.edgeTypeAttr])
    if (v) return slugType(v)
  }
  if (m.edgeTypeBy === 'label' && e.label) return slugType(e.label)
  return typeof m.fixedEdgeType === 'string' && m.fixedEdgeType.trim() ? m.fixedEdgeType : 'related'
}

/** Work out exactly what an import would write, without writing it. */
export function planGraphImport(store: EntityStore, p: ParsedGraph, m: GraphMappingSpec, source = 'import:graph'): GraphImportPlan {
  const idFor = new Map<string, EntityId>()
  /** Which source id each entity id was given to: a second source id slugging to the same entity id gets its own. */
  const givenTo = new Map<EntityId, string>()
  let collisions = 0
  let taken = 0
  const entities: Entity[] = []
  const warnings = [...p.warnings]
  let created = 0
  let updated = 0
  let reused = 0
  const positions: Positions = {}
  let dims: 2 | 3 = 2

  for (const n of p.nodes) {
    let own = m.idMode === 'verbatim' ? n.id : importedNodeId(m.importKey, n.id)
    if (m.idMode !== 'verbatim') {
      const had = givenTo.get(own)
      if (had !== undefined && had !== n.id) {
        own = distinctNodeId(m.importKey, n.id)
        collisions++
      }
      givenTo.set(own, n.id)
    }
    let atOwn = store.get(own)
    // What holds the import's own id is the import's when it is under the import's prefix (keyed) or was written by a
    // graph import (verbatim: the same IRI read again). Anything else there is not the file's to rewrite: reused when
    // asked and it may be, else the node takes an id of its own.
    let existingOwn = mergeable(atOwn) && (m.idMode !== 'verbatim' || byGraphImport(atOwn)) ? atOwn : undefined
    let existingPlain: Entity | undefined
    if (atOwn && !existingOwn) {
      if (m.idMode === 'verbatim' && m.reuseExistingIds && mergeable(atOwn)) existingPlain = atOwn
      else {
        own = distinctNodeId(m.importKey, n.id)
        taken++
        atOwn = store.get(own)
        existingOwn = mergeable(atOwn) ? atOwn : undefined
      }
    }
    if (!existingOwn && !existingPlain && m.reuseExistingIds && m.idMode !== 'verbatim') {
      const plain = store.get(n.id)
      if (mergeable(plain)) existingPlain = plain
    }
    const plainOk = !!existingPlain
    const target = existingOwn ?? existingPlain
    const id = target?.id ?? own
    idFor.set(n.id, id)
    const type = nodeType(n, m)
    const label = n.label ?? (m.labelAttr ? str(n.attrs[m.labelAttr]) : undefined) ?? n.id
    const description = m.descriptionAttr ? str(n.attrs[m.descriptionAttr]) : undefined
    const data: Record<string, unknown> = { ...(target?.data ?? {}) }
    if (m.attrsToData) for (const [k, v] of Object.entries(n.attrs)) if (k !== m.typeAttr && k !== m.tagsAttr && k !== m.labelAttr && k !== m.descriptionAttr && v !== undefined && !isUnsafeKey(k)) data[k] = v
    if (m.idMode !== 'verbatim') data.importedId = n.id
    // A colour — from the file's drawing hints or copied with its attributes — is drawn as CSS: only a real colour is kept.
    if (m.importColors && isCssColor(n.viz?.color)) data.color = n.viz.color.trim()
    if ('color' in data && !isCssColor(data.color)) delete data.color
    if (n.viz?.size !== undefined) data.size = n.viz.size
    const x = num(n.viz?.x), y = num(n.viz?.y), z = num(n.viz?.z)
    if (x !== undefined && y !== undefined) {
      positions[id] = { x, y, ...(z !== undefined ? { z } : {}) }
      if (z !== undefined) dims = 3
    }
    const tags = parseTags([...(target?.tags ?? []), ...(m.tagsAttr ? splitTags(n.attrs[m.tagsAttr]) : []), ...m.tags])
    if (target) {
      if (plainOk && !existingOwn) reused++
      else updated++
      // A stub (a thing only referred to) never overwrites what is already known about the entity.
      const stub = n.attrs.stub === true
      if (!stub) delete data.stub // described now: no longer a thing only referred to
      entities.push({ ...(target as Entity), label: stub ? target.label : label, type: existingOwn && !stub ? type : target.type, ...(description && !stub ? { description } : {}), tags, data: stub ? { ...data, ...target.data } : data, meta: { ...target.meta, updatedAt: new Date().toISOString() } })
    } else {
      created++
      entities.push(createEntity({ id, type, label, description, tags, data, meta: { source } }))
    }
  }

  if (taken) warnings.push(`${taken.toLocaleString()} node ids name something in the Library that this import did not make; each got an id of its own${m.reuseExistingIds ? '' : ' (turn on reusing existing ids to update entities instead)'}.`)
  if (collisions) warnings.push(`${collisions.toLocaleString()} node ids read alike once made safe for an entity id (punctuation, or the same first 80 characters); each got a distinct id.`)

  const relationships: Relationship[] = []
  const seen = new Map<string, number>()
  let skippedEdges = 0
  for (const e of p.edges) {
    const s = idFor.get(e.source)
    const t = idFor.get(e.target)
    if (!s || !t) {
      skippedEdges++
      continue
    }
    const type = edgeType(e, m)
    const directed = m.directed === 'file' ? (e.directed ?? p.directedDefault) : m.directed === 'directed'
    // A relationship id in the file is reused only when asked, and only for the same two ends: never rewired.
    const prevRel = e.id && m.reuseExistingIds ? store.get(e.id) : undefined
    const existingRel = prevRel?.kind === 'relationship' && prevRel.source.id === s && prevRel.target.id === t ? prevRel : undefined
    let id: string
    if (existingRel) id = existingRel.id
    else {
      const base = e.id ?? `${e.source}|${type}|${e.target}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      id = importedEdgeId(m.importKey, base, n)
    }
    const data: Record<string, unknown> = {}
    if (m.attrsToData) for (const [k, v] of Object.entries(e.attrs)) if (k !== m.edgeTypeAttr && v !== undefined && !isUnsafeKey(k)) data[k] = v
    if (e.weight !== undefined) data.weight = e.weight
    relationships.push(createRelationship({ id, type, source: s, target: t, directed, label: e.label && slugType(e.label) !== type ? e.label : undefined, tags: m.tags, data, meta: { source } }))
  }

  let layout: Entity<LayoutData> | undefined
  if (m.importLayout && Object.keys(positions).length) {
    const lid = importedLayoutId(m.importKey)
    const prev = store.get(lid)
    layout = createEntity<LayoutData>({ id: lid, type: GRAPH_TYPES.layout, label: prev?.label ?? `Imported layout (${m.importKey})`, tags: [], data: { positions, algorithm: 'imported', dimensions: dims }, meta: { source } })
  }
  return { entities, relationships, layout, created, updated, reused, skippedEdges, warnings }
}

export function applyGraphPlan(store: EntityStore, plan: GraphImportPlan) {
  store.transaction(() => store.upsertMany([...plan.entities, ...plan.relationships, ...(plan.layout ? [plan.layout as AnyEntity] : [])]))
}

/** Remove everything a previous import with this key created (reused entities are left alone). */
export function removeGraphImport(store: EntityStore, importKey: string): number {
  const prefix = `gi-${importKey}-`
  // Library-wide: an earlier run's entities are replaced whichever project is open.
  const ids = store.library.all().filter((e) => e.id.startsWith(prefix)).map((e) => e.id)
  store.remove(ids)
  return ids.length
}
