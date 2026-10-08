import Graph, { MultiGraph } from 'graphology'
import { displayLabel } from '../../entity/entity'
import { nodeColor, toHexColor } from '../../graph/style'
import { attributeKeys, isUnsafeKey, type GEdge, type GNode, type GraphExportInput, type ParsedGraph } from './model'

/**
 * Entities ⇄ graphology. Formats built on graphology (GEXF, GraphML) go
 * through here, and the attribute conventions (label, type, tags, color,
 * size, x/y/z, weight) match what Gephi reads and writes.
 */

const NODE_RESERVED = new Set(['label', 'type', 'tags', 'color', 'size', 'x', 'y', 'z', 'shape'])
const EDGE_RESERVED = new Set(['label', 'type', 'kind', 'tags', 'weight', 'color', 'size'])

function flatten(data: Record<string, unknown>, reserved: Set<string>, out: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    const key = reserved.has(k) ? `data_${k}` : k
    if (typeof v === 'object' && !Array.isArray(v)) out[key] = JSON.stringify(v)
    else if (Array.isArray(v)) out[key] = v.every((x) => typeof x !== 'object') ? v : JSON.stringify(v)
    else out[key] = v
  }
}

export function toGraphology(input: GraphExportInput): MultiGraph {
  const g = new MultiGraph({ type: 'mixed', allowSelfLoops: true })
  for (const n of input.nodes) {
    const st = input.styles?.nodes.get(n.id)
    const attrs: Record<string, unknown> = { label: displayLabel(n), type: n.type }
    if (n.tags.length) attrs.tags = n.tags
    const color = st ? nodeColor(st.color, n.type) : (input.registry?.get(n.type).color ?? undefined)
    if (color) attrs.color = toHexColor(color)
    if (st) attrs.size = st.size
    const p = input.positions?.[n.id]
    if (p) {
      attrs.x = p.x
      attrs.y = p.y
      if (p.z !== undefined) attrs.z = p.z
    }
    flatten(n.data, NODE_RESERVED, attrs)
    g.addNode(n.id, attrs)
  }
  for (const e of input.edges) {
    if (!g.hasNode(e.source.id) || !g.hasNode(e.target.id)) continue
    const st = input.styles?.edges.get(e.id)
    const attrs: Record<string, unknown> = { label: e.label ?? e.type, type: e.type }
    if (e.tags.length) attrs.tags = e.tags
    const w = e.data.weight
    if (typeof w === 'number') attrs.weight = w
    if (st) {
      attrs.color = toHexColor(st.color)
      attrs.size = st.width
    }
    flatten(e.data, EDGE_RESERVED, attrs)
    if (e.directed) g.addDirectedEdgeWithKey(e.id, e.source.id, e.target.id, attrs)
    else g.addUndirectedEdgeWithKey(e.id, e.source.id, e.target.id, attrs)
  }
  return g
}

const VIZ = new Set(['color', 'size', 'x', 'y', 'z', 'shape'])

export function fromGraphology(g: Graph): ParsedGraph {
  const nodes: GNode[] = []
  g.forEachNode((id, a) => {
    const attrs: Record<string, unknown> = {}
    const viz: NonNullable<GNode['viz']> = {}
    for (const [k, v] of Object.entries(a)) {
      if (k === 'label' || isUnsafeKey(k)) continue
      if (VIZ.has(k)) {
        if (k === 'color') viz.color = colorToHex(v)
        else if (k === 'shape') viz.shape = String(v)
        else if (typeof v === 'number') (viz as Record<string, number>)[k] = v
        continue
      }
      attrs[k] = v
    }
    nodes.push({ id, label: typeof a.label === 'string' ? a.label : undefined, attrs, viz: Object.keys(viz).length ? viz : undefined })
  })
  const edges: GEdge[] = []
  g.forEachEdge((id, a, s, t, _sa, _ta, undirected) => {
    const attrs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(a)) if (k !== 'label' && k !== 'weight' && !isUnsafeKey(k)) attrs[k] = v
    edges.push({ id, source: s, target: t, directed: !undirected, label: typeof a.label === 'string' ? a.label : undefined, weight: typeof a.weight === 'number' ? a.weight : undefined, attrs })
  })
  return { nodes, edges, directedDefault: g.type !== 'undirected', attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings: [] }
}

/** GEXF gives colours as {r,g,b,a}; GraphML/cyjs as strings. */
export function colorToHex(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const m = /^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v)
    return m ? `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : v
  }
  if (v && typeof v === 'object' && 'r' in v) {
    const c = v as { r: number; g: number; b: number }
    return `#${[c.r, c.g, c.b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`
  }
  return undefined
}
