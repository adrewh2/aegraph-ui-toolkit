import { autoLayout } from './layout'
import { elbowRoute, emptyGeometry, fixedPointOn, flattenRoute, type DiagramGeometry, type EdgeGeom, type NodeGeom, type Point } from './geometry'
import { type DEdge, type DGroup, type DNode, type ParsedDiagram } from './model'

/**
 * Excalidraw files (`.excalidraw`, JSON). Shapes with bound text become
 * nodes, arrows bound at both ends become edges, frames become groups.
 * Everything carries its geometry, so the import is one-to-one.
 */

interface XElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  roundness?: unknown
  isDeleted?: boolean
  groupIds?: string[]
  frameId?: string | null
  boundElements?: { id: string; type: string }[] | null
  /** Excalidraw's free-form slot; the writer keeps the source shape word here (a `cylinder` is drawn as a rectangle). */
  customData?: Record<string, unknown> | null
  containerId?: string | null
  text?: string
  originalText?: string
  fontSize?: number
  points?: [number, number][]
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  name?: string
  link?: string | null
  version?: number
  [extra: string]: unknown
}

export interface ExcalidrawFile {
  type: 'excalidraw'
  version?: number
  source?: string
  elements: XElement[]
  appState?: { viewBackgroundColor?: string; gridSize?: number | null }
  files?: Record<string, unknown>
}

export const isExcalidraw = (data: unknown): data is ExcalidrawFile => !!data && typeof data === 'object' && (data as { type?: unknown }).type === 'excalidraw' && Array.isArray((data as { elements?: unknown }).elements)

const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image'])
const shapeOf = (t: string) => (t === 'ellipse' ? 'ellipse' : t === 'diamond' ? 'diamond' : 'box')
/** The element a shape word is drawn as, in `shapeOf` terms. */
const drawnAs = (shape: string) => {
  const s = shape.toLowerCase()
  return s === 'ellipse' || s === 'circle' || s === 'oval' || s === 'doublecircle' || s === 'double-circle' ? 'ellipse' : s === 'diamond' || s === 'mdiamond' ? 'diamond' : 'box'
}
const colour = (c: string | undefined) => (c && c !== 'transparent' ? c : undefined)

/** A finite number, or the fallback: a drawing's numbers are data, and they are written into markup. */
const finite = <T,>(v: unknown, fallback: T): number | T => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * An element with every number it is drawn with made a finite number: `x`, `y`, `width`, `height` (0 when missing
 * or not a number), `angle`, `strokeWidth`, `fontSize` (dropped when not a number), and `points` (pairs that are
 * not two numbers dropped). A file is data — `"strokeWidth": "1\"/><style>…"` is a string Excalidraw would
 * never write, and the picture is drawn from these.
 */
function withFiniteNumbers(e: XElement): XElement {
  return {
    ...e,
    id: String(e.id),
    type: String(e.type),
    x: finite(e.x, 0),
    y: finite(e.y, 0),
    width: finite(e.width, 0),
    height: finite(e.height, 0),
    angle: finite(e.angle, undefined),
    strokeWidth: finite(e.strokeWidth, undefined),
    fontSize: finite(e.fontSize, undefined),
    points: Array.isArray(e.points) ? e.points.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([px, py]) => [px, py]) : undefined,
  }
}

export function parseExcalidraw(src: string | ExcalidrawFile): ParsedDiagram {
  const file: ExcalidrawFile = typeof src === 'string' ? JSON.parse(src) : src
  if (!isExcalidraw(file)) throw new Error('Not an Excalidraw file (expected {"type":"excalidraw","elements":[…]}).')
  const els = file.elements.filter((e) => !!e && typeof e === 'object' && !e.isDeleted).map(withFiniteNumbers)
  const byId = new Map(els.map((e) => [e.id, e]))
  const d: ParsedDiagram = { format: 'excalidraw', kind: 'excalidraw', attrs: {}, nodes: [], edges: [], groups: [], warnings: [] }
  const g = emptyGeometry()
  g.background = file.appState?.viewBackgroundColor && file.appState.viewBackgroundColor !== '#ffffff' ? file.appState.viewBackgroundColor : undefined

  // Text bound to a container labels it; unbound text is a node of its own.
  const labelOf = (e: XElement): { text: string; color?: string; fontSize?: number } | undefined => {
    const t = e.boundElements?.find((b) => b.type === 'text')
    const te = t ? byId.get(t.id) : undefined
    if (!te) return undefined
    return { text: (te.originalText ?? te.text ?? '').trim(), color: colour(te.strokeColor), fontSize: te.fontSize }
  }

  // Frames → groups.
  for (const e of els) {
    if (e.type !== 'frame' && e.type !== 'magicframe') continue
    const grp: DGroup = { id: e.id, label: e.name?.trim() || 'Frame', attrs: {} }
    d.groups.push(grp)
    g.groups[e.id] = { x: e.x, y: e.y, width: e.width, height: e.height, stroke: colour(e.strokeColor) ?? '#bbb', label: { x: e.x + 6, y: e.y - 6 } }
  }

  const frames = els.filter((e) => e.type === 'frame' || e.type === 'magicframe')
  // Frame membership: the explicit `frameId`, else the frame whose box contains the element's centre.
  const frameOf = (e: XElement): string | undefined => {
    if (e.frameId && byId.has(e.frameId)) return e.frameId
    const cx = e.x + e.width / 2
    const cy = e.y + e.height / 2
    return frames.find((f) => cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height)?.id
  }

  // Shapes → nodes.
  for (const e of els) {
    const isShape = NODE_TYPES.has(e.type)
    const isFreeText = e.type === 'text' && !e.containerId
    if (!isShape && !isFreeText) continue
    const label = isShape ? labelOf(e) : { text: (e.originalText ?? e.text ?? '').trim(), color: colour(e.strokeColor), fontSize: e.fontSize }
    // A shape Excalidraw cannot draw (cylinder, hexagon, …) was drawn as its nearest element and the
    // original word kept in customData; it comes back as long as the element is still that type.
    const kept = typeof e.customData?.shape === 'string' ? (e.customData.shape as string) : undefined
    const node: DNode = {
      id: e.id,
      label: label?.text || (isShape ? '' : ''),
      shape: isFreeText ? 'text' : kept && shapeOf(e.type) === drawnAs(kept) ? kept : shapeOf(e.type),
      group: frameOf(e),
      classes: e.groupIds?.length ? [`group:${e.groupIds[0]}`] : [],
      attrs: {},
    }
    if (e.link) node.attrs.link = e.link
    if (colour(e.backgroundColor)) node.attrs.fillcolor = e.backgroundColor!
    if (colour(e.strokeColor)) node.attrs.color = e.strokeColor!
    d.nodes.push(node)
    const geom: NodeGeom = {
      x: e.x + e.width / 2,
      y: e.y + e.height / 2,
      width: e.width,
      height: e.height,
      shape: node.shape,
      fill: isFreeText ? undefined : (colour(e.backgroundColor) ?? '#fff'),
      stroke: isFreeText ? undefined : (colour(e.strokeColor) ?? '#1e1e1e'),
      strokeWidth: e.strokeWidth,
      dashed: e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted',
      color: label?.color,
      fontSize: label?.fontSize,
      rotation: e.angle || undefined,
      // A drawing's positions are the user's own.
      pinned: true,
    }
    if (e.roundness && node.shape === 'box') geom.shape = 'rounded'
    g.nodes[e.id] = geom
  }
  const nodeIds = new Set(d.nodes.map((n) => n.id))

  // Arrows bound at both ends → edges; lines and loose arrows are decoration.
  let loose = 0
  for (const e of els) {
    if (e.type !== 'arrow' && e.type !== 'line') continue
    const s = e.startBinding?.elementId
    const t = e.endBinding?.elementId
    if (!s || !t || !nodeIds.has(s) || !nodeIds.has(t)) {
      loose++
      continue
    }
    const label = labelOf(e)
    const edge: DEdge = { id: e.id, source: s, target: t, label: label?.text || undefined, directed: e.type === 'arrow' && e.endArrowhead !== null, style: e.strokeStyle && e.strokeStyle !== 'solid' ? 'dotted' : undefined, attrs: {} }
    d.edges.push(edge)
    const pts: Point[] = (e.points ?? [[0, 0]]).map(([px, py]) => ({ x: e.x + px, y: e.y + py }))
    const geom: EdgeGeom = {
      points: pts,
      curve: pts.length > 2 ? 'poly' : 'line',
      stroke: colour(e.strokeColor),
      strokeWidth: e.strokeWidth,
      dashed: e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted',
      arrowStart: !!e.startArrowhead,
      arrowEnd: e.type === 'arrow' ? e.endArrowhead !== null : !!e.endArrowhead,
    }
    if (label) {
      const mid = pts[Math.floor(pts.length / 2)]
      geom.label = pts.length % 2 === 0 ? { x: (pts[pts.length / 2 - 1].x + mid.x) / 2, y: (pts[pts.length / 2 - 1].y + mid.y) / 2 - 8 } : { x: mid.x, y: mid.y - 8 }
    }
    g.edges[e.id] = geom
  }
  if (loose) d.warnings.push(`${loose} arrow${loose === 1 ? '' : 's'}/line${loose === 1 ? '' : 's'} not attached at both ends ${loose === 1 ? 'is' : 'are'} not part of the graph (kept in the drawing).`)
  const skipped = els.filter((e) => e.type === 'freedraw').length
  if (skipped) d.warnings.push(`${skipped} freehand stroke${skipped === 1 ? '' : 's'} ${skipped === 1 ? 'is' : 'are'} not part of the graph (kept in the drawing).`)

  // Canvas size from content.
  let x1 = 0
  let y1 = 0
  for (const n of Object.values(g.nodes)) {
    x1 = Math.max(x1, n.x + n.width / 2)
    y1 = Math.max(y1, n.y + n.height / 2)
  }
  g.width = Math.ceil(x1 + 40)
  g.height = Math.ceil(y1 + 40)
  d.geometry = g
  return d
}

let seq = 0
const xid = () => `ae${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`

export interface ExcalidrawWriteOptions {
  /**
   * The drawing as it was last: every element that still corresponds to a
   * node, edge or group is reused — its style, its text element, its seed
   * — with only what the diagram changed (label, and position when the
   * diagram pins one) updated; elements the diagram never modelled
   * (freehand, loose lines and text, images) are kept as they were.
   */
  previous?: string | ExcalidrawFile
}

/**
 * Write a diagram as an Excalidraw file. Nodes without geometry are laid
 * out; with `previous`, the file is the old drawing brought up to date
 * rather than a new one.
 */
export function writeExcalidraw(d: ParsedDiagram, opts: ExcalidrawWriteOptions = {}): string {
  const els: Record<string, unknown>[] = []
  let prevFile: ExcalidrawFile | undefined
  try {
    prevFile = opts.previous ? (typeof opts.previous === 'string' ? (JSON.parse(opts.previous) as ExcalidrawFile) : opts.previous) : undefined
    if (prevFile && !isExcalidraw(prevFile)) prevFile = undefined
  } catch {
    prevFile = undefined
  }
  const prev = new Map<string, XElement>((prevFile?.elements ?? []).filter((e) => !e.isDeleted).map((e) => [e.id, e]))
  const prevText = (owner: XElement | undefined) => {
    const ref = owner?.boundElements?.find((b) => b.type === 'text')
    return ref ? prev.get(ref.id) : undefined
  }
  const nodeIds = new Set(d.nodes.map((n) => n.id))
  const edgeIds = new Set(d.edges.map((e) => e.id))
  const groupIds = new Set(d.groups.map((x) => x.id))
  const used = new Set<string>()
  // Placement: the diagram's own geometry where pinned, else where the old drawing had it, else a fresh layout for what is new.
  const layout = d.geometry ?? autoLayout(d)
  const g: DiagramGeometry = { ...layout, nodes: { ...layout.nodes }, groups: { ...layout.groups }, edges: { ...layout.edges } }
  for (const n of d.nodes) {
    const own = d.geometry?.nodes[n.id]
    const old = prev.get(n.id)
    if (own?.pinned || !old) continue
    g.nodes[n.id] = { ...(g.nodes[n.id] ?? own ?? { width: old.width, height: old.height }), x: old.x + old.width / 2, y: old.y + old.height / 2, width: old.width, height: old.height }
  }
  for (const e of d.edges) {
    const old = prev.get(e.id)
    const endsMoved = [e.source, e.target].some((id) => d.geometry?.nodes[id]?.pinned && prev.get(id) && (Math.abs(prev.get(id)!.x + prev.get(id)!.width / 2 - g.nodes[id].x) > 0.5 || Math.abs(prev.get(id)!.y + prev.get(id)!.height / 2 - g.nodes[id].y) > 0.5))
    // An old arrow keeps its route unless an end moved; then the writer draws it straight again.
    if (old?.points && !endsMoved) g.edges[e.id] = { points: (old.points as [number, number][]).map(([px, py]) => ({ x: old.x + px, y: old.y + py })), curve: old.points.length > 2 ? 'poly' : 'line' }
    else if (endsMoved) delete g.edges[e.id]
  }
  for (const grp of d.groups) {
    // A frame the user has is theirs; a renderer's cluster box only places frames the drawing never had.
    const old = prev.get(grp.id)
    if (old) g.groups[grp.id] = { x: old.x, y: old.y, width: old.width, height: old.height, stroke: colour(old.strokeColor) }
  }
  const centre = new Map<string, Point>()
  const frameOf = (groupId: string | undefined) => (groupId && g.groups[groupId] ? groupId : null)
  const base = { version: 2, versionNonce: 1, isDeleted: false, groupIds: [], frameId: null, roundness: null, seed: 1, updated: Date.now(), locked: false, angle: 0, opacity: 100, fillStyle: 'solid', strokeStyle: 'solid', strokeWidth: 1, link: null }
  const textBox = (label: string, fontSize: number) => {
    const lines = label.split('\n')
    return { width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.6, height: lines.length * fontSize * 1.25 }
  }
  /** The old element, brought up to date: same identity and style, new box and version. */
  const reuse = (old: XElement, patch: Record<string, unknown>) => {
    used.add(old.id)
    return { ...old, ...patch, version: (old.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
  }
  /** Colours the diagram states outright (a DOT `fillcolor`, a Mermaid `style`) win over what the old element had; unstated ones keep it. */
  const restyled = (n: DNode, old: XElement): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const fill = n.attrs.fillcolor
    const stroke = n.attrs.color
    if (fill && fill !== old.backgroundColor) out.backgroundColor = fill
    if (stroke && stroke !== old.strokeColor) out.strokeColor = stroke
    const dashed = /dashed|dotted/.test(n.attrs.style ?? '')
    if (n.attrs.style !== undefined && dashed !== (old.strokeStyle === 'dashed' || old.strokeStyle === 'dotted')) out.strokeStyle = dashed ? 'dashed' : 'solid'
    return out
  }
  d.nodes.forEach((n, i) => {
    const geom = g.nodes[n.id]
    const old = prev.get(n.id)
    const width = geom?.width ?? Math.max(120, n.label.length * 8 + 32)
    const height = geom?.height ?? 56
    const x = geom ? geom.x - width / 2 : 40 + (i % 6) * (width + 60)
    const y = geom ? geom.y - height / 2 : 40 + Math.floor(i / 6) * (height + 60)
    centre.set(n.id, { x: x + width / 2, y: y + height / 2 })
    if (old && (NODE_TYPES.has(old.type) || old.type === 'text')) {
      const oldText = prevText(old)
      if (old.type === 'text') {
        els.push(reuse(old, { x, y, text: n.label, originalText: n.label, frameId: frameOf(n.group) ?? old.frameId ?? null }))
        return
      }
      els.push(reuse(old, { x, y, width, height, frameId: frameOf(n.group) ?? old.frameId ?? null, link: n.attrs.link ?? old.link ?? null, ...(n.shape && !/^(box|rect|rectangle|rounded|ellipse|circle|oval|diamond)$/i.test(n.shape) ? { customData: { ...(old.customData ?? {}), shape: n.shape } } : {}), ...restyled(n, old) }))
      if (oldText) {
        const tb = textBox(n.label, oldText.fontSize ?? 16)
        els.push(reuse(oldText, { x: x + width / 2 - tb.width / 2, y: y + height / 2 - tb.height / 2, width: tb.width, height: tb.height, text: n.label, originalText: n.label, frameId: frameOf(n.group) ?? oldText.frameId ?? null }))
      } else if (n.label) {
        const textId = xid()
        const tb = textBox(n.label, 16)
        els[els.length - 1].boundElements = [...(((old.boundElements as { id: string; type: string }[] | null) ?? []).filter((b) => b.type !== 'text')), { id: textId, type: 'text' }]
        els.push({ ...base, id: textId, type: 'text', x: x + width / 2 - tb.width / 2, y: y + height / 2 - tb.height / 2, width: tb.width, height: tb.height, frameId: frameOf(n.group), strokeColor: '#1e1e1e', backgroundColor: 'transparent', text: n.label, originalText: n.label, fontSize: 16, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle', containerId: n.id, lineHeight: 1.25, autoResize: true })
      }
      return
    }
    const textId = xid()
    const shape = (geom?.shape ?? n.shape ?? '').toLowerCase()
    const type = shape === 'ellipse' || shape === 'circle' || shape === 'oval' || shape === 'doublecircle' || shape === 'double-circle' ? 'ellipse' : shape === 'diamond' || shape === 'mdiamond' ? 'diamond' : 'rectangle'
    const rounded = shape === 'rounded' || shape === 'stadium' || /\brounded\b/.test(n.attrs.style ?? '')
    const fontSize = geom?.fontSize ?? 16
    const frameId = frameOf(n.group)
    if (n.shape === 'text') {
      const tb = textBox(n.label, fontSize)
      els.push({ ...base, id: n.id, type: 'text', x, y, width: tb.width, height: tb.height, frameId, strokeColor: geom?.color ?? '#1e1e1e', backgroundColor: 'transparent', text: n.label, originalText: n.label, fontSize, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true })
      return
    }
    els.push({
      ...base,
      id: n.id,
      type,
      x,
      y,
      width,
      height,
      frameId,
      strokeColor: geom?.stroke ?? n.attrs.color ?? '#1e1e1e',
      backgroundColor: geom?.fill ?? n.attrs.fillcolor ?? 'transparent',
      strokeWidth: geom?.strokeWidth ?? (n.attrs.penwidth ? Number(n.attrs.penwidth) : 1),
      strokeStyle: geom?.dashed || /dashed|dotted/.test(n.attrs.style ?? '') ? 'dashed' : 'solid',
      roundness: rounded ? { type: 3 } : null,
      ...(n.shape && !/^(box|rect|rectangle|rounded|ellipse|circle|oval|diamond)$/i.test(n.shape) ? { customData: { shape: n.shape } } : {}),
      boundElements: n.label ? [{ id: textId, type: 'text' }] : [],
    })
    if (n.label) {
      const tb = textBox(n.label, fontSize)
      els.push({ ...base, id: textId, type: 'text', x: x + width / 2 - tb.width / 2, y: y + height / 2 - tb.height / 2, width: tb.width, height: tb.height, frameId, strokeColor: geom?.color ?? n.attrs.fontcolor ?? '#1e1e1e', backgroundColor: 'transparent', text: n.label, originalText: n.label, fontSize, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle', containerId: n.id, lineHeight: 1.25, autoResize: true })
    }
  })
  for (const e of d.edges) {
    const a = centre.get(e.source)
    const b = centre.get(e.target)
    if (!a || !b) continue
    const geom = g.edges[e.id]
    // How the arrow is drawn:
    //  - a renderer's spline (Graphviz) is sampled along the curve and drawn smooth, so the
    //    route that avoided other nodes survives;
    //  - a straight fallback route (no renderer, or one that failed) becomes an Excalidraw
    //    elbow arrow: an orthogonal route out of one box and square into the other, bound at
    //    fixed points so Excalidraw keeps re-routing it as nodes move;
    //  - an existing drawing's own polyline is kept as it is.
    const na = g.nodes[e.source]
    const nb = g.nodes[e.target]
    const elbow = (!geom || geom.curve === 'line') && !!na && !!nb && na !== nb
    const pts = elbow ? elbowRoute(na, nb) : geom && geom.points.length >= 2 ? flattenRoute(geom) : [a, b]
    const smooth = !elbow && geom?.curve === 'bezier' && pts.length > 2
    const x = pts[0].x
    const y = pts[0].y
    const rel: [number, number][] = pts.map((p) => [p.x - x, p.y - y])
    const bindStart = elbow ? { elementId: e.source, focus: 0, gap: 1, fixedPoint: fixedPointOn(na, pts[0]) } : { elementId: e.source, focus: 0, gap: 4 }
    const bindEnd = elbow ? { elementId: e.target, focus: 0, gap: 1, fixedPoint: fixedPointOn(nb, pts[pts.length - 1]) } : { elementId: e.target, focus: 0, gap: 4 }
    const old = prev.get(e.id)
    if (old && (old.type === 'arrow' || old.type === 'line')) {
      const oldText = prevText(old)
      const edgeStyle: Record<string, unknown> = {}
      if (e.attrs.color && e.attrs.color !== old.strokeColor) edgeStyle.strokeColor = e.attrs.color
      const dashed = e.style === 'dotted' || e.style === 'dashed'
      if (e.style !== undefined && dashed !== (old.strokeStyle === 'dashed' || old.strokeStyle === 'dotted')) edgeStyle.strokeStyle = dashed ? 'dashed' : 'solid'
      els.push(reuse(old, { x, y, points: rel, width: Math.max(...rel.map((p) => p[0])) - Math.min(...rel.map((p) => p[0])), height: Math.max(...rel.map((p) => p[1])) - Math.min(...rel.map((p) => p[1])), startBinding: { ...(old.startBinding ?? { focus: 0, gap: 4 }), elementId: e.source }, endBinding: { ...(old.endBinding ?? { focus: 0, gap: 4 }), elementId: e.target }, endArrowhead: e.directed ? (old.endArrowhead ?? 'arrow') : null, ...edgeStyle }))
      if (oldText) {
        const m = geom?.label ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const tb = textBox(e.label ?? '', oldText.fontSize ?? 14)
        if (e.label) els.push(reuse(oldText, { x: m.x - tb.width / 2, y: m.y - tb.height / 2, width: tb.width, height: tb.height, text: e.label, originalText: e.label }))
        else els[els.length - 1].boundElements = (((old.boundElements as { id: string; type: string }[] | null) ?? []).filter((b) => b.type !== 'text'))
      }
      continue
    }
    const textId = xid()
    const sourceGroup = d.nodes.find((n) => n.id === e.source)?.group
    const targetGroup = d.nodes.find((n) => n.id === e.target)?.group
    const frameId = sourceGroup && sourceGroup === targetGroup ? frameOf(sourceGroup) : null
    els.push({
      ...base,
      id: e.id,
      type: 'arrow',
      x,
      y,
      width: Math.max(...rel.map((p) => p[0])) - Math.min(...rel.map((p) => p[0])),
      height: Math.max(...rel.map((p) => p[1])) - Math.min(...rel.map((p) => p[1])),
      points: rel,
      frameId,
      strokeColor: geom?.stroke ?? e.attrs.color ?? '#1e1e1e',
      strokeWidth: geom?.strokeWidth ?? (e.attrs.penwidth ? Number(e.attrs.penwidth) : 1),
      backgroundColor: 'transparent',
      strokeStyle: e.style === 'dotted' || e.style === 'dashed' || geom?.dashed ? 'dashed' : 'solid',
      roundness: smooth ? { type: 2 } : null,
      startBinding: bindStart,
      endBinding: bindEnd,
      startArrowhead: geom?.arrowStart ? 'arrow' : null,
      endArrowhead: e.directed ? 'arrow' : null,
      elbowed: elbow,
      ...(elbow ? { fixedSegments: [], startIsSpecial: false, endIsSpecial: false } : {}),
      boundElements: e.label ? [{ id: textId, type: 'text' }] : [],
    })
    if (e.label) {
      // On an elbow route the label sits on the spine (the middle segment), not between the centres.
      const spine = pts.length >= 4 ? [pts[1], pts[2]] : [pts[0], pts[pts.length - 1]]
      const m = elbow ? { x: (spine[0].x + spine[1].x) / 2, y: (spine[0].y + spine[1].y) / 2 } : (geom?.label ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      const tb = textBox(e.label, 14)
      els.push({ ...base, id: textId, type: 'text', x: m.x - tb.width / 2, y: m.y - tb.height / 2, width: tb.width, height: tb.height, frameId, strokeColor: '#1e1e1e', backgroundColor: 'transparent', text: e.label, originalText: e.label, fontSize: 14, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle', containerId: e.id, lineHeight: 1.25, autoResize: true })
    }
  }
  // Frames come first in the file so they sit under their members.
  const frames: Record<string, unknown>[] = []
  for (const grp of d.groups) {
    const geom = g.groups[grp.id]
    if (!geom) continue
    const old = prev.get(grp.id)
    if (old && (old.type === 'frame' || old.type === 'magicframe')) frames.push(reuse(old, { x: geom.x, y: geom.y, width: geom.width, height: geom.height, name: grp.label }))
    else frames.push({ ...base, id: grp.id, type: 'frame', x: geom.x, y: geom.y, width: geom.width, height: geom.height, strokeColor: geom.stroke ?? '#bbb', backgroundColor: 'transparent', name: grp.label })
  }
  els.unshift(...frames)
  // What the diagram never modelled — freehand, images, loose text and lines — stays as it was. Elements that *were* nodes,
  // edges or frames but aren't any more go, together with the labels bound to them.
  const gone = new Set<string>()
  for (const e of prev.values()) {
    if (used.has(e.id) || nodeIds.has(e.id) || edgeIds.has(e.id) || groupIds.has(e.id)) continue
    const wasNode = NODE_TYPES.has(e.type) && !!e.boundElements
    const wasEdge = (e.type === 'arrow' || e.type === 'line') && !!e.startBinding && !!e.endBinding
    const wasFrame = e.type === 'frame' || e.type === 'magicframe'
    if (wasNode || wasEdge || wasFrame) gone.add(e.id)
  }
  for (const e of prev.values()) {
    if (used.has(e.id) || gone.has(e.id) || nodeIds.has(e.id) || edgeIds.has(e.id) || groupIds.has(e.id)) continue
    // A label whose owner was reused is already in; one whose owner is gone goes with it.
    if (e.type === 'text' && e.containerId && (gone.has(e.containerId) || used.has(e.containerId) || nodeIds.has(e.containerId) || edgeIds.has(e.containerId))) continue
    els.push({ ...e })
  }
  // Excalidraw moves an arrow with a shape only if the shape lists the arrow in its own
  // boundElements — the binding on the arrow alone is not enough. Register every edge on
  // both of its endpoints (and drop registrations for arrows that no longer exist).
  type Bound = { id: string; type: string }
  const endsOf = (e: Record<string, unknown>) => [(e.startBinding as { elementId?: string } | null)?.elementId, (e.endBinding as { elementId?: string } | null)?.elementId]
  const outById = new Map(els.map((e) => [e.id as string, e]))
  const arrowsOf = new Map<string, string[]>()
  for (const e of els) {
    if (e.type !== 'arrow' && e.type !== 'line') continue
    for (const end of endsOf(e)) {
      if (!end || !outById.has(end)) continue
      arrowsOf.set(end, [...(arrowsOf.get(end) ?? []), e.id as string])
    }
  }
  for (const e of els) {
    if (!NODE_TYPES.has(e.type as string)) continue
    const current = (e.boundElements as Bound[] | null) ?? []
    const keep = current.filter((b) => b.type !== 'arrow' || (outById.has(b.id) && endsOf(outById.get(b.id)!).includes(e.id as string)))
    const have = new Set(keep.map((b) => b.id))
    const added: Bound[] = (arrowsOf.get(e.id as string) ?? []).filter((id) => !have.has(id)).map((id) => ({ id, type: 'arrow' }))
    if (added.length || keep.length !== current.length) e.boundElements = [...keep, ...added]
  }
  return JSON.stringify({ type: 'excalidraw', version: 2, source: 'aegraph', elements: els, appState: { viewBackgroundColor: g.background ?? prevFile?.appState?.viewBackgroundColor ?? '#ffffff', gridSize: prevFile?.appState?.gridSize ?? null }, files: prevFile?.files ?? {} }, null, 2)
}
