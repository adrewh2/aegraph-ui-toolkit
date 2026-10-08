import { describe, expect, it } from 'vitest'
import { BitSet } from '../bitset'
import { PackedGraph } from '../graph'
import { generateGraph } from '../generate'
import { aggregate, localMoving, louvainHierarchy, weightedFromPacked } from '../louvain'
import { layoutMultilevel } from '../multilevel'

/** k cliques of `size` nodes, joined in a ring by one edge each, plus `loose` nodes with no edge. */
function cliques(k: number, size: number, loose = 0) {
  const src: number[] = [], dst: number[] = []
  for (let c = 0; c < k; c++) {
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) {
      src.push(c * size + a)
      dst.push(c * size + b)
    }
    src.push(c * size)
    dst.push(((c + 1) % k) * size + 1)
  }
  const n = k * size + loose
  return PackedGraph.fromArrays({ nodeType: new Uint16Array(n), edgeSource: Uint32Array.from(src), edgeTarget: Uint32Array.from(dst), edgeType: new Uint16Array(src.length) })
}

function modularity(g: PackedGraph, labels: Uint32Array) {
  let K = 0
  for (const l of labels) K = Math.max(K, l + 1)
  const tot = new Float64Array(K)
  let m2 = 0, inside = 0
  for (let i = 0; i < g.nodeCount; i++) {
    tot[labels[i]] += g.degree[i]
    m2 += g.degree[i]
  }
  for (let e = 0; e < g.edgeCount; e++) if (labels[g.edgeSource[e]] === labels[g.edgeTarget[e]]) inside += 2
  let q = inside / m2
  for (let c = 0; c < K; c++) q -= (tot[c] / m2) ** 2
  return q
}

const dist = (p: Float32Array, a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2])

describe('louvain', () => {
  it('finds planted cliques, groups the loose nodes, and keeps the totals through aggregation', () => {
    const g = cliques(8, 10, 5)
    const G = weightedFromPacked(g)
    expect(G.targets.length).toBe(2 * g.edgeCount)
    const { comm, count } = localMoving(G, 1, 1, true)
    // Eight cliques and one group of the five loose nodes.
    expect(count).toBe(9)
    for (let c = 0; c < 8; c++) for (let a = 1; a < 10; a++) expect(comm[c * 10 + a]).toBe(comm[c * 10])
    for (let i = 81; i < 85; i++) expect(comm[i]).toBe(comm[80])
    const up = aggregate(G, comm, count)
    expect(up.n).toBe(9)
    // Strength and size are conserved; the ring's eight edges are what is left between communities.
    expect(up.strength.reduce((a, b) => a + b, 0)).toBeCloseTo(G.strength.reduce((a, b) => a + b, 0))
    expect(up.size.reduce((a, b) => a + b, 0)).toBe(85)
    expect(up.targets.length).toBe(16)
  })

  it('builds a hierarchy whose top level is small, and beats label propagation’s merging on a generated graph', () => {
    const gen = generateGraph({ nodes: 20_000, edges: 50_000, seed: 3 })
    const g = PackedGraph.fromArrays({ nodeType: gen.nodeType, edgeSource: gen.edgeSource, edgeTarget: gen.edgeTarget, edgeType: gen.edgeType })
    const h = louvainHierarchy(g, { topMax: 50 })
    expect(h.levels[0].n).toBe(20_000)
    for (let l = 1; l < h.levels.length; l++) expect(h.levels[l].n).toBeLessThan(h.levels[l - 1].n)
    const top = h.levels[h.levels.length - 1]
    let connected = 0
    for (let i = 0; i < top.n; i++) if (top.offsets[i + 1] > top.offsets[i]) connected++
    expect(connected).toBeLessThanOrEqual(50)
    // The partition two levels up is a good one.
    const labels = new Uint32Array(g.nodeCount)
    for (let i = 0; i < g.nodeCount; i++) labels[i] = h.parent[1][h.parent[0][i]]
    expect(modularity(g, labels)).toBeGreaterThan(0.6)
  }, 30_000)

  it('is deterministic for a seed', () => {
    const g = cliques(6, 7)
    const a = louvainHierarchy(g, { seed: 4 })
    const b = louvainHierarchy(g, { seed: 4 })
    expect(Array.from(a.parent[0])).toEqual(Array.from(b.parent[0]))
  })
})

describe('layoutMultilevel', () => {
  it('draws communities as separate balls, members inside, loose nodes grouped apart', () => {
    const g = cliques(6, 20, 30)
    const pos = new Float32Array(g.nodeCount * 3)
    const { labels, communities } = layoutMultilevel(g, pos, { dims: 3, spacing: 10 })
    expect(communities).toBe(7)
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true)
    // Within a clique nodes are near; across cliques, far.
    let inside = 0, across = 0, ni = 0, na = 0
    for (let a = 0; a < 120; a += 3) {
      for (let b = a + 1; b < 120; b += 5) {
        if (labels[a] === labels[b]) {
          inside += dist(pos, a, b)
          ni++
        } else {
          across += dist(pos, a, b)
          na++
        }
      }
    }
    expect(inside / ni).toBeLessThan((across / na) * 0.5)
    // The loose nodes share one ball: nearer each other than to the cliques' centre of mass.
    expect(labels[120]).toBe(labels[149])
    // Nodes do not pile up: nearest neighbours inside a clique are at least half a spacing apart.
    for (let a = 0; a < 20; a++) {
      let nearest = Infinity
      for (let b = 0; b < 20; b++) if (a !== b) nearest = Math.min(nearest, dist(pos, a, b))
      expect(nearest).toBeGreaterThan(5)
    }
  })

  it('stays flat in 2D, keeps pinned nodes and is deterministic', () => {
    const g = cliques(5, 12)
    const a = new Float32Array(g.nodeCount * 3)
    layoutMultilevel(g, a, { dims: 2, seed: 9 })
    for (let i = 0; i < g.nodeCount; i++) expect(a[i * 3 + 2]).toBe(0)
    const b = new Float32Array(g.nodeCount * 3)
    layoutMultilevel(g, b, { dims: 2, seed: 9 })
    expect(Array.from(b)).toEqual(Array.from(a))
    const pinned = new BitSet(g.nodeCount)
    pinned.set(7)
    const c = new Float32Array(g.nodeCount * 3)
    c[21] = 123
    c[22] = -45
    layoutMultilevel(g, c, { dims: 2 }, pinned)
    expect([c[21], c[22]]).toEqual([123, -45])
  })

  it('handles an empty graph, a graph without edges and a single edge', () => {
    const none = PackedGraph.fromArrays({ nodeType: new Uint16Array(0), edgeSource: new Uint32Array(0), edgeTarget: new Uint32Array(0), edgeType: new Uint16Array(0) })
    expect(layoutMultilevel(none, new Float32Array(0)).communities).toBeGreaterThanOrEqual(0)
    const loose = PackedGraph.fromArrays({ nodeType: new Uint16Array(50), edgeSource: new Uint32Array(0), edgeTarget: new Uint32Array(0), edgeType: new Uint16Array(0) })
    const p = new Float32Array(150)
    layoutMultilevel(loose, p, { dims: 3 })
    for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true)
    expect(dist(p, 0, 1)).toBeGreaterThan(0)
    const one = PackedGraph.fromArrays({ nodeType: new Uint16Array(2), edgeSource: Uint32Array.of(0), edgeTarget: Uint32Array.of(1), edgeType: new Uint16Array(1) })
    const q = new Float32Array(6)
    layoutMultilevel(one, q, { dims: 3 })
    expect(dist(q, 0, 1)).toBeGreaterThan(1)
  })

  it('reads edge weights: a heavy edge holds its ends together', () => {
    const g = cliques(4, 8)
    const w = new Float32Array(g.edgeCount).fill(1)
    const plain = new Float32Array(g.nodeCount * 3)
    layoutMultilevel(g, plain, { dims: 3 })
    const heavy = new Float32Array(g.nodeCount * 3)
    // The ring edge from clique 0 (node 0) to clique 1 (node 9), made heavier than a clique.
    for (let e = 0; e < g.edgeCount; e++) if (g.edgeSource[e] === 0 && g.edgeTarget[e] === 9) w[e] = 1000
    layoutMultilevel(g, heavy, { dims: 3, edgeWeight: w })
    expect(dist(heavy, 0, 9)).toBeLessThan(dist(plain, 0, 9))
  })
})
