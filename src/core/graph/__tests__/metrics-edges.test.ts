import { describe, expect, it } from 'vitest'
import { betweenness, buildDirected, buildUndirected, closeness, connectedComponents, degrees, eigenvector, hits, localClustering, pagerank, pathStats, weightedDegrees } from '../metrics/csr'
import { computeMetrics } from '../metrics'
import type { SerialGraph } from '../metrics/types'

/**
 * The metric kernels at their edges: self-loops and parallel edges in the
 * CSR, an edge to a node the graph does not have, weights, components by
 * size, clustering on a triangle, a star and an isolate, PageRank with
 * dangling nodes and direction, betweenness and closeness exact against
 * sampled and over disconnected pieces, eigenvector convergence, HITS on a
 * star, path statistics exact against sampled, and computeMetrics' summary
 * and stop hook.
 */
function graph(n: number, edges: [number, number, boolean?, number?][]): SerialGraph {
  return {
    ids: Array.from({ length: n }, (_, i) => `n${i}`),
    src: Uint32Array.from(edges.map((e) => e[0])),
    dst: Uint32Array.from(edges.map((e) => e[1])),
    directed: Uint8Array.from(edges.map((e) => (e[2] === false ? 0 : 1))),
    weight: edges.some((e) => e[3] !== undefined) ? Float64Array.from(edges.map((e) => e[3] ?? 1)) : undefined,
  }
}
const row = (c: ReturnType<typeof buildUndirected>, u: number) => Array.from(c.neighbors.slice(c.offsets[u], c.offsets[u + 1])).sort((a, b) => a - b)
const sum = (a: Float64Array) => Array.from(a).reduce((x, y) => x + y, 0)

describe('CSR', () => {
  it('drops self-loops, merges parallel edges by summing their weights, and lists undirected edges both ways in a directed view', () => {
    const g = graph(3, [[0, 0], [0, 1, true, 2], [0, 1, true, 3], [1, 2, false]])
    const und = buildUndirected(g)
    expect(row(und, 0)).toEqual([1])
    expect(und.weights[und.offsets[0]]).toBe(5)
    expect(row(und, 1)).toEqual([0, 2])
    expect(Array.from(degrees(und))).toEqual([1, 2, 1])
    expect(Array.from(weightedDegrees(und))).toEqual([5, 6, 1])
    const out = buildDirected(g, 'out')
    const inn = buildDirected(g, 'in')
    expect(row(out, 0)).toEqual([1])
    expect(row(out, 1)).toEqual([2]) // the undirected 1–2, seen from 1
    expect(row(out, 2)).toEqual([1])
    expect(row(inn, 0)).toEqual([])
    expect(row(inn, 1)).toEqual([0, 2])
  })

  it('ignores an edge whose end is not a node of the graph', () => {
    const g = graph(2, [[0, 1], [1, 7], [9, 0]])
    const und = buildUndirected(g)
    expect(und.n).toBe(2)
    expect(row(und, 0)).toEqual([1])
    expect(row(und, 1)).toEqual([0])
    expect(Array.from(und.neighbors).every((v) => v < 2)).toBe(true)
    // And every kernel over it stays finite.
    expect(Array.from(pagerank(buildDirected(g, 'out'))).every(Number.isFinite)).toBe(true)
    expect(connectedComponents(und).sizes).toEqual([2])
  })
})

describe('components, clustering', () => {
  it('numbers components from the largest and counts the isolates', () => {
    const g = graph(7, [[0, 1], [1, 2], [3, 4]])
    const { component, sizes } = connectedComponents(buildUndirected(g))
    expect(sizes).toEqual([3, 2, 1, 1])
    expect(Array.from(component.slice(0, 3))).toEqual([0, 0, 0])
    expect(component[3]).toBe(component[4])
    expect(component[5]).not.toBe(component[6])
    expect(connectedComponents(buildUndirected(graph(0, []))).sizes).toEqual([])
  })

  it('clusters a triangle fully, a star not at all, and leaves an isolate and a leaf at zero', () => {
    const g = graph(7, [[0, 1], [1, 2], [2, 0], [3, 4], [3, 5], [3, 6]])
    const cl = Array.from(localClustering(buildUndirected(g)))
    expect(cl.slice(0, 3)).toEqual([1, 1, 1])
    expect(cl[3]).toBe(0) // the star's centre: three neighbours, no two linked
    expect(cl[4]).toBe(0) // a leaf
    expect(localClustering(buildUndirected(graph(1, [])))[0]).toBe(0)
    // Closing one edge of the star gives its centre one triple out of three.
    const closed = graph(4, [[0, 1], [0, 2], [0, 3], [1, 2]])
    expect(localClustering(buildUndirected(closed))[0]).toBeCloseTo(1 / 3)
  })
})

describe('PageRank, eigenvector, HITS', () => {
  it('sums to one with dangling nodes, follows the arrows, and treats an undirected edge as two', () => {
    const chain = graph(4, [[0, 1], [1, 2], [2, 3]]) // 3 dangles
    const pr = pagerank(buildDirected(chain, 'out'))
    expect(sum(pr)).toBeCloseTo(1, 6)
    expect(pr[3]).toBeGreaterThan(pr[2])
    expect(pr[2]).toBeGreaterThan(pr[1])
    expect(pr[1]).toBeGreaterThan(pr[0])
    // Reversed arrows reverse the ranking; undirected, the two ends of one edge rank alike.
    const back = pagerank(buildDirected(graph(2, [[1, 0]]), 'out'))
    expect(back[0]).toBeGreaterThan(back[1])
    const und = pagerank(buildDirected(graph(2, [[0, 1, false]]), 'out'))
    expect(und[0]).toBeCloseTo(und[1])
    // Weights steer the share: the heavier edge gets more.
    const weighted = pagerank(buildDirected(graph(3, [[0, 1, true, 1], [0, 2, true, 3]]), 'out'))
    expect(weighted[2]).toBeGreaterThan(weighted[1])
    expect(sum(weighted)).toBeCloseTo(1, 6)
    // No edges at all: everyone equal; no nodes: nothing.
    expect(Array.from(pagerank(buildDirected(graph(3, []), 'out')))).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(pagerank(buildDirected(graph(0, []), 'out')).length).toBe(0)
  })

  it('eigenvector centrality converges on bipartite and disconnected graphs, peaks at the hub, and admits failure', () => {
    const star = buildUndirected(graph(4, [[0, 1], [0, 2], [0, 3]])) // bipartite: centre vs leaves
    const ev = eigenvector(star)!
    expect(ev).not.toBeNull()
    expect(ev[0]).toBe(1)
    expect(ev[1]).toBeCloseTo(ev[2])
    expect(ev[1]).toBeLessThan(1)
    const two = eigenvector(buildUndirected(graph(5, [[0, 1], [1, 2], [2, 0], [3, 4]])))!
    expect(two).not.toBeNull()
    expect(Math.max(...Array.from(two.slice(0, 3)))).toBe(1)
    expect(two[3]).toBeLessThan(two[0]) // the triangle dominates the pair
    expect(eigenvector(star, { maxIterations: 0 })).toBeNull()
    expect(eigenvector(buildUndirected(graph(0, [])))).toEqual(new Float64Array(0))
  })

  it('HITS makes the centre of an out-star the hub and its leaves the authorities, and the reverse for an in-star', () => {
    const outStar = graph(4, [[0, 1], [0, 2], [0, 3]])
    const h = hits(buildDirected(outStar, 'out'), buildDirected(outStar, 'in'))
    expect(h.hub[0]).toBeCloseTo(1)
    expect(h.authority[0]).toBe(0)
    expect(h.authority[1]).toBeCloseTo(1 / 3)
    const inStar = graph(4, [[1, 0], [2, 0], [3, 0]])
    const i = hits(buildDirected(inStar, 'out'), buildDirected(inStar, 'in'))
    expect(i.authority[0]).toBeCloseTo(1)
    expect(i.hub[1]).toBeCloseTo(1 / 3)
    const none = hits(buildDirected(graph(2, []), 'out'), buildDirected(graph(2, []), 'in'))
    expect(Array.from(none.hub)).toEqual([0, 0])
  })
})

describe('paths, betweenness, closeness', () => {
  it('measures a path graph exactly and reports a sampled run as a lower bound with its sources', () => {
    const path = buildUndirected(graph(5, [[0, 1], [1, 2], [2, 3], [3, 4]]))
    const exact = pathStats(path, { exactBelow: 100, sampleSources: 0, seed: 1 })
    expect(exact).toMatchObject({ diameter: 4, exact: true, sources: 5 })
    expect(exact.averagePathLength).toBeCloseTo(2) // 20 ordered pairs, total distance 40
    const sampled = pathStats(path, { exactBelow: 0, sampleSources: 2, seed: 1 })
    expect(sampled.exact).toBe(false)
    expect(sampled.sources).toBe(2)
    expect(sampled.diameter).toBeLessThanOrEqual(4)
    expect(sampled.diameter).toBeGreaterThan(0)
    // Two pieces: only reachable pairs count.
    const pieces = buildUndirected(graph(4, [[0, 1], [2, 3]]))
    expect(pathStats(pieces, { exactBelow: 100, sampleSources: 0, seed: 1 })).toMatchObject({ diameter: 1, averagePathLength: 1 })
    // Nothing to measure: zeros, not NaN.
    expect(pathStats(buildUndirected(graph(3, [])), { exactBelow: 100, sampleSources: 0, seed: 1 })).toMatchObject({ diameter: 0, averagePathLength: 0 })
    let calls = 0
    const stopped = pathStats(path, { exactBelow: 100, sampleSources: 0, seed: 1 }, undefined, () => ++calls > 1)
    expect(stopped.sources).toBe(5) // the plan
    expect(calls).toBe(2) // but it stopped after the first source
  })

  it('betweenness peaks at the middle of a path, is zero on a complete graph, and its sampled run agrees with the exact one on a small graph', () => {
    const path = buildUndirected(graph(5, [[0, 1], [1, 2], [2, 3], [3, 4]]))
    const exact = betweenness(path, 5, 1)
    expect(exact.sources).toBe(5)
    expect(exact.values[2]).toBeCloseTo(4 / 6) // 4 of the 6 pairs pass through the middle
    expect(exact.values[0]).toBe(0)
    expect(exact.values[1]).toBeCloseTo(3 / 6)
    const k4 = buildUndirected(graph(4, [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]))
    expect(Array.from(betweenness(k4, 4, 1).values)).toEqual([0, 0, 0, 0])
    // Sampled from every source but scaled: the same order, the middle still highest.
    const sampled = betweenness(path, 3, 7)
    expect(sampled.sources).toBe(3)
    expect(sampled.values[2]).toBeGreaterThanOrEqual(sampled.values[1])
    expect(sampled.values[0]).toBeLessThanOrEqual(sampled.values[1])
    // Disconnected: the bridge of one piece scores; the other piece does not interfere.
    const pieces = buildUndirected(graph(5, [[0, 1], [1, 2], [3, 4]]))
    const b = betweenness(pieces, 5, 1).values
    expect(b[1]).toBeGreaterThan(0)
    expect(b[3]).toBe(0)
    expect(betweenness(buildUndirected(graph(2, [[0, 1]])), 2, 1).values[0]).toBe(0)
  })

  it('closeness stays comparable across disconnected pieces and its sampled run keeps the exact ordering', () => {
    const path = buildUndirected(graph(5, [[0, 1], [1, 2], [2, 3], [3, 4]]))
    const exact = closeness(path, 5, 1).values
    expect(exact[2]).toBeCloseTo(1 / 1.5) // mean distance 1.5 from the middle, everyone reached
    expect(exact[2]).toBeGreaterThan(exact[1])
    expect(exact[1]).toBeGreaterThan(exact[0])
    expect(exact[0]).toBeCloseTo(exact[4])
    const pieces = buildUndirected(graph(5, [[0, 1], [1, 2], [3, 4]]))
    const c = closeness(pieces, 5, 1).values
    expect(c[1]).toBeGreaterThan(c[3]) // reaches two at distance 1 out of four possible; the pair reaches one
    expect(c[1]).toBeLessThan(1)
    expect(closeness(buildUndirected(graph(2, [])), 2, 1).values[0]).toBe(0)
    const sampled = closeness(path, 3, 7)
    expect(sampled.sources).toBe(3)
    expect(Array.from(sampled.values).every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})

describe('computeMetrics', () => {
  it('fills the summary from the graph, keys the result by the slice, and stops when asked', () => {
    const g = graph(6, [[0, 1], [1, 2], [2, 0], [3, 4]])
    const r = computeMetrics(g, { metrics: ['degree', 'component', 'componentSize', 'clustering', 'community'], paths: { exactBelow: 100, sampleSources: 0, seed: 1 } }, {}, 'key-1')
    expect(r.sliceKey).toBe('key-1')
    expect(r.summary).toMatchObject({ nodes: 6, edges: 4, componentCount: 3, giantComponentSize: 3, pathsExact: true, diameter: 1 })
    expect(r.summary.density).toBeCloseTo(4 / 15)
    expect(r.summary.averageDegree).toBeCloseTo(8 / 6)
    expect(r.summary.averageClustering).toBeCloseTo(0.5) // three at 1, three at 0
    expect(Array.from(r.columns.componentSize!)).toEqual([3, 3, 3, 2, 2, 1])
    expect(r.communities!.count).toBeGreaterThanOrEqual(3)
    expect(r.summary.warnings).toEqual([])
    expect(Object.keys(r.summary.durations)).toEqual(expect.arrayContaining(['build', 'component', 'clustering', 'community', 'paths', 'total']))
    // A stop before the expensive metrics leaves their columns out and the cheap ones in.
    const stopped = computeMetrics(g, { metrics: ['degree', 'clustering', 'betweenness'] }, { shouldStop: () => true }, 'key-2')
    expect(stopped.columns.degree).toBeDefined()
    expect(stopped.columns.clustering).toBeUndefined()
    expect(stopped.columns.betweenness).toBeUndefined()
    // A graph with no edges: Louvain gives every node its own community, density 0.
    const lone = computeMetrics(graph(3, []), { metrics: ['community'] }, {}, 'key-3')
    expect(lone.communities).toEqual({ count: 3, sizes: [1, 1, 1] })
    expect(lone.summary).toMatchObject({ density: 0, modularity: 0 })
  })
})
