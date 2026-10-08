import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter, type GraphSlice } from '../filter'
import { shortestPath, sliceToGraphology } from '../paths'
import '../types'

/**
 * What `paths-selection-edges.test.ts` did not ask of the path finder: a node
 * to itself (and a node to itself over a self-loop), two components, parallel
 * edges of different weights on the route, a self-loop beside the route, the
 * edge chosen when a directed edge points the wrong way between two nodes the
 * route visits, weighted and unweighted choosing different routes, the same
 * answer twice, what the graph built from a slice holds, and a thousand-node
 * line for time.
 */
const slice = (nodes: string[], edges: [string, string, string, boolean?, number?][]): GraphSlice => {
  const s = new EntityStore()
  s.upsertMany([
    ...nodes.map((id) => createEntity({ id, type: 'note', label: id })),
    ...edges.map(([id, a, b, directed, weight]) => createRelationship({ id, type: 'r', source: a, target: b, directed: directed ?? true, ...(weight === undefined ? {} : { data: { weight } }) })),
  ])
  return applyFilter(s, new TypeRegistry(s), emptyFilter())
}
const line = (n: number) => slice(Array.from({ length: n }, (_, i) => `n${i}`), Array.from({ length: n - 1 }, (_, i) => [`e${i}`, `n${i}`, `n${i + 1}`, false] as [string, string, string, boolean]))

describe('path finder edges', () => {
  it('a node to itself is a path of no hops, weighted or not, self-loop or not; an unknown end is no path at all', () => {
    const g = slice(['a', 'b'], [['ab', 'a', 'b'], ['aa', 'a', 'a']])
    expect(shortestPath(g, 'a', 'a')).toEqual({ nodes: ['a'], edges: [], length: 0, weight: undefined })
    expect(shortestPath(g, 'a', 'a', { weighted: true })).toEqual({ nodes: ['a'], edges: [], length: 0, weight: 0 })
    expect(shortestPath(g, 'a', 'zz')).toBeNull()
    expect(shortestPath(g, 'zz', 'a')).toBeNull()
    expect(shortestPath(g, 'zz', 'zz')).toBeNull()
    expect(shortestPath(slice([], []), 'a', 'b')).toBeNull()
  })

  it('two components have no path either way, weighted or not, directed or not', () => {
    const g = slice(['a', 'b', 'c', 'd'], [['ab', 'a', 'b'], ['cd', 'c', 'd']])
    for (const opts of [{}, { weighted: true }, { directed: true }, { directed: true, weighted: true }]) {
      expect(shortestPath(g, 'a', 'd', opts), JSON.stringify(opts)).toBeNull()
      expect(shortestPath(g, 'd', 'a', opts), JSON.stringify(opts)).toBeNull()
    }
    expect(shortestPath(g, 'a', 'b')?.length).toBe(1)
  })

  it('parallel edges: the route names the lightest one that can be walked, and a self-loop is never on it', () => {
    const g = slice(['a', 'b'], [['heavy', 'a', 'b', false, 9], ['light', 'a', 'b', false, 2], ['mid', 'a', 'b', false, 5], ['loop', 'a', 'a', false, 0.1]])
    const p = shortestPath(g, 'a', 'b', { weighted: true })
    expect(p).toMatchObject({ nodes: ['a', 'b'], edges: ['light'], length: 1, weight: 2 })
    // Unweighted, the hop count is the same and the edge named is still the lightest of the parallels.
    expect(shortestPath(g, 'a', 'b')).toMatchObject({ edges: ['light'], weight: undefined })
    // A wrong-way directed edge beside an undirected one: the undirected one is named, not the one that cannot be walked.
    const mixed = slice(['x', 'y'], [['back', 'y', 'x', true, 0.5], ['both', 'x', 'y', false, 3]])
    expect(shortestPath(mixed, 'x', 'y', { directed: true, weighted: true })).toMatchObject({ edges: ['both'], weight: 3 })
    // Undirected search: the same pair, and the cheaper edge is walkable in both directions.
    expect(shortestPath(mixed, 'x', 'y', { weighted: true })?.weight).toBe(0.5)
  })

  it('weights and hops disagree: unweighted takes the short hop, weighted the cheap detour, and the same call twice gives the same answer', () => {
    const g = slice(['a', 'b', 'c', 'd'], [['direct', 'a', 'd', false, 10], ['ab', 'a', 'b', false, 1], ['bc', 'b', 'c', false, 1], ['cd', 'c', 'd', false, 1]])
    expect(shortestPath(g, 'a', 'd')).toMatchObject({ nodes: ['a', 'd'], edges: ['direct'], length: 1 })
    expect(shortestPath(g, 'a', 'd', { weighted: true })).toMatchObject({ nodes: ['a', 'b', 'c', 'd'], edges: ['ab', 'bc', 'cd'], length: 3, weight: 3 })
    const twice = [shortestPath(g, 'a', 'd', { weighted: true }), shortestPath(g, 'a', 'd', { weighted: true })]
    expect(twice[0]).toEqual(twice[1])
    // Two routes of equal length and weight: whichever is chosen, it is chosen every time.
    const tie = slice(['s', 'u', 'v', 't'], [['su', 's', 'u', false], ['ut', 'u', 't', false], ['sv', 's', 'v', false], ['vt', 'v', 't', false]])
    const runs = Array.from({ length: 5 }, () => shortestPath(tie, 's', 't'))
    expect(new Set(runs.map((r) => r!.nodes.join('>')))).toEqual(new Set([runs[0]!.nodes.join('>')]))
    expect(runs[0]!.length).toBe(2)
  })

  it('the graph built from a slice keeps every node, self-loops and parallels, and drops an edge whose end is missing', () => {
    const s = new EntityStore()
    s.upsertMany([
      createEntity({ id: 'a', type: 'note' }),
      createEntity({ id: 'b', type: 'note' }),
      createRelationship({ id: 'ab1', type: 'r', source: 'a', target: 'b' }),
      createRelationship({ id: 'ab2', type: 'r', source: 'a', target: 'b', directed: false }),
      createRelationship({ id: 'aa', type: 'r', source: 'a', target: 'a' }),
    ])
    const sl = applyFilter(s, new TypeRegistry(s), emptyFilter())
    const stray = { ...sl, edges: [...sl.edges, { ...sl.edges[0], id: 'gone', target: { id: 'ghost' } }] } as GraphSlice
    const g = sliceToGraphology(stray, { directed: true })
    expect(g.order).toBe(2)
    expect(g.size).toBe(3)
    expect(g.hasEdge('gone')).toBe(false)
    expect(g.isDirected('ab1')).toBe(true)
    expect(g.isDirected('ab2')).toBe(false) // an undirected relationship stays undirected in a directed search
    const undirected = sliceToGraphology(stray, { directed: false })
    expect(undirected.edges().every((k) => undirected.isUndirected(k))).toBe(true)
    expect(sliceToGraphology(slice([], []), { directed: true }).order).toBe(0)
  })

  it('a directed search never walks against an arrow, and every hop of a route it does find names an edge', () => {
    // Both arrows point at b: there is no directed route from a to c, and none from c to a.
    const v = slice(['a', 'b', 'c'], [['ab', 'a', 'b'], ['cb', 'c', 'b']])
    expect(shortestPath(v, 'a', 'c', { directed: true })).toBeNull()
    expect(shortestPath(v, 'c', 'a', { directed: true })).toBeNull()
    expect(shortestPath(v, 'a', 'c', { directed: true, weighted: true })).toBeNull()
    expect(shortestPath(v, 'a', 'c')?.nodes).toEqual(['a', 'b', 'c']) // undirected: through b
    // A longer directed route with an undirected edge in the middle, and a decoy pointing backwards.
    const g = slice(['a', 'b', 'c', 'd'], [['ab', 'a', 'b'], ['bc', 'b', 'c', false], ['cd', 'c', 'd'], ['da', 'd', 'a'], ['cb', 'c', 'b']])
    for (const opts of [{ directed: true }, { directed: true, weighted: true }]) {
      const p = shortestPath(g, 'a', 'd', opts)!
      expect(p.nodes, JSON.stringify(opts)).toEqual(['a', 'b', 'c', 'd'])
      // One edge per hop: a route that named fewer would be hiding a step it could not actually walk.
      expect(p.edges.length, JSON.stringify(opts)).toBe(p.nodes.length - 1)
      for (const [i, key] of p.edges.entries()) {
        const e = g.edges.find((x) => x.id === key)!
        const ends = [e.source.id, e.target.id]
        expect(ends, key).toContain(p.nodes[i])
        expect(ends, key).toContain(p.nodes[i + 1])
        if (e.directed) expect(e.source.id, key).toBe(p.nodes[i])
      }
    }
  })

  it('a thousand-node line: the ends are a thousand hops apart, and both searches answer quickly', () => {
    const g = line(1000)
    const t = performance.now()
    const plain = shortestPath(g, 'n0', 'n999')
    const weighted = shortestPath(g, 'n0', 'n999', { weighted: true })
    const ms = performance.now() - t
    expect(plain?.length).toBe(999)
    expect(plain?.edges.length).toBe(999)
    expect(weighted?.weight).toBe(999)
    expect(weighted?.nodes).toEqual(plain?.nodes)
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(4000)
  })
})
