import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import '../../resources/types'
import { applyPlan, detectDiagramFormat, diagramFromEntities, edgeTypeFor, inferMapping, nodeTypeFor, parseDiagram, planImport, removeImported, writeDiagram } from '../index'
import { singularType } from '../mapping'

const DOT = `digraph G {
  subgraph cluster_people { label="People"; plato [label="Plato"]; aristotle [label="Aristotle"] }
  subgraph cluster_works { label="Major works"; republic [label="Republic"] }
  plato -> aristotle [label="taught"];
  plato -> republic [label="wrote"];
  aristotle -> republic;
}`

describe('mapping', () => {
  it('detects formats', () => {
    expect(detectDiagramFormat(DOT)).toBe('dot')
    expect(detectDiagramFormat('// c\nstrict graph { a -- b }')).toBe('dot')
    expect(detectDiagramFormat('flowchart TD\n a --> b')).toBe('mermaid')
    expect(detectDiagramFormat('---\ntitle: x\n---\nclassDiagram\n A <|-- B')).toBe('mermaid')
  })

  it('puts an inferred type back into the singular, conservatively', () => {
    for (const [plural, one] of [
      ['services', 'service'],
      ['stores', 'store'],
      ['categories', 'category'],
      ['processes', 'process'],
      ['boxes', 'box'],
      ['branches', 'branch'],
      ['dishes', 'dish'],
      ['people', 'person'],
      ['children', 'child'],
      ['major works', 'major work'],
      // Not plural, or not safely: left alone.
      ['class', 'class'],
      ['status', 'status'],
      ['analysis', 'analysis'],
      ['bus', 'bus'],
      ['gas', 'gas'],
      ['person', 'person'],
      ['entity', 'entity'],
      ['ies', 'ies'],
    ])
      expect(singularType(plural), plural).toBe(one)
  })

  it('infers a mapping from the richest signal', () => {
    const d = parseDiagram(DOT, 'dot')
    const m = inferMapping(d, 'My Diagram')
    expect(m.nodeTypeBy).toBe('group')
    // Cluster labels are plural; aegraph types are singular.
    expect(m.nodeTypes).toEqual({ cluster_people: 'person', cluster_works: 'major work' })
    expect(m.edgeTypeBy).toBe('label')
    expect(m.edgeTypes).toEqual({ taught: 'taught', wrote: 'wrote' })
    expect(m.tags).toEqual(['my-diagram'])
    expect(nodeTypeFor(d.nodes[0], m)).toBe('person')
    expect(edgeTypeFor(d.edges[2], m)).toBe('related')
  })

  it('plans, applies, re-applies idempotently, merges by label, and removes', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'existing-plato', type: 'philosopher', label: 'Plato' }))
    const diagram = createEntity({ id: 'diagram-1', type: 'diagram', label: 'Thinkers', data: { format: 'dot', source: DOT } })
    store.upsert(diagram)
    const d = parseDiagram(DOT, 'dot')
    const m = { ...inferMapping(d, 'Thinkers'), nodeTypes: { cluster_people: 'philosopher', cluster_works: 'major work' } }

    const plan = planImport(store, diagram, d, m)
    expect(plan.reused.map((r) => r.entity.id)).toEqual(['existing-plato'])
    expect(plan.created).toBe(2)
    expect(plan.updated).toBe(1)
    expect(plan.relationships.filter((r) => r.type !== 'derived-from').length).toBe(3)
    expect(plan.relationships.filter((r) => r.type === 'derived-from').length).toBe(3)
    applyPlan(store, plan)
    expect(store.get('existing-plato')?.tags).toContain('thinkers')
    expect(store.entityCount()).toBe(1 + 1 + 2)
    const taught = store.relationships().find((r) => r.type === 'taught')!
    expect(taught.source.id).toBe('existing-plato')
    expect(store.get(taught.target.id)?.label).toBe('Aristotle')

    // Re-import: same ids, nothing duplicated.
    applyPlan(store, planImport(store, diagram, d, m))
    expect(store.entityCount()).toBe(4)
    expect(store.relationshipCount()).toBe(6)

    // Change the mapping: the owned entities are retyped in place.
    applyPlan(store, planImport(store, diagram, d, { ...m, nodeTypes: { ...m.nodeTypes, cluster_works: 'book' } }))
    expect(store.ofType('book').length).toBe(1)
    expect(store.ofType('major work').length).toBe(0)

    // Remove what the import created; the merged existing entity stays.
    const removed = removeImported(store, diagram.id)
    expect(removed).toBeGreaterThan(0)
    expect(store.has('existing-plato')).toBe(true)
    expect(store.entityCount()).toBe(2)
    expect(store.relationshipCount()).toBe(0)
  })

  it('round-trips dataset → diagram → dataset onto the same entities', () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'a', type: 'philosopher', label: 'Plato' }), createEntity({ id: 'b', type: 'major work', label: 'Republic' })])
    const rel = { id: 'r', kind: 'relationship' as const, type: 'wrote', tags: [], data: {}, directed: true, source: { id: 'a' }, target: { id: 'b' }, meta: { createdAt: '', updatedAt: '' } }
    store.upsert(rel)
    const src = writeDiagram(diagramFromEntities(store.query({ kind: 'entity' }), [rel], new TypeRegistry(store)), 'dot')
    const diagram = createEntity({ id: 'd2', type: 'diagram', label: 'export', data: { format: 'dot', source: src } })
    store.upsert(diagram)
    const parsed = parseDiagram(src, 'dot')
    const plan = planImport(store, diagram, parsed, { ...inferMapping(parsed), mergeByLabel: false, linkToDiagram: false })
    expect(plan.created).toBe(0)
    expect(plan.updated).toBe(2)
    expect(plan.entities.map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(plan.relationships[0]).toMatchObject({ source: { id: 'a' }, target: { id: 'b' }, type: 'wrote' })
  })

  it('exports entities to DOT and Mermaid, grouped by type', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'a', type: 'philosopher', label: 'Plato' }),
      createEntity({ id: 'b', type: 'major work', label: 'Republic' }),
      schemaTypeEntity('philosopher', { label: 'Philosopher', pluralLabel: 'Philosophers', color: '#abcdef' }),
    ])
    const rel = { id: 'r', kind: 'relationship' as const, type: 'wrote', tags: [], data: {}, directed: true, source: { id: 'a' }, target: { id: 'b' }, meta: { createdAt: '', updatedAt: '' } }
    const d = diagramFromEntities(store.query({ kind: 'entity' }), [rel], new TypeRegistry(store))
    const dot = writeDiagram(d, 'dot')
    expect(dot).toContain('subgraph cluster_philosopher')
    expect(dot).toContain('label=Philosophers')
    expect(dot).toContain('fillcolor="#abcdef"')
    expect(dot).toContain('a -> b [label=wrote]')
    const mm = writeDiagram(d, 'mermaid')
    expect(mm).toContain('subgraph cluster_philosopher ["Philosophers"]')
    expect(mm).toContain('a -->|"wrote"| b')
    // And back again.
    const back = parseDiagram(dot, 'dot')
    expect(back.nodes.find((n) => n.id === 'a')).toMatchObject({ label: 'Plato', group: 'cluster_philosopher' })
  })
})
