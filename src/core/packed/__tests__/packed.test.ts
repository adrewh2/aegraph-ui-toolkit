import { describe, expect, it } from 'vitest'
import { BitSet } from '../bitset'
import { IdRegistry, TypeTable } from '../ids'
import { PackedGraph } from '../graph'
import { SpatialGrid } from '../grid'
import { packColor, packedToHex, unpackColor } from '../color'
import { BENCH_PRESETS, generateGraph } from '../generate'
import { extent, labelPropagation, layoutCoarse, layoutGrid, localForce } from '../layout'

describe('BitSet', () => {
  it('sets, clears, counts and combines without touching padding bits', () => {
    const a = new BitSet(70)
    a.set(0)
    a.set(33)
    a.set(69)
    expect(a.has(33)).toBe(true)
    expect(a.has(34)).toBe(false)
    expect(a.count()).toBe(3)
    const b = new BitSet(70)
    b.setAll()
    expect(b.count()).toBe(70)
    const out = new BitSet(70)
    a.and(b, out)
    expect(out.count()).toBe(3)
    b.andNot(a, out)
    expect(out.count()).toBe(67)
    expect(out.has(33)).toBe(false)
    const seen: number[] = []
    a.forEach((i) => seen.push(i))
    expect(seen).toEqual([0, 33, 69])
    expect(Array.from(a.toArray())).toEqual([0, 33, 69])
    expect(a.first()).toBe(0)
    a.resize(200)
    expect(a.has(69)).toBe(true)
    expect(a.count()).toBe(3)
    a.toggle(69)
    expect(a.count()).toBe(2)
  })
})

describe('IdRegistry', () => {
  it('interns to dense indices and reuses freed slots', () => {
    const r = new IdRegistry()
    expect(r.intern('a')).toBe(0)
    expect(r.intern('b')).toBe(1)
    expect(r.intern('a')).toBe(0)
    expect(r.index('zz')).toBe(-1)
    expect(r.remove('a')).toBe(0)
    expect(r.id(0)).toBeUndefined()
    expect(r.intern('c')).toBe(0)
    expect(r.size).toBe(2)
    expect(r.capacity).toBe(2)
    // Virtual ids: a pattern, no storage; interned ids sit past them.
    const v = new IdRegistry()
    v.setVirtual('n', 1000)
    expect(v.index('n999')).toBe(999)
    expect(v.index('n1000')).toBe(-1)
    expect(v.index('n01')).toBe(-1)
    expect(v.id(5)).toBe('n5')
    expect(v.intern('n7')).toBe(7)
    expect(v.intern('extra')).toBe(1000)
    expect(v.capacity).toBe(1001)
    expect(v.size).toBe(1001)
    const t = new TypeTable()
    expect(t.code('person')).toBe(0)
    expect(t.code('work')).toBe(1)
    expect(t.code('person')).toBe(0)
    expect(t.name(1)).toBe('work')
    expect(t.lookup('nope')).toBe(-1)
  })
})

describe('PackedGraph', () => {
  const neighbours = (g: PackedGraph, i: number) => {
    const out: number[] = []
    g.forEachIncident(i, (_e, o) => out.push(o))
    return out.sort((a, b) => a - b)
  }
  it('answers adjacency from the CSR and the delta alike, and compacts', () => {
    const g = new PackedGraph(4, 4)
    for (let i = 0; i < 5; i++) g.addNode(0)
    g.addEdge(0, 1, 0)
    g.addEdge(0, 2, 0, true)
    expect(g.degree[0]).toBe(2)
    expect(neighbours(g, 0)).toEqual([1, 2])
    g.compact()
    expect(g.pendingEdges).toBe(0)
    expect(neighbours(g, 0)).toEqual([1, 2])
    expect(neighbours(g, 2)).toEqual([0])
    // After the build: a delta edge shows up next to the CSR ones.
    const e = g.addEdge(3, 0, 1)
    expect(g.pendingEdges).toBe(2)
    expect(neighbours(g, 0)).toEqual([1, 2, 3])
    expect(g.degree[3]).toBe(1)
    g.removeEdge(e)
    expect(neighbours(g, 0)).toEqual([1, 2])
    expect(g.degree[0]).toBe(2)
    // Removing a CSR edge is a tombstone until the next compaction.
    g.removeEdge(0)
    expect(neighbours(g, 0)).toEqual([2])
    expect(neighbours(g, 1)).toEqual([])
    g.compact()
    expect(neighbours(g, 0)).toEqual([2])
    expect(g.aliveEdges()).toBe(1)
    g.removeNode(2)
    expect(g.aliveEdges()).toBe(0)
    expect(g.hasNode(2)).toBe(false)
    expect(g.edgeDirected.has(1)).toBe(true)
  })
  it('adding a few edges to a big graph does not rebuild the CSR', () => {
    const gen = generateGraph({ nodes: 5000, edges: 12000, seed: 3 })
    const g = PackedGraph.fromArrays({ nodeType: gen.nodeType, edgeSource: gen.edgeSource, edgeTarget: gen.edgeTarget, edgeType: gen.edgeType })
    const before = g.offsets
    for (let k = 0; k < 100; k++) g.addEdge(k, k + 1, 0)
    expect(g.offsets).toBe(before)
    expect(g.pendingEdges).toBe(200)
    expect(g.compactIfNeeded()).toBe(false)
    expect(neighbours(g, 0)).toContain(1)
    for (let k = 0; k < 2000; k++) g.addEdge(k, k + 2, 0)
    expect(g.compactIfNeeded()).toBe(true)
    expect(g.pendingEdges).toBe(0)
    expect(neighbours(g, 0)).toContain(2)
    // Degrees agree with the CSR.
    for (let i = 0; i < 50; i++) expect(neighbours(g, i).length).toBe(g.degree[i])
  })
  it('grows its capacities and puts nodes at chosen indices', () => {
    const g = new PackedGraph(2, 2)
    g.setNode(10, 3)
    expect(g.nodeCount).toBe(11)
    expect(g.hasNode(10)).toBe(true)
    expect(g.hasNode(5)).toBe(false)
    for (let i = 0; i < 100; i++) g.addEdge(10, 10, 0)
    expect(g.degree[10]).toBe(100)
    expect(g.edgeCapacity).toBeGreaterThanOrEqual(100)
    g.clear()
    expect(g.nodeCount).toBe(0)
    expect(g.aliveEdges()).toBe(0)
  })
})

describe('SpatialGrid', () => {
  it('finds the node under a point and the nodes in a rectangle', () => {
    const N = 1000
    const pos = new Float32Array(N * 3)
    layoutGrid(N, pos, 10)
    const grid = new SpatialGrid()
    grid.build(pos, N)
    expect(grid.count).toBe(N)
    const r = () => 3
    const X = (i: number) => pos[i * 3], Y = (i: number) => pos[i * 3 + 1]
    const i = grid.nearest(pos, X(42), Y(42) + 1, 5, r)
    expect(i).toBe(42)
    expect(grid.nearest(pos, X(42) + 5, Y(42) + 5, 5, r)).toBe(-1)
    expect(grid.nearest(pos, X(42), Y(42), 5, r, (k) => k !== 42)).toBe(-1)
    const hits: number[] = []
    grid.forEachInRect(pos, X(0) - 1, Y(0) - 1, X(0) + 11, Y(0) + 11, (k) => hits.push(k))
    expect(hits.sort((a, b) => a - b)).toEqual([0, 1, 32, 33])
    expect(grid.countInRect(X(0) - 1, Y(0) - 1, X(0) + 11, Y(0) + 11)).toBeGreaterThanOrEqual(4)
    const alive = new BitSet(N)
    alive.set(7)
    grid.build(pos, N, alive)
    expect(grid.count).toBe(1)
    expect(grid.nearest(pos, X(7), Y(7), 1, r)).toBe(7)
    expect(grid.nearest(pos, X(0), Y(0), 1, r)).toBe(-1)
  })
})

describe('packColor', () => {
  it('packs css colours little-endian RGBA', () => {
    expect(unpackColor(packColor('#ff8000'))).toEqual([255, 128, 0, 255])
    expect(unpackColor(packColor('#f80'))).toEqual([255, 136, 0, 255])
    expect(unpackColor(packColor('#ff800080'))).toEqual([255, 128, 0, 128])
    expect(unpackColor(packColor('rgb(1, 2, 3)'))).toEqual([1, 2, 3, 255])
    expect(unpackColor(packColor('rgba(1, 2, 3, 0.5)'))).toEqual([1, 2, 3, 128])
    expect(unpackColor(packColor('#ff8000', 0.5))).toEqual([255, 128, 0, 128])
    expect(unpackColor(packColor('garbage'))).toEqual([128, 128, 128, 255])
    expect(packedToHex(packColor('#ff8000'))).toBe('#ff8000')
  })
})

describe('generateGraph', () => {
  it('is deterministic and hits the counts', () => {
    const a = generateGraph({ nodes: 2000, edges: 5000, seed: 7 })
    const b = generateGraph({ nodes: 2000, edges: 5000, seed: 7 })
    expect(a.nodeType).toEqual(b.nodeType)
    expect(a.edgeSource).toEqual(b.edgeSource)
    expect(a.positions).toEqual(b.positions)
    expect(a.idPrefix).toBe('n')
    expect(a.edgeSource.length).toBe(5000)
    for (let e = 0; e < a.edgeSource.length; e++) expect(a.edgeSource[e]).not.toBe(a.edgeTarget[e])
    expect(a.communities).toBeGreaterThan(4)
    // Most edges stay in their community.
    let inside = 0
    for (let e = 0; e < a.edgeSource.length; e++) if (a.community[a.edgeSource[e]] === a.community[a.edgeTarget[e]]) inside++
    expect(inside / a.edgeSource.length).toBeGreaterThan(0.7)
    expect(BENCH_PRESETS['200k'].nodes).toBe(200_000)
    expect(BENCH_PRESETS['1m'].nodes).toBe(1_000_000)
  })
  it('builds the 200k / 500k preset in packed form quickly', () => {
    const t0 = performance.now()
    const g = generateGraph({ ...BENCH_PRESETS['200k'], seed: 1 })
    const packed = PackedGraph.fromArrays({ nodeType: g.nodeType, edgeSource: g.edgeSource, edgeTarget: g.edgeTarget, edgeType: g.edgeType })
    const ms = performance.now() - t0
    expect(packed.nodeCount).toBe(200_000)
    expect(packed.aliveEdges()).toBe(500_000)
    expect(ms).toBeLessThan(5000)
  })
})

describe('layouts', () => {
  it('label propagation recovers planted communities', () => {
    const gen = generateGraph({ nodes: 3000, edges: 12000, seed: 5, communities: 6, cohesion: 0.95 })
    const g = PackedGraph.fromArrays({ nodeType: gen.nodeType, edgeSource: gen.edgeSource, edgeTarget: gen.edgeTarget, edgeType: gen.edgeType })
    const { labels, communities } = labelPropagation(g, 10, 2)
    expect(communities).toBeGreaterThanOrEqual(2)
    expect(communities).toBeLessThan(60)
    // Nodes of the same planted community mostly share a label.
    let agree = 0, pairs = 0
    for (let i = 1; i < 3000; i++) {
      if (gen.community[i] !== gen.community[i - 1]) continue
      pairs++
      if (labels[i] === labels[i - 1]) agree++
    }
    expect(agree / pairs).toBeGreaterThan(0.6)
    const pos = new Float32Array(3000 * 3)
    layoutCoarse(g, pos, { communities: { labels, communities } })
    const box = extent(pos, 3000)!
    expect(box.maxX - box.minX).toBeGreaterThan(100)
    expect(box.maxZ - box.minZ).toBe(0)
    // Every node has a finite position.
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true)
    layoutCoarse(g, pos, { communities: { labels, communities }, dims: 3 })
    const box3 = extent(pos, 3000)!
    expect(box3.maxZ - box3.minZ).toBeGreaterThan(50)
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true)
  })
  it('localForce moves only the subset and pulls linked nodes together', () => {
    const g = new PackedGraph()
    for (let i = 0; i < 6; i++) g.addNode(0)
    g.addEdge(0, 1, 0)
    g.addEdge(1, 2, 0)
    g.compact()
    const pos = new Float32Array([0, 0, 0, 500, 0, 0, 1000, 0, 0, 5, 5, 0, 6, 6, 0, 7, 7, 0])
    const before = pos.slice()
    localForce(g, pos, new Uint32Array([0, 1, 2]), { iterations: 100, spacing: 30, seed: 1 })
    const d = (a: number, b: number) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2])
    expect(d(0, 1)).toBeLessThan(400)
    expect(d(1, 2)).toBeLessThan(400)
    expect(d(0, 1)).toBeGreaterThan(1)
    for (let i = 3; i < 6; i++) {
      expect(pos[i * 3]).toBe(before[i * 3])
      expect(pos[i * 3 + 1]).toBe(before[i * 3 + 1])
    }
    expect(pos[2]).toBe(0)
    // In three dimensions the z axis takes part.
    const pos3 = new Float32Array([0, 0, 0, 500, 0, 0, 0, 0, 900, 5, 5, 5, 6, 6, 6, 7, 7, 7])
    localForce(g, pos3, new Uint32Array([0, 1, 2]), { iterations: 100, spacing: 30, seed: 1, dims: 3 })
    expect(Math.abs(pos3[8])).toBeLessThan(800)
  })
})

describe('BitSet.resize', () => {
  it('grows after a shrink without overflowing, and a shrink leaves nothing behind to reappear', () => {
    // The sequence the engine goes through loading a 10k graph, then 480 nodes, then 5,000 (capacities 16k, 1k, 8k).
    const b = new BitSet(16384)
    b.set(3)
    b.set(2000)
    b.set(16000)
    b.resize(1024)
    expect(() => b.resize(8192)).not.toThrow()
    expect(b.size).toBe(8192)
    expect(b.has(3)).toBe(true)
    expect(b.has(2000)).toBe(false)
    b.resize(16384)
    expect(b.has(16000)).toBe(false)
    // A shrink to a size inside a word keeps the bits below it and drops the ones above.
    const c = new BitSet(64)
    c.set(4)
    c.set(5)
    c.set(40)
    c.resize(5)
    c.resize(64)
    expect([c.has(4), c.has(5), c.has(40)]).toEqual([true, false, false])
  })
})
