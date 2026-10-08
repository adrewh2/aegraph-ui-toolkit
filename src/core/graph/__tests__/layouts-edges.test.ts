import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import type { AnyEntity, Relationship } from '../../entity/types'
import type { GraphSlice } from '../filter'
import { BASE, bigViewLayout, isDynamicLayout, layoutTooBig, bounds, computeLayout, DEFAULT_LAYOUT_PARAMS, densestCell, fa2Settings, isHeavyLayout, LAYOUTS, mulberry32, NOVERLAP_CELL_LIMIT, pinnedPositions, removeOverlap, resolvePositions, type LayoutAlgorithm, type Positions } from '../layouts'
import Graph from 'graphology'

/**
 * The built-in layouts at their edges: every algorithm on an empty
 * slice, one node, two nodes, a self-loop and parallel edges, a
 * disconnected graph; a pinned node that is not in the slice; the 2D
 * form of 3D-only and the 3D form of 2D-only layouts; spacing and
 * iterations at their bounds; a centre node the slice lacks; an unknown
 * algorithm; the heavy thresholds algorithm by algorithm; the densest
 * cell with blanks and a custom grid; overlap removal on one node and
 * in 3D; resolving saved positions with every kind of fallback; bounds
 * of nothing and of 3D; the seeded random; the ForceAtlas2 settings.
 */
const slice = (nodes: AnyEntity[], edges: Relationship[] = []): GraphSlice => {
  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.id, 0)
  for (const e of edges) {
    degree.set(e.source.id, (degree.get(e.source.id) ?? 0) + 1)
    degree.set(e.target.id, (degree.get(e.target.id) ?? 0) + 1)
  }
  return { nodes, edges, degree, truncated: 0, candidates: nodes.length }
}
const N = (id: string, type = 't') => createEntity({ id, type, label: id })
const E = (id: string, s: string, t: string) => createRelationship({ id, type: 'r', source: s, target: t })
const P = { ...DEFAULT_LAYOUT_PARAMS, iterations: 30 }
const finite = (p: Positions) => Object.values(p).every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && (v.z === undefined || Number.isFinite(v.z)))
const BUILT_IN = LAYOUTS.filter((l) => !l.engine)

describe('every built-in layout', () => {
  it('returns nothing for an empty slice and a finite point for one node, in every dimension it offers', () => {
    for (const l of BUILT_IN) {
      for (const dims of l.dims) {
        expect(computeLayout(l.id, slice([]), { ...P, dimensions: dims }), l.id).toEqual({})
        const one = computeLayout(l.id, slice([N('a')]), { ...P, dimensions: dims })
        expect(Object.keys(one), l.id).toEqual(['a'])
        expect(finite(one), `${l.id} ${dims}D`).toBe(true)
        if (dims === 3 && l.id !== 'layered' && l.id !== 'circlepack') expect(one.a.z, `${l.id} z`).toBeDefined()
      }
    }
  })

  it('copes with two nodes, a self-loop, parallel edges and a disconnected graph, placing all and no two at one point', () => {
    const s = slice([N('a'), N('b', 'u'), N('c'), N('d', 'u')], [E('aa', 'a', 'a'), E('ab1', 'a', 'b'), E('ab2', 'a', 'b'), E('ba', 'b', 'a')])
    for (const l of BUILT_IN) {
      for (const dims of l.dims) {
        const out = computeLayout(l.id, s, { ...P, dimensions: dims })
        expect(Object.keys(out).sort(), l.id).toEqual(['a', 'b', 'c', 'd'])
        expect(finite(out), l.id).toBe(true)
        const spots = new Set(Object.values(out).map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${(v.z ?? 0).toFixed(3)}`))
        expect(spots.size, `${l.id} ${dims}D distinct`).toBe(4)
      }
    }
    const two = computeLayout('circular', slice([N('a'), N('b')]), P)
    expect(two.a.x).toBeCloseTo(BASE)
    expect(two.b.x).toBeCloseTo(-BASE) // opposite sides of the smallest circle
  })

  it('gives a 3D-only layout a circle in 2D, a 2D-only one no z in 3D, an unknown algorithm a grid, and a sphere its radius', () => {
    const s = slice([N('a'), N('b'), N('c')])
    expect(computeLayout('sphere', s, { ...P, dimensions: 2 })).toEqual(computeLayout('circular', s, { ...P, dimensions: 2 }))
    expect(computeLayout('layered', s, { ...P, dimensions: 3 }).a.z).toBeUndefined()
    expect(computeLayout('circlepack', s, { ...P, dimensions: 3 }).a.z).toBeUndefined()
    expect(computeLayout('nope' as LayoutAlgorithm, s, P)).toEqual(computeLayout('grid', s, P))
    const sph = computeLayout('sphere', s, { ...P, dimensions: 3 })
    for (const v of Object.values(sph)) expect(Math.hypot(v.x, v.y, v.z!)).toBeCloseTo(BASE * 2) // the smallest sphere
    expect(computeLayout('circular', s, { ...P, dimensions: 3 }).a.z).toBe(0)
  })

  it('takes spacing at zero and negative without failing, iterations at zero (at least twenty run), and a centre node the slice lacks', () => {
    const s = slice([N('a'), N('b'), N('c')], [E('ab', 'a', 'b')])
    for (const l of BUILT_IN) {
      expect(finite(computeLayout(l.id, s, { ...P, spacing: 0 })), `${l.id} spacing 0`).toBe(true)
      expect(finite(computeLayout(l.id, s, { ...P, spacing: -1 })), `${l.id} spacing -1`).toBe(true)
    }
    expect(Object.keys(computeLayout('grid', s, { ...P, spacing: 0 }))).toHaveLength(3) // every node at the origin: allowed
    expect(finite(computeLayout('force', s, { ...P, iterations: 0 }))).toBe(true)
    expect(finite(computeLayout('force', s, { ...P, iterations: 0, dimensions: 3 }))).toBe(true)
    const rad = computeLayout('radial-by-type', s, { ...P, centerId: 'zz' })
    expect(Object.values(rad).every((v) => v.x !== 0 || v.y !== 0)).toBe(true) // no node at the centre: the id is not here
    const con = computeLayout('concentric-by-degree', s, { ...P, centerId: 'zz' })
    expect(con.a).toEqual({ x: 0, y: 0 }) // the hub, by degree, still takes the middle
    expect(computeLayout('concentric-by-degree', s, { ...P, centerId: 'c' }).c).toEqual({ x: 0, y: 0 })
  })

  it('groups by type: grid and circular sort by type then label, clusters tile a macro grid, radial rings grow outward and stack in z', () => {
    const s = slice([N('b', 'y'), N('a', 'y'), N('c', 'x'), N('d', 'x'), N('e', 'x')])
    const g = computeLayout('grid', s, P)
    expect([g.c, g.d, g.e, g.a, g.b]).toEqual([{ x: 0, y: 0 }, { x: BASE, y: 0 }, { x: 2 * BASE, y: 0 }, { x: 0, y: BASE }, { x: BASE, y: BASE }]) // x before y, then by label
    const g3 = computeLayout('grid', slice(Array.from({ length: 9 }, (_, i) => N(`n${i}`))), { ...P, dimensions: 3 })
    expect(g3.n8).toEqual({ x: 2 * BASE, y: 2 * BASE, z: 0 }) // a cube of side ⌈∛9⌉ = 3
    const cl = computeLayout('clusters-by-type', s, P)
    expect(cl.c).toEqual({ x: 0, y: 0 })
    expect(cl.b.x).toBe((Math.ceil(Math.sqrt(3)) + 2) * BASE) // the second cluster one cell to the right, sized by the biggest
    expect(cl.a.x).toBe(cl.b.x + BASE)
    const r = computeLayout('radial-by-type', s, { ...P, dimensions: 3 })
    const ring = (id: string) => Math.hypot(r[id].x, r[id].y)
    expect(ring('c')).toBeCloseTo(BASE * 2) // the bigger type on the inner ring
    expect(ring('a')).toBeCloseTo(BASE * 4)
    expect([r.c.z, r.a.z]).toEqual([0, BASE * 2])
    const con = computeLayout('concentric-by-degree', slice(Array.from({ length: 12 }, (_, i) => N(`n${i}`))), P)
    const radii = new Set(Object.values(con).map((v) => Math.hypot(v.x, v.y).toFixed(3)))
    expect(radii.size).toBeGreaterThan(2) // the hub alone, then a ring of ⌊2π·60/40⌋ = 9, then the rest
  })

  it('keeps a pinned node only if the slice has it, leaves the rest to the layout, and skips overlap removal in 3D', () => {
    const s = slice([N('a'), N('b')])
    const previous = { a: { x: 5, y: 6 }, zz: { x: 1, y: 1 } }
    expect(pinnedPositions(s, previous, ['a', 'zz', 'b'])).toEqual({ a: { x: 5, y: 6 } })
    expect(pinnedPositions(s, undefined, ['a'])).toEqual({})
    const out = computeLayout('grid', s, P, previous, ['a', 'zz'])
    expect(out.a).toEqual({ x: 5, y: 6 })
    expect(out).not.toHaveProperty('zz')
    const stacked = { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 } }
    expect(removeOverlap(s, stacked, { ...P, dimensions: 2 })).not.toEqual(stacked)
    expect(computeLayout('random', s, { ...P, dimensions: 3, noverlap: true, seed: 3 })).toEqual(computeLayout('random', s, { ...P, dimensions: 3, noverlap: false, seed: 3 }))
    expect(removeOverlap(slice([N('a')]), { a: { x: 0, y: 0 } }, P)).toEqual({ a: { x: 0, y: 0 } })
    expect(removeOverlap(s, {}, P)).toEqual({})
  })
})

describe('thresholds and helpers', () => {
  it('judges heaviness algorithm by algorithm, never for no nodes, and always for an engine', () => {
    expect(isHeavyLayout('force', 0)).toBe(false)
    expect(isHeavyLayout('elk-layered', 0)).toBe(false)
    expect(isHeavyLayout('elk-layered', 1)).toBe(true)
    expect(isHeavyLayout('spectral', 1)).toBe(true)
    expect(isHeavyLayout('layered', 299)).toBe(false)
    expect(isHeavyLayout('layered', 300)).toBe(true)
    expect(isHeavyLayout('circlepack', 19999)).toBe(false)
    expect(isHeavyLayout('circlepack', 20000)).toBe(true)
    for (const id of ['grid', 'circular', 'radial-by-type', 'clusters-by-type', 'concentric-by-degree', 'sphere', 'random'] as const) expect(isHeavyLayout(id, 1e9), id).toBe(false)
  })

  it('finds the densest cell over finite points only, with a custom grid, and counts one or none', () => {
    expect(densestCell({}, [])).toBe(0)
    expect(densestCell({ a: { x: 1, y: 1 } }, ['a', 'missing'])).toBe(1)
    expect(densestCell({ a: { x: NaN, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 0 } }, ['a', 'b', 'c'])).toBe(2)
    const line = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, { x: i, y: 0 }]))
    expect(densestCell(line, Object.keys(line), 1)).toBe(10)
    expect(densestCell(line, Object.keys(line), 10)).toBe(1) // ten points over ten cells: one each, the last clamped into the last cell
    expect(densestCell({ a: { x: 3, y: 3 }, b: { x: 3, y: 3 } }, ['a', 'b'])).toBe(2) // a flat extent still counts
    expect(NOVERLAP_CELL_LIMIT).toBe(1000)
  })

  it('resolves saved positions: copies, newcomers to the right of the cloud by the fallback (a grid for layered, circlepack and engines), nothing missing', () => {
    const s = slice([N('a'), N('b'), N('c')])
    const saved = { a: { x: -10, y: 0, z: 5 }, b: { x: 10, y: 0 } }
    const r = resolvePositions(s, saved, 'grid', P)
    expect(r.unplaced).toBe(1)
    expect(r.positions.a).toEqual({ x: -10, y: 0, z: 5 })
    expect(r.positions.a).not.toBe(saved.a)
    expect(r.positions.c.x).toBeCloseTo(Math.hypot(-10, 0, 5) + BASE * 2) // just past the cloud's radius, z counted
    expect(r.positions.c.y).toBe(0)
    expect(resolvePositions(s, { a: saved.a, b: saved.b, c: { x: 1, y: 1 } }, 'grid', P)).toEqual({ positions: { a: saved.a, b: saved.b, c: { x: 1, y: 1 } }, unplaced: 0 })
    expect(resolvePositions(s, undefined, 'grid', P)).toEqual({ positions: computeLayout('grid', s, P), unplaced: 0 })
    for (const fb of ['layered', 'circlepack', 'elk-stress', 'spectral'] as const) expect(resolvePositions(s, saved, fb, P).positions.c, fb).toEqual(r.positions.c)
    const all = resolvePositions(s, {}, 'circular', P)
    expect(all.unplaced).toBe(3)
    expect(Object.values(all.positions).every((v) => v.x >= BASE * 2 - BASE)).toBe(true) // the whole circle shifted right of an empty cloud
  })

  it('bounds nothing to zeros and everything else in 3D with a missing z as 0; the seeded random is stable and in [0, 1)', () => {
    expect(bounds({})).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 })
    expect(bounds({ a: { x: -1, y: 2 }, b: { x: 3, y: -4, z: 9 } })).toEqual({ minX: -1, minY: -4, minZ: 0, maxX: 3, maxY: 2, maxZ: 9 })
    const r1 = mulberry32(7)
    const r2 = mulberry32(7)
    const xs = Array.from({ length: 5 }, () => r1())
    expect(xs).toEqual(Array.from({ length: 5 }, () => r2()))
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(mulberry32(8)()).not.toBe(xs[0])
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)())
  })

  it('derives ForceAtlas2 settings from the params: scaling by spacing, weights only with a field, Barnes–Hut past 500 nodes', () => {
    const g = new Graph()
    g.addNode('a')
    const s = fa2Settings(g, { ...P, spacing: 2, scalingRatio: 5, gravity: 3, linLogMode: true, strongGravity: true })
    expect(s).toMatchObject({ scalingRatio: 10, gravity: 3, linLogMode: true, strongGravityMode: true, edgeWeightInfluence: 0, barnesHutOptimize: false, adjustSizes: false })
    expect(fa2Settings(g, { ...P, weightField: 'data.w' }).edgeWeightInfluence).toBe(1)
    expect(fa2Settings(g, { ...P, weightField: 'data.w', edgeWeightInfluence: 0.5 }).edgeWeightInfluence).toBe(0.5)
    expect(fa2Settings(g, { ...P, edgeWeightInfluence: 0.5 }).edgeWeightInfluence).toBe(0.5)
    for (let i = 0; i < 500; i++) g.addNode(`n${i}`)
    expect(fa2Settings(g, P).barnesHutOptimize).toBe(true)
  })
})

describe('the layout a big view with no positions gets', () => {
  it('is Unigraph’s force on WebGPU, the multilevel layout without it — never ForceAtlas2', () => {
    expect(bigViewLayout(true)).toBe('unigraph-force')
    expect(bigViewLayout(false)).toBe('multilevel')
  })
})

describe('multilevel', () => {
  it('places every node, keeps a pinned one, and gives z only in 3D', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => N(`n${i}`))
    const edges: Relationship[] = []
    // Two planted communities, a bridge between them, and two isolated nodes.
    for (let i = 0; i < 18; i++) edges.push(E(`a${i}`, `n${i}`, `n${(i + 1) % 19}`))
    for (let i = 19; i < 37; i++) edges.push(E(`b${i}`, `n${i}`, `n${i + 1}`))
    edges.push(E('bridge', 'n3', 'n25'))
    const s = slice(nodes, edges)
    const flat = computeLayout('multilevel', s, { ...P, dimensions: 2 })
    expect(Object.keys(flat)).toHaveLength(40)
    for (const id in flat) {
      expect(Number.isFinite(flat[id].x)).toBe(true)
      expect(flat[id].z).toBeUndefined()
    }
    const deep = computeLayout('multilevel', s, { ...P, dimensions: 3 })
    expect(Object.values(deep).some((p) => (p.z ?? 0) !== 0)).toBe(true)
    // A pinned node stays where it was.
    const previous: Positions = { n5: { x: 999, y: -999 } }
    const pinned = computeLayout('multilevel', s, { ...P, dimensions: 2 }, previous, ['n5'])
    expect(pinned.n5).toEqual({ x: 999, y: -999 })
    // Nodes of one community sit nearer each other than nodes across the bridge.
    const d = (a: string, b: string, p: Positions) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y)
    expect(d('n1', 'n2', flat)).toBeLessThan(d('n1', 'n30', flat))
    expect(computeLayout('multilevel', slice([]), P)).toEqual({})
    expect(isHeavyLayout('multilevel', 19999)).toBe(false)
    expect(isHeavyLayout('multilevel', 20000)).toBe(true)
    expect(LAYOUTS.find((l) => l.id === 'multilevel')?.dims).toEqual([2, 3])
  })
})

describe('unigraph-force', () => {
  it('runs the force model on the CPU from a multilevel seed, or from the previous positions', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => N(`n${i}`))
    const edges: Relationship[] = []
    for (let i = 0; i < 29; i++) edges.push(E(`e${i}`, `n${i}`, `n${i + 1}`))
    const s = slice(nodes, edges)
    const out = computeLayout('unigraph-force', s, { ...P, iterations: 40, unigraph: { repulsion: 0.2, linkDistance: 10, linkStrength: 0.35, gravity: 0.25, damping: 0.6, alphaDecay: 0.02 } })
    expect(Object.keys(out)).toHaveLength(30)
    for (const id in out) expect(Number.isFinite(out[id].x + out[id].y)).toBe(true)
    // A chain settles with neighbours nearer than the ends.
    const d = (a: string, b: string) => Math.hypot(out[a].x - out[b].x, out[a].y - out[b].y)
    expect(d('n0', 'n1')).toBeLessThan(d('n0', 'n29'))
    // Seeded from previous positions, a pinned node stays put and the others start from where they were.
    const previous: Positions = {}
    for (let i = 0; i < 30; i++) previous[`n${i}`] = { x: i * 10, y: 0 }
    const again = computeLayout('unigraph-force', s, { ...P, iterations: 5 }, previous, ['n0'])
    expect(again.n0).toEqual({ x: 0, y: 0 })
    // Five iterations from a line: it contracts toward the centre from where it was — its far half ahead of its
    // start (within the far half, links of different strengths bunch it, so its order there is not kept).
    expect(again.n15.x).toBeGreaterThan(again.n1.x)
    expect(again.n29.x).toBeGreaterThan(again.n1.x)
    expect(isHeavyLayout('unigraph-force', 499)).toBe(false)
    expect(isHeavyLayout('unigraph-force', 500)).toBe(true)
    expect(LAYOUTS.find((l) => l.id === 'unigraph-force')?.uses).toContain('unigraph')
  })
})

describe('layouts that do not scale', () => {
  it('are refused past their limit, with the limit and what to use instead', () => {
    expect(layoutTooBig('layered', 300)).toBeUndefined()
    expect(layoutTooBig('layered', 301)).toMatch(/lays out at most 300 nodes .* this view has 301\. Force \(Unigraph\) or Multilevel lay out any size\./)
    expect(layoutTooBig('force', 25_000)).toBeUndefined()
    expect(layoutTooBig('force', 25_001)).toBeDefined()
    // The ones that scale — linear, or budgeted on the CPU — have no limit.
    for (const a of ['unigraph-force', 'multilevel', 'tree', 'circlepack', 'grid', 'radial-by-type'] as LayoutAlgorithm[]) expect(layoutTooBig(a, 5_000_000)).toBeUndefined()
    // A limit is never under the comfortable range the panel warns about.
    for (const l of LAYOUTS) if (l.maxNodes !== undefined) expect(l.maxNodes).toBeGreaterThanOrEqual(l.softLimit)
  })

  it('lists Force (Unigraph) first among the simulations', () => {
    expect(LAYOUTS.filter((l) => isDynamicLayout(l.id)).map((l) => l.id)).toEqual(['unigraph-force', 'force'])
  })
})
