import type { GraphSlice } from './filter'

/**
 * How much of a graph the explorer draws without asking. A view past the budget
 * is gated: the page shows what the filter would load — nodes by type, edges by
 * relationship type — and lets the user leave the heavy parts out before
 * anything is rendered. The numbers are what the renderers stay fluid at on an
 * ordinary laptop: sigma copes with more, three.js (one object per node and
 * edge) does not.
 */
export interface ViewBudget {
  nodes: number
  edges: number
}
export const DEFAULT_VIEW_BUDGET: ViewBudget = { nodes: 3000, edges: 15000 }

/** What a slice asks of the renderer: the nodes and edges it would draw (the node cap has already applied). */
export interface ViewLoad {
  nodes: number
  edges: number
}
export function viewLoad(slice: Pick<GraphSlice, 'nodes' | 'edges'>): ViewLoad {
  return { nodes: slice.nodes.length, edges: slice.edges.length }
}
export function exceedsBudget(load: ViewLoad, budget: ViewBudget): boolean {
  return load.nodes > budget.nodes || load.edges > budget.edges
}
/**
 * Whether to ask before drawing `load`: it is over budget and not something the user already agreed to.
 * A load within a tenth of what was accepted is treated as the same picture (filters go back and forth).
 */
export function shouldGate(load: ViewLoad, budget: ViewBudget, accepted?: ViewLoad): boolean {
  if (!exceedsBudget(load, budget)) return false
  return !covers(accepted, load)
}

/** Whether an accepted load stands for this one: within a tenth of it. */
export function covers(accepted: ViewLoad | undefined, load: ViewLoad): boolean {
  return !!accepted && load.nodes <= accepted.nodes * 1.1 && load.edges <= accepted.edges * 1.1
}

/** A slice's composition: nodes per type, edges per relationship type, and edges per (relationship type, source type, target type) — the last is what makes the estimates in the gate exact. */
export interface LoadBreakdown {
  nodeTypes: { type: string; count: number }[]
  relTypes: { type: string; count: number }[]
  /** Keyed `${relType}\t${sourceType}\t${targetType}`. */
  triples: Map<string, number>
}
export function breakdown(slice: Pick<GraphSlice, 'nodes' | 'edges'>): LoadBreakdown {
  const nodeCounts = new Map<string, number>()
  const typeOf = new Map<string, string>()
  for (const n of slice.nodes) {
    nodeCounts.set(n.type, (nodeCounts.get(n.type) ?? 0) + 1)
    typeOf.set(n.id, n.type)
  }
  const relCounts = new Map<string, number>()
  const triples = new Map<string, number>()
  for (const e of slice.edges) {
    relCounts.set(e.type, (relCounts.get(e.type) ?? 0) + 1)
    const k = `${e.type}\t${typeOf.get(e.source.id) ?? ''}\t${typeOf.get(e.target.id) ?? ''}`
    triples.set(k, (triples.get(k) ?? 0) + 1)
  }
  const desc = (m: Map<string, number>) => [...m].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  return { nodeTypes: desc(nodeCounts), relTypes: desc(relCounts), triples }
}

/** Edges that survive keeping only these node types and relationship types (exact, from the triples). */
export function estimateEdges(b: LoadBreakdown, nodeTypes: Set<string>, relTypes: Set<string>): number {
  let n = 0
  for (const [k, c] of b.triples) {
    const [rel, s, t] = k.split('\t')
    if (relTypes.has(rel) && nodeTypes.has(s) && nodeTypes.has(t)) n += c
  }
  return n
}
export function estimateNodes(b: LoadBreakdown, nodeTypes: Set<string>): number {
  let n = 0
  for (const t of b.nodeTypes) if (nodeTypes.has(t.type)) n += t.count
  return n
}

/**
 * A starting point for the gate: every node type, and relationship types dropped from the most numerous
 * down until the edges fit the budget (at least one type stays). Dense relationship kinds — similarity,
 * co-occurrence — are the usual bulk and the least informative to draw, and they are the biggest.
 */
export function suggestTrim(b: LoadBreakdown, budget: ViewBudget): { nodeTypes: Set<string>; relTypes: Set<string>; maxNodes: number } {
  const nodeTypes = new Set(b.nodeTypes.map((t) => t.type))
  const relTypes = new Set(b.relTypes.map((t) => t.type))
  for (const t of b.relTypes) {
    if (estimateEdges(b, nodeTypes, relTypes) <= budget.edges || relTypes.size <= 1) break
    relTypes.delete(t.type)
  }
  return { nodeTypes, relTypes, maxNodes: budget.nodes }
}

/**
 * What a drawn view costs the tab at its peak, measured: the WildChat atlas (2.09 M entities, 1.47 GB of heap with a
 * scene showing) with its filter cleared drew 1,000,492 nodes and 1,085,768 edges, and the heap peaked at 3.26 GB —
 * 74% of Chrome's 4.4 GB limit — before settling at 2.2 GB, with another 0.3 GB of typed-array buffers beside it. A
 * tab that started higher was stopped by the browser. The peak is what kills a tab, so it is what is counted.
 */
export const DRAW_BYTES = { node: 900, edge: 800 }
/** The share of the tab's heap limit a draw's peak may bring the page to; past it, garbage collection thrashes and the browser kills the tab. */
export const HEAP_CEILING = 0.7
/** What the explorer draws without asking where the browser does not report its heap (Firefox, Safari). */
export const UNMEASURED_BUDGET: ViewBudget = { nodes: 500_000, edges: 2_000_000 }

/** The tab's JS heap as Chrome reports it (`performance.memory`), in bytes; undefined elsewhere. */
export interface HeapReading {
  used: number
  limit: number
}
export function readHeap(): HeapReading | undefined {
  const m = (globalThis.performance as (Performance & { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }) | undefined)?.memory
  if (!m || !(m.jsHeapSizeLimit! > 0) || !(m.usedJSHeapSize! >= 0)) return undefined
  return { used: m.usedJSHeapSize!, limit: m.jsHeapSizeLimit! }
}

/** Bytes drawing `load` would add to the heap. */
export const drawCost = (load: ViewLoad): number => load.nodes * DRAW_BYTES.node + load.edges * DRAW_BYTES.edge

/** Bytes the page may still spend on a draw before it passes the ceiling (0 when it already has). */
export const heapRoom = (heap: HeapReading): number => Math.max(0, heap.limit * HEAP_CEILING - heap.used)

/**
 * The view budget memory allows: the room left split evenly between nodes and edges — what the gate's trim aims
 * for. Without a reading, the fixed `UNMEASURED_BUDGET`.
 */
export function memoryBudget(heap: HeapReading | undefined): ViewBudget {
  if (!heap) return UNMEASURED_BUDGET
  const room = heapRoom(heap)
  return { nodes: Math.floor(room / 2 / DRAW_BYTES.node), edges: Math.floor(room / 2 / DRAW_BYTES.edge) }
}

/** Whether drawing `load` keeps the page under the ceiling (always true without a reading: the fixed budget decides there). */
export function fitsMemory(load: ViewLoad, heap: HeapReading | undefined): boolean {
  if (!heap) return !exceedsBudget(load, UNMEASURED_BUDGET)
  return drawCost(load) <= heapRoom(heap)
}

/** Below this a view is never held back for memory: it costs a few dozen megabytes, and a page already short of that has worse trouble than a drawing. */
export const MEMORY_FLOOR: ViewBudget = { nodes: 50_000, edges: 200_000 }

/** Why a view is gated: past the budget the user set (or the engine's), or more than this tab's memory can take. */
export type GateReason = 'budget' | 'memory'

/**
 * Whether memory holds `load` back: past the floor, more than the tab can spare, and not something the user accepted
 * on this page (an acceptance from before a reload does not count — the heap is not what it was).
 */
export function memoryGates(load: ViewLoad, heap: HeapReading | undefined, acceptedHere?: ViewLoad): boolean {
  if (!exceedsBudget(load, MEMORY_FLOOR)) return false
  if (fitsMemory(load, heap)) return false
  return !covers(acceptedHere, load)
}
