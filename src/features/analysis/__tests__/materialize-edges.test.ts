import { afterEach, describe, expect, it } from 'vitest'
import { readGraphSetup } from '../../../app/openIn'
import { EntityStore } from '../../../core/entity/store'
import { DEFAULT_RENDERING, type RenderingSpec } from '../../../core/graph/rendering'
import { emptyFilter } from '../../../core/graph/filter'
import type { MetricsResult } from '../../../core/graph/metrics/types'
import '../../../core/graph/types'
import type { Finding } from '../../../analysis/types'
import type { ExplorerHandle } from '../../graph/explorerHandle'
import { registerPlotHandle, type PlotHandle } from '../../plots/plotHandle'
import { applyGraphSetup, metricsNeeded, renderingFor, showFinding } from '../materialize'

/**
 * Materialising a finding at its edges: a style with an unknown colour or
 * size mode, a metric mode without a metric, an unknown palette, no
 * style at all; metricsNeeded on every shape; showFinding on a finding
 * without a visual, a table, a plot with and without a name (through a
 * fake plot handle, and with none), a graph visual whose hand-over is
 * read back; applyGraphSetup through a recording handle — a setup of a
 * filter alone, of a focus alone, a gated view accepted, a layout
 * already current, metrics present vs missing vs stale, a run aborted
 * once, a run that fails.
 */
const finding = (visual?: Finding['visual']): Finding => ({ id: 'anomalies:x', analysis: 'anomalies', title: 'A finding', detail: 'd', score: 0.5, visual })

describe('styles and metrics', () => {
  it('unknown colour or size modes, a metric mode without a metric, and no style give the default look; an unknown palette falls back; labels off turns the label channel off', () => {
    expect(renderingFor()).toBe(DEFAULT_RENDERING)
    expect(renderingFor({ color: { by: 'sunset' as never }, size: { by: 'mass' as never } }).nodes.default).toMatchObject({ color: DEFAULT_RENDERING.nodes.default.color, size: DEFAULT_RENDERING.nodes.default.size, label: true })
    expect(renderingFor({ color: { by: 'metric' }, size: { by: 'metric' } }).nodes.default.color).toEqual(DEFAULT_RENDERING.nodes.default.color)
    expect(renderingFor({ color: { by: 'tag', palette: 'no-such-palette' } }).nodes.default.color).toMatchObject({ mode: 'partition', attr: { kind: 'tag' }, palette: 'tableau10' })
    expect(renderingFor({ color: { by: 'metric', metric: 'betweenness', palette: 'no-such-palette' } }).nodes.default.color).toMatchObject({ mode: 'ranking', attr: { kind: 'metric', key: 'betweenness' }, palette: 'viridis' })
    expect(renderingFor({ color: { by: 'type' } }).nodes.default.color).toEqual({ mode: 'constant' })
    expect(renderingFor({ size: { by: 'degree' } }).nodes.default.size).toEqual({ mode: 'ranking', attr: { kind: 'degree' }, min: 3, max: 14, log: true })
    expect(renderingFor({ size: { by: 'degree', log: false, min: 0, max: 0 } }).nodes.default.size).toMatchObject({ min: 0, max: 0, log: false })
    expect(renderingFor({ labels: 'none' }).nodes.default.label).toBe(false)
    expect(renderingFor({ labels: 'all' }).nodes.default.label).toBe(true)
    expect(metricsNeeded()).toEqual([])
    expect(metricsNeeded({ color: { by: 'metric' } })).toEqual([])
    expect(metricsNeeded({ color: { by: 'metric', metric: 'pagerank' }, size: { by: 'metric', metric: 'pagerank' } })).toEqual(['pagerank', 'pagerank'])
    expect(metricsNeeded({ color: { by: 'community' }, size: { by: 'degree' } })).toEqual(['community'])
  })
})

describe('showFinding', () => {
  let off: (() => void) | undefined
  afterEach(() => off?.())

  it('no visual or a table goes to Insights with the finding named; a plot without a name goes to a new plot and sets its spec, with a name saves an entity first; no plot mode is an error', async () => {
    const store = new EntityStore()
    const routes: string[] = []
    const host = { store, navigate: (r: string) => routes.push(r) }
    expect(await showFinding(finding(), host)).toEqual({ kind: 'table', route: '/insights?finding=anomalies%3Ax' })
    expect(await showFinding(finding({ kind: 'table', title: 't', columns: ['a'], rows: [[1]] }), host)).toEqual({ kind: 'table', route: '/insights?finding=anomalies%3Ax' })
    const specs: unknown[] = []
    const plot: PlotHandle = { getState: () => ({ spec: { traces: [] }, dirty: false }), setSpec: (s) => specs.push(s), load() {}, save: () => 'x', snapshot: async () => null, resetView: async () => {} }
    off = registerPlotHandle(plot)
    const spec = { traces: [{ kind: 'bar' as const, x: 'type', agg: 'count' as const }] }
    const shown = await showFinding(finding({ kind: 'plot', title: 'p', spec }), host)
    expect(shown).toEqual({ kind: 'plot', route: '/scenes?plot=new', plotId: undefined })
    expect(specs).toEqual([spec])
    const saved = await showFinding(finding({ kind: 'plot', title: 'p', spec }), host, { saveAs: 'Kept' })
    expect(saved.plotId).toBeDefined()
    expect(saved.route).toBe(`/scenes?plot=${encodeURIComponent(saved.plotId!)}`)
    expect(store.get(saved.plotId!)).toMatchObject({ type: 'plot', label: 'Kept', tags: ['insight'], data: { spec } })
    expect(specs).toHaveLength(1) // a saved plot is loaded by id, not set by hand
    expect(routes).toEqual(['/insights?finding=anomalies%3Ax', '/insights?finding=anomalies%3Ax', '/scenes?plot=new', saved.route])
    off()
    off = undefined
    // No plot mode registers: the call waits (and, five seconds on, would throw "did not open"); the wait is not a return.
    const pending = showFinding(finding({ kind: 'plot', title: 'p', spec }), host)
    pending.catch(() => {}) // the timeout's rejection lands after this test is over
    await expect(Promise.race([pending, new Promise((r) => setTimeout(() => r('still waiting'), 300))])).resolves.toBe('still waiting')
    expect(routes.at(-1)).toBe('/scenes?plot=new')
  })

  it('a graph visual hands over a setup a new tab can read back: the filter over the empty one, the style as a rendering, the metrics it needs, layout, labels and the focus (or the highlight)', async () => {
    const routes: string[] = []
    const host = { store: new EntityStore(), navigate: (r: string) => routes.push(r) }
    const shown = await showFinding(finding({ kind: 'graph', title: 'G', filter: { types: ['person'] }, style: { color: { by: 'community' }, size: { by: 'metric', metric: 'pagerank' }, highlight: ['h1'], labels: 'none' }, layout: 'circular' }), host)
    expect(shown.kind).toBe('graph')
    expect(shown.route).toMatch(/^\/graph\/2d\?setup=\w+$/)
    const setup = readGraphSetup(new URL(shown.route, 'http://x').searchParams.get('setup')!)!
    expect(setup).toMatchObject({ label: 'G', filter: { ...emptyFilter(), types: ['person'] }, metrics: ['community', 'pagerank'], layout: 'circular', labels: 'none', focus: ['h1'] })
    expect((setup.rendering as RenderingSpec).nodes.default.label).toBe(false)
    const bare = await showFinding(finding({ kind: 'graph', title: '', focus: ['f1'], style: { highlight: ['h1'] } }), host)
    const s2 = readGraphSetup(new URL(bare.route, 'http://x').searchParams.get('setup')!)!
    expect(s2).toMatchObject({ label: 'A finding', filter: emptyFilter(), metrics: [], focus: ['f1'] }) // the finding's title stands in; focus beats highlight
    expect(s2.layout).toBeUndefined()
  })
})

/** A handle that records what the setup does to it and answers as scripted. */
function fakeHandle(opts: { gated?: boolean; algorithm?: string; nodes?: number; metrics?: MetricsResult; stale?: boolean; runMetrics?: (calls: number) => MetricsResult | Error } = {}) {
  const log: string[] = []
  let metrics = opts.metrics
  let stale = opts.stale ?? false
  let layoutRunning = false
  let runs = 0
  const h = {
    setFilter: (f: unknown) => log.push(`filter ${JSON.stringify((f as { types?: string[] }).types)}`),
    getSlice: () => ({ nodes: new Array(opts.nodes ?? 3).fill({}), edges: [] }),
    isGated: () => !!opts.gated,
    gateReason: () => (opts.gated ? 'budget' : undefined),
    getLoad: () => ({ nodes: opts.nodes ?? 3, edges: 0 }),
    acceptLoad: (l: unknown) => log.push(`accept ${JSON.stringify(l)}`),
    getState: () => ({ algorithm: opts.algorithm ?? 'force', layoutRunning, metricsStale: stale, metricsRunning: false, analysisOptions: { metrics: ['degree'] } }),
    setAlgorithm: (a: string) => log.push(`algorithm ${a}`),
    setLabels: (l: string) => log.push(`labels ${l}`),
    setSelection: (ids: string[], mode: string) => log.push(`select ${ids.join(',')} ${mode}`),
    unloadLayout: () => {
      log.push('unload')
      layoutRunning = true
      setTimeout(() => (layoutRunning = false), 150)
    },
    fit: () => log.push('fit'),
    getMetrics: () => metrics,
    runMetrics: async (o: { metrics: string[] }) => {
      runs++
      log.push(`metrics ${o.metrics.join(',')}`)
      const r = opts.runMetrics ? opts.runMetrics(runs) : ({ columns: Object.fromEntries(o.metrics.map((m) => [m, new Float64Array(1)])) } as unknown as MetricsResult)
      if (r instanceof Error) throw r
      metrics = r
      stale = false
      return r
    },
    setRendering: (r: RenderingSpec) => log.push(`render ${r.nodes.default.color?.mode}`),
  }
  return { h: h as unknown as ExplorerHandle, log }
}

describe('applyGraphSetup', () => {
  it('a filter alone: set, settled, positions dropped, layout awaited, fit — no algorithm, labels, selection, metrics or rendering', async () => {
    const { h, log } = fakeHandle()
    await applyGraphSetup(h, { label: 'x', filter: { types: ['a'] } })
    expect(log).toEqual(['filter ["a"]', 'unload', 'fit'])
  })

  it('a focus alone selects before the layout; a gated view is accepted at its load; a layout already current is not set again; labels pass through', async () => {
    const { h, log } = fakeHandle({ gated: true, algorithm: 'circle', nodes: 7 })
    await applyGraphSetup(h, { label: 'x', focus: ['a', 'b'], layout: 'circle', labels: 'all' })
    expect(log).toEqual(['accept {"nodes":7,"edges":0}', 'labels all', 'select a,b replace', 'unload', 'fit'])
    const other = fakeHandle({ algorithm: 'circle' })
    await applyGraphSetup(other.h, { label: 'x', layout: 'grid', focus: [] })
    expect(other.log).toEqual(['algorithm grid', 'unload', 'fit'])
  })

  it('metrics: present and fresh — no run; missing — one run with the union of options and needs, then the rendering; stale — a run; aborted once — retried; failing otherwise — the error propagates', async () => {
    const have = { columns: { community: new Float64Array(1), pagerank: new Float64Array(1) } } as unknown as MetricsResult
    const fresh = fakeHandle({ metrics: have })
    await applyGraphSetup(fresh.h, { label: 'x', metrics: ['community'], rendering: renderingFor({ color: { by: 'community' } }) })
    expect(fresh.log).toEqual(['unload', 'fit', 'render partition'])
    const missing = fakeHandle()
    await applyGraphSetup(missing.h, { label: 'x', metrics: ['community', 'pagerank'], rendering: renderingFor({ color: { by: 'community' } }) })
    expect(missing.log).toEqual(['unload', 'fit', 'metrics degree,community,pagerank', 'render partition'])
    const stale = fakeHandle({ metrics: have, stale: true })
    await applyGraphSetup(stale.h, { label: 'x', metrics: ['community'] })
    expect(stale.log).toEqual(['unload', 'fit', 'metrics degree,community'])
    const aborted = fakeHandle({ runMetrics: (n) => (n === 1 ? Object.assign(new Error('cancelled'), { name: 'AbortError' }) : ({ columns: { community: new Float64Array(1) } } as unknown as MetricsResult)) })
    await applyGraphSetup(aborted.h, { label: 'x', metrics: ['community'] })
    expect(aborted.log.filter((l) => l.startsWith('metrics'))).toHaveLength(2)
    const failing = fakeHandle({ runMetrics: () => new Error('engine down') })
    await expect(applyGraphSetup(failing.h, { label: 'x', metrics: ['community'] })).rejects.toThrow('engine down')
  })
})
