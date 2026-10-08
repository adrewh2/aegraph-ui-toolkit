import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, describeFilter, emptyFilter, filterComputedRefs, isEmptyFilter, splitPredicates } from '../filter'
import { computeMetrics, serializeSlice } from '../metrics'
import { makeValueContext } from '../values'
import '../types'

/**
 * The filter's edges: roots that the checklists leave out, direction over
 * undirected edges, depth 0, tag modes with excluded tags, a degree band
 * counted after the relationship checklist, k-core and components, the
 * cap keeping the best-connected and reporting what it dropped, hand-picked
 * includes and excludes against each other, `only`, members, predicates
 * that are skipped or evaluated, and edges only ever among visible nodes.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'hub', type: 'topic', label: 'Graphs', tags: ['core'] }),
    createEntity({ id: 'p1', type: 'paper', label: 'Paper one', tags: ['core', 'old'], data: { year: 2001 } }),
    createEntity({ id: 'p2', type: 'paper', label: 'Paper two', tags: ['core'], data: { year: 2010 } }),
    createEntity({ id: 'p3', type: 'paper', label: 'Paper three', tags: ['old'], data: { year: 1999 } }),
    createEntity({ id: 'a1', type: 'person', label: 'Ada', tags: ['core'] }),
    createEntity({ id: 'lone', type: 'note', label: 'Loose note' }),
    createEntity({ id: 'x1', type: 'note', label: 'Island one' }),
    createEntity({ id: 'x2', type: 'note', label: 'Island two' }),
    createRelationship({ id: 'hp1', type: 'about', source: 'p1', target: 'hub', directed: true }),
    createRelationship({ id: 'hp2', type: 'about', source: 'p2', target: 'hub', directed: true }),
    createRelationship({ id: 'hp3', type: 'about', source: 'p3', target: 'hub', directed: true }),
    createRelationship({ id: 'c12', type: 'cites', source: 'p2', target: 'p1', directed: true }),
    createRelationship({ id: 'c13', type: 'cites', source: 'p3', target: 'p1', directed: true }),
    createRelationship({ id: 'w1', type: 'wrote', source: 'a1', target: 'p1', directed: true }),
    createRelationship({ id: 'k', type: 'knows', source: 'a1', target: 'p2', directed: false }),
    createRelationship({ id: 'xx', type: 'related', source: 'x1', target: 'x2', directed: false }),
  ])
  return { s, r: new TypeRegistry(s) }
}
const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort()
const eids = (g: { edges: { id: string }[] }) => g.edges.map((e) => e.id).sort()

describe('filter edges', () => {
  it('draws edges only among visible nodes, of the ticked relationship types, and counts degree over those', () => {
    const { s, r } = fixture()
    const papers = applyFilter(s, r, { ...emptyFilter(), types: ['paper'] })
    expect(ids(papers)).toEqual(['p1', 'p2', 'p3'])
    expect(eids(papers)).toEqual(['c12', 'c13'])
    expect(papers.degree.get('p1')).toBe(2)
    expect(papers.degree.get('p3')).toBe(1)
    const about = applyFilter(s, r, { ...emptyFilter(), relationshipTypes: ['about'] })
    expect(eids(about)).toEqual(['hp1', 'hp2', 'hp3'])
    expect(about.degree.get('a1') ?? 0).toBe(0) // a1's links are wrote/knows, unticked
    expect(ids(about)).toHaveLength(8) // every node still shows; only the edges are fewer
  })

  it('keeps a root only when the checklists do, walks by direction with undirected edges both ways, and stops at depth 0', () => {
    const { s, r } = fixture()
    // From the hub, one hop, papers only: the hub itself is not a paper and stays out; its papers come.
    const around = applyFilter(s, r, { ...emptyFilter(), roots: ['hub'], depth: 1, types: ['paper'] })
    expect(ids(around)).toEqual(['p1', 'p2', 'p3'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['hub'], depth: 0 }))).toEqual(['hub'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p1'], depth: 1, direction: 'out' }))).toEqual(['hub', 'p1'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p1'], depth: 1, direction: 'in' }))).toEqual(['a1', 'p1', 'p2', 'p3'])
    // knows is undirected: reachable from p2 whichever direction is asked.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p2'], depth: 1, direction: 'in' }))).toEqual(['a1', 'p2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p2'], depth: 1, direction: 'out' }))).toEqual(['a1', 'hub', 'p1', 'p2'])
    // The relationship checklist shapes the walk too: only `cites` hops from p1 (in), so the author stays out.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['p1'], depth: 1, relationshipTypes: ['cites'] }))).toEqual(['p1', 'p2', 'p3'])
    // A root that does not exist, or is hidden by hand, seeds nothing.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['nope'], depth: 2 }))).toEqual([])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['hub'], depth: 1, exclude: ['hub'] }))).toEqual([])
    expect(describeFilter({ ...emptyFilter(), roots: ['p1'], depth: 2, direction: 'in' })).toBe('2 hops in from 1')
  })

  it('matches tags by any or all, drops excluded tags, and searches text', () => {
    const { s, r } = fixture()
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['core', 'old'] }))).toEqual(['a1', 'hub', 'p1', 'p2', 'p3'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['core', 'old'], tagMode: 'all' }))).toEqual(['p1'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), tags: ['core'], excludeTags: ['old'] }))).toEqual(['a1', 'hub', 'p2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), excludeTags: ['core', 'old'] }))).toEqual(['lone', 'x1', 'x2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), text: 'island' }))).toEqual(['x1', 'x2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), text: '  ' }))).toHaveLength(8)
    expect(describeFilter({ ...emptyFilter(), tags: ['a', 'b'], tagMode: 'all', excludeTags: ['c'] })).toBe('tags: a & b · not tagged c')
  })

  it('prunes by a degree band after the checklists, by k-core, and by components', () => {
    const { s, r } = fixture()
    expect(ids(applyFilter(s, r, { ...emptyFilter(), hideIsolated: true }))).toEqual(['a1', 'hub', 'p1', 'p2', 'p3', 'x1', 'x2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), minDegree: 3 }))).toEqual(['hub', 'p1', 'p2']) // hub 3, p1 4, p2 3
    expect(ids(applyFilter(s, r, { ...emptyFilter(), maxDegree: 1 }))).toEqual(['lone', 'x1', 'x2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), minDegree: 1, maxDegree: 2 }))).toEqual(['a1', 'p3', 'x1', 'x2'])
    // Degree is counted within the slice: with only `cites` ticked the hub has no edge and is isolated.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), relationshipTypes: ['cites'], hideIsolated: true }))).toEqual(['p1', 'p2', 'p3'])
    // 2-core: the hub and the papers cycle and a1 links two of them; nothing survives a 3-core (p2 has two links there, and its loss cascades).
    const core = applyFilter(s, r, { ...emptyFilter(), kCore: 2 })
    expect(ids(core)).toEqual(['a1', 'hub', 'p1', 'p2', 'p3'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), kCore: 3 }))).toEqual([])
    const giant = applyFilter(s, r, { ...emptyFilter(), giantOnly: true })
    expect(ids(giant)).toEqual(['a1', 'hub', 'p1', 'p2', 'p3'])
    expect(giant.components).toBe(1)
    const pairs = applyFilter(s, r, { ...emptyFilter(), componentMin: 2 })
    expect(ids(pairs)).toEqual(['a1', 'hub', 'p1', 'p2', 'p3', 'x1', 'x2'])
    expect(pairs.components).toBe(2)
    expect(applyFilter(s, r, emptyFilter()).components).toBeUndefined()
    expect(describeFilter({ ...emptyFilter(), kCore: 2, giantOnly: true, hideIsolated: true })).toBe('no isolated · 2-core · giant component')
  })

  it('caps to the best-connected nodes and says how many were dropped, with the degree map recomputed', () => {
    const { s, r } = fixture()
    const top = applyFilter(s, r, { ...emptyFilter(), maxNodes: 2 })
    expect(top.candidates).toBe(8)
    expect(top.truncated).toBe(6)
    expect(ids(top)).toEqual(['hub', 'p1'])
    expect(eids(top)).toEqual(['hp1'])
    expect(top.degree.get('hub')).toBe(1)
    const fits = applyFilter(s, r, { ...emptyFilter(), maxNodes: 8 })
    expect(fits.truncated).toBe(0)
    expect(fits.candidates).toBe(8)
  })

  it('brings hand-picked nodes in and keeps hidden ones out, in that order, and honours `only`', () => {
    const { s, r } = fixture()
    const added = applyFilter(s, r, { ...emptyFilter(), types: ['paper'], include: ['a1', 'lone', 'nope'] })
    expect(ids(added)).toEqual(['a1', 'lone', 'p1', 'p2', 'p3'])
    expect(eids(added)).toEqual(['c12', 'c13', 'k', 'w1']) // the included author's links to visible papers come along
    // Hidden beats included; a hidden node also leaves the walk it would have seeded through.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), types: ['paper'], include: ['a1'], exclude: ['a1', 'p3'] }))).toEqual(['p1', 'p2'])
    // `only` is a hard list; includes still work on top of it, excludes still remove.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), only: ['hub', 'p1', 'x1'] }))).toEqual(['hub', 'p1', 'x1'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), only: ['hub', 'p1'], exclude: ['hub'] }))).toEqual(['p1'])
    // Structural pruning still applies to what was added by hand.
    expect(ids(applyFilter(s, r, { ...emptyFilter(), types: ['paper'], include: ['lone'], hideIsolated: true }))).toEqual(['p1', 'p2', 'p3'])
    expect(describeFilter({ ...emptyFilter(), include: ['a'], exclude: ['b', 'c'], only: ['d'] })).toBe('2 hidden · 1 added · just 1')
  })

  it('restricts the dataset to loaded project members, edges included', () => {
    const { s, r } = fixture()
    const members = new Set(['hub', 'p1', 'p2', 'hp1', 'a1'])
    const g = applyFilter(s, r, emptyFilter(), { members })
    expect(ids(g)).toEqual(['a1', 'hub', 'p1', 'p2'])
    // hp2 joins hub and p2, both members, but the relationship itself is not: it is not drawn.
    expect(eids(g)).toEqual(['hp1'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), include: ['x1'] }, { members }))).toEqual(['a1', 'hub', 'p1', 'p2'])
    expect(ids(applyFilter(s, r, { ...emptyFilter(), roots: ['hub'], depth: 1 }, { members }))).toEqual(['hub', 'p1', 'p2'])
  })

  it('evaluates plain and structural predicates, skips metric and stateful ones, and reports what it skipped', () => {
    const { s, r } = fixture()
    expect(ids(applyFilter(s, r, { ...emptyFilter(), fields: [{ path: 'data.year', op: 'gte', value: 2001 }] }))).toEqual(['p1', 'p2'])
    // A structural ref needs a context; without one the predicate is skipped and reported, not failed.
    const noCtx = applyFilter(s, r, { ...emptyFilter(), fields: [{ path: 'degree.in:cites', op: 'gte', value: 2 }] })
    expect(noCtx.skipped).toHaveLength(1)
    expect(ids(noCtx)).toHaveLength(8)
    const values = makeValueContext({ scope: 'dataset', store: s })
    const withCtx = applyFilter(s, r, { ...emptyFilter(), fields: [{ path: 'degree.in:cites', op: 'gte', value: 2 }] }, { values })
    expect(withCtx.skipped).toBeUndefined()
    expect(ids(withCtx)).toEqual(['p1'])
    // Metric and selection refs are never evaluated by a filter, even with metrics at hand.
    const slice = applyFilter(s, r, emptyFilter())
    const m = computeMetrics(serializeSlice(slice), { metrics: ['degree'] })
    const warm = makeValueContext({ scope: 'dataset', store: s, metrics: m, selected: new Set(['hub']) })
    const never = applyFilter(s, r, { ...emptyFilter(), fields: [{ path: 'metric.degree', op: 'gte', value: 3 }, { path: 'selected', op: 'eq', value: 1 }, { path: '', op: 'eq', value: 1 }] }, { values: warm })
    expect(never.skipped?.map((p) => p.path)).toEqual(['metric.degree', 'selected'])
    expect(ids(never)).toHaveLength(8)
    expect(splitPredicates([{ path: 'description', op: 'contains', value: 'x' }]).usable).toHaveLength(1)
    expect(filterComputedRefs({ ...emptyFilter(), fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }, { path: 'degree.out', op: 'gt', value: 0 }, { path: 'data.year', op: 'gt', value: 0 }] })).toEqual({ metrics: ['pagerank'], structural: true })
    expect(isEmptyFilter(emptyFilter())).toBe(true)
    expect(isEmptyFilter({ ...emptyFilter(), fields: [{ path: '', op: 'eq', value: 1 }] })).toBe(true)
  })
})
