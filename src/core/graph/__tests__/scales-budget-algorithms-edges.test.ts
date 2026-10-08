import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { adjacency, connectedComponents, degreesOf, hopsFrom, kCore } from '../algorithms'
import { breakdown, DEFAULT_VIEW_BUDGET, estimateEdges, estimateNodes, exceedsBudget, shouldGate, suggestTrim, viewLoad } from '../budget'
import { categories, domainOf, normalizer } from '../scales'

/**
 * Three small modules at their edges: scales (domains from one value, all
 * equal, explicit, log with zeros and negatives; clamping; categories
 * ordered by count then name with the overflow ranked), the view budget
 * (the thresholds themselves, the tenth of slack over an accepted load,
 * an empty slice, one dense relationship type), and the graph algorithms
 * called directly (self-loops, parallel edges, unknown ids, the k-core
 * cascade, component order, hops at depth 0 and by direction).
 */

describe('scales', () => {
  it('resolves a domain from what it sees, from one value, from nothing, from an explicit range, and on a log scale', () => {
    expect(domainOf([3, 1, 2], undefined)).toEqual([1, 3])
    expect(domainOf([5, 5, 5], 'auto')).toEqual([5, 5])
    expect(domainOf([], undefined)).toEqual([0, 1])
    expect(domainOf([NaN, Infinity, 2], undefined)).toEqual([2, 2])
    expect(domainOf([7], [0, 10])).toEqual([0, 10])
    // Log: the floor is the smallest positive value; zeros and negatives never set it.
    expect(domainOf([0, -3, 0.5, 40], undefined, true)).toEqual([0.5, 40])
    expect(domainOf([0, -3], undefined, true)).toEqual([1e-9, 1e-9])
    expect(domainOf([1, 10], [0, 100], true)).toEqual([1e-9, 100])
  })

  it('normalises into [0, 1] with clamping, a flat domain to the middle, and blanks to NaN', () => {
    const lin = normalizer([10, 20])
    expect(lin(10)).toBe(0)
    expect(lin(15)).toBe(0.5)
    expect(lin(20)).toBe(1)
    expect(lin(-5)).toBe(0)
    expect(lin(99)).toBe(1)
    expect(lin(NaN)).toBeNaN()
    expect(normalizer([4, 4])(4)).toBe(0.5)
    expect(normalizer([4, 4])(9)).toBe(0.5)
    const log = normalizer([1, 100], true)
    expect(log(1)).toBe(0)
    expect(log(10)).toBeCloseTo(0.5)
    expect(log(100)).toBe(1)
    expect(log(1000)).toBe(1)
    expect(log(0)).toBeNaN()
    expect(log(-1)).toBeNaN()
    expect(normalizer([5, 5], true)(5)).toBe(0.5)
  })

  it('buckets categories most frequent first, then by name with numbers in order, ranks the overflow, and skips blanks', () => {
    const c = categories(['b', 'a', 'b', '10', '9', '9', null, undefined, '', 0, 'a'], 3)
    expect(c.keys).toEqual(['9', 'a', 'b'])
    expect(c.counts.get('b')).toBe(2)
    expect(c.counts.get('0')).toBe(1)
    expect(c.counts.has('')).toBe(false)
    expect(c.overflow).toBe(2) // '0' and '10', one each
    expect(c.rank.get('10')).toBe(4) // past the legend but still ranked, after '0'... by name with numeric collation: '0' < '10'
    expect(c.rank.get('0')).toBe(3)
    expect(c.index.has('10')).toBe(false)
    expect(categories([]).keys).toEqual([])
    expect(categories(['x'], 0).keys).toEqual([])
  })
})

describe('the view budget', () => {
  const load = (nodes: number, edges: number) => ({ nodes, edges })
  it('gates past either threshold, not at it, and allows a tenth over what was accepted', () => {
    const b = DEFAULT_VIEW_BUDGET
    expect(exceedsBudget(load(3000, 15000), b)).toBe(false)
    expect(exceedsBudget(load(3001, 0), b)).toBe(true)
    expect(exceedsBudget(load(0, 15001), b)).toBe(true)
    expect(shouldGate(load(3001, 0), b)).toBe(true)
    expect(shouldGate(load(3001, 0), b, load(3001, 0))).toBe(false)
    expect(shouldGate(load(3300, 16500), b, load(3000, 15000))).toBe(false)
    expect(shouldGate(load(3301, 0), b, load(3000, 15000))).toBe(true)
    expect(shouldGate(load(0, 16501), b, load(3000, 15000))).toBe(true)
    expect(shouldGate(load(10, 10), b, load(3000, 15000))).toBe(false)
    expect(viewLoad({ nodes: [], edges: [] })).toEqual({ nodes: 0, edges: 0 })
  })

  it('breaks an empty slice down to nothing and keeps a single dense relationship type rather than dropping every type', () => {
    const empty = breakdown({ nodes: [], edges: [] })
    expect(empty).toEqual({ nodeTypes: [], relTypes: [], triples: new Map() })
    expect(estimateNodes(empty, new Set(['a']))).toBe(0)
    expect(estimateEdges(empty, new Set(['a']), new Set(['r']))).toBe(0)
    expect(suggestTrim(empty, DEFAULT_VIEW_BUDGET)).toEqual({ nodeTypes: new Set(), relTypes: new Set(), maxNodes: 3000 })
    const nodes = Array.from({ length: 4 }, (_, i) => createEntity({ id: `n${i}`, type: i < 2 ? 'a' : 'b' }))
    const dense = Array.from({ length: 6 }, (_, i) => createRelationship({ id: `d${i}`, type: 'similar', source: `n${i % 4}`, target: `n${(i + 1) % 4}` }))
    const sparse = [createRelationship({ id: 's', type: 'cites', source: 'n0', target: 'n1' })]
    const b = breakdown({ nodes, edges: [...dense, ...sparse] })
    expect(b.nodeTypes).toEqual([{ type: 'a', count: 2 }, { type: 'b', count: 2 }])
    expect(b.relTypes).toEqual([{ type: 'similar', count: 6 }, { type: 'cites', count: 1 }])
    // An edge whose end is not in the slice files under an empty type and counts for no type set.
    const stray = breakdown({ nodes, edges: [createRelationship({ id: 'x', type: 'r', source: 'n0', target: 'ghost' })] })
    expect([...stray.triples.keys()]).toEqual(['r\ta\t'])
    expect(estimateEdges(stray, new Set(['a', 'b']), new Set(['r']))).toBe(0)
    // Trimming with a budget of two edges drops `similar` and keeps `cites`; with one edge and only `similar` present, `similar` stays.
    expect(suggestTrim(b, { nodes: 10, edges: 2 }).relTypes).toEqual(new Set(['cites']))
    const onlyDense = breakdown({ nodes, edges: dense })
    expect(suggestTrim(onlyDense, { nodes: 10, edges: 1 }).relTypes).toEqual(new Set(['similar']))
    expect(estimateEdges(b, new Set(['a']), new Set(['similar', 'cites']))).toBe(3) // n0→n1 twice among the dense ring (d0, d4), and s
    expect(estimateNodes(b, new Set(['b']))).toBe(2)
  })
})

describe('graph algorithms', () => {
  const rel = (id: string, s: string, t: string, directed = true) => createRelationship({ id, type: 'r', source: s, target: t, directed })
  it('builds adjacency within the ids only, without self-loops, honouring direction for directed edges alone', () => {
    const ids = new Set(['a', 'b', 'c'])
    const edges = [rel('ab', 'a', 'b'), rel('bc', 'b', 'c', false), rel('aa', 'a', 'a'), rel('ax', 'a', 'x')]
    expect(adjacency(ids, edges).get('a')).toEqual(['b'])
    expect(adjacency(ids, edges).get('b')).toEqual(['a', 'c'])
    expect(adjacency(ids, edges, 'out').get('a')).toEqual(['b'])
    expect(adjacency(ids, edges, 'out').get('b')).toEqual(['c'])
    expect(adjacency(ids, edges, 'out').get('c')).toEqual(['b'])
    expect(adjacency(ids, edges, 'in').get('a')).toBeUndefined()
    expect(adjacency(ids, edges, 'in').get('b')).toEqual(['a', 'c'])
    expect(adjacency(new Set(), edges).size).toBe(0)
  })

  it('counts degree on both ends, a self-loop twice, and an edge to an unknown id on the known end', () => {
    const d = degreesOf([rel('ab', 'a', 'b'), rel('aa', 'a', 'a'), rel('ax', 'a', 'x')])
    expect(d.get('a')).toBe(4)
    expect(d.get('b')).toBe(1)
    expect(d.get('x')).toBe(1)
    expect(degreesOf([]).size).toBe(0)
  })

  it('peels the k-core in cascades, keeps everything for k ≤ 0, and empties for a k nobody reaches', () => {
    const ids = new Set(['a', 'b', 'c', 'd', 'e'])
    // A triangle a–b–c with a tail c–d–e.
    const edges = [rel('ab', 'a', 'b'), rel('bc', 'b', 'c'), rel('ca', 'c', 'a'), rel('cd', 'c', 'd'), rel('de', 'd', 'e')]
    expect([...kCore(ids, edges, 2)].sort()).toEqual(['a', 'b', 'c']) // e goes (1), then d (1)
    expect([...kCore(ids, edges, 1)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(kCore(ids, edges, 0)).toEqual(ids)
    expect(kCore(ids, edges, 3).size).toBe(0)
    expect(kCore(new Set(['a', 'z']), edges, 1)).toEqual(new Set()) // z has no edge; a's only edges lead outside the set
  })

  it('orders components largest first and walks hops from seeds by depth and direction', () => {
    const ids = new Set(['a', 'b', 'c', 'd', 'e', 'f'])
    const edges = [rel('ab', 'a', 'b'), rel('bc', 'b', 'c', false), rel('de', 'd', 'e')]
    const comps = connectedComponents(ids, edges)
    expect(comps.map((c) => c.length)).toEqual([3, 2, 1])
    expect([...comps[0]].sort()).toEqual(['a', 'b', 'c'])
    expect(comps[2]).toEqual(['f'])
    expect(connectedComponents(new Set(), edges)).toEqual([])
    expect([...hopsFrom(['a'], ids, edges, 0)]).toEqual(['a'])
    expect([...hopsFrom(['a'], ids, edges, 1, 'out')].sort()).toEqual(['a', 'b'])
    expect([...hopsFrom(['a'], ids, edges, 2, 'out')].sort()).toEqual(['a', 'b', 'c'])
    expect([...hopsFrom(['b'], ids, edges, 1, 'in')].sort()).toEqual(['a', 'b', 'c']) // b–c is undirected: in reaches it
    expect([...hopsFrom(['c'], ids, edges, 5, 'out')].sort()).toEqual(['b', 'c']) // c→b by the undirected edge, then nothing out of b
    expect([...hopsFrom(['nope', 'a'], ids, edges, 1)].sort()).toEqual(['a', 'b'])
    expect(hopsFrom([], ids, edges, 3).size).toBe(0)
    expect([...hopsFrom(['a'], new Set(['a']), edges, 3)]).toEqual(['a'])
  })
})
