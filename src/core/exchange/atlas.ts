import { SCHEMA_TYPE } from '../entity/categories'
import { createRelationship, uniqueTags } from '../entity/entity'
import { isRelationship, type AnyEntity, type EntityId, type Relationship, type TagInfo } from '../entity/types'
import { conversationIdFor } from './chatgpt'

/**
 * The scene-graph JSON the original aegraph app saved, and that
 * `aegraph-chatgpt-pipeline` emitted before it wrote project bundles
 * (September 2026 — a current atlas is an `.ae.json` and opens as a
 * project, template and all; `acp --migrate` converts an old one): nodes
 * and edges with namespaced `facet:value` tags, `userData` per node, and a
 * display config carrying a colour per tag. This turns one into entities:
 * nodes become entities of their node type, edges become relationships,
 * tag colours become tag metadata, and the node types get definitions so
 * the vocabulary travels with the data. Nothing is fetched here.
 */

export interface AtlasNode {
  id: string
  type?: string
  label?: string
  tags?: string[]
  userData?: Record<string, unknown>
  position?: { x: number; y: number; z?: number }
  color?: string
  size?: number
}
export interface AtlasEdge {
  id?: string
  source: string
  target: string
  type?: string
  label?: string
  tags?: string[]
  userData?: Record<string, unknown>
  color?: string
}
export interface AtlasFile {
  data: {
    graph: { nodes: AtlasNode[]; edges: AtlasEdge[] }
    metadata?: { name?: string; description?: string; source?: string; notes?: string }
    displayConfig?: { nodeConfig?: { tags?: Record<string, { color?: string }>; types?: Record<string, { color?: string }> } }
    dimensions?: Record<string, { id: string; label?: string; kind?: string }>
  }
}

export function isAtlas(data: unknown): data is AtlasFile {
  const d = (data as { data?: { graph?: { nodes?: unknown; edges?: unknown } } } | undefined)?.data
  return !!d && typeof d === 'object' && !!d.graph && Array.isArray(d.graph.nodes) && Array.isArray(d.graph.edges)
}

/** The atlas's node type `entity` would collide with the generic default; everything else is kept as spelled. */
const TYPE_MAP: Record<string, string> = { entity: 'named-entity' }

/** Colours and categories for the node types the pipeline emits; unknown types get a hashed colour from the registry. */
const TYPE_DEFS: Record<string, { label: string; plural: string; category: 'resource' | 'knowledge'; color: string; description: string }> = {
  segment: { label: 'Segment', plural: 'Segments', category: 'resource', color: '#10a37f', description: 'One coherent topical stretch of a ChatGPT conversation, with its summary, excerpt and facets.' },
  topic: { label: 'Topic', plural: 'Topics', category: 'knowledge', color: '#9ece6a', description: 'A specific subject the segments are about (open facet).' },
  domain: { label: 'Domain', plural: 'Domains', category: 'knowledge', color: '#7aa2f7', description: 'A subject area (closed facet).' },
  theme: { label: 'Theme', plural: 'Themes', category: 'knowledge', color: '#bb9af7', description: 'The current under the surface topic (closed facet).' },
  persona: { label: 'Persona', plural: 'Personas', category: 'knowledge', color: '#e0af68', description: 'A self-designation the user wrote under.' },
  'named-entity': { label: 'Named entity', plural: 'Named entities', category: 'knowledge', color: '#f7768e', description: 'A person, work, system or place the conversations mention.' },
  cluster: { label: 'Cluster', plural: 'Clusters', category: 'knowledge', color: '#2ac3de', description: 'A fine cluster of segments, found in the space of their labels.' },
  region: { label: 'Region', plural: 'Regions', category: 'knowledge', color: '#ff9e64', description: 'A coarse region: clusters agglomerated and named.' },
}

export interface ParsedAtlas {
  label: string
  description?: string
  entities: AnyEntity[]
  tags: TagInfo[]
  nodes: number
  edges: number
  types: string[]
}

/** A time from the file as ISO text, or `fallback` — a number no calendar reaches (1e300) is not a time, and `toISOString` would throw on it. */
const iso = (v: unknown, fallback: string): string => {
  const d = typeof v === 'string' ? new Date(v) : typeof v === 'number' && Number.isFinite(v) ? new Date(v > 1e12 ? v : v * 1000) : undefined
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : fallback
}

export function parseAtlas(file: AtlasFile, opts: { tag?: string; source?: string } = {}): ParsedAtlas {
  const { graph, metadata, displayConfig } = file.data
  const label = metadata?.name ?? 'Atlas'
  const stamp = new Date().toISOString()
  const source = opts.source ?? `import:${metadata?.source ?? 'atlas'}`
  const markTag = opts.tag
  const entities: AnyEntity[] = []
  const types = new Set<string>()
  const ids = new Set<EntityId>()

  for (const n of graph.nodes) {
    if (!n.id || ids.has(n.id)) continue
    ids.add(n.id)
    const given = typeof n.type === 'string' && n.type ? n.type : undefined
    const type = given === undefined ? 'entity' : Object.hasOwn(TYPE_MAP, given) ? TYPE_MAP[given] : given
    types.add(type)
    const ud = n.userData ?? {}
    const created = iso(ud.created ?? ud.created_ts, stamp)
    const updated = iso(ud.ended ?? ud.updated, created)
    const pos = n.position && (n.position.x || n.position.y || n.position.z) ? { position: n.position } : {}
    entities.push({
      id: n.id,
      kind: 'entity',
      type,
      label: n.label ?? n.id,
      description: typeof ud.description === 'string' && ud.description !== n.label ? ud.description : undefined,
      tags: uniqueTags([...(n.tags ?? []), ...(markTag ? [markTag] : [])]),
      data: { ...ud, ...(n.color ? { color: n.color } : {}), ...(typeof n.size === 'number' ? { size: n.size } : {}), ...pos },
      meta: { createdAt: created, updatedAt: updated, source },
    })
  }
  let edges = 0
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    const id = e.id ?? `${e.source}:::${e.type ?? 'related'}:::${e.target}`
    if (ids.has(id)) continue
    ids.add(id)
    edges++
    entities.push({
      id,
      kind: 'relationship',
      type: typeof e.type === 'string' && e.type ? e.type : 'related',
      label: e.label && e.label !== e.type ? e.label : undefined,
      tags: uniqueTags([...(e.tags ?? []).filter((t) => !t.startsWith('rel:')), ...(markTag ? [markTag] : [])]),
      data: { ...(e.userData ?? {}), ...(e.color ? { color: e.color } : {}) },
      meta: { createdAt: stamp, updatedAt: stamp, source },
      source: { id: e.source },
      target: { id: e.target },
      directed: true,
    })
  }

  // Type definitions for the vocabulary the file uses, so the Types page and colours are right on first load.
  for (const t of types) {
    const def = Object.hasOwn(TYPE_DEFS, t) ? TYPE_DEFS[t] : undefined
    if (!def) continue
    entities.push({
      id: `type:${t}`,
      kind: 'entity',
      type: SCHEMA_TYPE,
      label: def.label,
      description: def.description,
      tags: markTag ? [markTag] : [],
      data: { name: t, category: def.category, color: def.color, pluralLabel: def.plural },
      meta: { createdAt: stamp, updatedAt: stamp, source },
    })
  }

  // Tag colours from the display config; the `kind:` namespace only mirrors the type, so its tags get no colour.
  const tags: TagInfo[] = []
  const tagColours = displayConfig?.nodeConfig?.tags ?? {}
  for (const [tag, cfg] of Object.entries(tagColours)) if (cfg?.color) tags.push({ tag, color: cfg.color })
  if (markTag) tags.push({ tag: markTag, color: '#10a37f', description: `Loaded from ${label}` })

  return { label, description: metadata?.description, entities, tags, nodes: ids.size - edges, edges, types: [...types].sort() }
}

// ── Conversations ↔ atlas ─────────────────────────────────────────────

/** What a conversation carries about its segments once linked: enough for the viewer to mark them without a lookup. */
export interface AtlasSegmentRef {
  id: EntityId
  index: number
  label: string
  summary?: string
  /** Messages in this segment, in thread order; the viewer turns the sequence into ranges. */
  messages?: number
  region?: string
  cluster?: string
  topics: string[]
  domains: string[]
}

/** Edge types from a segment to a hub that make sense lifted to the conversation. */
const LIFTED = new Set(['in-region', 'in-cluster', 'on-topic', 'in-domain', 'has-theme', 'mentions', 'about-persona'])
/** Facet namespaces whose tags move from segments onto their conversation. */
const LIFTED_TAGS = /^(region|cluster|domain|topic|theme|persona|entity|year|era|intent|mode|stakes):/

/**
 * Join the atlas to the raw conversations: every segment points at its
 * conversation (`segment-of`), the conversation inherits the segments'
 * facet tags and their links to regions, clusters, topics, domains,
 * themes, personas and named entities (one relationship per hub, weight =
 * how many segments), and gets an `atlas` block for the viewer. Pure over
 * whatever entities are passed in — the store's contents, or a batch
 * about to be written.
 */
export function linkAtlasConversations(all: Iterable<AnyEntity>): { relationships: Relationship[]; conversations: AnyEntity[]; segments: number; linked: number } {
  const byId = new Map<EntityId, AnyEntity>()
  const segments: AnyEntity[] = []
  const conversations = new Map<EntityId, AnyEntity>()
  const outgoing = new Map<EntityId, Relationship[]>()
  for (const e of all) {
    byId.set(e.id, e)
    if (isRelationship(e)) {
      const list = outgoing.get(e.source.id)
      if (list) list.push(e)
      else outgoing.set(e.source.id, [e])
    } else if (e.type === 'segment' && typeof e.data.conversation_id === 'string') segments.push(e)
    else if (e.type === 'conversation') conversations.set(e.id, e)
  }
  if (!segments.length || !conversations.size) return { relationships: [], conversations: [], segments: segments.length, linked: 0 }

  const stamp = new Date().toISOString()
  const meta = { createdAt: stamp, updatedAt: stamp, source: 'import:atlas' }
  const relationships: Relationship[] = []
  const lifted = new Map<string, { conv: EntityId; hub: EntityId; type: string; weight: number }>()
  const perConv = new Map<EntityId, { tags: Set<string>; segments: AtlasSegmentRef[] }>()

  for (const seg of segments.sort((a, b) => Number(a.data.segment_index ?? 0) - Number(b.data.segment_index ?? 0))) {
    const convId = conversationIdFor(String(seg.data.conversation_id))
    const conv = conversations.get(convId)
    if (!conv) continue
    relationships.push(createRelationship({ id: `${seg.id}:::segment-of:::${convId}`, type: 'segment-of', label: 'segment of', source: seg.id, target: convId, data: { segment_index: seg.data.segment_index }, meta }))
    const acc = perConv.get(convId) ?? { tags: new Set<string>(), segments: [] }
    perConv.set(convId, acc)
    for (const t of seg.tags) if (LIFTED_TAGS.test(t)) acc.tags.add(t)
    const facets = (seg.data.facets ?? {}) as Record<string, unknown>
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
    acc.segments.push({
      id: seg.id,
      index: Number(seg.data.segment_index ?? acc.segments.length),
      label: seg.label ?? seg.id,
      summary: typeof seg.data.summary === 'string' ? seg.data.summary : undefined,
      messages: typeof seg.data.n_messages === 'number' ? seg.data.n_messages : undefined,
      region: typeof seg.data.region === 'string' ? seg.data.region : undefined,
      cluster: typeof seg.data.cluster === 'string' ? seg.data.cluster : undefined,
      topics: list(facets.topic),
      domains: list(facets.domain),
    })
    for (const r of outgoing.get(seg.id) ?? []) {
      if (!LIFTED.has(r.type) || !byId.has(r.target.id)) continue
      const key = `${convId}:::${r.type}:::${r.target.id}`
      const cur = lifted.get(key)
      if (cur) cur.weight++
      else lifted.set(key, { conv: convId, hub: r.target.id, type: r.type, weight: 1 })
    }
  }
  for (const [key, l] of lifted) relationships.push(createRelationship({ id: key, type: l.type, source: l.conv, target: l.hub, data: { weight: l.weight, via: 'segments' }, meta }))

  const updated: AnyEntity[] = []
  for (const [convId, acc] of perConv) {
    const conv = conversations.get(convId)!
    const tags = [...new Set([...conv.tags, ...acc.tags])]
    updated.push({ ...conv, tags, data: { ...conv.data, atlas: { segments: acc.segments, regions: [...new Set(acc.segments.map((s) => s.region).filter(Boolean))], clusters: [...new Set(acc.segments.map((s) => s.cluster).filter(Boolean))] } }, meta: { ...conv.meta, updatedAt: stamp } })
  }
  return { relationships, conversations: updated, segments: segments.length, linked: updated.length }
}
