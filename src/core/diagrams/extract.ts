import { emptyGeometry, type DiagramGeometry, type EdgeGeom, type Point } from './geometry'
import type { ParsedDiagram } from './model'

/**
 * Geometry from renderer output. Graphviz's JSON output and Mermaid's SVG
 * are both parsed here (pure functions over text/DOM), so the same code
 * serves the browser and tests.
 */

const PT = 72

/** Graphviz `-Tjson`: positions in points with y up; converted to y-down pixels at 1pt = 1px, with Graphviz's 4pt margin. */
export function geometryFromGraphvizJson(json: string | Record<string, unknown>, parsed: ParsedDiagram): DiagramGeometry {
  const j = (typeof json === 'string' ? JSON.parse(json) : json) as {
    bb?: string
    objects?: Record<string, unknown>[]
    edges?: Record<string, unknown>[]
  }
  const g = emptyGeometry()
  const bb = (j.bb ?? '0,0,0,0').split(',').map(Number)
  const H = bb[3]
  const pad = 4
  const fy = (y: number) => H - y + pad
  const fx = (x: number) => x + pad
  g.width = Math.ceil(bb[2] + pad * 2)
  g.height = Math.ceil(H + pad * 2)
  const byGvid = new Map<number, string>()
  const known = new Set(parsed.nodes.map((n) => n.id))
  for (const o of j.objects ?? []) {
    const name = String(o.name ?? '')
    const gvid = Number(o._gvid)
    if (typeof o.bb === 'string') {
      // A cluster.
      const [x0, y0, x1, y1] = o.bb.split(',').map(Number)
      const id = parsed.groups.find((gr) => gr.id === name)?.id ?? name
      g.groups[id] = { x: fx(x0), y: fy(y1), width: x1 - x0, height: y1 - y0, fill: colour(o.fillcolor ?? o.bgcolor), stroke: colour(o.color ?? o.pencolor) ?? '#999', label: o.lp ? point(String(o.lp), fx, fy) : undefined }
      continue
    }
    if (typeof o.pos !== 'string') continue
    byGvid.set(gvid, name)
    if (!known.has(name)) continue
    const c = point(o.pos, fx, fy)
    const style = String(o.style ?? '')
    const filled = /filled/.test(style)
    g.nodes[name] = {
      x: c.x,
      y: c.y,
      width: Number(o.width ?? 0.75) * PT,
      height: Number(o.height ?? 0.5) * PT,
      shape: normaliseShape(String(o.shape ?? 'ellipse')),
      fill: filled ? (colour(o.fillcolor) ?? colour(o.color) ?? '#d3d3d3') : '#fff',
      stroke: colour(o.color) ?? '#1f1e1b',
      strokeWidth: o.penwidth ? Number(o.penwidth) : undefined,
      dashed: /dashed|dotted/.test(style),
      color: colour(o.fontcolor),
      fontSize: o.fontsize ? Number(o.fontsize) : 14,
    }
  }
  const seen = new Map<string, number>()
  for (const e of j.edges ?? []) {
    const s = byGvid.get(Number(e.tail))
    const t = byGvid.get(Number(e.head))
    if (!s || !t) continue
    const key = `${s}|${t}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    // Match the parsed edge with the same endpoints, in order of appearance.
    const candidates = parsed.edges.filter((pe) => pe.source === s && pe.target === t)
    const pe = candidates[n] ?? candidates[0]
    if (!pe) continue
    const geom = splineFromPos(String(e.pos ?? ''), fx, fy)
    geom.stroke = colour(e.color)
    geom.strokeWidth = e.penwidth ? Number(e.penwidth) : undefined
    geom.dashed = /dashed|dotted/.test(String(e.style ?? ''))
    if (typeof e.lp === 'string') geom.label = point(e.lp, fx, fy)
    g.edges[pe.id] = geom
  }
  return g
}

function point(s: string, fx: (x: number) => number, fy: (y: number) => number): Point {
  const [x, y] = s.split(',').map(Number)
  return { x: fx(x), y: fy(y) }
}

const colour = (v: unknown): string | undefined => (typeof v === 'string' && v && v !== 'transparent' && v !== 'none' ? v : undefined)

function normaliseShape(s: string): string {
  if (s === 'ellipse' || s === 'oval' || s === 'circle' || s === 'doublecircle' || s === 'point') return s === 'circle' || s === 'doublecircle' || s === 'point' ? 'circle' : 'ellipse'
  if (s === 'diamond' || s === 'Mdiamond') return 'diamond'
  if (s === 'hexagon' || s === 'octagon') return 'hexagon'
  if (s === 'triangle') return 'triangle'
  if (s === 'parallelogram') return 'parallelogram'
  if (s === 'note' || s === 'folder' || s === 'tab' || s === 'cylinder') return s
  if (s === 'plaintext' || s === 'plain' || s === 'none') return 'text'
  return 'box'
}

/** Graphviz `pos` for an edge: optional `e,x,y` / `s,x,y` arrow tips, then a cubic B-spline (p0 then triples). */
export function splineFromPos(pos: string, fx: (x: number) => number = (x) => x, fy: (y: number) => number = (y) => y): EdgeGeom {
  const toks = pos.trim().split(/\s+/).filter(Boolean)
  let end: Point | undefined
  let start: Point | undefined
  const pts: Point[] = []
  for (const t of toks) {
    if (t.startsWith('e,')) end = point(t.slice(2), fx, fy)
    else if (t.startsWith('s,')) start = point(t.slice(2), fx, fy)
    else pts.push(point(t, fx, fy))
  }
  const geom: EdgeGeom = { points: pts, curve: 'bezier', arrowEnd: !!end, arrowStart: !!start }
  // Arrow tips extend the curve with a straight final segment: add as a degenerate cubic so the path stays one shape.
  if (end && pts.length) {
    const last = pts[pts.length - 1]
    geom.points = [...pts, last, end, end]
  }
  if (start && geom.points.length) {
    const first = geom.points[0]
    geom.points = [start, start, first, ...geom.points]
  }
  if ((geom.points.length - 1) % 3 !== 0) geom.curve = 'poly'
  return geom
}

/**
 * Mermaid's rendered SVG (flowcharts and the other dagre-based kinds):
 * node groups carry `translate(x,y)` and a shape; edges are `path`s whose
 * ids name their endpoints; clusters carry a rect.
 */
export function geometryFromMermaidSvg(doc: Document, parsed: ParsedDiagram): DiagramGeometry {
  const g = emptyGeometry()
  const root = doc.documentElement
  const vb = (root.getAttribute('viewBox') ?? '0 0 0 0').split(/[\s,]+/).map(Number)
  const [vx, vy, vw, vh] = vb
  g.width = Math.ceil(vw + vx)
  g.height = Math.ceil(vh + vy)
  const known = new Map(parsed.nodes.map((n) => [n.id, n] as const))
  const translate = (el: Element | null): Point => {
    const m = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/.exec(el?.getAttribute('transform') ?? '')
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }
  }
  const nodeIdFrom = (svgId: string): string | undefined => {
    // `<prefix>-flowchart-<id>-<n>` (flowchart), `<prefix>-state-<id>-<n>`, `classId-<id>-<n>`, `entity-<id>-<n>`.
    const m = /(?:flowchart|state|classId|entity|class)-(.+)-\d+$/.exec(svgId)
    if (m && known.has(m[1])) return m[1]
    for (const id of known.keys()) if (svgId.endsWith(`-${id}`) || svgId.includes(`-${id}-`)) return id
    return undefined
  }
  for (const el of Array.from(doc.querySelectorAll('g.node'))) {
    const id = nodeIdFrom(el.id)
    if (!id) continue
    const c = translate(el)
    const shape = el.querySelector('rect, polygon, circle, ellipse, path')
    let width = 0
    let height = 0
    let kind = 'box'
    if (shape?.tagName === 'rect') {
      width = Number(shape.getAttribute('width') ?? 0)
      height = Number(shape.getAttribute('height') ?? 0)
      kind = Number(shape.getAttribute('rx') ?? 0) > 0 ? 'rounded' : 'box'
    } else if (shape?.tagName === 'circle') {
      width = height = Number(shape.getAttribute('r') ?? 0) * 2
      kind = 'circle'
    } else if (shape?.tagName === 'ellipse') {
      width = Number(shape.getAttribute('rx') ?? 0) * 2
      height = Number(shape.getAttribute('ry') ?? 0) * 2
      kind = 'ellipse'
    } else if (shape?.tagName === 'polygon') {
      const pts = (shape.getAttribute('points') ?? '').trim().split(/\s+/).map((p) => p.split(',').map(Number))
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      width = Math.max(...xs) - Math.min(...xs)
      height = Math.max(...ys) - Math.min(...ys)
      kind = pts.length === 4 ? 'diamond' : pts.length === 6 ? 'hexagon' : pts.length === 3 ? 'triangle' : 'parallelogram'
    } else if (shape?.tagName === 'path') {
      const bb = pathBounds(shape.getAttribute('d') ?? '')
      width = bb.width
      height = bb.height
      kind = known.get(id)?.shape ?? 'box'
    }
    const style = shape?.getAttribute('style') ?? ''
    const fill = /fill:\s*([^;!]+)/.exec(style)?.[1]?.trim()
    const stroke = /stroke:\s*([^;!]+)/.exec(style)?.[1]?.trim()
    g.nodes[id] = { x: c.x, y: c.y, width, height, shape: kind, fill: fill || '#ECECFF', stroke: stroke || '#9370DB', fontSize: 14 }
  }
  // Edges: `L_<A>_<B>_<n>` or `L-<A>-<B>-<n>`; fall back to order.
  const paths = Array.from(doc.querySelectorAll('path.flowchart-link, path.edgePath, g.edgePaths path, path.transition, path.relation'))
  // Edge labels aren't emitted in edge order; pair them by text, each used once.
  const labels = Array.from(doc.querySelectorAll('g.edgeLabel')).map((el) => ({ el, text: el.textContent?.trim() ?? '', used: false }))
  const seen = new Map<string, number>()
  paths.forEach((p, i) => {
    const d = p.getAttribute('d') ?? ''
    const m = /L[_-](.+?)[_-](.+?)[_-]\d+$/.exec(p.id)
    let pe = parsed.edges[i]
    if (m) {
      const key = `${m[1]}|${m[2]}`
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      const c = parsed.edges.filter((e) => e.source === m[1] && e.target === m[2])
      pe = c[n] ?? c[0] ?? pe
    }
    if (!pe) return
    const geom = pathToGeom(d)
    geom.arrowEnd = !!p.getAttribute('marker-end') || pe.directed
    geom.dashed = /pattern-dotted|pattern-dashed/.test(p.getAttribute('class') ?? '')
    if (pe.label) {
      const want = pe.label.trim()
      const lbl = labels.find((l) => !l.used && l.text === want) ?? labels.find((l) => !l.used && l.text && want.startsWith(l.text))
      if (lbl) {
        lbl.used = true
        geom.label = translate(lbl.el)
      }
    }
    g.edges[pe.id] = geom
  })
  for (const cl of Array.from(doc.querySelectorAll('g.cluster'))) {
    const rect = cl.querySelector('rect')
    if (!rect) continue
    const id = parsed.groups.find((gr) => cl.id.endsWith(`-${gr.id}`) || cl.id === gr.id)?.id
    if (!id) continue
    g.groups[id] = { x: Number(rect.getAttribute('x') ?? 0), y: Number(rect.getAttribute('y') ?? 0), width: Number(rect.getAttribute('width') ?? 0), height: Number(rect.getAttribute('height') ?? 0), fill: '#ffffde', stroke: '#aaaa33', label: translate(cl.querySelector('.cluster-label')) }
  }
  return g
}

/** SVG path data (M/L/C/Q absolute, as renderers emit) → an edge route. */
export function pathToGeom(d: string): EdgeGeom {
  const toks = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const pts: Point[] = []
  let cmd = ''
  let i = 0
  let cubic = true
  const num = () => Number(toks[i++])
  while (i < toks.length) {
    const t = toks[i]
    // A command is one letter; a number in scientific notation (`1e-5`) has a letter too and is not one.
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t
      i++
      continue
    }
    if (cmd === 'M' || cmd === 'L') {
      pts.push({ x: num(), y: num() })
      if (cmd === 'L' && pts.length > 1) cubic = false
    } else if (cmd === 'C') {
      pts.push({ x: num(), y: num() }, { x: num(), y: num() }, { x: num(), y: num() })
    } else if (cmd === 'Q') {
      // Elevate the quadratic to a cubic so one curve type serves.
      const p0 = pts[pts.length - 1]
      const c = { x: num(), y: num() }
      const p1 = { x: num(), y: num() }
      pts.push({ x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) }, { x: p1.x + (2 / 3) * (c.x - p1.x), y: p1.y + (2 / 3) * (c.y - p1.y) }, p1)
    } else i++
  }
  const allLines = !cubic || (pts.length - 1) % 3 !== 0
  return { points: pts, curve: allLines ? (pts.length > 2 ? 'poly' : 'line') : 'bezier' }
}

function pathBounds(d: string): { width: number; height: number } {
  const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
  const xs = nums.filter((_, i) => i % 2 === 0)
  const ys = nums.filter((_, i) => i % 2 === 1)
  return { width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0, height: ys.length ? Math.max(...ys) - Math.min(...ys) : 0 }
}
