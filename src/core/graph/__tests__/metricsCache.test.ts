import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { clearMetricsCache, computeMetrics, coversMetrics, getCachedMetrics, mergeMetrics, partialMetrics, putCachedMetrics, serializeSlice, sliceKey } from '../metrics'
import { metricsCacheSize } from '../metrics/cache'
import { runMetricsInWorker } from '../metrics/runInWorker'
import type { MetricsOptions, MetricsResult, NodeMetricId, SerialGraph } from '../metrics/types'
import { metricsOptionsFor, runAnalyses } from '../../../analysis/run'
import { buildAnalysisInput } from '../../../features/analysis/buildInput'
import { TypeRegistry } from '../../entity/typeRegistry'
import '../types'

/** Two triangles joined by a bridge, plus a tail. */
function fixture() {
  const s = new EntityStore()
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  s.upsertMany(ids.map((id) => createEntity({ id, type: 'n', label: id })))
  const link = (x: string, y: string) => createRelationship({ id: x + y, type: 'r', source: x, target: y, directed: true })
  s.upsertMany([link('a', 'b'), link('b', 'c'), link('c', 'a'), link('c', 'd'), link('d', 'e'), link('e', 'f'), link('f', 'd'), link('f', 'g')])
  const slice = { nodes: ids.map((id) => s.get(id)!), edges: s.relationships() }
  return { s, slice, key: sliceKey(slice) }
}

const run = (slice: ReturnType<typeof fixture>['slice'], key: string, metrics: MetricsResult['options']['metrics'], extra: Partial<MetricsResult['options']> = {}) =>
  computeMetrics(serializeSlice(slice), { metrics, ...extra }, {}, key)

describe('metrics cache', () => {
  beforeEach(() => clearMetricsCache())

  it('answers a repeated request from memory, narrowed to the columns asked for', () => {
    const { slice, key } = fixture()
    expect(getCachedMetrics(key, { metrics: ['degree'] })).toBeUndefined()
    const r = run(slice, key, ['degree', 'pagerank', 'community'])
    putCachedMetrics(r)
    const hit = getCachedMetrics(key, { metrics: ['pagerank'] })
    expect(hit).toBeDefined()
    expect(hit!.columns.pagerank).toBe(r.columns.pagerank)
    expect(Object.keys(hit!.columns)).toEqual(['pagerank'])
    expect(hit!.options.metrics).toEqual(['pagerank'])
    expect(hit!.communities).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['community'] })!.communities).toBe(r.communities)
  })

  it('misses on a different slice, a missing column, or settings that change a column', () => {
    const { slice, key } = fixture()
    const r = run(slice, key, ['degree', 'community', 'betweenness'])
    putCachedMetrics(r)
    expect(getCachedMetrics('other', { metrics: ['degree'] })).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['closeness'] })).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['degree'], weightField: 'data.weight' })).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['degree'], directed: false })).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['community'], louvain: { resolution: 2, seed: 1 } })).toBeUndefined()
    expect(getCachedMetrics(key, { metrics: ['betweenness'], sampling: { sampleAbove: 10, sources: 5, seed: 1 } })).toBeUndefined()
    // The same settings spelled out explicitly are the defaults, so they hit.
    expect(getCachedMetrics(key, { metrics: ['community'], louvain: { resolution: 1, seed: 1 } })).toBeDefined()
    // Path statistics: a request that wants none is answered by any result; one that wants them needs the same path options.
    expect(getCachedMetrics(key, { metrics: ['degree'], paths: { exactBelow: 0, sampleSources: 0, seed: 1 } })).toBeDefined()
    expect(getCachedMetrics(key, { metrics: ['degree'], paths: { exactBelow: 10, sampleSources: 5, seed: 1 } })).toBeUndefined()
    expect(coversMetrics(r, { metrics: ['degree'] })).toBe(true)
  })

  it('keeps a few results per slice, drops the ones a new result makes redundant, and bounds the number of slices', () => {
    const { slice, key } = fixture()
    putCachedMetrics(run(slice, key, ['degree']))
    putCachedMetrics(run(slice, key, ['pagerank']))
    expect(metricsCacheSize()).toBe(2)
    putCachedMetrics(run(slice, key, ['degree', 'pagerank']))
    expect(metricsCacheSize()).toBe(1)
    // A narrowed hit put back, or the same run again, adds nothing.
    putCachedMetrics(getCachedMetrics(key, { metrics: ['degree'] })!)
    putCachedMetrics(run(slice, key, ['pagerank']))
    expect(metricsCacheSize()).toBe(1)
    expect(getCachedMetrics(key, { metrics: ['degree'] })!.cached).toBe(true)
    for (let i = 0; i < 10; i++) putCachedMetrics({ ...run(slice, `k${i}`, ['degree']) })
    expect(getCachedMetrics('k0', { metrics: ['degree'] })).toBeUndefined()
    expect(getCachedMetrics('k9', { metrics: ['degree'] })).toBeDefined()
    expect(getCachedMetrics(key, { metrics: ['degree'] })).toBeUndefined()
  })

  it('lets the Insights runner skip its metrics stage when a covering result is handed in', () => {
    const { s } = fixture()
    const input = buildAnalysisInput(s, new TypeRegistry(s))
    const which = ['centrality', 'communities'] as const
    const options = metricsOptionsFor([...which])
    expect(options.metrics.length).toBeGreaterThan(0)
    const precomputed = computeMetrics({ ids: input.ids, src: input.src, dst: input.dst, directed: input.directed }, options, {}, input.key)
    const seen: string[] = []
    const { metrics } = runAnalyses(input, [...which], {}, { metrics: precomputed, onProgress: (stage) => seen.push(stage) })
    expect(metrics).toBe(precomputed)
    // No metric stage ran: only the per-analysis progress marks appear after the initial 'metrics' tick.
    expect(seen.filter((x) => x === 'pagerank' || x === 'build')).toEqual([])
    // A result over a different slice is ignored and metrics are computed.
    const other = runAnalyses(input, [...which], {}, { metrics: { ...precomputed, sliceKey: 'elsewhere' } })
    expect(other.metrics).not.toBe(precomputed)
    expect(other.metrics.sliceKey).toBe(input.key)
  })

  it('runMetricsInWorker answers a cached key without starting a worker', async () => {
    const { slice, key } = fixture()
    const started = vi.fn()
    class FakeWorker {
      constructor() {
        started()
      }
      postMessage() {}
      terminate() {}
      onmessage: unknown
      onerror: unknown
    }
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const r = run(slice, key, ['degree', 'pagerank'])
      putCachedMetrics(r)
      const got = await runMetricsInWorker(serializeSlice(slice), { metrics: ['pagerank'] }, key)
      expect(got.columns.pagerank).toBe(r.columns.pagerank)
      expect(started).not.toHaveBeenCalled()
      // A miss does start one.
      void runMetricsInWorker(serializeSlice(slice), { metrics: ['closeness'] }, key).catch(() => {})
      expect(started).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does no work on a repeated key: computeMetrics is not called twice by the cached path', () => {
    const { slice, key } = fixture()
    const compute = vi.fn(() => run(slice, key, ['degree', 'pagerank']))
    const once = (want: MetricsResult['options']) => {
      const hit = getCachedMetrics(key, want)
      if (hit) return hit
      const r = compute()
      putCachedMetrics(r)
      return r
    }
    once({ metrics: ['degree', 'pagerank'] })
    once({ metrics: ['degree', 'pagerank'] })
    once({ metrics: ['pagerank'] })
    expect(compute).toHaveBeenCalledTimes(1)
  })
})

describe('partial compute on a miss', () => {
  beforeEach(() => clearMetricsCache())

  it('names the columns a cached result can lend and what is left to compute', () => {
    const { slice, key } = fixture()
    // An Insights-style result: no path statistics.
    putCachedMetrics(run(slice, key, ['degree', 'pagerank', 'community'], { paths: { exactBelow: 0, sampleSources: 0, seed: 1 } }))
    const p = partialMetrics(key, { metrics: ['pagerank', 'community', 'closeness'] })!
    expect(p.reused).toEqual(['pagerank', 'community'])
    expect(p.remaining.metrics).toEqual(['closeness'])
    // The Stats tab wants path statistics by default and the base has none, so they stay in the remaining run.
    expect(p.remaining.paths).toBeUndefined()
    // Only the paths missing: an empty column list, paths still on.
    const q = partialMetrics(key, { metrics: ['degree'] })!
    expect(q.remaining.metrics).toEqual([])
    // Nothing to gain: a request that wants no paths and no cached column.
    expect(partialMetrics(key, { metrics: ['closeness'], paths: { exactBelow: 0, sampleSources: 0, seed: 1 } })).toBeUndefined()
    // A different base (weighting) lends nothing; different Louvain settings lend everything but the community.
    expect(partialMetrics(key, { metrics: ['pagerank'], weightField: 'data.w' })).toBeUndefined()
    expect(partialMetrics(key, { metrics: ['pagerank', 'community'], louvain: { resolution: 2, seed: 1 } })!.reused).toEqual(['pagerank'])
  })

  it('merges lent columns with a fresh run into one result that then covers the request', () => {
    const { slice, key } = fixture()
    const base = run(slice, key, ['degree', 'pagerank', 'community'], { paths: { exactBelow: 0, sampleSources: 0, seed: 1 } })
    putCachedMetrics(base)
    const want = { metrics: ['pagerank', 'community', 'clustering'] as NodeMetricId[] }
    const p = partialMetrics(key, want)!
    const fresh = run(slice, key, p.remaining.metrics, p.remaining)
    expect(Object.keys(fresh.columns)).toEqual(['clustering'])
    const merged = mergeMetrics(p.base, p.reused, fresh, want)
    expect(merged.columns.pagerank).toBe(base.columns.pagerank)
    expect(merged.columns.community).toBe(base.columns.community)
    expect(merged.columns.clustering).toBe(fresh.columns.clustering)
    expect(merged.reused).toEqual(['pagerank', 'community'])
    expect(merged.summary.modularity).toBe(base.summary.modularity)
    expect(merged.communities).toBe(base.communities)
    expect(merged.summary.averageClustering).toBe(fresh.summary.averageClustering)
    expect(merged.summary.pathsExact).toBe(true)
    expect(merged.summary.diameter).toBeGreaterThan(0)
    expect(merged.options).toEqual(want)
    // Same as computing everything at once.
    const full = run(slice, key, want.metrics)
    expect(Array.from(merged.columns.clustering!)).toEqual(Array.from(full.columns.clustering!))
    expect(merged.summary.diameter).toBe(full.summary.diameter)
    expect(merged.summary.modularity).toBe(full.summary.modularity)
    putCachedMetrics(merged)
    expect(getCachedMetrics(key, want)).toBeDefined()
    expect(getCachedMetrics(key, want)!.reused).toBeUndefined()
  })

  it('runMetricsInWorker asks the worker for only the missing part', async () => {
    const { slice, key } = fixture()
    const posted: unknown[] = []
    class FakeWorker {
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onerror: unknown
      postMessage(req: { options: MetricsOptions; graph: SerialGraph; sliceKey: string }) {
        posted.push(req.options)
        const result = computeMetrics(req.graph, req.options, {}, req.sliceKey)
        queueMicrotask(() => this.onmessage?.({ data: { type: 'result', result } }))
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    try {
      putCachedMetrics(run(slice, key, ['degree', 'pagerank', 'community'], { paths: { exactBelow: 0, sampleSources: 0, seed: 1 } }))
      const got = await runMetricsInWorker(serializeSlice(slice), { metrics: ['pagerank', 'community', 'betweenness'] }, key)
      expect((posted[0] as MetricsOptions).metrics).toEqual(['betweenness'])
      expect(got.reused).toEqual(['pagerank', 'community'])
      expect(Object.keys(got.columns).sort()).toEqual(['betweenness', 'community', 'pagerank'])
      expect(got.summary.diameter).toBeGreaterThan(0)
      // Now covered: the same request is a hit.
      const again = await runMetricsInWorker(serializeSlice(slice), { metrics: ['pagerank', 'community', 'betweenness'] }, key)
      expect(again.cached).toBe(true)
      expect(posted.length).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
