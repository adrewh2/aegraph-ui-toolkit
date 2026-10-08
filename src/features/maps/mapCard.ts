import type { BaseLayer, GeoEntity, MapEntity } from './maps'

/**
 * A map's card: what is on it, where it is. The view is fitted to the map's
 * own locations, paths and areas — not the centre it was last left at — the
 * base tiles are the ones that view needs, and every feature is drawn over
 * them in the colour the map gives it. Pure arithmetic, so the index can draw
 * a card for a city of street trees without mounting a map: the marks are a
 * handful of SVG paths (one per colour; a dot is a zero-length round-capped
 * line), sampled down to a budget, and the whole thing is computed once per
 * data version.
 */

export const THUMB_W = 320
export const THUMB_H = 240
const TILE = 256
const PAD = 0.14
const MAX_DOTS = 4000
const MAX_SHAPES = 1500
const MAX_SHAPE_POINTS = 120
const MIN_ZOOM = 0
const MAX_ZOOM = 16

/** Each kind's colour when its tags give none — the map's own defaults. */
export const GEO_COLORS = { location: '#e76f51', path: '#2a6f97', area: '#7b4fa3', note: '#e9a23b' } as const

export interface ThumbTile {
  url: string
  /** Where the tile's top-left corner sits in the card, and its size there. */
  x: number
  y: number
  size: number
}

export interface MapThumb {
  tiles: ThumbTile[]
  /** Areas, then paths, then dots: one path per colour and kind, drawn in that order. */
  areas: { color: string; d: string }[]
  paths: { color: string; d: string }[]
  dots: { color: string; d: string }[]
  /** The dot's diameter, from how many there are: a few places read as pins, thousands as a texture. */
  dotSize: number
  /** How many features the card shows of how many there are (sampled past the budget). */
  shown: number
  total: number
}

export function tileUrl(layer: BaseLayer, z: number, x: number, y: number): string {
  if (layer === 'satellite') return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
  if (layer === 'terrain') return `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
}

/** Web Mercator at zoom 0: [0, 256) across, the same the tiles use. */
const wx = (lng: number) => ((lng + 180) / 360) * TILE
function wy(lat: number) {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE
}

type Coords = [number, number][]
function shapeOf(e: GeoEntity): { kind: 'location' | 'path' | 'area'; coords: Coords } {
  const g = e.data.geometry
  if (g?.type === 'LineString' && g.coordinates.length > 1) return { kind: 'path', coords: g.coordinates }
  if (g?.type === 'Polygon' && (g.coordinates[0]?.length ?? 0) > 2) return { kind: 'area', coords: g.coordinates[0] }
  return { kind: 'location', coords: [[e.data.lng, e.data.lat]] }
}

/** A line's longitudes made continuous, so a route across the antimeridian is not drawn the long way round. */
function unwrap(cs: Coords): Coords {
  const out: Coords = []
  let shift = 0
  for (let i = 0; i < cs.length; i++) {
    if (i) {
      const d = cs[i][0] + shift - out[i - 1][0]
      if (d > 180) shift -= 360
      else if (d < -180) shift += 360
    }
    out.push([cs[i][0] + shift, cs[i][1]])
  }
  return out
}

const every = <T>(xs: T[], max: number): T[] => {
  if (xs.length <= max) return xs
  const step = xs.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)])
  return out
}

/** The low and high values a stray point or two cannot drag: the whole range for a few, the 0.5–99.5% range for many. */
function span(vs: number[]): [number, number] {
  if (vs.length < 200) return [Math.min(...vs), Math.max(...vs)]
  const s = every(vs, 20000).sort((a, b) => a - b)
  return [s[Math.floor(s.length * 0.005)], s[Math.ceil(s.length * 0.995) - 1]]
}

/**
 * The card for a map and what is on it. `colorOf` is the map's own (a
 * feature's first tag with a colour); `tiles: false` leaves the base out —
 * the third-party switch is off — and the marks are drawn on the page.
 */
export function mapThumb(map: Pick<MapEntity, 'data'>, features: GeoEntity[], colorOf: (tags: string[]) => string | undefined, opts: { tiles?: boolean; width?: number; height?: number } = {}): MapThumb {
  const W = opts.width ?? THUMB_W
  const H = opts.height ?? THUMB_H
  // One pass to sort locations from lines, no objects made; shapes are read only for what is sampled.
  const locs: GeoEntity[] = []
  const lines: GeoEntity[] = []
  for (let i = 0; i < features.length; i++) {
    const t = features[i].data.geometry?.type
    ;(t === 'LineString' || t === 'Polygon' ? lines : locs).push(features[i])
  }

  // The view: the features' extent, or the map's own view when it has none yet.
  const xs: number[] = []
  const ys: number[] = []
  for (const e of every(locs, 20000)) xs.push(wx(e.data.lng)), ys.push(wy(e.data.lat))
  for (const e of every(lines, 2000)) {
    const s = shapeOf(e)
    for (const [lng, lat] of every(s.kind === 'location' ? s.coords : unwrap(s.coords), 32)) xs.push(wx(lng)), ys.push(wy(lat))
  }
  let zoom: number, cx: number, cy: number
  if (!xs.length) {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, map.data.zoom - 1))
    cx = wx(map.data.center.lng)
    cy = wy(map.data.center.lat)
  } else {
    const [x0, x1] = span(xs)
    const [y0, y1] = span(ys)
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    const fit = Math.log2(Math.min((W * (1 - 2 * PAD)) / Math.max(x1 - x0, 1e-9), (H * (1 - 2 * PAD)) / Math.max(y1 - y0, 1e-9)))
    // One place is shown where it is, at the zoom the map was left at (a street, not the whole planet).
    zoom = Math.max(MIN_ZOOM, Math.min(x1 - x0 < 1e-7 && y1 - y0 < 1e-7 ? Math.min(map.data.zoom, 15) : MAX_ZOOM, fit))
  }
  const scale = 2 ** zoom
  const left = cx * scale - W / 2
  const top = cy * scale - H / 2
  const px = (lng: number) => wx(lng) * scale - left
  const py = (lat: number) => wy(lat) * scale - top

  // The tiles: one level finer than the view and shown smaller, so the card is sharp rather than stretched.
  const tiles: ThumbTile[] = []
  if (opts.tiles !== false) {
    const z = Math.min(MAX_ZOOM + 1, Math.max(0, Math.ceil(zoom)))
    const size = (TILE * scale) / 2 ** z
    const n = 2 ** z
    for (let ty = Math.floor(top / size); ty * size < top + H; ty++) {
      if (ty < 0 || ty >= n) continue
      for (let tx = Math.floor(left / size); tx * size < left + W; tx++) tiles.push({ url: tileUrl(map.data.layer, z, ((tx % n) + n) % n, ty), x: tx * size - left, y: ty * size - top, size })
    }
  }

  // The marks, grouped by colour: an SVG path per colour holds a city.
  const r1 = (v: number) => Math.round(v * 10) / 10
  const group = () => new Map<string, string[]>()
  const areas = group(), paths = group(), dots = group()
  const add = (m: Map<string, string[]>, c: string, d: string) => (m.get(c) ?? m.set(c, []).get(c)!).push(d)
  const drawnLines = every(lines, MAX_SHAPES)
  const drawnDots = every(locs, MAX_DOTS).slice()
  for (const e of drawnLines) {
    const s = shapeOf(e)
    // A line of one point, or a ring of two: drawn as the place it is.
    if (s.kind === 'location') drawnDots.push(e)
    if (s.kind === 'location') continue
    const cs = every(unwrap(s.coords), MAX_SHAPE_POINTS)
    const d = cs.map(([lng, lat], i) => `${i ? 'L' : 'M'}${r1(px(lng))} ${r1(py(lat))}`).join('') + (s.kind === 'area' ? 'Z' : '')
    add(s.kind === 'area' ? areas : paths, colorOf(e.tags) ?? GEO_COLORS[s.kind], d)
  }
  for (const e of drawnDots) {
    const x = px(e.data.lng), y = py(e.data.lat)
    if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue
    add(dots, colorOf(e.tags) ?? GEO_COLORS.location, `M${r1(x)} ${r1(y)}h0`)
  }
  const flat = (m: Map<string, string[]>) => [...m].map(([color, ds]) => ({ color, d: ds.join('') }))
  const n = locs.length
  return {
    tiles,
    areas: flat(areas),
    paths: flat(paths),
    dots: flat(dots),
    dotSize: n <= 30 ? 9 : n <= 300 ? 6 : n <= 3000 ? 3.5 : 2.2,
    shown: drawnDots.length + drawnLines.length,
    total: features.length,
  }
}
