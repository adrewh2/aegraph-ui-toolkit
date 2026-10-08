import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { schemaTypeEntity } from '../../entity/typeRegistry'
import '../../resources/types'
import { parseDiagram } from '../index'
import { applyPlan, describeMapping, edgeKey, importedEntityId, inferMapping, keyStats, nodeKey, planImport, removeImported, slugType, type MappingSpec } from '../mapping'
import { addEdge, emptyDiagram, upsertNode } from '../model'

/**
 * The diagram importer at its edges: a node without a label, an edge
 * whose end is a cluster or nothing, two nodes with one label against
 * an existing entity (collapsed) and against each other (kept apart), a
 * node id that names a project, a type definition or a diagram (never
 * reused), what a merged entity gains and keeps, what an own entity
 * gets refreshed, parallel edges, the diagram link added once, a
 * relationship's creation time kept across re-imports, removal under a
 * project scope, inference for every kind and signal, and the helpers.
 */
const fixed = (over: Partial<MappingSpec> = {}): MappingSpec => ({ nodeTypeBy: 'fixed', nodeTypes: {}, fixedNodeType: 'concept', edgeTypeBy: 'fixed', edgeTypes: {}, fixedEdgeType: 'related', tags: [], mergeByLabel: true, linkToDiagram: false, attrsToData: true, ...over })
const diagramEntity = (store: EntityStore, id = 'diagram-x') => {
  const d = createEntity({ id, type: 'diagram', label: 'D', data: { format: 'dot', source: '' } })
  store.upsert(d)
  return d
}

describe('diagram mapping edges', () => {
  it('labels a node by its id when it has none, skips and counts an edge to a cluster or to nothing, and keeps a self-loop', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    const d = emptyDiagram('dot', 'digraph')
    upsertNode(d, 'a', { label: '   ' })
    upsertNode(d, 'b', { label: 'B', group: 'cluster_g' })
    d.groups.push({ id: 'cluster_g', label: 'G', attrs: {} })
    addEdge(d, { source: 'a', target: 'cluster_g', directed: true, attrs: {} })
    addEdge(d, { source: 'ghost', target: 'a', directed: true, attrs: {} })
    addEdge(d, { source: 'a', target: 'a', directed: true, attrs: {} })
    const plan = planImport(s, dg, d, fixed())
    expect(plan.entities.map((e) => e.label)).toEqual(['a', 'B'])
    expect(plan.relationships).toHaveLength(1)
    expect(plan.relationships[0]).toMatchObject({ source: { id: importedEntityId(dg.id, 'a') }, target: { id: importedEntityId(dg.id, 'a') } })
    expect(plan.skippedEdges).toBe(2)
    expect(Object.keys(plan.edgeIds)).toEqual(['e3'])
  })

  it('collapses two nodes onto one existing entity by label, but keeps two same-labelled nodes apart when nothing exists, and never merges by label when told not to', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    const d = emptyDiagram('dot', 'digraph')
    upsertNode(d, 'p1', { label: 'Plato' })
    upsertNode(d, 'p2', { label: 'PLATO ' })
    addEdge(d, { source: 'p1', target: 'p2', directed: true, attrs: {} })
    const apart = planImport(s, dg, d, fixed())
    expect(apart).toMatchObject({ created: 2, updated: 0, collapsed: 0 })
    expect(apart.entities.map((e) => e.id)).toEqual([importedEntityId(dg.id, 'p1'), importedEntityId(dg.id, 'p2')])
    s.upsert(createEntity({ id: 'plato', type: 'philosopher', label: 'plato' }))
    const merged = planImport(s, dg, d, fixed())
    expect(merged).toMatchObject({ created: 0, updated: 2, collapsed: 1 })
    expect(merged.entities.map((e) => e.id)).toEqual(['plato', 'plato'])
    expect(merged.reused.map((r) => r.nodeId)).toEqual(['p1', 'p2'])
    expect(merged.nodeIds).toEqual({ p1: 'plato', p2: 'plato' })
    expect(merged.relationships[0]).toMatchObject({ source: { id: 'plato' }, target: { id: 'plato' } }) // the edge between them became a loop
    const off = planImport(s, dg, d, fixed({ mergeByLabel: false }))
    expect(off).toMatchObject({ created: 2, collapsed: 0 })
    expect(off.reused).toEqual([])
  })

  it('reuses an entity the node id names, but never a project, a type definition, a diagram or a relationship — by id or by label', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    s.upsertMany([
      createEntity({ id: 'plain', type: 'note', label: 'Plain' }),
      createEntity({ id: 'proj', type: 'project', label: 'Project', data: { members: [] } }),
      schemaTypeEntity('thing', { label: 'Thing' }),
      createEntity({ id: 'other-diagram', type: 'diagram', label: 'Other', data: { format: 'dot', source: '' } }),
      createRelationship({ id: 'rel', type: 'r', source: 'plain', target: 'plain', label: 'Rel' }),
      createEntity({ id: 'lay', type: 'layout', label: 'Lay', data: { positions: {} } }),
      createEntity({ id: 'ws', type: 'workstation', label: 'Desk', data: {} }),
    ])
    const d = emptyDiagram('dot', 'digraph')
    for (const [id, label] of [['plain', 'x'], ['proj', 'y'], ['schema:type:thing', 'z'], ['other-diagram', 'w'], ['rel', 'Rel'], ['lay', 'v'], ['n', 'Project'], ['t', 'Thing'], ['u', 'Desk'], ['q', 'Other']]) upsertNode(d, id, { label })
    const plan = planImport(s, dg, d, fixed())
    expect(plan.reused.map((r) => r.entity.id)).toEqual(['plain'])
    expect(plan.created).toBe(9)
    expect(plan.entities.map((e) => e.id)).toContain('plain')
    expect(plan.entities.filter((e) => ['proj', 'schema:type:thing', 'other-diagram', 'rel', 'lay', 'ws'].includes(e.id))).toEqual([])
  })

  it('gives a merged entity tags and missing data only, refreshes an own entity in place, and accumulates tags across mappings', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    s.upsert(createEntity({ id: 'ada', type: 'person', label: 'Ada', description: 'kept', tags: ['old'], data: { shape: 'theirs', keep: 1 } }))
    const d = emptyDiagram('dot', 'digraph')
    upsertNode(d, 'a', { label: 'ada', shape: 'box', classes: ['c1', 'c2'], group: 'g', attrs: { color: 'red' } })
    upsertNode(d, 'b', { label: 'Bee', shape: 'ellipse' })
    const m = fixed({ nodeTypeBy: 'shape', nodeTypes: { box: 'square' }, tags: ['t1'] })
    const plan = planImport(s, dg, d, m)
    const ada = plan.entities.find((e) => e.id === 'ada')!
    expect(ada).toMatchObject({ type: 'person', label: 'Ada', description: 'kept', tags: ['old', 't1'], data: { shape: 'theirs', keep: 1, classes: ['c1', 'c2'], group: 'g', color: 'red', diagramNodeId: 'a' } })
    const bee = plan.entities.find((e) => e.label === 'Bee')!
    expect(bee).toMatchObject({ type: 'concept', tags: ['t1'], data: { shape: 'ellipse', diagramNodeId: 'b' } }) // ellipse is not mapped: the fixed type
    expect(bee.meta).toMatchObject({ source: 'import:dot', derivedFrom: { id: dg.id } })
    applyPlan(s, plan)
    s.update(bee.id, { description: 'mine' })
    upsertNode(d, 'b', { label: 'Bee 2', shape: 'box', attrs: { color: 'blue' } })
    const again = planImport(s, dg, d, { ...m, tags: ['t2'] })
    expect(again).toMatchObject({ created: 0, updated: 2, collapsed: 0, reused: [{ nodeId: 'a', entity: expect.objectContaining({ id: 'ada' }) }] })
    const bee2 = again.entities.find((e) => e.id === bee.id)!
    expect(bee2).toMatchObject({ label: 'Bee 2', type: 'square', description: 'mine', tags: ['t1', 't2'], data: { shape: 'box', color: 'blue', diagramNodeId: 'b' } })
    upsertNode(d, 'c', { label: 'C', shape: 'box', attrs: { color: 'red' } })
    expect(planImport(s, dg, d, fixed({ attrsToData: false })).entities[2].data).toEqual({ diagramNodeId: 'c' })
  })

  it('numbers parallel edges of one type, types edges by label, style or nothing, keeps the label as a label or as data, and keeps the creation time of a relationship across imports', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    const d = parseDiagram('digraph { a -> b [label="knows"]; a -> b [label=" knows "]; a -> b [label="likes", style=dotted]; a -> b; b -> a }', 'dot')
    const byLabel = planImport(s, dg, d, fixed({ edgeTypeBy: 'label', edgeTypes: { knows: 'knows' } }))
    expect(byLabel.relationships.map((r) => [r.type, r.label, r.data.label, r.data.style])).toEqual([
      ['knows', undefined, undefined, undefined],
      ['knows', undefined, ' knows ', undefined], // the raw label differs from the trimmed key, so it is kept as data
      ['related', 'likes', undefined, 'dotted'], // unmapped: the type falls back, the label stays
      ['related', undefined, undefined, undefined],
      ['related', undefined, undefined, undefined],
    ])
    const ids = byLabel.relationships.map((r) => r.id)
    expect(ids[1]).toBe(ids[0] + '-1')
    expect(ids[3]).toBe(ids[2] + '-1')
    expect(new Set(ids).size).toBe(5)
    const byStyle = planImport(s, dg, d, fixed({ edgeTypeBy: 'style', edgeTypes: { dotted: 'maybe' } }))
    expect(byStyle.relationships.map((r) => [r.type, r.label])).toEqual([['related', 'knows'], ['related', ' knows '], ['maybe', 'likes'], ['related', undefined], ['related', undefined]])
    applyPlan(s, byLabel)
    const created = s.get(ids[0])!.meta.createdAt
    const later = planImport(s, dg, d, fixed({ edgeTypeBy: 'label', edgeTypes: { knows: 'knows' } }))
    expect(later.relationships[0].meta.createdAt).toBe(created)
    expect(later.relationships[0].meta.source).toBe('import:dot')
  })

  it('links every imported or merged entity to the diagram once, and removes what it made under any scope, leaving merged entities', () => {
    const s = new EntityStore()
    const dg = diagramEntity(s)
    s.upsert(createEntity({ id: 'ada', type: 'person', label: 'Ada' }))
    const d = parseDiagram('digraph { ada -> b }', 'dot')
    const plan = planImport(s, dg, d, fixed({ linkToDiagram: true }))
    const links = plan.relationships.filter((r) => r.type === 'derived-from')
    expect(links.map((r) => [r.source.id, r.target.id])).toEqual([['ada', dg.id], [importedEntityId(dg.id, 'b'), dg.id]])
    applyPlan(s, plan)
    expect(planImport(s, dg, d, fixed({ linkToDiagram: true })).relationships.filter((r) => r.type === 'derived-from')).toEqual([])
    expect(s.relationshipCount()).toBe(3)
    // Under a project scope that holds none of it, removal still reaches the Library.
    s.upsert(createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [] } }))
    s.setScope('p')
    expect(removeImported(s, dg.id)).toBe(4) // b, its edge, and both diagram links
    s.setScope(null)
    expect(s.has('ada')).toBe(true)
    expect(s.relationshipsOf('ada')).toEqual([]) // ada's link went with the diagram's ids; the edge went with b
    expect(removeImported(s, dg.id)).toBe(0)
  })

  it('infers from classes, shapes or nothing, names fixed types by the diagram kind, types edges by style only when styles differ, and tags from the label', () => {
    const classes = parseDiagram('flowchart TD\n a:::svc --> b:::db\n c --> d', 'mermaid')
    const mc = inferMapping(classes, 'My Map!')
    expect(mc).toMatchObject({ nodeTypeBy: 'class', nodeTypes: { svc: 'svc', db: 'db' }, edgeTypeBy: 'fixed', fixedNodeType: 'concept', fixedEdgeType: 'related', tags: ['my-map'] })
    const shapes = parseDiagram('digraph { a [shape=box]; b [shape=box]; c [shape=ellipse]; a -> b [style=dotted]; b -> c [style=bold] }', 'dot')
    const ms = inferMapping(shapes)
    expect(ms).toMatchObject({ nodeTypeBy: 'shape', nodeTypes: { box: 'box', ellipse: 'ellipse' }, edgeTypeBy: 'style', edgeTypes: { dotted: 'dotted', bold: 'bold' }, tags: [] })
    const oneShape = inferMapping(parseDiagram('digraph { a [shape=box]; b [shape=box]; a -> b [style=dotted]; a -> b [style=dotted] }', 'dot'))
    expect(oneShape).toMatchObject({ nodeTypeBy: 'fixed', edgeTypeBy: 'fixed' })
    expect(inferMapping(parseDiagram('classDiagram\n A <|-- B', 'mermaid'))).toMatchObject({ fixedNodeType: 'class', fixedEdgeType: 'associated with' })
    expect(inferMapping(parseDiagram('erDiagram\n A ||--o{ B : has', 'mermaid'))).toMatchObject({ fixedNodeType: 'entity' })
    expect(inferMapping(parseDiagram('stateDiagram-v2\n [*] --> A', 'mermaid'))).toMatchObject({ fixedNodeType: 'state', fixedEdgeType: 'transitions to' })
    expect(inferMapping(parseDiagram('mindmap\n root\n  a', 'mermaid'))).toMatchObject({ fixedEdgeType: 'contains' })
    // A group without a label types by its id, minus the cluster prefix, made singular.
    const unl = parseDiagram('digraph { subgraph cluster_categories { a } b }', 'dot')
    expect(inferMapping(unl).nodeTypes).toEqual({ cluster_categories: 'category' })
    expect(inferMapping(emptyDiagram('dot'))).toMatchObject({ nodeTypeBy: 'fixed', nodeTypes: {}, edgeTypeBy: 'fixed', edgeTypes: {} })
  })

  it('helpers: keys by signal, stats by count then key with three samples, slugs, and the description', () => {
    const n = { id: 'n', label: 'N', classes: ['x', 'y'], shape: 'box', group: 'g', attrs: {} }
    expect([nodeKey(n, 'group'), nodeKey(n, 'class'), nodeKey(n, 'shape'), nodeKey(n, 'fixed')]).toEqual(['g', 'x', 'box', ''])
    expect(nodeKey({ id: 'n', label: '', classes: [], attrs: {} }, 'class')).toBe('')
    const e = { id: 'e', source: 'a', target: 'b', directed: true, label: ' L ', style: 'dotted', attrs: {} }
    expect([edgeKey(e, 'label'), edgeKey(e, 'style'), edgeKey(e, 'fixed')]).toEqual(['L', 'dotted', ''])
    const stats = keyStats(['b', 'a', 'a', 'c', 'a', 'a', 'b'], (k) => k, (k) => k.toUpperCase())
    expect(stats).toEqual([{ key: 'a', count: 4, samples: ['A', 'A', 'A'] }, { key: 'b', count: 2, samples: ['B', 'B'] }, { key: 'c', count: 1, samples: ['C'] }])
    expect(slugType('')).toBe('entity')
    expect(slugType('Cluster_Foo  Bar!')).toBe('foo bar')
    expect(slugType('cluster')).toBe('entity')
    expect(describeMapping(fixed({ fixedNodeType: 'major_work' }))).toBe('all nodes → Major work; all edges → related')
    expect(describeMapping(fixed({ nodeTypeBy: 'group', nodeTypes: { a: 'x', b: 'y' }, edgeTypeBy: 'label', edgeTypes: { k: 'k' } }))).toBe('node type from group (2 mapped); edge type from label (1 mapped)')
  })
})
