import { describe, expect, it } from 'vitest'
import { runAnalyses } from '../run'
import type { AnalysisId, AnalysisInput, Finding } from '../types'

/**
 * The other three Insights analyses at their edges. Centrality: no
 * edges, a complete graph where everyone is equal, one bridge between
 * two cliques, a self-loop and a duplicate edge. Communities: one big
 * clique against two, many tiny pairs, the naming of a community.
 * Schema: no declared types, a declared type nobody uses, a property
 * nobody declares, a relationship kind joining every pair of types, a
 * type whose instances never link. Every finding's score in 0–1, its
 * entities in the slice, its id unique; two runs the same.
 */
interface Spec {
  nodes: { type?: string; label?: string; tags?: string[]; props?: string[] }[]
  edges?: [number, number, string?][]
  schema?: AnalysisInput['schema']
  /** Edges are directed unless told otherwise (a directed clique has a sink that soaks up PageRank). */
  undirected?: boolean
}
function input(spec: Spec): AnalysisInput {
  const edges = spec.edges ?? []
  const t = Date.UTC(2024, 0, 1)
  return {
    ids: spec.nodes.map((_, i) => `n${i}`),
    types: spec.nodes.map((x) => x.type ?? 'thing'),
    labels: spec.nodes.map((x, i) => x.label ?? `Thing ${i}`),
    tags: spec.nodes.map((x) => x.tags ?? []),
    props: spec.nodes.map((x) => x.props ?? []),
    created: Float64Array.from(spec.nodes, (_, i) => t + i * 3_600_000),
    updated: Float64Array.from(spec.nodes, (_, i) => t + i * 3_600_000),
    src: Uint32Array.from(edges, (e) => e[0]),
    dst: Uint32Array.from(edges, (e) => e[1]),
    directed: new Uint8Array(edges.length).fill(spec.undirected ? 0 : 1),
    edgeTypes: edges.map((e) => e[2] ?? 'rel'),
    edgeIds: edges.map((_, j) => `r${j}`),
    schema: spec.schema ?? [],
    scope: { label: 'edges' },
    key: `${spec.nodes.length}:${edges.length}:${Math.random()}`,
  }
}
const run = (spec: Spec, which: AnalysisId[], options = {}) => runAnalyses(input(spec), which, { seed: 1, ...options }).report.findings
const by = (fs: Finding[], id: string) => fs.find((f) => f.id === id)
function sound(fs: Finding[], spec: Spec) {
  const ids = new Set(spec.nodes.map((_, i) => `n${i}`))
  expect(new Set(fs.map((f) => f.id)).size).toBe(fs.length)
  for (const f of fs) {
    expect(f.score, f.id).toBeGreaterThanOrEqual(0)
    expect(f.score, f.id).toBeLessThanOrEqual(1)
    for (const e of f.entities ?? []) expect(ids.has(e), `${f.id} → ${e}`).toBe(true)
    expect(f.title, f.id).toBeTruthy()
  }
}
const clique = (ids: number[], kind = 'rel'): [number, number, string][] => ids.flatMap((a) => ids.filter((b) => b > a).map((b) => [a, b, kind] as [number, number, string]))
const nodes = (n: number, type = 'thing') => Array.from({ length: n }, (_, i) => ({ type, label: `${type} ${i}` }))

describe('centrality at the edges', () => {
  it('no edges: influence is spread, the top 1% touch 0%, everyone isolated is said; fewer than three nodes is nothing', () => {
    expect(run({ nodes: nodes(2), edges: [[0, 1]] }, ['centrality'])).toEqual([])
    const lonely: Spec = { nodes: nodes(20) }
    const r = run(lonely, ['centrality'])
    sound(r, lonely)
    expect(by(r, 'centrality:degree-distribution')?.title).toBe('Connections are spread evenly: the top 1% touch only 0% of relationship ends')
    expect(by(r, 'centrality:degree-distribution')?.detail).toContain('20 entities (100%) have no relationships at all')
    expect(by(r, 'centrality:concentration')?.title).toBe('Influence sits with a visible top tier') // uniform PageRank: the top ten of twenty hold exactly half
    expect(by(r, 'centrality:concentration')?.data?.topShare).toBeCloseTo(0.5, 6)
    expect(by(r, 'centrality:hubs')?.title).not.toMatch(/× the runner-up/)
    expect(by(r, 'centrality:bridges')).toBeUndefined()
  })

  it('a complete graph: everyone equal, no dominance, no bridge, an even degree distribution; a self-loop and a duplicate edge add no degree and make no bridge', () => {
    const k: Spec = { nodes: nodes(12), edges: clique([...Array(12).keys()]), undirected: true }
    const r = run(k, ['centrality'])
    sound(r, k)
    const hubs = by(r, 'centrality:hubs')!
    expect(hubs.title).not.toMatch(/× the runner-up/)
    expect(hubs.data?.gini).toBeCloseTo(0, 6)
    expect(hubs.detail).toContain('evenly spread')
    expect(by(r, 'centrality:bridges')).toBeUndefined()
    expect(by(r, 'centrality:degree-distribution')?.data).toMatchObject({ meanDegree: 11, maxDegree: 11, isolated: 0 })
    const odd: Spec = { nodes: nodes(6), edges: [...clique([0, 1, 2, 3, 4, 5]), [0, 0], [0, 1], [0, 1]], undirected: true }
    const o = run(odd, ['centrality'])
    sound(o, odd)
    expect(by(o, 'centrality:degree-distribution')?.data?.maxDegree).toBe(5) // the adjacency drops self-loops and repeated edges: degree is neighbours, not edges
    expect(by(o, 'centrality:bridges')).toBeUndefined()
  })

  it('one node joining two cliques is the bridge — first by betweenness, low by degree — and the hubs list has each clique’s members', () => {
    const a = [...Array(10).keys()]
    const b = a.map((i) => i + 11)
    const spec: Spec = { nodes: nodes(21), edges: [...clique(a), ...clique(b), [0, 10], [10, 11]], undirected: true }
    const r = run(spec, ['centrality'])
    sound(r, spec)
    const br = by(r, 'centrality:bridges')!
    expect(br.entities![0]).toBe('n10')
    expect(br.data?.bridges).toEqual([expect.objectContaining({ id: 'n10', degree: 2, betweennessRank: 1 })])
    expect(br.title).toBe('1 entity is a bridge: on many shortest paths despite few connections')
    expect(by(r, 'centrality:degree-distribution')?.title).toMatch(/spread evenly/)
    // Determinism.
    expect(JSON.stringify(run(spec, ['centrality']))).toBe(JSON.stringify(run(spec, ['centrality'])))
  })
})

describe('communities at the edges', () => {
  it('one clique is one community: nothing to say; two cliques split cleanly, each named after its lead, the ties counted; fewer than six nodes is nothing', () => {
    expect(run({ nodes: nodes(5), edges: clique([0, 1, 2, 3, 4]) }, ['communities'])).toEqual([])
    const one: Spec = { nodes: nodes(12), edges: clique([...Array(12).keys()]), undirected: true }
    expect(run(one, ['communities'])).toEqual([])
    const a = [...Array(8).keys()]
    const b = a.map((i) => i + 8)
    const two: Spec = { nodes: [...nodes(8, 'left'), ...nodes(8, 'right')], edges: [...clique(a), ...clique(b), [0, 8, 'cross']], undirected: true }
    const r = run(two, ['communities'])
    sound(r, two)
    const ov = by(r, 'communities:overview')!
    expect(ov.title).toMatch(/^2 communities with moderate separation \(modularity 0\.4\d\)/) // two K8 joined by one edge: Q just under a half
    expect(ov.data?.count).toBe(2)
    const comp = by(r, 'communities:composition')!
    expect(comp.visual?.kind).toBe('plot')
    const ties = by(r, 'communities:ties')
    if (ties) expect(ties.data).toBeDefined()
    const profiles = ov.data?.profiles as { size: number; label: string; cohesion: number }[] | undefined
    if (profiles) {
      expect(profiles.map((p) => p.size)).toEqual([8, 8])
      for (const p of profiles) expect(p.cohesion).toBeCloseTo(28 / 29, 2) // rounded to three places in the report
    }
  })

  it('many tiny pairs are many weak communities, none meaningful at 1%; a tag two thirds of a community carries names it', () => {
    const pairs: Spec = { nodes: nodes(40), edges: Array.from({ length: 20 }, (_, i) => [2 * i, 2 * i + 1]) }
    const r = run(pairs, ['communities'])
    sound(r, pairs)
    const ov = by(r, 'communities:overview')!
    expect(ov.data?.count).toBe(20)
    expect(ov.detail).toMatch(/^0 hold at least 1% of entities/) // the floor is at least three members: pairs fall under it
    const a = [...Array(8).keys()]
    const b = a.map((i) => i + 8)
    const tagged: Spec = { nodes: [...Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, tags: i < 6 ? ['hot'] : [] })), ...nodes(8, 'cold')], edges: [...clique(a), ...clique(b), [0, 8]], undirected: true }
    const t = run(tagged, ['communities'])
    sound(t, tagged)
    expect(by(t, 'communities:overview')?.detail).toContain('#hot')
  })
})

describe('schema at the edges', () => {
  it('no declared types: every type in use is undeclared and every property is fine; one type only is "everything is a"; a kind joining every pair is polymorphic', () => {
    const spec: Spec = { nodes: [...nodes(4, 'a'), ...nodes(4, 'b'), ...nodes(4, 'c')], edges: [[0, 4, 'links'], [4, 8, 'links'], [8, 0, 'links'], [1, 5, 'links']] }
    const r = run(spec, ['schema'])
    sound(r, spec)
    expect(by(r, 'schema:declared-vs-used')?.title).toBe('3 types are in use without a declaration')
    expect(by(r, 'schema:coverage')).toBeUndefined()
    expect(by(r, 'schema:patterns')?.detail).toContain('links joins 3 type pairs')
    expect(by(r, 'schema:type-mix')?.title).toBe('Three types make up 100% of the dataset') // the top-three share is judged before the spread
    const four: Spec = { nodes: [...nodes(3, 'a'), ...nodes(3, 'b'), ...nodes(3, 'c'), ...nodes(3, 'd')] }
    expect(by(run(four, ['schema']), 'schema:type-mix')?.title).toBe('4 types in use, fairly evenly spread')
    const mono = run({ nodes: nodes(5, 'only') }, ['schema'])
    expect(by(mono, 'schema:type-mix')?.title).toBe('Everything is a only')
    expect(by(mono, 'schema:patterns')).toBeUndefined()
    expect(by(mono, 'schema:unlinked-types')?.title).toBe('100% of only entities have no relationships')
    expect(run({ nodes: [] }, ['schema'])).toEqual([])
  })

  it('a declared type nobody uses and a property nobody declares are both named; a declared property set on one of ten is a gap; a type of two is not judged', () => {
    const schema: AnalysisInput['schema'] = [
      { type: 'person', label: 'Person', category: 'knowledge', properties: ['name', 'email'], declared: true },
      { type: 'ghost', label: 'Ghost', category: 'knowledge', properties: [], declared: true },
    ]
    const spec: Spec = { nodes: Array.from({ length: 10 }, (_, i) => ({ type: 'person', props: i === 0 ? ['name', 'email', 'phone'] : ['name', 'phone'] })), edges: [[0, 1]], schema }
    const r = run(spec, ['schema'])
    sound(r, spec)
    expect(by(r, 'schema:declared-vs-used')?.title).toBe('1 declared type has no entities')
    expect(by(r, 'schema:declared-vs-used')?.data).toEqual({ empty: ['ghost'], inferred: [] })
    const cov = by(r, 'schema:coverage')!
    expect(cov.title).toBe('“email” is set on only 10% of 10 person entities')
    expect(cov.detail).toContain('Used but undeclared: person.phone 100%')
    const tiny: Spec = { nodes: [{ type: 'person', props: ['name'] }, { type: 'person', props: [] }], edges: [[0, 1]], schema }
    expect(by(run(tiny, ['schema']), 'schema:coverage')).toBeUndefined()
    expect(JSON.stringify(run(spec, ['schema']))).toBe(JSON.stringify(run(spec, ['schema'])))
  })
})
