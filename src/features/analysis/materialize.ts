import { createEntity } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import { emptyFilter, type FilterSpec } from '../../core/graph/filter'
import type { NodeMetricId } from '../../core/graph/metrics/types'
import { isPaletteId, type PaletteId } from '../../core/graph/palettes'
import { PLOT_TYPE, type PlotData } from '../../core/graph/plot'
import { DEFAULT_RENDERING, setDefault, type ColorChannel, type NumberChannel, type RenderingSpec } from '../../core/graph/rendering'
import type { ExplorerHandle } from '../graph/explorerHandle'
import { graphSetupHref, type GraphSetup } from '../../app/openIn'
import type { LayoutAlgorithm } from '../../core/graph/layouts'
import { waitForPlot } from '../plots/plotHandle'
import type { Finding, GraphStyle, Visual } from '../../analysis/types'

export interface MaterializeHost {
  store: EntityStore
  navigate: (to: string) => void
}

export interface Shown {
  kind: Visual['kind']
  route: string
  /** The plot entity created when a name was given. */
  plotId?: EntityId
}

/**
 * Put a finding's visual on screen: a plot on the Scenes page, a filtered
 * and styled Unigraph view with the entities of interest selected and framed,
 * or the Insights page with the table open. `saveAs` keeps a plot as an entity.
 */
export async function showFinding(f: Finding, host: MaterializeHost, opts: { saveAs?: string } = {}): Promise<Shown> {
  const v = f.visual
  if (!v) {
    const route = `/insights?finding=${encodeURIComponent(f.id)}`
    host.navigate(route)
    return { kind: 'table', route }
  }
  if (v.kind === 'plot') {
    let plotId: EntityId | undefined
    if (opts.saveAs) {
      const e = createEntity<PlotData>({ type: PLOT_TYPE, label: opts.saveAs, data: { spec: v.spec }, tags: ['insight'], meta: { source: 'analysis' } })
      host.store.upsert(e)
      plotId = e.id
    }
    const route = plotId ? `/scenes?plot=${encodeURIComponent(plotId)}` : '/scenes?plot=new'
    host.navigate(route)
    const h = await waitForPlot()
    if (!h) throw new Error('The Scenes page did not open its plot mode.')
    if (!plotId) h.setSpec(v.spec)
    return { kind: 'plot', route, plotId }
  }
  if (v.kind === 'graph') {
    // A new explorer tab, set up by itself once it opens (GraphExplorer reads `?setup=`): the Unigraph page
    // comes to the front with the finding as its own tab, whatever other explorers are open or kept behind pages.
    const route = graphSetupHref({ label: v.title || f.title, filter: { ...emptyFilter(), ...(v.filter ?? {}) }, rendering: renderingFor(v.style), metrics: metricsNeeded(v.style), layout: v.layout, labels: v.style?.labels, focus: v.focus ?? v.style?.highlight })
    host.navigate(route)
    return { kind: 'graph', route }
  }
  const route = `/insights?finding=${encodeURIComponent(f.id)}`
  host.navigate(route)
  return { kind: 'table', route }
}

/** What a new tab does with a hand-over: filter, metrics the style needs, style, layout, labels, selection, then a fit. */
export async function applyGraphSetup(h: ExplorerHandle, setup: GraphSetup): Promise<void> {
  if (setup.filter) h.setFilter({ ...emptyFilter(), ...(setup.filter as Partial<FilterSpec>) })
  await sliceSettled(h)
  // Opened on purpose, with its cap set: draw it rather than asking about its size.
  if (h.isGated()) h.acceptLoad(h.getLoad())
  if (setup.layout && h.getState().algorithm !== setup.layout) h.setAlgorithm(setup.layout as LayoutAlgorithm)
  if (setup.labels) h.setLabels(setup.labels)
  // Selection is the highlight: set before the metrics, which can take a while on a big view, so it is there whatever happens to them.
  if (setup.focus?.length) h.setSelection(setup.focus, 'replace')
  // A new tab is seeded with the last tab's held positions; the nodes it adds would be placed around those piecemeal
  // (discs of leaves round each hub) — so the positions are dropped, which makes the explorer lay the whole view out
  // from scratch; the frame waits for that layout to land.
  h.unloadLayout()
  await layoutLanded(h)
  h.fit()
  if (setup.metrics?.length) await ensureMetrics(h, setup.metrics as NodeMetricId[])
  if (setup.rendering) h.setRendering(setup.rendering as RenderingSpec)
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait for the layout job the explorer starts after positions are dropped to begin and finish (a small view lays out at once). */
async function layoutLanded(h: ExplorerHandle, ms = 60000): Promise<void> {
  const t0 = Date.now()
  let seen = false
  while (Date.now() - t0 < ms) {
    const job = h.getState().layoutRunning
    if (job) seen = true
    else if (seen || Date.now() - t0 > 600) return
    await sleep(100)
  }
}

/** After a filter change the slice is recomputed on the next render; wait until two reads agree. */
async function sliceSettled(h: ExplorerHandle, ms = 2000): Promise<void> {
  const t0 = Date.now()
  let last = -1
  await sleep(60)
  while (Date.now() - t0 < ms) {
    const n = h.getSlice().nodes.length
    if (n === last) return
    last = n
    await sleep(90)
  }
}

/**
 * Make sure the explorer holds fresh metric columns for `needed`. The
 * explorer re-runs its own metrics when the view changes and aborts any
 * run in flight, so a run of ours can be cancelled; wait it out and retry.
 */
async function ensureMetrics(h: ExplorerHandle, needed: NodeMetricId[], ms = 20000): Promise<void> {
  const ready = () => {
    const m = h.getMetrics()
    return !!m && !h.getState().metricsStale && needed.every((k) => m.columns[k])
  }
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (ready()) return
    const st = h.getState()
    if (st.metricsRunning) {
      await sleep(120)
      continue
    }
    try {
      await h.runMetrics({ ...st.analysisOptions, metrics: [...new Set([...st.analysisOptions.metrics, ...needed])] })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e
      await sleep(120)
    }
  }
  if (!ready()) throw new Error('The graph metrics did not finish in time.')
}

export function metricsNeeded(style?: GraphStyle): NodeMetricId[] {
  const out: NodeMetricId[] = []
  if (!style) return out
  if (style.color?.by === 'community') out.push('community')
  if (style.color?.by === 'metric' && style.color.metric) out.push(style.color.metric)
  if (style.size?.by === 'metric' && style.size.metric) out.push(style.size.metric)
  return out
}

/** The explorer's rendering spec for a declarative style: defaults, then the two channels the analyses drive. */
export function renderingFor(style?: GraphStyle): RenderingSpec {
  let spec = DEFAULT_RENDERING
  if (!style) return spec
  const pal = (p: string | undefined, fallback: PaletteId): PaletteId => (isPaletteId(p) ? p : fallback)
  let color: ColorChannel | undefined
  if (style.color?.by === 'type') color = { mode: 'constant' }
  else if (style.color?.by === 'community') color = { mode: 'partition', attr: { kind: 'metric', key: 'community' }, palette: pal(style.color.palette, 'tableau10'), maxCategories: 12 }
  else if (style.color?.by === 'tag') color = { mode: 'partition', attr: { kind: 'tag' }, palette: pal(style.color.palette, 'tableau10'), maxCategories: 12 }
  else if (style.color?.by === 'metric' && style.color.metric) color = { mode: 'ranking', attr: { kind: 'metric', key: style.color.metric }, palette: pal(style.color.palette, 'viridis') }
  let size: NumberChannel | undefined
  if (style.size?.by === 'degree') size = { mode: 'ranking', attr: { kind: 'degree' }, min: style.size.min ?? 3, max: style.size.max ?? 14, log: style.size.log ?? true }
  else if (style.size?.by === 'metric' && style.size.metric) size = { mode: 'ranking', attr: { kind: 'metric', key: style.size.metric }, min: style.size.min ?? 3, max: style.size.max ?? 18, log: style.size.log }
  spec = setDefault(spec, 'nodes', { ...(color ? { color } : {}), ...(size ? { size } : {}), label: style.labels !== 'none' })
  return spec
}
