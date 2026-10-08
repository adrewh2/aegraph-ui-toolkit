import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { applyFilter, describeFilter, emptyFilter, filterComputedRefs, isEmptyFilter, toFilterSpec } from '../filter'
import '../types'

/**
 * The filter's structure at its edges, after the first pass: the order
 * of the pruning steps (the degree band before the k-core, the cap
 * last, `candidates` and `components` counted before it), k at zero,
 * depth beyond the graph and through a cycle, a neighbourhood with an
 * unknown relationship type, a cap of zero and ties at the cap, includes
 * that are relationships, definitions or projects, excluded tags against
 * required ones, degree counted over a project's own relationships,
 * the description of every knob, and the spec from stored data.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 't', label: 'A', tags: ['x', 'y'] }),
    createEntity({ id: 'b', type: 't', label: 'B', tags: ['x'] }),
    createEntity({ id: 'c', type: 't', label: 'C', tags: ['y'] }),
    createEntity({ id: 'd', type: 't', label: 'D' }),
    createEntity({ id: 'e', type: 'u', label: 'E' }),
    createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [] } }),
    schemaTypeEntity('t', { label: 'Tee' }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c' }),
    createRelationship({ id: 'ca', type: 'r', source: 'c', target: 'a' }),
    createRelationship({ id: 'cd', type: 's', source: 'c', target: 'd' }),
    createRelationship({ id: 'de', type: 's', source: 'd', target: 'e' }),
  ])
  return { s, r: new TypeRegistry(s) }
}
const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort()

describe('filter structure edges', () => {
  it('prunes in order: the degree band first, the k-core over what is left, components after, the cap last with counts taken before it', () => {
    const { s, r } = fixture()
    // Degrees: a 2, b 2, c 3, d 2, e 1. A 2-core alone keeps the triangle and d? d has c and e; e goes (1), then d (1): the triangle.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), kCore: 2 }))).toEqual(['a', 'b', 'c'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), kCore: 0 }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    // maxDegree 2 drops c first; then nothing has two neighbours among a, b, d, e: a 2-core over the remainder is empty.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), maxDegree: 2 }))).toEqual(['a', 'b', 'd', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), maxDegree: 2, kCore: 2 }))).toEqual([])
    // hideIsolated is a minimum degree of one, and the larger of the two wins.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), hideIsolated: true, minDegree: 3 }))).toEqual(['c'])
    // componentMin 1 is off (a node is its own component); 2 keeps the triangle only. The cap comes after: counts are taken before it.
    expect(applyFilter(s, r, { ...emptyFilter(), relationshipTypes: ['r'], componentMin: 1 }).components).toBeUndefined()
    const capped = applyFilter(s, r, { ...emptyFilter(), relationshipTypes: ['r'], componentMin: 2, maxNodes: 1 })
    expect(capped.components).toBe(1)
    expect(capped.candidates).toBe(3)
    expect(capped.truncated).toBe(2)
    expect(ids(capped)).toEqual(['a']) // degrees tie at 2 within `r`: the first in store order
    const zero = applyFilter(s, r, { ...emptyFilter(), maxNodes: 0 })
    expect(zero).toMatchObject({ nodes: [], edges: [], candidates: 5, truncated: 5 })
  })

  it('walks a neighbourhood through a cycle without revisiting, past the graph’s end, and by a relationship type nothing has', () => {
    const { s, r } = fixture()
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['a'], depth: 2 }))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['a'], depth: 99 }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['a'], depth: 3, direction: 'out' }))).toEqual(['a', 'b', 'c', 'd']) // a→b→c→d; c→a is a revisit
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['e'], depth: 3, direction: 'out' }))).toEqual(['e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['e'], depth: 3, direction: 'in' }))).toEqual(['b', 'c', 'd', 'e']) // e←d←c←b; a→b is one more hop, and c→a points away
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['e'], depth: 4, direction: 'in' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['a'], depth: 2, relationshipTypes: ['nope'] }))).toEqual(['a'])
    // Two roots, one of them a project: the project seeds nothing (it is never a node) and the other walks as usual.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p', 'e'], depth: 1 }))).toEqual(['d', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['a', 'e'], depth: 0 }))).toEqual(['a', 'e'])
  })

  it('never brings in a relationship, a type definition or a project by hand, and keeps excluded tags out of a required set', () => {
    const { s, r } = fixture()
    const g = applyFilter(s, r, { ...emptyFilter(), types: ['u'], include: ['ab', 'schema:type:t', 'p', 'a'] })
    expect(ids(g)).toEqual(['a', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), only: ['p', 'schema:type:t', 'ab', 'b'] }))).toEqual(['b'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['x', 'y'], tagMode: 'all' }))).toEqual(['a'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['x', 'y'], tagMode: 'all', excludeTags: ['y'] }))).toEqual([])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['x'], excludeTags: ['y'] }))).toEqual(['b'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), excludeTags: ['x', 'y'] }))).toEqual(['d', 'e'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), text: '  b  ' }))).toEqual(['b'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), text: 'zzz' }))).toEqual([])
  })

  it('counts degree over a project’s own relationships only, so a member linked by a relationship the project lacks is isolated', () => {
    const { s, r } = fixture()
    const members = new Set(['a', 'b', 'c', 'ab'])
    const g = applyFilter(s, r, { ...emptyFilter(), hideIsolated: true }, { members })
    expect(ids(g)).toEqual(['a', 'b'])
    expect(g.degree.get('c')).toBeUndefined()
    expect(applyFilter(s, r, { ...emptyFilter(), minDegree: 2 }, { members }).nodes).toEqual([])
    expect(applyFilter(s, r, { ...emptyFilter(), only: ['d'] }, { members }).nodes).toEqual([]) // outside the project: not in the dataset
  })

  it('describes every knob, calls the defaults everything even when capped, and fills a stored spec', () => {
    expect(describeFilter({ ...emptyFilter(), types: ['a', 'b'], relationshipTypes: ['r'], tags: ['x', 'y'], tagMode: 'all', excludeTags: ['z'], text: ' q ', maxDegree: 3, componentMin: 2, fields: [{ path: 'data.year', op: 'gte', value: 2000 }] })).toBe('2 types · 1 rel. type · tags: x & y · not tagged z · “q” · data.year ≥ 2000 · degree ≤ 3 · components ≥ 2')
    expect(describeFilter({ ...emptyFilter(), tags: ['x', 'y'], roots: ['a', 'b'], depth: 1, direction: 'out', minDegree: 1 })).toBe('tags: x, y · 1 hop out from 2 · degree ≥ 1')
    expect(describeFilter({ ...emptyFilter(), giantOnly: true, componentMin: 3 })).toBe('giant component') // the giant component says it all
    expect(describeFilter({ ...emptyFilter(), fields: [{ path: '', op: 'eq', value: 1 }] })).toBe('Everything')
    expect(isEmptyFilter({ ...emptyFilter(), maxNodes: 5, depth: 3, direction: 'in' })).toBe(true) // the cap and an unused walk do not count
    expect(isEmptyFilter({ ...emptyFilter(), hideIsolated: true })).toBe(false)
    expect(toFilterSpec(undefined)).toEqual(emptyFilter())
    expect(toFilterSpec({ types: ['t'], kCore: 2 } as never)).toMatchObject({ types: ['t'], kCore: 2, depth: 1, maxNodes: 20000 })
    expect(filterComputedRefs({ ...emptyFilter(), fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }, { path: 'degree.in:cites', op: 'gt', value: 0 }, { path: 'data.x', op: 'eq', value: 1 }, { path: 'label', op: 'eq', value: 'x' }] })).toEqual({ metrics: ['pagerank'], structural: true })
    expect(filterComputedRefs(emptyFilter())).toEqual({ metrics: [], structural: false })
  })
})
