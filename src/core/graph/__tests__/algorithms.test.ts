import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { connectedComponents, hopsFrom, kCore } from '../algorithms'
import { coerce, describePredicate, getPath, matchPredicate, sampleDataKeys } from '../fields'
import { applyFilter, describeFilter, emptyFilter, toFilterSpec } from '../filter'
import { computeLayout, DEFAULT_LAYOUT_PARAMS, densestCell, LAYOUTS, NOVERLAP_CELL_LIMIT, removeOverlap } from '../layouts'
import { shortestPath } from '../paths'
import { applySelect, pruneSelection, selectionOp } from '../selection'
import '../types'

/** Triangle a-b-c with a tail c-d-e, plus an isolated pair x-y. */
function fixture() {
  const s = new EntityStore()
  const ids = ['a', 'b', 'c', 'd', 'e', 'x', 'y']
  s.upsertMany(ids.map((id, i) => createEntity({ id, type: i < 5 ? 'person' : 'note', label: id.toUpperCase(), tags: i % 2 ? ['odd'] : ['even'], data: { year: 1900 + i * 10, name: `n${i}` }, meta: { createdAt: `20${20 + i}-01-01T00:00:00.000Z` } })))
  s.upsertMany([
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b', directed: true }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c', directed: true }),
    createRelationship({ id: 'ca', type: 'r', source: 'c', target: 'a', directed: true }),
    createRelationship({ id: 'cd', type: 'r', source: 'c', target: 'd', directed: true, data: { weight: 5 } }),
    createRelationship({ id: 'de', type: 'r', source: 'd', target: 'e', directed: false }),
    createRelationship({ id: 'ae', type: 'r', source: 'a', target: 'e', directed: true, data: { weight: 20 } }),
    createRelationship({ id: 'xy', type: 'r', source: 'x', target: 'y', directed: true }),
  ])
  return { s, r: new TypeRegistry(s), slice: applyFilter(s, new TypeRegistry(s), emptyFilter()) }
}

describe('algorithms', () => {
  it('peels k-cores', () => {
    const { slice } = fixture()
    const ids = new Set(slice.nodes.map((n) => n.id))
    expect([...kCore(ids, slice.edges, 2)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect([...kCore(ids, slice.edges, 3)]).toEqual([])
    expect(kCore(ids, slice.edges, 0).size).toBe(7)
    expect(kCore(new Set(), [], 2).size).toBe(0)
  })
  it('finds components largest first', () => {
    const { slice } = fixture()
    const comps = connectedComponents(new Set(slice.nodes.map((n) => n.id)), slice.edges)
    expect(comps.map((c) => c.length)).toEqual([5, 2])
    expect(connectedComponents(new Set(['solo']), []).length).toBe(1)
  })
  it('walks hops with direction', () => {
    const { slice } = fixture()
    const ids = new Set(slice.nodes.map((n) => n.id))
    expect([...hopsFrom(['a'], ids, slice.edges, 0)]).toEqual(['a'])
    expect([...hopsFrom(['a'], ids, slice.edges, 1)].sort()).toEqual(['a', 'b', 'c', 'e'])
    expect([...hopsFrom(['a'], ids, slice.edges, 1, 'out')].sort()).toEqual(['a', 'b', 'e'])
    expect([...hopsFrom(['a'], ids, slice.edges, 1, 'in')].sort()).toEqual(['a', 'c'])
    expect(hopsFrom(['a'], ids, slice.edges, 9).size).toBe(5)
  })
})

describe('field predicates', () => {
  const e = createEntity({ id: 'p', type: 'person', label: 'Ada', tags: ['t1', 't2'], data: { year: '1900', name: 'Ada Lovelace', ok: true }, meta: { createdAt: '2024-05-01T00:00:00.000Z' } })
  it('reads paths and coerces values', () => {
    expect(getPath(e, 'data.year')).toBe('1900')
    expect(getPath(e, 'meta.createdAt')).toBe('2024-05-01T00:00:00.000Z')
    expect(getPath(e, 'tags')).toEqual(['t1', 't2'])
    expect(coerce('1900', 1900)).toEqual([1900, 1900])
    const [d1, d2] = coerce('2024-05-01', '2024-01-01') as [number, number]
    expect(d1).toBeGreaterThan(d2)
    expect(coerce('Ada', 'ada')).toEqual(['ada', 'ada'])
  })
  it('evaluates every operator', () => {
    expect(matchPredicate(e, { path: 'data.year', op: 'eq', value: 1900 })).toBe(true)
    expect(matchPredicate(e, { path: 'data.year', op: 'neq', value: 1900 })).toBe(false)
    expect(matchPredicate(e, { path: 'data.year', op: 'gte', value: 1900 })).toBe(true)
    expect(matchPredicate(e, { path: 'data.year', op: 'gt', value: 1900 })).toBe(false)
    expect(matchPredicate(e, { path: 'data.year', op: 'lt', value: '2000' })).toBe(true)
    expect(matchPredicate(e, { path: 'data.year', op: 'between', value: [1850, 1950] })).toBe(true)
    expect(matchPredicate(e, { path: 'meta.createdAt', op: 'between', value: ['2024-01-01', '2024-12-31'] })).toBe(true)
    expect(matchPredicate(e, { path: 'meta.createdAt', op: 'lt', value: '2024-01-01' })).toBe(false)
    expect(matchPredicate(e, { path: 'data.name', op: 'contains', value: 'LOVE' })).toBe(true)
    expect(matchPredicate(e, { path: 'tags', op: 'contains', value: 't2' })).toBe(true)
    expect(matchPredicate(e, { path: 'tags', op: 'in', value: ['zz', 't1'] })).toBe(true)
    expect(matchPredicate(e, { path: 'data.ok', op: 'eq', value: true })).toBe(true)
    expect(matchPredicate(e, { path: 'data.missing', op: 'exists' })).toBe(false)
    expect(matchPredicate(e, { path: 'data.missing', op: 'neq', value: 1 })).toBe(true)
    expect(matchPredicate(e, { path: 'label', op: 'in', value: 'ada, bob' })).toBe(true)
  })
  it('samples keys and describes predicates', () => {
    expect(sampleDataKeys([e])).toEqual(['data.name', 'data.ok', 'data.year', 'label', 'meta.createdAt', 'meta.updatedAt', 'tags', 'type'])
    expect(describePredicate({ path: 'data.year', op: 'gte', value: 1900 })).toBe('data.year ≥ 1900')
    expect(describePredicate({ path: 'data.year', op: 'between', value: [1, 2] })).toBe('data.year in [1, 2]')
    expect(describePredicate({ path: 'data.x', op: 'exists' })).toBe('data.x exists')
  })
})

describe('filter extensions', () => {
  it('applies degree band, k-core, components, exclude, fields and direction', () => {
    const { s, r } = fixture()
    const run = (spec: Partial<ReturnType<typeof emptyFilter>>) => applyFilter(s, r, { ...emptyFilter(), ...spec })
    expect(run({ maxDegree: 1 }).nodes.map((n) => n.id).sort()).toEqual(['x', 'y'])
    expect(run({ kCore: 2 }).nodes.length).toBe(5)
    expect(run({ componentMin: 3 }).nodes.length).toBe(5)
    expect(run({ giantOnly: true })).toMatchObject({ components: 1 })
    const ex = run({ exclude: ['a'] })
    expect(ex.nodes.map((n) => n.id)).not.toContain('a')
    expect(ex.edges.map((e) => e.id)).not.toContain('ab')
    expect(run({ roots: ['a'], exclude: ['a'] }).nodes.map((n) => n.id)).not.toContain('a')
    expect(run({ fields: [{ path: 'data.year', op: 'gte', value: 1930 }] }).nodes.map((n) => n.id).sort()).toEqual(['d', 'e', 'x', 'y'])
    expect(run({ fields: [{ path: 'meta.createdAt', op: 'between', value: ['2020-06-01', '2022-06-01'] }] }).nodes.map((n) => n.id).sort()).toEqual(['b', 'c'])
    expect(run({ roots: ['a'], direction: 'out' }).nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'e'])
    expect(run({ roots: ['a'], direction: 'in' }).nodes.map((n) => n.id).sort()).toEqual(['a', 'c'])
    // Undirected edges are traversable both ways even with a direction.
    expect(run({ roots: ['e'], direction: 'out' }).nodes.map((n) => n.id).sort()).toEqual(['d', 'e'])
  })
  it('describes the new parts and keeps old specs loadable', () => {
    expect(describeFilter({ ...emptyFilter(), kCore: 2, giantOnly: true, exclude: ['a'], maxDegree: 3, fields: [{ path: 'data.y', op: 'lt', value: 5 }], roots: ['a'], direction: 'in' })).toBe('data.y < 5 · 1 hop in from 1 · degree ≤ 3 · 2-core · giant component · 1 hidden')
    const spec = toFilterSpec({ types: ['a'] })
    expect(spec.exclude).toEqual([])
    expect(spec.direction).toBe('both')
    expect(describeFilter(spec)).toBe('1 type')
  })
})

describe('shortest paths', () => {
  it('respects direction, weights and multigraphs', () => {
    const { slice } = fixture()
    expect(shortestPath(slice, 'a', 'e')?.nodes).toEqual(['a', 'e'])
    expect(shortestPath(slice, 'e', 'a', { directed: true })).toBeNull()
    expect(shortestPath(slice, 'a', 'd', { directed: true })?.nodes).toEqual(['a', 'e', 'd'])
    expect(shortestPath(slice, 'b', 'd', { directed: true })?.nodes).toEqual(['b', 'c', 'd'])
    const w = shortestPath(slice, 'a', 'e', { weighted: true })
    expect(w?.nodes).toEqual(['a', 'c', 'd', 'e'])
    expect(w?.weight).toBe(7)
    expect(shortestPath(slice, 'a', 'x')).toBeNull()
    expect(shortestPath(slice, 'a', 'a')).toMatchObject({ length: 0 })
    const multi = { nodes: slice.nodes, edges: [...slice.edges, createRelationship({ id: 'ae2', type: 'r', source: 'a', target: 'e', data: { weight: 2 } })] }
    expect(shortestPath(multi, 'a', 'e', { weighted: true })?.edges).toEqual(['ae2'])
  })
})

describe('selection', () => {
  it('applies modes and keeps the primary last', () => {
    expect(applySelect(['a'], ['b'])).toEqual(['b'])
    expect(applySelect(['a'], ['b', 'a'], 'add')).toEqual(['b', 'a'])
    expect(applySelect(['a', 'b'], ['a'], 'remove')).toEqual(['b'])
    expect(applySelect(['a'], ['a', 'c'], 'toggle')).toEqual(['c'])
    expect(pruneSelection(['a', 'b'], new Set(['b']))).toEqual(['b'])
    const same = ['a']
    expect(pruneSelection(same, new Set(['a']))).toBe(same)
  })
  it('derives selections from the slice', () => {
    const { slice } = fixture()
    expect(selectionOp([], slice, { op: 'all' }).length).toBe(7)
    expect(selectionOp(['a'], slice, { op: 'invert' }).length).toBe(6)
    expect(selectionOp(['a'], slice, { op: 'neighbours' }).sort()).toEqual(['a', 'b', 'c', 'e'])
    expect(selectionOp(['a'], slice, { op: 'neighbours', hops: 1, direction: 'out' }).sort()).toEqual(['a', 'b', 'e'])
    expect(selectionOp(['x'], slice, { op: 'byType' }).sort()).toEqual(['x', 'y'])
    expect(selectionOp(['a'], slice, { op: 'byTag' }).sort()).toEqual(['a', 'c', 'e', 'y'])
    expect(selectionOp(['a'], slice, { op: 'none' })).toEqual([])
  })
})

describe('layout extensions', () => {
  it('keeps pinned nodes in place for every algorithm and honours the old param shape', () => {
    const { slice } = fixture()
    const previous = { a: { x: 123, y: 456, z: 7 } }
    for (const l of LAYOUTS) {
      for (const dims of l.dims) {
        const out = computeLayout(l.id, slice, { dimensions: dims, spacing: 1, iterations: 60, direction: 'TB', seed: 1 }, previous, ['a'])
        expect(Object.keys(out).length).toBe(7)
        expect(out.a.x).toBe(123)
        expect(out.a.y).toBe(456)
      }
    }
  })
  it('leaves a picture alone when one grid cell holds more nodes than overlap removal can handle', () => {
    // A spectral layout's central blob at six thousand nodes: every pair in the cell collides, and the collision set
    // overflows ("Set maximum size exceeded") after tens of seconds. The layout is returned as it is instead.
    const s = new EntityStore()
    const n = NOVERLAP_CELL_LIMIT + 6
    s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `n${i}`, type: 't', label: `n${i}` })))
    const slice = applyFilter(s, new TypeRegistry(s), emptyFilter())
    const blob: Record<string, { x: number; y: number }> = {}
    slice.nodes.forEach((v, i) => (blob[v.id] = { x: i < n - 5 ? 0 : 1000 * i, y: 0 }))
    expect(densestCell(blob, Object.keys(blob))).toBe(n - 5)
    expect(densestCell({ a: { x: 0, y: 0 }, b: { x: 10, y: 10 }, c: { x: 20, y: 20 } }, ['a', 'b', 'c'])).toBe(1)
    const t = performance.now()
    const out = removeOverlap(slice, blob, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 })
    expect(out).toBe(blob)
    expect(performance.now() - t).toBeLessThan(200)
    // A blob under the limit is still spread.
    const fewer = Object.fromEntries(Object.entries(blob).slice(0, 40))
    const smaller = { ...slice, nodes: slice.nodes.filter((v) => v.id in fewer) }
    expect(removeOverlap(smaller, fewer, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 })).not.toBe(fewer)
  })
  it('spreads overlapping nodes, respects layered gaps and the centre node', () => {
    const { slice } = fixture()
    const stacked = Object.fromEntries(slice.nodes.map((n) => [n.id, { x: 0, y: 0 }]))
    const spread = removeOverlap(slice, stacked, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 }, undefined, new Set(['a']))
    expect(spread.a).toEqual({ x: 0, y: 0 })
    const distinct = new Set(Object.values(spread).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`))
    expect(distinct.size).toBeGreaterThan(3)
    const tight = computeLayout('layered', slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2, ranksep: 0.5 })
    const loose = computeLayout('layered', slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2, ranksep: 3 })
    const span = (p: Record<string, { y: number }>) => Math.max(...Object.values(p).map((v) => v.y)) - Math.min(...Object.values(p).map((v) => v.y))
    expect(span(loose)).toBeGreaterThan(span(tight))
    expect(computeLayout('radial-by-type', slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2, centerId: 'd' }).d).toEqual({ x: 0, y: 0 })
    expect(computeLayout('concentric-by-degree', slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2, centerId: 'y' }).y).toEqual({ x: 0, y: 0 })
    const auto = computeLayout('force', slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2, noverlap: true, weightField: 'data.weight' })
    expect(Object.keys(auto).length).toBe(7)
  })
})
