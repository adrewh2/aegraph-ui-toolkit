import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { edgeWeight, shortestPath } from '../paths'
import { applySelect, pruneSelection, selectionOp } from '../selection'
import '../types'

/**
 * Shortest paths and the selection at their edges: weights that are
 * missing, zero, negative, words or numeric strings, a custom weight
 * field, undirected edges under a directed search, a wrong-way directed
 * edge beside an undirected one, edges into nodes the slice lacks,
 * unreachable and unknown endpoints; and every selection operation with
 * odd input, empty selections, hops and direction, and pruning.
 */
function fixture() {
  const s = new EntityStore()
  s.upsertMany([
    ...['a', 'b', 'c', 'd', 'e', 'lone'].map((id) => createEntity({ id, type: id === 'e' ? 'note' : 'paper', label: id.toUpperCase(), tags: id === 'a' || id === 'c' ? ['x'] : [] })),
    createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b', directed: true, data: { weight: 'not a number' } }),
    createRelationship({ id: 'bc', type: 'r', source: 'b', target: 'c', directed: true, data: { weight: 0 } }),
    createRelationship({ id: 'cd', type: 'r', source: 'c', target: 'd', directed: true, data: { weight: -5, cost: 10 } }),
    createRelationship({ id: 'ad', type: 'r', source: 'a', target: 'd', directed: true, data: { weight: '4', cost: 1 } }),
    createRelationship({ id: 'de', type: 'r', source: 'd', target: 'e', directed: false }),
    createRelationship({ id: 'ea', type: 'r', source: 'e', target: 'a', directed: true, data: { weight: 1 } }),
    createRelationship({ id: 'out', type: 'r', source: 'e', target: 'ghost', directed: true }),
  ])
  const slice = applyFilter(s, new TypeRegistry(s), emptyFilter())
  return { s, slice }
}

describe('shortest path edges', () => {
  it('reads a weight only when it is a positive number (or a numeric string), from any field, else 1', () => {
    const { slice } = fixture()
    const e = (id: string) => slice.edges.find((x) => x.id === id)!
    expect(edgeWeight(e('ab'))).toBe(1) // a word
    expect(edgeWeight(e('bc'))).toBe(1) // zero
    expect(edgeWeight(e('cd'))).toBe(1) // negative
    expect(edgeWeight(e('ad'))).toBe(4) // a numeric string
    expect(edgeWeight(e('de'))).toBe(1) // nothing
    expect(edgeWeight(e('cd'), 'data.cost')).toBe(10)
    expect(edgeWeight(e('de'), 'data.cost')).toBe(1)
  })

  it('finds the lightest route by weight, and a different one by another field', () => {
    const { slice } = fixture()
    // Unweighted: a→d direct is one hop.
    expect(shortestPath(slice, 'a', 'd')?.nodes).toEqual(['a', 'd'])
    // By data.weight, along the arrows: a→d costs 4; a→b→c→d costs 1+1+1 = 3 (a word, a zero and a negative each count 1).
    const byWeight = shortestPath(slice, 'a', 'd', { weighted: true, directed: true })
    expect(byWeight?.nodes).toEqual(['a', 'b', 'c', 'd'])
    expect(byWeight).toMatchObject({ length: 3, weight: 3, edges: ['ab', 'bc', 'cd'] })
    // Ignoring the arrows, e→a and d–e open a route of 1+1 = 2.
    expect(shortestPath(slice, 'a', 'd', { weighted: true })).toMatchObject({ nodes: ['a', 'e', 'd'], weight: 2 })
    // By data.cost, along the arrows: a→d costs 1, the long way 1+1+10.
    const byCost = shortestPath(slice, 'a', 'd', { weighted: true, directed: true, weightField: 'data.cost' })
    expect(byCost?.nodes).toEqual(['a', 'd'])
    expect(byCost?.weight).toBe(1)
    // Unweighted results carry no weight; from === to carries a zero one when weighted.
    expect(shortestPath(slice, 'a', 'd')?.weight).toBeUndefined()
    expect(shortestPath(slice, 'a', 'a', { weighted: true })).toEqual({ nodes: ['a'], edges: [], length: 0, weight: 0 })
  })

  it('walks undirected edges both ways under a directed search and skips a wrong-way edge beside them', () => {
    const { slice } = fixture()
    // e→a is directed, d–e undirected: from d to a under direction, d–e then e→a.
    expect(shortestPath(slice, 'd', 'a', { directed: true })?.nodes).toEqual(['d', 'e', 'a'])
    // a to e under direction: a→d then d–e (the undirected edge back from e is fine too).
    expect(shortestPath(slice, 'a', 'e', { directed: true })?.edges).toEqual(['ad', 'de'])
    // Against the arrow, c reaches b only the long way round the cycle; ignoring arrows it is one hop.
    expect(shortestPath(slice, 'c', 'b', { directed: true })?.nodes).toEqual(['c', 'd', 'e', 'a', 'b'])
    expect(shortestPath(slice, 'c', 'b')?.edges).toEqual(['bc'])
    // A wrong-way directed edge beside an undirected one is not the edge the path reports.
    const twin = { nodes: slice.nodes, edges: [...slice.edges, createRelationship({ id: 'ed-back', type: 'r', source: 'e', target: 'd', directed: true, data: { weight: 0.5 } })] }
    const p = shortestPath(twin, 'd', 'e', { directed: true, weighted: true })
    expect(p?.edges).toEqual(['de'])
    expect(shortestPath(twin, 'e', 'd', { directed: true, weighted: true })?.edges).toEqual(['ed-back'])
  })

  it('returns null for what cannot be reached or is not in the slice, and ignores edges to nodes the slice lacks', () => {
    const { slice } = fixture()
    expect(shortestPath(slice, 'a', 'lone')).toBeNull()
    expect(shortestPath(slice, 'lone', 'lone')).toMatchObject({ length: 0 })
    expect(shortestPath(slice, 'a', 'ghost')).toBeNull() // the edge e→ghost points outside the slice
    expect(shortestPath(slice, 'nope', 'a')).toBeNull()
    expect(shortestPath({ nodes: [], edges: [] }, 'a', 'b')).toBeNull()
  })
})

describe('selection edges', () => {
  it('takes odd input in its stride and keeps the primary node last', () => {
    expect(applySelect(['a'], 'b' as unknown as string[])).toEqual(['b'])
    expect(applySelect(['a'], null as unknown as string[])).toEqual([])
    expect(applySelect([], ['a', 'a', 'b'])).toEqual(['a', 'b'])
    // Adding what is already selected moves it to the end: it becomes the primary.
    expect(applySelect(['a', 'b', 'c'], ['a'], 'add')).toEqual(['b', 'c', 'a'])
    expect(applySelect(['a', 'b'], ['c', 'zz'], 'remove')).toEqual(['a', 'b'])
    expect(applySelect(['a', 'b'], ['b', 'c', 'c'], 'toggle')).toEqual(['a', 'c'])
    expect(applySelect([], [], 'toggle')).toEqual([])
  })

  it('derives selections with hops and direction, keeps the current order first, and stands still when there is nothing to go on', () => {
    const { slice } = fixture()
    const ids = (r: string[]) => [...r].sort()
    expect(ids(selectionOp(['a'], slice, { op: 'neighbours', hops: 2, direction: 'out' }))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(selectionOp(['b'], slice, { op: 'neighbours', direction: 'in' }))).toEqual(['a', 'b'])
    expect(ids(selectionOp(['lone'], slice, { op: 'neighbours', hops: 3 }))).toEqual(['lone'])
    expect(selectionOp(['d', 'a'], slice, { op: 'neighbours' }).slice(0, 2)).toEqual(['d', 'a'])
    expect(selectionOp([], slice, { op: 'neighbours' })).toEqual([])
    expect(selectionOp([], slice, { op: 'byType' })).toEqual([])
    expect(ids(selectionOp(['e'], slice, { op: 'byType' }))).toEqual(['e'])
    expect(ids(selectionOp(['a', 'e'], slice, { op: 'byType' }))).toEqual(['a', 'b', 'c', 'd', 'e', 'lone'])
    // No tag on the selection: it stays as it is.
    expect(selectionOp(['b'], slice, { op: 'byTag' })).toEqual(['b'])
    expect(ids(selectionOp(['a'], slice, { op: 'byTag' }))).toEqual(['a', 'c'])
    // Ids outside the view do not count and drop out of an inversion.
    expect(ids(selectionOp(['ghost'], slice, { op: 'invert' }))).toEqual(['a', 'b', 'c', 'd', 'e', 'lone'])
    expect(selectionOp(['a'], slice, { op: 'nonsense' } as never)).toEqual(['a'])
  })

  it('prunes to what is visible in order, and hands the same list back when nothing changes', () => {
    const list = ['c', 'a', 'b']
    expect(pruneSelection(list, new Set(['a', 'b', 'c']))).toBe(list)
    expect(pruneSelection(list, new Set(['b', 'c']))).toEqual(['c', 'b'])
    expect(pruneSelection(list, new Set())).toEqual([])
    expect(pruneSelection([], new Set(['a']))).toEqual([])
  })
})
