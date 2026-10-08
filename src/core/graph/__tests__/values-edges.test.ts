import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { getPath, matchPredicate } from '../fields'
import { applyFilter, emptyFilter } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { DegreeIndex, describeValueRef, isCategoricalRef, isValidValueRef, listValueRefs, makeValueContext, numericOf, parseValueRef, refIsStateful, valueOf } from '../values'
import '../types'

/**
 * The edges of the ValueRef grammar the main test leaves alone: undirected
 * edges in typed degrees, every meta timestamp, tags and labels that are
 * missing, metrics for a node the run did not cover, overlays against real
 * data, booleans, arrays, objects and nested paths as values, and what
 * numericOf makes of dates and words.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', label: 'A', tags: ['x', 'y'], data: { year: 2001, when: '2024-05-01T10:00:00.000Z', day: '2024-05-01', flag: true, list: ['p', 'q'], nested: { deep: 7 }, zero: 0, empty: '', obj: { a: 1 } }, meta: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-02-01T00:00:00.000Z' } }),
    createEntity({ id: 'b', type: 'paper', label: '', tags: [], data: { year: '2002' } }),
    createEntity({ id: 'c', type: 'note', data: { year: 'two thousand' } }),
    createEntity({ id: 'lonely', type: 'note' }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b', directed: true }),
    createRelationship({ id: 'ac', type: 'related', source: 'a', target: 'c', directed: false }),
    createRelationship({ id: 'cb', type: 'cites', source: 'c', target: 'b', directed: true }),
  ])
  const slice = applyFilter(s, new TypeRegistry(s), emptyFilter())
  const ctx = makeValueContext({ scope: 'view', store: s, slice })
  return { s, slice, ctx }
}

describe('ValueRef edges', () => {
  it('counts an undirected edge on both ends whatever the direction asked', () => {
    const { s, ctx } = fixture()
    const a = s.get('a')!
    const c = s.get('c')!
    expect(valueOf(a, 'degree.out', ctx)).toBe(2) // ab out, ac undirected
    expect(valueOf(a, 'degree.in', ctx)).toBe(1) // ac undirected only
    expect(valueOf(c, 'degree.in:related', ctx)).toBe(1)
    expect(valueOf(c, 'degree.out:related', ctx)).toBe(1)
    expect(valueOf(c, 'degree.out:cites', ctx)).toBe(1)
    expect(valueOf(c, 'degree.in:cites', ctx)).toBe(0)
    expect(valueOf(s.get('lonely')!, 'degree', ctx)).toBe(0)
    expect(valueOf(s.get('lonely')!, 'degree.in:cites', ctx)).toBe(0)
    // A type nobody uses is a table of zeros, built once.
    const idx = new DegreeIndex(() => s.relationships())
    expect(idx.get('a', 'both', 'nope')).toBe(0)
    expect(idx.table('both', 'nope').size).toBe(0)
  })

  it('reads timestamps as epoch milliseconds and leaves missing or unparsable ones undefined', () => {
    const { s, ctx } = fixture()
    const a = s.get('a')!
    expect(valueOf(a, 'meta.createdAt', ctx)).toBe(Date.parse('2024-01-01T00:00:00.000Z'))
    expect(valueOf(a, 'meta.updatedAt', ctx)).toBe(Date.parse('2024-02-01T00:00:00.000Z'))
    expect(valueOf(a, 'meta.accessedAt', ctx)).toBeUndefined()
    const odd = createEntity({ id: 'odd', type: 'note', meta: { updatedAt: 'yesterday' as never } })
    expect(valueOf(odd, 'meta.updatedAt', ctx)).toBeUndefined()
    expect(numericOf(odd, 'meta.updatedAt', ctx)).toBeNaN()
    expect(parseValueRef('meta.source')).toBeUndefined()
    expect(isValidValueRef('meta.source')).toBe(true) // a plain path getPath answers, still valid where plain paths are
  })

  it('gives labels, ids, types and tags as strings, falling back where a node has none', () => {
    const { s, ctx } = fixture()
    expect(valueOf(s.get('a')!, 'tags', ctx)).toBe('x, y')
    expect(valueOf(s.get('b')!, 'tags', ctx)).toBeUndefined()
    expect(valueOf(s.get('b')!, 'label', ctx)).toBe('b')
    expect(valueOf(s.get('c')!, 'type', ctx)).toBe('note')
    expect(valueOf(s.get('c')!, 'id', ctx)).toBe('c')
    expect(isCategoricalRef('tags')).toBe(true)
    expect(isCategoricalRef('degree')).toBe(false)
    expect(isCategoricalRef('nonsense')).toBe(false)
    expect(refIsStateful('pinned')).toBe(true)
    expect(refIsStateful('data.pinned')).toBe(false)
  })

  it('turns booleans and arrays into text, drops objects, and reads nested paths', () => {
    const { s, ctx } = fixture()
    const a = s.get('a')!
    expect(valueOf(a, 'data.flag', ctx)).toBe('true')
    expect(valueOf(a, 'data.list', ctx)).toBe('p, q')
    expect(valueOf(a, 'data.obj', ctx)).toBeUndefined()
    expect(valueOf(a, 'data.zero', ctx)).toBe(0)
    expect(valueOf(a, 'data.empty', ctx)).toBe('')
    expect(valueOf(a, 'data.missing', ctx)).toBeUndefined()
    // Dotted paths reach nested keys, as the docs say — in values and in filter predicates alike.
    expect(valueOf(a, 'data.nested.deep', ctx)).toBe(7)
    expect(getPath(a, 'data.nested.deep')).toBe(7)
    expect(matchPredicate(a, { path: 'data.nested.deep', op: 'gte', value: 7 })).toBe(true)
    expect(valueOf(a, 'data.nested.nope', ctx)).toBeUndefined()
  })

  it('coerces numeric strings and ISO dates to numbers and words to NaN', () => {
    const { s, ctx } = fixture()
    const a = s.get('a')!
    expect(numericOf(s.get('b')!, 'data.year', ctx)).toBe(2002)
    expect(numericOf(s.get('c')!, 'data.year', ctx)).toBeNaN()
    expect(numericOf(a, 'data.when', ctx)).toBe(Date.parse('2024-05-01T10:00:00.000Z'))
    expect(numericOf(a, 'data.day', ctx)).toBe(Date.parse('2024-05-01'))
    expect(numericOf(a, 'data.flag', ctx)).toBeNaN()
    expect(numericOf(a, 'data.missing', ctx)).toBeNaN()
    expect(numericOf(a, 'tags', ctx)).toBeNaN()
    expect(numericOf(a, 'nonsense', ctx)).toBeNaN()
    expect(valueOf(a, 'nonsense', ctx)).toBeUndefined()
  })

  it('answers metrics only for nodes the run covered and columns it computed, and overlays only where the node has no value of its own', () => {
    const { s, slice, ctx } = fixture()
    const a = s.get('a')!
    const part = { nodes: slice.nodes.filter((n) => n.id !== 'lonely'), edges: slice.edges }
    const m = computeMetrics(serializeSlice(part), { metrics: ['degree'] })
    const withMetrics = makeValueContext({ scope: 'view', store: s, slice, metrics: m })
    expect(valueOf(a, 'metric.degree', withMetrics)).toBe(2) // ab, and the undirected ac once
    expect(valueOf(s.get('lonely')!, 'metric.degree', withMetrics)).toBeUndefined()
    expect(valueOf(a, 'metric.pagerank', withMetrics)).toBeUndefined()
    expect(valueOf(a, 'metric.degree', ctx)).toBeUndefined()
    const overlay = new Map<string, Record<string, number>>([
      ['a', { year: 1999, pagerank: 0.5 }],
      ['b', { pagerank: 0.25 }],
    ])
    const laid = makeValueContext({ scope: 'view', store: s, slice, overlay })
    expect(valueOf(a, 'data.year', laid)).toBe(2001) // the node's own value wins
    expect(valueOf(a, 'data.pagerank', laid)).toBe(0.5)
    expect(valueOf(s.get('b')!, 'data.pagerank', laid)).toBe(0.25)
    expect(valueOf(s.get('c')!, 'data.pagerank', laid)).toBeUndefined()
    expect(valueOf(a, 'data.zero', laid)).toBe(0) // a real zero is not "missing"
    const refs = listValueRefs(laid)
    expect(refs.find((r) => r.ref === 'data.pagerank')).toMatchObject({ label: 'pagerank (project)', group: 'Data', kind: 'numeric' })
    expect(refs.filter((r) => r.ref === 'data.year')).toHaveLength(1)
    expect(refs.find((r) => r.ref === 'data.year')?.label).toBe('year')
  })

  it('selected and pinned read 1 or 0 from the context and nothing without one', () => {
    const { s, slice } = fixture()
    const ctx = makeValueContext({ scope: 'view', store: s, slice, selected: new Set(['a']), pinned: new Set(['b']) })
    expect(valueOf(s.get('a')!, 'selected', ctx)).toBe(1)
    expect(valueOf(s.get('a')!, 'pinned', ctx)).toBe(0)
    expect(valueOf(s.get('b')!, 'pinned', ctx)).toBe(1)
    const bare = makeValueContext({ scope: 'view', store: s, slice })
    expect(valueOf(s.get('a')!, 'selected', bare)).toBe(0)
  })

  it('describes every kind for a legend, and hands an unknown ref back as it came', () => {
    expect(describeValueRef('data.year')).toBe('year')
    expect(describeValueRef('meta.createdAt')).toBe('created')
    expect(describeValueRef('meta.accessedAt')).toBe('last opened')
    expect(describeValueRef('metric.community')).toBe('Community (Louvain)')
    expect(describeValueRef('degree')).toBe('degree')
    expect(describeValueRef('degree.out')).toBe('out-degree')
    expect(describeValueRef('degree.out:wrote')).toBe('out-degree via wrote')
    expect(describeValueRef('tags')).toBe('tags')
    expect(describeValueRef('selected')).toBe('selected')
    expect(describeValueRef('what.ever')).toBe('what.ever')
    expect(parseValueRef('  data.year  ')).toEqual({ kind: 'data', key: 'year' })
    expect(parseValueRef('data.')).toBeUndefined()
    expect(parseValueRef('degree.sideways')).toBeUndefined()
    expect(parseValueRef('Degree')).toBeUndefined()
  })

  it('lists typed degrees for the relationship types of the scope, and marks metrics available once computed', () => {
    const { s, slice, ctx } = fixture()
    const refs = listValueRefs(ctx)
    const typed = refs.filter((r) => r.ref.includes(':')).map((r) => r.ref)
    expect(typed).toEqual(['degree.in:cites', 'degree.out:cites', 'degree.in:related', 'degree.out:related'])
    expect(refs.find((r) => r.ref === 'data.flag')?.kind).toBe('categorical')
    expect(refs.find((r) => r.ref === 'data.year')?.kind).toBe('numeric')
    const m = computeMetrics(serializeSlice(slice), { metrics: ['pagerank'] })
    const later = listValueRefs(makeValueContext({ scope: 'view', store: s, slice, metrics: m }))
    expect(later.find((r) => r.ref === 'metric.pagerank')?.available).toBe(true)
    expect(later.find((r) => r.ref === 'metric.community')?.available).toBe(false)
    // Only the nodes given are sampled for data keys.
    expect(listValueRefs(ctx, [s.get('lonely')!]).some((r) => r.ref === 'data.year')).toBe(false)
  })
})
