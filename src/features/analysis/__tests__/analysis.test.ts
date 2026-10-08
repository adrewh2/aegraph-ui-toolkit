import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { buildPlot } from '../../../core/graph/plot'
import { runAnalyses } from '../../../analysis/run'
import { buildAnalysisInput } from '../buildInput'
import { setLatestAnalysis } from '../latest'
import { metricsNeeded, renderingFor } from '../materialize'
import { plotContextFor } from '../../plots/plotContext'

function fixture() {
  const store = new EntityStore()
  const at = (d: number) => new Date(Date.UTC(2024, 0, 1 + d)).toISOString()
  for (let i = 0; i < 12; i++) store.upsert(createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}`, data: { role: i % 3 ? 'dev' : '' }, tags: ['team'], meta: { createdAt: at(i), updatedAt: at(i + 1), source: 'test' } }))
  store.upsert(createEntity({ id: 'd1', type: 'document', label: 'Plan', data: { title: 'Plan' }, meta: { createdAt: at(3), updatedAt: at(3), source: 'test' } }))
  store.upsert(createEntity({ id: 'plot1', type: 'plot', label: 'A plot', data: { spec: { traces: [] } }, meta: { createdAt: at(3), updatedAt: at(3), source: 'test' } }))
  for (let i = 0; i < 12; i++) {
    store.upsert(createRelationship({ id: `a${i}`, type: 'authored', source: { id: `p${i}` }, target: { id: 'd1' } }))
    if (i) store.upsert(createRelationship({ id: `k${i}`, type: 'knows', source: { id: `p${i - 1}` }, target: { id: `p${i}` } }))
  }
  return { store, registry: new TypeRegistry(store) }
}

describe('analysis in the app', () => {
  it('builds a columnar input from the store, leaving graph types out', () => {
    const { store, registry } = fixture()
    const input = buildAnalysisInput(store, registry)
    expect(input.ids.length).toBe(13)
    expect(input.types).not.toContain('plot')
    expect(input.src.length).toBe(23)
    expect(input.edgeTypes.filter((t) => t === 'knows').length).toBe(11)
    // Empty strings do not count as a property being set.
    expect(input.props[input.ids.indexOf('p0')]).toEqual([])
    expect(input.props[input.ids.indexOf('p1')]).toEqual(['role'])
    expect(Number.isFinite(input.created[0])).toBe(true)
    expect(input.scope.label).toBe('Library')
    expect(input.schema.some((t) => t.type === 'person')).toBe(true)
  })

  it('lends the latest run’s metrics to plots over the same dataset', () => {
    const { store, registry } = fixture()
    const input = buildAnalysisInput(store, registry)
    const { report, metrics } = runAnalyses(input, ['communities'])
    setLatestAnalysis({ report, metrics })
    const ctx = plotContextFor(store, registry)
    expect(ctx.refs().find((r) => r.ref === 'metric.community')?.available).toBe(true)
    const built = buildPlot({ traces: [{ kind: 'bar', x: 'metric.community', agg: 'count' }] }, ctx)
    expect(built.stats.rows).toBe(13)
    // A changed dataset no longer matches: the metrics are withheld.
    store.upsert(createEntity({ id: 'p99', type: 'person', label: 'New', meta: { createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z', source: 'test' } }))
    expect(plotContextFor(store, registry).refs().find((r) => r.ref === 'metric.community')?.available).toBe(false)
    setLatestAnalysis(null)
  })

  it('maps a declarative graph style onto the rendering spec', () => {
    const r = renderingFor({ color: { by: 'community' }, size: { by: 'metric', metric: 'pagerank', min: 2, max: 20 } })
    expect(r.nodes.default.color).toEqual({ mode: 'partition', attr: { kind: 'metric', key: 'community' }, palette: 'tableau10', maxCategories: 12 })
    expect(r.nodes.default.size).toMatchObject({ mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 2, max: 20 })
    expect(metricsNeeded({ color: { by: 'community' }, size: { by: 'metric', metric: 'pagerank' } })).toEqual(['community', 'pagerank'])
    expect(metricsNeeded({ color: { by: 'type' }, size: { by: 'degree' } })).toEqual([])
  })
})
