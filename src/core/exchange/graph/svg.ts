import { displayLabel } from '../../entity/entity'
import type { AnyEntity, EntityId, Relationship } from '../../entity/types'
import type { Positions } from '../../graph/layouts'
import { curvatureFor, indexParallelEdges } from '../../graph/parallel'
import type { EdgeStyle, NodeStyle } from '../../graph/rendering'
import { nodeColor } from '../../graph/style'
import { xmlEscape } from './xml'

export interface SvgOptions {
  width?: number
  height?: number
  padding?: number
  /** CSS colour or 'transparent'. */
  background?: string
  labels?: 'auto' | 'all' | 'none'
  edgeLabels?: boolean
  curvedEdges?: boolean
  fontFamily?: string
  fontSize?: number
  /** Multiplier on node radii. */
  scale?: number
}

/**
 * The current view as an SVG document: held positions, resolved styles, the
 * same shapes and parallel-edge curvature as the canvas. Pure, so it runs
 * anywhere (and in tests) and is deterministic for a given input.
 */
export function svgFromView(slice: { nodes: AnyEntity[]; edges: Relationship[] }, positions: Positions, styles: { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> }, opts: SvgOptions = {}): string {
  const W = opts.width ?? 1200
  const H = opts.height ?? 800
  const pad = opts.padding ?? 24
  const labels = opts.labels ?? 'auto'
  const font = opts.fontFamily ?? 'system-ui, sans-serif'
  const fs = opts.fontSize ?? 12
  const k = opts.scale ?? 1
  const bg = opts.background ?? '#faf9f6'

  const visible = slice.nodes.filter((n) => styles.nodes.get(n.id)?.visible !== false && positions[n.id])
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of visible) {
    const p = positions[n.id]
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!visible.length) return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>\n`
  // A span of zero (one node, or a row) only guards the scale; the offsets use the real span so the picture is centred.
  const s = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1))
  const ox = (W - (maxX - minX) * s) / 2
  const oy = (H - (maxY - minY) * s) / 2
  // Graph y grows upward (sigma/Gephi); SVG y grows downward.
  const sx = (x: number) => ox + (x - minX) * s
  const sy = (y: number) => H - (oy + (y - minY) * s)
  const pos = new Map<EntityId, { x: number; y: number; r: number }>()
  for (const n of visible) {
    const p = positions[n.id]
    const st = styles.nodes.get(n.id)!
    pos.set(n.id, { x: sx(p.x), y: sy(p.y), r: Math.max(1, st.size * k) })
  }

  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${xmlEscape(font)}" font-size="${fs}">`]
  if (bg !== 'transparent') out.push(`<rect width="100%" height="100%" fill="${xmlEscape(bg)}"/>`)

  // Arrow markers, one per colour actually used.
  const markers = new Map<string, string>()
  const markerId = (color: string) => {
    let id = markers.get(color)
    if (!id) {
      id = `a${markers.size}`
      markers.set(color, id)
    }
    return id
  }
  const parallel = opts.curvedEdges ? indexParallelEdges(slice.edges) : undefined
  const edgeEls: string[] = []
  for (const e of slice.edges) {
    const st = styles.edges.get(e.id)
    if (!st || !st.visible || e.source.id === e.target.id) continue
    const a = pos.get(e.source.id)
    const b = pos.get(e.target.id)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const arrow = e.directed && st.arrow
    const x1 = a.x + ux * a.r
    const y1 = a.y + uy * a.r
    const x2 = b.x - ux * (b.r + (arrow ? st.width * 3 : 0))
    const y2 = b.y - uy * (b.r + (arrow ? st.width * 3 : 0))
    const common = `stroke="${xmlEscape(st.color)}" stroke-width="${round(st.width)}" stroke-opacity="${round(st.opacity)}" fill="none" data-id="${xmlEscape(e.id)}"${arrow ? ` marker-end="url(#${markerId(st.color)})"` : ''}`
    const curv = curvatureFor(parallel?.get(e.id))
    let mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
    if (curv) {
      const cx = mid.x - uy * curv * len
      const cy = mid.y + ux * curv * len
      edgeEls.push(`<path d="M${round(x1)} ${round(y1)} Q${round(cx)} ${round(cy)} ${round(x2)} ${round(y2)}" ${common}/>`)
      mid = { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 }
    } else edgeEls.push(`<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" ${common}/>`)
    if (opts.edgeLabels) edgeEls.push(`<text x="${round(mid.x)}" y="${round(mid.y)}" font-size="${round(fs * 0.8)}" fill="#6b6a66" text-anchor="middle" dominant-baseline="middle">${xmlEscape(e.label ?? e.type)}</text>`)
  }
  if (markers.size) {
    out.push('<defs>')
    for (const [color, id] of markers) out.push(`<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" markerUnits="strokeWidth" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${xmlEscape(color)}"/></marker>`)
    out.push('</defs>')
  }
  out.push('<g class="edges">', ...edgeEls, '</g>')

  const nodeEls: string[] = []
  const labelEls: string[] = []
  for (const n of visible) {
    const st = styles.nodes.get(n.id)!
    const p = pos.get(n.id)!
    const fill = nodeColor(st.color, n.type)
    const attrs = `fill="${xmlEscape(fill)}" fill-opacity="${round(st.opacity)}" data-id="${xmlEscape(n.id)}"`
    const { x, y, r } = p
    if (st.shape === 'square') nodeEls.push(`<rect x="${round(x - r)}" y="${round(y - r)}" width="${round(2 * r)}" height="${round(2 * r)}" ${attrs}/>`)
    else if (st.shape === 'diamond') nodeEls.push(`<polygon points="${round(x)},${round(y - r)} ${round(x + r)},${round(y)} ${round(x)},${round(y + r)} ${round(x - r)},${round(y)}" ${attrs}/>`)
    else if (st.shape === 'triangle') nodeEls.push(`<polygon points="${round(x)},${round(y - r)} ${round(x + r)},${round(y + r)} ${round(x - r)},${round(y + r)}" ${attrs}/>`)
    else nodeEls.push(`<circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" ${attrs}/>`)
    if (st.label && labels !== 'none' && (labels === 'all' || r >= 6)) labelEls.push(`<text x="${round(x + r + 3)}" y="${round(y)}" dominant-baseline="middle" fill="#1f1e1b">${xmlEscape(displayLabel(n))}</text>`)
  }
  out.push('<g class="nodes">', ...nodeEls, '</g>')
  if (labelEls.length) out.push('<g class="labels">', ...labelEls, '</g>')
  out.push('</svg>', '')
  return out.join('\n')
}

const round = (v: number) => Math.round(v * 100) / 100
