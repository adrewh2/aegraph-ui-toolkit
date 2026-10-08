import type { PackedGraph } from './graph'
import { mulberry32 } from './random'

/**
 * Louvain communities as a hierarchy, over typed arrays only. Each level is a
 * weighted undirected graph in CSR (every edge listed from both ends); the
 * local-moving phase gives each node the neighbouring community with the best
 * modularity gain, driven by a queue — a node is looked at again only when a
 * neighbour moved (Traag's fast Louvain), so a pass costs the moves, not the
 * graph — and aggregation folds each community into one node of the next
 * level. Both are O(E) per pass with scratch arrays; nothing is allocated per
 * node. Where plain Louvain stops with more than `topMax` connected
 * communities, it goes on at half the resolution (and half again) so the
 * hierarchy ends in a top level small enough to lay out whole.
 */

/** A weighted, undirected graph in CSR — each edge listed from both ends — as one level of a hierarchy. */
export interface WeightedGraph {
  n: number
  offsets: Uint32Array
  targets: Uint32Array
  weights: Float32Array
  /** Weighted degree, counting the edges folded inside the node twice (as modularity counts them). */
  strength: Float64Array
  /** How many original nodes the node stands for. */
  size: Uint32Array
}

export interface Hierarchy {
  /** `levels[0]` is the graph itself; `levels[l + 1]` the communities of `levels[l]`. */
  levels: WeightedGraph[]
  /** `parent[l][i]`: the node of level l + 1 that node i of level l belongs to. */
  parent: Uint32Array[]
}

export interface HierarchyOptions {
  /** Modularity resolution: above 1, smaller communities; below, bigger (default 1). */
  resolution?: number
  /** Coarsen further, at lower resolution, until the top level has at most this many connected nodes (default 400). */
  topMax?: number
  /** At most this many levels, the graph included (default 16). */
  maxLevels?: number
  /** Weight per edge id (default 1 each); parallel edges add up. */
  edgeWeight?: Float32Array | Float64Array
  seed?: number
}

/** Level 0: the packed graph as a weighted CSR, self-loops dropped. Nodes that are not alive stand for nobody (size 0). */
export function weightedFromPacked(g: PackedGraph, edgeWeight?: Float32Array | Float64Array): WeightedGraph {
  const n = g.nodeCount
  const offsets = new Uint32Array(n + 1)
  let targets: Uint32Array
  let weights: Float32Array
  if (g.csrIsExact()) {
    // One pass to count what stays (self-loops go), one to copy.
    const off = g.offsets, nb = g.neighbors, ei = g.edgeIndex
    for (let i = 0; i < n; i++) {
      let c = 0
      for (let k = off[i], end = off[i + 1]; k < end; k++) if (nb[k] !== i) c++
      offsets[i + 1] = offsets[i] + c
    }
    targets = new Uint32Array(offsets[n])
    weights = new Float32Array(offsets[n])
    let p = 0
    for (let i = 0; i < n; i++) {
      for (let k = off[i], end = off[i + 1]; k < end; k++) {
        const j = nb[k]
        if (j === i) continue
        targets[p] = j
        weights[p++] = edgeWeight ? Math.max(0, edgeWeight[ei[k]]) || 0 : 1
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      let c = 0
      g.forEachIncident(i, (_e, other) => {
        if (other !== i) c++
      })
      offsets[i + 1] = offsets[i] + c
    }
    targets = new Uint32Array(offsets[n])
    weights = new Float32Array(offsets[n])
    let p = 0
    for (let i = 0; i < n; i++) {
      g.forEachIncident(i, (e, other) => {
        if (other === i) return
        targets[p] = other
        weights[p++] = edgeWeight ? Math.max(0, edgeWeight[e]) || 0 : 1
      })
    }
  }
  const strength = new Float64Array(n)
  const size = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = offsets[i], end = offsets[i + 1]; k < end; k++) s += weights[k]
    strength[i] = s
    size[i] = g.nodeAlive.has(i) ? 1 : 0
  }
  return { n, offsets, targets, weights, strength, size }
}

/**
 * One local-moving phase: returns dense community codes (0..K-1, in order of first appearance) and K. With
 * `groupIsolated`, every node without an edge joins one community — a thousand loose nodes are one group to place,
 * not a thousand. Deterministic for a seed.
 */
export function localMoving(G: WeightedGraph, resolution: number, seed: number, groupIsolated: boolean, maxPasses = 10): { comm: Uint32Array; count: number } {
  const n = G.n
  const { offsets, targets, weights, strength } = G
  const comm = new Uint32Array(n)
  const tot = new Float64Array(n)
  let m2 = 0
  for (let i = 0; i < n; i++) m2 += strength[i]
  let isolated = -1
  for (let i = 0; i < n; i++) {
    if (groupIsolated && offsets[i + 1] === offsets[i]) {
      if (isolated < 0) isolated = i
      comm[i] = isolated
    } else comm[i] = i
    tot[comm[i]] += strength[i]
  }
  if (m2 > 0) {
    const scale = resolution / m2
    // The queue: every node with an edge once, in a shuffled order; a ring buffer of n with a membership flag, so a
    // node is never in it twice.
    const queue = new Uint32Array(n)
    const queued = new Uint8Array(n)
    let tail = 0
    for (let i = 0; i < n; i++) if (offsets[i + 1] > offsets[i]) queue[tail++] = i
    const live = tail
    const rand = mulberry32(seed)
    for (let i = live - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = queue[i]
      queue[i] = queue[j]
      queue[j] = t
    }
    for (let q = 0; q < live; q++) queued[queue[q]] = 1
    let head = 0
    let pending = live
    tail = tail % n
    const acc = new Float64Array(n)
    const touched = new Uint32Array(n)
    let budget = live * maxPasses
    while (pending > 0 && budget-- > 0) {
      const i = queue[head]
      head = head + 1 === n ? 0 : head + 1
      pending--
      queued[i] = 0
      const own = comm[i]
      const ki = strength[i]
      let nt = 0
      const start = offsets[i], end = offsets[i + 1]
      for (let k = start; k < end; k++) {
        const c = comm[targets[k]]
        if (acc[c] === 0) touched[nt++] = c
        acc[c] += weights[k]
      }
      // Out of its community first, then into the best one — staying where it was wins ties.
      tot[own] -= ki
      let best = own
      let bestGain = acc[own] - tot[own] * ki * scale
      for (let t = 0; t < nt; t++) {
        const c = touched[t]
        const gain = acc[c] - tot[c] * ki * scale
        if (gain > bestGain + 1e-12) {
          bestGain = gain
          best = c
        }
      }
      for (let t = 0; t < nt; t++) acc[touched[t]] = 0
      tot[best] += ki
      if (best !== own) {
        comm[i] = best
        // Neighbours outside the community it joined may now prefer to follow it.
        for (let k = start; k < end; k++) {
          const j = targets[k]
          if (queued[j] || comm[j] === best) continue
          queued[j] = 1
          queue[tail] = j
          tail = tail + 1 === n ? 0 : tail + 1
          pending++
        }
      }
    }
  }
  // Dense codes in order of first appearance.
  const code = new Int32Array(n).fill(-1)
  let count = 0
  for (let i = 0; i < n; i++) {
    const c = comm[i]
    if (code[c] < 0) code[c] = count++
    comm[i] = code[c]
  }
  return { comm, count }
}

/** Fold each community into one node: edges between communities summed, edges inside them left in the strength. */
export function aggregate(G: WeightedGraph, comm: Uint32Array, K: number): WeightedGraph {
  const n = G.n
  const strength = new Float64Array(K)
  const size = new Uint32Array(K)
  const start = new Uint32Array(K + 1)
  for (let i = 0; i < n; i++) {
    const c = comm[i]
    strength[c] += G.strength[i]
    size[c] += G.size[i]
    start[c + 1]++
  }
  for (let c = 0; c < K; c++) start[c + 1] += start[c]
  const fill = start.slice(0, K)
  const members = new Uint32Array(n)
  for (let i = 0; i < n; i++) members[fill[comm[i]]++] = i
  const offsets = new Uint32Array(K + 1)
  // At most as many entries as the level below; trimmed at the end.
  const targets = new Uint32Array(G.targets.length)
  const weights = new Float32Array(G.targets.length)
  const acc = new Float64Array(K)
  const touched = new Uint32Array(K)
  let p = 0
  for (let c = 0; c < K; c++) {
    let nt = 0
    for (let m = start[c]; m < start[c + 1]; m++) {
      const i = members[m]
      for (let k = G.offsets[i], end = G.offsets[i + 1]; k < end; k++) {
        const d = comm[G.targets[k]]
        if (d === c) continue
        if (acc[d] === 0) touched[nt++] = d
        acc[d] += G.weights[k]
      }
    }
    for (let t = 0; t < nt; t++) {
      const d = touched[t]
      targets[p] = d
      weights[p++] = acc[d]
      acc[d] = 0
    }
    offsets[c + 1] = p
  }
  return { n: K, offsets, targets: targets.slice(0, p), weights: weights.slice(0, p), strength, size }
}

/** Nodes of a level that have an edge to another node of it. */
function connected(G: WeightedGraph): number {
  let c = 0
  for (let i = 0; i < G.n; i++) if (G.offsets[i + 1] > G.offsets[i]) c++
  return c
}

/** The community hierarchy of a packed graph (or of a level-0 graph already built). */
export function louvainHierarchy(g: PackedGraph | WeightedGraph, opts: HierarchyOptions = {}): Hierarchy {
  const base = 'targets' in g ? g : weightedFromPacked(g, opts.edgeWeight)
  const topMax = opts.topMax ?? 400
  const maxLevels = opts.maxLevels ?? 16
  let resolution = opts.resolution ?? 1
  let seed = opts.seed ?? 1
  const levels: WeightedGraph[] = [base]
  const parent: Uint32Array[] = []
  while (levels.length < maxLevels) {
    const G = levels[levels.length - 1]
    const { comm, count } = localMoving(G, resolution, seed++, levels.length === 1)
    if (count === G.n) {
      // Converged. A top level still too big to place whole is coarsened further at a lower resolution.
      if (connected(G) > topMax && resolution > 1 / 256) {
        resolution /= 2
        continue
      }
      break
    }
    parent.push(comm)
    levels.push(aggregate(G, comm, count))
    if (count <= 1) break
  }
  return { levels, parent }
}
