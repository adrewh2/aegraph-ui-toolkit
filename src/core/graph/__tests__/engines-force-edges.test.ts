import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import cola from '../engines/cola'
import ngraph from '../engines/ngraph'
import { applyFilter, emptyFilter, type GraphSlice } from '../filter'
import type { EngineFn } from '../layoutEngines'
import { DEFAULT_LAYOUT_PARAMS, mulberry32, type LayoutParams, type Positions } from '../layouts'
import '../types'

/**
 * The two force engines at their edges: nothing, one node, two unlinked,
 * many components, a complete graph, self-loops, parallel edges and edges
 * to nodes outside the slice, iterations at zero and below, spacing at
 * zero and huge, refining from held positions (the picture keeps its
 * shape), fixed nodes, determinism from the seed, 3D, a thousand nodes.
 */
function graph(n: number, edges: [number, number][]): GraphSlice {
  const s = new EntityStore()
  s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `n${i}` })))
  s.upsertMany(edges.map(([a, b], i) => createRelationship({ id: `e${i}`, type: 'r', source: `n${a}`, target: `n${b}` })))
  return applyFilter(s, new TypeRegistry(s), emptyFilter())
}
const path = (n: number) => graph(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]))
const input = (slice: GraphSlice, extra: Partial<LayoutParams> = {}, more: { previous?: Positions; fixed?: string[]; seed?: number } = {}) => ({ slice, params: { ...DEFAULT_LAYOUT_PARAMS, iterations: 60, ...extra }, previous: more.previous, fixed: new Set(more.fixed ?? []), rnd: mulberry32(more.seed ?? 1) })
const finite = (p: { x: number; y: number; z?: number }) => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.z === undefined || Number.isFinite(p.z))
const spots = (out: Positions) => new Set(Object.values(out).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${(p.z ?? 0).toFixed(2)}`))
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
/** Spearman rank correlation of two equal-length series. */
function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((_, i) => i).sort((i, j) => v[i] - v[j])
    const r = new Array<number>(v.length)
    order.forEach((i, k) => (r[i] = k))
    return r
  }
  const ra = rank(a), rb = rank(b)
  const n = a.length
  let d2 = 0
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2
  return 1 - (6 * d2) / (n * (n * n - 1))
}
const ENGINES: [string, EngineFn][] = [['cola', cola], ['ngraph', ngraph]]

describe.each(ENGINES)('%s edges', (name, engine) => {
  it('places nothing for an empty graph, one node and two unlinked nodes finitely and apart, in 2D and 3D', async () => {
    for (const dimensions of [2, 3] as const) {
      expect(await engine(name as never, input(graph(0, []), { dimensions })), `${dimensions}D empty`).toEqual({})
      const one = await engine(name as never, input(graph(1, []), { dimensions }))
      expect(Object.keys(one)).toEqual(['n0'])
      expect(finite(one.n0)).toBe(true)
      expect(one.n0.z === undefined, `${dimensions}D z`).toBe(dimensions === 2)
      const two = await engine(name as never, input(graph(2, []), { dimensions }))
      expect(Object.values(two).every(finite)).toBe(true)
      expect(dist(two.n0, two.n1)).toBeGreaterThan(1)
    }
  }, 30000)

  it('lays out ten components and a complete graph with every node finite and on its own spot', async () => {
    const edges: [number, number][] = []
    for (let p = 0; p < 10; p++) edges.push([3 * p, 3 * p + 1], [3 * p + 1, 3 * p + 2], [3 * p + 2, 3 * p])
    const out = await engine(name as never, input(graph(30, edges)))
    expect(Object.keys(out).length).toBe(30)
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(30)
    // A triangle's members stay closer to each other than the picture is wide.
    const xs = Object.values(out).map((p) => p.x), ys = Object.values(out).map((p) => p.y)
    const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    for (let p = 0; p < 10; p++) expect(dist(out[`n${3 * p}`], out[`n${3 * p + 1}`]), `triangle ${p}`).toBeLessThan(extent / 2)
    const k: [number, number][] = []
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) k.push([i, j])
    const complete = await engine(name as never, input(graph(6, k)))
    expect(Object.values(complete).every(finite)).toBe(true)
    expect(spots(complete).size).toBe(6)
  }, 30000)

  it('ignores self-loops, takes parallel edges without harm, and skips an edge to a node outside the slice', async () => {
    const slice = graph(4, [[0, 0], [0, 1], [0, 1], [1, 0], [1, 2], [2, 3]])
    const out = await engine(name as never, input(slice))
    expect(Object.keys(out).length).toBe(4)
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(4)
    const stray = { ...slice, edges: [...slice.edges, { ...slice.edges[1], id: 'gone', target: { id: 'nope' } }] } as GraphSlice
    expect(await engine(name as never, input(stray))).toEqual(out)
  }, 30000)

  it('clamps iterations at zero and below to the minimum, and survives spacing at zero and at a million', async () => {
    const slice = path(8)
    const floor = await engine(name as never, input(slice, { iterations: 20 }))
    expect(await engine(name as never, input(slice, { iterations: 0 }))).toEqual(floor)
    expect(await engine(name as never, input(slice, { iterations: -5 }))).toEqual(floor)
    expect(await engine(name as never, input(slice, { iterations: 1e9 }))).not.toEqual(floor) // capped high, but well past the floor
    for (const spacing of [0, 1e6]) {
      const out = await engine(name as never, input(slice, { spacing }))
      expect(Object.values(out).every(finite), `spacing ${spacing}`).toBe(true)
      expect(Object.keys(out).length, `spacing ${spacing}`).toBe(8)
    }
  }, 30000)

  it('refines held positions rather than reshuffling: a path laid on a line keeps its order', async () => {
    const n = 24
    const slice = path(n)
    const previous: Positions = {}
    for (let i = 0; i < n; i++) previous[`n${i}`] = { x: i * 60, y: ((i * 7919) % 11) - 5 }
    const out = await engine(name as never, input(slice, { iterations: 60 }, { previous }))
    expect(Object.values(out).every(finite)).toBe(true)
    const before = Array.from({ length: n }, (_, i) => previous[`n${i}`].x)
    const after = Array.from({ length: n }, (_, i) => out[`n${i}`].x)
    expect(spearman(before, after)).toBeGreaterThan(0.95)
    expect(after).not.toEqual(before) // it did move
  }, 30000)

  it('keeps fixed nodes exactly where they were and moves the rest around them', async () => {
    const slice = path(6)
    const previous: Positions = {}
    for (let i = 0; i < 6; i++) previous[`n${i}`] = { x: i * 100 - 250, y: 0 }
    const out = await engine(name as never, input(slice, {}, { previous, fixed: ['n0', 'n5'] }))
    expect(out.n0).toEqual({ x: -250, y: 0 })
    expect(out.n5).toEqual({ x: 250, y: 0 })
    expect(Object.values(out).every(finite)).toBe(true)
    // The rest still sit between the two anchors.
    for (let i = 1; i < 5; i++) expect(out[`n${i}`].x, `n${i}`).toBeGreaterThan(-250)
    for (let i = 1; i < 5; i++) expect(out[`n${i}`].x, `n${i}`).toBeLessThan(250)
  }, 30000)

  it('is deterministic from the seed and different for another seed, in 2D and 3D', async () => {
    const slice = graph(12, [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [0, 4], [7, 8], [9, 10], [10, 11]])
    for (const dimensions of [2, 3] as const) {
      const a = await engine(name as never, input(slice, { dimensions }, { seed: 7 }))
      const b = await engine(name as never, input(slice, { dimensions }, { seed: 7 }))
      const c = await engine(name as never, input(slice, { dimensions }, { seed: 8 }))
      expect(b, `${dimensions}D`).toEqual(a)
      expect(c, `${dimensions}D`).not.toEqual(a)
      expect(Object.values(a).every(finite)).toBe(true)
      if (dimensions === 3) expect(Object.values(a).some((p) => p.z !== 0)).toBe(true)
    }
  }, 30000)

  it('a thousand nodes with a thousand edges lay out in bounds', async () => {
    const n = 1000
    let seed = 3
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const edges: [number, number][] = []
    for (let i = 1; i < n; i++) edges.push([i, Math.floor(rnd() * i)])
    const slice = graph(n, edges)
    const t = performance.now()
    const out = await engine(name as never, input(slice, { iterations: 40 }))
    const ms = performance.now() - t
    expect(Object.keys(out).length).toBe(n)
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBeGreaterThan(n * 0.95)
    // Alone: ngraph ~0.2 s, cola ~7 s (overlap avoidance is quadratic-ish; its soft limit is 1,500). Under a loaded machine both stretch several-fold.
    expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(name === 'cola' ? 90000 : 15000)
  }, 120000)
})
