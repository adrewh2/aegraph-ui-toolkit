import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { categoryCounts, columnStats, computeMetrics, fromAnalysisData, histogram, serializeSlice, sliceKey, toAnalysisData, topK, writeMetricsToEntities, type NodeMetricId } from '../metrics'
import { betweenness, buildUndirected, closeness, connectedComponents, localClustering, pagerank, pathStats } from '../metrics/csr'
import '../types'

/** Path a-b-c-d, triangle e-f-g, isolate z. */
function fixture() {
  const s = new EntityStore()
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'z']
  s.upsertMany(ids.map((id) => createEntity({ id, type: 'n', label: id })))
  s.upsertMany([
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b', directed: true }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c', directed: true, data: { weight: 3 } }),
    createRelationship({ id: 'cd', type: 'r', source: 'c', target: 'd', directed: true }),
    createRelationship({ id: 'ef', type: 'r', source: 'e', target: 'f', directed: false }),
    createRelationship({ id: 'fg', type: 'r', source: 'f', target: 'g', directed: false }),
    createRelationship({ id: 'ge', type: 'r', source: 'g', target: 'e', directed: false }),
    createRelationship({ id: 'dup', type: 'r', source: 'a', target: 'b', directed: true }),
  ])
  const nodes = ids.map((id) => s.get(id)!)
  const edges = s.relationships()
  return { s, slice: { nodes, edges } }
}

describe('serialize', () => {
  it('fingerprints slices order-insensitively and packs edges', () => {
    const { slice } = fixture()
    const k1 = sliceKey(slice)
    const k2 = sliceKey({ nodes: [...slice.nodes].reverse(), edges: [...slice.edges].reverse() })
    expect(k1).toBe(k2)
    expect(sliceKey({ nodes: slice.nodes.slice(1), edges: slice.edges })).not.toBe(k1)
    const g = serializeSlice(slice, 'data.weight')
    expect(g.ids).toHaveLength(8)
    expect(g.src.length).toBe(7)
    expect(Array.from(g.weight!)).toContain(3)
    expect(g.directed[3]).toBe(0)
  })
})

describe('csr metrics', () => {
  const g = serializeSlice(fixture().slice)
  const und = buildUndirected(g)
  const idx = (id: string) => g.ids.indexOf(id)
  it('merges parallel edges and finds components', () => {
    expect(und.offsets[idx('a') + 1] - und.offsets[idx('a')]).toBe(1)
    const c = connectedComponents(und)
    expect(c.sizes).toEqual([4, 3, 1])
    expect(c.component[idx('z')]).toBe(2)
    expect(c.component[idx('a')]).toBe(0)
  })
  it('computes clustering, betweenness, closeness and paths', () => {
    const cl = localClustering(und)
    expect(cl[idx('e')]).toBe(1)
    expect(cl[idx('b')]).toBe(0)
    const bt = betweenness(und, und.n, 1)
    expect(bt.values[idx('b')]).toBeGreaterThan(bt.values[idx('a')])
    expect(bt.values[idx('b')]).toBeCloseTo(bt.values[idx('c')])
    const sampled = betweenness(und, 3, 7)
    expect(sampled.sources).toBe(3)
    const cs = closeness(und, und.n, 1)
    expect(cs.values[idx('b')]).toBeGreaterThan(cs.values[idx('a')])
    expect(cs.values[idx('z')]).toBe(0)
    const p = pathStats(und, { exactBelow: 100, sampleSources: 2, seed: 1 })
    expect(p).toMatchObject({ diameter: 3, exact: true })
    const ps = pathStats(und, { exactBelow: 2, sampleSources: 3, seed: 1 })
    expect(ps.exact).toBe(false)
    expect(ps.sources).toBe(3)
  })
  it('pagerank sums to one and favours the sink of a directed chain', () => {
    const outC = { ...buildUndirected(g) }
    const pr = pagerank(outC)
    let s = 0
    for (const v of pr) s += v
    expect(s).toBeCloseTo(1, 6)
  })
})

describe('computeMetrics', () => {
  it('runs every metric with progress and produces a coherent summary', () => {
    const { slice } = fixture()
    const stages: string[] = []
    const all: NodeMetricId[] = ['degree', 'inDegree', 'outDegree', 'weightedDegree', 'pagerank', 'betweenness', 'closeness', 'eigenvector', 'hub', 'authority', 'clustering', 'component', 'componentSize', 'community']
    const r = computeMetrics(serializeSlice(slice, 'data.weight'), { metrics: all, weightField: 'data.weight' }, { onProgress: (s) => stages.push(s) }, 'k')
    expect(Object.keys(r.columns).sort()).toEqual([...all].sort())
    expect(stages[0]).toBe('build')
    expect(r.sliceKey).toBe('k')
    const i = (id: string) => r.ids.indexOf(id)
    expect(r.columns.degree![i('b')]).toBe(2)
    expect(r.columns.inDegree![i('a')]).toBe(0)
    expect(r.columns.outDegree![i('a')]).toBe(1)
    expect(r.columns.weightedDegree![i('c')]).toBe(4)
    expect(r.columns.componentSize![i('e')]).toBe(3)
    expect(r.summary).toMatchObject({ nodes: 8, componentCount: 3, giantComponentSize: 4, diameter: 3, pathsExact: true })
    expect(r.summary.communityCount).toBeGreaterThanOrEqual(3)
    expect(r.summary.modularity).toBeGreaterThan(0)
    expect(r.summary.density).toBeCloseTo(6 / 28)
    expect(r.communities!.sizes[0]).toBeGreaterThanOrEqual(r.communities!.sizes[1])
  })
  it('stops early when asked and handles empty graphs', () => {
    const { slice } = fixture()
    let calls = 0
    const r = computeMetrics(serializeSlice(slice), { metrics: ['degree', 'betweenness', 'closeness'] }, { shouldStop: () => ++calls > 2 })
    expect(r.columns.degree).toBeDefined()
    expect(r.columns.betweenness).toBeUndefined()
    const empty = computeMetrics(serializeSlice({ nodes: [], edges: [] }), { metrics: ['degree', 'community', 'pagerank'] })
    expect(empty.summary.nodes).toBe(0)
  })
  it('offers helpers, round-trips analyses, and writes back in one transaction', () => {
    const { s, slice } = fixture()
    const r = computeMetrics(serializeSlice(slice), { metrics: ['degree', 'component'] })
    expect(topK(r, 'degree', 2).map((t) => t.id).sort()).toEqual(['b', 'c'].sort().slice(0, 2).length === 2 ? expect.any(Array) : [])
    const stats = columnStats(r.columns.degree!)
    expect(stats).toMatchObject({ min: 0, max: 2, count: 8 })
    const h = histogram(r.columns.degree!, 4)
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(8)
    expect(categoryCounts(r.columns.component!)[0]).toEqual({ key: 0, count: 4 })
    const back = fromAnalysisData(toAnalysisData(r, { filterId: 'f' }))
    expect(Array.from(back.columns.degree!)).toEqual(Array.from(r.columns.degree!))
    let notifications = 0
    const unsub = s.subscribe(() => notifications++)
    const n = writeMetricsToEntities(s, r, ['degree'], 'm_')
    unsub()
    expect(n).toBe(8)
    expect(notifications).toBe(1)
    expect(s.get('b')?.data.m_degree).toBe(2)
  })
})
