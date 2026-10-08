/**
 * The pins of a map as numbers, indexed for clustering: built once per
 * features list, then a redraw at any zoom reads the cells in view and
 * touches an entity only when it is drawn.
 *
 * Why: a map of a city's trees is 688,335 locations. Clustering them by
 * walking the entities — reading `data.lat`, resolving a colour from the
 * tags — cost a second per zoom step, and the same again on every pan
 * that left the drawn margin. Here the coordinates and the colour of
 * every point are read once into flat arrays, and the points are sorted
 * once in **Morton order** of their cell at the deepest zoom: a cell of
 * CLUSTER_PX at any coarser zoom is exactly 2^k × 2^k of those cells, and
 * in Morton order that is one contiguous run. So a zoom's cells — count,
 * centroid (from prefix sums), members (a slice of the order) — fall out
 * of one linear walk, with no grid to build per zoom and nothing kept per
 * zoom either.
 */
import type { GeoEntity } from './maps'

/** Pins closer than this on screen become one bubble; also the cell size of the grid at every zoom. */
export const CLUSTER_PX = 44
/** The zoom whose cells are the unit of the order; a coarser zoom's cell is 2^(BASE_ZOOM − zoom) of them a side. */
export const BASE_ZOOM = 19

export interface PinIndex {
  /** `[lat, lng, …]` per feature; NaN for a shape (a path, an area), which is drawn as a shape, not a pin. */
  coords: Float64Array
  /** Feature indices that are points, in Morton order of their BASE_ZOOM cell. */
  order: Uint32Array
  /** Feature indices that are shapes. */
  shapes: Uint32Array
  /** Each ordered point's cell column and row at BASE_ZOOM. */
  col: Uint32Array
  row: Uint32Array
  /** Prefix sums of the ordered points' Mercator pixels at BASE_ZOOM: `sx[i]` is the sum over the first i points. */
  sx: Float64Array
  sy: Float64Array
  /** A colour per feature, as an index into `palette` (0 for a shape). */
  colorIdx: Uint16Array
  palette: string[]
  /** The colour resolver the palette was built with; a different one rebuilds it. */
  colorOf: ((tags: string[]) => string | undefined) | undefined
  /** Feature index by entity id, built on first use (a hover card or a selection asks for one among a city's worth). */
  byId?: Map<string, number>
}

/** One cell of a zoom, in view: its members are `order[start, end)`; `x`, `y` its centroid in Mercator pixels at that zoom. */
export interface Cell {
  start: number
  end: number
  x: number
  y: number
  /** The cell's column and row at that zoom. */
  col: number
  row: number
}

/** Web Mercator x in pixels at a zoom, from a longitude. */
export const mercX = (lng: number, zoom: number) => ((lng + 180) * 256 * 2 ** zoom) / 360
/** Web Mercator y in pixels at a zoom, from a latitude (clamped to the projection's range). */
export const mercY = (lat: number, zoom: number) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
  return ((180 - (Math.log((1 + s) / (1 - s)) / 2) * (180 / Math.PI)) * 256 * 2 ** zoom) / 360
}

/** A latitude and longitude from Mercator pixels at a zoom: the inverse of mercX / mercY. */
export const unproject = (x: number, y: number, zoom: number): [number, number] => {
  const w = 256 * 2 ** zoom
  const lng = (x * 360) / w - 180
  const lat = (Math.atan(Math.exp(((180 - (y * 360) / w) * Math.PI) / 180)) * 360) / Math.PI - 90
  return [lat, lng]
}

/** The bits of a 16-bit value spread to the even bits of a 32-bit one (the classic magic-mask spread). */
function spread16(x: number): number {
  x &= 0xffff
  x = (x | (x << 8)) & 0x00ff00ff
  x = (x | (x << 4)) & 0x0f0f0f0f
  x = (x | (x << 2)) & 0x33333333
  x = (x | (x << 1)) & 0x55555555
  return x
}

/**
 * Bits of a 22-bit column and row interleaved: the Morton code of a BASE_ZOOM cell (44 bits, exact in a double).
 * The low sixteen bits of each are spread with masks into one 32-bit word, the high six into another that is
 * scaled up past it — a dozen operations, where a loop over the 22 bit positions was a third of the index's cost.
 */
export function morton(col: number, row: number): number {
  const low = (spread16(col) | (spread16(row) << 1)) >>> 0
  const high = (spread16(col >>> 16) | (spread16(row >>> 16) << 1)) >>> 0
  return high * 4294967296 + low
}

/** Indices 0..n−1 sorted by their keys (non-negative integers under 2^44): a radix sort, four passes of eleven bits. */
function sortByKey(keys: Float64Array): Uint32Array {
  const n = keys.length
  let src = new Uint32Array(n)
  for (let i = 0; i < n; i++) src[i] = i
  let dst = new Uint32Array(n)
  const counts = new Uint32Array(2049)
  for (let pass = 0; pass < 4; pass++) {
    const div = 2 ** (11 * pass)
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[(Math.floor(keys[src[i]] / div) % 2048) + 1]++
    for (let d = 0; d < 2048; d++) counts[d + 1] += counts[d]
    for (let i = 0; i < n; i++) {
      const k = src[i]
      dst[counts[Math.floor(keys[k] / div) % 2048]++] = k
    }
    const t = src
    src = dst
    dst = t
  }
  return src
}

const indexOf = new WeakMap<GeoEntity[], PinIndex>()

/** The index for a features list (built on first use, kept per list); the palette follows `colorOf`. */
export function pinIndex(features: GeoEntity[], colorOf: PinIndex['colorOf'], fallback: string): PinIndex {
  let ix = indexOf.get(features)
  if (!ix) {
    const n = features.length
    const coords = new Float64Array(n * 2)
    const points: number[] = []
    const shapes: number[] = []
    for (let i = 0; i < n; i++) {
      const p = features[i]
      const geo = p.data.geometry
      if (!geo || geo.type === 'Point') {
        coords[2 * i] = p.data.lat
        coords[2 * i + 1] = p.data.lng
        points.push(i)
      } else {
        coords[2 * i] = NaN
        coords[2 * i + 1] = NaN
        shapes.push(i)
      }
    }
    // Every point's cell at the deepest zoom, the order by Morton code, and the prefix sums in that order.
    const m = points.length
    const keys = new Float64Array(m)
    const xs = new Float64Array(m)
    const ys = new Float64Array(m)
    for (let k = 0; k < m; k++) {
      const i = points[k]
      xs[k] = mercX(coords[2 * i + 1], BASE_ZOOM)
      ys[k] = mercY(coords[2 * i], BASE_ZOOM)
      keys[k] = morton(Math.floor(xs[k] / CLUSTER_PX), Math.floor(ys[k] / CLUSTER_PX))
    }
    const sorted = sortByKey(keys)
    const order = new Uint32Array(m)
    const col = new Uint32Array(m)
    const row = new Uint32Array(m)
    const sx = new Float64Array(m + 1)
    const sy = new Float64Array(m + 1)
    for (let j = 0; j < m; j++) {
      const k = sorted[j]
      order[j] = points[k]
      col[j] = Math.floor(xs[k] / CLUSTER_PX)
      row[j] = Math.floor(ys[k] / CLUSTER_PX)
      sx[j + 1] = sx[j] + xs[k]
      sy[j + 1] = sy[j] + ys[k]
    }
    ix = { coords, order, shapes: Uint32Array.from(shapes), col, row, sx, sy, colorIdx: new Uint16Array(n), palette: [], colorOf: undefined }
    indexOf.set(features, ix)
  }
  if (ix.colorOf !== colorOf || !ix.palette.length) {
    const slot = new Map<string, number>()
    const palette: string[] = []
    const idx = ix.colorIdx
    for (let k = 0; k < ix.order.length; k++) {
      const i = ix.order[k]
      const c = colorOf?.(features[i].tags) ?? fallback
      let s = slot.get(c)
      if (s === undefined) {
        s = palette.length
        palette.push(c)
        slot.set(c, s)
      }
      idx[i] = s
    }
    ix.palette = palette
    ix.colorOf = colorOf
  }
  return ix
}

/**
 * The non-empty cells of a zoom whose centroid lies within a box (Mercator pixels at that zoom; omit the box for all
 * of them): one linear walk over the order, a cell per run of points sharing a cell at that zoom.
 */
export function cellsAt(ix: PinIndex, zoom: number, box?: { minX: number; maxX: number; minY: number; maxY: number }): Cell[] {
  const shift = Math.max(0, BASE_ZOOM - Math.floor(zoom))
  const scale = 2 ** (zoom - BASE_ZOOM)
  const { col, row, sx, sy } = ix
  const out: Cell[] = []
  const n = col.length
  let start = 0
  while (start < n) {
    const c = col[start] >>> shift
    const r = row[start] >>> shift
    let end = start + 1
    while (end < n && col[end] >>> shift === c && row[end] >>> shift === r) end++
    const x = ((sx[end] - sx[start]) / (end - start)) * scale
    const y = ((sy[end] - sy[start]) / (end - start)) * scale
    if (!box || (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY)) out.push({ start, end, x, y, col: c, row: r })
    start = end
  }
  return out
}

/** The cell a feature falls in at a zoom, as `[col, row]`, or null for a shape. */
export function cellOf(ix: PinIndex, zoom: number, feature: number): [number, number] | null {
  const lat = ix.coords[2 * feature]
  if (lat !== lat) return null
  const shift = Math.max(0, BASE_ZOOM - Math.floor(zoom))
  return [Math.floor(mercX(ix.coords[2 * feature + 1], BASE_ZOOM) / CLUSTER_PX) >>> shift, Math.floor(mercY(lat, BASE_ZOOM) / CLUSTER_PX) >>> shift]
}

/** The index of the feature with this id, or -1. */
export function featureIndex(ix: PinIndex, features: GeoEntity[], id: string): number {
  if (!ix.byId) {
    ix.byId = new Map()
    for (let i = 0; i < features.length; i++) ix.byId.set(features[i].id, i)
  }
  return ix.byId.get(id) ?? -1
}
