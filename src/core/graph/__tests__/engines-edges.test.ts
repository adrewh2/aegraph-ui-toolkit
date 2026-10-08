import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import elk from '../engines/elk'
import spectral from '../engines/spectral'
import { applyFilter, emptyFilter, type GraphSlice } from '../filter'
import { computeLayoutAsync } from '../layoutEngines'
import { DEFAULT_LAYOUT_PARAMS, mulberry32, type LayoutAlgorithm, type Positions } from '../layouts'
import '../types'

/**
 * The spectral and ELK engines at their edges: nothing, one node, two nodes
 * with no edge, many components, a complete graph (every non-trivial
 * eigenvalue zero), self-loops and parallel edges, edges to nodes outside
 * the slice, the ELK ceilings on nodes and on edges, a path (finite,
 * distinct, in order), determinism, three nodes in 3D, an unknown ELK
 * algorithm, and a pinned node. Weights: neither engine reads any — a
 * NaN or negative weight cannot reach them. Cancelling: the contract has
 * no signal; a run is abandoned by ending its worker.
 */
function graph(n: number, edges: [number, number][], opts: { directed?: boolean; ids?: string[] } = {}): GraphSlice {
  const s = new EntityStore()
  const ids = opts.ids ?? Array.from({ length: n }, (_, i) => `n${i}`)
  s.upsertMany(ids.map((id) => createEntity({ id, type: 'note', label: id })))
  s.upsertMany(edges.map(([a, b], i) => createRelationship({ id: `e${i}`, type: 'r', source: ids[a], target: ids[b], directed: opts.directed ?? true })))
  return applyFilter(s, new TypeRegistry(s), emptyFilter())
}
const input = (slice: GraphSlice, extra: Partial<typeof DEFAULT_LAYOUT_PARAMS> = {}) => ({ slice, params: { ...DEFAULT_LAYOUT_PARAMS, ...extra }, fixed: new Set<string>(), rnd: mulberry32(1) })
const finite = (p: { x: number; y: number; z?: number }) => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.z === undefined || Number.isFinite(p.z))
const spots = (out: Record<string, { x: number; y: number; z?: number }>) => new Set(Object.values(out).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${(p.z ?? 0).toFixed(3)}`))
// The engine contract allows a promise; spectral answers at once.
const spectralNow = (...args: Parameters<typeof spectral>) => spectral(...args) as Positions
const ELK: LayoutAlgorithm[] = ['elk-layered', 'elk-stress', 'elk-mrtree', 'elk-radial']

describe('spectral edges', () => {
  it('places nothing for an empty graph, one node at the origin, and two unlinked nodes apart', () => {
    expect(spectralNow('spectral', input(graph(0, [])))).toEqual({})
    expect(spectralNow('spectral', input(graph(1, [])))).toEqual({ n0: { x: 0, y: 0 } })
    expect(spectralNow('spectral', input(graph(1, []), { dimensions: 3 }))).toEqual({ n0: { x: 0, y: 0, z: 0 } })
    const two = spectralNow('spectral', input(graph(2, [])))
    expect(two.n0).toEqual({ x: 0, y: 0 })
    expect(finite(two.n1) && Math.hypot(two.n1.x, two.n1.y) > 100).toBe(true)
  })

  it('gives the largest component the spectrum and rings the rest, grouped by component, no two on one spot', () => {
    // One component of 8 with no two nodes alike (structurally equivalent nodes share a spectral spot by nature), then ten pairs.
    const edges: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2], [2, 3], [3, 4], [4, 5], [4, 6], [5, 6], [6, 7], [2, 7]]
    for (let p = 0; p < 10; p++) edges.push([8 + 2 * p, 9 + 2 * p])
    const slice = graph(28, edges)
    const out = spectralNow('spectral', input(slice))
    expect(Object.keys(out).length).toBe(28)
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(28)
    const main = Array.from({ length: 8 }, (_, i) => out[`n${i}`])
    const rMain = Math.max(...main.map((p) => Math.hypot(p.x, p.y)))
    const ring = Array.from({ length: 20 }, (_, i) => Math.hypot(out[`n${8 + i}`].x, out[`n${8 + i}`].y))
    expect(Math.min(...ring)).toBeGreaterThan(rMain)
    expect(Math.max(...ring) - Math.min(...ring)).toBeLessThan(1e-6) // one radius
    // Pairs sit next to each other on the ring.
    for (let p = 0; p < 10; p++) {
      const a = out[`n${8 + 2 * p}`], b = out[`n${9 + 2 * p}`]
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(rMain)
    }
  })

  it('a complete graph, whose every non-trivial eigenvalue is zero, still gets distinct finite spots', () => {
    const edges: [number, number][] = []
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) edges.push([i, j])
    const out = spectralNow('spectral', input(graph(6, edges)))
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(6)
  })

  it('ignores self-loops, counts parallel edges twice without harm, skips edges to nodes outside the slice, and reads no weight', () => {
    const slice = graph(4, [[0, 0], [0, 1], [0, 1], [1, 0], [1, 2], [2, 3]])
    const out = spectralNow('spectral', input(slice))
    expect(Object.keys(out).length).toBe(4)
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(4)
    const stray = { ...slice, edges: [...slice.edges, { ...slice.edges[1], id: 'gone', target: { id: 'nope' } }] } as GraphSlice
    expect(spectralNow('spectral', input(stray))).toEqual(out)
    const weighted = { ...slice, edges: slice.edges.map((e) => ({ ...e, data: { weight: NaN } })) } as GraphSlice
    expect(spectralNow('spectral', input(weighted, { weightField: 'data.weight', edgeWeightInfluence: 1 }))).toEqual(out)
  })

  it('a path comes out finite, all distinct, each node nearest its neighbours; the same twice; three nodes in 3D have no z', () => {
    const n = 30
    const slice = graph(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]))
    const out = spectralNow('spectral', input(slice))
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(n)
    // Not a straight line: three hundred power iterations cannot separate a long path's near-equal leading
    // eigenvalues, so the curve folds. What holds is smoothness — a step along the path is a short step in the picture.
    const d = (a: number, b: number) => Math.hypot(out[`n${a}`].x - out[`n${b}`].x, out[`n${a}`].y - out[`n${b}`].y)
    const all: number[] = []
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) all.push(d(a, b))
    const median = all.sort((p, q) => p - q)[Math.floor(all.length / 2)]
    for (let i = 1; i < n; i++) expect(d(i - 1, i), `step ${i}`).toBeLessThan(median / 2)
    expect(spectralNow('spectral', input(slice))).toEqual(out)
    // Larger than any picture needs, still quick: a thousand-node path.
    const t = performance.now()
    const big = spectralNow('spectral', input(graph(1000, Array.from({ length: 999 }, (_, i) => [i, i + 1] as [number, number]))))
    expect(performance.now() - t).toBeLessThan(5000)
    expect(spots(big).size).toBe(1000)
    // Three nodes: only two eigenvectors exist beyond the trivial one, so the third axis is flat.
    const tri = spectralNow('spectral', input(graph(3, [[0, 1], [1, 2]]), { dimensions: 3 }))
    expect(Object.values(tri).map((p) => p.z)).toEqual([0, 0, 0])
    expect(spots(tri).size).toBe(3)
  })
})

describe('ELK edges', () => {
  it('places nothing for an empty graph and one node finitely, for every algorithm and an unknown one', async () => {
    for (const alg of [...ELK, 'elk-nonesuch' as LayoutAlgorithm]) {
      expect(await elk(alg, input(graph(0, []))), alg).toEqual({})
      const one = await elk(alg, input(graph(1, [])))
      expect(Object.keys(one), alg).toEqual(['n0'])
      expect(finite(one.n0), alg).toBe(true)
    }
  }, 30000)

  it('two unlinked nodes and ten components land apart, no two on one spot', async () => {
    for (const alg of ELK) {
      const two = await elk(alg, input(graph(2, [])))
      expect(spots(two).size, alg).toBe(2)
      const edges: [number, number][] = []
      for (let p = 0; p < 10; p++) edges.push([3 * p, 3 * p + 1], [3 * p, 3 * p + 2])
      const out = await elk(alg, input(graph(30, edges)))
      expect(Object.keys(out).length, alg).toBe(30)
      expect(Object.values(out).every(finite), alg).toBe(true)
      expect(spots(out).size, alg).toBe(30)
    }
  }, 60000)

  it('drops self-loops, parallel and reversed pairs, and edges to nodes outside the slice; a complete graph lays out', async () => {
    const slice = graph(4, [[0, 0], [0, 1], [0, 1], [1, 0], [1, 2], [2, 3]], { directed: false })
    const stray = { ...slice, edges: [...slice.edges, { ...slice.edges[1], id: 'gone', target: { id: 'nope' } }] } as GraphSlice
    for (const alg of ELK) {
      const out = await elk(alg, input(slice))
      expect(Object.keys(out).length, alg).toBe(4)
      expect(spots(out).size, alg).toBe(4)
      expect(await elk(alg, input(stray)), alg).toEqual(out)
    }
    const edges: [number, number][] = []
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) edges.push([i, j])
    for (const alg of ELK) {
      const out = await elk(alg, input(graph(6, edges)))
      expect(Object.values(out).every(finite), alg).toBe(true)
      expect(spots(out).size, alg).toBe(6)
    }
  }, 60000)

  it('refuses a graph past its ceiling on nodes or on edges, naming both counts, before starting the engine', async () => {
    const nodes = graph(8001, [])
    await expect(elk('elk-mrtree', input(nodes))).rejects.toThrow(/mrtree handles up to 8,000 nodes and 40,000 edges; this view has 8,001 and 0/)
    await expect(elk('elk-radial', input(nodes))).rejects.toThrow(/up to 8,000/)
    const small = graph(3, [[0, 1]])
    const dense = { ...small, edges: Array.from({ length: 20001 }, (_, i) => ({ ...small.edges[0], id: `p${i}` })) } as GraphSlice
    await expect(elk('elk-layered', input(dense))).rejects.toThrow(/20,000 edges; this view has 3 and 20,001/)
    await expect(elk('elk-stress', input(dense))).rejects.toThrow(/up to 3,000 nodes/)
    // Under the ceiling, the twenty thousand parallel edges collapse to one and the layout is instant.
    const t = performance.now()
    const out = await elk('elk-mrtree', input(dense))
    expect(performance.now() - t).toBeLessThan(5000)
    expect(spots(out).size).toBe(3)
  }, 30000)

  it('a path is finite, distinct and in layer order; the same twice; a pinned node stays put through the pipeline', async () => {
    const n = 20
    const slice = graph(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]))
    const out = await elk('elk-layered', input(slice))
    expect(Object.values(out).every(finite)).toBe(true)
    expect(spots(out).size).toBe(n)
    for (let i = 1; i < n; i++) expect(out[`n${i}`].y, `y${i}`).toBeLessThan(out[`n${i - 1}`].y)
    expect(await elk('elk-layered', input(slice))).toEqual(out)
    for (const alg of ['elk-stress', 'elk-mrtree', 'elk-radial'] as const) {
      const o = await elk(alg, input(slice))
      expect(spots(o).size, alg).toBe(n)
      expect(await elk(alg, input(slice)), alg).toEqual(o)
    }
    const previous = { n5: { x: 4321, y: 99 } }
    const pinned = await computeLayoutAsync('elk-layered', slice, DEFAULT_LAYOUT_PARAMS, previous, ['n5'])
    expect(pinned.n5).toEqual({ x: 4321, y: 99 })
    expect(Object.keys(pinned).length).toBe(n)
  }, 60000)
})
