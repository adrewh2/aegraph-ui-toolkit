import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { datasetGraph, datasetKeyOf } from '../dataset'
import { applyFilter, emptyFilter, filterComputedRefs, splitPredicates } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { describePipeline, renderingUsesMetrics, ruleUsesMetrics } from '../pipeline'
import { bboxOf, describePlacement, place, resolveRegion, transform } from '../placement'
import { buildProject, projectBreadcrumb, projectOverlay } from '../project'
import { DEFAULT_RENDERING, toRenderingSpec } from '../rendering'
import { describeSelector, resolveSelector } from '../selector'
import '../types'
import { DegreeIndex, describeValueRef, isCategoricalRef, isPlainRef, listValueRefs, makeValueContext, numericOf, parseValueRef, refUsesMetrics, valueOf } from '../values'

/** Documents d1..d3 citing each other, a person p, an unrelated note. */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'd1', type: 'document', label: 'One', tags: ['x'], data: { year: 2001 }, meta: { updatedAt: '2024-01-01T00:00:00.000Z' } }),
    createEntity({ id: 'd2', type: 'document', label: 'Two', data: { year: 2002 }, meta: { updatedAt: '2024-06-01T00:00:00.000Z' } }),
    createEntity({ id: 'd3', type: 'document', label: 'Three', data: { year: '2003' }, meta: { updatedAt: '2024-12-01T00:00:00.000Z' } }),
    createEntity({ id: 'p', type: 'person', label: 'Ada' }),
    createEntity({ id: 'n', type: 'note', label: 'Loose' }),
    createRelationship({ id: 'c1', type: 'cites', source: 'd2', target: 'd1', directed: true }),
    createRelationship({ id: 'c2', type: 'cites', source: 'd3', target: 'd1', directed: true }),
    createRelationship({ id: 'c3', type: 'cites', source: 'd3', target: 'd2', directed: true }),
    createRelationship({ id: 'r1', type: 'references', source: 'd1', target: 'p', directed: true }),
    createRelationship({ id: 'a1', type: 'authored', source: 'p', target: 'd1', directed: true }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'view', store: s, slice, selected: new Set(['d1']) })
  return { s, registry, slice, values }
}

describe('value refs', () => {
  it('parses the grammar', () => {
    expect(parseValueRef('data.year')).toEqual({ kind: 'data', key: 'year' })
    expect(parseValueRef('meta.updatedAt')).toEqual({ kind: 'meta', key: 'updatedAt' })
    expect(parseValueRef('meta.nope')).toBeUndefined()
    expect(parseValueRef('metric.pagerank')).toEqual({ kind: 'metric', id: 'pagerank' })
    expect(parseValueRef('metric.bogus')).toBeUndefined()
    expect(parseValueRef('degree')).toEqual({ kind: 'degree', dir: 'both', relType: undefined })
    expect(parseValueRef('degree.in:cites')).toEqual({ kind: 'degree', dir: 'in', relType: 'cites' })
    expect(parseValueRef('degree:a:b')).toEqual({ kind: 'degree', dir: 'both', relType: 'a:b' })
    expect(parseValueRef('selected')).toEqual({ kind: 'selected' })
    expect(parseValueRef('')).toBeUndefined()
    expect(isPlainRef('data.x')).toBe(true)
    expect(isPlainRef('degree')).toBe(false)
    expect(refUsesMetrics('metric.community')).toBe(true)
    expect(isCategoricalRef('metric.community')).toBe(true)
    expect(isCategoricalRef('metric.pagerank')).toBe(false)
    expect(describeValueRef('degree.in:cites')).toBe('in-degree via cites')
    expect(describeValueRef('meta.updatedAt')).toBe('last edited')
  })
  it('reads every kind of value, with typed degrees per scope', () => {
    const { s, slice, values } = fixture()
    const d1 = s.get('d1')!
    expect(valueOf(d1, 'data.year', values)).toBe(2001)
    expect(numericOf(s.get('d3')!, 'data.year', values)).toBe(2003)
    expect(valueOf(d1, 'meta.updatedAt', values)).toBe(Date.parse('2024-01-01T00:00:00.000Z'))
    expect(valueOf(d1, 'label', values)).toBe('One')
    expect(valueOf(d1, 'tags', values)).toBe('x')
    expect(valueOf(d1, 'degree', values)).toBe(4)
    expect(valueOf(d1, 'degree.in', values)).toBe(3)
    expect(valueOf(d1, 'degree.in:cites', values)).toBe(2)
    expect(valueOf(d1, 'degree.out:references', values)).toBe(1)
    expect(valueOf(d1, 'selected', values)).toBe(1)
    expect(valueOf(s.get('d2')!, 'selected', values)).toBe(0)
    expect(valueOf(d1, 'metric.pagerank', values)).toBeUndefined()
    const m = computeMetrics(serializeSlice(slice), { metrics: ['pagerank'] })
    const withMetrics = makeValueContext({ scope: 'view', store: s, slice, metrics: m })
    expect(typeof valueOf(d1, 'metric.pagerank', withMetrics)).toBe('number')
    // Dataset scope counts edges the view might hide.
    const narrow = applyFilter(s, new TypeRegistry(s), { ...emptyFilter(), types: ['document'] })
    const viewCtx = makeValueContext({ scope: 'view', store: s, slice: narrow })
    const dataCtx = makeValueContext({ scope: 'dataset', store: s, slice: narrow })
    expect(valueOf(d1, 'degree', viewCtx)).toBe(2)
    expect(valueOf(d1, 'degree', dataCtx)).toBe(4)
    const idx = new DegreeIndex(() => s.relationships())
    expect(idx.get('d1', 'in', 'cites')).toBe(2)
    expect(idx.table('in', 'cites')).toBe(idx.table('in', 'cites'))
    expect(valueOf(d1, 'data.pagerank', makeValueContext({ scope: 'view', slice, overlay: new Map([['d1', { pagerank: 0.5 }]]) }))).toBe(0.5)
  })
  it('lists refs for pickers', () => {
    const { values } = fixture()
    const refs = listValueRefs(values)
    expect(refs.find((r) => r.ref === 'data.year')?.kind).toBe('numeric')
    expect(refs.some((r) => r.ref === 'degree.in:cites')).toBe(true)
    expect(refs.find((r) => r.ref === 'metric.pagerank')?.available).toBe(false)
  })
})

describe('filters with computed refs and project members', () => {
  it('skips metric and stateful refs, evaluates structural refs with a context, restricts to members', () => {
    const { s, registry, values } = fixture()
    const fields = [
      { path: 'degree.in:cites', op: 'gte' as const, value: 2 },
      { path: 'metric.pagerank', op: 'gte' as const, value: 0.1 },
      { path: 'selected', op: 'eq' as const, value: 1 },
    ]
    const { usable, skipped } = splitPredicates(fields, { values })
    expect(usable.map((p) => p.path)).toEqual(['degree.in:cites'])
    expect(skipped.map((p) => p.path)).toEqual(['metric.pagerank', 'selected'])
    expect(splitPredicates(fields).usable).toEqual([])
    expect(filterComputedRefs({ fields })).toEqual({ metrics: ['pagerank'], structural: true })
    const r = applyFilter(s, registry, { ...emptyFilter(), fields }, { values })
    expect(r.nodes.map((n) => n.id)).toEqual(['d1'])
    expect(r.skipped?.length).toBe(2)
    const proj = applyFilter(s, registry, emptyFilter(), { members: new Set(['d1', 'd2', 'c1', 'r1']) })
    expect(proj.nodes.map((n) => n.id).sort()).toEqual(['d1', 'd2'])
    expect(proj.edges.map((e) => e.id)).toEqual(['c1'])
  })
})

describe('selector', () => {
  it('selects by type, fields, selection, roots, scope, sort and limit', () => {
    const { s, registry, slice, values } = fixture()
    const ctx = { store: s, registry, slice, values, selected: new Set(['d1', 'p']) }
    expect(resolveSelector({ types: ['document'] }, ctx).nodes.map((n) => n.id)).toEqual(['d1', 'd2', 'd3'])
    expect(resolveSelector({ selection: true, types: ['person'] }, ctx).nodes.map((n) => n.id)).toEqual(['p'])
    expect(resolveSelector({ fields: [{ path: 'degree.in:cites', op: 'gt', value: 0 }] }, ctx).nodes.map((n) => n.id).sort()).toEqual(['d1', 'd2'])
    expect(resolveSelector({ types: ['document'], sort: 'meta.updatedAt', desc: true, limit: 2 }, ctx).nodes.map((n) => n.id)).toEqual(['d3', 'd2'])
    expect(resolveSelector({ types: ['document'], sort: 'data.year' }, ctx).nodes.map((n) => n.id)).toEqual(['d1', 'd2', 'd3'])
    expect(resolveSelector({ roots: ['p'], depth: 1 }, ctx).nodes.map((n) => n.id).sort()).toEqual(['d1', 'p'])
    expect(resolveSelector({ text: 'ada' }, ctx).nodes.map((n) => n.id)).toEqual(['p'])
    const narrow = applyFilter(s, registry, { ...emptyFilter(), types: ['person'] })
    const nctx = { ...ctx, slice: narrow }
    const inView = resolveSelector({ types: ['document'] }, nctx)
    expect(inView.nodes).toEqual([])
    expect(inView.outsideView).toBe(3)
    expect(resolveSelector({ types: ['document'], scope: 'dataset' }, nctx).total).toBe(3)
    expect(resolveSelector({ fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }] }, ctx).skipped).toHaveLength(1)
    expect(describeSelector({ types: ['document'], sort: 'data.year', limit: 5 })).toBe('document · by data.year · top 5')
  })
})

describe('placement', () => {
  const frame = { viewport: { minX: 0, minY: 0, maxX: 1000, maxY: 500 }, bbox: { minX: -100, minY: -100, maxX: 100, maxY: 100 } }
  it('resolves regions with anchors, fractions and margins (y up)', () => {
    expect(resolveRegion({ of: 'viewport', anchor: 'top-left', size: { fraction: 0.5 } }, frame)).toEqual({ minX: 0, minY: 250, maxX: 500, maxY: 500 })
    expect(resolveRegion({ of: 'viewport', anchor: 'bottom-right', size: { w: 100, h: 50 } }, frame)).toEqual({ minX: 900, minY: 0, maxX: 1000, maxY: 50 })
    expect(resolveRegion({ of: 'viewport', anchor: 'center', size: { fraction: 0.5 } }, frame)).toEqual({ minX: 250, minY: 125, maxX: 750, maxY: 375 })
    expect(resolveRegion({ of: 'bbox', margin: 10 }, frame)).toEqual({ minX: -90, minY: -90, maxX: 90, maxY: 90 })
    expect(resolveRegion({ of: 'rect', rect: { minX: 1, minY: 2, maxX: 3, maxY: 4 } }, frame)).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 })
  })
  it('arranges grids, binned scatters, circles, lines and stacks', () => {
    const { s, values } = fixture()
    const docs = ['d1', 'd2', 'd3'].map((id) => s.get(id)!)
    const grid = place(docs, { arrangement: 'grid', cols: 2, region: { of: 'viewport', anchor: 'top-left', size: { w: 200, h: 200 } } }, values, frame)
    expect(grid.positions.d1).toEqual({ x: 50, y: 450 })
    expect(grid.positions.d3).toEqual({ x: 50, y: 350 })
    const heat = place(docs, { arrangement: 'scatter', x: 'degree.in:cites', y: 'data.year', bins: { x: 3, y: 3 }, region: { of: 'viewport' } }, values, frame)
    expect(heat.cells?.length).toBe(9)
    expect(heat.cells!.reduce((a, c) => a + c.count, 0)).toBe(3)
    // d1: 2 citations (max → last column), year 2001 (min → first row).
    const d1cell = heat.cells!.find((c) => c.count && heat.positions.d1.x >= c.rect.minX && heat.positions.d1.x <= c.rect.maxX && heat.positions.d1.y >= c.rect.minY && heat.positions.d1.y <= c.rect.maxY)
    expect(d1cell).toMatchObject({ x: 2, y: 0 })
    expect(heat.axes.x?.kind).toBe('binned')
    expect(heat.axes.x?.ticks.length).toBe(4)
    const same = place(docs, { arrangement: 'scatter', x: 'type', bins: { x: 2 }, region: { of: 'viewport' } }, values, frame)
    expect(same.unplaced).toEqual(['d1', 'd2', 'd3']) // non-numeric axis → parked
    const sc = place(docs, { arrangement: 'scatter', x: 'data.year', y: 'meta.updatedAt', scale: 'rank', region: { of: 'rect', rect: { minX: 0, minY: 0, maxX: 100, maxY: 100 } } }, values, frame)
    expect(sc.positions.d1).toEqual({ x: 0, y: 0 })
    expect(sc.positions.d3).toEqual({ x: 100, y: 100 })
    const circle = place(docs, { arrangement: 'circle', order: 'data.year', region: { of: 'rect', rect: { minX: -10, minY: -10, maxX: 10, maxY: 10 } } }, values, frame)
    expect(Math.hypot(circle.positions.d2.x, circle.positions.d2.y)).toBeCloseTo(10)
    const line = place(docs, { arrangement: 'line', x: 'data.year', region: { of: 'rect', rect: { minX: 0, minY: 0, maxX: 100, maxY: 100 } } }, values, frame)
    expect(line.positions.d1.y).toBe(50)
    expect(line.positions.d2.x).toBe(50)
    const all = ['d1', 'd2', 'd3', 'p', 'n'].map((id) => s.get(id)!)
    const stack = place(all, { arrangement: 'stack', x: 'type', region: { of: 'viewport' } }, values, frame)
    expect(stack.axes.x?.categories).toEqual(['document', 'note', 'person'])
    expect(stack.cells?.map((c) => c.count)).toEqual([3, 1, 1])
    expect(stack.positions.d2.x).toBeGreaterThan(stack.positions.d1.x)
    expect(stack.positions.d2.y).toBe(stack.positions.d1.y)
    expect(place(docs, { arrangement: 'grid', region: { of: 'viewport' } }, values, frame)).toEqual(place(docs, { arrangement: 'grid', region: { of: 'viewport' } }, values, frame))
    expect(describePlacement({ arrangement: 'scatter', x: 'degree.in:cites', y: 'data.year', bins: { x: 8, y: 8 }, region: { of: 'viewport', anchor: 'top-left' } })).toBe('scatter · in-degree via cites × year · 8×8 bins · top-left of viewport')
  })
  it('transforms groups', () => {
    const pos = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 5 } }
    expect(transform(['a', 'b'], pos, { translate: { dx: 5, dy: -5 } })).toEqual({ a: { x: 5, y: -5 }, b: { x: 15, y: -5 } })
    expect(transform(['a', 'b'], pos, { scale: 2 })).toEqual({ a: { x: -5, y: 0 }, b: { x: 15, y: 0 } })
    const rot = transform(['a', 'b'], pos, { rotate: 90, about: 'origin' })
    expect(rot.b.x).toBeCloseTo(0)
    expect(rot.b.y).toBeCloseTo(10)
    expect(transform(['a', 'b', 'c'], pos, { align: 'left', to: { minX: 100, minY: 0, maxX: 200, maxY: 10 } }).a.x).toBe(100)
    const dist = transform(['a', 'b', 'c'], { a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, c: { x: 30, y: 0 } }, { distribute: 'x' })
    expect(dist.b.x).toBe(15)
    expect(bboxOf(['a', 'c'], pos)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 5 })
  })
})

describe('projects and the pipeline', () => {
  it('exports members and values, overlays them, and describes the stages', () => {
    const { s, registry, slice } = fixture()
    const m = computeMetrics(serializeSlice(slice), { metrics: ['pagerank', 'community'] })
    const p = buildProject('Ranked', slice, m, { filterId: 'f' })
    s.upsert(p)
    expect(p.data.members).toHaveLength(10)
    expect(p.data.summary).toMatchObject({ nodes: 5, edges: 5, metrics: ['pagerank', 'community'] })
    const overlay = projectOverlay(p)!
    expect(typeof overlay.get('d1')?.pagerank).toBe('number')
    const child = buildProject('Child', { nodes: slice.nodes.slice(0, 2), edges: [] }, undefined, { parentProjectId: p.id })
    s.upsert(child)
    expect(projectBreadcrumb(s, child.id).map((b) => b.label)).toEqual(['Library', 'Ranked', 'Child'])
    expect(datasetKeyOf(datasetGraph(s, registry))).toBe(datasetKeyOf({ nodes: [...datasetGraph(s, registry).nodes].reverse(), edges: datasetGraph(s, registry).edges }))
    const pipeline = describePipeline({
      dataset: { source: 'workspace', label: 'Workspace', nodes: 5, edges: 5, breadcrumb: ['Workspace'] },
      filter: { ...emptyFilter(), fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }] },
      view: { nodes: 5, edges: 5 },
      layout: { algorithm: 'force', positions: 5, dirty: false, rule: { kind: 'placement', selector: {}, spec: { arrangement: 'scatter', x: 'metric.pagerank', region: { of: 'viewport' } } } },
      rendering: toRenderingSpec({ nodes: { default: { color: { mode: 'partition', attr: { kind: 'value', ref: 'metric.community' }, palette: 'tableau10' } } } }),
      analysis: { metrics: m, stale: true, running: false, auto: false },
    })
    expect(pipeline.order).toEqual(['dataset', 'filter', 'layout', 'style', 'analysis', 'export'])
    expect(pipeline.feedback).toBe(true)
    expect(pipeline.stages.find((st) => st.id === 'filter')?.notes[0]).toContain('Export the view as a project')
    expect(pipeline.stages.find((st) => st.id === 'layout')).toMatchObject({ usesMetrics: true, stale: true })
    expect(renderingUsesMetrics(DEFAULT_RENDERING)).toBe(false)
    expect(ruleUsesMetrics(undefined)).toBe(false)
  })
})
