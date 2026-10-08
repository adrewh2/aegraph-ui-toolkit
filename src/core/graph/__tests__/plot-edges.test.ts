import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { buildPlot, floorTime, temporalMs, type PlotSpec } from '../plot'
import { resolveSelector } from '../selector'
import { makeValueContext } from '../values'
import '../types'

/**
 * The chart builder's edges: every time unit's floor, timestamps in
 * seconds and milliseconds and month strings, every aggregate over a
 * bucket with blanks, numeric bins, groups with a blank group, a trace
 * with its own selector, several traces sharing an axis, categorical
 * x sorted, cumulative runs, and what the stats count.
 */
function fixture() {
  const s = new EntityStore()
  const T = (d: string) => `2026-03-${d}`
  s.upsertMany([
    createEntity({ id: 'a', type: 'incident', label: 'A', data: { startedAt: `${T('02')}T10:15:00Z`, severity: 'S1', minutes: 30, team: 'core' } }),
    createEntity({ id: 'b', type: 'incident', label: 'B', data: { startedAt: `${T('02')}T18:00:00Z`, severity: 'S2', minutes: 10, team: 'core' } }),
    createEntity({ id: 'c', type: 'incident', label: 'C', data: { startedAt: `${T('09')}T09:00:00Z`, severity: 'S1', minutes: 50, team: 'edge' } }),
    createEntity({ id: 'd', type: 'incident', label: 'D', data: { startedAt: `${T('31')}T23:59:00Z`, severity: 'S3', minutes: 'not a number' } }),
    createEntity({ id: 'e', type: 'incident', label: 'E', data: { severity: 'S2', minutes: 20 } }),
    createEntity({ id: 'n', type: 'note', label: 'N', data: { minutes: 5 } }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'dataset', store: s, slice })
  const ctx = { values, resolve: (sel: Parameters<typeof resolveSelector>[0]) => resolveSelector({ ...sel, scope: 'dataset' }, { store: s, registry, slice, values }).nodes }
  return { s, ctx }
}
const build = (spec: PlotSpec, ctx: ReturnType<typeof fixture>['ctx']) => buildPlot(spec, ctx)

describe('plot edges', () => {
  it('floors to every unit in UTC and reads timestamps in seconds, milliseconds and year-month strings', () => {
    const t = Date.UTC(2026, 2, 4, 15, 42, 7) // Wednesday 4 March 2026
    expect(floorTime(t, 'hour')).toBe(Date.UTC(2026, 2, 4, 15))
    expect(floorTime(t, 'day')).toBe(Date.UTC(2026, 2, 4))
    expect(floorTime(t, 'week')).toBe(Date.UTC(2026, 2, 2)) // the Monday
    expect(floorTime(Date.UTC(2026, 2, 2), 'week')).toBe(Date.UTC(2026, 2, 2)) // a Monday is its own week
    expect(floorTime(Date.UTC(2026, 2, 1), 'week')).toBe(Date.UTC(2026, 1, 23)) // a Sunday belongs to the week before
    expect(floorTime(t, 'month')).toBe(Date.UTC(2026, 2, 1))
    expect(floorTime(Date.UTC(2026, 4, 9), 'quarter')).toBe(Date.UTC(2026, 3, 1))
    expect(floorTime(t, 'year')).toBe(Date.UTC(2026, 0, 1))
    expect(temporalMs('2026-03')).toBe(Date.UTC(2026, 2, 1))
    expect(temporalMs('2026-03-04')).toBe(Date.UTC(2026, 2, 4))
    expect(temporalMs(1_700_000_000)).toBe(1_700_000_000_000) // seconds
    expect(temporalMs(1_700_000_000_000)).toBe(1_700_000_000_000) // milliseconds
    expect(temporalMs(42)).toBeUndefined() // too small to be a time
    expect(temporalMs('March')).toBeUndefined()
  })

  it('bins a date axis by the unit asked, counts per bucket in order, and reports the rows without a date as missing', () => {
    const { ctx } = fixture()
    const byWeek = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'week' }] }, ctx)
    expect(byWeek.stats).toEqual({ rows: 5, traces: 1, missing: 1 })
    expect(byWeek.data[0].x).toEqual(['2026-03-02T00:00:00.000Z', '2026-03-09T00:00:00.000Z', '2026-03-30T00:00:00.000Z'])
    expect(byWeek.data[0].y).toEqual([2, 1, 1])
    expect(byWeek.data[0].customdata).toEqual([['a', 'b'], ['c'], ['d']])
    expect(byWeek.layout.xaxis).toMatchObject({ type: 'date' })
    const byDay = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'day', cumulative: true }] }, ctx)
    expect(byDay.data[0].y).toEqual([2, 3, 4])
    expect((byDay.layout.yaxis as { title: { text: string } }).title.text).toBe('cumulative count')
  })

  it('aggregates y per bucket every way, dropping rows whose y is not a number', () => {
    const { ctx } = fixture()
    const agg = (a: 'sum' | 'mean' | 'median' | 'min' | 'max' | 'distinct') => build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.severity', y: 'data.minutes', agg: a }] }, ctx)
    // S1: 30 and 50; S2: 10 and 20; S3: only a non-number, so the bucket never forms.
    expect(agg('sum').data[0].x).toEqual(['S1', 'S2'])
    expect(agg('sum').data[0].y).toEqual([80, 30])
    expect(agg('mean').data[0].y).toEqual([40, 15])
    expect(agg('median').data[0].y).toEqual([40, 15])
    expect(agg('min').data[0].y).toEqual([30, 10])
    expect(agg('max').data[0].y).toEqual([50, 20])
    expect(agg('distinct').data[0].y).toEqual([2, 2])
    expect(agg('sum').stats.missing).toBe(1)
    expect((agg('mean').layout.yaxis as { title: { text: string } }).title.text).toBe('mean of minutes')
    // A count needs no y and keeps every row with an x.
    const count = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.severity' }] }, ctx)
    expect(count.data[0].x).toEqual(['S1', 'S2', 'S3'])
    expect(count.data[0].y).toEqual([2, 2, 1])
    expect(count.stats.missing).toBe(0)
  })

  it('bins numbers by a width and leaves a unit bin on a number alone', () => {
    const { ctx } = fixture()
    const width = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.minutes', bin: 25 }] }, ctx)
    expect(width.data[0].x).toEqual([0, 25, 50])
    expect(width.data[0].y).toEqual([2, 1, 1]) // 10 and 20 · 30 · 50; the non-number is missing
    expect(width.stats.missing).toBe(1)
    const unit = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.minutes', bin: 'month' }] }, ctx)
    expect(unit.data[0].x).toEqual([10, 20, 30, 50, 'not a number']) // a word on a count axis is its own category
    expect(unit.layout.xaxis).not.toMatchObject({ type: 'date' })
  })

  it('splits into one trace per group with a blank group named, names traces, and lets a trace bring its own selector', () => {
    const { ctx } = fixture()
    const grouped = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.severity', group: 'data.team' }] }, ctx)
    expect(grouped.data.map((d) => d.name)).toEqual(['core', '(none)', 'edge'])
    expect(grouped.stats.traces).toBe(3)
    expect(grouped.layout.barmode).toBe('stack')
    expect(grouped.layout.showlegend).toBe(true)
    const named = build({ selector: { types: ['incident'] }, traces: [{ kind: 'bar', name: 'Incidents', x: 'data.severity', group: 'data.team' }] }, ctx)
    expect(named.data[0].name).toBe('Incidents · core')
    const own = build({ traces: [{ kind: 'bar', name: 'incidents', x: 'data.severity', selector: { types: ['incident'] } }, { kind: 'bar', name: 'everything', x: 'type' }] }, ctx)
    expect(own.data[0].y).toEqual([2, 2, 1])
    expect(own.data[1].x).toEqual(['incident', 'note'])
    expect(own.stats.rows).toBe(11) // 5 + 6
    // No selector anywhere: the whole dataset.
    expect(build({ traces: [{ kind: 'bar', x: 'type' }] }, ctx).data[0].y).toEqual([5, 1])
  })

  it('scatters raw rows binned or not, dates on y too, and counts a row missing either value once', () => {
    const { ctx } = fixture()
    const raw = build({ selector: { types: ['incident'] }, traces: [{ kind: 'scatter', x: 'data.minutes', y: 'data.startedAt' }] }, ctx)
    // e has no date and is missing; d's minutes are a word, which a raw scatter still plots as a category (the axis cannot know).
    expect(raw.stats).toEqual({ rows: 5, traces: 1, missing: 1 })
    expect(raw.data[0].x).toEqual([30, 10, 50, 'not a number'])
    expect(raw.layout.yaxis).toMatchObject({ type: 'date' })
    expect(raw.data[0].text).toEqual(['A', 'B', 'C', 'D'])
    // Asked for numeric bins, the word has no bin and is missing.
    const rawBinned = build({ selector: { types: ['incident'] }, traces: [{ kind: 'scatter', x: 'data.minutes', y: 'data.startedAt', bin: 25 }] }, ctx)
    expect(rawBinned.stats.missing).toBe(2)
    expect(rawBinned.data[0].x).toEqual([25, 0, 50])
    const binned = build({ selector: { types: ['incident'] }, traces: [{ kind: 'line', x: 'data.startedAt', y: 'data.minutes', bin: 'month' }] }, ctx)
    expect(new Set(binned.data[0].x as string[]).size).toBe(1) // every point snaps to March
    expect(binned.data[0].mode).toBe('lines')
    const area = build({ selector: { types: ['incident'] }, traces: [{ kind: 'area', x: 'data.startedAt', bin: 'day' }] }, ctx)
    expect(area.data[0]).toMatchObject({ type: 'scatter', fill: 'tozeroy' })
  })

  it('refuses a trace that cannot be drawn', () => {
    const { ctx } = fixture()
    expect(() => build({ traces: [{ kind: 'bar' }] }, ctx)).toThrow(/needs x/)
    expect(() => build({ traces: [{ kind: 'heatmap', x: 'data.minutes' }] }, ctx)).toThrow(/needs x and y/)
    expect(() => build({ traces: [{ kind: 'box' }] }, ctx)).toThrow(/needs y/)
    expect(() => build({ traces: [{ kind: 'scatter', x: 'data.minutes', agg: 'sum' }] }, ctx)).not.toThrow() // sum with no y: every row missing, nothing drawn
    expect(build({ traces: [{ kind: 'scatter', x: 'data.minutes', agg: 'sum' }] }, ctx).data[0].x).toEqual([])
  })
})
