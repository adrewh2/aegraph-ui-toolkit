import { displayLabel } from '../../entity/entity'
import { assignSafe, attributeKeys, type ExportFile, type GEdge, type GNode, type GraphExportInput, type ParsedGraph } from './model'

/**
 * Cytoscape.js JSON: `{ elements: { nodes: [{ data, position }], edges: [{ data }] } }`
 * (or the flat `elements: [...]` array form). Reserved data keys are id,
 * source, target; everything else is an attribute.
 */
interface CyElement {
  group?: 'nodes' | 'edges'
  data: Record<string, unknown> & { id?: string; source?: string; target?: string }
  position?: { x: number; y: number }
}

const NODE_KEYS = new Set(['id', 'name', 'label'])
const EDGE_KEYS = new Set(['id', 'source', 'target', 'label', 'weight', 'directed'])

export async function parseCyjs(text: string): Promise<ParsedGraph> {
  const doc = JSON.parse(text) as { elements?: { nodes?: CyElement[]; edges?: CyElement[] } | CyElement[] } | CyElement[]
  const el = Array.isArray(doc) ? doc : doc.elements
  let rawNodes: CyElement[] = []
  let rawEdges: CyElement[] = []
  if (Array.isArray(el)) {
    for (const e of el) (e.group === 'edges' || (e.group !== 'nodes' && e.data.source && e.data.target) ? rawEdges : rawNodes).push(e)
  } else if (el) {
    rawNodes = el.nodes ?? []
    rawEdges = el.edges ?? []
  }
  const warnings: string[] = []
  const nodes: GNode[] = []
  rawNodes.forEach((n, i) => {
    const { id, name, label } = n.data
    const nid = id !== undefined ? String(id) : `n${i}`
    // Keys that name an object's machinery are left out: a node's attributes become an entity's data.
    const attrs = assignSafe({}, n.data, NODE_KEYS)
    const rest = attrs
    if (name !== undefined) attrs.name = name
    const viz: NonNullable<GNode['viz']> = {}
    if (n.position && typeof n.position.x === 'number') {
      viz.x = n.position.x
      viz.y = -n.position.y // Cytoscape's y grows downward.
    }
    if (typeof rest.color === 'string') viz.color = rest.color
    nodes.push({ id: nid, label: typeof label === 'string' ? label : typeof name === 'string' ? name : undefined, attrs, viz: Object.keys(viz).length ? viz : undefined })
  })
  const edges: GEdge[] = []
  for (const e of rawEdges) {
    const { id, source, target, label, weight, directed } = e.data
    const rest = assignSafe({}, e.data, EDGE_KEYS)
    if (source === undefined || target === undefined) {
      warnings.push('Skipped an edge without source/target.')
      continue
    }
    edges.push({ id: id !== undefined ? String(id) : undefined, source: String(source), target: String(target), directed: directed === undefined ? true : directed !== false, label: typeof label === 'string' ? label : undefined, weight: typeof weight === 'number' ? weight : undefined, attrs: rest })
  }
  return { nodes, edges, directedDefault: true, attributeKeys: { nodes: attributeKeys(nodes), edges: attributeKeys(edges) }, warnings }
}

export async function writeCyjs(input: GraphExportInput): Promise<ExportFile[]> {
  const ids = new Set(input.nodes.map((n) => n.id))
  const doc = {
    elements: {
      nodes: input.nodes.map((n) => {
        const p = input.positions?.[n.id]
        const st = input.styles?.nodes.get(n.id)
        return { data: { id: n.id, label: displayLabel(n), type: n.type, tags: n.tags, ...(st ? { color: st.color, size: st.size } : {}), ...n.data }, ...(p ? { position: { x: p.x, y: -p.y } } : {}) }
      }),
      edges: input.edges.filter((e) => ids.has(e.source.id) && ids.has(e.target.id)).map((e) => ({ data: { id: e.id, source: e.source.id, target: e.target.id, type: e.type, label: e.label ?? e.type, directed: e.directed, tags: e.tags, ...e.data } })),
    },
  }
  return [{ name: `${input.name ?? 'graph'}.cyjs`, text: JSON.stringify(doc, null, 2), mime: 'application/json' }]
}
