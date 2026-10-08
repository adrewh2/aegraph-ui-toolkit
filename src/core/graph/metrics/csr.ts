import type { SerialGraph } from './types'

/**
 * Compressed sparse row adjacency over typed arrays: the fastest shape for
 * the BFS-heavy metrics (components, clustering, paths, betweenness,
 * closeness) and for the power iterations (PageRank, eigenvector, HITS).
 */
export interface Csr {
  n: number
  /** offsets[i]..offsets[i+1] index `neighbors`/`weights` for node i. */
  offsets: Uint32Array
  neighbors: Uint32Array
  weights: Float64Array
}

/** Undirected view (every edge both ways; self-loops dropped; parallel edges merged by summing weights). */
export function buildUndirected(g: SerialGraph): Csr {
  return build(g, 'both')
}
/** Directed views: `out` lists successors, `in` lists predecessors. Undirected relationships appear in both. */
export function buildDirected(g: SerialGraph, dir: 'out' | 'in'): Csr {
  return build(g, dir)
}

function build(g: SerialGraph, dir: 'both' | 'out' | 'in'): Csr {
  const n = g.ids.length
  const m = g.src.length
  // Pass 1: count, deduplicating parallel edges via a per-node map built lazily in pass 2.
  const pairs = new Map<number, Map<number, number>>()
  const add = (a: number, b: number, w: number) => {
    let row = pairs.get(a)
    if (!row) pairs.set(a, (row = new Map()))
    row.set(b, (row.get(b) ?? 0) + w)
  }
  for (let i = 0; i < m; i++) {
    const s = g.src[i]
    const t = g.dst[i]
    // A self-loop says nothing about structure; an end the graph does not have would index past every kernel's buffers.
    if (s === t || s >= n || t >= n) continue
    const w = g.weight ? g.weight[i] : 1
    const und = dir === 'both' || !g.directed[i]
    if (und || dir === 'out') add(s, t, w)
    if (und || dir === 'in') add(t, s, w)
  }
  const offsets = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + (pairs.get(i)?.size ?? 0)
  const neighbors = new Uint32Array(offsets[n])
  const weights = new Float64Array(offsets[n])
  for (let i = 0; i < n; i++) {
    const row = pairs.get(i)
    if (!row) continue
    let k = offsets[i]
    for (const [j, w] of row) {
      neighbors[k] = j
      weights[k] = w
      k++
    }
  }
  return { n, offsets, neighbors, weights }
}

export function degrees(c: Csr): Float64Array {
  const out = new Float64Array(c.n)
  for (let i = 0; i < c.n; i++) out[i] = c.offsets[i + 1] - c.offsets[i]
  return out
}

export function weightedDegrees(c: Csr): Float64Array {
  const out = new Float64Array(c.n)
  for (let i = 0; i < c.n; i++) {
    let s = 0
    for (let k = c.offsets[i]; k < c.offsets[i + 1]; k++) s += c.weights[k]
    out[i] = s
  }
  return out
}

/** Component id per node (0 = largest) and sizes sorted descending. */
export function connectedComponents(c: Csr): { component: Float64Array; sizes: number[] } {
  const label = new Int32Array(c.n).fill(-1)
  const sizes: number[] = []
  const stack = new Uint32Array(c.n)
  let comp = 0
  for (let s = 0; s < c.n; s++) {
    if (label[s] >= 0) continue
    let top = 0
    stack[top++] = s
    label[s] = comp
    let size = 0
    while (top) {
      const u = stack[--top]
      size++
      for (let k = c.offsets[u]; k < c.offsets[u + 1]; k++) {
        const v = c.neighbors[k]
        if (label[v] < 0) {
          label[v] = comp
          stack[top++] = v
        }
      }
    }
    sizes.push(size)
    comp++
  }
  // Renumber so component 0 is the largest.
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => b.size - a.size)
  const remap = new Int32Array(sizes.length)
  order.forEach((o, rank) => (remap[o.i] = rank))
  const component = new Float64Array(c.n)
  for (let i = 0; i < c.n; i++) component[i] = remap[label[i]]
  return { component, sizes: order.map((o) => o.size) }
}

/** Local clustering coefficient: closed triples / possible triples around each node. */
export function localClustering(c: Csr, onProgress?: (done: number) => void): Float64Array {
  const out = new Float64Array(c.n)
  const mark = new Int32Array(c.n).fill(-1)
  for (let u = 0; u < c.n; u++) {
    const start = c.offsets[u]
    const end = c.offsets[u + 1]
    const d = end - start
    if (d < 2) continue
    for (let k = start; k < end; k++) mark[c.neighbors[k]] = u
    let tri = 0
    for (let k = start; k < end; k++) {
      const v = c.neighbors[k]
      for (let l = c.offsets[v]; l < c.offsets[v + 1]; l++) if (mark[c.neighbors[l]] === u) tri++
    }
    out[u] = tri / (d * (d - 1))
    if (onProgress && (u & 1023) === 0) onProgress(u)
  }
  return out
}

/** Single-source BFS distances into `dist` (reused buffer); returns the visit order length. */
function bfs(c: Csr, s: number, dist: Int32Array, order: Uint32Array): number {
  dist.fill(-1)
  dist[s] = 0
  let head = 0
  let tail = 0
  order[tail++] = s
  while (head < tail) {
    const u = order[head++]
    const du = dist[u] + 1
    for (let k = c.offsets[u]; k < c.offsets[u + 1]; k++) {
      const v = c.neighbors[k]
      if (dist[v] < 0) {
        dist[v] = du
        order[tail++] = v
      }
    }
  }
  return tail
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickSources(n: number, count: number, seed: number): Uint32Array {
  if (count >= n) {
    const all = new Uint32Array(n)
    for (let i = 0; i < n; i++) all[i] = i
    return all
  }
  const rnd = mulberry32(seed)
  const chosen = new Set<number>()
  while (chosen.size < count) chosen.add(Math.floor(rnd() * n))
  return Uint32Array.from(chosen)
}

/** Diameter and average path length over reachable pairs; exact below `exactBelow` nodes, else from `sampleSources` BFS roots. */
export function pathStats(c: Csr, opts: { exactBelow: number; sampleSources: number; seed: number }, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean) {
  const exact = c.n <= opts.exactBelow
  const sources = exact ? pickSources(c.n, c.n, 0) : pickSources(c.n, opts.sampleSources, opts.seed)
  const dist = new Int32Array(c.n)
  const order = new Uint32Array(c.n)
  let diameter = 0
  let total = 0
  let pairs = 0
  for (let i = 0; i < sources.length; i++) {
    if (shouldStop?.()) break
    const reached = bfs(c, sources[i], dist, order)
    for (let k = 1; k < reached; k++) {
      const d = dist[order[k]]
      if (d > diameter) diameter = d
      total += d
      pairs++
    }
    if (onProgress && (i & 63) === 0) onProgress(i, sources.length)
  }
  return { diameter, averagePathLength: pairs ? total / pairs : 0, exact, sources: sources.length }
}

/**
 * Brandes betweenness (unweighted). Exact when every node is a source;
 * otherwise scaled from `sources` sampled roots. Normalised to [0, 1].
 */
export function betweenness(c: Csr, sourceCount: number, seed: number, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): { values: Float64Array; sources: number } {
  const n = c.n
  const sources = pickSources(n, sourceCount, seed)
  const cb = new Float64Array(n)
  const dist = new Int32Array(n)
  const sigma = new Float64Array(n)
  const delta = new Float64Array(n)
  const order = new Uint32Array(n)
  // Predecessor lists as CSR-shaped scratch: for unweighted BFS a node's predecessors are exactly its neighbours at dist-1.
  for (let si = 0; si < sources.length; si++) {
    if (shouldStop?.()) break
    const s = sources[si]
    dist.fill(-1)
    sigma.fill(0)
    delta.fill(0)
    dist[s] = 0
    sigma[s] = 1
    let head = 0
    let tail = 0
    order[tail++] = s
    while (head < tail) {
      const u = order[head++]
      const du = dist[u]
      for (let k = c.offsets[u]; k < c.offsets[u + 1]; k++) {
        const v = c.neighbors[k]
        if (dist[v] < 0) {
          dist[v] = du + 1
          order[tail++] = v
        }
        if (dist[v] === du + 1) sigma[v] += sigma[u]
      }
    }
    for (let i = tail - 1; i > 0; i--) {
      const w = order[i]
      const dw = dist[w]
      const coeff = (1 + delta[w]) / sigma[w]
      for (let k = c.offsets[w]; k < c.offsets[w + 1]; k++) {
        const v = c.neighbors[k]
        if (dist[v] === dw - 1) delta[v] += sigma[v] * coeff
      }
      cb[w] += delta[w]
    }
    if (onProgress && (si & 31) === 0) onProgress(si, sources.length)
  }
  // Undirected: each pair counted twice; scale sampled runs up and normalise by (n-1)(n-2).
  const scale = (sources.length < n ? n / sources.length : 1) / 2
  const norm = n > 2 ? (n - 1) * (n - 2) / 2 : 1
  for (let i = 0; i < n; i++) cb[i] = (cb[i] * scale) / norm
  return { values: cb, sources: sources.length }
}

/** Closeness (Wasserman–Faust, so disconnected graphs stay comparable). Sampled: distances measured from sampled roots. */
export function closeness(c: Csr, sourceCount: number, seed: number, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): { values: Float64Array; sources: number } {
  const n = c.n
  const out = new Float64Array(n)
  const dist = new Int32Array(n)
  const order = new Uint32Array(n)
  if (sourceCount >= n) {
    for (let s = 0; s < n; s++) {
      if (shouldStop?.()) break
      const reached = bfs(c, s, dist, order)
      let sum = 0
      for (let k = 1; k < reached; k++) sum += dist[order[k]]
      const r = reached - 1
      out[s] = r > 0 ? ((r / sum) * r) / (n - 1) : 0
      if (onProgress && (s & 63) === 0) onProgress(s, n)
    }
    return { values: out, sources: n }
  }
  // Sampled: accumulate distance sums to every node from the sampled roots (distance is symmetric).
  const sources = pickSources(n, sourceCount, seed)
  const sum = new Float64Array(n)
  const reachedBy = new Float64Array(n)
  for (let i = 0; i < sources.length; i++) {
    if (shouldStop?.()) break
    const reached = bfs(c, sources[i], dist, order)
    for (let k = 1; k < reached; k++) {
      const v = order[k]
      sum[v] += dist[v]
      reachedBy[v]++
    }
    if (onProgress && (i & 63) === 0) onProgress(i, sources.length)
  }
  for (let v = 0; v < n; v++) out[v] = reachedBy[v] > 0 ? (reachedBy[v] / sum[v]) * (reachedBy[v] / sources.length) : 0
  return { values: out, sources: sources.length }
}

/** PageRank by power iteration over the out-CSR (dangling mass redistributed uniformly). */
export function pagerank(outC: Csr, opts: { alpha?: number; maxIterations?: number; tolerance?: number } = {}): Float64Array {
  const n = outC.n
  const alpha = opts.alpha ?? 0.85
  const maxIt = opts.maxIterations ?? 100
  const tol = opts.tolerance ?? 1e-6
  let rank = new Float64Array(n).fill(1 / n)
  let next = new Float64Array(n)
  const outW = new Float64Array(n)
  for (let u = 0; u < n; u++) for (let k = outC.offsets[u]; k < outC.offsets[u + 1]; k++) outW[u] += outC.weights[k]
  for (let it = 0; it < maxIt; it++) {
    let dangling = 0
    for (let u = 0; u < n; u++) if (outW[u] === 0) dangling += rank[u]
    const base = (1 - alpha) / n + (alpha * dangling) / n
    next.fill(base)
    for (let u = 0; u < n; u++) {
      if (outW[u] === 0) continue
      const share = (alpha * rank[u]) / outW[u]
      for (let k = outC.offsets[u]; k < outC.offsets[u + 1]; k++) next[outC.neighbors[k]] += share * outC.weights[k]
    }
    let diff = 0
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - rank[i])
    const t = rank
    rank = next
    next = t
    if (diff < tol) break
  }
  return rank
}

/**
 * Eigenvector centrality by shifted power iteration ((A + I) x) on the
 * undirected CSR, normalised to max 1. The shift keeps bipartite components
 * from oscillating. Returns null if it still fails to converge.
 */
export function eigenvector(c: Csr, opts: { maxIterations?: number; tolerance?: number } = {}): Float64Array | null {
  const n = c.n
  if (n === 0) return new Float64Array(0)
  let x = new Float64Array(n).fill(1)
  let y = new Float64Array(n)
  for (let it = 0; it < (opts.maxIterations ?? 300); it++) {
    for (let i = 0; i < n; i++) y[i] = x[i]
    for (let u = 0; u < n; u++) for (let k = c.offsets[u]; k < c.offsets[u + 1]; k++) y[c.neighbors[k]] += x[u] * c.weights[k]
    let max = 0
    for (let i = 0; i < n; i++) if (y[i] > max) max = y[i]
    if (max === 0) return y
    let diff = 0
    for (let i = 0; i < n; i++) {
      y[i] /= max
      diff += Math.abs(y[i] - x[i])
    }
    const t = x
    x = y
    y = t
    if (diff < (opts.tolerance ?? 1e-6) * n) return x
  }
  return null
}

/** HITS hubs/authorities by alternating power iteration over the directed CSRs. */
export function hits(outC: Csr, inC: Csr, opts: { maxIterations?: number; tolerance?: number } = {}): { hub: Float64Array; authority: Float64Array } {
  const n = outC.n
  const hub = new Float64Array(n).fill(1)
  const auth = new Float64Array(n).fill(1)
  const normalize = (a: Float64Array) => {
    let s = 0
    for (let i = 0; i < n; i++) s += a[i]
    if (s > 0) for (let i = 0; i < n; i++) a[i] /= s
  }
  for (let it = 0; it < (opts.maxIterations ?? 100); it++) {
    const prev = Float64Array.from(auth)
    // authority(v) = sum hub(u) for u -> v ; hub(u) = sum authority(v) for u -> v
    auth.fill(0)
    for (let v = 0; v < n; v++) for (let k = inC.offsets[v]; k < inC.offsets[v + 1]; k++) auth[v] += hub[inC.neighbors[k]] * inC.weights[k]
    normalize(auth)
    hub.fill(0)
    for (let u = 0; u < n; u++) for (let k = outC.offsets[u]; k < outC.offsets[u + 1]; k++) hub[u] += auth[outC.neighbors[k]] * outC.weights[k]
    normalize(hub)
    let diff = 0
    for (let i = 0; i < n; i++) diff += Math.abs(auth[i] - prev[i])
    if (diff < (opts.tolerance ?? 1e-8)) break
  }
  return { hub, authority: auth }
}
