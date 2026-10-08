import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { buildPlot, describePlot, floorTime, temporalMs } from '../plot'
import { plotContextFor } from '../../../features/plots/plotContext'

function fixture() {
  const store = new EntityStore()
  const seg = (id: string, created: string, region: string, chars: number, n: number) =>
    store.upsert(createEntity({ id, type: 'segment', label: id, data: { created, region, chars, n_messages: n }, tags: [`region:${region}`], meta: { createdAt: created, updatedAt: created, source: 'test' } }))
  seg('s1', '2024-01-05T10:00:00Z', 'tools', 1200, 4)
  seg('s2', '2024-01-20T10:00:00Z', 'tools', 3000, 8)
  seg('s3', '2024-02-02T10:00:00Z', 'life', 500, 2)
  seg('s4', '2024-02-15T10:00:00Z', 'tools', 900, 3)
  seg('s5', '2024-04-01T10:00:00Z', 'life', 4000, 12)
  store.upsert(createEntity({ id: 't1', type: 'topic', label: 'graphs', meta: { createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', source: 'test' } }))
  store.upsert(createRelationship({ id: 'r1', type: 'on-topic', source: { id: 's1' }, target: { id: 't1' } }))
  store.upsert(createRelationship({ id: 'r2', type: 'on-topic', source: { id: 's2' }, target: { id: 't1' } }))
  return { store, ctx: plotContextFor(store, new TypeRegistry(store)) }
}

describe('plot builder', () => {
  it('shortens long category ticks, turns them, and sizes the margin for them — no automargin', () => {
    const { store, ctx } = fixture()
    store.update('s3', { data: { ...store.require('s3').data, region: 'Consciousness, Dreams and the Long Night' } })
    const b = buildPlot({ selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'data.region' }] }, ctx)
    const x = b.layout.xaxis as { automargin?: boolean; tickangle?: number; tickvals?: string[]; ticktext?: string[] }
    expect(x.automargin).toBeUndefined()
    expect(x.tickangle).toBe(-45)
    expect(x.tickvals).toContain('Consciousness, Dreams and the Long Night')
    expect(x.ticktext).toContain('Consciousness, Dr…')
    expect(x.ticktext).toContain('tools') // short ones are left alone
    expect((b.layout.margin as { b: number }).b).toBeGreaterThan(100)
  })

  it('leaves a date axis alone: Plotly places and formats its ticks', () => {
    const { ctx } = fixture()
    const b = buildPlot({ selector: { types: ['segment'] }, traces: [{ kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.region' }] }, ctx)
    const x = b.layout.xaxis as { type?: string; tickvals?: unknown; tickangle?: number }
    expect(x.type).toBe('date')
    expect(x.tickvals).toBeUndefined()
    expect(x.tickangle).toBeUndefined()
    expect((b.layout.margin as { b: number }).b).toBe(48)
  })

  it('coerces timestamps and floors them to units', () => {
    expect(temporalMs('2024-03-05T12:00:00Z')).toBe(Date.parse('2024-03-05T12:00:00Z'))
    expect(temporalMs('2024-03')).toBe(Date.parse('2024-03-01'))
    expect(temporalMs(1709640000)).toBe(1709640000000) // seconds → ms
    expect(temporalMs(1709640000000)).toBe(1709640000000)
    expect(temporalMs(42)).toBeUndefined()
    const t = Date.parse('2024-03-06T15:30:00Z') // a Wednesday
    expect(new Date(floorTime(t, 'month')).toISOString()).toBe('2024-03-01T00:00:00.000Z')
    expect(new Date(floorTime(t, 'week')).toISOString()).toBe('2024-03-04T00:00:00.000Z')
    expect(new Date(floorTime(t, 'quarter')).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(new Date(floorTime(t, 'day')).toISOString()).toBe('2024-03-06T00:00:00.000Z')
  })

  it('counts activity per month as a date-axis bar trace', () => {
    const { ctx } = fixture()
    const b = buildPlot({ selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month' }] }, ctx)
    expect(b.stats).toEqual({ rows: 5, traces: 1, missing: 0 })
    expect(b.data[0].type).toBe('bar')
    expect(b.data[0].x).toEqual(['2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '2024-04-01T00:00:00.000Z'])
    expect(b.data[0].y).toEqual([2, 2, 1])
    expect((b.layout.xaxis as { type?: string }).type).toBe('date')
    expect((b.layout.yaxis as { title: { text: string } }).title.text).toBe('count')
  })

  it('treats an ISO-dated field as temporal whatever it is called', () => {
    const { store, ctx } = fixture()
    // `data.created` says "created"; a field named `startedAt` (or anything holding an ISO date) must bin the same way.
    const b = buildPlot({ selector: { types: ['segment'] }, traces: [{ kind: 'line', x: 'data.created', bin: 'month', y: 'data.chars', agg: 'mean' }] }, ctx)
    expect(b.data[0].x).toEqual(['2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '2024-04-01T00:00:00.000Z'])
    expect(b.data[0].y).toEqual([2100, 700, 4000])
    store.upsert(createEntity({ id: 'i1', type: 'incident', label: 'i1', data: { startedAt: '2024-03-03T10:00:00Z', duration_min: 30 }, meta: { createdAt: '2024-03-03T10:00:00Z', updatedAt: '2024-03-03T10:00:00Z', source: 'test' } }))
    store.upsert(createEntity({ id: 'i2', type: 'incident', label: 'i2', data: { startedAt: '2024-03-20T10:00:00Z', duration_min: 50 }, meta: { createdAt: '2024-03-20T10:00:00Z', updatedAt: '2024-03-20T10:00:00Z', source: 'test' } }))
    const ctx2 = plotContextFor(store, new TypeRegistry(store))
    const c = buildPlot({ selector: { types: ['incident'] }, traces: [{ kind: 'line', x: 'data.startedAt', bin: 'month', y: 'data.duration_min', agg: 'mean' }] }, ctx2)
    expect(c.data[0].x).toEqual(['2024-03-01T00:00:00.000Z'])
    expect(c.data[0].y).toEqual([40])
  })

  it('groups into one trace per category, aggregates y, and can run cumulatively', () => {
    const { ctx } = fixture()
    const b = buildPlot({ traces: [{ kind: 'line', selector: { types: ['segment'] }, x: 'data.created', bin: 'month', group: 'data.region', y: 'data.chars', agg: 'sum' }] }, ctx)
    expect(b.data.map((t) => t.name)).toEqual(['tools', 'life'])
    expect(b.data[0].y).toEqual([4200, 900])
    expect(b.data[1].y).toEqual([500, 4000])
    const c = buildPlot({ selector: { types: ['segment'] }, traces: [{ kind: 'area', x: 'meta.createdAt', bin: 'month', cumulative: true }] }, ctx)
    expect(c.data[0].y).toEqual([2, 4, 5])
    expect(c.data[0].fill).toBe('tozeroy')
  })

  it('scatters raw rows with continuous colour and size, and reports missing values', () => {
    const { ctx } = fixture()
    const b = buildPlot({ traces: [{ kind: 'scatter', x: 'data.n_messages', y: 'data.chars', color: 'degree', size: 'data.chars', text: 'label' }] }, ctx)
    // The topic has no n_messages/chars, so it is missing; the five segments plot.
    expect(b.stats.rows).toBe(6)
    expect(b.stats.missing).toBe(1)
    expect(b.data[0].x).toEqual([4, 8, 2, 3, 12])
    const marker = b.data[0].marker as { color: number[]; size: number[]; colorscale: unknown }
    expect(marker.color).toEqual([1, 1, 0, 0, 0])
    expect(marker.colorscale).toBeTruthy()
    expect(Math.max(...marker.size)).toBe(24)
    expect(b.data[0].text).toEqual(['s1', 's2', 's3', 's4', 's5'])
  })

  it('builds histograms, boxes, heatmaps and pies', () => {
    const { ctx } = fixture()
    const sel = { types: ['segment'] }
    expect(buildPlot({ selector: sel, traces: [{ kind: 'histogram', x: 'data.chars' }] }, ctx).data[0].type).toBe('histogram')
    const box = buildPlot({ selector: sel, traces: [{ kind: 'box', y: 'data.chars', group: 'data.region' }] }, ctx)
    expect(box.data.map((t) => t.name)).toEqual(['tools', 'life'])
    const heat = buildPlot({ selector: sel, traces: [{ kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.region' }] }, ctx)
    expect(heat.data[0].z).toEqual([
      [0, 1, 1],
      [2, 1, 0],
    ])
    const pie = buildPlot({ traces: [{ kind: 'pie' }] }, ctx)
    expect(pie.data[0].labels).toEqual(['segment', 'topic'])
    expect(pie.data[0].values).toEqual([5, 1])
  })

  it('describes specs and rejects impossible ones', () => {
    expect(describePlot({ traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month', group: 'data.region' }] })).toBe('bar · count by created per month · grouped by region')
    const { ctx } = fixture()
    expect(() => buildPlot({ traces: [{ kind: 'heatmap', x: 'meta.createdAt' }] }, ctx)).toThrow(/heatmap needs x and y/)
    expect(() => buildPlot({ traces: [{ kind: 'scatter', y: 'data.chars' }] }, ctx)).toThrow(/needs x/)
  })
})

describe('plot points know their entities', () => {
  it('carries ids as customdata for raw points, bins, cells and slices', () => {
    const { ctx } = fixture()
    const sel = { types: ['segment'] }
    const raw = buildPlot({ selector: sel, traces: [{ kind: 'scatter', x: 'data.n_messages', y: 'data.chars' }] }, ctx)
    expect(raw.data[0].customdata).toEqual([['s1'], ['s2'], ['s3'], ['s4'], ['s5']])
    const binned = buildPlot({ selector: sel, traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month' }] }, ctx)
    expect(binned.data[0].customdata).toEqual([['s1', 's2'], ['s3', 's4'], ['s5']])
    const heat = buildPlot({ selector: sel, traces: [{ kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.region' }] }, ctx)
    expect((heat.data[0].customdata as string[][][])[1][0]).toEqual(['s1', 's2'])
    const pie = buildPlot({ traces: [{ kind: 'pie' }] }, ctx)
    expect((pie.data[0].customdata as string[][])[0]).toHaveLength(5)
  })
})
