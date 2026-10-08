import { describe, expect, it } from 'vitest'
import { computeMetrics } from '../metrics'
import { METRIC_IDS, type MetricsOptions, type NodeMetricId, type SerialGraph } from '../metrics/types'

/**
 * computeMetrics metric by metric, where metrics.test.ts and
 * metrics-edges.test.ts did not look: every metric over an empty graph and
 * over one node, a self-loop alone, parallel edges, a directed edge read
 * undirected, a zero weight, a star (betweenness), a cycle (PageRank), a
 * bipartite graph at resolution extremes (community), the sampling
 * threshold exactly at sampleAbove, path statistics over two components,
 * stopping between stages, which durations a run records, and the
 * summary's density and average degree on a multigraph.
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
const arr = (a: Float64Array | undefined) => (a ? Array.from(a) : undefined)
const all: NodeMetricId[] = [...METRIC_IDS]
const run = (g: SerialGraph, metrics: NodeMetricId[] = all, extra: Partial<MetricsOptions> = {}) => computeMetrics(g, { metrics, ...extra })

describe('metrics per metric, at the edges', () => {
  it('every metric over an empty graph: empty columns, a summary of zeros, no path statistics, and nothing thrown', () => {
    const r = run(graph(0, []))
    for (const m of all) if (r.columns[m]) expect(r.columns[m]!.length, m).toBe(0)
    expect(r.summary).toMatchObject({ nodes: 0, edges: 0, density: 0, averageDegree: 0, componentCount: 0, giantComponentSize: 0, averageClustering: 0 })
    expect(r.summary.diameter).toBeUndefined()
    expect(r.summary.pathsExact).toBeUndefined()
    expect(r.communities).toEqual({ count: 0, sizes: [] })
    expect(r.ids).toEqual([])
  })

  it('every metric over one node, and over one node with only a self-loop: the loop counts as an edge in the summary but nowhere else', () => {
    for (const g of [graph(1, []), graph(1, [[0, 0]])]) {
      const r = run(g)
      expect(arr(r.columns.degree)).toEqual([0])
      expect(arr(r.columns.inDegree)).toEqual([0])
      expect(arr(r.columns.weightedDegree)).toEqual([0])
      expect(arr(r.columns.component)).toEqual([0])
      expect(arr(r.columns.componentSize)).toEqual([1])
      expect(arr(r.columns.clustering)).toEqual([0])
      expect(arr(r.columns.pagerank)).toEqual([1])
      expect(arr(r.columns.community)).toEqual([0])
      expect(arr(r.columns.closeness)).toEqual([0])
      expect(arr(r.columns.betweenness)).toEqual([0])
      expect(r.summary.edges).toBe(g.src.length)
      expect(r.summary).toMatchObject({ density: 0, averageDegree: 0, componentCount: 1, giantComponentSize: 1 })
      expect(r.summary.diameter).toBeUndefined() // one node: no paths to measure
      for (const k of ['hub', 'authority', 'eigenvector'] as const) for (const v of arr(r.columns[k]) ?? []) expect(Number.isFinite(v), k).toBe(true)
    }
  })

  it('parallel edges merge for the structure and add up for the weights; a directed edge read undirected has in = out = degree', () => {
    const r = run(graph(2, [[0, 1], [0, 1], [1, 0]]))
    // Degrees count distinct neighbours in every direction; the multiplicity lives in the weights.
    expect(arr(r.columns.degree)).toEqual([1, 1])
    expect(arr(r.columns.weightedDegree)).toEqual([3, 3])
    expect(arr(r.columns.inDegree)).toEqual([1, 1])
    expect(arr(r.columns.outDegree)).toEqual([1, 1])
    expect(r.summary).toMatchObject({ edges: 3, density: 1, averageDegree: 1 })
    const u = run(graph(3, [[0, 1], [1, 2]]), ['degree', 'inDegree', 'outDegree', 'pagerank'], { directed: false })
    expect(arr(u.columns.inDegree)).toEqual(arr(u.columns.degree))
    expect(arr(u.columns.outDegree)).toEqual(arr(u.columns.degree))
    expect(arr(u.columns.pagerank)!.reduce((a, b) => a + b)).toBeCloseTo(1, 9)
    expect(u.columns.pagerank![0]).toBeCloseTo(u.columns.pagerank![2], 9) // symmetric ends
  })

  it('a zero weight is taken as given (the serialiser is what turns bad weights into 1): the weighted degree is zero and PageRank stays finite', () => {
    const r = run(graph(3, [[0, 1, true, 0], [1, 2, true, 2]]), ['weightedDegree', 'pagerank', 'community'])
    expect(arr(r.columns.weightedDegree)).toEqual([0, 2, 2])
    expect(arr(r.columns.pagerank)!.every(Number.isFinite)).toBe(true)
    expect(arr(r.columns.pagerank)!.reduce((a, b) => a + b)).toBeCloseTo(1, 9)
    expect(arr(r.columns.community)!.every(Number.isFinite)).toBe(true)
  })

  it('betweenness on a star: the centre carries every path and the leaves none; PageRank on a cycle is uniform', () => {
    const k = 6
    const star = run(graph(k + 1, Array.from({ length: k }, (_, i) => [0, i + 1] as [number, number])), ['betweenness', 'closeness'])
    const b = arr(star.columns.betweenness)!
    expect(b[0]).toBeGreaterThan(0)
    expect(b.slice(1)).toEqual(new Array(k).fill(0))
    const c = arr(star.columns.closeness)!
    expect(c[0]).toBeGreaterThan(c[1])
    expect(new Set(c.slice(1).map((v) => v.toFixed(9))).size).toBe(1)
    const n = 7
    const cycle = run(graph(n, Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number])), ['pagerank', 'eigenvector', 'hub', 'authority'])
    for (const v of arr(cycle.columns.pagerank)!) expect(v).toBeCloseTo(1 / n, 9)
    for (const m of ['eigenvector', 'hub', 'authority'] as const) {
      const col = arr(cycle.columns[m])
      if (col) expect(new Set(col.map((v) => v.toFixed(6))).size, m).toBe(1)
    }
  })

  it('community on a bipartite graph: the count never falls as the resolution rises, and ids are numbered largest first', () => {
    const edges: [number, number][] = []
    for (let a = 0; a < 3; a++) for (let b = 3; b < 8; b++) edges.push([a, b])
    edges.push([8, 9], [9, 10], [10, 8]) // a triangle apart
    const g = graph(11, edges)
    const counts = [0.05, 1, 50].map((resolution) => run(g, ['community'], { louvain: { resolution, seed: 1 } }).summary.communityCount!)
    expect(counts[0]).toBeLessThanOrEqual(counts[1])
    expect(counts[1]).toBeLessThanOrEqual(counts[2])
    expect(counts[0]).toBeGreaterThanOrEqual(2) // two pieces can never be one community
    const r = run(g, ['community'])
    const sizes = r.communities!.sizes
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes)
    expect(sizes.reduce((a, b) => a + b)).toBe(11)
    const col = arr(r.columns.community)!
    expect(col[8]).toBe(col[9])
    expect(col[9]).toBe(col[10])
    expect(col[0]).not.toBe(col[8])
    expect(Math.max(...col)).toBe(sizes.length - 1)
    expect(run(g, ['community']).columns.community).toEqual(r.columns.community) // seeded: the same twice
  })

  it('samples the path centralities only past sampleAbove, exactly at it not; path statistics over two components stay finite', () => {
    const chain = (n: number) => graph(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]))
    const at = run(chain(10), ['betweenness', 'closeness'], { sampling: { sampleAbove: 10, sources: 3, seed: 1 } })
    expect(at.summary.centralitySources).toBeUndefined()
    const past = run(chain(11), ['betweenness', 'closeness'], { sampling: { sampleAbove: 10, sources: 3, seed: 1 } })
    expect(past.summary.centralitySources).toBe(3)
    const two = run(graph(6, [[0, 1], [1, 2], [3, 4], [4, 5]]), ['closeness'], { paths: { exactBelow: 100, sampleSources: 0, seed: 1 } })
    expect(two.summary.pathsExact).toBe(true)
    expect(two.summary.diameter).toBe(2)
    expect(Number.isFinite(two.summary.averagePathLength!)).toBe(true)
    expect(two.summary.averagePathLength).toBeGreaterThan(1)
    expect(two.summary.averagePathLength).toBeLessThanOrEqual(2)
    expect(two.summary.componentCount).toBe(2)
  })

  it('stops between stages, keeping what was done, and records a duration for each stage it ran (degree and authority ride on others)', () => {
    const g = graph(20, Array.from({ length: 30 }, (_, i) => [i % 20, (i * 7 + 3) % 20] as [number, number]))
    let seen: string[] = []
    const stopped = computeMetrics(g, { metrics: all }, { onProgress: (stage) => void seen.push(stage), shouldStop: () => seen.includes('pagerank') })
    expect(stopped.columns.degree).toBeDefined()
    expect(stopped.columns.clustering).toBeDefined()
    expect(stopped.columns.pagerank).toBeDefined()
    expect(stopped.columns.eigenvector).toBeUndefined()
    expect(stopped.columns.community).toBeUndefined()
    expect(stopped.columns.betweenness).toBeUndefined()
    expect(stopped.summary.diameter).toBeUndefined()
    expect(stopped.summary.durations.total).toBeGreaterThanOrEqual(0)
    seen = []
    const full = computeMetrics(g, { metrics: all }, { onProgress: (stage) => void seen.push(stage) })
    const d = full.summary.durations
    for (const k of ['build', 'component', 'inDegree', 'outDegree', 'weightedDegree', 'clustering', 'pagerank', 'eigenvector', 'hub', 'community', 'closeness', 'betweenness', 'paths', 'total'] as const) expect(d[k], k).toBeGreaterThanOrEqual(0)
    expect(d.degree).toBeUndefined()
    expect(d.authority).toBeUndefined()
    expect([...new Set(seen)]).toEqual(['build', 'components', 'clustering', 'pagerank', 'eigenvector', 'hits', 'community', 'closeness', 'betweenness', 'paths'])
    for (const m of all) expect(full.columns[m], m).toBeDefined()
  })

  it('the summary counts every edge given but measures density and average degree on the simple graph underneath', () => {
    const r = run(graph(3, [[0, 1], [0, 1], [1, 2], [2, 2]]), ['degree'])
    expect(r.summary.edges).toBe(4)
    expect(r.summary.density).toBeCloseTo(2 / 3, 9)
    expect(r.summary.averageDegree).toBeCloseTo(4 / 3, 9)
    expect(arr(r.columns.degree)).toEqual([1, 2, 1])
  })
})
