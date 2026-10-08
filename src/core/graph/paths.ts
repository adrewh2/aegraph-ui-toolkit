import Graph from 'graphology'
import { bidirectional as dijkstraBidirectional } from 'graphology-shortest-path/dijkstra'
import { bidirectional as unweightedBidirectional } from 'graphology-shortest-path/unweighted'
import type { EntityId, Relationship } from '../entity/types'
import { getPath } from './fields'
import type { GraphSlice } from './filter'

/**
 * Shortest paths over the current slice. The graphology graph is built per
 * query (a few ms at the slice cap) rather than cached, since the slice and
 * the direction/weight options change independently.
 */

export interface PathOptions {
  /** Honour relationship direction (default false: treat every edge as two-way). */
  directed?: boolean
  weighted?: boolean
  /** Edge attribute path for weights, default `data.weight`; missing/non-numeric = 1. */
  weightField?: string
}

export interface PathResult {
  nodes: EntityId[]
  edges: EntityId[]
  /** Hops. */
  length: number
  /** Sum of edge weights when weighted. */
  weight?: number
}

export function edgeWeight(e: Relationship, field = 'data.weight'): number {
  const v = getPath(e, field)
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : 1
}

export function sliceToGraphology(slice: Pick<GraphSlice, 'nodes' | 'edges'>, opts: { directed: boolean; weightField?: string }): Graph {
  const g = new Graph({ multi: true, type: 'mixed', allowSelfLoops: true })
  for (const n of slice.nodes) g.addNode(n.id)
  for (const e of slice.edges) {
    if (!g.hasNode(e.source.id) || !g.hasNode(e.target.id)) continue
    const attrs = { weight: edgeWeight(e, opts.weightField) }
    if (opts.directed && e.directed) g.addDirectedEdgeWithKey(e.id, e.source.id, e.target.id, attrs)
    else g.addUndirectedEdgeWithKey(e.id, e.source.id, e.target.id, attrs)
  }
  return g
}

export function shortestPath(slice: Pick<GraphSlice, 'nodes' | 'edges'>, from: EntityId, to: EntityId, opts: PathOptions = {}): PathResult | null {
  const g = sliceToGraphology(slice, { directed: !!opts.directed, weightField: opts.weightField })
  if (!g.hasNode(from) || !g.hasNode(to)) return null
  if (from === to) return { nodes: [from], edges: [], length: 0, weight: opts.weighted ? 0 : undefined }
  const nodes = opts.weighted ? dijkstraBidirectional(g, from, to, 'weight') : unweightedBidirectional(g, from, to)
  if (!nodes || nodes.length === 0) return null
  const edges: EntityId[] = []
  let weight = 0
  for (let i = 0; i + 1 < nodes.length; i++) {
    // Multigraph: several edges may join the same pair; take the lightest usable one.
    let best: string | undefined
    let bestW = Infinity
    for (const key of g.edges(nodes[i], nodes[i + 1])) {
      if (g.isDirected(key) && g.source(key) !== nodes[i]) continue
      const w = g.getEdgeAttribute(key, 'weight') as number
      if (w < bestW) {
        bestW = w
        best = key
      }
    }
    if (best) {
      edges.push(best)
      weight += bestW
    }
  }
  return { nodes, edges, length: nodes.length - 1, weight: opts.weighted ? weight : undefined }
}
