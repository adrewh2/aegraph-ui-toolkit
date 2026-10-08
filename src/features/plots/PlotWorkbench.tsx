import { ArrowLeft, BarChart3, BoxSelect, Code2, Download, ExternalLink, Hand, Maximize2, Plus, Search, Table2, Waypoints, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { browserHref, entityHref, pickHref, takePlotRows, relatedItems } from '../../app/openIn'
import type { Selector } from '../../core/graph/selector'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { createEntity, displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { buildPlot, describePlot, isPlot, PLOT_TYPE, type BuiltPlot, type PlotData, type PlotSpec } from '../../core/graph/plot'
import { plotPreview } from '../../core/graph/thumbnail'
import { datasetColumnRefs, datasetOf, datasetRowEntities } from '../../core/datasets/join'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { SavedPicker } from '../graph/SavedPicker'
import { PlotPanel } from './PlotPanel'
import { loadPlotly, panChart, PlotlyChart, zoomChart, type PointPick } from './PlotlyChart'
import { Inspector } from '../resources/Inspector'
import { usePlotContext } from './plotContext'
import { registerPlotHandle } from './plotHandle'
import { plotToScript } from './plotScript'
import { saveScript } from '../scripts/script'
import { useOpenInTab } from '../workstation/paneContext'
import './plots.css'

const DRAFT_KEY = 'aegraph:plots:draft'
function readDraft(): PlotSpec | undefined {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const v = raw ? (JSON.parse(raw) as { spec?: PlotSpec }) : undefined
    return v?.spec && Array.isArray(v.spec.traces) ? v.spec : undefined
  } catch {
    return undefined
  }
}

/** Where a new plot starts: activity over time, the question most datasets get asked first. */
export const DEFAULT_PLOT: PlotSpec = { traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month', agg: 'count' }], layout: { title: 'Activity per month' } }

export const PLOT_TEMPLATES: { label: string; spec: PlotSpec }[] = [
  { label: 'Activity per month', spec: DEFAULT_PLOT },
  { label: 'Activity per month, by type', spec: { traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month', agg: 'count', group: 'type' }], layout: { title: 'Activity per month by type', barmode: 'stack' } } },
  { label: 'Cumulative growth', spec: { traces: [{ kind: 'area', x: 'meta.createdAt', bin: 'week', agg: 'count', cumulative: true }], layout: { title: 'Cumulative entities' } } },
  { label: 'Created × updated (scatter)', spec: { traces: [{ kind: 'scatter', x: 'meta.createdAt', y: 'meta.updatedAt', color: 'degree' }], layout: { title: 'Created vs updated' } } },
  { label: 'Degree distribution', spec: { traces: [{ kind: 'histogram', x: 'degree' }], layout: { title: 'Degree distribution' } } },
  { label: 'Share by type', spec: { traces: [{ kind: 'pie', x: 'type' }], layout: { title: 'Entities by type' } } },
]

/**
 * The Scenes page's plot: a chart over entities built from a spec whose
 * axes, colours and groups are value references. Rows come from the whole
 * dataset (or a loaded project), never from the explorer's filter. Saved
 * plots are `plot` entities; the assistant drives the same state through
 * the plot handle.
 */
export function PlotWorkbench({ title }: { title?: ReactNode } = {}) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const toast = useToast()
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const [params, setParams] = useSearchParams()
  const [pointMenu, setPointMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [inspected, setInspected] = useState<EntityId | null>(null)
  const [dragmode, setDragmode] = useState<'pan' | 'zoom'>('pan')
  const wanted = params.get('plot') ?? undefined
  const [plotId, setPlotId] = useState<EntityId | undefined>(wanted && wanted !== 'new' && isPlot(store.get(wanted)) ? wanted : undefined)
  // An unsaved spec survives a refresh: it is kept under its own key until it is saved or replaced.
  // `?plot=new&types=…&tags=…&text=…&pick=…` — a hand-off from a table: the default chart over those rows.
  const handoff = useMemo(() => {
    if (wanted !== 'new') return undefined
    const rows = takePlotRows(params)
    if (!rows) return undefined
    const { types, tags, text, ids, label } = rows
    if (!types?.length && !tags?.length && !text && !ids?.length) return undefined
    const selector: Selector = { ...(types?.length ? { types } : {}), ...(tags?.length ? { tags } : {}), ...(text ? { text } : {}), ...(ids?.length ? { ids } : {}) }
    const what = label ?? (ids?.length ? `${ids.length} entities` : [types?.join(', '), tags?.map((t) => `#${t}`).join(' '), text ? `“${text}”` : ''].filter(Boolean).join(' · '))
    return { selector, title: `${what} — activity per month` }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])
  const [spec, setSpec] = useState<PlotSpec>(() => {
    const e = wanted ? store.get(wanted) : undefined
    if (isPlot(e)) return e.data.spec
    if (handoff) return { ...DEFAULT_PLOT, selector: handoff.selector, layout: { ...DEFAULT_PLOT.layout, title: handoff.title } }
    return readDraft() ?? DEFAULT_PLOT
  })
  const [dirty, setDirty] = useState(() => !!handoff || (!(wanted && isPlot(store.get(wanted))) && !!readDraft()))
  useEffect(() => {
    try {
      if (dirty) localStorage.setItem(DRAFT_KEY, JSON.stringify({ spec, plotId }))
      else localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* ignore */
    }
  }, [spec, dirty, plotId])
  const [newMenu, setNewMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const chartEl = useRef<HTMLDivElement | null>(null)
  const side = useResizableWidth({ storageKey: 'aegraph:plots:side-width', initial: 380, min: 280, max: 720, edge: 'start' })
  const ctx = usePlotContext()

  // Follow the URL: `?plot=<id>` loads a saved plot.
  useEffect(() => {
    if (!wanted || wanted === 'new' || wanted === plotId) return
    const e = store.get(wanted)
    if (isPlot(e)) {
      setPlotId(e.id)
      setSpec(e.data.spec)
      setDirty(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])

  const built = useMemo<{ plot?: BuiltPlot; error?: string }>(() => {
    try {
      const plot = buildPlot(spec, ctx)
      plot.layout.uirevision = plotId ?? 'new'
      return { plot }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }, [spec, ctx, plotId])
  // What the pickers offer follows the rows chosen, so a plot of people lists people's properties — and a plot of a
  // dataset lists its columns.
  const table = spec.dataset ? datasetOf(store, spec.dataset) : undefined
  const rows = useMemo(() => (table ? datasetRowEntities(table) : spec.selector ? ctx.resolve(spec.selector) : undefined), [ctx, spec.selector, table])
  const refs = useMemo(() => (table ? datasetColumnRefs(table.data) : ctx.refs(rows)), [ctx, rows, table])
  // What the suggestions look at: the chosen rows, else everything.
  const rowSample = useMemo(() => rows ?? store.all().filter((e) => e.kind === 'entity').slice(0, 500), [rows, store])

  const change = useCallback((next: PlotSpec) => {
    setSpec(next)
    setDirty(true)
  }, [])

  const save = useCallback(
    (name: string, existing?: AnyEntity | EntityId): EntityId => {
      const id = typeof existing === 'string' ? existing : existing?.id
      const summary = built.plot ? { rows: built.plot.stats.rows, traces: built.plot.stats.traces } : undefined
      const data: PlotData = { spec, summary, preview: built.plot ? plotPreview(built.plot) : undefined }
      if (id && store.has(id)) {
        store.update(id, { label: name, data })
        setPlotId(id)
        setParams({ plot: id }, { replace: true })
        setDirty(false)
        toast(`Saved “${name}”`)
        return id
      }
      const e = createEntity<PlotData>({ type: PLOT_TYPE, label: name, data, tags: [], meta: { source: 'user' } })
      store.upsert(e)
      setPlotId(e.id)
      setParams({ plot: e.id }, { replace: true })
      setDirty(false)
      toast(`Saved “${name}”`)
      return e.id
    },
    [built.plot, spec, store, setParams, toast],
  )
  const load = useCallback(
    (e: AnyEntity | EntityId) => {
      const ent = typeof e === 'string' ? store.get(e) : e
      if (!isPlot(ent)) return
      setPlotId(ent.id)
      setSpec(ent.data.spec)
      setDirty(false)
      setParams({ plot: ent.id }, { replace: true })
    },
    [store, setParams],
  )
  const unload = () => {
    setPlotId(undefined)
    setSpec(DEFAULT_PLOT)
    setDirty(false)
    setParams({ plot: 'new' }, { replace: true })
  }
  const snapshot = useCallback(async (opts: { width?: number; height?: number } = {}) => {
    const el = chartEl.current
    if (!el) return null
    const Plotly = await loadPlotly()
    const url = await Plotly.toImage(el, { format: 'png', width: opts.width ?? 1200, height: opts.height ?? 700, scale: 2 })
    return (await fetch(url)).blob()
  }, [])
  const resetView = useCallback(async () => {
    const el = chartEl.current
    if (!el) return
    const Plotly = await loadPlotly()
    await Plotly.relayout(el, { 'xaxis.autorange': true, 'yaxis.autorange': true })
  }, [])
  const zoom = (factor: number) => chartEl.current && zoomChart(chartEl.current, factor)
  const pan = (dx: number, dy: number) => chartEl.current && panChart(chartEl.current, dx, dy)
  // Arrow keys pan, +/- zoom, 0 fits — when the chart (not a field) has the focus.
  const onStageKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const step = e.shiftKey ? 0.5 : 0.15
    if (e.key === 'ArrowLeft') pan(-step, 0)
    else if (e.key === 'ArrowRight') pan(step, 0)
    else if (e.key === 'ArrowUp') pan(0, step)
    else if (e.key === 'ArrowDown') pan(0, -step)
    else if (e.key === '+' || e.key === '=') zoom(1.5)
    else if (e.key === '-' || e.key === '_') zoom(1 / 1.5)
    else if (e.key === '0') void resetView()
    else return
    e.preventDefault()
  }
  /** The chart as code: a script entity that draws the same picture from the dataset, opened and run on the Scripts page. */
  const exportScript = () => {
    const label = `${plotLabel} — script`
    const code = plotToScript(spec, { label: plotLabel, date: new Date() })
    const e = saveScript(store, code, label, undefined, undefined, 'js', `The “${plotLabel}” chart, written out from Charts: ${describePlot(spec)}`)
    if (plotId) store.update(e.id, { meta: { ...e.meta, derivedFrom: { id: plotId } } } as never)
    toast(`Saved script “${label}”`)
    openTab(`/analytics/scripts?script=${encodeURIComponent(e.id)}&run=1`, plotLabel)
  }
  const exportPng = async () => {
    const blob = await snapshot()
    if (!blob) return toast('Nothing to export yet')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(plotId ? displayLabel(store.get(plotId)!) : spec.layout?.title ?? 'plot').replace(/[^\w.-]+/g, '_')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // The assistant's handle to this workbench.
  const live = useRef({ plotId, spec, dirty, stats: built.plot?.stats })
  live.current = { plotId, spec, dirty, stats: built.plot?.stats }
  useEffect(
    () =>
      registerPlotHandle({
        getState: () => live.current,
        setSpec: change,
        load,
        save,
        snapshot,
        resetView,
      }),
    [change, load, save, snapshot, resetView],
  )

  /** Every entity the current plot draws, for "all rows → Entities". */
  const allRowIds = useCallback((): EntityId[] => {
    const ids = new Set<EntityId>()
    for (const t of built.plot?.data ?? []) for (const cell of (t.customdata as unknown[] | undefined) ?? []) for (const id of Array.isArray(cell) ? (cell as unknown[]).flat() : []) ids.add(String(id))
    return [...ids]
  }, [built.plot])
  const plotLabel = plotId ? displayLabel(store.get(plotId)!) : (spec.layout?.title ?? 'plot')

  /** What a point offers: the entity behind it (open, show, inspect) or the set behind a bin (show them all, or one by one). */
  const onPick = useCallback(
    (pick: PointPick) => {
      const ents = pick.ids.map((id) => store.get(id)).filter((e): e is AnyEntity => !!e)
      if (!ents.length) return
      const where = pick.trace ? `${pick.trace} · ${String(pick.x ?? '')}` : String(pick.x ?? '')
      const items: MenuItem[] = []
      if (ents.length === 1) {
        const e = ents[0]
        items.push(
          { kind: 'label', label: `${displayLabel(e)} · ${registry.get(e.type).label}` },
          { kind: 'item', label: 'Inspect here', icon: Search, onSelect: () => setInspected(e.id) },
          { kind: 'item', label: 'Show in Entities', icon: Table2, onSelect: () => navigate(browserHref(e, registry)) },
          { kind: 'item', label: 'Open', icon: ExternalLink, onSelect: () => navigate(entityHref(e, registry)) },
          { kind: 'item', label: 'Show in 2D graph', icon: Waypoints, onSelect: () => navigate(`/unigraph/2d?sel=${encodeURIComponent(e.id)}`) },
          ...relatedItems(store, [e.id], openTab),
        )
      } else {
        items.push(
          { kind: 'label', label: `${ents.length.toLocaleString()} entities · ${where}` },
          { kind: 'item', label: `Show all ${ents.length.toLocaleString()} in Entities`, icon: Table2, onSelect: () => navigate(pickHref(ents.map((e) => e.id), where)) },
          { kind: 'item', label: 'Show in 2D graph', icon: Waypoints, onSelect: () => navigate(`/unigraph/2d?sel=${encodeURIComponent(ents.map((e) => e.id).join(','))}`) },
          ...relatedItems(store, ents.map((e) => e.id), openTab),
          { kind: 'sep' },
        )
        for (const e of ents.slice(0, 8)) items.push({ kind: 'item', label: displayLabel(e), onSelect: () => setInspected(e.id) })
        if (ents.length > 8) items.push({ kind: 'item', label: `… and ${(ents.length - 8).toLocaleString()} more`, disabled: true, onSelect: () => {} })
      }
      setPointMenu({ x: pick.clientX, y: pick.clientY, items })
    },
    [store, registry, navigate, openTab],
  )

  const newItems: MenuItem[] = [
    { kind: 'label', label: 'Templates' },
    ...PLOT_TEMPLATES.map<MenuItem>((t) => ({
      kind: 'item',
      label: t.label,
      onSelect: () => {
        setPlotId(undefined)
        setParams({ plot: 'new' }, { replace: true })
        change(t.spec)
      },
    })),
  ]
  const summary = plotId || dirty ? `${describePlot(spec)}${built.plot ? ` · ${built.plot.stats.rows.toLocaleString()} rows` : ''}` : 'new plot'

  return (
    <>
      <div className="pj__tools">
        {title}
        <SavedPicker type={PLOT_TYPE} noun="chart" icon={BarChart3} activeId={plotId} dirty={dirty} summary={summary} onLoad={load} onSave={save} onClear={unload} clearLabel="New" />
        <button className="btn btn--sm" onClick={(e) => setNewMenu(newMenu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
          <Plus size={13} /> Template
        </button>
        <span className="tb__sep" />
        <div className="plot__drag" role="radiogroup" aria-label="Drag does">
          <button className={`btn btn--sm btn--icon ${dragmode === 'pan' ? 'is-on' : ''}`} title="Drag moves the view (default). Scroll zooms; double-click fits." aria-pressed={dragmode === 'pan'} onClick={() => setDragmode('pan')}>
            <Hand size={13} />
          </button>
          <button className={`btn btn--sm btn--icon ${dragmode === 'zoom' ? 'is-on' : ''}`} title="Drag draws a box to zoom into" aria-pressed={dragmode === 'zoom'} onClick={() => setDragmode('zoom')}>
            <BoxSelect size={13} />
          </button>
        </div>
        <button className="btn btn--sm btn--icon" disabled={!built.plot} title="Zoom out (−)" onClick={() => zoom(1 / 1.5)}>
          <ZoomOut size={13} />
        </button>
        <button className="btn btn--sm btn--icon" disabled={!built.plot} title="Zoom in (+)" onClick={() => zoom(1.5)}>
          <ZoomIn size={13} />
        </button>
        <button className="btn btn--sm" disabled={!built.plot} title="Fit everything (0, or double-click the chart)" onClick={resetView}>
          <Maximize2 size={13} /> Fit
        </button>
        <span className="tb__sep" />
        <button className="btn btn--sm" disabled={!built.plot} title="Show every entity this chart draws in the Entities table" onClick={() => navigate(pickHref(allRowIds(), plotLabel))}>
          <Table2 size={13} /> Rows → Entities
        </button>
        <button className="btn btn--sm" disabled={!built.plot} title="Download the chart as a PNG" onClick={exportPng}>
          <Download size={13} /> PNG
        </button>
        <button className="btn btn--sm" disabled={!built.plot} title="Write this chart out as a script — the same picture in code, saved as a script entity and opened in a Scripts tab beside this one" onClick={exportScript}>
          <Code2 size={13} /> Script
        </button>
        <span className="spacer" />
        <span className="muted pj__hint">{built.error ? built.error : built.plot ? `${built.plot.stats.rows.toLocaleString()} rows · ${built.plot.stats.traces} traces` : ''}</span>
      </div>
      <div className="pj__body">
        <div className="plot__stage" tabIndex={0} onKeyDown={onStageKey}>
          {built.plot ? <PlotlyChart data={built.plot.data} layout={built.plot.layout} dragmode={dragmode} onReady={(el) => (chartEl.current = el)} onPick={onPick} /> : <div className="plot__empty">{built.error ?? 'Nothing to draw yet.'}</div>}
          {built.plot && <div className="plot__legend-hint">drag to move · scroll to zoom · double-click to fit · click a point for its entities</div>}
        </div>
        <div className="pane-gutter" onPointerDown={side.onPointerDown} onDoubleClick={side.reset} title="Drag to resize · double-click to reset" />
        <aside className="pj__side plot__side" style={{ width: side.width }}>
          {inspected && store.has(inspected) ? (
            <div className="plot__inspect">
              <button className="btn btn--sm btn--ghost" onClick={() => setInspected(null)}>
                <ArrowLeft size={13} /> Back to the chart
              </button>
              <Inspector entityId={inspected} onClose={() => setInspected(null)} onOpen={(id) => (store.has(id) ? setInspected(id) : navigate(`/entities?sel=${id}`))} onDelete={() => toast('Delete from the entity table')} />
            </div>
          ) : (
            <PlotPanel spec={spec} onChange={change} refs={refs} rows={rowSample} stats={built.plot?.stats} error={built.error} />
          )}
        </aside>
      </div>
      {pointMenu && <Menu x={pointMenu.x} y={pointMenu.y} items={pointMenu.items} onClose={() => setPointMenu(null)} />}
      {newMenu && <Menu x={newMenu.x} y={newMenu.y} anchor={newMenu.anchor} items={newItems} onClose={() => setNewMenu(null)} />}
    </>
  )
}
