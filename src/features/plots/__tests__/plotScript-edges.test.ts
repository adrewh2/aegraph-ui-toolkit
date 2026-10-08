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

/**
 * The chart script writer at its edges: a spec with no traces, every kind
 * in one spec sharing the colour sequence, a bin by width against one by
 * unit (on dates and on numbers, and a width on a category), a group with
 * more than 24 series, an x field nobody has, a selector by ids, a layout
 * with a title only, and titles and field names with quotes, newlines and
 * comment closers — every one run in the sandbox and held to buildPlot.
 */
function fixture() {
  const store = new EntityStore()
  for (let i = 0; i < 90; i++) {
    const created = new Date(Date.UTC(2025, i % 12, 1 + (i % 27), i % 24)).toISOString()
    store.upsert(createEntity({ id: `e${i}`, type: i % 3 ? 'incident' : 'service', label: `E ${i}`, tags: i % 5 ? ['tier:app'] : ['tier:data'], data: { severity: `S${1 + (i % 3)}`, duration_min: 10 + (i % 50), env: i % 2 ? 'prod' : 'staging', team: `team-${i % 30}`, 'odd "key"': i % 7, 'two\nlines': i % 4, started_at: created }, meta: { createdAt: created, updatedAt: created, source: 'test' } }))
  }
  const registry = new TypeRegistry(store)
  return { store, registry, ctx: plotContextFor(store, registry), snapshot: buildSnapshot(store, registry).snapshot }
}

const essence = (d: Record<string, unknown>) => {
  const marker = d.marker as Record<string, unknown> | undefined
  const line = d.line as Record<string, unknown> | undefined
  return { type: d.type, mode: d.mode, name: d.name, x: d.x, y: d.y, z: d.z, labels: d.labels, values: d.values, color: marker?.color, size: marker?.size, colorscale: (d.colorscale ?? marker?.colorscale) as unknown, lineColor: line?.color, fill: d.fill, opacity: d.opacity, hole: d.hole }
}

describe('plot → script edges', () => {
  const { ctx, snapshot } = fixture()
  const sb = new Sandbox()
  const run = async (spec: PlotSpec, opts?: Parameters<typeof plotToScript>[1]) => {
    const code = plotToScript(spec, opts)
    await sb.load('fixture', JSON.stringify(snapshot))
    const r = await sb.run(code)
    if (r.error) throw new Error(`${r.error.message}\n${code}`)
    const outs = outputsOf(r.value)
    expect(outs[0]?.kind).toBe('figure')
    if (outs[0]?.kind !== 'figure') throw new Error('no figure')
    return { code, data: outs[0].data as Record<string, unknown>[], layout: outs[0].layout }
  }
  const same = async (spec: PlotSpec) => {
    const gui = buildPlot(spec, ctx)
    const s = await run(spec)
    expect(s.data.map(essence)).toEqual(gui.data.map(essence))
    return s
  }

  it('a spec with no traces is a script that runs and returns an empty figure — which the output layer refuses, as it would any', async () => {
    const code = plotToScript({ traces: [], layout: { title: 'Nothing yet' } })
    expect(code).toContain('return figure(traces, {\n  "title": "Nothing yet"\n})')
    await sb.load('fixture', JSON.stringify(snapshot))
    const r = await sb.run(code)
    expect(r.error).toBeUndefined()
    expect(r.value).toEqual({ plot: { data: [], layout: { title: 'Nothing yet' } } })
    expect(() => outputsOf(r.value)).toThrow(/non-empty/)
    expect(buildPlot({ traces: [] }, ctx).data).toEqual([])
  })

  it('every kind in one spec takes the colour sequence in the same order as the tool', async () => {
    const s = await same({
      selector: { types: ['incident'], scope: 'dataset' },
      traces: [
        { kind: 'pie', x: 'data.env' },
        { kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.severity' },
        { kind: 'histogram', x: 'data.duration_min' },
        { kind: 'box', y: 'data.duration_min', x: 'data.env' },
        { kind: 'bar', x: 'data.severity' },
        { kind: 'line', x: 'meta.createdAt', bin: 'week', y: 'data.duration_min', agg: 'max' },
        { kind: 'area', x: 'meta.createdAt', bin: 'quarter', y: 'data.duration_min', agg: 'sum', cumulative: true },
        { kind: 'scatter', x: 'data.duration_min', y: 'data.odd "key"', group: 'data.env' },
      ],
    })
    expect(s.data.map((d) => d.type)).toEqual(['pie', 'heatmap', 'histogram', 'box', 'bar', 'scatter', 'scatter', 'scatter', 'scatter'])
    // The pie and the heatmap take no series colour; histogram, box, bar, line, area, then the two scatter series do.
    const colours = s.data.map((d) => (d.marker as { color?: unknown } | undefined)?.color).filter((c) => typeof c === 'string')
    expect(new Set(colours).size).toBe(7)
  })

  it('bins by width and by unit on dates, on numbers, and a width on a category', async () => {
    await same({ traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 7 * 86_400_000 }] }) // a width on a date: 7-day buckets
    await same({ traces: [{ kind: 'bar', x: 'data.duration_min', bin: 'month' }] }) // a unit on a number: no binning
    await same({ traces: [{ kind: 'bar', x: 'data.duration_min', bin: 15 }] })
    await same({ traces: [{ kind: 'bar', x: 'data.severity', bin: 10 }] }) // a width on a category: nothing to bin — both drop the rows
    await same({ traces: [{ kind: 'heatmap', x: 'data.severity', bin: 10, y: 'data.duration_min', ybin: 20 }] })
  })

  it('folds a group with more than 24 series into 23 plus “other”, largest first', async () => {
    const s = await same({ traces: [{ kind: 'bar', x: 'data.severity', group: 'data.team' }] })
    expect(s.data.length).toBe(24)
    expect(s.data[23].name).toBe('other')
    expect(s.data.slice(0, 23).every((d) => String(d.name).startsWith('team-'))).toBe(true)
  })

  it('an x field nobody has draws nothing in both — and a y nobody has either', async () => {
    const s = await same({ traces: [{ kind: 'bar', x: 'data.nope' }, { kind: 'scatter', x: 'data.duration_min', y: 'data.nope' }, { kind: 'histogram', x: 'data.nope' }] })
    expect(s.data.map((d) => (d.x as unknown[]).length)).toEqual([0, 0, 0])
  })

  it('a selector by ids picks just those, whatever the types say, and a trace selector overrides the spec’s', async () => {
    expect(selectorExpr({ ids: ['e1', 'e2'], types: ['service'] })).toEqual({ expr: 'ds.entities.filter((e) => ["e1","e2"].includes(e.id))', notes: [] })
    const s = await same({ selector: { ids: ['e1', 'e2', 'e3'] }, traces: [{ kind: 'bar', x: 'data.env' }, { kind: 'bar', x: 'data.env', selector: { ids: ['e0'], scope: 'dataset' } }] })
    expect(s.data[0].y).toEqual([2, 1])
    expect(s.data[1].y).toEqual([1])
    expect(s.code).toContain('const rows2 = ')
  })

  it('a layout with a title only still names the axes after the first trace; a label stands in when there is no title', async () => {
    const s = await run({ traces: [{ kind: 'scatter', x: 'data.duration_min', y: 'data.odd "key"' }], layout: { title: 'Only a title' } })
    expect(s.layout).toEqual({ title: 'Only a title', xaxis: { title: 'duration_min' }, yaxis: { title: 'odd "key"' } })
    expect(plotToScript({ traces: [] }, { label: 'From the label', date: new Date('2026-09-18T12:00:00Z') })).toMatch(/^\/\/ From the label\n\/\/ Exported from Charts on 2026-09-18/)
    expect(plotToScript({ traces: [] })).toMatch(/^\/\/ Chart\n/)
  })

  it('field names with quotes and newlines reach the sandbox intact', async () => {
    expect(refExpr('data.odd "key"')).toBe('e.data["odd \\"key\\""]')
    expect(refExpr('data.two\nlines')).toBe('e.data["two\\nlines"]')
    await same({ traces: [{ kind: 'bar', x: 'data.odd "key"', y: 'data.two\nlines', agg: 'mean' }] })
    await same({ traces: [{ kind: 'scatter', x: 'data.two\nlines', y: 'data.duration_min', group: 'data.odd "key"', text: 'data.two\nlines' }] })
  })

  it('a title with a newline or a comment closer cannot break out of its comment', async () => {
    const s = await run({ traces: [{ kind: 'bar', x: 'data.env' }], layout: { title: 'Line one\nreturn 42 // */ */' } })
    expect(s.data.length).toBe(1)
    expect((s.layout as { title: string }).title).toBe('Line one\nreturn 42 // */ */')
    expect(plotToScript({ traces: [] }, { label: 'a\nb' })).not.toMatch(/^b$/m)
  })
})
