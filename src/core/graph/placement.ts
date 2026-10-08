import type { AnyEntity, EntityId } from '../entity/types'
import type { Positions } from './layouts'
import { categories, domainOf, normalizer } from './scales'
import type { Selector } from './selector'
import { sortWithBlanksLast } from './fields'
import { describeValueRef, isCategoricalRef, numericOf, valueOf, type ValueContext, type ValueRef } from './values'

/**
 * Placement: positions computed from values, in a region of the view.
 * "Put the documents in a grid at the top-left", "scatter by citations ×
 * references in 8×8 bins" — every arrangement is a pure function from
 * nodes + values + a rectangle to positions. Graph y points up (sigma /
 * Gephi convention), so "top" means max y.
 */

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}
export type Anchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'

export interface Region {
  /** What the region is measured against: the visible viewport, the bounding box of all held positions, or an explicit rectangle. */
  of: 'viewport' | 'bbox' | 'rect'
  rect?: Rect
  anchor?: Anchor
  /** Absolute size in graph units, or a fraction of the base (default 1). */
  size?: { w: number; h: number } | { fraction: number }
  /** Inset from the base, in graph units. */
  margin?: number
}

export interface PlacementSpec {
  /** `geo`: every node where it is on Earth — Web Mercator of `y` (latitude, default `data.lat`) and `x` (longitude, default `data.lng`), north up, the shape kept (not stretched to the region). */
  arrangement: 'grid' | 'scatter' | 'circle' | 'line' | 'stack' | 'geo'
  x?: ValueRef
  y?: ValueRef
  z?: ValueRef
  /** Snap scatter/line positions into cells (a heatmap grid). */
  bins?: { x?: number; y?: number }
  scale?: 'linear' | 'log' | 'rank'
  /** Sort nodes by this value before arranging (grid order, circle order). */
  order?: ValueRef
  desc?: boolean
  cols?: number
  /** Distance between grid cells / stack rows; default fills the region. */
  spacing?: number
  region: Region
  /** How nodes sharing a cell are spread: on a small spiral (default) or stacked at the centre. */
  jitter?: 'spiral' | 'none'
  /**
   * scatter: `free` (default) stretches each axis to fill the region, so the picture takes the region's shape;
   * `equal` keeps one scale for both axes (the same unit across and up), fitted inside the region and centred — for
   * axes in the same unit, and for maps.
   */
  aspect?: 'free' | 'equal'
  /**
   * scatter: the axes are longitude (x) and latitude (y). Implies `equal`, and shortens a degree of longitude by
   * cos(latitude) so the picture keeps the map's shape — at Toronto a degree east is 72% of a degree north; drawn
   * degree for degree, the city stands too tall and its shoreline climbs. Defaults to on when the refs look like
   * lng/lon/longitude and lat/latitude; `false` turns it off.
   */
  geo?: boolean
}

/** Whether a pair of value refs reads as a longitude and a latitude — `data.lng` × `data.lat`, `lon`, `longitude`. */
export function looksGeographic(x: ValueRef | undefined, y: ValueRef | undefined): boolean {
  const key = (r: ValueRef | undefined) => (r ?? '').toLowerCase()
  return /(^|[._])(lng|lon|long|longitude)$/.test(key(x)) && /(^|[._])(lat|latitude)$/.test(key(y))
}

export interface Frame {
  viewport: Rect
  bbox: Rect
}

export interface Axis {
  ref: ValueRef
  kind: 'numeric' | 'categorical' | 'binned'
  domain?: [number, number]
  categories?: string[]
  scale: 'linear' | 'log' | 'rank'
  /** Tick positions in graph coordinates along the axis. */
  ticks: { at: number; label: string }[]
  /** Nodes with no value on this axis. */
  missing: number
}

export interface Cell {
  x: number
  y: number
  count: number
  rect: Rect
  label?: string
}

export interface PlaceResult {
  positions: Positions
  cells?: Cell[]
  axes: { x?: Axis; y?: Axis; z?: Axis }
  region: Rect
  /** Nodes with a missing value on a required axis; parked beside the region. */
  unplaced: EntityId[]
}

const W = (r: Rect) => r.maxX - r.minX
const H = (r: Rect) => r.maxY - r.minY

export function resolveRegion(region: Region, frame: Frame): Rect {
  let base = region.of === 'rect' && region.rect ? region.rect : region.of === 'bbox' ? frame.bbox : frame.viewport
  if (W(base) <= 0 || H(base) <= 0) base = { minX: base.minX - 200, minY: base.minY - 200, maxX: base.minX + 200, maxY: base.minY + 200 }
  const m = region.margin ?? 0
  base = { minX: base.minX + m, minY: base.minY + m, maxX: base.maxX - m, maxY: base.maxY - m }
  let w = W(base)
  let h = H(base)
  if (region.size) {
    if ('fraction' in region.size) {
      w *= region.size.fraction
      h *= region.size.fraction
    } else {
      w = region.size.w
      h = region.size.h
    }
  }
  const anchor = region.anchor ?? 'center'
  const ax = anchor.endsWith('left') ? base.minX : anchor.endsWith('right') ? base.maxX - w : anchor === 'left' ? base.minX : anchor === 'right' ? base.maxX - w : (base.minX + base.maxX) / 2 - w / 2
  const ay = anchor.startsWith('top') ? base.maxY - h : anchor.startsWith('bottom') ? base.minY : (base.minY + base.maxY) / 2 - h / 2
  return { minX: ax, minY: ay, maxX: ax + w, maxY: ay + h }
}

/** Value → [0,1] with the chosen scale; NaN when missing. */
function scaler(values: number[], scale: 'linear' | 'log' | 'rank'): { t: (v: number) => number; domain: [number, number] } {
  const finite = values.filter((v) => Number.isFinite(v))
  if (scale === 'rank') {
    const sorted = [...finite].sort((a, b) => a - b)
    const rank = new Map<number, number>()
    // Ties share their mean rank.
    let i = 0
    while (i < sorted.length) {
      let j = i
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++
      rank.set(sorted[i], (i + j) / 2)
      i = j + 1
    }
    const n = Math.max(1, sorted.length - 1)
    return { t: (v) => (Number.isFinite(v) && rank.has(v) ? rank.get(v)! / n : NaN), domain: sorted.length ? [sorted[0], sorted[sorted.length - 1]] : [0, 1] }
  }
  const domain = domainOf(finite, 'auto', scale === 'log')
  return { t: normalizer(domain, scale === 'log'), domain }
}

function niceTicks(domain: [number, number], count = 5): number[] {
  const [lo, hi] = domain
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return []
  if (hi === lo) return [lo]
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}

const fmtTick = (v: number, ref: ValueRef) => (ref.startsWith('meta.') ? new Date(v).toISOString().slice(0, 10) : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? String(v) : v.toPrecision(3))

function numericAxis(ref: ValueRef, nodes: AnyEntity[], ctx: ValueContext, scale: 'linear' | 'log' | 'rank', lo: number, hi: number): { axis: Axis; t: Map<EntityId, number> } {
  const vals = nodes.map((n) => numericOf(n, ref, ctx))
  const sc = scaler(vals, scale)
  const t = new Map<EntityId, number>()
  let missing = 0
  nodes.forEach((n, i) => {
    const v = sc.t(vals[i])
    if (Number.isNaN(v)) missing++
    t.set(n.id, v)
  })
  const ticks = scale === 'rank' ? [0, 0.25, 0.5, 0.75, 1].map((q) => ({ at: lo + q * (hi - lo), label: `${Math.round(q * 100)}%` })) : niceTicks(sc.domain).map((v) => ({ at: lo + sc.t(v) * (hi - lo), label: fmtTick(v, ref) }))
  return { axis: { ref, kind: 'numeric', domain: sc.domain, scale, ticks, missing }, t }
}

function order(nodes: AnyEntity[], spec: PlacementSpec, ctx: ValueContext): AnyEntity[] {
  if (!spec.order) return nodes
  const ref = spec.order
  return sortWithBlanksLast(
    nodes.map((n) => ({ n, k: valueOf(n, ref, ctx) })),
    !!spec.desc,
  ).map((k) => k.n)
}

const GOLDEN = 2.399963229728653

/** Sunflower spiral: the k-th of m points inside a disc of radius r. */
const spiral = (k: number, m: number, r: number) => {
  const rr = r * Math.sqrt((k + 0.5) / m)
  const a = k * GOLDEN
  return { dx: rr * Math.cos(a), dy: rr * Math.sin(a) }
}

export function place(nodesIn: AnyEntity[], spec: PlacementSpec, ctx: ValueContext, frame: Frame, current?: Positions): PlaceResult {
  let R = resolveRegion(spec.region, frame)
  const nodes = order(nodesIn, spec, ctx)
  const positions: Positions = {}
  const unplaced: EntityId[] = []
  const axes: PlaceResult['axes'] = {}
  const zOf = (id: EntityId) => current?.[id]?.z
  const n = nodes.length
  const scale = spec.scale ?? 'linear'
  if (n === 0) return { positions, axes, region: R, unplaced }

  if (spec.arrangement === 'geo') {
    // Web Mercator, in degrees of longitude for x and the projected latitude for y, so a map's shape is a map's shape;
    // the picture is scaled to fit the region without stretching, centred in it.
    const xRef = spec.x ?? 'data.lng'
    const yRef = spec.y ?? 'data.lat'
    const pts: { id: EntityId; x: number; y: number }[] = []
    for (const node of nodes) {
      const lng = numericOf(node, xRef, ctx)
      const lat = numericOf(node, yRef, ctx)
      if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
        unplaced.push(node.id)
        continue
      }
      const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
      pts.push({ id: node.id, x: lng, y: (Math.log((1 + s) / (1 - s)) / 2) * (180 / Math.PI) })
    }
    if (pts.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of pts) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const w = Math.max(maxX - minX, 1e-6)
      const h = Math.max(maxY - minY, 1e-6)
      const k = Math.min(W(R) / w, H(R) / h)
      const ox = (R.minX + R.maxX) / 2 - ((minX + maxX) / 2) * k
      const oy = (R.minY + R.maxY) / 2 - ((minY + maxY) / 2) * k
      for (const p of pts) positions[p.id] = { x: ox + p.x * k, y: oy + p.y * k, ...(zOf(p.id) !== undefined ? { z: zOf(p.id) } : {}) }
      axes.x = { ref: xRef, kind: 'numeric', domain: [minX, maxX], scale: 'linear', ticks: niceTicks([minX, maxX]).map((v) => ({ at: ox + v * k, label: `${v}°` })), missing: unplaced.length }
      axes.y = { ref: yRef, kind: 'numeric', domain: [minY, maxY], scale: 'linear', ticks: [], missing: unplaced.length }
    }
    park(unplaced, positions, R, current)
    return { positions, axes, region: R, unplaced }
  }

  if (spec.arrangement === 'grid') {
    const cols = Math.max(1, spec.cols ?? Math.ceil(Math.sqrt(n)))
    const rows = Math.max(1, Math.ceil(n / cols))
    const cw = spec.spacing ?? W(R) / cols
    const ch = spec.spacing ?? H(R) / rows
    nodes.forEach((node, i) => {
      positions[node.id] = { x: R.minX + ((i % cols) + 0.5) * cw, y: R.maxY - (Math.floor(i / cols) + 0.5) * ch, ...(zOf(node.id) !== undefined ? { z: zOf(node.id) } : {}) }
    })
    const cells: Cell[] = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c, y: r, count: r * cols + c < n ? 1 : 0, rect: { minX: R.minX + c * cw, maxX: R.minX + (c + 1) * cw, minY: R.maxY - (r + 1) * ch, maxY: R.maxY - r * ch } })
    return { positions, axes, region: { minX: R.minX, minY: R.maxY - rows * ch, maxX: R.minX + cols * cw, maxY: R.maxY }, unplaced, cells: cells.length <= 4000 ? cells : undefined }
  }

  if (spec.arrangement === 'stack') {
    // Categorical columns; nodes pile up inside each column.
    const ref = spec.x ?? 'type'
    const cats = categories(nodes.map((nd) => valueOf(nd, ref, ctx)), spec.bins?.x ?? 40)
    const keys = [...cats.keys, ...(cats.overflow ? ['other'] : [])]
    const k = Math.max(1, keys.length)
    const cw = W(R) / k
    const byCol = new Map<number, AnyEntity[]>()
    for (const node of nodes) {
      const v = valueOf(node, ref, ctx)
      const idx = v === undefined ? (cats.overflow ? k - 1 : -1) : (cats.index.get(String(v)) ?? (cats.overflow ? k - 1 : -1))
      if (idx < 0) {
        unplaced.push(node.id)
        continue
      }
      byCol.set(idx, [...(byCol.get(idx) ?? []), node])
    }
    const perRow = Math.max(1, Math.floor(cw / (spec.spacing ?? 40)))
    const maxRows = Math.max(1, ...[...byCol.values()].map((l) => Math.ceil(l.length / perRow)))
    const rh = spec.spacing ?? Math.min(40, H(R) / maxRows)
    const cells: Cell[] = []
    keys.forEach((label, j) => {
      const list = byCol.get(j) ?? []
      const x0 = R.minX + j * cw
      list.forEach((node, i) => {
        positions[node.id] = { x: x0 + ((i % perRow) + 0.5) * (cw / perRow), y: R.minY + (Math.floor(i / perRow) + 0.5) * rh, ...(zOf(node.id) !== undefined ? { z: zOf(node.id) } : {}) }
      })
      cells.push({ x: j, y: 0, count: list.length, label, rect: { minX: x0, maxX: x0 + cw, minY: R.minY, maxY: R.maxY } })
    })
    axes.x = { ref, kind: 'categorical', categories: keys, scale: 'linear', ticks: keys.map((label, j) => ({ at: R.minX + (j + 0.5) * cw, label })), missing: unplaced.length }
    return { positions, cells, axes, region: R, unplaced }
  }

  if (spec.arrangement === 'circle') {
    const cx = (R.minX + R.maxX) / 2
    const cy = (R.minY + R.maxY) / 2
    const r = Math.min(W(R), H(R)) / 2
    const ax = spec.x ? numericAxis(spec.x, nodes, ctx, scale, 0, Math.PI * 2) : undefined
    const ay = spec.y ? numericAxis(spec.y, nodes, ctx, scale, r * 0.25, r) : undefined
    if (ax) axes.x = { ...ax.axis, ticks: ax.axis.ticks.map((t) => ({ ...t, at: t.at })) }
    if (ay) axes.y = ay.axis
    nodes.forEach((node, i) => {
      const tx = ax ? ax.t.get(node.id)! : i / n
      const ty = ay ? ay.t.get(node.id)! : NaN
      if (Number.isNaN(tx) || (ay && Number.isNaN(ty))) {
        unplaced.push(node.id)
        return
      }
      const rad = ay ? r * (0.25 + 0.75 * ty) : r
      const a = tx * Math.PI * 2
      positions[node.id] = { x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a), ...(zOf(node.id) !== undefined ? { z: zOf(node.id) } : {}) }
    })
    park(unplaced, positions, R, current)
    return { positions, axes, region: R, unplaced }
  }

  // scatter / line: numeric axes into the region, optionally binned into cells.
  const xRef = spec.x
  const yRef = spec.arrangement === 'line' ? undefined : spec.y
  const zRef = spec.z
  let ax = xRef ? numericAxis(xRef, nodes, ctx, scale, R.minX, R.maxX) : undefined
  let ay = yRef ? numericAxis(yRef, nodes, ctx, scale, R.minY, R.maxY) : undefined
  const az = zRef ? numericAxis(zRef, nodes, ctx, scale, -H(R) / 2, H(R) / 2) : undefined
  // One scale for both axes: the data's own shape, fitted inside the region and centred, instead of each axis
  // stretched to the region's edge. A map keeps its shape this way; the longitude span is shortened by cos(latitude).
  const geo = spec.geo ?? (spec.arrangement === 'scatter' && looksGeographic(xRef, yRef))
  if (ax?.axis.domain && ay?.axis.domain && scale === 'linear' && (geo || spec.aspect === 'equal')) {
    const [x0, x1] = ax.axis.domain
    const [y0, y1] = ay.axis.domain
    const midLat = geo ? ((y0 + y1) / 2) * (Math.PI / 180) : 0
    const spanX = Math.max(1e-9, (x1 - x0) * (geo ? Math.max(0.05, Math.cos(midLat)) : 1))
    const spanY = Math.max(1e-9, y1 - y0)
    const k = Math.min(W(R) / spanX, H(R) / spanY)
    const w = spanX * k
    const h = spanY * k
    const fit: Rect = { minX: (R.minX + R.maxX) / 2 - w / 2, maxX: (R.minX + R.maxX) / 2 + w / 2, minY: (R.minY + R.maxY) / 2 - h / 2, maxY: (R.minY + R.maxY) / 2 + h / 2 }
    ax = { ...ax, axis: { ...ax.axis, ticks: ax.axis.ticks.map((t) => ({ ...t, at: fit.minX + ((t.at - R.minX) / Math.max(1e-9, W(R))) * w })) } }
    ay = { ...ay, axis: { ...ay.axis, ticks: ay.axis.ticks.map((t) => ({ ...t, at: fit.minY + ((t.at - R.minY) / Math.max(1e-9, H(R))) * h })) } }
    R = fit
  }
  if (ax) axes.x = ax.axis
  if (ay) axes.y = ay.axis
  if (az) axes.z = az.axis
  const bx = spec.bins?.x && xRef ? Math.max(1, Math.floor(spec.bins.x)) : 0
  const by = spec.bins?.y && yRef ? Math.max(1, Math.floor(spec.bins.y)) : 0
  const binned = bx > 0 || by > 0
  const cols = bx || 1
  const rows = by || 1
  const cw = W(R) / cols
  const ch = spec.arrangement === 'line' && !yRef ? Math.min(cw, H(R)) : H(R) / rows
  // Each cell's members in order, and each node's rank within its cell (for the spiral): appended, never copied —
  // building a cell's list by copying it per node was quadratic, and a city's worth of nodes in one cell took minutes.
  const cellNodes = new Map<string, AnyEntity[]>()
  const rankInCell = new Map<EntityId, number>()
  const cellOf = (node: AnyEntity): { c: number; r: number; tx: number; ty: number } | null => {
    const tx = ax ? ax.t.get(node.id)! : 0.5
    const ty = ay ? ay.t.get(node.id)! : 0.5
    if (Number.isNaN(tx) || Number.isNaN(ty)) return null
    return { c: bx ? Math.min(bx - 1, Math.floor(tx * bx)) : 0, r: by ? Math.min(by - 1, Math.floor(ty * by)) : 0, tx, ty }
  }
  for (const node of nodes) {
    const cell = cellOf(node)
    if (!cell) {
      unplaced.push(node.id)
      continue
    }
    const key = `${cell.c},${cell.r}`
    let mates = cellNodes.get(key)
    if (!mates) cellNodes.set(key, (mates = []))
    rankInCell.set(node.id, mates.length)
    mates.push(node)
  }
  const yCentre = (R.minY + R.maxY) / 2
  for (const node of nodes) {
    const cell = cellOf(node)
    if (!cell) continue
    let x: number
    let y: number
    if (binned) {
      const key = `${cell.c},${cell.r}`
      const mates = cellNodes.get(key)!
      const k = rankInCell.get(node.id)!
      const cx = R.minX + (cell.c + 0.5) * cw
      const cy = spec.arrangement === 'line' && !yRef ? yCentre : by ? R.minY + (cell.r + 0.5) * ch : R.minY + cell.ty * H(R)
      const off = mates.length > 1 && spec.jitter !== 'none' ? spiral(k, mates.length, 0.42 * Math.min(cw, ch)) : { dx: 0, dy: 0 }
      x = cx + off.dx
      y = cy + off.dy
    } else {
      x = R.minX + cell.tx * W(R)
      y = spec.arrangement === 'line' && !yRef ? yCentre : R.minY + cell.ty * H(R)
    }
    const tz = az ? az.t.get(node.id)! : NaN
    const z = az && !Number.isNaN(tz) ? -H(R) / 2 + tz * H(R) : zOf(node.id)
    positions[node.id] = { x, y, ...(z !== undefined ? { z } : {}) }
  }
  park(unplaced, positions, R, current)
  let cells: Cell[] | undefined
  if (binned && cols * rows <= 3600) {
    cells = []
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const minY = spec.arrangement === 'line' && !yRef ? yCentre - ch / 2 : R.minY + r * ch
        cells.push({ x: c, y: r, count: cellNodes.get(`${c},${r}`)?.length ?? 0, rect: { minX: R.minX + c * cw, maxX: R.minX + (c + 1) * cw, minY, maxY: minY + ch } })
      }
    if (ax) axes.x = { ...ax.axis, kind: 'binned', ticks: binEdgeTicks(ax.axis, R.minX, R.maxX, cols, xRef!) }
    if (ay && by) axes.y = { ...ay.axis, kind: 'binned', ticks: binEdgeTicks(ay.axis, R.minY, R.maxY, rows, yRef!) }
  }
  return { positions, cells, axes, region: R, unplaced }
}

/** Ticks at the bin edges, labelled with the value each edge corresponds to (linear/log scales) or the quantile (rank). */
function binEdgeTicks(axis: Axis, lo: number, hi: number, bins: number, ref: ValueRef): Axis['ticks'] {
  const [d0, d1] = axis.domain ?? [0, 1]
  const out: Axis['ticks'] = []
  for (let i = 0; i <= bins; i++) {
    const t = i / bins
    const v = axis.scale === 'log' ? 10 ** (Math.log10(Math.max(d0, 1e-9)) + t * (Math.log10(Math.max(d1, 1e-9)) - Math.log10(Math.max(d0, 1e-9)))) : d0 + t * (d1 - d0)
    out.push({ at: lo + t * (hi - lo), label: axis.scale === 'rank' ? `${Math.round(t * 100)}%` : fmtTick(v, ref) })
  }
  return out
}

/** Nodes without values go on a strip just left of the region, in a column, so they stay findable. */
function park(ids: EntityId[], positions: Positions, R: Rect, current?: Positions) {
  if (!ids.length) return
  const step = Math.min(30, H(R) / Math.max(1, ids.length))
  ids.forEach((id, i) => {
    positions[id] = { x: R.minX - Math.max(30, W(R) * 0.06), y: R.maxY - (i + 0.5) * step, ...(current?.[id]?.z !== undefined ? { z: current[id].z } : {}) }
  })
}

export interface TransformOp {
  translate?: { dx?: number; dy?: number; dz?: number }
  scale?: number | { sx?: number; sy?: number; sz?: number }
  /** Degrees, in the xy plane. */
  rotate?: number
  about?: 'centroid' | 'origin' | { x: number; y: number }
  align?: 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
  distribute?: 'x' | 'y'
  /** Rectangle to align against (default: the group's own bbox, i.e. no-op for align). */
  to?: Rect
}

export function bboxOf(ids: Iterable<EntityId>, positions: Positions): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const id of ids) {
    const p = positions[id]
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

/** Move a group of nodes: translate, scale and rotate about a point, align an edge to a rectangle, or distribute evenly. */
export function transform(ids: EntityId[], positions: Positions, op: TransformOp): Positions {
  const present = ids.filter((id) => positions[id])
  const out: Positions = {}
  for (const id of present) out[id] = { ...positions[id] }
  if (!present.length) return out
  const box = bboxOf(present, positions)
  const about = op.about === 'origin' ? { x: 0, y: 0 } : op.about && typeof op.about === 'object' ? op.about : { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
  if (op.translate) {
    for (const id of present) {
      out[id].x += op.translate.dx ?? 0
      out[id].y += op.translate.dy ?? 0
      if (op.translate.dz !== undefined) out[id].z = (out[id].z ?? 0) + op.translate.dz
    }
  }
  if (op.scale !== undefined) {
    const sx = typeof op.scale === 'number' ? op.scale : (op.scale.sx ?? 1)
    const sy = typeof op.scale === 'number' ? op.scale : (op.scale.sy ?? 1)
    const sz = typeof op.scale === 'number' ? op.scale : op.scale.sz
    for (const id of present) {
      out[id].x = about.x + (out[id].x - about.x) * sx
      out[id].y = about.y + (out[id].y - about.y) * sy
      if (sz !== undefined && out[id].z !== undefined) out[id].z = out[id].z! * sz
    }
  }
  if (op.rotate) {
    const a = (op.rotate * Math.PI) / 180
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    for (const id of present) {
      const dx = out[id].x - about.x
      const dy = out[id].y - about.y
      out[id].x = about.x + dx * cos - dy * sin
      out[id].y = about.y + dx * sin + dy * cos
    }
  }
  if (op.align && op.to) {
    const b = bboxOf(present, out)
    const t = op.to
    let dx = 0
    let dy = 0
    if (op.align === 'left') dx = t.minX - b.minX
    else if (op.align === 'right') dx = t.maxX - b.maxX
    else if (op.align === 'center-x') dx = (t.minX + t.maxX) / 2 - (b.minX + b.maxX) / 2
    else if (op.align === 'top') dy = t.maxY - b.maxY
    else if (op.align === 'bottom') dy = t.minY - b.minY
    else if (op.align === 'center-y') dy = (t.minY + t.maxY) / 2 - (b.minY + b.maxY) / 2
    for (const id of present) {
      out[id].x += dx
      out[id].y += dy
    }
  }
  if (op.distribute && present.length > 2) {
    const axis = op.distribute
    const sorted = [...present].sort((a, b) => out[a][axis] - out[b][axis])
    const lo = out[sorted[0]][axis]
    const hi = out[sorted[sorted.length - 1]][axis]
    sorted.forEach((id, i) => (out[id][axis] = lo + ((hi - lo) * i) / (sorted.length - 1)))
  }
  return out
}

export function describePlacement(spec: PlacementSpec): string {
  const parts: string[] = [spec.arrangement]
  const axisDesc = (ref?: ValueRef) => (ref ? (isCategoricalRef(ref) ? describeValueRef(ref) : describeValueRef(ref)) : undefined)
  const x = axisDesc(spec.x)
  const y = axisDesc(spec.y)
  if (x || y) parts.push([x, y].filter(Boolean).join(' × '))
  if (spec.bins?.x || spec.bins?.y) parts.push(`${spec.bins.x ?? 1}×${spec.bins.y ?? 1} bins`)
  if (spec.scale && spec.scale !== 'linear') parts.push(spec.scale)
  if (spec.arrangement === 'scatter' && (spec.geo ?? looksGeographic(spec.x, spec.y))) parts.push('map shape (north up, equal scale)')
  else if (spec.aspect === 'equal') parts.push('equal scale')
  if (spec.order) parts.push(`by ${describeValueRef(spec.order)}${spec.desc ? ' ↓' : ''}`)
  const r = spec.region
  parts.push(`${r.anchor ?? 'center'} of ${r.of}${r.size && 'fraction' in r.size ? ` ×${r.size.fraction}` : ''}`)
  return parts.join(' · ')
}

/** A layout that can be recomputed from data: which nodes, and how to arrange them. */
export interface LayoutRule {
  kind: 'placement'
  selector: Selector
  spec: PlacementSpec
}
