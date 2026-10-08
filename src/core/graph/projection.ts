import { ScanSearch } from 'lucide-react'
import { createEntity } from '../entity/entity'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import { isRelationship, type AnyEntity, type Entity, type EntityData, type EntityId } from '../entity/types'
import { emptyGeometry, type DiagramGeometry, type EdgeGeom, type GroupGeom, type NodeGeom } from '../diagrams/geometry'
import type { ImportPlan } from '../diagrams/mapping'
import type { ParsedDiagram } from '../diagrams/model'

/**
 * A scene (type key `projection`, kept for saved data) is a 2D arrangement
 * of entities: where each one sits, how big it is, what shape and colour,
 * how the relationships between them are routed, and which boxes group
 * them. It is what the Scenes page draws. Imports write one so a diagram
 * can be checked one-to-one against its source; people make new ones by
 * arranging things by hand.
 *
 * Scene is the root of a small family. Its subtypes (`parent: 'projection'`)
 * are **script scenes** (`scene:script`, this same geometry, produced by a
 * script's `scene(positions)` and remembering which script) and **graph
 * scenes** (`scene`, in ./scene.ts — a Unigraph composition rather
 * than fixed positions). `SCENE_FAMILY` names the family for anything that
 * lists scenes; `isProjection` accepts every member that carries geometry.
 */

export const PROJECTION_TYPE = 'projection'
export const SCRIPT_SCENE_TYPE = 'scene:script'
/** The graph scene's keys live in ./scene.ts; named here so the family can be listed without a cycle. The bare `scene` is the
 * graph scene of old saves; `scene:unigraph` is what Unigraph saves; `scene:explorer` what the Graph Explorer it replaced saved. */
export const GRAPH_SCENE_TYPE = 'scene'
export const GRAPH_SCENE_SUBTYPES = ['scene:explorer', 'scene:unigraph'] as const

/** What a scene is for someone reading a list: the plain one, one a script made, or a Unigraph composition. */
export type SceneKind = 'scene' | 'script' | 'graph'
export const sceneKindOf = (type: string): SceneKind | undefined => (type === PROJECTION_TYPE ? 'scene' : type === SCRIPT_SCENE_TYPE ? 'script' : type === GRAPH_SCENE_TYPE || (GRAPH_SCENE_SUBTYPES as readonly string[]).includes(type) ? 'graph' : undefined)
/** The type keys of the family — the root and its subtypes, the graph scene's own subtypes included — for `store.query({ type })`. */
export const SCENE_FAMILY = [PROJECTION_TYPE, SCRIPT_SCENE_TYPE, GRAPH_SCENE_TYPE, ...GRAPH_SCENE_SUBTYPES] as const

/** A group box: its members (entities and nested groups), and the padding it keeps around them when it refits. */
export interface ProjectionGroup extends GroupGeom {
  title?: string
  members?: EntityId[]
  parent?: string
  pad?: { l: number; t: number; r: number; b: number }
}

export interface ProjectionData extends EntityData {
  kind: '2d'
  width: number
  height: number
  background?: string
  nodes: Record<EntityId, NodeGeom>
  edges: Record<EntityId, EdgeGeom>
  groups: Record<string, ProjectionGroup>
  /** Where the geometry came from: captured from a diagram, or produced by a script (a script scene). */
  source?: { diagramId: EntityId; format: string; engine?: string; capturedAt: string } | { scriptId: EntityId; ranAt: string }
}

export type ProjectionEntity = Entity<ProjectionData>

/** A scene with geometry the Scenes page can draw: the root type or a script scene (a graph scene has none). */
export const isProjection = (e: AnyEntity | undefined): e is ProjectionEntity => !!e && !isRelationship(e) && (e.type === PROJECTION_TYPE || e.type === SCRIPT_SCENE_TYPE) && !!e.data.nodes
export const isScriptScene = (e: AnyEntity | undefined): e is ProjectionEntity => isProjection(e) && e.type === SCRIPT_SCENE_TYPE
/** The diagram a scene was captured from, when it was. */
export const diagramSourceOf = (d: ProjectionData | null | undefined): { diagramId: EntityId; format: string; engine?: string; capturedAt: string } | undefined => (d?.source && 'diagramId' in d.source ? d.source : undefined)
/** The script that produced a scene, when one did. */
export const scriptSourceOf = (d: ProjectionData | null | undefined): { scriptId: EntityId; ranAt: string } | undefined => (d?.source && 'scriptId' in d.source ? d.source : undefined)

export const projectionType: EntityTypeDef = defineEntityType({
  type: PROJECTION_TYPE,
  label: 'Scene',
  pluralLabel: 'Scenes',
  category: 'project',
  icon: ScanSearch,
  color: '#7c3aed',
  description: 'A 2D arrangement of entities — positions, sizes, shapes, colours, edge routes and group boxes — drawn by the Scenes page. Captured from diagram imports or arranged by hand.',
  fields: [
    { key: 'data.width', label: 'Width', kind: 'number', width: 80 },
    { key: 'data.height', label: 'Height', kind: 'number', width: 80 },
    { key: 'data.source.format', label: 'From', kind: 'text', width: 100 },
    { key: 'data.source.diagramId', label: 'Diagram', kind: 'ref', width: 200 },
  ],
})

export const scriptSceneType: EntityTypeDef = defineEntityType({
  type: SCRIPT_SCENE_TYPE,
  label: 'Script scene',
  pluralLabel: 'Script scenes',
  parent: PROJECTION_TYPE,
  category: 'project',
  icon: ScanSearch,
  color: '#9333ea',
  description: 'A scene a script produced with scene(positions): the same geometry as a scene, and which script made it, so rerunning the script updates it rather than adding another.',
  fields: [
    { key: 'data.source.scriptId', label: 'Script', kind: 'ref', width: 200 },
    { key: 'data.source.ranAt', label: 'Ran', kind: 'date', width: 120 },
  ],
})

export const projectionIdFor = (diagramId: EntityId) => `dg-${diagramId.slice(0, 8)}-projection`

/** Rekey captured diagram geometry by the entity/relationship ids the import plan assigned. */
export function projectionFromPlan(diagram: AnyEntity, parsed: ParsedDiagram, geometry: DiagramGeometry, plan: ImportPlan, existing?: AnyEntity, engine?: string): ProjectionEntity {
  const data: ProjectionData = {
    kind: '2d',
    width: geometry.width,
    height: geometry.height,
    background: geometry.background,
    nodes: {},
    edges: {},
    groups: {},
    source: { diagramId: diagram.id, format: parsed.format, engine, capturedAt: new Date().toISOString() },
  }
  for (const [nodeId, geom] of Object.entries(geometry.nodes)) {
    const eid = plan.nodeIds[nodeId]
    if (eid) data.nodes[eid] = geom
  }
  for (const [edgeId, geom] of Object.entries(geometry.edges)) {
    const rid = plan.edgeIds[edgeId]
    if (rid) data.edges[rid] = geom
  }
  for (const [gid, geom] of Object.entries(geometry.groups)) {
    const grp = parsed.groups.find((g) => g.id === gid)
    // Two diagram nodes that collapsed onto one entity are one member.
    const members = [...new Set(parsed.nodes.filter((n) => n.group === gid).map((n) => plan.nodeIds[n.id]).filter((x): x is EntityId => !!x))]
    data.groups[gid] = { ...geom, title: grp?.label ?? gid, members, parent: grp?.parent }
  }
  const id = projectionIdFor(diagram.id)
  const prev = existing && isProjection(existing) ? existing : undefined
  return createEntity<ProjectionData>({
    id,
    type: PROJECTION_TYPE,
    label: prev?.label ?? `${diagram.label ?? 'Diagram'} · scene`,
    tags: prev?.tags ?? ['from-diagram'],
    data,
    meta: { ...(prev?.meta ?? {}), source: `import:${parsed.format}`, derivedFrom: { id: diagram.id }, updatedAt: new Date().toISOString() },
  })
}

/** A scene from a saved layout's positions: uniform boxes, straight edges, ready to be adjusted. */
export function projectionFromPositions(label: string, positions: Record<EntityId, { x: number; y: number }>, opts: { scale?: number; box?: { width: number; height: number } } = {}): ProjectionEntity {
  const g = geometryFromPositions(positions, opts)
  return createEntity<ProjectionData>({ type: PROJECTION_TYPE, label, tags: [], data: { kind: '2d', width: g.width, height: g.height, nodes: g.nodes, edges: {}, groups: {} }, meta: { source: 'user' } })
}

/**
 * A script scene: the positions a script returned, as a scene that remembers
 * the script. Rerunning the script writes the same entity (`existing`), so a
 * script that draws a picture has one scene, not one per run; the label
 * and any groups drawn by hand on it are kept.
 */
export function scriptSceneFrom(script: { id: EntityId; label?: string }, positions: Record<EntityId, { x: number; y: number }>, opts: { scale?: number; box?: { width: number; height: number }; label?: string; existing?: AnyEntity; ranAt?: string } = {}): ProjectionEntity {
  const g = geometryFromPositions(positions, opts)
  const ranAt = opts.ranAt ?? new Date().toISOString()
  const prev = isProjection(opts.existing) ? opts.existing : undefined
  const label = opts.label ?? prev?.label ?? script.label ?? 'Script scene'
  return createEntity<ProjectionData>({
    ...(prev ? { id: prev.id } : {}),
    type: SCRIPT_SCENE_TYPE,
    label,
    tags: prev?.tags ?? [],
    data: { kind: '2d', width: g.width, height: g.height, nodes: g.nodes, edges: {}, groups: prev?.data.groups ?? {}, source: { scriptId: script.id, ranAt } },
    meta: { ...(prev?.meta ?? {}), source: 'script', derivedFrom: { id: script.id }, updatedAt: ranAt },
  })
}

function geometryFromPositions(positions: Record<EntityId, { x: number; y: number }>, opts: { scale?: number; box?: { width: number; height: number } }): DiagramGeometry {
  const scale = opts.scale ?? 1
  const box = opts.box ?? { width: 140, height: 44 }
  const g = emptyGeometry()
  for (const [id, p] of Object.entries(positions)) g.nodes[id] = { x: p.x * scale, y: p.y * scale, width: box.width, height: box.height, shape: 'rounded' }
  const xs = Object.values(g.nodes)
  g.width = Math.ceil(Math.max(0, ...xs.map((n) => n.x + n.width / 2)) + 40)
  g.height = Math.ceil(Math.max(0, ...xs.map((n) => n.y + n.height / 2)) + 40)
  return g
}

/**
 * A scene back as a diagram, using the entities and relationships it
 * places — so a hand-arranged scene can be written out (Excalidraw, DOT,
 * Mermaid) or drawn as flat SVG with the same geometry.
 */
export function diagramFromProjection(proj: ProjectionData, entities: Map<EntityId, AnyEntity>, relationships: { id: EntityId; source: EntityId; target: EntityId; type: string; label?: string; directed: boolean }[]): ParsedDiagram {
  const d: ParsedDiagram = { format: 'excalidraw', kind: 'excalidraw', attrs: {}, nodes: [], edges: [], groups: [], warnings: [] }
  const g = emptyGeometry()
  g.width = proj.width
  g.height = proj.height
  g.background = proj.background
  const groupOf = new Map<EntityId, string>()
  for (const [gid, grp] of Object.entries(proj.groups)) {
    d.groups.push({ id: gid, label: grp.title ?? gid, parent: grp.parent, attrs: {} })
    g.groups[gid] = { x: grp.x, y: grp.y, width: grp.width, height: grp.height, fill: grp.fill, stroke: grp.stroke, label: grp.label }
    for (const m of grp.members ?? []) groupOf.set(m, gid)
  }
  for (const [id, geom] of Object.entries(proj.nodes)) {
    const e = entities.get(id)
    const label = e ? (e.kind === 'entity' ? (e.label ?? id) : id) : id
    d.nodes.push({ id, label, shape: geom.shape, group: groupOf.get(id), classes: e ? [e.type] : [], attrs: {} })
    g.nodes[id] = geom
  }
  const placed = new Set(Object.keys(proj.nodes))
  for (const r of relationships) {
    if (!placed.has(r.source) || !placed.has(r.target)) continue
    // Relationship types are what edge labels became on the way in, so they go back out as labels (as diagramFromEntities does).
    d.edges.push({ id: r.id, source: r.source, target: r.target, label: r.label ?? r.type, directed: r.directed, attrs: {} })
    const geom = proj.edges[r.id]
    if (geom) g.edges[r.id] = geom
  }
  d.geometry = g
  return d
}
