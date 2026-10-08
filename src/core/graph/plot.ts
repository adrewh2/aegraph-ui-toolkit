import { BarChart3 } from 'lucide-react'
import { displayLabel } from '../entity/entity'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import { isRelationship, type AnyEntity, type Entity, type EntityData, type EntityId } from '../entity/types'
import type { DatasetData } from '../datasets/dataset'
import { datasetOf, datasetRowEntities, rowRef } from '../datasets/join'
import { palette, type PaletteId } from './palettes'
import type { Selector } from './selector'
import { describeValueRef, valueOf, type ValueContext, type ValueRef } from './values'

/**
 * Plots: a small declarative spec over the same values and selectors the
 * explorer uses, turned into Plotly traces. Rows are entities (or a
 * dataset's rows, read as entities: `core/datasets/join.ts`); every axis,
 * colour, size and grouping is a ValueRef, so "segments per month by
 * region" is a spec, not code. Pure: nothing here touches the DOM.
 */

export const PLOT_TYPE = 'plot'

export type TraceKind = 'scatter' | 'line' | 'area' | 'bar' | 'histogram' | 'box' | 'heatmap' | 'pie'
export type TimeUnit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
export type Agg = 'count' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'distinct'

export interface PlotTrace {
  kind?: TraceKind
  name?: string
  /** Rows for this trace; defaults to the plot's selector. */
  selector?: Selector
  x?: ValueRef
  y?: ValueRef
  /** One sub-trace per distinct value (the legend). */
  group?: ValueRef
  /** Continuous marker colour (scatter) with a palette. */
  color?: ValueRef
  palette?: PaletteId
  /** A fixed colour for the whole trace (a highlight), instead of the next palette colour. */
  fill?: string
  size?: ValueRef
  /** Hover text; defaults to the entity label. */
  text?: ValueRef
  /** Snap x into bins: a time unit for temporal values, a width for numbers. */
  bin?: TimeUnit | number
  /** Fold rows sharing an x (and group) into one point: count needs no y; the rest aggregate y. */
  agg?: Agg
  cumulative?: boolean
  mode?: 'markers' | 'lines' | 'lines+markers'
  opacity?: number
  /** Heatmap: bins on the y axis (x uses `bin`). */
  ybin?: TimeUnit | number
}

export interface PlotLayout {
  title?: string
  xaxis?: { title?: string; type?: 'linear' | 'log' | 'date' | 'category' }
  yaxis?: { title?: string; type?: 'linear' | 'log' | 'date' | 'category' }
  barmode?: 'stack' | 'group' | 'overlay'
  showlegend?: boolean
  height?: number
}

export interface PlotSpec {
  selector?: Selector
  /**
   * A dataset's rows instead of entities: one point or bar per row, and a trace's refs name its columns — bare
   * (`count`, or the column's label) or as `data.<column>` — with `label`, `type` and `id` read from columns of
   * those names. A trace with a selector of its own still plots entities.
   */
  dataset?: EntityId
  traces: PlotTrace[]
  layout?: PlotLayout
}

export interface PlotData extends EntityData {
  spec: PlotSpec
  /** Counts from the last build, for the picker. */
  summary?: { rows: number; traces: number }
  /** A small picture of the chart as it was saved (an SVG data: URL drawn by `thumbnail.ts`) for the Charts page's card. */
  preview?: string
}
export type PlotEntity = Entity<PlotData>
export const isPlot = (e: AnyEntity | undefined): e is PlotEntity => !!e && !isRelationship(e) && e.type === PLOT_TYPE && !!(e.data as PlotData).spec

export const plotType: EntityTypeDef = defineEntityType({
  type: PLOT_TYPE,
  label: 'Chart',
  pluralLabel: 'Charts',
  category: 'project',
  icon: BarChart3,
  color: '#0891b2',
  description: 'A chart over entities: axes, colours and groups are value references, rows come from a selector. Built and shown in a Charts tab of Analytics.',
  fields: [
    { key: 'data.spec.traces', label: 'Traces', kind: 'json', width: 80, format: (v) => (Array.isArray(v) ? String(v.length) : '') },
    { key: 'data.summary.rows', label: 'Rows', kind: 'number', width: 80 },
  ],
})

// ── Values ────────────────────────────────────────────────────────────

/** Temporal refs read as epoch ms; ISO strings and second-precision stamps are coerced. */
/** Category tick labels longer than this are shortened with an ellipsis on the axis. */
const TICK_MAX = 18
const shortTick = (s: string) => (s.length > TICK_MAX ? s.slice(0, TICK_MAX - 1).trimEnd() + '…' : s)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/

export function temporalMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v > 1e8 ? v * 1000 : undefined
  if (typeof v === 'string' && /^\d{4}-\d{2}/.test(v)) {
    const t = Date.parse(v.length === 7 ? `${v}-01` : v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

const TIME_UNITS = new Set<string>(['hour', 'day', 'week', 'month', 'quarter', 'year'])
export const isTimeUnit = (b: unknown): b is TimeUnit => typeof b === 'string' && TIME_UNITS.has(b)

/** Floor a timestamp to the start of its unit (UTC). */
export function floorTime(ms: number, unit: TimeUnit): number {
  const d = new Date(ms)
  switch (unit) {
    case 'hour':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    case 'week': {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
      return day - dow * 86400000
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1)
  }
}

type Scalar = number | string
/** A value on an axis: temporal → ms (tagged), numeric → number, else the string. */
function axisValue(node: AnyEntity, ref: ValueRef, ctx: ValueContext): { v: Scalar | undefined; temporal: boolean } {
  const raw = valueOf(node, ref, ctx)
  if (raw === undefined || raw === null || raw === '') return { v: undefined, temporal: false }
  // Temporal by name (createdAt, deployedAt, start_ts, …) or by shape (an ISO date string).
  const p = /^meta\./.test(ref) || /(created|updated|ended|_ts|timestamp|date|time|At$|_at$)/i.test(ref) || (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw))
  if (p) {
    const t = temporalMs(raw)
    if (t !== undefined) return { v: t, temporal: true }
  }
  if (typeof raw === 'number') return { v: raw, temporal: false }
  const n = Number(raw)
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(n)) return { v: n, temporal: false }
  return { v: String(raw), temporal: false }
}

/** Snap a value into its bin; undefined when a numeric width is asked of something that is not a number (it has no bin). */
function binValue(v: Scalar, temporal: boolean, bin: TimeUnit | number | undefined): Scalar | undefined {
  if (bin === undefined) return v
  if (isTimeUnit(bin)) return temporal && typeof v === 'number' ? floorTime(v, bin) : v
  if (typeof v !== 'number') return undefined
  return bin > 0 ? Math.floor(v / bin) * bin : v
}

function aggregate(values: number[], agg: Agg): number {
  if (agg === 'count') return values.length
  if (!values.length) return NaN
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'median': {
      const s = [...values].sort((a, b) => a - b)
      const m = s.length >> 1
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    case 'min':
      return values.reduce((a, b) => (b < a ? b : a), Infinity)
    case 'max':
      return values.reduce((a, b) => (b > a ? b : a), -Infinity)
    case 'distinct':
      return new Set(values).size
  }
}

const sortScalars = (a: Scalar, b: Scalar) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
const cellKey = (x: Scalar, y: Scalar) => `${typeof x}:${x}|${typeof y}:${y}`

// ── Build ─────────────────────────────────────────────────────────────

/** A Plotly trace object (untyped on purpose: Plotly's own typings are heavier than the feature). */
export type PlotlyTrace = Record<string, unknown>

export interface BuiltPlot {
  data: PlotlyTrace[]
  layout: Record<string, unknown>
  stats: { rows: number; traces: number; missing: number }
}

export interface PlotBuildContext {
  resolve: (sel: Selector) => AnyEntity[]
  values: ValueContext
}

const CATEGORICAL_LIMIT = 24

export function buildPlot(spec: PlotSpec, ctx: PlotBuildContext): BuiltPlot {
  const data: PlotlyTrace[] = []
  let rows = 0
  let missing = 0
  let anyTemporalX = false
  let anyTemporalY = false
  const table = spec.dataset ? (ctx.values.store ? datasetOf(ctx.values.store, spec.dataset) : undefined) : undefined
  if (spec.dataset && !table) throw new Error(`No dataset with id ${spec.dataset}.`)
  const defaultRows = table ? datasetRowEntities(table) : spec.selector ? ctx.resolve(spec.selector) : undefined
  let colorIndex = 0

  for (const specTrace of spec.traces) {
    const t = table ? traceOverDataset(specTrace, table.data) : specTrace
    const kind = t.kind ?? 'scatter'
    const nodes = t.selector ? ctx.resolve(t.selector) : (defaultRows ?? ctx.resolve({ scope: 'dataset' }))
    const label = (n: AnyEntity) => (t.text ? String(valueOf(n, t.text, ctx.values) ?? '') : displayLabel(n))

    if (kind === 'pie') {
      const slices = new Map<string, EntityId[]>()
      for (const n of nodes) {
        const v = t.x ? valueOf(n, t.x, ctx.values) : n.type
        if (v === undefined) {
          missing++
          continue
        }
        const k = String(v)
        const list = slices.get(k)
        if (list) list.push(n.id)
        else slices.set(k, [n.id])
      }
      rows += nodes.length
      const entries = [...slices.entries()].sort((a, b) => b[1].length - a[1].length)
      data.push({ type: 'pie', name: t.name ?? (t.x ? describeValueRef(t.x) : 'type'), labels: entries.map((e) => e[0]), values: entries.map((e) => e[1].length), customdata: entries.map((e) => e[1]), hole: 0.4, opacity: t.opacity })
      continue
    }

    if (kind === 'heatmap') {
      if (!t.x || !t.y) throw new Error('A heatmap needs x and y.')
      const cells = new Map<string, EntityId[]>()
      const xs = new Map<Scalar, true>()
      const ys = new Map<Scalar, true>()
      let temporalX = false
      let temporalY = false
      for (const n of nodes) {
        const ax = axisValue(n, t.x, ctx.values)
        const ay = axisValue(n, t.y, ctx.values)
        if (ax.v === undefined || ay.v === undefined) {
          missing++
          continue
        }
        temporalX ||= ax.temporal
        temporalY ||= ay.temporal
        const bx = binValue(ax.v, ax.temporal, t.bin)
        const by = binValue(ay.v, ay.temporal, t.ybin)
        if (bx === undefined || by === undefined) {
          missing++
          continue
        }
        xs.set(bx, true)
        ys.set(by, true)
        const k = cellKey(bx, by)
        const list = cells.get(k)
        if (list) list.push(n.id)
        else cells.set(k, [n.id])
      }
      rows += nodes.length
      const xk = [...xs.keys()].sort(sortScalars)
      const yk = [...ys.keys()].sort(sortScalars)
      const z = yk.map((y) => xk.map((x) => cells.get(cellKey(x, y))?.length ?? 0))
      const customdata = yk.map((y) => xk.map((x) => cells.get(cellKey(x, y)) ?? []))
      anyTemporalX ||= temporalX
      anyTemporalY ||= temporalY
      data.push({ type: 'heatmap', name: t.name, x: xk.map((v) => (temporalX ? new Date(v as number).toISOString() : v)), y: yk.map((v) => (temporalY ? new Date(v as number).toISOString() : v)), z, customdata, colorscale: plotlyScale(t.palette ?? 'viridis'), hovertemplate: '%{x} · %{y}: %{z}<extra></extra>' })
      continue
    }

    if (kind === 'histogram') {
      if (!t.x) throw new Error('A histogram needs x.')
      const groups = splitByGroup(nodes, t, ctx.values)
      for (const [g, list] of groups) {
        const xs: Scalar[] = []
        const ids: EntityId[] = []
        let temporal = false
        for (const n of list) {
          const ax = axisValue(n, t.x, ctx.values)
          if (ax.v === undefined) {
            missing++
            continue
          }
          temporal ||= ax.temporal
          xs.push(ax.v)
          ids.push(n.id)
        }
        rows += list.length
        anyTemporalX ||= temporal
        data.push({ type: 'histogram', name: traceName(t, g, groups.size), x: temporal ? xs.map((v) => new Date(v as number).toISOString()) : xs, customdata: ids.map((id) => [id]), opacity: t.opacity ?? (groups.size > 1 ? 0.7 : 1), marker: { color: t.fill ?? categoryColor(colorIndex++) } })
      }
      continue
    }

    if (kind === 'box') {
      if (!t.y) throw new Error('A box plot needs y.')
      const groups = splitByGroup(nodes, t, ctx.values)
      for (const [g, list] of groups) {
        const ys: number[] = []
        const xs: Scalar[] = []
        const ids: EntityId[] = []
        for (const n of list) {
          const ay = axisValue(n, t.y, ctx.values)
          if (typeof ay.v !== 'number') {
            missing++
            continue
          }
          ys.push(ay.v)
          ids.push(n.id)
          if (t.x) xs.push(axisValue(n, t.x, ctx.values).v ?? '')
        }
        rows += list.length
        data.push({ type: 'box', name: traceName(t, g, groups.size), y: ys, ...(t.x ? { x: xs } : {}), customdata: ids.map((id) => [id]), marker: { color: t.fill ?? categoryColor(colorIndex++) }, boxpoints: ys.length <= 500 ? 'outliers' : false })
      }
      continue
    }

    // scatter / line / area / bar
    if (!t.x) throw new Error(`A ${kind} trace needs x.`)
    const agg: Agg | undefined = t.agg ?? (t.y ? undefined : 'count')
    if (!agg && !t.y) throw new Error(`A ${kind} trace needs y, or an agg (count) to fold rows by x.`)
    const groups = splitByGroup(nodes, t, ctx.values)
    for (const [g, list] of groups) {
      let temporalX = false
      let temporalY = false
      const xs: Scalar[] = []
      const ys: Scalar[] = []
      const texts: string[] = []
      const colors: number[] = []
      const sizes: number[] = []
      const members: EntityId[][] = []
      if (agg) {
        const buckets = new Map<Scalar, number[]>()
        const bucketIds = new Map<Scalar, EntityId[]>()
        for (const n of list) {
          const ax = axisValue(n, t.x, ctx.values)
          if (ax.v === undefined) {
            missing++
            continue
          }
          const bx = binValue(ax.v, ax.temporal, t.bin)
          if (bx === undefined) {
            missing++
            continue
          }
          temporalX ||= ax.temporal
          let yv = 0
          if (agg !== 'count') {
            const ay = t.y ? axisValue(n, t.y, ctx.values) : { v: undefined }
            if (typeof ay.v !== 'number') {
              missing++
              continue
            }
            yv = ay.v
          }
          const b = buckets.get(bx)
          if (b) {
            b.push(yv)
            bucketIds.get(bx)!.push(n.id)
          } else {
            buckets.set(bx, [yv])
            bucketIds.set(bx, [n.id])
          }
        }
        const keys = [...buckets.keys()].sort(sortScalars)
        let running = 0
        for (const k of keys) {
          const v = aggregate(buckets.get(k)!, agg)
          running += v
          xs.push(k)
          ys.push(t.cumulative ? running : v)
          texts.push(`${buckets.get(k)!.length} rows`)
          members.push(bucketIds.get(k)!)
        }
      } else {
        for (const n of list) {
          const ax = axisValue(n, t.x, ctx.values)
          const ay = axisValue(n, t.y!, ctx.values)
          if (ax.v === undefined || ay.v === undefined) {
            missing++
            continue
          }
          const bx = binValue(ax.v, ax.temporal, t.bin)
          if (bx === undefined) {
            missing++
            continue
          }
          temporalX ||= ax.temporal
          temporalY ||= ay.temporal
          xs.push(bx)
          ys.push(ay.v)
          texts.push(label(n))
          members.push([n.id])
          if (t.color) {
            const c = axisValue(n, t.color, ctx.values).v
            colors.push(typeof c === 'number' ? c : NaN)
          }
          if (t.size) {
            const s = axisValue(n, t.size, ctx.values).v
            sizes.push(typeof s === 'number' ? s : NaN)
          }
        }
      }
      rows += list.length
      anyTemporalX ||= temporalX
      anyTemporalY ||= temporalY
      const toAxis = (vals: Scalar[], temporal: boolean) => (temporal ? vals.map((v) => new Date(v as number).toISOString()) : vals)
      const base: PlotlyTrace = { name: traceName(t, g, groups.size), x: toAxis(xs, temporalX), y: toAxis(ys, temporalY), text: texts, customdata: members, hovertemplate: '%{text}<br>%{x} · %{y}<extra>%{fullData.name}</extra>', opacity: t.opacity }
      const color = t.fill ?? categoryColor(colorIndex++)
      if (kind === 'bar') data.push({ ...base, type: 'bar', marker: { color } })
      else {
        const mode = t.mode ?? (kind === 'scatter' ? 'markers' : 'lines')
        const marker: Record<string, unknown> = { color }
        if (!agg && t.color && colors.some((c) => !Number.isNaN(c))) Object.assign(marker, { color: colors, colorscale: plotlyScale(t.palette ?? 'viridis'), showscale: true, colorbar: { title: { text: describeValueRef(t.color) }, thickness: 12 } })
        if (!agg && t.size && sizes.some((s) => !Number.isNaN(s))) Object.assign(marker, { size: scaleSizes(sizes), sizemode: 'diameter' })
        data.push({ ...base, type: 'scatter', mode, marker, line: { color, width: 2 }, ...(kind === 'area' ? { fill: 'tozeroy' } : {}) })
      }
    }
  }

  const first = spec.traces[0]
  // Category labels (a category axis only: a date axis also carries strings — ISO stamps — but its ticks are Plotly's
  // to place and format): long ones are shortened on the ticks (the hover keeps the full name), turned at a fixed
  // angle, and the margins are sized for them here — not Plotly's automargin, which re-measures on every zoom step
  // and makes the plot area jump about while the wheel turns.
  const xType = spec.layout?.xaxis?.type ?? (anyTemporalX ? 'date' : undefined)
  const yType = spec.layout?.yaxis?.type ?? (anyTemporalY ? 'date' : undefined)
  const categoriesOf = (axis: 'x' | 'y', type: string | undefined) => (type === 'date' || type === 'linear' || type === 'log' ? [] : [...new Set(data.flatMap((d) => (Array.isArray(d[axis]) ? (d[axis] as unknown[]) : [])).filter((v): v is string => typeof v === 'string' && !ISO_DATE.test(v)))])
  const xCategories = categoriesOf('x', xType)
  const yCategories = categoriesOf('y', yType)
  const xLongest = Math.max(0, ...xCategories.map((c) => shortTick(c).length))
  const yLongest = Math.max(0, ...yCategories.map((c) => shortTick(c).length))
  const xTicks = xCategories.some((c) => c.length > TICK_MAX) ? { tickvals: xCategories, ticktext: xCategories.map(shortTick) } : {}
  const yTicks = yCategories.some((c) => c.length > TICK_MAX) ? { tickvals: yCategories, ticktext: yCategories.map(shortTick) } : {}
  // Labels longer than fit upright are turned 45°; the bottom margin then holds their projected height (≈7 px per character).
  const xTurned = xCategories.length > 0 && xLongest > 6
  const marginB = 48 + (xTurned ? Math.round(xLongest * 7 * 0.71) : 0)
  const marginL = Math.max(56, yCategories.length ? 24 + yLongest * 7 : 0)
  const layout: Record<string, unknown> = {
    title: spec.layout?.title ? { text: spec.layout.title } : undefined,
    barmode: spec.layout?.barmode ?? (data.filter((d) => d.type === 'bar').length > 1 ? 'stack' : undefined),
    showlegend: spec.layout?.showlegend ?? data.length > 1,
    xaxis: { title: { text: spec.layout?.xaxis?.title ?? (first?.x ? describeValueRef(first.x) : undefined) }, type: xType, ...(xTurned ? { tickangle: -45 } : {}), ...xTicks },
    yaxis: { title: { text: spec.layout?.yaxis?.title ?? yTitle(first) }, type: yType, ...yTicks },
    height: spec.layout?.height,
    margin: { l: marginL, r: 24, t: spec.layout?.title ? 48 : 24, b: marginB },
    hovermode: 'closest',
  }
  return { data, layout, stats: { rows, traces: data.length, missing } }
}

function yTitle(t?: PlotTrace): string | undefined {
  if (!t) return undefined
  const agg = t.agg ?? (t.y ? undefined : 'count')
  if (!agg) return t.y ? describeValueRef(t.y) : undefined
  if (agg === 'count') return t.cumulative ? 'cumulative count' : 'count'
  return `${agg} of ${t.y ? describeValueRef(t.y) : ''}${t.cumulative ? ' (cumulative)' : ''}`
}

function splitByGroup(nodes: AnyEntity[], t: PlotTrace, values: ValueContext): Map<string | undefined, AnyEntity[]> {
  if (!t.group) return new Map([[undefined, nodes]])
  const groups = new Map<string | undefined, AnyEntity[]>()
  for (const n of nodes) {
    const v = valueOf(n, t.group, values)
    const key = v === undefined ? '(none)' : String(v)
    const list = groups.get(key)
    if (list) list.push(n)
    else groups.set(key, [n])
  }
  if (groups.size <= CATEGORICAL_LIMIT) return new Map([...groups.entries()].sort((a, b) => b[1].length - a[1].length))
  // Keep the largest categories; fold the rest.
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  const keep = new Map(sorted.slice(0, CATEGORICAL_LIMIT - 1))
  keep.set('other', sorted.slice(CATEGORICAL_LIMIT - 1).flatMap((e) => e[1]))
  return keep
}

const traceName = (t: PlotTrace, group: string | undefined, groups: number) => (group !== undefined ? (t.name ? `${t.name} · ${group}` : group) : (t.name ?? (groups > 1 ? group : t.y ? describeValueRef(t.y) : 'count')))

const CATEGORY_COLORS = ['#0f766e', '#2563eb', '#ea580c', '#9333ea', '#e11d48', '#ca8a04', '#0891b2', '#65a30d', '#7c3aed', '#db2777', '#475569', '#b45309']
const categoryColor = (i: number) => CATEGORY_COLORS[i % CATEGORY_COLORS.length]

export function plotlyScale(id: PaletteId): [number, string][] {
  const stops = palette(id).stops
  return stops.map((c, i) => [i / (stops.length - 1), c])
}

function scaleSizes(values: number[]): number[] {
  // Reductions, not Math.min(...finite): a hundred thousand rows would overflow the call stack as arguments.
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return values.map((v) => (Number.isFinite(v) && hi > lo ? 6 + 18 * ((v - lo) / (hi - lo)) : 8))
}

/** A trace over a dataset's rows: a column named bare (`count`, or its label) becomes `data.<key>`. A trace with its own selector plots entities and is left alone. */
export function traceOverDataset(t: PlotTrace, data: DatasetData): PlotTrace {
  if (t.selector) return t
  const out: PlotTrace = { ...t }
  for (const k of ['x', 'y', 'group', 'color', 'size', 'text'] as const) if (t[k] !== undefined) out[k] = rowRef(data, t[k])
  return out
}

/** A spec over a dataset with its refs written out in full (what a saved chart keeps, so the pickers know them). */
export const specOverDataset = (spec: PlotSpec, data: DatasetData): PlotSpec => ({ ...spec, traces: spec.traces.map((t) => traceOverDataset(t, data)) })

/** One line for pickers and tool results. */
export function describePlot(spec: PlotSpec): string {
  return spec.traces
    .map((t) => {
      const kind = t.kind ?? 'scatter'
      const agg = t.agg ?? (t.y ? undefined : 'count')
      const y = agg ? `${agg}${t.y ? ` of ${describeValueRef(t.y)}` : ''}` : t.y ? describeValueRef(t.y) : ''
      const x = t.x ? describeValueRef(t.x) : ''
      return `${kind} · ${y || x}${y && x ? ` by ${x}` : ''}${t.bin ? ` per ${t.bin}` : ''}${t.group ? ` · grouped by ${describeValueRef(t.group)}` : ''}`
    })
    .join(' + ')
}

export const plotIdFor = (label: string): EntityId => `plot-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
