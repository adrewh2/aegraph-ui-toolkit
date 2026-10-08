import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry, schemaTypeEntity } from '../../entity/typeRegistry'
import { hashColor } from '../../../lib/format'
import { applyFilter, emptyFilter } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { MISSING_COLOR } from '../palettes'
import { DEFAULT_RENDERING, edgeAttrValue, legendFor, nodeAttrValue, resolveEdgeStyle, resolveNodeStyle, styleContext, type NodeShape, type RenderingSpec } from '../rendering'
import { makeValueContext } from '../values'
import '../types'

/**
 * The style spec's edges: the colour precedence chain (channel, the
 * entity's own colour, the type's, a hash), rankings with explicit and
 * reversed ranges, log and clamped domains, blanks at the minimum and in
 * the missing colour, partitions with named colours and shapes, overflow
 * past the legend's room, degree by direction, nested field keys, metric
 * attrs with and without a run, value attrs, several tag rules on one
 * node under either precedence, and edge channels.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', tags: ['hot', 'old'], data: { year: 2001, weight: 1, nested: { deep: 7 }, color: '#abcdef' } }),
    createEntity({ id: 'b', type: 'paper', tags: ['old'], data: { year: 2010, weight: 100 } }),
    createEntity({ id: 'c', type: 'paper', tags: [], data: { year: 2020 } }),
    createEntity({ id: 'd', type: 'note', tags: ['hot'], data: { weight: 10 } }),
    createEntity({ id: 'e', type: 'note', data: { color: 'not a colour' } }),
    schemaTypeEntity('paper', { color: '#112233' }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b', directed: true, data: { strength: 2 } }),
    createRelationship({ id: 'cb', type: 'cites', source: 'c', target: 'b', directed: true, data: { strength: 4 }, tags: ['weak'] }),
    createRelationship({ id: 'ad', type: 'mentions', source: 'a', target: 'd', directed: false }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'view', store: s, slice })
  const spec = (patch: (r: RenderingSpec) => void): RenderingSpec => {
    const r = structuredClone(DEFAULT_RENDERING)
    patch(r)
    return r
  }
  const ctxFor = (r: RenderingSpec, extras: Parameters<typeof styleContext>[4] = {}) => styleContext(registry, slice.nodes, slice.degree, r, { edges: slice.edges, values, ...extras })
  const node = (id: string) => s.get(id)!
  const edge = (id: string) => slice.edges.find((e) => e.id === id)!
  return { s, registry, slice, values, spec, ctxFor, node, edge }
}

describe('rendering edges', () => {
  it('colours by the channel, else the entity’s own colour, else the type’s, else a hash', () => {
    const { spec, ctxFor, node } = fixture()
    const plain = spec((r) => (r.nodes.default.color = { mode: 'constant' }))
    const ctx = ctxFor(plain)
    expect(resolveNodeStyle(node('a'), plain, ctx).color).toBe('#abcdef') // its own data.color
    expect(resolveNodeStyle(node('b'), plain, ctx).color).toBe('#112233') // the type's
    expect(resolveNodeStyle(node('e'), plain, ctx).color).toBe(hashColor('note')) // an invalid own colour is ignored
    const fixed = spec((r) => (r.nodes.default.color = { mode: 'constant', value: '#ff0000' }))
    expect(resolveNodeStyle(node('a'), fixed, ctxFor(fixed)).color).toBe('#ff0000')
  })

  it('ranks with an explicit or reversed range, a log or clamped domain, and puts blanks at the minimum', () => {
    const { spec, ctxFor, node, slice } = fixture()
    const size = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 2, max: 12 }))
    let ctx = ctxFor(size)
    expect(resolveNodeStyle(node('a'), size, ctx).size).toBe(2)
    expect(resolveNodeStyle(node('b'), size, ctx).size).toBe(12)
    expect(resolveNodeStyle(node('c'), size, ctx).size).toBe(2) // no weight: the minimum
    const reversed = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 12, max: 2 }))
    ctx = ctxFor(reversed)
    expect(resolveNodeStyle(node('a'), reversed, ctx).size).toBe(12)
    expect(resolveNodeStyle(node('b'), reversed, ctx).size).toBe(2)
    const log = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 0, max: 100, log: true }))
    ctx = ctxFor(log)
    expect(resolveNodeStyle(node('d'), log, ctx).size).toBeCloseTo(50) // 10 sits halfway between 1 and 100 on a log scale
    const clamped = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 0, max: 10, domain: [0, 10] }))
    ctx = ctxFor(clamped)
    expect(resolveNodeStyle(node('b'), clamped, ctx).size).toBe(10) // 100 past the domain: clamped to the top
    expect(resolveNodeStyle(node('a'), clamped, ctx).size).toBe(1)
    // A colour ranking: a blank wears the missing colour, not the low end.
    const col = spec((r) => (r.nodes.default.color = { mode: 'ranking', attr: { kind: 'field', key: 'weight' }, palette: 'viridis' }))
    ctx = ctxFor(col)
    expect(resolveNodeStyle(node('c'), col, ctx).color).toBe(MISSING_COLOR)
    expect(resolveNodeStyle(node('a'), col, ctx).color).not.toBe(resolveNodeStyle(node('b'), col, ctx).color)
    expect(legendFor(col, ctx, slice.nodes)).toMatchObject({ kind: 'gradient', domain: [1, 100], log: false })
  })

  it('partitions with named colours and shapes, cycles the palette past the legend’s room, and greys a blank', () => {
    const { spec, ctxFor, node, slice } = fixture()
    const part = spec((r) => {
      r.nodes.default.color = { mode: 'partition', attr: { kind: 'field', key: 'year' }, palette: 'tableau10', colors: { '2001': '#00ff00' } }
      r.nodes.default.shape = { mode: 'partition', attr: { kind: 'type' }, shapes: { note: 'diamond' } }
    })
    const ctx = ctxFor(part)
    expect(resolveNodeStyle(node('a'), part, ctx).color).toBe('#00ff00')
    expect(resolveNodeStyle(node('b'), part, ctx).color).not.toBe(MISSING_COLOR)
    expect(resolveNodeStyle(node('d'), part, ctx).color).toBe(MISSING_COLOR) // no year
    expect(resolveNodeStyle(node('d'), part, ctx).shape).toBe('diamond')
    expect(resolveNodeStyle(node('a'), part, ctx).shape).not.toBe('diamond')
    const legend = legendFor(part, ctx, slice.nodes)
    expect(legend).toMatchObject({ kind: 'categories', missing: 2 })
    expect((legend as { items: { key: string; color: string }[] }).items.find((i) => i.key === '2001')?.color).toBe('#00ff00')
    // Past maxCategories the rest still get a colour (the palette cycles) and the legend says how many spilled over.
    const tight = spec((r) => (r.nodes.default.color = { mode: 'partition', attr: { kind: 'field', key: 'year' }, palette: 'tableau10', maxCategories: 2 }))
    const tctx = ctxFor(tight)
    const colours = ['a', 'b', 'c'].map((id) => resolveNodeStyle(node(id), tight, tctx).color)
    expect(colours.every((c) => c !== MISSING_COLOR)).toBe(true)
    // Every value is listed (the list scrolls); past the palette's room the colours repeat, and the legend says from where.
    const l = legendFor(tight, tctx, slice.nodes) as { items: { key: string; color: string }[]; overflow: number; more: number; repeatsFrom?: number }
    expect(l).toMatchObject({ kind: 'categories', overflow: 0, more: 0, repeatsFrom: 2 })
    expect(l.items.map((i) => i.color)).toEqual(expect.arrayContaining(colours.filter(Boolean) as string[]))
  })

  it('reads degree by direction, nested field keys, value refs, and metrics only once there is a run', () => {
    const { spec, ctxFor, node, slice } = fixture()
    const inDeg = spec((r) => (r.nodes.default.size = { mode: 'ranking', attr: { kind: 'degree', dir: 'in' }, min: 1, max: 3 }))
    let ctx = ctxFor(inDeg)
    expect(nodeAttrValue(node('b'), { kind: 'degree', dir: 'in' }, ctx)).toBe(2)
    expect(nodeAttrValue(node('b'), { kind: 'degree', dir: 'out' }, ctx)).toBe(0)
    expect(nodeAttrValue(node('a'), { kind: 'degree' }, ctx)).toBe(2)
    expect(resolveNodeStyle(node('b'), inDeg, ctx).size).toBe(3)
    // A directed degree is only built when a channel asks for it.
    expect(ctxFor(DEFAULT_RENDERING).inDegree).toBeUndefined()
    expect(nodeAttrValue(node('a'), { kind: 'field', key: 'nested.deep' }, ctx)).toBe(7)
    expect(nodeAttrValue(node('a'), { kind: 'value', ref: 'degree.out:cites' }, ctx)).toBe(1)
    expect(nodeAttrValue(node('a'), { kind: 'value', ref: 'data.nested.deep' }, ctx)).toBe(7)
    expect(nodeAttrValue(node('a'), { kind: 'metric', key: 'pagerank' }, ctx)).toBeUndefined()
    const m = computeMetrics(serializeSlice(slice), { metrics: ['pagerank'] })
    ctx = ctxFor(inDeg, { metrics: m })
    expect(typeof nodeAttrValue(node('a'), { kind: 'metric', key: 'pagerank' }, ctx)).toBe('number')
    expect(nodeAttrValue(node('a'), { kind: 'metric', key: 'community' }, ctx)).toBeUndefined() // not computed
  })

  it('lets several tag rules on one node resolve by precedence, with the type rule between them', () => {
    const { spec, ctxFor, node } = fixture()
    const r = spec((s) => {
      s.nodes.types.paper = { color: { mode: 'constant', value: '#aa0000' }, sizeScale: 2 }
      s.nodes.tags.hot = { color: { mode: 'constant', value: '#00aa00' }, shape: { mode: 'constant', value: 'square' } }
      s.nodes.tags.old = { color: { mode: 'constant', value: '#0000aa' } }
    })
    const ctx = ctxFor(r)
    // a is a paper tagged hot then old. Type precedence: the type's colour; tag precedence: the later tag's colour; the shape comes from the only rule that sets it either way.
    expect(resolveNodeStyle(node('a'), r, ctx)).toMatchObject({ color: '#aa0000', shape: 'square' })
    const tagsWin: RenderingSpec = { ...r, precedence: 'tag' }
    expect(resolveNodeStyle(node('a'), tagsWin, ctxFor(tagsWin))).toMatchObject({ color: '#0000aa', shape: 'square' })
    // The size multiplier stacks on the mapped size only once, from the rule that wins it.
    const plain = resolveNodeStyle(node('a'), DEFAULT_RENDERING, ctxFor(DEFAULT_RENDERING)).size
    expect(resolveNodeStyle(node('a'), r, ctx).size).toBe(plain * 2)
    // A label switched off by any matching rule stays off.
    const noLabel = spec((s) => (s.nodes.tags.old = { label: false }))
    expect(resolveNodeStyle(node('a'), noLabel, ctxFor(noLabel)).label).toBe(false)
    expect(resolveNodeStyle(node('c'), noLabel, ctxFor(noLabel)).label).toBe(true)
  })

  it('styles edges by rankings on their data, partitions on direction, tag rules, and hides by rule', () => {
    const { spec, ctxFor, edge } = fixture()
    const r = spec((s) => {
      s.edges.default.width = { mode: 'ranking', attr: { kind: 'field', key: 'strength' }, min: 1, max: 5 }
      s.edges.default.color = { mode: 'partition', attr: { kind: 'directed' }, palette: 'tableau10' }
      s.edges.tags.weak = { opacity: { mode: 'constant', value: 0.2 }, arrow: false }
      s.edges.types.mentions = { visible: false }
    })
    const ctx = ctxFor(r)
    const fallback = () => '#999999'
    expect(edgeAttrValue(edge('ad'), { kind: 'directed' })).toBe('undirected')
    expect(edgeAttrValue(edge('cb'), { kind: 'tag' })).toBe('weak')
    expect(edgeAttrValue(edge('ab'), { kind: 'tag' })).toBeUndefined()
    expect(resolveEdgeStyle(edge('ab'), r, fallback, ctx).width).toBe(1)
    expect(resolveEdgeStyle(edge('cb'), r, fallback, ctx).width).toBe(5)
    expect(resolveEdgeStyle(edge('ad'), r, fallback, ctx).width).toBe(1) // no strength: the minimum
    expect(resolveEdgeStyle(edge('ab'), r, fallback, ctx).color).not.toBe(resolveEdgeStyle(edge('ad'), r, fallback, ctx).color)
    expect(resolveEdgeStyle(edge('cb'), r, fallback, ctx)).toMatchObject({ opacity: 0.2, arrow: false })
    expect(resolveEdgeStyle(edge('ab'), r, fallback, ctx)).toMatchObject({ opacity: 0.6, arrow: true }) // the default edge opacity
    expect(resolveEdgeStyle(edge('ad'), r, fallback, ctx).visible).toBe(false)
    // With no mapping the fallback colours by type.
    expect(resolveEdgeStyle(edge('ab'), DEFAULT_RENDERING, fallback).color).toBe('#999999')
  })

  it('takes the shape partition’s cycle from the shapes on offer', () => {
    const { spec, ctxFor, node } = fixture()
    const byYear = spec((r) => (r.nodes.default.shape = { mode: 'partition', attr: { kind: 'field', key: 'year' } }))
    const ctx = ctxFor(byYear)
    const shapes = ['a', 'b', 'c'].map((id) => resolveNodeStyle(node(id), byYear, ctx).shape)
    expect(new Set(shapes).size).toBe(3)
    expect(resolveNodeStyle(node('d'), byYear, ctx).shape).toBe<NodeShape>('circle') // no year
  })
})
