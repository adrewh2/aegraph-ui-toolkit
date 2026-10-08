import type { EntityId, Relationship } from '../entity/types'
import { edgeWeight } from './paths'

/**
 * Backbone extraction: which edges of a dense graph carry its structure.
 *
 * A similarity mesh — every segment tied to the fifty segments most like it —
 * draws as a ball of wool whatever the layout does, because almost every edge
 * is noise at the scale you are looking at. These are the three standard ways
 * to keep the edges that matter, each cheap enough to run on every filter:
 *
 * - **disparity** — Serrano, Boguñá & Vespignani, *Extracting the multiscale
 *   backbone of complex weighted networks* (PNAS 2009). For each node, an edge
 *   is kept when its share of that node's strength is larger than a random
 *   split of the strength would give, at significance α. Multi-scale: a hub's
 *   strong ties and a leaf's only tie both survive. Needs weights.
 * - **simmelian** — the embeddedness backbone (Nick, Lee, Cui & Brandes,
 *   *Simmelian backbones*, ASONAM 2013): rank each node's edges by how much
 *   the two endpoints' neighbourhoods overlap, keep its top `k`. Triangles
 *   survive, one-off links go. Works without weights, which is what a
 *   nearest-neighbour graph has.
 * - **spanning** — the maximum spanning forest (Kruskal on descending weight,
 *   overlap as the weight when there is none): every node kept, one connected
 *   skeleton, no cycles. The tree layouts draw this exactly.
 *
 * Each returns the edges to keep; nodes are left alone (`hideIsolated` drops
 * what comes away empty). Costs: disparity and spanning are O(E log E),
 * simmelian O(Σ min(deg u, deg v)) — the triangle-counting bound — with a
 * guard on the very largest hubs.
 */

export type BackboneMode = 'disparity' | 'simmelian' | 'spanning'

export interface BackboneOptions {
  mode: BackboneMode
  /** disparity: keep edges significant at this level (0.01 severe … 0.5 gentle). Default 0.05. */
  alpha?: number
  /** simmelian: edges kept per node. Default 3. */
  k?: number
  /** Where the weight lives, e.g. `data.weight`; absent, every edge weighs 1. */
  weightField?: string
}

const DEFAULT_ALPHA = 0.05
const DEFAULT_K = 3
/** Neighbourhoods larger than this are sampled rather than intersected: a hub of 50k neighbours must not stall the filter. */
const OVERLAP_CAP = 2048

interface Compact {
  /** Endpoint indices per edge. */
  a: Int32Array
  b: Int32Array
  w: Float64Array
  /** Neighbours in CSR form. */
  start: Int32Array
  adj: Int32Array
  /** The edge each adjacency slot came from. */
  via: Int32Array
  n: number
}

/** Edges as index arrays plus an adjacency index — every mode reads this, nothing walks the entity graph twice. */
function compact(edges: Relationship[], weightField?: string): { c: Compact; ids: EntityId[] } {
  const index = new Map<EntityId, number>()
  const ids: EntityId[] = []
  const at = (id: EntityId) => {
    let i = index.get(id)
    if (i === undefined) {
      i = ids.length
      index.set(id, i)
      ids.push(id)
    }
    return i
  }
  const m = edges.length
  const a = new Int32Array(m)
  const b = new Int32Array(m)
  const w = new Float64Array(m)
  for (let e = 0; e < m; e++) {
    const r = edges[e]
    a[e] = at(r.source.id)
    b[e] = at(r.target.id)
    const raw = edgeWeight(r, weightField)
    w[e] = Number.isFinite(raw) && raw > 0 ? raw : 1
  }
  const n = ids.length
  const deg = new Int32Array(n)
  for (let e = 0; e < m; e++) {
    deg[a[e]]++
    deg[b[e]]++
  }
  const start = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i]
  const adj = new Int32Array(start[n])
  const via = new Int32Array(start[n])
  const fill = start.slice(0, n)
  for (let e = 0; e < m; e++) {
    adj[fill[a[e]]] = b[e]
    via[fill[a[e]]++] = e
    adj[fill[b[e]]] = a[e]
    via[fill[b[e]]++] = e
  }
  return { c: { a, b, w, start, adj, via, n }, ids }
}

/** The edges of `edges` that carry the structure, in their original order. */
export function backboneEdges(edges: Relationship[], opts: BackboneOptions): Relationship[] {
  if (edges.length < 2) return edges
  const { c } = compact(edges, opts.weightField)
  const keep = opts.mode === 'disparity' ? disparity(c, opts.alpha ?? DEFAULT_ALPHA) : opts.mode === 'spanning' ? spanning(c) : simmelian(c, Math.max(1, opts.k ?? DEFAULT_K))
  const out: Relationship[] = []
  for (let e = 0; e < edges.length; e++) if (keep[e]) out.push(edges[e])
  return out
}

/** Serrano et al.: keep an edge when it is significant from either end. A degree-1 node keeps its only edge. */
function disparity(c: Compact, alpha: number): Uint8Array {
  const { a, w, start, via, n } = c
  const keep = new Uint8Array(a.length)
  const strength = new Float64Array(n)
  for (let i = 0; i < n; i++) for (let k = start[i]; k < start[i + 1]; k++) strength[i] += w[via[k]]
  for (let i = 0; i < n; i++) {
    const k = start[i + 1] - start[i]
    const s = strength[i]
    if (!k || s <= 0) continue
    if (k === 1) {
      keep[via[start[i]]] = 1
      continue
    }
    for (let x = start[i]; x < start[i + 1]; x++) {
      const e = via[x]
      // p is the chance a uniform split of the node's strength would give this edge at least its share.
      const p = Math.pow(1 - w[e] / s, k - 1)
      if (p < alpha) keep[e] = 1
    }
  }
  return keep
}

/**
 * Neighbourhood overlap — the Jaccard index of the two endpoints' neighbours — as each edge's embeddedness.
 * Every edge is settled by its *larger* endpoint, whose neighbourhood is marked once, so the walk costs
 * O(Σ deg) + O(Σ_e min(deg u, deg v)): the triangle-counting bound, not the square of the degree.
 */
function overlaps(c: Compact): Float64Array {
  const { a, start, adj, via, n } = c
  const out = new Float64Array(a.length)
  const mark = new Int32Array(n).fill(-1)
  const degOf = (i: number) => Math.min(start[i + 1] - start[i], OVERLAP_CAP)
  for (let i = 0; i < n; i++) {
    const degI = start[i + 1] - start[i]
    if (!degI) continue
    let mine = 0
    const lim = Math.min(start[i + 1], start[i] + OVERLAP_CAP)
    for (let k = start[i]; k < lim; k++) {
      mark[adj[k]] = i
      mine++
    }
    for (let k = start[i]; k < start[i + 1]; k++) {
      const e = via[k]
      const j = adj[k]
      const degJ = start[j + 1] - start[j]
      // One endpoint settles the edge: the bigger degree, the lower index on a tie.
      if (degJ > degI || (degJ === degI && j < i)) continue
      let shared = 0
      const jLim = Math.min(start[j + 1], start[j] + OVERLAP_CAP)
      for (let x = start[j]; x < jLim; x++) if (mark[adj[x]] === i) shared++
      const union = mine + degOf(j) - shared
      out[e] = union > 0 ? shared / union : 0
    }
  }
  return out
}

/** Simmelian backbone: each node keeps its k most embedded edges; the union is the backbone. */
function simmelian(c: Compact, k: number): Uint8Array {
  const { start, via, n } = c
  const keep = new Uint8Array(c.a.length)
  const emb = overlaps(c)
  const slot: number[] = []
  for (let i = 0; i < n; i++) {
    const deg = start[i + 1] - start[i]
    if (!deg) continue
    if (deg <= k) {
      for (let x = start[i]; x < start[i + 1]; x++) keep[via[x]] = 1
      continue
    }
    slot.length = 0
    for (let x = start[i]; x < start[i + 1]; x++) slot.push(via[x])
    // Ties by weight, then by index: the same graph gives the same backbone every time.
    slot.sort((p, q) => emb[q] - emb[p] || c.w[q] - c.w[p] || p - q)
    for (let x = 0; x < k; x++) keep[slot[x]] = 1
  }
  return keep
}

/**
 * Maximum spanning forest: Kruskal over descending weight, union-find with path halving.
 *
 * Ties — which is every edge of an unweighted graph — are broken by how well connected the edge's ends are, then by
 * embeddedness. Without that, equal weights make Kruskal join whatever it meets first and the "skeleton" comes out
 * as one long snake; with it, each node attaches to the biggest thing near it, so a containment graph keeps its
 * hubs and the tree reads as a hierarchy.
 */
function spanning(c: Compact): Uint8Array {
  const { a, b, w, start, n } = c
  const m = a.length
  const keep = new Uint8Array(m)
  const emb = overlaps(c)
  const pull = new Float64Array(m)
  for (let e = 0; e < m; e++) {
    const da = start[a[e] + 1] - start[a[e]]
    const db = start[b[e] + 1] - start[b[e]]
    pull[e] = Math.max(da, db)
  }
  const order = new Int32Array(m)
  for (let e = 0; e < m; e++) order[e] = e
  const sorted = Array.from(order).sort((p, q) => w[q] - w[p] || pull[q] - pull[p] || emb[q] - emb[p] || p - q)
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x: number) => {
    let i = x
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (const e of sorted) {
    const ra = find(a[e])
    const rb = find(b[e])
    if (ra === rb) continue
    parent[ra] = rb
    keep[e] = 1
  }
  return keep
}
