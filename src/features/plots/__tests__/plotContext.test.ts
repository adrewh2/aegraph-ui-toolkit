import { afterEach, describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { clearMetricsCache, computeMetrics, putCachedMetrics, serializeSlice, sliceKey } from '../../../core/graph/metrics'
import { buildPlot } from '../../../core/graph/plot'
import '../../../core/graph/types'
import { setLatestAnalysis } from '../../analysis/latest'
import { plotContextFor } from '../plotContext'

/**
 * Plots read metric columns lent by a run over the exact node and edge set
 * they draw: the latest Insights run, or — since the shared metrics cache —
 * a Stats run over the whole dataset.
 */
function corpus() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'note', label: 'A' }),
    createEntity({ id: 'b', type: 'note', label: 'B' }),
    createEntity({ id: 'c', type: 'note', label: 'C' }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
    createRelationship({ id: 'cb', type: 'r', source: 'c', target: 'b' }),
  ])
  return s
}

describe('plot context', () => {
  afterEach(() => {
    clearMetricsCache()
    setLatestAnalysis(null)
  })

  it('lends the metric columns a Stats run left in the shared cache when they cover the dataset', () => {
    const store = corpus()
    const registry = new TypeRegistry(store)
    const before = plotContextFor(store, registry)
    expect(before.values.metrics).toBeUndefined()
    expect(before.refs().find((r) => r.ref === 'metric.pagerank')?.available).toBe(false)
    const spec = { traces: [{ kind: 'scatter' as const, x: 'degree', y: 'metric.pagerank' }] }
    // Rows come from the selector either way; without the column every point is missing.
    const blank = buildPlot(spec, before)
    expect(blank.stats.rows).toBe(3)
    expect(blank.stats.missing).toBeGreaterThan(0)

    // A Stats run over the same nodes and edges (the explorer with no filter): its columns are now lent.
    const key = sliceKey(before.slice)
    putCachedMetrics(computeMetrics(serializeSlice(before.slice), { metrics: ['degree', 'pagerank'] }, {}, key))
    const after = plotContextFor(store, registry)
    expect(after.values.metrics?.columns.pagerank).toBeDefined()
    expect(after.refs().find((r) => r.ref === 'metric.pagerank')?.available).toBe(true)
    const built = buildPlot(spec, after)
    expect(built.stats.rows).toBe(3)
    expect(built.stats.missing).toBe(0)
    expect(built.data[0].y).toHaveLength(3)
    // b is pointed at by a and c: the highest PageRank.
    const ys = built.data[0].y as number[]
    const xs = built.data[0].x as number[]
    expect(Math.max(...ys)).toBe(ys[xs.indexOf(2)])

    // A run over a different node set lends nothing.
    clearMetricsCache()
    putCachedMetrics(computeMetrics(serializeSlice({ nodes: before.slice.nodes.slice(0, 2), edges: [] }), { metrics: ['pagerank'] }, {}, 'elsewhere'))
    expect(plotContextFor(store, registry).values.metrics).toBeUndefined()
  })
})
