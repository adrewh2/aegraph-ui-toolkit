import { parseDot, writeDot } from './dot'
import { patchDot } from './dotPatch'
import { parseExcalidraw, writeExcalidraw } from './excalidraw'
import type { DiagramGeometry } from './geometry'
import { mmId, parseMermaid, writeMermaid } from './mermaid'
import type { DiagramFormat, ParsedDiagram } from './model'

/**
 * Switching a diagram between formats without losing anything.
 *
 * A diagram is kept in every format it has been shown in
 * (`sources[format]`), each with the fingerprint of the structure it was
 * in sync with. Switching to a format the diagram already has, when the
 * structure and pinned positions have not changed since, shows that text
 * exactly as it was — a drawing comes back with every stroke, colour and
 * freehand scribble; DOT comes back with the user's own formatting.
 * When something did change, the target is *reconciled*: rebuilt from the
 * current structure on top of its previous rendition, so what the current
 * format could not express (styles, arrow routes, freehand, DOT
 * attributes) is carried over rather than regenerated.
 *
 * Positions travel too: a drawing writes `pos="x,y!"`, `width` and
 * `height` into DOT, and DOT with pinned positions places the drawing.
 * Mermaid carries no positions; the drawing keeps its own.
 */

export type DiagramSources = Partial<Record<DiagramFormat, { source: string; fingerprint: string }>>

export interface SwitchInput {
  format: DiagramFormat
  source: string
  sources?: DiagramSources
  /**
   * Where a renderer placed the current diagram (Graphviz / Mermaid), for
   * nodes the drawing has never seen. Not pinned: positions the user set
   * always win over it.
   */
  rendered?: DiagramGeometry
}

export interface SwitchResult {
  format: DiagramFormat
  source: string
  sources: DiagramSources
  /** Exact text from before, or rebuilt on top of it, or converted fresh. */
  how: 'exact' | 'reconciled' | 'converted'
}

export function parseFor(source: string, format: DiagramFormat): ParsedDiagram {
  if (format === 'excalidraw') return parseExcalidraw(source)
  if (format === 'dot') return withDotPositions(parseDot(source))
  return parseMermaid(source)
}

/** Node `pos="x,y!"` / `width` / `height` in DOT become pinned geometry (points ↔ pixels, y up ↔ y down, inches at 72 dpi). */
export function withDotPositions(d: ParsedDiagram): ParsedDiagram {
  const nodes: DiagramGeometry['nodes'] = {}
  for (const n of d.nodes) {
    const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(!)?\s*$/.exec(n.attrs.pos ?? '')
    if (!m) continue
    const w = Number(n.attrs.width)
    const h = Number(n.attrs.height)
    nodes[n.id] = { x: Number(m[1]), y: -Number(m[2]), width: Number.isFinite(w) && w > 0 ? w * 72 : 120, height: Number.isFinite(h) && h > 0 ? h * 72 : 56, shape: n.shape, pinned: true }
  }
  if (!Object.keys(nodes).length) return d
  const base = d.geometry ?? { width: 0, height: 0, nodes: {}, edges: {}, groups: {} }
  return { ...d, geometry: { ...base, nodes: { ...base.nodes, ...nodes } } }
}

/** Shapes as the formats agree on them: every box-like word is a box, every round one an ellipse. */
export function canonShape(shape: string | undefined): string {
  const s = (shape ?? '').toLowerCase()
  if (!s || /^(box|rect|rectangle|rounded|note|stadium|subroutine|square|plaintext|plain|none|text|folder|tab|component)$/.test(s)) return 'box'
  if (/^(ellipse|circle|oval|doublecircle|double-circle|point)$/.test(s)) return 'ellipse'
  if (/^(diamond|mdiamond|rhombus)$/.test(s)) return 'diamond'
  return s
}

/**
 * Ids as every format can spell them. A drawing's element ids carry
 * characters Mermaid can't (`-`, leading digits), so Mermaid writes them
 * sanitised; comparing and matching through this spelling lets the
 * formats agree on which node is which.
 */
export const canonId = (id: string) => mmId(id)
/** Groups too: DOT spells a drawing's frame `f1` as `cluster_f1`, and a cluster comes back as a frame of that name. */
export const canonGroupId = (id: string) => canonId(id.replace(/^cluster_?/i, ''))

/** What both formats must agree on: nodes, edges and groups, by canonical id, with labels and canonical shapes — not positions, not styling. */
export function fingerprint(d: ParsedDiagram): string {
  const nodes = d.nodes.map((n) => [canonId(n.id), n.label, n.group ? canonGroupId(n.group) : '', canonShape(n.shape)]).sort((a, b) => a[0].localeCompare(b[0]))
  const edges = d.edges.map((e) => [canonId(e.source), canonId(e.target), e.label ?? '', e.directed ? 1 : 0]).sort((a, b) => String(a).localeCompare(String(b)))
  const groups = d.groups.map((g) => [canonGroupId(g.id), g.label, g.parent ? canonGroupId(g.parent) : '']).sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify([nodes, edges, groups])
}

/**
 * The current diagram with its ids spelled the way a previous rendition
 * spelled them, wherever they mean the same node, edge or group — so the
 * writer finds the elements to reuse. Edges without an id match are
 * matched by endpoints and label.
 */
export function alignIds(current: ParsedDiagram, previous: ParsedDiagram): ParsedDiagram {
  const byCanon = new Map<string, string>()
  const byCanonGroup = new Map<string, string>()
  for (const n of previous.nodes) byCanon.set(canonId(n.id), n.id)
  for (const g of previous.groups) byCanonGroup.set(canonGroupId(g.id), g.id)
  const idOf = (id: string) => byCanon.get(canonId(id)) ?? id
  const groupOf = (id: string) => byCanonGroup.get(canonGroupId(id)) ?? id
  const nodes = current.nodes.map((n) => ({ ...n, id: idOf(n.id), group: n.group ? groupOf(n.group) : n.group }))
  const groups = current.groups.map((g) => ({ ...g, id: groupOf(g.id), parent: g.parent ? groupOf(g.parent) : g.parent }))
  const prevEdgeIds = new Set(previous.edges.map((e) => e.id))
  const edges = current.edges.map((e) => {
    const source = idOf(e.source)
    const target = idOf(e.target)
    if (prevEdgeIds.has(e.id)) return { ...e, source, target }
    const match = previous.edges.find((p) => p.source === source && p.target === target && (p.label ?? '') === (e.label ?? ''))
    return { ...e, source, target, id: match?.id ?? e.id }
  })
  let geometry = current.geometry
  if (geometry) {
    const remap = <T,>(rec: Record<string, T>, ids: (id: string) => string) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [ids(k), v]))
    const edgeIdOf = new Map(current.edges.map((e, i) => [e.id, edges[i].id]))
    geometry = { ...geometry, nodes: remap(geometry.nodes, idOf), groups: remap(geometry.groups, groupOf), edges: remap(geometry.edges, (k) => edgeIdOf.get(k) ?? k) }
  }
  return { ...current, nodes, edges, groups, geometry }
}

/** Pinned centres and sizes, rounded to the pixel, by canonical id — the part of geometry that a user set and a format may carry. */
function pinnedGeometry(d: ParsedDiagram): Record<string, [number, number, number, number]> {
  const out: Record<string, [number, number, number, number]> = {}
  for (const [id, g] of Object.entries(d.geometry?.nodes ?? {})) if (g.pinned) out[canonId(id)] = [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)]
  return out
}

/**
 * Whether the current diagram pins positions the target's last text does
 * not have: moved since, or — for a format that can carry them — never
 * written there at all.
 */
/**
 * Whether the current rendition moved a node since the target's text was
 * written. `baseline` is the current format's text as it was last synced:
 * when the target never carried positions (DOT laid out by Graphviz), a
 * drawing that still sits where that layout put it has not moved.
 */
function positionsMoved(current: ParsedDiagram, previous: ParsedDiagram, targetCarries: boolean, baseline?: ParsedDiagram): boolean {
  const now = pinnedGeometry(current)
  const before = pinnedGeometry(previous)
  const synced = baseline ? pinnedGeometry(baseline) : {}
  return Object.entries(now).some(([id, a]) => {
    const b = before[id] ?? synced[id]
    if (!b) return targetCarries && previous.nodes.some((n) => canonId(n.id) === id)
    return a.some((v, i) => Math.abs(v - b[i]) > 1)
  })
}

/** Which way a drawing mostly flows, from where its arrows go — so Mermaid, which cannot place nodes, at least reads the same way. */
export function flowDirection(d: ParsedDiagram): 'LR' | 'TD' | undefined {
  const nodes = d.geometry?.nodes
  if (!nodes) return undefined
  let dx = 0
  let dy = 0
  for (const e of d.edges) {
    const a = nodes[e.source]
    const b = nodes[e.target]
    if (!a?.pinned || !b?.pinned) continue
    dx += Math.abs(b.x - a.x)
    dy += Math.abs(b.y - a.y)
  }
  if (!dx && !dy) return undefined
  return dx > dy * 1.2 ? 'LR' : 'TD'
}

const norm = (c: string | undefined) => (c ? c.trim().toLowerCase() : undefined)

/**
 * Whether the current diagram states a colour or line style for something
 * that the target's last text stated differently. Only what both sides
 * state counts: a text without colours has no opinion.
 */
function stylesChanged(current: ParsedDiagram, previous: ParsedDiagram): boolean {
  const prevNodes = new Map(previous.nodes.map((n) => [canonId(n.id), n]))
  for (const n of current.nodes) {
    const p = prevNodes.get(canonId(n.id))
    if (!p) continue
    for (const k of ['fillcolor', 'color', 'fontcolor']) {
      const a = norm(n.attrs[k])
      const b = norm(p.attrs[k])
      if (a && b && a !== b) return true
    }
  }
  const prevEdges = previous.edges.map((e) => ({ key: `${canonId(e.source)}\u0000${canonId(e.target)}\u0000${e.label ?? ''}`, e }))
  for (const e of current.edges) {
    const key = `${canonId(e.source)}\u0000${canonId(e.target)}\u0000${e.label ?? ''}`
    const p = prevEdges.find((x) => x.key === key)?.e
    if (!p) continue
    const a = norm(e.attrs.color)
    const b = norm(p.attrs.color)
    if (a && b && a !== b) return true
    if (e.style !== undefined && p.style !== undefined && (e.style === 'dotted' || e.style === 'dashed') !== (p.style === 'dotted' || p.style === 'dashed')) return true
  }
  return false
}

export function switchDiagramFormat(input: SwitchInput, target: DiagramFormat): SwitchResult {
  const current = parseFor(input.source, input.format)
  if (input.rendered) {
    // The renderer's placement fills in for nodes without a pinned position.
    const nodes = { ...input.rendered.nodes }
    for (const [id, g] of Object.entries(current.geometry?.nodes ?? {})) if (g.pinned) nodes[id] = g
    current.geometry = { ...input.rendered, nodes, edges: current.geometry?.edges ?? input.rendered.edges, groups: { ...input.rendered.groups, ...(current.geometry?.groups ?? {}) } }
  }
  const fp = fingerprint(current)
  // This format's text as it was last synced, before it is replaced below.
  const lastSynced = input.sources?.[input.format]
  let baseline: ParsedDiagram | undefined
  if (lastSynced && lastSynced.source !== input.source) {
    try {
      baseline = parseFor(lastSynced.source, input.format)
    } catch {
      baseline = undefined
    }
  } else if (lastSynced) baseline = current
  const sources: DiagramSources = { ...input.sources, [input.format]: { source: input.source, fingerprint: fp } }
  if (target === input.format) return { format: target, source: input.source, sources, how: 'exact' }

  const kept = sources[target]
  let previous: ParsedDiagram | undefined
  if (kept) {
    try {
      previous = parseFor(kept.source, target)
    } catch {
      previous = undefined
    }
  }
  if (kept && previous && kept.fingerprint === fp && !positionsMoved(current, previous, target !== 'mermaid', baseline) && !stylesChanged(current, previous)) return { format: target, source: kept.source, sources, how: 'exact' }

  // Spell ids the way the target's last text did, so its elements and statements are found and reused.
  const aligned = previous ? alignIds(current, previous) : current
  let source: string
  if (target === 'excalidraw') source = writeExcalidraw(aligned, { previous: kept?.source })
  else if (target === 'dot') source = (kept && previous ? patchDot(kept.source, aligned, previous) : undefined) ?? writeDot(aligned, { previous, positions: Object.keys(pinnedGeometry(aligned)).length > 0 })
  else source = writeMermaid(aligned, { direction: aligned.attrs.direction || aligned.attrs.rankdir ? undefined : flowDirection(aligned) })
  sources[target] = { source, fingerprint: fp }
  return { format: target, source, sources, how: previous ? 'reconciled' : 'converted' }
}
