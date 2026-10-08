import { describe, expect, it } from 'vitest'
import type { ProjectionData } from '../../../core/graph/projection'
import { descendants, fitGroups, groupAt, moveGroup, normalizeGroups, setMembership } from '../groups'

const base = (): ProjectionData => ({
  kind: '2d',
  width: 800,
  height: 600,
  nodes: {
    a: { x: 100, y: 100, width: 80, height: 40 },
    b: { x: 260, y: 100, width: 80, height: 40 },
    c: { x: 500, y: 300, width: 80, height: 40 },
  },
  edges: { ab: { points: [{ x: 140, y: 100 }, { x: 220, y: 100 }], curve: 'line' }, bc: { points: [{ x: 300, y: 100 }, { x: 460, y: 300 }], curve: 'line' } },
  groups: {
    g1: { x: 40, y: 50, width: 280, height: 100, title: 'Pair' }, // contains a and b, no members listed
    outer: { x: 20, y: 30, width: 600, height: 340, title: 'All' },
  },
})

describe('display scene groups', () => {
  it('normalizes members, parents and padding from captured boxes', () => {
    const d = normalizeGroups(base())
    expect(d.groups.g1.members).toEqual(['a', 'b'])
    expect(d.groups.g1.parent).toBe('outer')
    expect(d.groups.outer.members).toEqual(['c'])
    expect(d.groups.g1.pad).toEqual({ l: 20, t: 30, r: 20, b: 30 })
    expect(descendants(d.groups, 'outer').sort()).toEqual(['a', 'b', 'c'])
  })

  it('refits a group when a member moves, and the parent follows', () => {
    const d = normalizeGroups(base())
    const moved = { ...d, nodes: { ...d.nodes, b: { ...d.nodes.b, x: 400 } } }
    const fit = fitGroups(moved)
    expect(fit.groups.g1.x + fit.groups.g1.width).toBe(400 + 40 + 20)
    expect(fit.groups.outer.x + fit.groups.outer.width).toBeGreaterThanOrEqual(fit.groups.g1.x + fit.groups.g1.width)
  })

  it('moves a group with its members, nested groups, and internal routes', () => {
    const d = fitGroups(normalizeGroups(base()))
    const m = moveGroup(d, 'g1', 10, 20, [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
    ])
    expect(m.nodes.a).toMatchObject({ x: 110, y: 120 })
    expect(m.nodes.c).toMatchObject({ x: 500, y: 300 })
    expect(m.edges.ab.points[0]).toEqual({ x: 150, y: 120 })
    expect(m.edges.bc).toBeUndefined()
    expect(m.groups.g1.x).toBe(d.groups.g1.x + 10)
  })

  it('finds the deepest group under a point and changes membership', () => {
    const d = fitGroups(normalizeGroups(base()))
    expect(groupAt(d, { x: 100, y: 100 })).toBe('g1')
    expect(groupAt(d, { x: 500, y: 300 })).toBe('outer')
    expect(groupAt(d, { x: 790, y: 590 })).toBeUndefined()
    const s = fitGroups(setMembership(d, 'c', 'g1'))
    expect(s.groups.g1.members).toEqual(['a', 'b', 'c'])
    expect(s.groups.outer.members).toEqual([])
    expect(s.groups.g1.x + s.groups.g1.width).toBeGreaterThanOrEqual(540)
  })
})
