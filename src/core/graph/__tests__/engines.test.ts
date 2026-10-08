import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, emptyFilter } from '../filter'
import { computeLayoutAsync, resolvePositionsAsync } from '../layoutEngines'
import { DEFAULT_LAYOUT_PARAMS, engineOf, isHeavyLayout, LAYOUTS, type LayoutAlgorithm } from '../layouts'
import { spanningForest } from '../engines/elk'
import { spread, spreadOf } from '../engines/spectral'
import '../types'

/** A small tree with a few cross links and one island — enough for every engine to have something to say. */
function fixture() {
  const s = new EntityStore()
  const nodes = Array.from({ length: 16 }, (_, i) => createEntity({ id: `n${i}`, type: i % 3 ? 'note' : 'topic', label: `N${i}` }))
  const rels = []
  for (let i = 1; i < 14; i++) rels.push(createRelationship({ id: `t${i}`, type: 'child-of', source: `n${i}`, target: `n${Math.floor((i - 1) / 2)}` }))
  rels.push(createRelationship({ id: 'x1', type: 'related', source: 'n5', target: 'n9', directed: false }))
  rels.push(createRelationship({ id: 'x2', type: 'related', source: 'n3', target: 'n12', directed: false }))
  rels.push(createRelationship({ id: 'island', type: 'related', source: 'n14', target: 'n15' }))
  s.upsertMany([...nodes, ...rels])
  return { s, r: new TypeRegistry(s) }
}

const finite = (p: { x: number; y: number; z?: number }) => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.z === undefined || Number.isFinite(p.z))

describe('on-demand layout engines', () => {
  const { s, r } = fixture()
  const slice = applyFilter(s, r, emptyFilter())
  const engines = LAYOUTS.filter((l) => l.engine)

  it('are catalogued as engines, always heavy (worker-only), and fall back to a grid synchronously', () => {
    expect(engines.map((l) => l.id)).toEqual(['elk-layered', 'elk-stress', 'elk-mrtree', 'elk-radial', 'cola', 'ngraph', 'spectral'])
    for (const l of engines) {
      expect(engineOf(l.id)).toBe(l.engine)
      expect(isHeavyLayout(l.id, 3)).toBe(true)
    }
    expect(isHeavyLayout('circular', 100000)).toBe(false)
    // Nothing to lay out is never heavy — the explorer must not start (and re-start) a job for zero nodes.
    expect(isHeavyLayout('ngraph', 0)).toBe(false)
    expect(isHeavyLayout('force', 0)).toBe(false)
  })

  it('place every node at finite coordinates, in 2D and 3D where offered', async () => {
    for (const l of engines) {
      for (const dims of l.dims) {
        const out = await computeLayoutAsync(l.id, slice, { ...DEFAULT_LAYOUT_PARAMS, dimensions: dims, iterations: 60 })
        expect(Object.keys(out).length, `${l.id} ${dims}D`).toBe(slice.nodes.length)
        for (const id in out) expect(finite(out[id]), `${l.id} ${dims}D ${id}`).toBe(true)
        if (dims === 3) expect(Object.values(out).some((p) => p.z !== undefined && p.z !== 0), `${l.id} uses z`).toBe(true)
        // Not everything on one spot.
        const xs = new Set(Object.values(out).map((p) => Math.round(p.x)))
        expect(xs.size, `${l.id} ${dims}D spread`).toBeGreaterThan(3)
      }
    }
  }, 60000)

  it('keep pinned nodes where they were and place only the missing ones when resolving', async () => {
    const previous = { n0: { x: 1234, y: -99 }, n1: { x: 10, y: 10 } }
    const out = await computeLayoutAsync('ngraph', slice, { ...DEFAULT_LAYOUT_PARAMS, iterations: 40 }, previous, ['n0'])
    expect(out.n0).toEqual({ x: 1234, y: -99 })
    const r2 = await resolvePositionsAsync(slice, previous, 'spectral', DEFAULT_LAYOUT_PARAMS)
    expect(r2.unplaced).toBe(slice.nodes.length - 2)
    expect(r2.positions.n0).toEqual({ x: 1234, y: -99 })
    expect(Object.keys(r2.positions).length).toBe(slice.nodes.length)
  }, 30000)

  it('ELK refuses a graph past its ceiling with a sentence instead of overflowing its stack', async () => {
    const big = { ...slice, nodes: Array.from({ length: 3001 }, (_, i) => ({ ...slice.nodes[0], id: `x${i}` })), edges: [] }
    await expect(computeLayoutAsync('elk-layered', big, DEFAULT_LAYOUT_PARAMS)).rejects.toThrow(/up to 3,000 nodes .* this view has 3,001/)
    await expect(computeLayoutAsync('elk-radial', big, DEFAULT_LAYOUT_PARAMS)).resolves.toBeDefined()
  }, 30000)

  it('ELK radial takes a spanning forest, so a graph with cycles lays out instead of overflowing the stack', async () => {
    // Fifty nodes, a hundred edges with cycles in every direction — the shape that failed at any size.
    const st = new EntityStore()
    st.upsertMany(Array.from({ length: 50 }, (_, i) => createEntity({ id: `c${i}`, type: 'note', label: `C${i}` })))
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const rels = []
    for (let i = 0; i < 100; i++) {
      const a = Math.floor(rnd() * 50)
      const b = (a + 1 + Math.floor(rnd() * 48)) % 50
      rels.push(createRelationship({ id: `e${i}`, type: 'r', source: `c${a}`, target: `c${b}`, directed: i % 2 === 0 }))
    }
    st.upsertMany(rels)
    const cyclic = applyFilter(st, new TypeRegistry(st), emptyFilter())
    const out = await computeLayoutAsync('elk-radial', cyclic, DEFAULT_LAYOUT_PARAMS)
    expect(Object.keys(out).length).toBe(50)
    expect(Object.values(out).every(finite)).toBe(true)
    // Spread out (a collapsed forest put everything on one line: two distinct spots); ELK may still land two leaves of
    // different subtrees on the same ring point, which overlap removal handles.
    expect(new Set(Object.values(out).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size).toBeGreaterThanOrEqual(45)
    // The forest itself: one edge per node bar the roots, hung from the best-connected node, always parent → child.
    const edges = rels.map((e) => ({ id: e.id, sources: [e.source.id], targets: [e.target.id] }))
    const forest = spanningForest(cyclic.nodes.map((n) => n.id), edges)
    // Nodes with no edge sit on a ring outside the trees rather than being handed to ELK as leaves.
    const linked = new Set(forest.flatMap((e) => [e.sources[0], e.targets[0]]))
    const isolated = cyclic.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id)
    expect(isolated.length).toBeGreaterThan(0)
    const inner = cyclic.nodes.filter((n) => linked.has(n.id)).map((n) => out[n.id])
    const cx = (Math.min(...inner.map((p) => p.x)) + Math.max(...inner.map((p) => p.x))) / 2
    const cy = (Math.min(...inner.map((p) => p.y)) + Math.max(...inner.map((p) => p.y))) / 2
    const innerR = Math.max(...inner.map((p) => Math.hypot(p.x - cx, p.y - cy)))
    for (const id of isolated) expect(Math.hypot(out[id].x - cx, out[id].y - cy)).toBeGreaterThan(innerR)
    // No edges at all: no ELK run, a ring, instantly.
    const t = performance.now()
    const lone = await computeLayoutAsync('elk-radial', { ...cyclic, edges: [] }, DEFAULT_LAYOUT_PARAMS)
    expect(Object.keys(lone).length).toBe(50)
    expect(new Set(Object.values(lone).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size).toBe(50)
    expect(performance.now() - t).toBeLessThan(500)
    expect(forest.length).toBeLessThan(cyclic.nodes.length)
    const children = new Set(forest.map((e) => e.targets[0]))
    expect(children.size).toBe(forest.length)
    const roots = cyclic.nodes.filter((n) => !children.has(n.id)).map((n) => n.id)
    const degree = (id: string) => edges.filter((e) => e.sources[0] === id || e.targets[0] === id).length
    const best = [...cyclic.nodes].sort((a, b) => degree(b.id) - degree(a.id))[0].id
    expect(roots).toContain(best)
    expect(spanningForest(['a', 'b', 'c'], [{ id: 'ab', sources: ['a'], targets: ['b'] }, { id: 'ba', sources: ['b'], targets: ['a'] }])).toEqual([{ id: 'ab', sources: ['a'], targets: ['b'] }])
  }, 30000)
  it('spectral spreads a localised eigenvector by rank and leaves a spread one alone', () => {
    // Evenly spread entries: the linear scaling, untouched.
    const even = Array.from({ length: 100 }, (_, i) => (i - 49.5) / 49.5)
    expect(spreadOf(even)).toBeGreaterThan(0.8)
    const lin = spread(even, 1000)
    expect(lin[0]).toBeCloseTo(-1000, 6)
    expect(lin[99]).toBeCloseTo(1000, 6)
    expect(lin[50] - lin[49]).toBeCloseTo(lin[1] - lin[0], 6)
    // Localised: five spikes, everything else within ±0.001. Scaled by the maximum, 95 nodes would share one dot.
    const local = Array.from({ length: 1000 }, (_, i) => (i < 5 ? (i % 2 ? -1 : 1) * (1 + i) : ((i * 7919) % 1000) / 1e6))
    expect(spreadOf(local)).toBeLessThan(0.01)
    const out = spread(local, 1000)
    const abs = out.map(Math.abs).sort((a, b) => a - b)
    // The bulk fills the picture (the 90th percentile of |x| past a third of the span) …
    expect(abs[900]).toBeGreaterThan(330)
    // … the spikes stay outermost, and the order of every pair is kept.
    const top = out.map((x, i) => [Math.abs(x), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, i]) => i)
    expect(new Set(top)).toEqual(new Set([0, 1, 2, 3, 4]))
    const order = local.map((_, i) => i).sort((a, b) => local[a] - local[b])
    for (let r = 1; r < order.length; r++) expect(out[order[r]]).toBeGreaterThan(out[order[r - 1]])
    expect(spread(local, 1000)).toEqual(out)
  })
  it('layered ELK flows top-down along edge direction, like the built-in layered layout (y grows upward)', async () => {
    const out = await computeLayoutAsync('elk-layered' as LayoutAlgorithm, slice, { ...DEFAULT_LAYOUT_PARAMS, direction: 'TB' })
    // child-of edges point child → parent, so a child sits a layer above its parent.
    expect(out.n1.y).toBeGreaterThan(out.n0.y)
    expect(out.n3.y).toBeGreaterThan(out.n1.y)
    const lr = await computeLayoutAsync('elk-layered' as LayoutAlgorithm, slice, { ...DEFAULT_LAYOUT_PARAMS, direction: 'LR' })
    expect(lr.n1.x).toBeLessThan(lr.n0.x)
  }, 30000)
})
