import { describe, expect, it } from 'vitest'
import { outputsOf } from '../outputs'
import { Sandbox } from '../sandbox'
import type { Snapshot } from '../types'

/**
 * The metrics prelude inside the real sandbox: two triangles joined by a
 * bridge, a lone pair and an isolated node — enough to know the answers.
 */
function snapshot(): Snapshot {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
  const entities = ids.map((id) => ({ id, type: 'node', label: id.toUpperCase(), tags: [], data: {}, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }))
  const edges: [string, string][] = [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'], // triangle 1
    ['c', 'd'], // the bridge
    ['d', 'e'],
    ['e', 'f'],
    ['f', 'd'], // triangle 2
    ['g', 'h'], // a pair; i is alone
    ['a', 'b'], // a parallel edge, counted once undirected
  ]
  const relationships = edges.map(([s, t], i) => ({ id: `r${i}`, type: 'link', source: s, target: t, directed: true, data: {} }))
  return { scope: { label: 'test' }, entities, relationships, ontology: [], tags: [], metrics: { pagerank: { a: 0.9 } } }
}

describe('sandbox metrics', () => {
  const sb = new Sandbox()
  const load = () => sb.load('m1', JSON.stringify(snapshot()))

  it('computes degrees, components, clustering, pagerank, betweenness, closeness and communities in the sandbox', async () => {
    await load()
    const r = await sb.run(`
      const m = ds.compute(['degree', 'inDegree', 'outDegree', 'component', 'componentSize', 'clustering', 'pagerank', 'betweenness', 'closeness', 'community'])
      return {
        degree: m.degree, inDeg: m.inDegree.a, outDeg: m.outDegree.a,
        comp: m.component, size: m.componentSize,
        clust: m.clustering,
        prTop: Object.entries(m.pagerank).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k),
        prSum: Object.values(m.pagerank).reduce((s, v) => s + v, 0),
        btTop: Object.entries(m.betweenness).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k).sort(),
        btZero: m.betweenness.i,
        cl: m.closeness,
        community: m.community,
        names: ds.metricNames().sort(),
        viaMetric: ds.metric('pagerank', 'a') === m.pagerank.a,
        computable: ds.computable().length,
      }
    `)
    expect(r.error).toBeUndefined()
    const v = r.value as Record<string, Record<string, number>> & { inDeg: number; outDeg: number; prSum: number; btTop: string[]; btZero: number; names: string[]; viaMetric: boolean; computable: number }
    // The parallel a–b edge counts once; the bridge gives c and d three.
    expect(v.degree).toEqual({ a: 2, b: 2, c: 3, d: 3, e: 2, f: 2, g: 1, h: 1, i: 0 })
    expect(v.inDeg).toBe(1)
    expect(v.outDeg).toBe(2)
    // Components numbered by size: the six, the pair, the single.
    expect(v.comp).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 1, h: 1, i: 2 })
    expect(v.size).toEqual({ a: 6, b: 6, c: 6, d: 6, e: 6, f: 6, g: 2, h: 2, i: 1 })
    // A triangle's corners are fully clustered; the bridge ends see one of three pairs linked.
    expect(v.clust.a).toBe(1)
    expect(v.clust.c).toBeCloseTo(1 / 3)
    expect(v.clust.g).toBe(0)
    expect(v.prSum).toBeCloseTo(1, 6)
    // Everything flows into d (in-links from c, f) and a (from c); the bridge ends carry the most betweenness.
    expect(v.btTop).toEqual(['c', 'd'])
    expect(v.btZero).toBe(0)
    expect(v.cl.i).toBe(0)
    expect(v.cl.c).toBeGreaterThan(v.cl.a)
    // Louvain splits the six into the two triangles; the pair and the single are their own.
    const comm = v.community as Record<string, number>
    expect(comm.a).toBe(comm.b)
    expect(comm.b).toBe(comm.c)
    expect(comm.d).toBe(comm.e)
    expect(comm.e).toBe(comm.f)
    expect(comm.a).not.toBe(comm.d)
    expect(comm.g).toBe(comm.h)
    expect(new Set(Object.values(comm)).size).toBe(4)
    expect(v.names).toEqual(['betweenness', 'closeness', 'clustering', 'community', 'component', 'componentSize', 'degree', 'inDegree', 'outDegree', 'pagerank'])
    // A computed metric wins over the host's stale one (pagerank a was 0.9).
    expect(v.viaMetric).toBe(true)
    expect(v.computable).toBe(10)
  })

  it('refuses an unknown metric by name and keeps a computed one across runs', async () => {
    // A fresh snapshot key: a new context, nothing computed yet.
    await sb.load('m2', JSON.stringify(snapshot()))
    const bad = await sb.run(`ds.compute(['pagerank', 'eigen'])`)
    expect(bad.error?.message).toMatch(/Unknown metric eigen/)
    const first = await sb.run(`ds.compute('degree'); return ds.metric('degree', 'c')`)
    expect(first.value).toBe(3)
    // Names: what was computed here plus what the host's run had (pagerank).
    const again = await sb.run(`return ds.metricNames()`)
    expect(again.value).toEqual(['degree', 'pagerank'])
  })

  it('builds a style and a layout from computed metrics with the colour and scale helpers', async () => {
    await load()
    const r = await sb.run(`
      const { pagerank, community } = ds.compute(['pagerank', 'community'])
      const [lo, hi] = extent(Object.values(pagerank))
      const nodes = {}
      for (const e of ds.entities) nodes[e.id] = { color: colorOf(community[e.id]), size: scaleSqrt(pagerank[e.id], [lo, hi], [3, 22]), shape: community[e.id] === 0 ? 'square' : 'circle' }
      const positions = {}
      ds.entities.forEach((e, i) => { positions[e.id] = { x: community[e.id] * 100, y: i * 10 } })
      return { ...style(nodes, { legend: { title: 'Community', items: [{ label: 'One', color: colorOf(0) }, { label: 'Two', color: colorOf(1) }] }, edges: { r3: { color: '#000', width: 4 } } }), ...layout(positions, { label: 'By community' }), ramp: colorRamp(0.5, PALETTES.blues), lin: scaleLinear(5, [0, 10], [0, 1]), logv: scaleLog(0, [0, 10], [1, 2]) }
    `)
    expect(r.error).toBeUndefined()
    const outs = outputsOf(r.value)
    const st = outs.find((o) => o.kind === 'style')
    const lay = outs.find((o) => o.kind === 'layout')
    expect(st && st.kind === 'style' && Object.keys(st.overlay.nodes ?? {}).length).toBe(9)
    if (st?.kind === 'style') {
      expect(st.overlay.nodes?.a).toMatchObject({ color: '#4e79a7', shape: 'square' })
      expect(st.overlay.nodes?.a?.size).toBeGreaterThan(3)
      expect(st.overlay.edges?.r3).toEqual({ color: '#000', width: 4 })
      expect(st.overlay.legend).toEqual({ title: 'Community', items: [{ label: 'One', color: '#4e79a7' }, { label: 'Two', color: '#f28e2b' }] })
    }
    expect(lay?.kind === 'layout' && lay.label).toBe('By community')
    expect(lay?.kind === 'layout' && lay.positions.d).toEqual({ x: 100, y: 30 })
    const v = r.value as { ramp: string; lin: number; logv: number }
    expect(v.ramp).toMatch(/^#[0-9a-f]{6}$/)
    expect(v.lin).toBe(0.5)
    expect(v.logv).toBe(1)
  })
})
