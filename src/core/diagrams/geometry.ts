import { cssColor } from '../../lib/cssColor'

/**
 * 2D geometry captured from a rendered diagram, in scene pixels with y down.
 * Enough to redraw the diagram one-to-one without the source renderer:
 * where every node sits and how big it is, the route every edge takes,
 * the boxes groups occupy, and the colours the source gave them.
 */

export interface Point {
  x: number
  y: number
}

export interface NodeGeom {
  /** Centre. */
  x: number
  y: number
  width: number
  height: number
  /** box | ellipse | circle | diamond | hexagon | cylinder | note | text | … (source's word). */
  shape?: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  dashed?: boolean
  /** Text colour and size, when the source set them. */
  color?: string
  fontSize?: number
  rotation?: number
  /** The source states this position itself (Excalidraw, a DOT `pos` with `!`), as opposed to a renderer having chosen it. */
  pinned?: boolean
}

export interface EdgeGeom {
  /** Route. `bezier`: p0 then cubic triples (Graphviz splines); `poly`: straight segments; `line`: endpoints only. */
  points: Point[]
  curve: 'line' | 'poly' | 'bezier'
  stroke?: string
  strokeWidth?: number
  dashed?: boolean
  arrowStart?: boolean
  arrowEnd?: boolean
  /** Where the label sits, when the source placed one. */
  label?: Point
}

export interface GroupGeom {
  /** Top-left. */
  x: number
  y: number
  width: number
  height: number
  fill?: string
  stroke?: string
  label?: Point
}

export interface DiagramGeometry {
  width: number
  height: number
  background?: string
  nodes: Record<string, NodeGeom>
  edges: Record<string, EdgeGeom>
  groups: Record<string, GroupGeom>
}

export const emptyGeometry = (): DiagramGeometry => ({ width: 0, height: 0, nodes: {}, edges: {}, groups: {} })

/** SVG path data for an edge route. */
export function edgePath(g: EdgeGeom): string {
  const p = g.points
  if (p.length === 0) return ''
  if (p.length === 1) return `M${p[0].x} ${p[0].y}`
  if (g.curve === 'bezier' && (p.length - 1) % 3 === 0) {
    let d = `M${p[0].x} ${p[0].y}`
    for (let i = 1; i + 2 < p.length; i += 3) d += ` C${p[i].x} ${p[i].y} ${p[i + 1].x} ${p[i + 1].y} ${p[i + 2].x} ${p[i + 2].y}`
    return d
  }
  return `M${p[0].x} ${p[0].y}` + p.slice(1).map((q) => ` L${q.x} ${q.y}`).join('')
}

/**
 * A route as a drawable polyline. Graphviz splines (`bezier`) are sampled
 * along each cubic so the points lie on the curve; `poly` and `line`
 * routes are returned as they are.
 */
export function flattenRoute(g: EdgeGeom, perSegment = 6): Point[] {
  const p = g.points
  if (g.curve !== 'bezier' || p.length < 4 || (p.length - 1) % 3 !== 0) return p
  const out: Point[] = [p[0]]
  for (let i = 1; i + 2 < p.length; i += 3) {
    const [a, b, c, d] = [out[out.length - 1], p[i], p[i + 1], p[i + 2]]
    // A degenerate cubic (an arrow tip written as a straight tail) needs no samples.
    const straight = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 0.5 && Math.abs(c.x - d.x) + Math.abs(c.y - d.y) < 0.5
    const n = straight ? 1 : perSegment
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      out.push({ x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y })
    }
  }
  return out
}

/**
 * An orthogonal route between two boxes, for drawings with no renderer
 * geometry: leaves the source's side facing the target, runs a straight
 * spine between the boxes and enters the target square-on. When the
 * boxes overlap on both axes it degrades to a straight line.
 */
export function elbowRoute(a: NodeGeom, b: NodeGeom): Point[] {
  const ax0 = a.x - a.width / 2
  const ax1 = a.x + a.width / 2
  const ay0 = a.y - a.height / 2
  const ay1 = a.y + a.height / 2
  const bx0 = b.x - b.width / 2
  const bx1 = b.x + b.width / 2
  const by0 = b.y - b.height / 2
  const by1 = b.y + b.height / 2
  const gapX = bx0 > ax1 ? bx0 - ax1 : ax0 > bx1 ? ax0 - bx1 : -1
  const gapY = by0 > ay1 ? by0 - ay1 : ay0 > by1 ? ay0 - by1 : -1
  if (gapX < 0 && gapY < 0) return straightRoute(a, b)
  if (gapX >= gapY) {
    // Leave left/right, spine vertical in the gap between the boxes.
    const sx = bx0 > ax1 ? ax1 : ax0
    const tx = bx0 > ax1 ? bx0 : bx1
    const mx = (sx + tx) / 2
    return a.y === b.y ? [{ x: sx, y: a.y }, { x: tx, y: b.y }] : [{ x: sx, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: tx, y: b.y }]
  }
  const sy = by0 > ay1 ? ay1 : ay0
  const ty = by0 > ay1 ? by0 : by1
  const my = (sy + ty) / 2
  return a.x === b.x ? [{ x: a.x, y: sy }, { x: b.x, y: ty }] : [{ x: a.x, y: sy }, { x: a.x, y: my }, { x: b.x, y: my }, { x: b.x, y: ty }]
}

/** Where a point sits on a box, as Excalidraw's binding `fixedPoint` (0..1 across width and height). */
export function fixedPointOn(n: NodeGeom, p: Point): [number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return [clamp((p.x - (n.x - n.width / 2)) / n.width), clamp((p.y - (n.y - n.height / 2)) / n.height)]
}

/** A straight route between two node centres, trimmed to their boxes so arrowheads land on the border. */
export function straightRoute(a: NodeGeom, b: NodeGeom): Point[] {
  const s = borderPoint(a, b)
  const t = borderPoint(b, a)
  return [s, t]
}

/** Where the segment from `from`'s centre toward `to` leaves `from`'s bounding shape. */
export function borderPoint(from: NodeGeom, to: NodeGeom): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y }
  const hw = from.width / 2
  const hh = from.height / 2
  if (from.shape === 'ellipse' || from.shape === 'circle') {
    const ang = Math.atan2(dy, dx)
    return { x: from.x + hw * Math.cos(ang), y: from.y + hh * Math.sin(ang) }
  }
  if (from.shape === 'diamond') {
    const k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
    return { x: from.x + dx * k, y: from.y + dy * k }
  }
  const k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9))
  return { x: from.x + dx * k, y: from.y + dy * k }
}

/** Bounding box of everything, with padding. */
export function geometryBounds(g: DiagramGeometry, pad = 24): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  for (const n of Object.values(g.nodes)) {
    add(n.x - n.width / 2, n.y - n.height / 2)
    add(n.x + n.width / 2, n.y + n.height / 2)
  }
  for (const e of Object.values(g.edges)) for (const p of e.points) add(p.x, p.y)
  for (const gr of Object.values(g.groups)) {
    add(gr.x, gr.y)
    add(gr.x + gr.width, gr.y + gr.height)
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: g.width || 400, height: g.height || 300 }
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 }
}

/** Translate every coordinate. */
export function shiftGeometry(g: DiagramGeometry, dx: number, dy: number): DiagramGeometry {
  const out = emptyGeometry()
  out.width = g.width
  out.height = g.height
  out.background = g.background
  for (const [k, n] of Object.entries(g.nodes)) out.nodes[k] = { ...n, x: n.x + dx, y: n.y + dy }
  for (const [k, e] of Object.entries(g.edges)) out.edges[k] = { ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), label: e.label ? { x: e.label.x + dx, y: e.label.y + dy } : undefined }
  for (const [k, gr] of Object.entries(g.groups)) out.groups[k] = { ...gr, x: gr.x + dx, y: gr.y + dy, label: gr.label ? { x: gr.label.x + dx, y: gr.label.y + dy } : undefined }
  return out
}

/** Points along the polygon outline of a shape, centred on the node — for the static renderer and hit tests. */
export function shapeOutline(n: NodeGeom): string | null {
  const hw = n.width / 2
  const hh = n.height / 2
  switch (n.shape) {
    case 'diamond':
      return `${n.x},${n.y - hh} ${n.x + hw},${n.y} ${n.x},${n.y + hh} ${n.x - hw},${n.y}`
    case 'hexagon':
      return `${n.x - hw * 0.5},${n.y - hh} ${n.x + hw * 0.5},${n.y - hh} ${n.x + hw},${n.y} ${n.x + hw * 0.5},${n.y + hh} ${n.x - hw * 0.5},${n.y + hh} ${n.x - hw},${n.y}`
    case 'triangle':
      return `${n.x},${n.y - hh} ${n.x + hw},${n.y + hh} ${n.x - hw},${n.y + hh}`
    case 'parallelogram':
      return `${n.x - hw + hw * 0.3},${n.y - hh} ${n.x + hw},${n.y - hh} ${n.x + hw - hw * 0.3},${n.y + hh} ${n.x - hw},${n.y + hh}`
    default:
      return null
  }
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A number as it may be written into markup: finite, else the fallback. */
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const pt = (p: unknown): Point => ({ x: num((p as Point | undefined)?.x), y: num((p as Point | undefined)?.y) })
const optPt = (p: unknown): Point | undefined => (p && typeof p === 'object' ? pt(p) : undefined)

/**
 * The geometry with every number it is drawn with a finite number. Geometry comes from a file (an Excalidraw
 * drawing, a stored scene), and `geometryToSvg` writes its numbers into markup: a string where a number belongs
 * (`"strokeWidth": "1\"/><style>…"`) would be markup of its own.
 */
function finiteGeometry(g: DiagramGeometry): DiagramGeometry {
  const out: DiagramGeometry = { width: num(g.width), height: num(g.height), background: g.background, nodes: {}, edges: {}, groups: {} }
  for (const [k, n] of Object.entries(g.nodes ?? {})) out.nodes[k] = { ...n, x: num(n.x), y: num(n.y), width: num(n.width), height: num(n.height), strokeWidth: optNum(n.strokeWidth), fontSize: optNum(n.fontSize), rotation: optNum(n.rotation) }
  for (const [k, e] of Object.entries(g.edges ?? {})) out.edges[k] = { ...e, points: Array.isArray(e.points) ? e.points.map(pt) : [], strokeWidth: optNum(e.strokeWidth), label: optPt(e.label) }
  for (const [k, gr] of Object.entries(g.groups ?? {})) out.groups[k] = { ...gr, x: num(gr.x), y: num(gr.y), width: num(gr.width), height: num(gr.height), label: optPt(gr.label) }
  return out
}

/**
 * A plain SVG of the geometry — flat vector, no renderer: used for
 * Excalidraw previews and as the reference layer on the Scenes page.
 * Every number is made finite and every string escaped before it is
 * written (`finiteGeometry`); the picture is sanitised after, like any other.
 */
export function geometryToSvg(geometry: DiagramGeometry, labels: { nodes?: Record<string, string>; edges?: Record<string, string>; groups?: Record<string, string> } = {}): string {
  const g = finiteGeometry(geometry)
  const b = geometryBounds(g)
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" width="${b.width}" height="${b.height}" font-family="system-ui, sans-serif">`)
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>`)
  if (g.background) parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${esc(cssColor(g.background, '#fff'))}"/>`)
  for (const [id, gr] of Object.entries(g.groups)) {
    parts.push(`<rect x="${gr.x}" y="${gr.y}" width="${gr.width}" height="${gr.height}" rx="4" fill="${esc(cssColor(gr.fill, 'none'))}" stroke="${esc(cssColor(gr.stroke, '#999'))}"/>`)
    const l = labels.groups?.[id]
    if (l) parts.push(`<text x="${gr.label?.x ?? gr.x + 8}" y="${gr.label?.y ?? gr.y + 16}" font-size="12" fill="#555">${esc(l)}</text>`)
  }
  for (const [id, e] of Object.entries(g.edges)) {
    const stroke = esc(cssColor(e.stroke, '#333'))
    parts.push(`<path d="${edgePath(e)}" fill="none" stroke="${stroke}" stroke-width="${e.strokeWidth ?? 1.5}"${e.dashed ? ' stroke-dasharray="6 4"' : ''}${e.arrowEnd ? ' marker-end="url(#arrow)"' : ''}${e.arrowStart ? ' marker-start="url(#arrow)"' : ''}/>`)
    const l = labels.edges?.[id]
    if (l && e.label) parts.push(`<text x="${e.label.x}" y="${e.label.y}" font-size="11" text-anchor="middle" fill="${stroke}">${esc(l)}</text>`)
  }
  for (const [id, n] of Object.entries(g.nodes)) {
    const fill = esc(cssColor(n.fill, '#fff'))
    const stroke = esc(cssColor(n.stroke, '#333'))
    const sw = n.strokeWidth ?? 1.5
    const dash = n.dashed ? ' stroke-dasharray="6 4"' : ''
    const rot = n.rotation ? ` transform="rotate(${(n.rotation * 180) / Math.PI} ${n.x} ${n.y})"` : ''
    const outline = shapeOutline(n)
    if (n.shape === 'text') {
      /* label only */
    } else if (n.shape === 'ellipse' || n.shape === 'circle') parts.push(`<ellipse cx="${n.x}" cy="${n.y}" rx="${n.width / 2}" ry="${n.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${rot}/>`)
    else if (outline) parts.push(`<polygon points="${outline}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${rot}/>`)
    else parts.push(`<rect x="${n.x - n.width / 2}" y="${n.y - n.height / 2}" width="${n.width}" height="${n.height}" rx="${n.shape === 'rounded' ? 8 : 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}${rot}/>`)
    const l = labels.nodes?.[id]
    if (l) {
      const lines = String(l).split('\n')
      const fs = n.fontSize ?? 13
      const y0 = n.y - ((lines.length - 1) * fs * 1.2) / 2
      parts.push(`<text x="${n.x}" y="${y0}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="${esc(cssColor(n.color, '#1f1e1b'))}"${rot}>${lines.map((ln, i) => `<tspan x="${n.x}" dy="${i === 0 ? 0 : fs * 1.2}">${esc(ln)}</tspan>`).join('')}</text>`)
    }
  }
  parts.push('</svg>')
  return parts.join('')
}
