import type { DiagramGeometry } from './geometry'

/**
 * Format-neutral view of a diagram. The DOT, Mermaid and Excalidraw parsers
 * produce this; the mapping workflow and the writers consume it. Kept deliberately
 * flat: nodes, edges, and groups (subgraphs / clusters / classes' owners),
 * each carrying whatever attributes the source had.
 */

export type DiagramFormat = 'dot' | 'mermaid' | 'excalidraw'

/** What the source declared itself as. Mermaid has many; DOT is graph/digraph. */
export type DiagramKind = 'digraph' | 'graph' | 'flowchart' | 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'mindmap' | 'sequenceDiagram' | 'excalidraw' | 'unknown'

export interface DNode {
  id: string
  label: string
  /** Shape word as the source spelled it (box, ellipse, diamond, cylinder, …). */
  shape?: string
  /** Innermost group this node was declared in. */
  group?: string
  /** CSS-ish classes (Mermaid `:::cls`, `class A cls`, DOT `class="…"`). */
  classes: string[]
  /** Every other attribute, verbatim (DOT attrs, Mermaid class members, ER attributes…). */
  attrs: Record<string, string>
}

export interface DEdge {
  id: string
  source: string
  target: string
  label?: string
  directed: boolean
  /** Style hint from the arrow: solid, dotted, thick; inheritance, composition, … */
  style?: string
  attrs: Record<string, string>
}

export interface DGroup {
  id: string
  label: string
  parent?: string
  attrs: Record<string, string>
}

export interface ParsedDiagram {
  format: DiagramFormat
  kind: DiagramKind
  /** Graph-level attributes (rankdir, label, direction…). */
  attrs: Record<string, string>
  nodes: DNode[]
  edges: DEdge[]
  groups: DGroup[]
  /** Non-fatal things the parser skipped. */
  warnings: string[]
  /** Where things are, when the source carries positions (Excalidraw) or a renderer has been run. */
  geometry?: DiagramGeometry
}

export const emptyDiagram = (format: DiagramFormat, kind: DiagramKind = 'unknown'): ParsedDiagram => ({ format, kind, attrs: {}, nodes: [], edges: [], groups: [], warnings: [] })

/**
 * Where each node id is in `d.nodes`, per diagram, so a parse of n nodes is n lookups rather than n² (a diagram is
 * text from anywhere, and a DOT file of 50,000 nodes was minutes). Built as nodes are appended — through
 * `upsertNode` or not — and rebuilt when `d.nodes` is another array, has shrunk, or no longer has a node where the
 * index says. The first node with an id is the one found, as `find` would.
 */
const nodeIndex = new WeakMap<ParsedDiagram, { nodes: DNode[]; at: Map<string, number>; count: number }>()

/** The node with this id in a diagram being parsed, or undefined. */
export function findNode(d: ParsedDiagram, id: string): DNode | undefined {
  let ix = nodeIndex.get(d)
  if (!ix || ix.nodes !== d.nodes || d.nodes.length < ix.count) {
    ix = { nodes: d.nodes, at: new Map(), count: 0 }
    nodeIndex.set(d, ix)
  }
  const hit = ix.at.get(id)
  if (hit !== undefined) {
    if (d.nodes[hit]?.id === id) return d.nodes[hit]
    ix.at.clear()
    ix.count = 0
  }
  for (; ix.count < d.nodes.length; ix.count++) {
    const n = d.nodes[ix.count]
    if (!ix.at.has(n.id)) ix.at.set(n.id, ix.count)
  }
  const i = ix.at.get(id)
  return i !== undefined && d.nodes[i]?.id === id ? d.nodes[i] : undefined
}

/** Get-or-create a node while parsing; later declarations refine earlier ones. */
export function upsertNode(d: ParsedDiagram, id: string, patch: Partial<DNode> = {}): DNode {
  let n = findNode(d, id)
  if (!n) {
    n = { id, label: patch.label ?? id, classes: [], attrs: {} }
    d.nodes.push(n)
  }
  if (patch.label !== undefined) n.label = patch.label
  if (patch.shape !== undefined) n.shape = patch.shape
  if (patch.group !== undefined) n.group = patch.group
  if (patch.classes?.length) n.classes = [...new Set([...n.classes, ...patch.classes])]
  if (patch.attrs) Object.assign(n.attrs, patch.attrs)
  return n
}

/**
 * The most edges a parsed diagram keeps. `{ a1 … a3000 } -> { b1 … b3000 }` in DOT (or `A & B & … --> C & D & …` in
 * Mermaid) is nine million edges from sixty kilobytes; past this, the rest are left out with a warning.
 */
export const MAX_DIAGRAM_EDGES = 200_000
const capped = new WeakSet<ParsedDiagram>()

export function addEdge(d: ParsedDiagram, e: Omit<DEdge, 'id'>): DEdge {
  const edge: DEdge = { id: `e${d.edges.length + 1}`, ...e }
  if (d.edges.length >= MAX_DIAGRAM_EDGES) {
    if (!capped.has(d)) {
      capped.add(d)
      d.warnings.push(`More than ${MAX_DIAGRAM_EDGES.toLocaleString('en-US')} edges: the rest were left out.`)
    }
    return edge
  }
  d.edges.push(edge)
  return edge
}
