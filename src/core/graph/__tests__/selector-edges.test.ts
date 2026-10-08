import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { describeSelector, resolveSelector } from '../selector'
import { makeValueContext } from '../values'
import '../types'

/**
 * The selector's edges: ids that do not exist or are filtered out, tag
 * modes, roots with depth 0 / direction / a root outside the view, members
 * as the dataset, sorting with values missing (they stay last whichever
 * way the sort runs), strings, limits of 0, predicates skipped or not
 * depending on the metrics at hand.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'paper', label: 'Alpha', tags: ['x', 'y'], data: { year: 2001, score: 3 }, description: 'about graphs' }),
    createEntity({ id: 'b', type: 'paper', label: 'Beta', tags: ['x'], data: { year: 2002 } }),
    createEntity({ id: 'c', type: 'paper', label: 'Gamma', tags: ['y'], data: { year: 2003, score: 1 } }),
    createEntity({ id: 'd', type: 'note', label: 'Delta', data: { score: 2 } }),
    createEntity({ id: 'e', type: 'note', label: 'Epsilon' }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b', directed: true }),
    createRelationship({ id: 'bc', type: 'cites', source: 'b', target: 'c', directed: true }),
    createRelationship({ id: 'cd', type: 'mentions', source: 'c', target: 'd', directed: true }),
    createRelationship({ id: 'de', type: 'related', source: 'd', target: 'e', directed: false }),
  ])
  const registry = new TypeRegistry(s)
  const slice = applyFilter(s, registry, emptyFilter())
  const values = makeValueContext({ scope: 'view', store: s, slice })
  return { s, registry, slice, values, ctx: { store: s, registry, slice, values } }
}
const ids = (r: { nodes: { id: string }[] }) => r.nodes.map((n) => n.id)

describe('selector edges', () => {
  it('intersects ids with everything else, ignores ids that do not exist, and reads selection from the context', () => {
    const { ctx } = fixture()
    expect(ids(resolveSelector({ ids: ['a', 'nope', 'd'] }, ctx))).toEqual(['a', 'd'])
    expect(ids(resolveSelector({ ids: ['a', 'd'], types: ['note'] }, ctx))).toEqual(['d'])
    expect(resolveSelector({ ids: [] }, ctx).total).toBe(0)
    expect(resolveSelector({ selection: true }, ctx).total).toBe(0)
    expect(ids(resolveSelector({ selection: true }, { ...ctx, selected: new Set(['b', 'e']) }))).toEqual(['b', 'e'])
    expect(resolveSelector({}, ctx).total).toBe(5)
    expect(describeSelector({})).toBe('everything in view')
  })

  it('matches tags by any or all, and text over label, description, id and data', () => {
    const { ctx } = fixture()
    expect(ids(resolveSelector({ tags: ['x', 'y'] }, ctx))).toEqual(['a', 'b', 'c'])
    expect(ids(resolveSelector({ tags: ['x', 'y'], tagMode: 'all' }, ctx))).toEqual(['a'])
    expect(resolveSelector({ tags: ['zz'] }, ctx).total).toBe(0)
    expect(ids(resolveSelector({ text: 'GRAPHS' }, ctx))).toEqual(['a'])
    expect(ids(resolveSelector({ text: 'ps' }, ctx))).toEqual(['e']) // in the label
    expect(ids(resolveSelector({ text: '2003' }, ctx))).toEqual(['c']) // in the data
    expect(ids(resolveSelector({ text: '   ' }, ctx))).toHaveLength(5) // blank text is no text
    expect(describeSelector({ tags: ['x', 'y'], tagMode: 'all' })).toBe('#x & #y')
  })

  it('walks roots by depth and direction, and a root outside the view seeds nothing', () => {
    const { ctx, s, registry } = fixture()
    expect(ids(resolveSelector({ roots: ['b'], depth: 0 }, ctx))).toEqual(['b'])
    expect(ids(resolveSelector({ roots: ['b'], depth: 1 }, ctx)).sort()).toEqual(['a', 'b', 'c'])
    expect(ids(resolveSelector({ roots: ['b'], depth: 1, direction: 'out' }, ctx)).sort()).toEqual(['b', 'c'])
    expect(ids(resolveSelector({ roots: ['b'], depth: 1, direction: 'in' }, ctx)).sort()).toEqual(['a', 'b'])
    expect(ids(resolveSelector({ roots: ['b'], depth: 3, direction: 'out' }, ctx)).sort()).toEqual(['b', 'c', 'd', 'e'])
    // The other constraints still apply to what the walk reaches.
    expect(ids(resolveSelector({ roots: ['b'], depth: 3, types: ['note'] }, ctx)).sort()).toEqual(['d', 'e'])
    // A root the view does not show cannot seed a walk in view scope; in dataset scope it can.
    const papers = applyFilter(s, registry, { ...emptyFilter(), types: ['paper'] })
    const pctx = { ...ctx, slice: papers, values: makeValueContext({ scope: 'view', store: s, slice: papers }) }
    expect(resolveSelector({ roots: ['d'], depth: 1 }, pctx).total).toBe(0)
    expect(ids(resolveSelector({ roots: ['d'], depth: 1, scope: 'dataset' }, pctx)).sort()).toEqual(['c', 'd', 'e'])
    expect(describeSelector({ roots: ['b'], depth: 2 })).toBe('2 hops from 1')
  })

  it('counts what the view hides, and treats loaded project members as the dataset', () => {
    const { ctx, s, registry } = fixture()
    const papers = applyFilter(s, registry, { ...emptyFilter(), types: ['paper'] })
    const pctx = { ...ctx, slice: papers, values: makeValueContext({ scope: 'view', store: s, slice: papers }) }
    const notes = resolveSelector({ types: ['note'] }, pctx)
    expect(notes.total).toBe(0)
    expect(notes.outsideView).toBe(2)
    expect(resolveSelector({ types: ['paper'] }, pctx).outsideView).toBe(0)
    // With the whole dataset in view there is nothing outside it.
    expect(resolveSelector({ types: ['note'] }, ctx).outsideView).toBe(0)
    // Members: the dataset is the project; what is outside the project is outside the dataset too.
    const members = new Set(['a', 'b', 'd'])
    const mctx = { ...pctx, members }
    expect(ids(resolveSelector({ scope: 'dataset' }, mctx)).sort()).toEqual(['a', 'b', 'd'])
    expect(resolveSelector({ types: ['note'] }, mctx).outsideView).toBe(1)
    expect(describeSelector({ scope: 'dataset', types: ['note'] })).toBe('note · in dataset')
  })

  it('sorts by numbers with missing values last both ways, by strings, and applies the limit after counting', () => {
    const { ctx } = fixture()
    expect(ids(resolveSelector({ sort: 'data.score' }, ctx))).toEqual(['c', 'd', 'a', 'b', 'e'])
    // Descending still keeps the nodes without a value at the end: "top 2 by score" is a and d, never a blank.
    expect(ids(resolveSelector({ sort: 'data.score', desc: true }, ctx))).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(ids(resolveSelector({ sort: 'data.score', desc: true, limit: 2 }, ctx))).toEqual(['a', 'd'])
    // By label text: Gamma, Epsilon, Delta, Beta, Alpha.
    expect(ids(resolveSelector({ sort: 'label', desc: true }, ctx))).toEqual(['c', 'e', 'd', 'b', 'a'])
    // b, c and d each have two links; a and e one — the top by degree is one of the three.
    expect(['b', 'c', 'd']).toContain(ids(resolveSelector({ sort: 'degree', desc: true, limit: 1 }, ctx))[0])
    const limited = resolveSelector({ types: ['paper'], limit: 2 }, ctx)
    expect(limited.total).toBe(3)
    expect(limited.nodes).toHaveLength(2)
    expect(resolveSelector({ types: ['paper'], limit: 0 }, ctx).nodes).toHaveLength(3)
    expect(resolveSelector({ types: ['paper'], limit: -1 }, ctx).nodes).toHaveLength(3)
    expect(describeSelector({ sort: 'data.score', desc: true, limit: 2 })).toBe('by data.score desc · top 2')
  })

  it('skips a metric predicate only while there are no metrics, evaluates computed refs, and drops an empty path', () => {
    const { ctx, s, slice } = fixture()
    const cold = resolveSelector({ fields: [{ path: 'metric.degree', op: 'gte', value: 2 }] }, ctx)
    expect(cold.skipped).toHaveLength(1)
    expect(cold.total).toBe(5) // a skipped predicate passes everything
    const m = computeMetrics(serializeSlice(slice), { metrics: ['degree'] })
    const warm = { ...ctx, values: makeValueContext({ scope: 'view', store: s, slice, metrics: m }) }
    const hit = resolveSelector({ fields: [{ path: 'metric.degree', op: 'gte', value: 2 }] }, warm)
    expect(hit.skipped).toHaveLength(0)
    expect(ids(hit).sort()).toEqual(['b', 'c', 'd'])
    expect(ids(resolveSelector({ fields: [{ path: 'degree.out:cites', op: 'eq', value: 1 }] }, ctx)).sort()).toEqual(['a', 'b'])
    expect(ids(resolveSelector({ fields: [{ path: 'data.year', op: 'lt', value: 2003 }, { path: 'tags', op: 'contains', value: 'y' }] }, ctx))).toEqual(['a'])
    expect(resolveSelector({ fields: [{ path: '', op: 'eq', value: 1 }] }, ctx).total).toBe(5)
    expect(describeSelector({ fields: [{ path: 'data.year', op: 'lt', value: 2003 }] })).toBe('data.year lt 2003')
  })
})
