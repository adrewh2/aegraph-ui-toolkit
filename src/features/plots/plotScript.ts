import { describeValueRef, parseValueRef, type ValueRef } from '../../core/graph/values'
import type { Selector } from '../../core/graph/selector'
import { plotlyScale, type PlotSpec, type PlotTrace } from '../../core/graph/plot'
import type { PaletteId } from '../../core/graph/palettes'

/**
 * A plot spec as a script: the same picture, written in the scripts
 * sandbox's vocabulary (`ds`, `bin`, `groupBy`, `figure`…) so it can be
 * read, edited and run there — and drift from the spec on purpose.
 * Faithful for what the plot tool can express; the sandbox has no
 * selection or view scope, so a selector over "the current view" becomes
 * the whole dataset with a note.
 */

const q = (s: string) => JSON.stringify(s)
/** Text bound for a `//` comment: a line break in a title or field name must not end the comment early. */
const c = (s: string) => s.replace(/\r?\n|\u2028|\u2029/g, ' ')

/** `data.foo` → `e.data.foo` — the expression that reads a value ref off an entity `e`. */
export function refExpr(ref: ValueRef): string {
  const p = parseValueRef(ref)
  if (!p) return `e.data[${q(ref)}]`
  switch (p.kind) {
    case 'data':
      return /^[a-zA-Z_$][\w$]*$/.test(p.key) ? `e.data.${p.key}` : `e.data[${q(p.key)}]`
    case 'meta':
      return `e.${p.key}` // the snapshot flattens meta: e.createdAt, e.updatedAt
    case 'label':
      return `(e.label ?? e.id)`
    case 'type':
      return 'e.type'
    case 'id':
      return 'e.id'
    case 'tags':
      return `e.tags.join(', ')`
    case 'metric':
      return `ds.metric(${q(p.id)}, e.id)`
    case 'degree':
      return p.dir === 'both' ? `ds.degree(e.id${p.relType ? `, ${q(p.relType)}` : ''})` : `ds.${p.dir}(e.id${p.relType ? `, ${q(p.relType)}` : ''}).length`
    case 'selected':
    case 'pinned':
      return 'false /* no selection in a script */'
    case 'dataset':
      return `undefined /* ${c(ref)}: a dataset's column is not in the script snapshot */`
  }
}

/** The rows a selector picks, as the expression that builds them. */
export function selectorExpr(sel: Selector | undefined): { expr: string; notes: string[] } {
  const notes: string[] = []
  if (!sel) return { expr: 'ds.entities', notes }
  const steps: string[] = []
  if (sel.ids?.length) steps.push(`ds.entities.filter((e) => ${JSON.stringify(sel.ids)}.includes(e.id))`)
  else if (sel.types?.length) steps.push(`ds.byType(${sel.types.map(q).join(', ')})`)
  else steps.push('ds.entities')
  if (sel.tags?.length) steps.push(`.filter((e) => ${JSON.stringify(sel.tags)}.${sel.tagMode === 'all' ? 'every' : 'some'}((t) => e.tags.includes(t)))`)
  if (sel.text?.trim()) steps.push(`.filter((e) => JSON.stringify([e.label, e.description, e.id, e.data]).toLowerCase().includes(${q(sel.text.trim().toLowerCase())}))`)
  if (sel.fields?.length) notes.push('The field predicates of the chart are not carried over; add a .filter() for them.')
  if (sel.selection) notes.push('The chart drew the explorer selection; a script has no selection, so this takes every entity the other filters allow.')
  if (sel.roots?.length) notes.push('The chart walked out from root entities; add ds.neighbors() steps for that.')
  if (sel.scope !== 'dataset' && !sel.ids?.length) notes.push('The chart followed the graph view’s filter; a script sees the whole dataset.')
  return { expr: steps.join('\n  '), notes }
}

const nameOf = (t: PlotTrace, groups: boolean) => (t.name ? q(t.name) : groups ? 'name' : q(t.y ? describeValueRef(t.y) : 'count'))
const helper: Record<string, string> = { scatter: 'scatter', line: 'line', area: 'area', bar: 'bar' }
const scaleLiteral = (id: PaletteId | undefined) => JSON.stringify(plotlyScale(id ?? 'viridis'))

/**
 * The script. It leans on the prelude's plot conventions (axisValue, binAxis, seriesOf, plotColor, markerSizes,
 * aggregate — the plot tool's own reading of values, bins, series and colours) so the picture is the same one.
 */
export function plotToScript(spec: PlotSpec, opts: { label?: string; date?: Date } = {}): string {
  const out: string[] = []
  const title = spec.layout?.title ?? opts.label ?? 'Chart'
  out.push(`// ${c(title)}`, `// Exported from Charts${opts.date ? ` on ${opts.date.toISOString().slice(0, 10)}` : ''}: the same chart, written out so it can be read, changed and run.`)
  const base = selectorExpr(spec.selector)
  for (const n of base.notes) out.push(`// Note: ${n}`)
  out.push('', `const rows = ${base.expr}`, '', 'const traces = []', 'let color = 0 // series take the chart tool\'s colours in order')
  // Colours are handed out per drawn trace, in order, across all trace specs — as the plot tool does.
  spec.traces.forEach((t, i) => {
    const kind = t.kind ?? 'scatter'
    const own = t.selector ? selectorExpr(t.selector) : null
    const rowsVar = own ? `rows${i + 1}` : 'rows'
    out.push('')
    if (own) {
      for (const n of own.notes) out.push(`// Note: ${n}`)
      out.push(`const ${rowsVar} = ${own.expr}`)
    }
    const x = t.x ? refExpr(t.x) : undefined
    const y = t.y ? refExpr(t.y) : undefined
    const ax = (ref: ValueRef) => `axisValue(${refExpr(ref)}, ${q(ref)})`
    const opacity = t.opacity !== undefined ? `, opacity: ${t.opacity}` : ''
    const series = `seriesOf(${rowsVar}${t.group ? `, (e) => ${refExpr(t.group)}` : ''})`
    const seriesName = (single: string) => (t.group ? (t.name ? `${q(t.name + ' · ')} + name` : 'name') : single)

    if (kind === 'pie') {
      out.push(`// One slice per ${t.x ? c(describeValueRef(t.x)) : 'type'}, biggest first.`, `{`, `  const slices = sortBy([...groupBy(${rowsVar}.filter((e) => ${x ?? 'e.type'} !== undefined), (e) => String(${x ?? 'e.type'})).entries()], ([, list]) => list.length, true)`, `  traces.push(pie(slices.map(([k]) => k), slices.map(([, list]) => list.length), { name: ${t.name ? q(t.name) : q(t.x ? describeValueRef(t.x) : 'type')}, hole: 0.4${opacity} }))`, `}`)
      return
    }
    if (kind === 'heatmap') {
      if (!t.x || !t.y) return
      out.push(
        `// Rows in cells of ${c(describeValueRef(t.x))} × ${c(describeValueRef(t.y))}; z is the count in each cell.`,
        `{`,
        `  const cells = new Map()`,
        `  let temporalX = false, temporalY = false`,
        `  for (const e of ${rowsVar}) {`,
        `    const ax = ${ax(t.x)}, ay = ${ax(t.y)}`,
        `    if (ax.v === undefined || ay.v === undefined) continue`,
        `    temporalX ||= ax.temporal; temporalY ||= ay.temporal`,
        `    const x = binAxis(ax, ${JSON.stringify(t.bin ?? null)} ?? undefined), y = binAxis(ay, ${JSON.stringify(t.ybin ?? null)} ?? undefined)`,
        `    if (x === undefined || y === undefined) continue`,
        `    const k = typeof x + ':' + x + '|' + typeof y + ':' + y`,
        `    const c = cells.get(k) ?? { x, y, n: 0 }`,
        `    c.n++`,
        `    cells.set(k, c)`,
        `  }`,
        `  const xs = [...new Set([...cells.values()].map((c) => c.x))].sort(sortScalars)`,
        `  const ys = [...new Set([...cells.values()].map((c) => c.y))].sort(sortScalars)`,
        `  const z = ys.map((y) => xs.map((x) => cells.get(typeof x + ':' + x + '|' + typeof y + ':' + y)?.n ?? 0))`,
        `  traces.push(heatmap(xs.map((v) => axisOut(v, temporalX)), ys.map((v) => axisOut(v, temporalY)), z, { ${t.name ? `name: ${q(t.name)}, ` : ''}colorscale: ${scaleLiteral(t.palette)}, hovertemplate: '%{x} · %{y}: %{z}<extra></extra>' }))`,
        `}`,
      )
      return
    }
    if (kind === 'histogram') {
      if (!t.x) return
      out.push(`// A histogram of ${c(describeValueRef(t.x))}${t.group ? `, one per ${c(describeValueRef(t.group))}` : ''}.`, `for (const [name, list] of ${series}) {`, `  const vals = list.map((e) => ${ax(t.x)}).filter((a) => a.v !== undefined)`, `  const temporal = vals.some((a) => a.temporal)`, `  traces.push(histogram(vals.map((a) => axisOut(a.v, temporal)), { name: ${seriesName(nameOf(t, false))}, opacity: ${t.opacity ?? (t.group ? 0.7 : 1)}, marker: { color: ${t.fill ? q(t.fill) : 'plotColor(color++)'} } }))`, `}`)
      return
    }
    if (kind === 'box') {
      if (!t.y) return
      out.push(`// The spread of ${c(describeValueRef(t.y))}${t.x ? ` per ${c(describeValueRef(t.x))}` : ''}${t.group ? `, one box per ${c(describeValueRef(t.group))}` : ''}.`, `for (const [name, list] of ${series}) {`, `  const kept = list.filter((e) => typeof ${ax(t.y)}.v === 'number')`, `  const ys = kept.map((e) => ${ax(t.y)}.v)`, `  traces.push(box(ys, { name: ${seriesName(nameOf(t, false))}${t.x ? `, x: kept.map((e) => ${ax(t.x)}.v ?? '')` : ''}, marker: { color: ${t.fill ? q(t.fill) : 'plotColor(color++)'} }, boxpoints: ys.length <= 500 ? 'outliers' : false${opacity} }))`, `}`)
      return
    }
    if (!x || !t.x) return
    const xr = t.x
    const fn = helper[kind] ?? 'scatter'
    const agg = t.agg ?? (t.y ? undefined : 'count')
    const mode = t.mode ?? (kind === 'scatter' ? 'markers' : 'lines')
    const binArg = JSON.stringify(t.bin ?? null) + ' ?? undefined'
    const styled = (extra: string) => `{ name: ${seriesName(nameOf(t, false))}, text, hovertemplate: '%{text}<br>%{x} · %{y}<extra>%{fullData.name}</extra>'${opacity}${extra} }`
    const colorExpr = t.fill ? q(t.fill) : 'plotColor(color++)'
    if (agg) {
      out.push(`// ${agg === 'count' ? 'How many rows' : `The ${agg} of ${t.y ? c(describeValueRef(t.y)) : 'y'}`} per ${t.bin ? `${typeof t.bin === 'number' ? `${t.bin}-wide bin of ` : `${t.bin} of `}` : ''}${c(describeValueRef(xr))}${t.group ? `, one series per ${c(describeValueRef(t.group))}` : ''}${t.cumulative ? ', as a running total' : ''}.`)
      out.push(
        `for (const [name, list] of ${series}) {`,
        `  const buckets = new Map()`,
        `  let temporal = false`,
        `  for (const e of list) {`,
        `    const a = ${ax(xr)}`,
        `    if (a.v === undefined) continue`,
        ...(agg === 'count' ? [`    const yv = 0`] : [`    const yv = ${y ? ax(t.y!) : '{ v: undefined }'}.v`, `    if (typeof yv !== 'number') continue`]),
        `    temporal ||= a.temporal`,
        `    const k = binAxis(a, ${binArg})`,
        `    if (k === undefined) continue`,
        `    if (!buckets.has(k)) buckets.set(k, [])`,
        `    buckets.get(k).push(yv)`,
        `  }`,
        `  const keys = [...buckets.keys()].sort(sortScalars)`,
        ...(t.cumulative ? [`  let running = 0`, `  const ys = keys.map((k) => (running += aggregate(buckets.get(k), ${q(agg)})))`] : [`  const ys = keys.map((k) => aggregate(buckets.get(k), ${q(agg)}))`]),
        `  const text = keys.map((k) => buckets.get(k).length + ' rows')`,
        `  const c = ${colorExpr}`,
        `  traces.push(${fn}(keys.map((k) => axisOut(k, temporal)), ys, ${styled(fn === 'bar' ? ', marker: { color: c }' : `, mode: ${q(mode)}, marker: { color: c }, line: { color: c, width: 2 }`)}))`,
        `}`,
      )
    } else {
      out.push(`// ${c(describeValueRef(t.y!))} against ${c(describeValueRef(xr))}, one point per row${t.group ? `, one series per ${c(describeValueRef(t.group))}` : ''}.`)
      const picks = [t.color ? `    colors.push(typeof ${ax(t.color!)}.v === 'number' ? ${ax(t.color!)}.v : NaN)` : '', t.size ? `    sizes.push(typeof ${ax(t.size!)}.v === 'number' ? ${ax(t.size!)}.v : NaN)` : ''].filter(Boolean)
      out.push(
        `for (const [name, list] of ${series}) {`,
        `  const xs = [], ys = [], text = []${t.color ? ', colors = []' : ''}${t.size ? ', sizes = []' : ''}`,
        `  let temporalX = false, temporalY = false`,
        `  for (const e of list) {`,
        `    const a = ${ax(xr)}, b = ${ax(t.y!)}`,
        `    if (a.v === undefined || b.v === undefined) continue`,
        `    temporalX ||= a.temporal; temporalY ||= b.temporal`,
        `    const bx = binAxis(a, ${binArg})`,
        `    if (bx === undefined) continue`,
        `    xs.push(bx); ys.push(b.v); text.push(${t.text ? `String(${refExpr(t.text)} ?? '')` : '(e.label ?? e.id)'})`,
        ...picks,
        `  }`,
        `  const c = ${colorExpr}`,
        `  const marker = { color: c }`,
        ...(t.color ? [`  if (colors.some((v) => !Number.isNaN(v))) Object.assign(marker, { color: colors, colorscale: ${scaleLiteral(t.palette)}, showscale: true, colorbar: { title: { text: ${q(describeValueRef(t.color!))} }, thickness: 12 } })`] : []),
        ...(t.size ? [`  if (sizes.some((v) => !Number.isNaN(v))) Object.assign(marker, { size: markerSizes(sizes), sizemode: 'diameter' })`] : []),
        `  traces.push(${fn}(xs.map((v) => axisOut(v, temporalX)), ys.map((v) => axisOut(v, temporalY)), ${styled(fn === 'bar' ? ', marker' : `, mode: ${q(mode)}, marker, line: { color: c, width: 2 }`)}))`,
        `}`,
      )
    }
  })
  const layout: Record<string, unknown> = { title }
  const bars = spec.traces.filter((t) => (t.kind ?? 'scatter') === 'bar').length
  const barmode = spec.layout?.barmode ?? (bars > 1 || spec.traces.some((t) => (t.kind ?? 'scatter') === 'bar' && t.group) ? 'stack' : undefined)
  if (barmode) layout.barmode = barmode
  if (spec.layout?.showlegend !== undefined) layout.showlegend = spec.layout.showlegend
  const ax2 = (a: { title?: string; type?: string } | undefined, fallback?: string) => {
    const o: Record<string, unknown> = {}
    if (a?.title ?? fallback) o.title = a?.title ?? fallback
    if (a?.type) o.type = a.type
    return Object.keys(o).length ? o : undefined
  }
  const first = spec.traces[0]
  const xa = ax2(spec.layout?.xaxis, first?.x ? describeValueRef(first.x) : undefined)
  const ya = ax2(spec.layout?.yaxis, first?.y ? describeValueRef(first.y) : first?.agg || (first && !first.y) ? 'count' : undefined)
  if (xa) layout.xaxis = xa
  if (ya) layout.yaxis = ya
  out.push('', `return figure(traces, ${JSON.stringify(layout, null, 2)})`)
  return out.join('\n') + '\n'
}
