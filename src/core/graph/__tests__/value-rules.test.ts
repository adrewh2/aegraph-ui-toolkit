import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { getPath, matchPredicate, sortWithBlanksLast } from '../fields'
import { applyFilter, emptyFilter } from '../filter'
import { place } from '../placement'
import { buildPlot } from '../plot'
import { DEFAULT_RENDERING, nodeAttrValue, resolveNodeStyle, styleContext } from '../rendering'
import { resolveSelector } from '../selector'
import { makeValueContext, numericOf, valueOf } from '../values'
import '../types'

/**
 * Three rules the docs state about values, checked through every door a
 * value comes in by — so the next place that reads a value on its own
 * cannot quietly disagree with the others:
 *
 *   1. a dotted key reaches nested data (`data.address.city`);
 *   2. an ISO date reads as a number wherever a number is wanted;
 *   3. a blank label reads as the id.
 *
 * And the one rule about sorting: the blanks come last, ascending or not.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', label: '', data: { address: { city: 'Paris', floor: 3 }, when: '2026-03-04T10:00:00Z' } }),
    createEntity({ id: 'b', type: 'paper', label: 'B', data: { address: { city: 'Lima', floor: 1 }, when: '2026-01-01' } }),
    createEntity({ id: 'c', type: 'paper', label: 'C', data: { address: { floor: 2 } } }),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b', data: { meta: { strength: 5 } } }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'dataset', store: s, slice })
  return { s, registry, slice, values }
}
const T_A = Date.parse('2026-03-04T10:00:00Z')
const T_B = Date.parse('2026-01-01')

describe('the value rules, through every door', () => {
  it('a dotted key reaches nested data', () => {
    const { s, registry, slice, values } = fixture()
    const a = s.get('a')!
    // values
    expect(valueOf(a, 'data.address.city', values)).toBe('Paris')
    expect(numericOf(a, 'data.address.floor', values)).toBe(3)
    // filters
    expect(getPath(a, 'data.address.city')).toBe('Paris')
    expect(matchPredicate(a, { path: 'data.address.floor', op: 'gte', value: 3 })).toBe(true)
    expect(applyFilter(s, registry, { ...emptyFilter(), fields: [{ path: 'data.address.city', op: 'eq', value: 'Lima' }] }).nodes.map((n) => n.id)).toEqual(['b'])
    // the selector's sort and predicates
    expect(resolveSelector({ sort: 'data.address.floor', desc: true }, { store: s, registry, slice, values }).nodes.map((n) => n.id)).toEqual(['a', 'c', 'b'])
    // styles, nodes and edges
    const ctx = styleContext(registry, slice.nodes, slice.degree, DEFAULT_RENDERING, { edges: slice.edges, values })
    expect(nodeAttrValue(a, { kind: 'field', key: 'address.floor' }, ctx)).toBe(3)
    expect(nodeAttrValue(a, { kind: 'value', ref: 'data.address.city' }, ctx)).toBe('Paris')
    const byFloor = { ...DEFAULT_RENDERING, nodes: { ...DEFAULT_RENDERING.nodes, default: { ...DEFAULT_RENDERING.nodes.default, size: { mode: 'ranking' as const, attr: { kind: 'field' as const, key: 'address.floor' }, min: 1, max: 3 } } } }
    const sctx = styleContext(registry, slice.nodes, slice.degree, byFloor, { edges: slice.edges, values })
    expect(resolveNodeStyle(a, byFloor, sctx).size).toBe(3)
    expect(resolveNodeStyle(s.get('b')!, byFloor, sctx).size).toBe(1)
    // placements
    const frame = { viewport: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }
    const laid = place(slice.nodes, { arrangement: 'scatter', x: 'data.address.floor', region: { of: 'viewport' } }, values, frame)
    expect(laid.unplaced).toEqual([])
    expect(laid.positions.b.x).toBeLessThan(laid.positions.c.x)
    expect(laid.positions.c.x).toBeLessThan(laid.positions.a.x)
    // charts
    const chart = buildPlot({ traces: [{ kind: 'bar', x: 'data.address.city' }] }, { values, resolve: () => slice.nodes })
    expect(chart.data[0].x).toEqual(['Lima', 'Paris'])
    expect(chart.stats.missing).toBe(1)
    const scatter = buildPlot({ traces: [{ kind: 'scatter', x: 'data.address.floor', y: 'data.address.floor' }] }, { values, resolve: () => slice.nodes })
    expect(scatter.data[0].x).toEqual([3, 1, 2])
  })

  it('an ISO date reads as a number wherever a number is wanted', () => {
    const { s, registry, slice, values } = fixture()
    const a = s.get('a')!
    expect(numericOf(a, 'data.when', values)).toBe(T_A)
    expect(numericOf(s.get('b')!, 'data.when', values)).toBe(T_B)
    expect(numericOf(s.get('c')!, 'data.when', values)).toBeNaN()
    // filters compare dates as dates
    expect(matchPredicate(a, { path: 'data.when', op: 'gt', value: '2026-02-01' })).toBe(true)
    expect(matchPredicate(s.get('b')!, { path: 'data.when', op: 'gt', value: '2026-02-01' })).toBe(false)
    // the selector sorts them in time, blanks last either way
    const sctx = { store: s, registry, slice, values }
    expect(resolveSelector({ sort: 'data.when' }, sctx).nodes.map((n) => n.id)).toEqual(['b', 'a', 'c'])
    expect(resolveSelector({ sort: 'data.when', desc: true }, sctx).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    // a placement axis spans them, the blank parked
    const frame = { viewport: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }
    const laid = place(slice.nodes, { arrangement: 'scatter', x: 'data.when', region: { of: 'viewport' } }, values, frame)
    expect(laid.unplaced).toEqual(['c'])
    expect(laid.positions.b.x).toBe(0)
    expect(laid.positions.a.x).toBe(100)
    // a chart bins them by month on a date axis
    const chart = buildPlot({ traces: [{ kind: 'bar', x: 'data.when', bin: 'month' }] }, { values, resolve: () => slice.nodes })
    expect(chart.data[0].x).toEqual(['2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'])
    expect(chart.layout.xaxis).toMatchObject({ type: 'date' })
    expect(chart.stats.missing).toBe(1)
  })

  it('a blank label reads as the id', () => {
    const { s, registry, slice, values } = fixture()
    const a = s.get('a')!
    expect(valueOf(a, 'label', values)).toBe('a')
    // Sorted by label, case aside, the blank one sorts as its id: a, B, C.
    expect(resolveSelector({ sort: 'label' }, { store: s, registry, slice, values }).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    const chart = buildPlot({ traces: [{ kind: 'scatter', x: 'data.address.floor', y: 'data.address.floor' }] }, { values, resolve: () => slice.nodes })
    expect(chart.data[0].text).toEqual(['a', 'B', 'C'])
  })

  it('a sort by value keeps the blanks last, ascending or descending, whatever the keys', () => {
    const items = [
      { id: 'n1', k: 2 },
      { id: 'blank', k: undefined },
      { id: 'n2', k: 10 },
      { id: 'nan', k: NaN },
      { id: 'n3', k: 1 },
    ]
    expect(sortWithBlanksLast(items).map((x) => x.id)).toEqual(['n3', 'n1', 'n2', 'blank', 'nan'])
    expect(sortWithBlanksLast(items, true).map((x) => x.id)).toEqual(['n2', 'n1', 'n3', 'blank', 'nan'])
    const words = [
      { id: 'b', k: 'beta' },
      { id: 'e', k: '' },
      { id: 'a', k: 'Alpha' },
    ]
    expect(sortWithBlanksLast(words).map((x) => x.id)).toEqual(['a', 'b', 'e'])
    expect(sortWithBlanksLast(words, true).map((x) => x.id)).toEqual(['b', 'a', 'e'])
    // Ties keep their order.
    const ties = [{ id: 'x', k: 1 }, { id: 'y', k: 1 }, { id: 'z', k: 0 }]
    expect(sortWithBlanksLast(ties).map((x) => x.id)).toEqual(['z', 'x', 'y'])
    expect(sortWithBlanksLast([]).length).toBe(0)
  })
})
