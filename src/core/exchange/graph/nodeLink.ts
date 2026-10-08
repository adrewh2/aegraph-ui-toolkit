import { attributeKeys, type GEdge, type GNode, type ParsedGraph } from './model'

/**
 * Node-link JSON — the shape most graphs on the web come in: d3's examples (`{ nodes, links }`, Les Misérables among
 * them), NetworkX's `node_link_data` (`{ directed, multigraph, graph, nodes, links }`, or `edges` since 3.4), and
 * vega-datasets. A node is named by its `id`, else its `name`, else its place in the list; a link's `source` and
 * `target` are an id, a name, an index into `nodes` (d3 before its simulation has run), or the node itself (after).
 * Everything else on a node or a link is an attribute (`group` becomes one, so colouring by it is a click). Keys that
 * would reach into how objects work (`__proto__`, `prototype`, `constructor`) are dropped, as everywhere data is read.
 */

type Raw = Record<string, unknown>
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])
const attrsOf = (o: Raw, skip: ReadonlySet<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) if (!skip.has(k) && !UNSAFE.has(k)) out[k] = o[k]
  return out
}
const NODE_KEYS = new Set(['id', 'label', 'x', 'y', 'z', 'fx', 'fy', 'vx', 'vy', 'index'])
const LINK_KEYS = new Set(['id', 'source', 'target', 'label', 'weight', 'value', 'directed', 'index'])
const scalarId = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined)

/** Whether a parsed JSON value is a node-link graph rather than an aegraph document: `nodes` and `links`/`edges`, no `entities`. */
export function isNodeLink(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const d = doc as Raw
  return Array.isArray(d.nodes) && (Array.isArray(d.links) || Array.isArray(d.edges)) && !('entities' in d)
}

export async function parseNodeLink(text: string): Promise<ParsedGraph> {
  const doc = JSON.parse(text) as unknown
  if (!isNodeLink(doc)) throw new Error('Not node-link JSON: expected { "nodes": [...], "links": [...] } (or "edges").')
  const d = doc as { nodes: unknown[]; links?: unknown[]; edges?: unknown[]; directed?: unknown }
  const rawLinks = (d.links ?? d.edges) as unknown[]
  const warnings: string[] = []
  const nodes: GNode[] = []
  // Ids as the file gives them, when every node has one; otherwise a node is its name, or its place in the list.
  const explicit = d.nodes.every((n) => n && typeof n === 'object' && scalarId((n as Raw).id) !== undefined)
  const byName = new Map<string, string>()
  d.nodes.forEach((raw, i) => {
    const n = (raw && typeof raw === 'object' ? raw : { id: raw }) as Raw
    const name = typeof n.name === 'string' ? n.name : undefined
    const id = (explicit ? scalarId(n.id) : undefined) ?? name ?? String(i)
    if (name !== undefined && !byName.has(name)) byName.set(name, id)
    const viz: NonNullable<GNode['viz']> = {}
    if (typeof n.x === 'number' && typeof n.y === 'number') {
      viz.x = n.x
      viz.y = -n.y // screen y grows downward
    }
    if (typeof n.color === 'string') viz.color = n.color
    const label = typeof n.label === 'string' ? n.label : name ?? (typeof n.title === 'string' ? n.title : undefined)
    nodes.push({ id, label, attrs: attrsOf(n, NODE_KEYS), viz: Object.keys(viz).length ? viz : undefined })
  })
  const ids = new Set(nodes.map((n) => n.id))
  /** A link's end as a node id: the node object d3 swapped in, an id, a name, or an index into `nodes`. */
  const end = (v: unknown): string | undefined => {
    if (v && typeof v === 'object') return end((v as Raw).id ?? (v as Raw).name ?? (v as Raw).index)
    const s = scalarId(v)
    if (s === undefined) return undefined
    if (ids.has(s)) return s
    if (byName.has(s)) return byName.get(s)
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < nodes.length) return nodes[v].id
    return undefined
  }
  const edges: GEdge[] = []
  let dangling = 0
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== 'object') continue
    const l = raw as Raw
    const source = end(l.source)
    const target = end(l.target)
    if (source === undefined || target === undefined) {
      dangling++
      continue
    }
    const weight = typeof l.weight === 'number' ? l.weight : typeof l.value === 'number' ? l.value : undefined
    edges.push({ id: scalarId(l.id), source, target, directed: typeof l.directed === 'boolean' ? l.directed : undefined, label: typeof l.label === 'string' ? l.label : undefined, weight, attrs: { ...attrsOf(l, LINK_KEYS), ...(weight !== undefined ? { weight } : {}) } })
  }
  if (dangling) warnings.push(`Skipped ${dangling} link${dangling === 1 ? '' : 's'} whose ends are not among the nodes.`)
  return { nodes, edges, directedDefault: d.directed === true, attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings }
}
