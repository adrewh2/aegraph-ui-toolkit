import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { openMade } from './toolkit'
import { datasetOf } from '../../core/datasets/join'
import { createEntity, displayLabel, quoteLabel } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { buildPlot, describePlot, isPlot, PLOT_TYPE, specOverDataset, type PlotData, type PlotSpec, type PlotTrace } from '../../core/graph/plot'
import { plotPreview } from '../../core/graph/thumbnail'
import { plotContextFor } from '../plots/plotContext'
import { getPlotHandle, waitForPlot } from '../plots/plotHandle'
import { SELECTOR_SCHEMA, VALUE_REF_HELP, selectorFrom } from './schemas'
import type { AppHost } from './tools'

const json = (v: unknown) => JSON.stringify(v)

const TRACE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['scatter', 'line', 'area', 'bar', 'histogram', 'box', 'heatmap', 'pie'] },
    name: { type: 'string' },
    selector: { ...SELECTOR_SCHEMA, description: 'Rows for this trace only (default: the chart’s selector)' },
    x: { type: 'string', description: 'ValueRef for x (pie: the category). Temporal refs (meta.*, data.created…) plot as dates.' },
    y: { type: 'string', description: 'ValueRef for y; with agg it is the value aggregated (count needs none)' },
    group: { type: 'string', description: 'ValueRef: one trace per distinct value (legend / colour)' },
    color: { type: 'string', description: 'Numeric ValueRef for a continuous marker colour (scatter/line without agg)' },
    palette: { type: 'string' },
    fill: { type: 'string', description: 'A fixed colour (hex) for the whole trace — a highlight — instead of the next palette colour' },
    size: { type: 'string', description: 'Numeric ValueRef for marker size' },
    text: { type: 'string', description: 'ValueRef for hover text (default: the label)' },
    bin: { description: 'Snap x: "hour"|"day"|"week"|"month"|"quarter"|"year" for temporal refs, or a number (width) for numeric ones', anyOf: [{ type: 'string', enum: ['hour', 'day', 'week', 'month', 'quarter', 'year'] }, { type: 'number' }] },
    ybin: { description: 'Heatmap: bins on y (same forms as bin)', anyOf: [{ type: 'string', enum: ['hour', 'day', 'week', 'month', 'quarter', 'year'] }, { type: 'number' }] },
    agg: { type: 'string', enum: ['count', 'sum', 'mean', 'median', 'min', 'max', 'distinct'], description: 'Fold rows sharing an x (and group) into one point. Default: count when y is absent, none when y is given.' },
    cumulative: { type: 'boolean' },
    mode: { type: 'string', enum: ['markers', 'lines', 'lines+markers'] },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const

const AXIS_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, type: { type: 'string', enum: ['linear', 'log', 'date', 'category'] } }, additionalProperties: false } as const

const SPEC_SCHEMA = {
  type: 'object',
  description: `A chart: rows from a selector (every entity when absent) or a dataset's rows (\`dataset\`), one or more traces over ValueRefs, and layout. ${VALUE_REF_HELP} Examples — activity per month: {traces:[{kind:"bar", x:"meta.createdAt", bin:"month"}]}; per month by region: {traces:[{kind:"line", x:"meta.createdAt", bin:"month", group:"data.region"}]}; length vs messages: {traces:[{kind:"scatter", x:"data.n_messages", y:"data.chars", color:"data.salience"}]}.`,
  properties: {
    selector: SELECTOR_SCHEMA,
    dataset: { type: 'string', description: 'A dataset id (dataset {action:"list"}): chart its rows instead of entities — one point or bar per row, and x, y, group, color, size and text name its columns, bare ("count") or as data.<column>. A table of counts per type is {dataset:"<id>", traces:[{kind:"bar", x:"type", y:"count"}]}.' },
    traces: { type: 'array', items: TRACE_SCHEMA, minItems: 1 },
    layout: {
      type: 'object',
      properties: { title: { type: 'string' }, xaxis: AXIS_SCHEMA, yaxis: AXIS_SCHEMA, barmode: { type: 'string', enum: ['stack', 'group', 'overlay'] }, showlegend: { type: 'boolean' }, height: { type: 'number' } },
      additionalProperties: false,
    },
  },
  required: ['traces'],
  additionalProperties: false,
} as const

type SpecInput = {
  selector?: Parameters<typeof selectorFrom>[0]
  dataset?: string
  traces: readonly (Omit<PlotTrace, 'selector' | 'bin' | 'ybin' | 'palette' | 'fill'> & { selector?: Parameters<typeof selectorFrom>[0]; bin?: unknown; ybin?: unknown; palette?: string; fill?: string })[]
  layout?: PlotSpec['layout']
}

const specFrom = (s: SpecInput): PlotSpec => ({
  selector: s.selector ? selectorFrom(s.selector) : undefined,
  ...(s.dataset ? { dataset: s.dataset } : {}),
  traces: s.traces.map((t) => ({ ...t, selector: t.selector ? selectorFrom(t.selector) : undefined, bin: t.bin as PlotTrace['bin'], ybin: t.ybin as PlotTrace['ybin'], palette: t.palette as PlotTrace['palette'] })),
  layout: s.layout,
})

/** Plots: build, save, open and read charts over entities, on the Scenes page or headless. */
export function createPlotTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  /** Trace arrays trimmed for a tool result: up to `n` points per trace, plus the count. */
  const preview = (spec: PlotSpec, n: number) => {
    const built = buildPlot(spec, plotContextFor(store, registry()))
    const traces = built.data.map((t) => {
      const x = t.x as unknown[] | undefined
      const y = t.y as unknown[] | undefined
      const z = t.z as unknown[] | undefined
      const labels = t.labels as unknown[] | undefined
      const values = t.values as unknown[] | undefined
      return {
        name: t.name,
        type: t.type,
        points: (x ?? labels ?? []).length,
        ...(x ? { x: x.slice(0, n) } : {}),
        ...(y ? { y: y.slice(0, n) } : {}),
        ...(z ? { z: z.slice(0, n) } : {}),
        ...(labels ? { labels: labels.slice(0, n), values: values?.slice(0, n) } : {}),
      }
    })
    return { stats: built.stats, traces, layout: { title: (built.layout.title as { text?: string } | undefined)?.text, xaxis: built.layout.xaxis, yaxis: built.layout.yaxis } }
  }

  const plot = betaTool({
    name: 'plot',
    description:
      'Charts over entities (Plotly, built in a Charts tab of Analytics). Rows come from a selector over the whole dataset; every axis, colour, size and group is a ValueRef; traces fold rows with bin (time unit) + agg (count/sum/mean…). Actions: preview (compute without saving: stats + the first points of every trace — use it to check a spec), show (draw it in a Charts tab; optionally save), save (create or update a chart entity; a new one opens unless `open: false`), open (a saved chart), list, get, delete, reset_view (undo zoom/pan). In the chart: scroll to zoom, drag to pan/zoom, double-click to reset. Activity trends: bar/line with x a timestamp ref, bin "month" (or week/day), agg count, optionally group by a category.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preview', 'show', 'save', 'open', 'list', 'get', 'delete', 'reset_view'], description: 'reset_view: undo zoom/pan on the chart that is open' },
        spec: SPEC_SCHEMA,
        id: { type: 'string', description: 'Chart (plot) entity id (open, get, delete, or save to update)' },
        name: { type: 'string', description: 'Name for save / show' },
        points: { type: 'integer', minimum: 1, maximum: 500, description: 'preview: points per trace to return (default 24)' },
        open: { type: 'boolean', description: 'save: show a new chart in a Charts tab afterwards (default true); false to save it without leaving the page' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, spec, id, name, points, open }) => {
      if (action === 'list') return json({ plots: store.ofType(PLOT_TYPE).map((e) => ({ id: e.id, label: displayLabel(e), summary: describePlot((e.data as PlotData).spec), rows: (e.data as PlotData).summary?.rows, updatedAt: e.meta.updatedAt })) })
      if (action === 'get') {
        const e = store.get(id ?? '')
        if (!isPlot(e)) throw new Error(`No plot with id ${id}. Use plot {action:"list"}.`)
        return json({ id: e.id, label: displayLabel(e), spec: e.data.spec, ...preview(e.data.spec, points ?? 12) })
      }
      if (action === 'delete') {
        const e = store.get(id ?? '')
        if (!isPlot(e)) throw new Error(`No plot with id ${id}.`)
        if (!(await host.confirm(`Delete the plot ${quoteLabel(displayLabel(e))}?`, { yes: 'Delete', danger: true }))) return json({ deleted: false })
        store.remove([e.id])
        return json({ deleted: true, id: e.id })
      }
      if (action === 'reset_view') {
        const h = getPlotHandle()
        if (!h) throw new Error('No plot is open. Use plot {action:"open"} first.')
        await h.resetView()
        return json({ reset: true })
      }
      if (action === 'open') {
        const e = store.get(id ?? '')
        if (!isPlot(e)) throw new Error(`No plot with id ${id}. Use plot {action:"list"}.`)
        host.navigate(`/scenes?plot=${encodeURIComponent(e.id)}`)
        return json({ opened: e.id, label: displayLabel(e), summary: describePlot(e.data.spec) })
      }
      if (!spec) throw new Error(`${action} needs a spec.`)
      const given = specFrom(spec as SpecInput)
      // Over a dataset, the columns are kept as full refs (`data.count`), which the Charts tab's pickers know.
      const table = given.dataset ? datasetOf(store, given.dataset) : undefined
      if (given.dataset && !table) throw new Error(`No dataset with id ${given.dataset}. Use dataset {action:"list"}.`)
      const s = table ? specOverDataset(given, table.data) : given
      if (action === 'preview') return json({ summary: describePlot(s), ...preview(s, points ?? 24) })
      if (action === 'save') {
        const built = buildPlot(s, plotContextFor(store, registry()))
        const data: PlotData = { spec: s, summary: { rows: built.stats.rows, traces: built.stats.traces }, preview: plotPreview(built) }
        const existing = id ? store.get(id) : undefined
        if (id && !isPlot(existing)) throw new Error(`No plot with id ${id}.`)
        const label = name ?? (existing ? displayLabel(existing) : (s.layout?.title ?? describePlot(s)))
        if (existing) store.update(existing.id, { label, data })
        const e = existing ?? createEntity<PlotData>({ type: PLOT_TYPE, label, data, tags: [], meta: { source: 'assistant' } })
        if (!existing) store.upsert(e)
        const h = getPlotHandle()
        if (h && (h.getState().plotId === e.id || !h.getState().plotId)) h.load(e.id)
        else if (!existing && open !== false) openMade(host, e.id, `/scenes?plot=${encodeURIComponent(e.id)}`)
        return json({ id: e.id, label, updated: !!existing, summary: describePlot(s), stats: built.stats })
      }
      // show: draw on the Scenes page (saving first when a name is given, so the URL is stable).
      let plotId: string | undefined
      if (name) {
        const built = buildPlot(s, plotContextFor(store, registry()))
        const e = createEntity<PlotData>({ type: PLOT_TYPE, label: name, data: { spec: s, summary: { rows: built.stats.rows, traces: built.stats.traces }, preview: plotPreview(built) }, tags: [], meta: { source: 'assistant' } })
        store.upsert(e)
        plotId = e.id
      }
      host.navigate(plotId ? `/scenes?plot=${encodeURIComponent(plotId)}` : '/scenes?plot=new')
      const h = await waitForPlot()
      if (!h) throw new Error('The Scenes page did not open its plot mode. Navigate to /scenes?plot=new and try again.')
      if (!plotId) h.setSpec(s)
      const built = preview(s, 6)
      return json({ shown: true, id: plotId, summary: describePlot(s), stats: built.stats, hint: plotId ? undefined : 'Pass a name to save it as a plot entity, or plot {action:"save"}.' })
    },
  })

  return [plot]
}
