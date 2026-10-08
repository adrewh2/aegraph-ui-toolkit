import { beforeEach, describe, expect, it } from 'vitest'
import { metricsOptionsFor, runAnalyses } from '../../../analysis/run'
import { buildAnalysisInput } from '../../../features/analysis/buildInput'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { clearMetricsCache, computeMetrics, coversMetrics, getCachedMetrics, mergeMetrics, partialMetrics, putCachedMetrics, serializeSlice, sliceKey } from '../metrics'
import { metricsCacheSize } from '../metrics/cache'
import type { MetricsResult, NodeMetricId } from '../metrics/types'
import '../types'

/**
 * The result cache at its edges: a result without a key, the four-per-key
 * bound and which entry goes, the least recently *used* key surviving
 * past eight, the cell budget with the newest result always kept, a base
 * that lends only its path statistics, a tie between two bases, merging
 * when the fresh run also carries a lent column, warnings and durations
 * across a merge, a hit for a paths-off request from a result that has
 * them, the analysis runner's option set per analysis and its refusal
 * of a hooked result that lacks a column.
 */
function fixture() {
  const s = new EntityStore()
  const ids = ['a', 'b', 'c', 'd']
  s.upsertMany(ids.map((id) => createEntity({ id, type: 'n', label: id })))
  const link = (x: string, y: string) => createRelationship({ id: x + y, type: 'r', source: x, target: y, directed: true })
  s.upsertMany([link('a', 'b'), link('b', 'c'), link('c', 'a'), link('c', 'd')])
  const slice = { nodes: ids.map((id) => s.get(id)!), edges: s.relationships() }
  return { s, slice, key: sliceKey(slice) }
}
const NO_PATHS = { exactBelow: 0, sampleSources: 0, seed: 1 }
const run = (slice: ReturnType<typeof fixture>['slice'], key: string, metrics: NodeMetricId[], extra: Partial<MetricsResult['options']> = {}) => computeMetrics(serializeSlice(slice), { metrics, ...extra }, {}, key)
/** A result whose cell count is what matters, not its contents. */
const bulky = (key: string, rows: number, cols: number): MetricsResult => ({ ...run(fixture().slice, key, ['degree']), ids: new Array(rows).fill('x'), columns: Object.fromEntries(Array.from({ length: cols }, (_, i) => [`c${i}`, new Float64Array(1)])) as MetricsResult['columns'] })

describe('metrics cache edges', () => {
  beforeEach(() => clearMetricsCache())

  it('ignores a result without a slice key, keeps four incomparable results per key dropping the oldest, and keeps the least recently used key past eight', () => {
    const { slice, key } = fixture()
    putCachedMetrics({ ...run(slice, key, ['degree']), sliceKey: '' })
    expect(metricsCacheSize()).toBe(0)
    // Five bases that cannot cover one another: unweighted, weighted, undirected, two Louvain resolutions.
    putCachedMetrics(run(slice, key, ['degree'], { weightField: 'data.w' }))
    putCachedMetrics(run(slice, key, ['degree'], { directed: false }))
    putCachedMetrics(run(slice, key, ['community'], { louvain: { resolution: 2, seed: 1 } }))
    putCachedMetrics(run(slice, key, ['community'], { louvain: { resolution: 3, seed: 1 } }))
    expect(metricsCacheSize()).toBe(4)
    putCachedMetrics(run(slice, key, ['degree']))
    expect(metricsCacheSize()).toBe(4)
    expect(getCachedMetrics(key, { metrics: ['degree'], weightField: 'data.w' })).toBeUndefined() // the oldest went
    expect(getCachedMetrics(key, { metrics: ['degree'] })).toBeDefined()
    clearMetricsCache()
    for (let i = 0; i < 8; i++) putCachedMetrics(run(slice, `k${i}`, ['degree']))
    expect(getCachedMetrics('k0', { metrics: ['degree'] })).toBeDefined() // touched: now the most recently used
    putCachedMetrics(run(slice, 'k8', ['degree']))
    expect(getCachedMetrics('k0', { metrics: ['degree'] })).toBeDefined()
    expect(getCachedMetrics('k1', { metrics: ['degree'] })).toBeUndefined() // the least recently used went instead
  })

  it('drops the oldest slices when the cells add up past the budget, and always keeps the newest result even when it alone is over', () => {
    putCachedMetrics(bulky('old', 1_000_000, 3)) // 3M
    putCachedMetrics(bulky('mid', 1_000_000, 3)) // 6M
    putCachedMetrics(bulky('new', 1_000_000, 3)) // 9M: over 8M, the oldest goes
    expect(getCachedMetrics('old', { metrics: ['c0' as NodeMetricId] })).toBeUndefined()
    expect(getCachedMetrics('mid', { metrics: ['c0' as NodeMetricId] })).toBeDefined()
    expect(getCachedMetrics('new', { metrics: ['c0' as NodeMetricId] })).toBeDefined()
    putCachedMetrics(bulky('huge', 1_000_000, 9)) // 9M by itself
    expect(getCachedMetrics('huge', { metrics: ['c0' as NodeMetricId] })).toBeDefined()
    expect(getCachedMetrics('mid', { metrics: ['c0' as NodeMetricId] })).toBeUndefined()
    expect(getCachedMetrics('new', { metrics: ['c0' as NodeMetricId] })).toBeUndefined()
    expect(metricsCacheSize()).toBe(1)
  })

  it('lends path statistics alone, prefers the base that lends more and the newer on a tie, and lends nothing to a request it cannot help', () => {
    const { slice, key } = fixture()
    const withPaths = run(slice, key, ['degree'])
    putCachedMetrics(withPaths)
    // Nothing in common but the paths: the whole column list stays to compute, the paths do not.
    const p = partialMetrics(key, { metrics: ['pagerank'] })!
    expect(p.reused).toEqual([])
    expect(p.remaining).toEqual({ metrics: ['pagerank'], paths: NO_PATHS })
    const fresh = run(slice, key, p.remaining.metrics, p.remaining)
    expect(fresh.summary.diameter).toBeUndefined() // paths off: no statistics, not a diameter of 0
    expect(fresh.summary.averagePathLength).toBeUndefined()
    expect(fresh.summary.pathSources).toBeUndefined()
    const merged = mergeMetrics(p.base, p.reused, fresh, { metrics: ['pagerank'] })
    expect(merged.summary.diameter).toBe(withPaths.summary.diameter)
    expect(merged.summary.pathsExact).toBe(true)
    expect(merged.reused).toBeUndefined() // no column was lent
    expect(coversMetrics(merged, { metrics: ['pagerank'] })).toBe(true)
    // Two bases: one lends two columns, the other one — the richer wins; on a tie, the newer (first in the list).
    clearMetricsCache()
    putCachedMetrics(run(slice, key, ['degree', 'clustering'], { paths: NO_PATHS }))
    putCachedMetrics(run(slice, key, ['pagerank'], { paths: NO_PATHS }))
    expect(partialMetrics(key, { metrics: ['degree', 'clustering', 'pagerank'], paths: NO_PATHS })!.reused).toEqual(['degree', 'clustering'])
    const tie = partialMetrics(key, { metrics: ['degree', 'pagerank'], paths: NO_PATHS })!
    expect(tie.reused).toEqual(['pagerank'])
    expect(partialMetrics('nowhere', { metrics: ['degree'] })).toBeUndefined()
    expect(partialMetrics(key, { metrics: ['closeness'], paths: NO_PATHS })).toBeUndefined()
    expect(partialMetrics(key, { metrics: ['degree'], directed: false, paths: NO_PATHS })).toBeUndefined()
  })

  it('merges with the fresh column winning over a lent one, unions warnings and carries lent durations, and narrows a hit without dropping its summary', () => {
    const { slice, key } = fixture()
    const base = run(slice, key, ['degree', 'pagerank'], { paths: NO_PATHS })
    base.summary.warnings = ['from the base']
    base.summary.durations = { ...base.summary.durations, pagerank: 42 }
    const fresh = run(slice, key, ['pagerank', 'clustering'], { paths: NO_PATHS })
    fresh.summary.warnings = ['from the run']
    const merged = mergeMetrics(base, ['pagerank'], fresh, { metrics: ['pagerank', 'clustering'] })
    expect(merged.columns.pagerank).toBe(fresh.columns.pagerank) // computed again: the fresh one stands
    expect(merged.summary.durations.pagerank).not.toBe(42)
    expect(merged.summary.warnings).toEqual(['from the run', 'from the base'])
    expect(merged.reused).toEqual(['pagerank'])
    const lent = mergeMetrics(base, ['pagerank'], run(slice, key, ['clustering'], { paths: NO_PATHS }), { metrics: ['pagerank', 'clustering'] })
    expect(lent.summary.durations.pagerank).toBe(42)
    expect(mergeMetrics(base, [], fresh, { metrics: ['clustering'] }).summary.warnings).toEqual(['from the run']) // nothing lent: the base's warnings stay out
    // A request that wants no paths is answered by a result that has them; the summary keeps what it knows.
    putCachedMetrics(run(slice, key, ['degree']))
    const hit = getCachedMetrics(key, { metrics: ['degree'], paths: NO_PATHS })!
    expect(hit.cached).toBe(true)
    expect(hit.summary.diameter).toBeGreaterThan(0)
    expect(hit.options.paths).toEqual(NO_PATHS)
  })

  it('names the metrics each analysis needs, with the paths off, and the runner recomputes when a hooked result lacks a column', () => {
    expect(metricsOptionsFor(['centrality']).metrics).toContain('pagerank')
    expect(metricsOptionsFor(['communities']).metrics).toContain('community')
    expect(metricsOptionsFor(['centrality', 'communities']).metrics).toEqual(metricsOptionsFor(['centrality']).metrics) // communities' metrics are a subset: the union adds nothing
    expect(metricsOptionsFor(['nope' as never])).toEqual({ metrics: [], paths: { exactBelow: 0, sampleSources: 0, seed: 1 } })
    expect(metricsOptionsFor(['schema'], { seed: 7 }).paths?.seed).toBe(7)
    const { s } = fixture()
    const input = buildAnalysisInput(s, new TypeRegistry(s))
    const narrow = computeMetrics({ ids: input.ids, src: input.src, dst: input.dst, directed: input.directed }, { metrics: ['degree'], paths: NO_PATHS }, {}, input.key)
    const r = runAnalyses(input, ['centrality'], {}, { metrics: narrow })
    expect(r.metrics).not.toBe(narrow)
    expect(r.metrics.columns.pagerank).toBeDefined()
    const wide = computeMetrics({ ids: input.ids, src: input.src, dst: input.dst, directed: input.directed }, { ...metricsOptionsFor(['centrality']), metrics: [...metricsOptionsFor(['centrality']).metrics, 'clustering'] }, {}, input.key)
    expect(runAnalyses(input, ['centrality'], {}, { metrics: wide }).metrics).toBe(wide) // wider than needed still covers
  })
})
