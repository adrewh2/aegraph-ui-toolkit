import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANALYSIS_IDS } from '../../../analysis/types'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import type { AnyEntity } from '../../../core/entity/types'
import { clearMetricsCache } from '../../../core/graph/metrics'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { setLatestAnalysis } from '../../analysis/latest'
import { registerPlotHandle, type PlotHandle } from '../../plots/plotHandle'
import { createAppTools, type AppHost } from '../tools'

/**
 * The analyze tool over the fake host. In Node there is no Worker, so the
 * analyses run inline; the latest run is module state and is cleared
 * between tests. Three communities of people around a document each, a
 * hub bridging them, a duplicate label, loose notes and one burst — the
 * shape src/analysis's own tests use — so every analysis has something to
 * say.
 */

function host(store: EntityStore): AppHost & { navigated: string[] } {
  const navigated: string[] = []
  return { store, navigated, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/insights' }), confirm: async () => true }
}
const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
}

function corpus(store: EntityStore) {
  const t0 = Date.UTC(2024, 0, 1)
  const DAY = 86_400_000
  const out: AnyEntity[] = []
  let n = 0
  const add = (type: string, label: string, day: number, data: Record<string, unknown> = {}, tags: string[] = []) => {
    const id = `e${n++}`
    const at = new Date(t0 + day * DAY).toISOString()
    out.push(createEntity({ id, type, label, tags, data, meta: { createdAt: at, updatedAt: new Date(t0 + (day + 5) * DAY).toISOString() } }))
    return id
  }
  const link = (a: string, b: string, type: string) => out.push(createRelationship({ id: `${a}-${type}-${b}`, type, source: a, target: b }))
  const hub = add('organization', 'Acme', 0, { name: 'Acme' })
  for (let c = 0; c < 3; c++) {
    const doc = add('document', `Report ${c}`, 10 + c * 30, { title: `Report ${c}`, body: '…' }, [`topic-${c}`])
    const people: string[] = []
    for (let k = 0; k < 12; k++) {
      const day = c === 1 ? 40 + (k % 3) : 10 + c * 30 + k * 2
      const p = add('person', `Person ${c}-${k}`, day, k % 6 === 0 ? { name: 'x' } : { name: 'x', role: 'y' }, [`topic-${c}`])
      people.push(p)
      link(p, doc, 'authored')
      if (k) link(people[k - 1], p, 'knows')
      if (k > 1) link(people[k - 2], p, 'knows')
    }
    link(people[0], hub, 'affiliated-with')
    link(people[1], hub, 'affiliated-with')
  }
  add('person', 'Person 0-1', 90, { name: 'x', role: 'y' })
  add('note', 'Loose note', 100)
  add('note', 'Another note', 101)
  store.upsertMany(out)
}

describe('analyze tool', () => {
  let store: EntityStore
  let h: ReturnType<typeof host>
  let tools: ReturnType<typeof createAppTools>
  beforeEach(() => {
    setLatestAnalysis(null)
    clearMetricsCache()
    store = new EntityStore()
    corpus(store)
    h = host(store)
    tools = createAppTools(h)
  })
  afterEach(() => setLatestAnalysis(null))

  it('lists the catalog, and refuses to read findings before a run', async () => {
    const c = await tool(tools, 'analyze')({ action: 'catalog' })
    expect(c.analyses.map((a: { id: string }) => a.id)).toEqual([...ANALYSIS_IDS])
    for (const a of c.analyses) expect(a).toMatchObject({ label: expect.any(String), question: expect.any(String), description: expect.any(String) })
    await expect(tool(tools, 'analyze')({ action: 'findings' })).rejects.toThrow(/No analysis has run yet/)
    await expect(tool(tools, 'analyze')({ action: 'get', finding: 'centrality:hubs' })).rejects.toThrow(/No analysis has run yet/)
  })

  it('runs the analyses over the dataset and returns a briefing with ranked findings', async () => {
    const r = await tool(tools, 'analyze')({ action: 'run', top: 5 })
    expect(r.nodes).toBe(store.library.entityCount())
    expect(r.edges).toBe(store.library.relationshipCount())
    expect(r.scope).toMatchObject({ label: 'Library' })
    expect(typeof r.briefing).toBe('string')
    expect(r.briefing.length).toBeGreaterThan(50)
    expect(r.runs.map((x: { id: string }) => x.id)).toEqual([...ANALYSIS_IDS])
    for (const run of r.runs) expect(run.ms).toBeGreaterThanOrEqual(0)
    expect(r.findings.length).toBe(5)
    const [first, second] = r.findings
    expect(first).toMatchObject({ rank: 1, id: expect.stringMatching(/^[a-z]+:/), score: expect.any(Number), title: expect.any(String), detail: expect.any(String) })
    expect(first.score).toBeGreaterThanOrEqual(second.score)
    expect(second.rank).toBe(2)
    // The corpus is built so the hub, the communities and the duplicate label all show.
    const all = await tool(tools, 'analyze')({ action: 'findings', top: 50 })
    const ids = all.findings.map((f: { id: string }) => f.id)
    expect(ids.some((id: string) => id.startsWith('centrality:'))).toBe(true)
    expect(ids.some((id: string) => id.startsWith('communities:'))).toBe(true)
    expect(ids.some((id: string) => id.startsWith('anomalies:'))).toBe(true)
    expect(ids.some((id: string) => id.startsWith('temporal:'))).toBe(true)
    expect(ids.some((id: string) => id.startsWith('schema:'))).toBe(true)
    expect(all.computedAt).toBeTruthy()
  })

  it('filters findings by analysis, returns one finding with its rows, and limits a run to chosen analyses', async () => {
    await tool(tools, 'analyze')({ action: 'run' })
    const only = await tool(tools, 'analyze')({ action: 'findings', analyses: ['anomalies'], top: 20 })
    expect(only.findings.length).toBeGreaterThan(0)
    for (const f of only.findings) expect(f.id).toMatch(/^anomalies:/)
    const f = only.findings[0]
    const got = await tool(tools, 'analyze')({ action: 'get', finding: f.id })
    expect(got).toMatchObject({ id: f.id, title: f.title, rank: expect.any(Number) })
    expect(Array.isArray(got.entities) || got.entities === undefined).toBe(true)
    expect(got.data === undefined || typeof got.data === 'object').toBe(true)
    await expect(tool(tools, 'analyze')({ action: 'get', finding: 'nope:nothing' })).rejects.toThrow(/No finding nope:nothing/)

    // A run limited to two analyses: only their runs, only their findings.
    setLatestAnalysis(null)
    const two = await tool(tools, 'analyze')({ action: 'run', analyses: ['centrality', 'schema'], top: 50 })
    expect(two.runs.map((x: { id: string }) => x.id)).toEqual(['centrality', 'schema'])
    for (const x of two.findings) expect(x.id).toMatch(/^(centrality|schema):/)
  })

  it('reuses the latest run over the same dataset unless forced, and recomputes when the data changes', async () => {
    const a = await tool(tools, 'analyze')({ action: 'run' })
    const b = await tool(tools, 'analyze')({ action: 'run' })
    const at = (await tool(tools, 'analyze')({ action: 'findings' })).computedAt
    expect(b.findings).toEqual(a.findings)
    // A run limited to analyses the latest one already covers is answered by it too.
    const sub = await tool(tools, 'analyze')({ action: 'run', analyses: ['communities'] })
    expect(sub.runs.length).toBe(5)
    await new Promise((r) => setTimeout(r, 5))
    await tool(tools, 'analyze')({ action: 'run', force: true })
    const forced = (await tool(tools, 'analyze')({ action: 'findings' })).computedAt
    expect(forced).not.toBe(at)
    // New data: the key changes, so the next run computes.
    store.upsert(createEntity({ id: 'late', type: 'note', label: 'Late note' }))
    const c = await tool(tools, 'analyze')({ action: 'run' })
    expect(c.nodes).toBe(a.nodes + 1)
  })

  it('puts a finding on screen: a graph finding opens an explorer set up for it, a plot finding fills the plot workbench', async () => {
    await tool(tools, 'analyze')({ action: 'run' })
    const all = await tool(tools, 'analyze')({ action: 'findings', top: 50 })
    const graph = all.findings.find((f: { visual?: string }) => f.visual?.startsWith('graph:'))
    const plot = all.findings.find((f: { visual?: string }) => f.visual?.startsWith('plot:'))
    expect(graph).toBeDefined()
    expect(plot).toBeDefined()

    const g = await tool(tools, 'analyze')({ action: 'show', finding: graph.id })
    expect(g).toMatchObject({ shown: 'graph', finding: graph.id, title: graph.title })
    expect(g.route).toMatch(/^\/graph\/2d\?/)
    expect(g.route).toContain('setup=')
    expect(h.navigated.at(-1)).toBe(g.route)

    const specs: unknown[] = []
    const handle: PlotHandle = { getState: () => ({ spec: { selector: {}, traces: [] } as never, dirty: false }), setSpec: (s) => specs.push(s), load: () => {}, save: () => 'saved', snapshot: async () => null, resetView: async () => {} }
    const unregister = registerPlotHandle(handle)
    try {
      const p = await tool(tools, 'analyze')({ action: 'show', finding: plot.id })
      expect(p).toMatchObject({ shown: 'plot', finding: plot.id, route: '/scenes?plot=new' })
      expect(specs.length).toBe(1)
      expect(h.navigated.at(-1)).toBe('/scenes?plot=new')
      // Saved as a plot entity: the entity holds the spec and the page opens on it.
      const saved = await tool(tools, 'analyze')({ action: 'show', finding: plot.id, save_as: 'Kept chart' })
      expect(saved.plotId).toBeTruthy()
      expect(saved.route).toBe(`/scenes?plot=${encodeURIComponent(saved.plotId)}`)
      const e = store.get(saved.plotId)!
      expect(e.type).toBe('plot')
      expect(e.label).toBe('Kept chart')
      expect(e.tags).toContain('insight')
      expect(specs.length).toBe(1)
    } finally {
      unregister()
    }
    await expect(tool(tools, 'analyze')({ action: 'show', finding: 'nope:x' })).rejects.toThrow(/No finding/)
  })

  it('keeps a finding as a claim with its evidence, and names a community of the latest run', async () => {
    await tool(tools, 'analyze')({ action: 'run' })
    const list = await tool(tools, 'analyze')({ action: 'findings', analyses: ['centrality'], top: 20 })
    const f = list.findings.find((x: { entities?: string[] }) => x.entities?.length) ?? list.findings[0]
    const kept = await tool(tools, 'analyze')({ action: 'keep', finding: f.id })
    expect(kept.created).toBe(true)
    const claim = store.get(kept.id)!
    expect(claim.type).toBe('claim')
    expect(claim.label).toBe(f.title)
    expect(store.relationshipsOf(claim.id, 'in').filter((r) => r.type === 'supports').length).toBe(kept.evidence)
    // Kept again: the same claim, refreshed — and get reports it.
    const again = await tool(tools, 'analyze')({ action: 'keep', finding: f.id })
    expect(again).toMatchObject({ id: kept.id, created: false })
    expect((await tool(tools, 'analyze')({ action: 'get', finding: f.id })).claim).toBe(kept.id)

    const communities = await tool(tools, 'analyze')({ action: 'findings', analyses: ['communities'], top: 20 })
    const withIds = communities.findings.map((x: { id: string }) => x.id)
    const detail = await tool(tools, 'analyze')({ action: 'get', finding: withIds[0] })
    const number = (detail.data as { communities?: { id: number }[] } | undefined)?.communities?.[0]?.id ?? (Array.isArray(detail.data) ? (detail.data as { id?: number }[]).find((d) => typeof d.id === 'number')?.id : undefined) ?? 0
    const named = await tool(tools, 'analyze')({ action: 'name_community', community: number, label: 'The Report 0 crowd', description: 'Authors of report 0' })
    expect(named.created).toBe(true)
    expect(named.members).toBeGreaterThan(0)
    const c = store.get(named.id)!
    expect(c.type).toBe('community')
    expect(store.relationshipsOf(c.id, 'in').filter((r) => r.type === 'member-of').length).toBe(named.members)
    await expect(tool(tools, 'analyze')({ action: 'name_community', community: 9999, label: 'x' })).rejects.toThrow(/no community 9999/)
    await expect(tool(tools, 'analyze')({ action: 'name_community', community: number })).rejects.toThrow(/label/)
  })
})
