import { afterEach, describe, expect, it } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { ANALYSIS_IDS, type AnalysisId } from '../../../analysis/types'
import { createAnalysisTools } from '../../assistant/analysisTools'
import type { AppHost } from '../../assistant/tools'
import { buildAnalysisInput } from '../buildInput'
import { getLatestAnalysis, metricsForKey, setAnalysisError, setAnalysisProgress, setLatestAnalysis, useLatestAnalysis, type LatestAnalysis } from '../latest'
import { cancelInsights, runInsights } from '../runInsights'
import '../../../core/graph/types'

/**
 * The analysis registry and the run around it, at the edges: nothing run
 * yet, a run set then cleared, progress / error / run each clearing the
 * others, listeners told once per change and let go cleanly, metricsForKey
 * for the current key and another, a run over an empty store, one over a
 * store too small to say anything, unknown analysis ids, the same call
 * twice sharing one run and a forced one replacing it, the input built
 * from empty and odd data (no props for blanks, NaN for bad dates, a
 * schema end left out, a project scope), and what the analyze tool
 * refuses before running.
 */
const reg = () => (globalThis as unknown as { __aegraphAnalysis: { state: ReturnType<typeof getLatestAnalysis> extends infer L ? { latest: L; running: unknown; error: string | null } : never; listeners: Set<() => void> } }).__aegraphAnalysis
const fake = (key: string, nodes = 0): LatestAnalysis => ({ report: { computedAt: 'now', key, scope: { label: 'Library' }, nodes, edges: 0, runs: [], findings: [], metrics: [], ms: 0 }, metrics: { computedAt: 'now', sliceKey: key, options: { metrics: [] }, ids: [], columns: {}, summary: {} } as unknown as LatestAnalysis['metrics'] })
const tool = (store: EntityStore, name: string) => {
  const t = createAnalysisTools({ store, navigate: () => {}, getContext: () => ({ route: '/insights' }), confirm: async () => true } as unknown as AppHost).find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
}

describe('analysis registry edges', () => {
  afterEach(() => setLatestAnalysis(null))

  it('starts empty; a run, progress and an error each clear what they should; a listener hears each change once and can leave', () => {
    expect(getLatestAnalysis()).toBeNull()
    expect(metricsForKey('anything')).toBeUndefined()
    const heard: string[] = []
    const listener = () => heard.push(JSON.stringify([!!reg().state.latest, reg().state.running, reg().state.error]))
    reg().listeners.add(listener)
    setAnalysisProgress({ stage: 'metrics', done: 0, total: 1 })
    setAnalysisError('boom')
    expect(reg().state).toMatchObject({ latest: null, running: null, error: 'boom' })
    setAnalysisProgress({ stage: 'centrality', done: 1, total: 5 })
    // Progress does not clear an old error; a new run clears both.
    expect(reg().state).toMatchObject({ running: { stage: 'centrality', done: 1, total: 5 }, error: 'boom' })
    setLatestAnalysis(fake('k1'))
    expect(reg().state).toMatchObject({ running: null, error: null })
    expect(getLatestAnalysis()?.report.key).toBe('k1')
    // An error after a run keeps the run on show.
    setAnalysisError('later')
    expect(getLatestAnalysis()?.report.key).toBe('k1')
    setLatestAnalysis(null)
    expect(getLatestAnalysis()).toBeNull()
    expect(heard.length).toBe(6)
    reg().listeners.delete(listener)
    setAnalysisProgress(null)
    expect(heard.length).toBe(6)
    expect(typeof useLatestAnalysis).toBe('function')
  })

  it('metricsForKey answers only for the run’s own key, and the state object is replaced, never mutated', () => {
    const before = reg().state
    setLatestAnalysis(fake('k9', 3))
    expect(reg().state).not.toBe(before)
    expect(metricsForKey('k9')?.sliceKey).toBe('k9')
    expect(metricsForKey('k8')).toBeUndefined()
    expect(metricsForKey('')).toBeUndefined()
    const l = getLatestAnalysis()!
    setAnalysisProgress({ stage: 'x', done: 0, total: 1 })
    expect(getLatestAnalysis()).toBe(l) // the same run object while progress changes around it
  })

  it('runs over an empty store and a tiny one: every analysis reports with a note, no findings, and the run is published', async () => {
    const store = new EntityStore()
    const registry = new TypeRegistry(store)
    const r = await runInsights(store, registry)
    expect(r.report.nodes).toBe(0)
    expect(r.report.edges).toBe(0)
    expect(r.report.findings).toEqual([])
    expect(r.report.runs.map((x) => x.id)).toEqual(ANALYSIS_IDS)
    expect(r.report.runs.every((x) => x.note === 'Too few entities to say anything.')).toBe(true)
    expect(getLatestAnalysis()).toBe(r)
    expect(reg().state).toMatchObject({ running: null, error: null })
    expect(metricsForKey(r.report.key)).toBe(r.metrics)
    store.upsertMany([createEntity({ id: 'a', type: 'note' }), createEntity({ id: 'b', type: 'note' }), createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' })])
    const r2 = await runInsights(store, registry)
    expect(r2).not.toBe(r)
    expect(r2.report.nodes).toBe(2)
    expect(r2.report.edges).toBe(1)
    // Two notes and a link are still "too few" for most analyses, but the schema analysis has a type mix to report.
    expect(r2.report.findings.every((f) => Number.isFinite(f.score) && f.analysis === 'schema')).toBe(true)
    expect(r2.report.runs.filter((x) => x.findings.length).map((x) => x.id)).toEqual(['schema'])
  })

  it('unknown analysis ids run nothing; two calls share one run; force replaces it; cancel is harmless when nothing runs', async () => {
    const store = new EntityStore()
    const registry = new TypeRegistry(store)
    store.upsertMany(Array.from({ length: 8 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `N${i}` })))
    const none = await runInsights(store, registry, ['nope' as AnalysisId])
    expect(none.report.runs).toEqual([])
    expect(none.report.metrics).toEqual([])
    const p1 = runInsights(store, registry, ['schema'])
    const p2 = runInsights(store, registry, ['schema'])
    expect(p2).toBe(p1)
    const a = await p1
    expect(a.report.runs.map((x) => x.id)).toEqual(['schema'])
    // Same data, same analyses: the latest answers without a run; a superset runs again; force runs again.
    expect(await runInsights(store, registry, ['schema'])).toBe(a)
    const b = await runInsights(store, registry, ['schema', 'anomalies'])
    expect(b).not.toBe(a)
    expect(b.report.runs.map((x) => x.id)).toEqual(['schema', 'anomalies'])
    expect(await runInsights(store, registry, ['schema'])).toBe(b)
    const c = await runInsights(store, registry, ['schema'], {}, { force: true })
    expect(c).not.toBe(b)
    cancelInsights()
    expect(getLatestAnalysis()).toBe(c)
  })

  it('builds the input from an empty store and from odd data: blanks are not properties, bad dates are NaN, a schema end is left out, a scope narrows', () => {
    const store = new EntityStore()
    const registry = new TypeRegistry(store)
    const empty = buildAnalysisInput(store, registry)
    expect(empty.ids).toEqual([])
    expect(empty.src.length).toBe(0)
    expect(empty.scope).toEqual({ label: 'Library' })
    expect(typeof empty.key).toBe('string')
    store.upsertMany([
      createEntity({ id: 'a', type: 'note', label: '', data: { blank: '', nil: null, undef: undefined, empty: [], zero: 0, no: false, label: 'base key', text: 'x' }, meta: { createdAt: 'not a date', updatedAt: '' } }),
      createEntity({ id: 'type:note', type: 'schema:type', data: { name: 'note' } }),
      createEntity({ id: 'project:p', type: 'project', label: 'P' }),
      createEntity({ id: 'b', type: 'note', label: 'B', meta: { projects: ['project:p'] } }),
      createRelationship({ id: 'at', type: 'r', source: 'a', target: 'type:note' }),
      createRelationship({ id: 'ab', type: 'r', source: 'a', target: 'b' }),
    ])
    const input = buildAnalysisInput(store, registry)
    expect(input.ids.sort()).toEqual(['a', 'b'])
    const ia = input.ids.indexOf('a')
    expect(input.labels[ia]).toBe('a')
    expect(input.props[ia]).toEqual(['zero', 'no', 'text'])
    expect(Number.isNaN(input.created[ia])).toBe(true)
    expect(Number.isNaN(input.updated[ia])).toBe(true)
    expect(input.edgeIds).toEqual(['ab'])
    expect(input.schema.map((t) => t.type)).not.toContain('schema:type')
    expect(input.schema.map((t) => t.type)).not.toContain('project')
    store.setScope('project:p')
    const scoped = buildAnalysisInput(store, registry)
    expect(scoped.ids).toEqual(['b'])
    expect(scoped.src.length).toBe(0)
    expect(scoped.scope).toEqual({ label: 'P', projectId: 'project:p' })
    expect(scoped.key).not.toBe(input.key)
    store.setScope(null)
  })

  it('the analyze tool refuses what it cannot do, naming what it needs', async () => {
    const store = new EntityStore()
    const analyze = tool(store, 'analyze')
    await expect(analyze({ action: 'name_community', community: 0, label: 'x' })).rejects.toThrow(/No analysis has run yet/)
    await runInsights(store, new TypeRegistry(store), ['schema'])
    await expect(analyze({ action: 'get', finding: 'nope:thing' })).rejects.toThrow(/No finding nope:thing/)
    await expect(analyze({ action: 'name_community', label: 'x' })).rejects.toThrow(/needs `community`/)
    await expect(analyze({ action: 'name_community', community: 3, label: '   ' })).rejects.toThrow(/needs a `label`/)
    await expect(analyze({ action: 'name_community', community: 3, label: 'Three' })).rejects.toThrow(/no community 3/)
    expect((await analyze({ action: 'findings', analyses: ['temporal'] })).findings).toEqual([])
    // Bounds live in the schema the model reads (parse itself is JSON only): top 1–50, per_analysis 1–12, analyses from the catalogue.
    const schema = (createAnalysisTools({ store } as unknown as AppHost)[0] as unknown as { input_schema: { properties: Record<string, { minimum?: number; maximum?: number; items?: { enum?: string[] } }> } }).input_schema.properties
    expect([schema.top.minimum, schema.top.maximum, schema.per_analysis.minimum, schema.per_analysis.maximum]).toEqual([1, 50, 1, 12])
    expect(schema.analyses.items?.enum).toEqual(ANALYSIS_IDS)
  })
})
