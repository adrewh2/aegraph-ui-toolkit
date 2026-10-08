import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../entity/entity'
import { EntityStore } from '../../../entity/store'
import '../../../graph/types'
import { applyGraphPlan, importKeyFor, inferGraphMapping, planGraphImport, removeGraphImport, type GraphMappingSpec } from '../mapping'
import type { ParsedGraph } from '../model'

/**
 * The graph import mapping at its edges, where the format tests stop: a
 * file whose nodes carry nothing, attributes named like the fields they
 * would shadow (id, label, type, tags), ids that need escaping, are
 * empty, are longer than the id allows or are given twice, edges with an
 * end that is not there, a spec naming columns nothing carries, the same
 * file imported twice, two files whose node ids collide, removal taking
 * only its own, positions and colours absent or nonsense — and a
 * thousand nodes for time.
 */
const parsed = (over: Partial<ParsedGraph> = {}): ParsedGraph => ({ nodes: [], edges: [], directedDefault: true, attributeKeys: { nodes: [], edges: [] }, warnings: [], ...over })
const spec = (over: Partial<GraphMappingSpec> = {}): GraphMappingSpec => ({ importKey: 'k1', typeBy: 'fixed', fixedType: 'node', edgeTypeBy: 'fixed', fixedEdgeType: 'related', directed: 'file', attrsToData: true, importLayout: true, importColors: true, reuseExistingIds: true, tags: [], ...over })
const ids = (p: { entities: { id: string }[] }) => p.entities.map((e) => e.id)

describe('graph mapping edges', () => {
  it('takes a file whose nodes carry nothing: no columns to infer, the id is the label, and the only data is where the node came from', () => {
    const bare = parsed({ nodes: [{ id: 'a', attrs: {} }, { id: 'b', attrs: {} }], edges: [{ source: 'a', target: 'b', attrs: {} }] })
    const m = inferGraphMapping(bare, 'bare.gexf')
    expect(m).toMatchObject({ typeBy: 'fixed', fixedType: 'node', edgeTypeBy: 'fixed', importLayout: false, importColors: false, idMode: 'keyed' })
    expect(m.labelAttr).toBeUndefined()
    expect(m.tagsAttr).toBeUndefined()
    expect(m.typeAttr).toBeUndefined()
    expect(m.descriptionAttr).toBeUndefined()
    const plan = planGraphImport(new EntityStore(), bare, m)
    expect(plan).toMatchObject({ created: 2, updated: 0, reused: 0, skippedEdges: 0 })
    expect(plan.entities.map((e) => e.label)).toEqual(['a', 'b'])
    expect(plan.entities[0].data).toEqual({ importedId: 'a' })
    expect(plan.entities[0].description).toBeUndefined()
    expect(plan.layout).toBeUndefined()
  })

  it('keeps an attribute named like a field it would shadow as data, and drops it from the data once the spec reads it', () => {
    const attrs = { id: 'other', label: 'Attr label', type: 'Attr type', tags: 'x,y', description: 'D' }
    const p = parsed({ nodes: [{ id: 'a', label: 'Node label', attrs }], attributeKeys: { nodes: Object.keys(attrs), edges: [] } })
    // Nothing read: the entity keeps the file's own id and label, and every attribute lands in the data as written.
    const plain = planGraphImport(new EntityStore(), p, spec())
    expect(plain.entities[0]).toMatchObject({ id: 'gi-k1-n-a', label: 'Node label', type: 'node' })
    expect(plain.entities[0].data).toEqual({ ...attrs, importedId: 'a' })
    // Read by the spec: each column becomes the field and leaves the data, except `id`, which is never a field.
    const read = planGraphImport(new EntityStore(), p, spec({ typeBy: 'attr', typeAttr: 'type', tagsAttr: 'tags', labelAttr: 'label', descriptionAttr: 'description' }))
    expect(read.entities[0]).toMatchObject({ type: 'attr type', tags: ['x', 'y'], description: 'D', label: 'Node label' }) // the node's own label wins over the column
    expect(read.entities[0].data).toEqual({ id: 'other', importedId: 'a' })
  })

  it('escapes what an id may not carry, still gives an empty id an entity, and keeps two ids that escape alike apart', () => {
    const p = parsed({ nodes: [{ id: 'a b/c#1', attrs: {} }, { id: '', attrs: {} }, { id: 'x'.repeat(120), attrs: {} }, { id: 'a b/c#1 ', attrs: {} }] })
    const plan = planGraphImport(new EntityStore(), p, spec())
    expect(ids(plan)[0]).toBe('gi-k1-n-a_b_c_1')
    expect(ids(plan)[1]).toBe('gi-k1-n-')
    expect(ids(plan)[2]).toBe(`gi-k1-n-${'x'.repeat(80)}`) // slugged ids stop at 80 characters
    expect(new Set(ids(plan)).size).toBe(4) // two ids that escape to the same text are still two entities
    expect(plan.entities.map((e) => e.data.importedId)).toEqual(['a b/c#1', '', 'x'.repeat(120), 'a b/c#1 ']) // what the file called them survives
    expect(plan.created).toBe(4)
  })

  it('keeps nodes apart whose ids slug alike — punctuation, or long ids sharing their first 80 characters — and keeps ids that never collide as they were', () => {
    const long = 'T'.repeat(90)
    const p = parsed({ nodes: [{ id: 'a b', attrs: {} }, { id: 'a/b', attrs: {} }, { id: `${long}-one`, attrs: {} }, { id: `${long}-two`, attrs: {} }, { id: 'a b', attrs: {} }] })
    const plan = planGraphImport(new EntityStore(), p, spec())
    const got = ids(plan)
    expect(got[0]).toBe('gi-k1-n-a_b') // the first keeps the id it always had
    expect(got[1]).toMatch(/^gi-k1-n-a_b~[0-9a-z]+$/)
    expect(got[2]).toBe(`gi-k1-n-${'T'.repeat(80)}`)
    expect(got[3]).toMatch(new RegExp(`^gi-k1-n-${'T'.repeat(64)}~[0-9a-z]+$`))
    expect(got[4]).toBe('gi-k1-n-a_b') // the same id twice is still one node
    const s = new EntityStore()
    applyGraphPlan(s, plan)
    expect(s.library.all().filter((e) => e.kind === 'entity')).toHaveLength(4)
    expect(plan.warnings).toContain('2 node ids read alike once made safe for an entity id (punctuation, or the same first 80 characters); each got a distinct id.')
    // Deterministic: the same file imports to the same ids again.
    expect(ids(planGraphImport(new EntityStore(), p, spec()))).toEqual(got)
  })

  it('lets a node id given twice be one entity, the later description of it winning', () => {
    const p = parsed({ nodes: [{ id: 'a', label: 'First', attrs: { k: 1 } }, { id: 'a', label: 'Second', attrs: { k: 2 } }], edges: [{ source: 'a', target: 'a', attrs: {} }] })
    const plan = planGraphImport(new EntityStore(), p, spec())
    expect(ids(plan)).toEqual(['gi-k1-n-a', 'gi-k1-n-a'])
    const s = new EntityStore()
    applyGraphPlan(s, plan)
    expect(s.get('gi-k1-n-a')).toMatchObject({ label: 'Second', data: { k: 2 } }) // one entity in the end: the last row wins
    expect(s.library.all().filter((e) => e.kind === 'entity').length).toBe(1)
    expect(plan.relationships[0]).toMatchObject({ source: { id: 'gi-k1-n-a' }, target: { id: 'gi-k1-n-a' } })
  })

  it('skips an edge whose end is not in the file, counting each one, and keeps the edges around it', () => {
    const p = parsed({ nodes: [{ id: 'a', attrs: {} }], edges: [{ source: 'a', target: 'ghost', attrs: {} }, { source: 'ghost', target: 'a', attrs: {} }, { source: 'ghost', target: 'other', attrs: {} }, { source: '', target: 'a', attrs: {} }, { source: 'a', target: 'a', attrs: {} }] })
    const plan = planGraphImport(new EntityStore(), p, spec())
    expect(plan.skippedEdges).toBe(4)
    expect(plan.relationships.map((r) => [r.source.id, r.target.id])).toEqual([['gi-k1-n-a', 'gi-k1-n-a']])
  })

  it('falls back when the spec names a column nothing carries', () => {
    const p = parsed({ nodes: [{ id: 'a', attrs: { real: 1 } }], edges: [{ source: 'a', target: 'a', attrs: { real: 2 } }] })
    const plan = planGraphImport(new EntityStore(), p, spec({ typeBy: 'attr', typeAttr: 'nope', tagsAttr: 'nope', labelAttr: 'nope', descriptionAttr: 'nope', edgeTypeBy: 'attr', edgeTypeAttr: 'nope' }))
    expect(plan.entities[0]).toMatchObject({ type: 'node', label: 'a', tags: [] }) // the fixed type, and the id for a label
    expect(plan.entities[0].description).toBeUndefined()
    expect(plan.entities[0].data).toMatchObject({ real: 1 })
    expect(plan.relationships[0].type).toBe('related')
    // An empty attribute is as good as a missing one: the fixed type stands rather than an empty type.
    const empty = planGraphImport(new EntityStore(), parsed({ nodes: [{ id: 'a', attrs: { type: '' } }] }), spec({ typeBy: 'attr', typeAttr: 'type' }))
    expect(empty.entities[0].type).toBe('node')
  })

  it('imports the same file twice without duplicating anything: the same ids, updated in place', () => {
    const s = new EntityStore()
    const file = () => parsed({ nodes: [{ id: 'a', attrs: {} }, { id: 'b', attrs: {} }], edges: [{ source: 'a', target: 'b', attrs: {} }, { source: 'a', target: 'b', attrs: {} }], attributeKeys: { nodes: [], edges: [] } })
    const m = inferGraphMapping(file(), 'twice.graphml')
    const first = planGraphImport(s, file(), m)
    applyGraphPlan(s, first)
    const before = s.library.all().length
    const second = planGraphImport(s, file(), m)
    applyGraphPlan(s, second)
    expect(ids(second)).toEqual(ids(first))
    expect(second.relationships.map((r) => r.id)).toEqual(first.relationships.map((r) => r.id)) // parallel edges keep their numbering
    expect(second).toMatchObject({ created: 0, updated: 2 })
    expect(s.library.all().length).toBe(before)
  })

  it('keeps two files whose node ids collide apart, and removes one without touching the other', () => {
    const s = new EntityStore()
    const file = () => parsed({ nodes: [{ id: 'a', attrs: {} }], edges: [{ source: 'a', target: 'a', attrs: {} }] })
    const one = importKeyFor('one')
    const two = importKeyFor('two')
    expect(one).not.toBe(two)
    applyGraphPlan(s, planGraphImport(s, file(), spec({ importKey: one, reuseExistingIds: false })))
    applyGraphPlan(s, planGraphImport(s, file(), spec({ importKey: two, reuseExistingIds: false })))
    expect(s.has(`gi-${one}-n-a`)).toBe(true)
    expect(s.has(`gi-${two}-n-a`)).toBe(true)
    s.upsert(createEntity({ id: 'mine', type: 'note' }))
    expect(removeGraphImport(s, one)).toBe(2) // its node and its edge
    expect(s.has(`gi-${one}-n-a`)).toBe(false)
    expect(s.has(`gi-${two}-n-a`)).toBe(true)
    expect(s.has('mine')).toBe(true)
  })

  it('reuses one entity for both files when the node id is already an entity, and leaves it behind when an import is removed', () => {
    const s = new EntityStore()
    s.upsert(createEntity({ id: 'a', type: 'person', label: 'Ada' }))
    const file = parsed({ nodes: [{ id: 'a', attrs: {} }] })
    applyGraphPlan(s, planGraphImport(s, file, spec({ importKey: 'k1' })))
    const second = planGraphImport(s, file, spec({ importKey: 'k2' }))
    expect(second).toMatchObject({ created: 0, reused: 1 })
    expect(second.entities[0].id).toBe('a')
    applyGraphPlan(s, second)
    expect(removeGraphImport(s, 'k1')).toBe(0) // the entity was the workspace's, not the import's
    expect(s.get('a')).toMatchObject({ type: 'person' })
  })

  it('takes a position only when it is a pair of real numbers, and a colour only when there is one', () => {
    const p = parsed({
      nodes: [
        { id: 'ok', attrs: {}, viz: { x: 1, y: 2, color: '#abc' } },
        { id: 'nan', attrs: {}, viz: { x: Number.NaN, y: 2 } },
        { id: 'inf', attrs: {}, viz: { x: 1, y: Number.POSITIVE_INFINITY } },
        { id: 'none', attrs: {}, viz: { color: '' } },
      ],
    })
    const plan = planGraphImport(new EntityStore(), p, spec())
    expect(Object.keys(plan.layout?.data.positions ?? {})).toEqual(['gi-k1-n-ok']) // a position that is not a number is no position
    expect(plan.entities[0].data).toMatchObject({ color: '#abc' })
    expect(plan.entities[3].data).not.toHaveProperty('color')
    expect(plan.layout?.data.dimensions).toBe(2)
    // A z that is not a number leaves the layout in two dimensions rather than writing a broken third.
    const z = planGraphImport(new EntityStore(), parsed({ nodes: [{ id: 'a', attrs: {}, viz: { x: 0, y: 0, z: Number.NaN } }] }), spec())
    expect(z.layout?.data.dimensions).toBe(2)
    expect(z.layout?.data.positions['gi-k1-n-a']).toEqual({ x: 0, y: 0 })
  })

  it('plans a thousand nodes and two thousand edges in well under a second', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, attrs: { i, group: `g${i % 7}` }, viz: { x: i, y: -i } }))
    const edges = Array.from({ length: 2000 }, (_, i) => ({ source: `n${i % 1000}`, target: `n${(i * 7 + 3) % 1000}`, attrs: { w: i } }))
    const p = parsed({ nodes, edges, attributeKeys: { nodes: ['i', 'group'], edges: ['w'] } })
    const m = inferGraphMapping(p, 'big.graphml')
    const t0 = performance.now()
    const plan = planGraphImport(new EntityStore(), p, m)
    const ms = performance.now() - t0
    expect(plan).toMatchObject({ created: 1000, skippedEdges: 0 })
    expect(plan.relationships.length).toBe(2000)
    expect(Object.keys(plan.layout?.data.positions ?? {}).length).toBe(1000)
    expect(ms).toBeLessThan(600) // generous: the run is O(N + E) and takes single-digit milliseconds unloaded
  })
})
