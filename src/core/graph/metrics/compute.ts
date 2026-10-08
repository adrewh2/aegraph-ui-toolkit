import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { betweenness, buildDirected, buildUndirected, closeness, connectedComponents, degrees, eigenvector, hits, localClustering, mulberry32, pagerank, pathStats, weightedDegrees } from './csr'
import { DEFAULT_OPTIONS, type MetricsOptions, type MetricsResult, type MetricsSummary, type NodeMetricId, type SerialGraph } from './types'

export interface ComputeHooks {
  onProgress?: (stage: string, done: number, total: number) => void
  shouldStop?: () => boolean
}

/**
 * Run the requested metrics over a serialised graph. Pure and synchronous
 * so it is testable directly; the worker wraps it. Cheap stages run first
 * so a cancelled run still leaves something useful.
 */
export function computeMetrics(g: SerialGraph, options: MetricsOptions, hooks: ComputeHooks = {}, sliceKey = ''): MetricsResult {
  const t0 = now()
  const want = new Set<NodeMetricId>(options.metrics)
  const n = g.ids.length
  const columns: MetricsResult['columns'] = {}
  const durations: MetricsSummary['durations'] = {}
  const warnings: string[] = []
  const progress = (stage: string, done = 0, total = 1) => hooks.onProgress?.(stage, done, total)
  const stop = () => !!hooks.shouldStop?.()
  const timed = <T>(key: keyof MetricsSummary['durations'], fn: () => T): T => {
    const s = now()
    const r = fn()
    durations[key] = Math.round(now() - s)
    return r
  }

  progress('build')
  const und = timed('build', () => buildUndirected(g))
  const directed = options.directed !== false
  let outC: ReturnType<typeof buildDirected> | undefined
  let inC: ReturnType<typeof buildDirected> | undefined
  const dir = () => {
    outC ??= directed ? buildDirected(g, 'out') : und
    inC ??= directed ? buildDirected(g, 'in') : und
    return { outC, inC }
  }

  // ── Degrees ──
  const deg = degrees(und)
  if (want.has('degree')) columns.degree = deg
  if (want.has('inDegree')) columns.inDegree = timed('inDegree', () => degrees(dir().inC))
  if (want.has('outDegree')) columns.outDegree = timed('outDegree', () => degrees(dir().outC))
  if (want.has('weightedDegree')) columns.weightedDegree = timed('weightedDegree', () => weightedDegrees(und))

  // ── Components ──
  progress('components')
  const comps = timed('component', () => connectedComponents(und))
  if (want.has('component')) columns.component = comps.component
  if (want.has('componentSize')) {
    const sizes = new Float64Array(n)
    for (let i = 0; i < n; i++) sizes[i] = comps.sizes[comps.component[i]]
    columns.componentSize = sizes
  }

  let averageClustering: number | undefined
  if (want.has('clustering') && !stop()) {
    progress('clustering', 0, n)
    const cl = timed('clustering', () => localClustering(und, (done) => progress('clustering', done, n)))
    columns.clustering = cl
    let s = 0
    for (let i = 0; i < n; i++) s += cl[i]
    averageClustering = n ? s / n : 0
  }

  if (want.has('pagerank') && !stop()) {
    progress('pagerank')
    columns.pagerank = timed('pagerank', () => pagerank(dir().outC))
  }
  if (want.has('eigenvector') && !stop()) {
    progress('eigenvector')
    const ev = timed('eigenvector', () => eigenvector(und))
    if (ev) columns.eigenvector = ev
    else warnings.push('Eigenvector centrality did not converge (disconnected or bipartite structure); column omitted.')
  }
  if ((want.has('hub') || want.has('authority')) && !stop()) {
    progress('hits')
    const h = timed('hub', () => hits(dir().outC, dir().inC))
    if (want.has('hub')) columns.hub = h.hub
    if (want.has('authority')) columns.authority = h.authority
  }

  // ── Communities ──
  let modularity: number | undefined
  let communityCount: number | undefined
  let communities: MetricsResult['communities']
  if (want.has('community') && !stop()) {
    progress('community')
    timed('community', () => {
      const lg = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false })
      for (let i = 0; i < n; i++) lg.addNode(String(i))
      for (let i = 0; i < g.src.length; i++) {
        const s = g.src[i]
        const t = g.dst[i]
        if (s === t) continue
        const w = g.weight ? g.weight[i] : 1
        lg.mergeEdge(String(s), String(t), {}) // key not needed; weights summed below
        lg.updateEdgeAttribute(String(s), String(t), 'weight', (v) => ((v as number) ?? 0) + w)
      }
      const opts = { ...DEFAULT_OPTIONS.louvain, ...(options.louvain ?? {}) }
      if (lg.size === 0) {
        const col = new Float64Array(n)
        for (let i = 0; i < n; i++) col[i] = i
        columns.community = col
        modularity = 0
        communityCount = n
        communities = { count: n, sizes: new Array(n).fill(1) }
        return
      }
      const res = louvain.detailed(lg, { getEdgeWeight: 'weight', resolution: opts.resolution, rng: mulberry32(opts.seed) })
      // Renumber communities by size, largest first, so ids are stable and meaningful.
      const sizes = new Map<number, number>()
      for (let i = 0; i < n; i++) sizes.set(res.communities[String(i)], (sizes.get(res.communities[String(i)]) ?? 0) + 1)
      const order = [...sizes.entries()].sort((a, b) => b[1] - a[1])
      const remap = new Map(order.map(([c], rank) => [c, rank]))
      const col = new Float64Array(n)
      for (let i = 0; i < n; i++) col[i] = remap.get(res.communities[String(i)])!
      columns.community = col
      modularity = res.modularity
      communityCount = res.count
      communities = { count: res.count, sizes: order.map(([, s]) => s) }
    })
  }

  // ── Expensive path-based centralities last ──
  const sampling = { ...DEFAULT_OPTIONS.sampling, ...(options.sampling ?? {}) }
  const sourceCount = n > sampling.sampleAbove ? sampling.sources : n
  let centralitySources: number | undefined
  if (want.has('closeness') && !stop()) {
    progress('closeness', 0, sourceCount)
    const r = timed('closeness', () => closeness(und, sourceCount, sampling.seed, (d, t) => progress('closeness', d, t), stop))
    columns.closeness = r.values
    if (r.sources < n) centralitySources = r.sources
  }
  if (want.has('betweenness') && !stop()) {
    progress('betweenness', 0, sourceCount)
    const r = timed('betweenness', () => betweenness(und, sourceCount, sampling.seed, (d, t) => progress('betweenness', d, t), stop))
    columns.betweenness = r.values
    if (r.sources < n) centralitySources = r.sources
  }

  // ── Graph-level paths ──
  let paths: ReturnType<typeof pathStats> | undefined
  const po = { ...DEFAULT_OPTIONS.paths, ...(options.paths ?? {}) }
  // Paths off (no exact walk, no sampled sources): no statistics at all, rather than a diameter of 0 that reads as computed.
  if (!stop() && n > 1 && (po.exactBelow > 0 || po.sampleSources > 0)) {
    progress('paths', 0, Math.min(n, po.exactBelow))
    paths = timed('paths', () => pathStats(und, po, (d, t) => progress('paths', d, t), stop))
  }

  const m = und.offsets[n] / 2
  let avgDeg = 0
  for (let i = 0; i < n; i++) avgDeg += deg[i]
  avgDeg = n ? avgDeg / n : 0
  durations.total = Math.round(now() - t0)
  const summary: MetricsSummary = {
    nodes: n,
    edges: g.src.length,
    density: n > 1 ? m / ((n * (n - 1)) / 2) : 0,
    averageDegree: avgDeg,
    componentCount: comps.sizes.length,
    giantComponentSize: comps.sizes[0] ?? 0,
    averageClustering,
    modularity,
    communityCount,
    diameter: paths?.diameter,
    averagePathLength: paths?.averagePathLength,
    pathsExact: paths?.exact,
    pathSources: paths?.sources,
    centralitySources,
    warnings,
    durations,
  }
  return { computedAt: new Date().toISOString(), sliceKey, options, ids: g.ids, columns, summary, communities }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
