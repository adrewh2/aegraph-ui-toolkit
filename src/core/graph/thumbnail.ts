import type { AnyEntity, EntityId, Relationship } from '../entity/types'
import { cssColor } from '../../lib/cssColor'
import { categoricalColor, paletteColor } from './palettes'
import type { BuiltPlot, PlotlyTrace } from './plot'
import { isProjection, sceneKindOf } from './projection'
import type { LayoutData } from './types'

/**
 * Pictures for the cards on the Scenes and Charts pages, drawn as SVG from
 * what the entity holds — a layout's positions, a scene's placed boxes, a
 * chart's traces — so a scene composed by the headless engine or a chart
 * saved by a tool has one as well as a view captured in a tab. Pure: no DOM,
 * no canvas; the result is a `data:image/svg+xml` URL the card shows as an
 * `<img>`, where an SVG runs nothing. Sampled to a few thousand marks, so a
 * picture is tens of kilobytes at most and draws in a millisecond or two.
 */
export const THUMB_W = 320
export const THUMB_H = 200
const PAD = 12
const MAX_NODES = 1500
const MAX_EDGES = 2000
const MAX_POINTS = 1500
const EDGE = '#8a877f'
const AXIS = '#8a877f'

/** A stored picture: an image data: URL (the captured JPEG, or an SVG drawn here). */
export const isImageUrl = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/')

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

const r1 = (n: number) => Math.round(n * 10) / 10
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${THUMB_W} ${THUMB_H}" width="${THUMB_W}" height="${THUMB_H}">${body}</svg>`
const typeColor = (() => {
  const seen = new Map<string, string>()
  return (type: string) => {
    let c = seen.get(type)
    if (!c) seen.set(type, (c = categoricalColor('tableau10', seen.size)))
    return c
  }
})()

/** Every `n`-th of a list so that at most `max` are left, the ends kept in their order. */
function sample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs
  const step = xs.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)])
  return out
}

/** A fit of world coordinates into the picture, aspect kept, y down as on screen (`flipY` for y-up data). */
function fitter(xs: number[], ys: number[], flipY: boolean) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i]
    if (xs[i] > maxX) maxX = xs[i]
    if (ys[i] < minY) minY = ys[i]
    if (ys[i] > maxY) maxY = ys[i]
  }
  const w = Math.max(maxX - minX, 1e-9), h = Math.max(maxY - minY, 1e-9)
  const s = Math.min((THUMB_W - 2 * PAD) / w, (THUMB_H - 2 * PAD) / h)
  const ox = (THUMB_W - w * s) / 2, oy = (THUMB_H - h * s) / 2
  return { s, x: (x: number) => r1(ox + (x - minX) * s), y: (y: number) => r1(flipY ? oy + (maxY - y) * s : oy + (y - minY) * s) }
}

/** A node-link picture: dots coloured by type over faint edges. `null` when there is nothing placed. */
export function graphThumbnailSvg(points: { id: EntityId; x: number; y: number; type?: string }[], edges: [EntityId, EntityId][], opts: { flipY?: boolean } = {}): string | null {
  const nodes = sample(points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), MAX_NODES)
  if (!nodes.length) return null
  const f = fitter(nodes.map((p) => p.x), nodes.map((p) => p.y), opts.flipY ?? false)
  const at = new Map(nodes.map((p) => [p.id, p]))
  let lines = ''
  let drawn = 0
  for (const [a, b] of edges) {
    const p = at.get(a), q = at.get(b)
    if (!p || !q || p === q) continue
    lines += `M${f.x(p.x)} ${f.y(p.y)}L${f.x(q.x)} ${f.y(q.y)}`
    if (++drawn >= MAX_EDGES) break
  }
  const radius = nodes.length > 600 ? 1.4 : nodes.length > 150 ? 2.2 : nodes.length > 30 ? 3.2 : 4.5
  const byColor = new Map<string, string>()
  for (const p of nodes) byColor.set(typeColor(p.type ?? ''), (byColor.get(typeColor(p.type ?? '')) ?? '') + `<circle cx="${f.x(p.x)}" cy="${f.y(p.y)}" r="${radius}"/>`)
  let dots = ''
  for (const [c, circles] of byColor) dots += `<g fill="${c}">${circles}</g>`
  return svg(`${lines ? `<path d="${lines}" stroke="${EDGE}" stroke-opacity="${drawn > 500 ? 0.18 : 0.4}" stroke-width="0.7" fill="none"/>` : ''}${dots}`)
}

interface EntityReader {
  get(id: EntityId): AnyEntity | undefined
  relationshipsOf(id: EntityId): Relationship[]
}

/** The edges among a set of placed ids, read from the store: each once, up to the cap. */
function edgesAmong(ids: EntityId[], store: EntityReader): [EntityId, EntityId][] {
  const inSet = new Set(ids)
  const seen = new Set<EntityId>()
  const out: [EntityId, EntityId][] = []
  for (const id of ids) {
    for (const r of store.relationshipsOf(id)) {
      if (seen.has(r.id) || !inSet.has(r.source.id) || !inSet.has(r.target.id)) continue
      seen.add(r.id)
      out.push([r.source.id, r.target.id])
      if (out.length >= MAX_EDGES) return out
    }
  }
  return out
}

/**
 * A scene's picture from what it holds: a graph scene's layout part (the positions the app or the headless engine
 * computed and saved), a hand-arranged or script scene's placed boxes. `null` when it holds no positions — a graph
 * scene whose layout is computed when it opens.
 */
export function sceneThumbnailSvg(scene: AnyEntity, store: EntityReader): string | null {
  const kind = sceneKindOf(scene.type)
  if (kind === 'graph') {
    const layoutId = (scene.data as { layoutId?: EntityId }).layoutId
    const layout = layoutId ? store.get(layoutId) : undefined
    const positions = (layout?.data as LayoutData | undefined)?.positions
    if (!positions) return null
    const ids = sample(Object.keys(positions), MAX_NODES)
    const points = ids.map((id) => ({ id, x: positions[id].x, y: positions[id].y, type: store.get(id)?.type }))
    // The engine draws y up; a layout's numbers are its world coordinates.
    return graphThumbnailSvg(points, edgesAmong(ids, store), { flipY: true })
  }
  if (!isProjection(scene)) return null
  const d = scene.data
  const entries = sample(Object.entries(d.nodes ?? {}), MAX_NODES)
  if (!entries.length) return null
  // Scenes are diagrams: boxes in page coordinates, y down, drawn as boxes when there are few enough to read as such.
  const xs: number[] = [], ys: number[] = []
  for (const [, n] of entries) {
    xs.push(n.x - n.width / 2, n.x + n.width / 2)
    ys.push(n.y - n.height / 2, n.y + n.height / 2)
  }
  for (const g of Object.values(d.groups ?? {})) {
    xs.push(g.x, g.x + g.width)
    ys.push(g.y, g.y + g.height)
  }
  const f = fitter(xs, ys, false)
  let body = ''
  for (const g of Object.values(d.groups ?? {})) body += `<rect x="${f.x(g.x)}" y="${f.y(g.y)}" width="${r1(g.width * f.s)}" height="${r1(g.height * f.s)}" rx="4" fill="${EDGE}" fill-opacity="0.08" stroke="${EDGE}" stroke-opacity="0.5" stroke-width="0.8"/>`
  const at = new Map(entries)
  let lines = ''
  let drawn = 0
  for (const e of Object.values(d.edges ?? {})) {
    const a = e.points?.[0], b = e.points?.[e.points.length - 1]
    if (!a || !b) continue
    lines += `M${f.x(a.x)} ${f.y(a.y)}L${f.x(b.x)} ${f.y(b.y)}`
    if (++drawn >= MAX_EDGES) break
  }
  if (!drawn) {
    // A script scene places entities and draws no routes: the relationships between them stand in.
    for (const [a, b] of edgesAmong([...at.keys()], store)) {
      const p = at.get(a)!, q = at.get(b)!
      lines += `M${f.x(p.x)} ${f.y(p.y)}L${f.x(q.x)} ${f.y(q.y)}`
    }
  }
  if (lines) body += `<path d="${lines}" stroke="${EDGE}" stroke-opacity="0.45" stroke-width="0.8" fill="none"/>`
  const boxes = entries.length <= 200
  for (const [id, n] of entries) {
    const c = cssColor(n.fill, typeColor(store.get(id)?.type ?? ''))
    if (boxes) body += `<rect x="${f.x(n.x - n.width / 2)}" y="${f.y(n.y - n.height / 2)}" width="${Math.max(2, r1(n.width * f.s))}" height="${Math.max(2, r1(n.height * f.s))}" rx="2" fill="${c}" fill-opacity="0.85"/>`
    else body += `<circle cx="${f.x(n.x)}" cy="${f.y(n.y)}" r="1.6" fill="${c}"/>`
  }
  return svg(body)
}

// ── Charts ──

const ISO = /^\d{4}-\d{2}-\d{2}/
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
const traceColor = (t: PlotlyTrace, i: number) => {
  const m = t.marker as { color?: unknown } | undefined
  const l = t.line as { color?: unknown } | undefined
  return cssColor(typeof m?.color === 'string' ? m.color : l?.color, categoricalColor('tableau10', i))
}

/** An x axis shared by every trace: numbers and dates as themselves, anything else as categories in the order met. */
function xAxis(traces: PlotlyTrace[]) {
  const all = traces.flatMap((t) => arr(t.x))
  const numeric = all.length > 0 && all.every((v) => num(v) !== undefined)
  const cats = new Map<string, number>()
  if (!numeric) for (const v of all) if (!cats.has(String(v))) cats.set(String(v), cats.size)
  return { numeric, count: cats.size, at: (v: unknown) => (numeric ? num(v)! : cats.get(String(v))!) }
}

function arcPath(cx: number, cy: number, r0: number, r1_: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${r1(cx + r * Math.sin(a))} ${r1(cy - r * Math.cos(a))}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${p(r1_, a0)}A${r1_} ${r1_} 0 ${large} 1 ${p(r1_, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`
}

function quantile(sorted: number[], q: number) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo)
}

/** A chart's picture from its built traces — the marks only, no labels: the card is a glance, the chart is a click away. `null` when nothing is plotted. */
export function plotThumbnailSvg(built: Pick<BuiltPlot, 'data'>): string | null {
  const traces = built.data
  if (!traces.length) return null
  const L = PAD, R = THUMB_W - PAD, T = PAD, B = THUMB_H - PAD
  const kind = String(traces[0].type ?? 'scatter')

  if (kind === 'pie') {
    const t = traces[0]
    const values = arr(t.values).map((v) => num(v) ?? 0)
    const total = values.reduce((a, b) => a + b, 0)
    if (!total) return null
    let a = 0
    let body = ''
    values.forEach((v, i) => {
      if (v <= 0) return
      const next = a + (v / total) * Math.PI * 2
      body += `<path d="${arcPath(THUMB_W / 2, THUMB_H / 2, 40, 84, a, Math.min(next, a + Math.PI * 2 - 1e-4))}" fill="${categoricalColor('tableau10', i)}"/>`
      a = next
    })
    return svg(body)
  }

  if (kind === 'heatmap') {
    const z = arr(traces[0].z).map((row) => arr(row).map(num))
    const rows = z.length, cols = Math.max(0, ...z.map((r) => r.length))
    if (!rows || !cols) return null
    const flat = z.flat().filter((v): v is number => v !== undefined)
    const lo = Math.min(...flat), hi = Math.max(...flat)
    const cw = (R - L) / cols, ch = (B - T) / rows
    let body = ''
    z.forEach((row, j) => row.forEach((v, i) => {
      if (v === undefined) return
      body += `<rect x="${r1(L + i * cw)}" y="${r1(B - (j + 1) * ch)}" width="${r1(cw + 0.3)}" height="${r1(ch + 0.3)}" fill="${paletteColor('viridis', hi > lo ? (v - lo) / (hi - lo) : 0.5)}"/>`
    }))
    return svg(body)
  }

  if (kind === 'box') {
    const boxes = traces.map((t) => arr(t.y).map(num).filter((v): v is number => v !== undefined).sort((a, b) => a - b)).filter((ys) => ys.length)
    if (!boxes.length) return null
    const lo = Math.min(...boxes.map((b) => b[0])), hi = Math.max(...boxes.map((b) => b[b.length - 1]))
    const y = (v: number) => r1(hi > lo ? B - ((v - lo) / (hi - lo)) * (B - T) : (T + B) / 2)
    const band = (R - L) / boxes.length
    let body = ''
    boxes.forEach((ys, i) => {
      const c = traceColor(traces[i], i)
      const cx = L + band * (i + 0.5), w = Math.min(band * 0.5, 60)
      const q1 = quantile(ys, 0.25), q2 = quantile(ys, 0.5), q3 = quantile(ys, 0.75)
      body += `<path d="M${r1(cx)} ${y(ys[0])}V${y(q1)}M${r1(cx)} ${y(q3)}V${y(ys[ys.length - 1])}" stroke="${c}" stroke-width="1.2"/>`
      body += `<rect x="${r1(cx - w / 2)}" y="${y(q3)}" width="${r1(w)}" height="${Math.max(1, r1(y(q1) - y(q3)))}" fill="${c}" fill-opacity="0.35" stroke="${c}" stroke-width="1.2"/>`
      body += `<path d="M${r1(cx - w / 2)} ${y(q2)}H${r1(cx + w / 2)}" stroke="${c}" stroke-width="2"/>`
    })
    return svg(body)
  }

  // Histograms bin here into bars; everything else is x/y marks.
  const series = traces.map((t, i) => {
    if (String(t.type) === 'histogram') {
      const xs = arr(t.x)
      const ax = xAxis([t])
      const vals = xs.map(ax.at).filter((v) => Number.isFinite(v))
      if (!vals.length) return { type: 'bar', color: traceColor(t, i), xs: [] as number[], ys: [] as number[] }
      if (!ax.numeric) {
        const counts = new Map<number, number>()
        for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1)
        return { type: 'bar', color: traceColor(t, i), xs: [...counts.keys()], ys: [...counts.values()] }
      }
      const lo = Math.min(...vals), hi = Math.max(...vals)
      const n = Math.min(30, Math.max(5, Math.ceil(Math.sqrt(vals.length))))
      const w = (hi - lo) / n || 1
      const ys = new Array<number>(n).fill(0)
      for (const v of vals) ys[Math.min(n - 1, Math.floor((v - lo) / w))]++
      return { type: 'bar', color: traceColor(t, i), xs: ys.map((_, k) => lo + w * (k + 0.5)), ys }
    }
    const xs = arr(t.x), ys = arr(t.y)
    const px: unknown[] = [], py: number[] = []
    for (let k = 0; k < Math.min(xs.length, ys.length); k++) {
      const y = num(ys[k])
      if (y === undefined) continue
      px.push(xs[k])
      py.push(y)
    }
    const type = String(t.type) === 'bar' ? 'bar' : t.fill === 'tozeroy' ? 'area' : String(t.mode ?? 'markers').includes('lines') ? 'line' : 'scatter'
    return { type, color: traceColor(t, i), raw: px, ys: py, xs: [] as number[] }
  })
  // One x axis across the traces that are not histograms, so categories line up.
  const shared = xAxis(traces.filter((t) => String(t.type) !== 'histogram').map((t, i) => ({ ...t, x: (series[i] as { raw?: unknown[] }).raw ?? [] })))
  for (const s of series) if ('raw' in s && s.raw) s.xs = s.raw.map(shared.at)
  const all = series.filter((s) => s.xs.length)
  if (!all.length) return null
  const xsAll = all.flatMap((s) => s.xs), ysAll = all.flatMap((s) => s.ys)
  const anyBar = all.some((s) => s.type === 'bar' || s.type === 'area')
  let xlo = Math.min(...xsAll), xhi = Math.max(...xsAll)
  const ylo = Math.min(anyBar ? 0 : Infinity, ...ysAll), yhi = Math.max(anyBar ? 0 : -Infinity, ...ysAll)
  const bars = all.filter((s) => s.type === 'bar')
  // Bars get half a step of room at each end so the outer ones are whole.
  const steps = [...new Set(xsAll)].sort((a, b) => a - b)
  let step = Infinity
  for (let k = 1; k < steps.length; k++) step = Math.min(step, steps[k] - steps[k - 1])
  if (!Number.isFinite(step)) step = Math.max(xhi - xlo, 1)
  if (bars.length) {
    xlo -= step / 2
    xhi += step / 2
  }
  const x = (v: number) => r1(xhi > xlo ? L + ((v - xlo) / (xhi - xlo)) * (R - L) : (L + R) / 2)
  const y = (v: number) => r1(yhi > ylo ? B - ((v - ylo) / (yhi - ylo)) * (B - T) : (T + B) / 2)
  const bw = Math.max(1, ((step / Math.max(xhi - xlo, 1e-9)) * (R - L) * 0.8) / Math.max(1, bars.length))
  let body = `<path d="M${L} ${y(Math.max(ylo, Math.min(0, yhi)))}H${R}" stroke="${AXIS}" stroke-opacity="0.5" stroke-width="0.8"/>`
  all.forEach((s) => {
    const order = s.xs.map((_, k) => k).sort((a, b) => s.xs[a] - s.xs[b])
    if (s.type === 'bar') {
      const bi = bars.indexOf(s)
      let d = ''
      for (const k of order) {
        const y0 = y(0), y1 = y(s.ys[k])
        d += `M${r1(x(s.xs[k]) - (bars.length * bw) / 2 + bi * bw)} ${Math.min(y0, y1)}h${r1(bw)}v${Math.max(0.5, r1(Math.abs(y1 - y0)))}h${-r1(bw)}Z`
      }
      body += `<path d="${d}" fill="${s.color}"/>`
    } else if (s.type === 'line' || s.type === 'area') {
      const pts = sample(order, MAX_POINTS).map((k) => `${x(s.xs[k])} ${y(s.ys[k])}`)
      if (s.type === 'area') body += `<path d="M${pts[0].split(' ')[0]} ${y(0)}L${pts.join('L')}L${pts[pts.length - 1].split(' ')[0]} ${y(0)}Z" fill="${s.color}" fill-opacity="0.25"/>`
      body += `<path d="M${pts.join('L')}" stroke="${s.color}" stroke-width="1.8" fill="none" stroke-linejoin="round"/>`
    } else {
      const pts = sample(order, MAX_POINTS)
      const r = pts.length > 400 ? 1.4 : 2.4
      body += `<g fill="${s.color}" fill-opacity="0.75">${pts.map((k) => `<circle cx="${x(s.xs[k])}" cy="${y(s.ys[k])}" r="${r}"/>`).join('')}</g>`
    }
  })
  return svg(body)
}

/** A chart's picture as a data: URL, to store with the chart when it is saved (by the Charts page or the `plot` tool, in a tab or headless). */
export function plotPreview(built: Pick<BuiltPlot, 'data'>): string | undefined {
  const s = plotThumbnailSvg(built)
  return s ? svgDataUrl(s) : undefined
}

/** A graph scene's picture from the slice it holds and the positions its layout gave — what the headless `graph_scene` stores. */
export function graphScenePreview(nodes: { id: EntityId; type: string }[], edges: { source: { id: EntityId }; target: { id: EntityId } }[], positions: Record<EntityId, { x: number; y: number }>): string | undefined {
  const points = nodes.flatMap((n) => (positions[n.id] ? [{ id: n.id, x: positions[n.id].x, y: positions[n.id].y, type: n.type }] : []))
  const s = graphThumbnailSvg(points, edges.map((e) => [e.source.id, e.target.id]), { flipY: true })
  return s ? svgDataUrl(s) : undefined
}

/** The picture a card shows: the one stored with the entity when there is one, else one drawn from what it holds. */
export function scenePreview(scene: AnyEntity, store: EntityReader): string | undefined {
  const stored = (scene.data as { preview?: unknown }).preview
  if (isImageUrl(stored)) return stored
  const s = sceneThumbnailSvg(scene, store)
  return s ? svgDataUrl(s) : undefined
}
