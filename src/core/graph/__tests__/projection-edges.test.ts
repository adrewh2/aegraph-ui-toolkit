import { describe, expect, it } from 'vitest'
import { emptyGeometry, type DiagramGeometry } from '../../diagrams/geometry'
import type { ImportPlan } from '../../diagrams/mapping'
import { emptyDiagram, upsertNode } from '../../diagrams/model'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity } from '../../entity/types'
import { diagramFromProjection, diagramSourceOf, isProjection, isScriptScene, projectionFromPlan, projectionFromPositions, projectionIdFor, SCENE_FAMILY, sceneKindOf, SCRIPT_SCENE_TYPE, scriptSceneFrom, scriptSourceOf, type ProjectionData } from '../projection'
import { TypeRegistry } from '../../entity/typeRegistry'
import { EntityStore } from '../../entity/store'
import '../scene'

/**
 * Scenes at their edges: rekeying captured geometry when two diagram
 * nodes collapsed onto one entity, when an edge was skipped, when a
 * node or group has no plan id, when a group is nested; what an earlier
 * scene lends (label, tags, creation time) and what it does not; a
 * scene from positions with none, with negatives and with a scale; a
 * scene back as a diagram with entities missing, a relationship where
 * an entity should be, edges to unplaced nodes, edges without a route,
 * groups without members or with members not placed, and the parent.
 */
const plan = (nodeIds: Record<string, string>, edgeIds: Record<string, string> = {}): ImportPlan => ({ entities: [], relationships: [], reused: [], created: 0, updated: 0, collapsed: 0, skippedEdges: 0, nodeIds, edgeIds })
const geom = (nodes: Record<string, [number, number]>, edges: string[] = [], groups: string[] = []): DiagramGeometry => ({
  ...emptyGeometry(),
  width: 500,
  height: 300,
  background: '#fafafa',
  nodes: Object.fromEntries(Object.entries(nodes).map(([id, [x, y]]) => [id, { x, y, width: 100, height: 40, shape: 'box' }])),
  edges: Object.fromEntries(edges.map((id) => [id, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], curve: 'line' as const }])),
  groups: Object.fromEntries(groups.map((id, i) => [id, { x: i * 10, y: 0, width: 200, height: 100 }])),
})
const diagram = createEntity({ id: 'diagram-123456789', type: 'diagram', label: 'Sketch', data: { format: 'dot', source: '' } })

describe('projectionFromPlan', () => {
  it('rekeys nodes and edges by the plan, keeps one box for two collapsed nodes, drops what the plan skipped, and records where it came from', () => {
    const parsed = emptyDiagram('dot')
    for (const id of ['p1', 'p2', 'q']) upsertNode(parsed, id, { label: id })
    const p = plan({ p1: 'plato', p2: 'plato', q: 'dg-x-n-q' }, { e1: 'r1' })
    const proj = projectionFromPlan(diagram, parsed, geom({ p1: [10, 10], p2: [20, 20], q: [30, 30], stray: [40, 40] }, ['e1', 'e2']), p, undefined, 'graphviz')
    expect(proj.id).toBe('dg-diagram--projection')
    expect(projectionIdFor('abcdefghijk')).toBe('dg-abcdefgh-projection')
    expect(Object.keys(proj.data.nodes).sort()).toEqual(['dg-x-n-q', 'plato'])
    expect(proj.data.nodes.plato).toMatchObject({ x: 20, y: 20 }) // the later of the two collapsed boxes
    expect(Object.keys(proj.data.edges)).toEqual(['r1'])
    expect(proj.data).toMatchObject({ kind: '2d', width: 500, height: 300, background: '#fafafa', source: { diagramId: diagram.id, format: 'dot', engine: 'graphviz' } })
    expect((proj.data.source as { capturedAt?: string })?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(proj).toMatchObject({ type: 'projection', label: 'Sketch · scene', tags: ['from-diagram'] })
    expect(proj.meta).toMatchObject({ source: 'import:dot', derivedFrom: { id: diagram.id } })
    expect(isProjection(proj)).toBe(true)
  })

  it('keeps every geometry group, titled by the diagram or by its id, with members placed by the plan once each, and the parent', () => {
    const parsed = emptyDiagram('dot')
    upsertNode(parsed, 'p1', { label: 'P', group: 'cluster_a' })
    upsertNode(parsed, 'p2', { label: 'P', group: 'cluster_a' })
    upsertNode(parsed, 'lost', { label: 'L', group: 'cluster_a' })
    upsertNode(parsed, 'q', { label: 'Q', group: 'cluster_b' })
    parsed.groups.push({ id: 'cluster_a', label: 'A', attrs: {} }, { id: 'cluster_b', label: 'B', parent: 'cluster_a', attrs: {} })
    const p = plan({ p1: 'plato', p2: 'plato', q: 'q-ent' })
    const proj = projectionFromPlan(diagram, parsed, geom({ p1: [0, 0], p2: [0, 0], q: [0, 0] }, [], ['cluster_a', 'cluster_b', 'cluster_ghost']), p)
    expect(proj.data.groups.cluster_a).toMatchObject({ title: 'A', members: ['plato'], parent: undefined, x: 0, width: 200 })
    expect(proj.data.groups.cluster_b).toMatchObject({ title: 'B', members: ['q-ent'], parent: 'cluster_a', x: 10 })
    expect(proj.data.groups.cluster_ghost).toMatchObject({ title: 'cluster_ghost', members: [], x: 20 })
  })

  it('takes the label, tags and creation time of an earlier scene, but not from something that is not one, and names an unlabelled diagram', () => {
    const parsed = emptyDiagram('mermaid')
    const g = geom({})
    const earlier = createEntity<ProjectionData>({ id: 'x', type: 'projection', label: 'My scene', tags: ['mine'], data: { kind: '2d', width: 1, height: 1, nodes: {}, edges: {}, groups: {} }, meta: { createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', source: 'user' } })
    const kept = projectionFromPlan(diagram, parsed, g, plan({}), earlier)
    expect(kept).toMatchObject({ label: 'My scene', tags: ['mine'] })
    expect(kept.meta.createdAt).toBe('2020-01-01T00:00:00Z')
    expect(kept.meta.updatedAt).not.toBe('2020-01-01T00:00:00Z')
    expect(kept.meta.source).toBe('import:mermaid')
    const notOne = createEntity({ id: 'y', type: 'note', label: 'Note' })
    expect(projectionFromPlan(diagram, parsed, g, plan({}), notOne)).toMatchObject({ label: 'Sketch · scene', tags: ['from-diagram'] })
    const nameless = createEntity({ id: 'diagram-2', type: 'diagram', data: { format: 'dot', source: '' } })
    expect(projectionFromPlan(nameless, parsed, g, plan({})).label).toBe('Diagram · scene')
  })

  it('recognises a scene by type and by having nodes, never a relationship or nothing', () => {
    expect(isProjection(undefined)).toBe(false)
    expect(isProjection(createEntity({ id: 'a', type: 'projection', data: { kind: '2d' } }))).toBe(false)
    expect(isProjection(createEntity({ id: 'a', type: 'projection', data: { nodes: {} } }))).toBe(true)
    expect(isProjection(createEntity({ id: 'a', type: 'layout', data: { nodes: {} } }))).toBe(false)
    expect(isProjection(createRelationship({ id: 'r', type: 'projection', source: 'a', target: 'b', data: { nodes: {} } }))).toBe(false)
  })
})

describe('projectionFromPositions', () => {
  it('draws uniform rounded boxes, scaled, sized to the farthest box plus a margin, and never smaller than the margin', () => {
    const p = projectionFromPositions('L', { a: { x: 10, y: 20 }, b: { x: -300, y: -300 } }, { scale: 2, box: { width: 50, height: 10 } })
    expect(p).toMatchObject({ type: 'projection', label: 'L', tags: [], meta: { source: 'user' } })
    expect(p.data.nodes.a).toEqual({ x: 20, y: 40, width: 50, height: 10, shape: 'rounded' })
    expect(p.data.nodes.b).toMatchObject({ x: -600, y: -600 })
    expect([p.data.width, p.data.height]).toEqual([20 + 25 + 40, 40 + 5 + 40]) // negatives do not widen the canvas
    expect(projectionFromPositions('E', {}).data).toMatchObject({ width: 40, height: 40, nodes: {}, edges: {}, groups: {} })
    expect(projectionFromPositions('D', { a: { x: 0, y: 0 } }).data.nodes.a).toMatchObject({ width: 140, height: 44 })
    expect(isProjection(p)).toBe(true)
  })
})

describe('diagramFromProjection', () => {
  const proj: ProjectionData = {
    kind: '2d',
    width: 600,
    height: 300,
    background: '#eee',
    nodes: { a: { x: 100, y: 100, width: 120, height: 50, shape: 'rounded' }, b: { x: 400, y: 100, width: 120, height: 50 }, ghost: { x: 0, y: 0, width: 10, height: 10 } },
    edges: { r: { points: [{ x: 160, y: 100 }, { x: 340, y: 100 }], curve: 'line' } },
    groups: {
      g: { x: 20, y: 40, width: 260, height: 120, title: 'People', members: ['a', 'unplaced'], fill: '#fee', label: { x: 30, y: 50 } },
      h: { x: 300, y: 40, width: 10, height: 10, parent: 'g' },
    },
  }
  const entities = new Map<string, AnyEntity>([
    ['a', createEntity({ id: 'a', type: 'person', label: 'Ada' })],
    ['b', createEntity({ id: 'b', type: 'work' })],
    ['rel-as-node', createRelationship({ id: 'rel-as-node', type: 'odd', source: 'a', target: 'b', label: 'Rel' })],
  ])
  const rels = [
    { id: 'r', source: 'a', target: 'b', type: 'wrote', directed: true },
    { id: 'r2', source: 'b', target: 'a', type: 'cites', label: 'Cites', directed: false },
    { id: 'r3', source: 'a', target: 'nowhere', type: 'x', directed: true },
  ]

  it('names nodes by their entity or their id, classes them by type, groups them by membership, and carries every group with its parent', () => {
    const d = diagramFromProjection({ ...proj, nodes: { ...proj.nodes, 'rel-as-node': { x: 0, y: 0, width: 1, height: 1 } } }, entities, rels)
    expect(d.nodes.map((n) => [n.id, n.label, n.shape, n.group, n.classes])).toEqual([
      ['a', 'Ada', 'rounded', 'g', ['person']],
      ['b', 'b', undefined, undefined, ['work']],
      ['ghost', 'ghost', undefined, undefined, []],
      ['rel-as-node', 'rel-as-node', undefined, undefined, ['odd']], // a relationship where an entity should be: its id, its type
    ])
    expect(d.groups).toEqual([{ id: 'g', label: 'People', parent: undefined, attrs: {} }, { id: 'h', label: 'h', parent: 'g', attrs: {} }])
    expect(d.geometry!.groups.g).toEqual({ x: 20, y: 40, width: 260, height: 120, fill: '#fee', stroke: undefined, label: { x: 30, y: 50 } })
    expect(d.geometry).toMatchObject({ width: 600, height: 300, background: '#eee' })
    expect(d.format).toBe('excalidraw')
  })

  it('keeps only relationships between placed nodes, labels them by label or type, and carries a route only when the scene has one', () => {
    const d = diagramFromProjection(proj, entities, rels)
    expect(d.edges.map((e) => [e.id, e.label, e.directed])).toEqual([['r', 'wrote', true], ['r2', 'Cites', false]])
    expect(Object.keys(d.geometry!.edges)).toEqual(['r'])
    expect(diagramFromProjection({ ...proj, nodes: {} }, entities, rels).edges).toEqual([])
    expect(diagramFromProjection({ ...proj, groups: {} }, new Map(), []).groups).toEqual([])
  })
})

describe('the scene family', () => {
  it('names three kinds: the scene, the script scene and the graph scene (with a subtype per page), all under one parent', () => {
    expect(sceneKindOf('projection')).toBe('scene')
    expect(sceneKindOf(SCRIPT_SCENE_TYPE)).toBe('script')
    expect(sceneKindOf('scene')).toBe('graph')
    // The graph scene's own subtypes — which page composed it — are graph scenes too.
    expect(sceneKindOf('scene:explorer')).toBe('graph')
    expect(sceneKindOf('scene:unigraph')).toBe('graph')
    expect(sceneKindOf('document')).toBeUndefined()
    expect([...SCENE_FAMILY].sort()).toEqual(['projection', 'scene', 'scene:explorer', 'scene:script', 'scene:unigraph'])
    const registry = new TypeRegistry(new EntityStore())
    expect(registry.get(SCRIPT_SCENE_TYPE).parent).toBe('projection')
    expect(registry.get('scene').parent).toBe('projection')
    expect(registry.get('scene:explorer').parent).toBe('scene')
    expect(registry.get('scene:unigraph').parent).toBe('scene')
    expect(registry.withSubtypes('projection').sort()).toEqual(['projection', 'scene', 'scene:explorer', 'scene:script', 'scene:unigraph'])
    expect(registry.rootOf('scene:script')).toBe('projection')
    expect(registry.rootOf('scene:unigraph')).toBe('projection')
    // A script scene inherits the scene's table columns and adds its own.
    const keys = registry.fieldsFor(SCRIPT_SCENE_TYPE).map((f) => f.key)
    expect(keys).toEqual(expect.arrayContaining(['data.width', 'data.source.scriptId', 'data.source.ranAt']))
  })

  it('a script scene carries the geometry and remembers its script; a rerun keeps the id, the label and the hand-drawn groups', () => {
    const first = scriptSceneFrom({ id: 'sc1', label: 'Layout by year' }, { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, { scale: 10, ranAt: '2026-09-19T10:00:00.000Z' })
    expect(first.type).toBe(SCRIPT_SCENE_TYPE)
    expect(first.label).toBe('Layout by year')
    expect(isProjection(first)).toBe(true)
    expect(isScriptScene(first)).toBe(true)
    expect(scriptSourceOf(first.data)).toEqual({ scriptId: 'sc1', ranAt: '2026-09-19T10:00:00.000Z' })
    expect(diagramSourceOf(first.data)).toBeUndefined()
    expect(first.data.nodes.a).toMatchObject({ x: 10, y: 20 })
    expect(first.meta.derivedFrom).toEqual({ id: 'sc1' })
    expect(first.meta.source).toBe('script')

    const kept = { ...first, label: 'My picture', tags: ['keep'], data: { ...first.data, groups: { g: { x: 0, y: 0, width: 50, height: 50, title: 'Group', members: ['a'] } } } }
    const again = scriptSceneFrom({ id: 'sc1', label: 'Layout by year' }, { a: { x: 5, y: 5 }, c: { x: 6, y: 6 } }, { existing: kept, ranAt: '2026-09-19T11:00:00.000Z' })
    expect(again.id).toBe(first.id)
    expect(again.label).toBe('My picture')
    expect(again.tags).toEqual(['keep'])
    expect(Object.keys(again.data.nodes).sort()).toEqual(['a', 'c'])
    expect(again.data.groups.g.title).toBe('Group')
    expect(scriptSourceOf(again.data)?.ranAt).toBe('2026-09-19T11:00:00.000Z')
    expect(again.meta.createdAt).toBe(first.meta.createdAt)
    // A label passed explicitly wins; an existing entity that is not a scene is ignored.
    expect(scriptSceneFrom({ id: 'sc1' }, {}, { label: 'Named', existing: createEntity({ id: 'x', type: 'note', label: 'N' }) })).toMatchObject({ label: 'Named', id: expect.not.stringMatching(/^x$/) })
    expect(scriptSceneFrom({ id: 'sc2' }, {}).label).toBe('Script scene')
  })

  it('a plain scene made from positions is not a script scene, and a graph scene has no geometry to draw', () => {
    const plain = projectionFromPositions('Plain', { a: { x: 0, y: 0 } })
    expect(plain.type).toBe('projection')
    expect(isScriptScene(plain)).toBe(false)
    const graph = createEntity({ id: 'g', type: 'scene', label: 'Graph', data: { renderer: '2d' } })
    expect(isProjection(graph)).toBe(false)
    expect(sceneKindOf(graph.type)).toBe('graph')
  })
})
