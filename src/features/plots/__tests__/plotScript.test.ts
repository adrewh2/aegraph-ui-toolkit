import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { buildPlot, type PlotSpec } from '../../../core/graph/plot'
import { outputsOf } from '../../../scripting/outputs'
import { Sandbox } from '../../../scripting/sandbox'
import { buildSnapshot } from '../../scripts/snapshot'
import { plotContextFor } from '../plotContext'
import { plotToScript, refExpr, selectorExpr } from '../plotScript'

describe('plot → script: the pieces', () => {
  it('reads value refs off a snapshot entity', () => {
    expect(refExpr('data.p99_latency_ms')).toBe('e.data.p99_latency_ms')
    expect(refExpr('data.odd key')).toBe('e.data["odd key"]')
    expect(refExpr('meta.createdAt')).toBe('e.createdAt')
    expect(refExpr('label')).toBe('(e.label ?? e.id)')
    expect(refExpr('metric.pagerank')).toBe('ds.metric("pagerank", e.id)')
    expect(refExpr('degree.in:wrote')).toBe('ds.in(e.id, "wrote").length')
  })

  it('turns a selector into the rows expression, noting what a script cannot do', () => {
    expect(selectorExpr({ types: ['service'], tags: ['tier:app'], scope: 'dataset' })).toEqual({ expr: 'ds.byType("service")\n  .filter((e) => ["tier:app"].some((t) => e.tags.includes(t)))', notes: [] })
    expect(selectorExpr({ types: ['service'], selection: true }).notes.length).toBe(2)
  })
})

/** A dataset with dates, numbers as numbers and as strings, categories, tags — everything the coercions care about. */
function fixture() {
  const store = new EntityStore()
  for (let i = 0; i < 120; i++) {
    const created = new Date(Date.UTC(2025, i % 12, 1 + (i % 27), i % 24)).toISOString()
    store.upsert(createEntity({ id: `e${i}`, type: i % 4 ? 'incident' : 'service', label: `E ${i}`, tags: i % 5 ? ['tier:app'] : ['tier:data'], data: { severity: `S${1 + (i % 3)}`, level: String(1 + (i % 3)), duration_min: 10 + (i % 50), env: i % 2 ? 'prod' : 'staging', started_at: created }, meta: { createdAt: created, updatedAt: created, source: 'test' } }))
  }
  const registry = new TypeRegistry(store)
  return { store, registry, ctx: plotContextFor(store, registry), snapshot: buildSnapshot(store, registry).snapshot }
}

/** What matters for "the same picture": the trace's shape and the pixels' inputs — x, y, z, names, colours, scales. */
const essence = (d: Record<string, unknown>) => {
  const marker = d.marker as Record<string, unknown> | undefined
  const line = d.line as Record<string, unknown> | undefined
  return { type: d.type, mode: d.mode, name: d.name, x: d.x, y: d.y, z: d.z, labels: d.labels, values: d.values, color: marker?.color, size: marker?.size, colorscale: (d.colorscale ?? marker?.colorscale) as unknown, lineColor: line?.color, fill: d.fill, opacity: d.opacity, hole: d.hole }
}

describe('plot → script draws the same picture as the plot tool', () => {
  const { ctx, snapshot } = fixture()
  const sb = new Sandbox()
  const same = async (spec: PlotSpec) => {
    const gui = buildPlot(spec, ctx)
    const code = plotToScript(spec)
    await sb.load('fixture', JSON.stringify(snapshot))
    const r = await sb.run(code)
    if (r.error) throw new Error(`${r.error.message}\n${code}`)
    const outs = outputsOf(r.value)
    expect(outs[0].kind).toBe('figure')
    if (outs[0].kind !== 'figure') return
    const script = outs[0].data as Record<string, unknown>[]
    expect(script.map(essence)).toEqual(gui.data.map(essence))
    expect(script.length).toBe(gui.data.length)
  }

  it('count per month, split into series (bars, stacked, in the tool’s colours)', () => same({ selector: { types: ['incident'], scope: 'dataset' }, traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month', group: 'data.env' }], layout: { title: 'Incidents' } }))
  it('mean per quarter as a running total line', () => same({ traces: [{ kind: 'line', x: 'data.started_at', bin: 'quarter', y: 'data.duration_min', agg: 'mean', cumulative: true }] }))
  it('a heatmap of month × a numeric-string category', () => same({ traces: [{ kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.level' }] }))
  it('a heatmap over two numeric bins', () => same({ traces: [{ kind: 'heatmap', x: 'data.duration_min', bin: 10, y: 'data.level', ybin: 1 }] }))
  it('a pie', () => same({ traces: [{ kind: 'pie', x: 'data.severity' }] }))
  it('boxes per category, split into series', () => same({ traces: [{ kind: 'box', y: 'data.duration_min', x: 'data.severity', group: 'data.env' }] }))
  it('histograms per series', () => same({ traces: [{ kind: 'histogram', x: 'data.duration_min', group: 'data.env' }] }))
  it('a scatter with a colour scale and sized markers', () => same({ traces: [{ kind: 'scatter', x: 'data.duration_min', y: 'data.level', color: 'data.duration_min', size: 'data.level', palette: 'plasma', text: 'label' }] }))
  it('two traces take the next colours in turn', () => same({ selector: { types: ['incident'], scope: 'dataset' }, traces: [{ kind: 'line', x: 'meta.createdAt', bin: 'month' }, { kind: 'area', x: 'meta.createdAt', bin: 'month', name: 'again', opacity: 0.5 }] }))
})
