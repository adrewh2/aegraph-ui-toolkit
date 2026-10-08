import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity, Relationship } from '../../entity/types'
import { backboneEdges } from '../backbone'
import { hierarchyOf, coneTree, radialTree } from '../tree'
import { DEFAULT_LAYOUT_PARAMS } from '../layouts'
import { degreesOf } from '../algorithms'
import type { GraphSlice } from '../filter'

const node = (id: string) => createEntity({ id, type: 'thing', label: id })
const link = (a: string, b: string, weight?: number) => createRelationship({ id: `${a}-${b}`, type: 'to', source: a, target: b, ...(weight === undefined ? {} : { data: { weight } }) })
const slice = (nodes: AnyEntity[], edges: Relationship[]): GraphSlice => ({ nodes, edges, degree: degreesOf(edges), truncated: 0, candidates: nodes.length })

describe('backbone', () => {
  it('disparity keeps the strong ties of a hub and every leaf’s only link', () => {
    // A hub with one strong tie and nine weak ones; each leaf has just the one edge.
    const edges = [link('hub', 'strong', 100), ...Array.from({ length: 9 }, (_, i) => link('hub', `weak${i}`, 1))]
    const kept = backboneEdges(edges, { mode: 'disparity', alpha: 0.05, weightField: 'data.weight' }).map((e) => e.id)
    expect(kept).toContain('hub-strong')
    // The weak ones survive only because their leaf has nothing else — the filter is per node, from either end.
    expect(kept).toHaveLength(edges.length)
    const severe = backboneEdges([...edges, link('weak0', 'weak1', 1)], { mode: 'disparity', alpha: 0.01, weightField: 'data.weight' }).map((e) => e.id)
    expect(severe).toContain('hub-strong')
    expect(severe).not.toContain('weak0-weak1')
  })

  it('simmelian keeps embedded edges and drops the one-offs', () => {
    // Two triangles joined by a single edge, plus a stray tie from each triangle to a loose node.
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'a'), link('d', 'e'), link('e', 'f'), link('f', 'd'), link('c', 'd'), link('a', 'loose'), link('e', 'loose2')]
    const kept = new Set(backboneEdges(edges, { mode: 'simmelian', k: 2 }).map((e) => e.id))
    for (const id of ['a-b', 'b-c', 'c-a', 'd-e', 'e-f', 'f-d']) expect(kept.has(id), id).toBe(true)
    // `loose` has one edge, so it keeps it; `a` does not spend one of its two slots on it.
    expect(kept.has('a-loose')).toBe(true)
    expect(backboneEdges(edges, { mode: 'simmelian', k: 1 }).length).toBeLessThan(edges.length)
  })

  it('spanning keeps every node in one forest with no cycles', () => {
    const edges = [link('a', 'b', 5), link('b', 'c', 4), link('c', 'a', 1), link('d', 'e', 3)]
    const kept = backboneEdges(edges, { mode: 'spanning', weightField: 'data.weight' })
    expect(kept.map((e) => e.id).sort()).toEqual(['a-b', 'b-c', 'd-e'])
  })

  it('leaves a graph with nothing to thin alone', () => {
    expect(backboneEdges([link('a', 'b')], { mode: 'simmelian' })).toHaveLength(1)
    expect(backboneEdges([], { mode: 'disparity' })).toEqual([])
  })
})

describe('hierarchy and the tree layouts', () => {
  const nodes = ['root', 'a', 'b', 'a1', 'a2', 'b1'].map(node)
  const edges = [link('root', 'a'), link('root', 'b'), link('a', 'a1'), link('a', 'a2'), link('b', 'b1')]

  it('finds the root, the depths and the leaves of a directed tree', () => {
    const h = hierarchyOf(slice(nodes, edges), { follow: 'out' })
    expect(h.roots.map((i) => h.nodes[i].id)).toEqual(['root'])
    const depth = Object.fromEntries(h.nodes.map((n, i) => [n.id, h.depth[i]]))
    expect(depth).toEqual({ root: 0, a: 1, b: 1, a1: 2, a2: 2, b1: 2 })
    const leaves = Object.fromEntries(h.nodes.map((n, i) => [n.id, h.leaves[i]]))
    expect(leaves.root).toBe(3)
    expect(leaves.a).toBe(2)
    expect(h.extra).toBe(0)
  })

  it('spans a cyclic, undirected graph and counts the edges it could not use', () => {
    const cyc = [link('a', 'b'), link('b', 'c'), link('c', 'a')]
    const h = hierarchyOf(slice(['a', 'b', 'c'].map(node), cyc), { follow: 'any' })
    expect(h.roots).toHaveLength(1)
    expect(h.extra).toBe(1)
    expect([...h.parent].filter((p) => p >= 0)).toHaveLength(2)
  })

  it('draws every node once, children below their parent in 3D and further out in 2D', () => {
    const s = slice(nodes, edges)
    const cone = coneTree(s, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 3 })
    expect(Object.keys(cone).sort()).toEqual(nodes.map((n) => n.id).sort())
    // Depth runs down −y, so the default camera sees the branches from the side.
    expect(cone.root.y).toBe(0)
    expect(cone.a.y).toBeLessThan(cone.root.y)
    expect(cone.a1.y).toBeLessThan(cone.a.y)
    // Siblings share a level and sit apart across x/z.
    expect(cone.a.y).toBe(cone.b.y)
    expect(Math.hypot(cone.a.x - cone.b.x, (cone.a.z ?? 0) - (cone.b.z ?? 0))).toBeGreaterThan(0)

    const radial = radialTree(s, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 2 })
    const r = (id: string) => Math.hypot(radial[id].x, radial[id].y)
    expect(r('root')).toBe(0)
    expect(r('a')).toBeGreaterThan(0)
    expect(r('a1')).toBeGreaterThan(r('a'))
  })

  it('is deterministic and handles a forest', () => {
    const forest = slice(['x', 'y', 'p', 'q'].map(node), [link('x', 'y'), link('p', 'q')])
    const a = coneTree(forest, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 3 })
    const b = coneTree(forest, { ...DEFAULT_LAYOUT_PARAMS, dimensions: 3 })
    expect(a).toEqual(b)
    expect(a.x).not.toEqual(a.p)
  })
})
