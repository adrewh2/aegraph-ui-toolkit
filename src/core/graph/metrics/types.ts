import type { EntityId } from '../../entity/types'

/**
 * Graph analytics vocabulary. Results are columnar (one Float64Array per
 * metric, aligned with `ids`) so they transfer out of the worker without
 * copying and feed histograms, legends and top-k lists directly.
 */

export type NodeMetricId =
  | 'degree'
  | 'inDegree'
  | 'outDegree'
  | 'weightedDegree'
  | 'pagerank'
  | 'betweenness'
  | 'closeness'
  | 'eigenvector'
  | 'hub'
  | 'authority'
  | 'clustering'
  | 'component'
  | 'componentSize'
  | 'community'

export interface MetricInfo {
  id: NodeMetricId
  label: string
  group: 'degree' | 'centrality' | 'structure' | 'community'
  /** Rough cost class, for warnings. */
  cost: 'linear' | 'iterative' | 'quadratic'
  /** Values are labels (component / community ids), not magnitudes. */
  categorical?: boolean
  description: string
  /** Node count above which the metric gets sampled or warned about. */
  softLimit?: number
}

export const METRICS: MetricInfo[] = [
  { id: 'degree', label: 'Degree', group: 'degree', cost: 'linear', description: 'Number of relationships touching the node.' },
  { id: 'inDegree', label: 'In-degree', group: 'degree', cost: 'linear', description: 'Incoming directed relationships.' },
  { id: 'outDegree', label: 'Out-degree', group: 'degree', cost: 'linear', description: 'Outgoing directed relationships.' },
  { id: 'weightedDegree', label: 'Weighted degree', group: 'degree', cost: 'linear', description: 'Sum of edge weights (needs a weight field).' },
  { id: 'pagerank', label: 'PageRank', group: 'centrality', cost: 'iterative', description: 'Importance by incoming links from important nodes.' },
  { id: 'betweenness', label: 'Betweenness', group: 'centrality', cost: 'quadratic', description: 'How often the node sits on shortest paths (bridges). Sampled on large graphs.', softLimit: 3000 },
  { id: 'closeness', label: 'Closeness', group: 'centrality', cost: 'quadratic', description: 'Inverse average distance to every reachable node. Sampled on large graphs.', softLimit: 3000 },
  { id: 'eigenvector', label: 'Eigenvector', group: 'centrality', cost: 'iterative', description: 'Influence: connected to other influential nodes.' },
  { id: 'hub', label: 'HITS hub', group: 'centrality', cost: 'iterative', description: 'Points at many good authorities.' },
  { id: 'authority', label: 'HITS authority', group: 'centrality', cost: 'iterative', description: 'Pointed at by many good hubs.' },
  { id: 'clustering', label: 'Clustering coefficient', group: 'structure', cost: 'linear', description: 'How interconnected the node’s neighbours are (0–1).' },
  { id: 'component', label: 'Component', group: 'structure', cost: 'linear', categorical: true, description: 'Connected component id (0 = largest).' },
  { id: 'componentSize', label: 'Component size', group: 'structure', cost: 'linear', description: 'Nodes in the node’s connected component.' },
  { id: 'community', label: 'Community (Louvain)', group: 'community', cost: 'iterative', categorical: true, description: 'Modularity-maximising community id.' },
]

export const metricInfo = (id: NodeMetricId) => METRICS.find((m) => m.id === id)!
export const METRIC_IDS = METRICS.map((m) => m.id)
/** A sensible default set: everything cheap, plus PageRank and communities. */
export const DEFAULT_METRICS: NodeMetricId[] = ['degree', 'inDegree', 'outDegree', 'pagerank', 'clustering', 'component', 'componentSize', 'community']

export interface MetricsOptions {
  metrics: NodeMetricId[]
  /** Relationship attribute path holding weights, e.g. `data.weight`. */
  weightField?: string
  /** Honour relationship direction for in/out-degree, PageRank and HITS (default true). */
  directed?: boolean
  paths?: { exactBelow: number; sampleSources: number; seed: number }
  louvain?: { resolution: number; seed: number }
  /** Betweenness/closeness: sample this many sources above `sampleAbove` nodes. */
  sampling?: { sampleAbove: number; sources: number; seed: number }
}

export const DEFAULT_OPTIONS: Required<Pick<MetricsOptions, 'paths' | 'louvain' | 'sampling'>> = {
  paths: { exactBelow: 1500, sampleSources: 200, seed: 1 },
  louvain: { resolution: 1, seed: 1 },
  sampling: { sampleAbove: 3000, sources: 400, seed: 1 },
}

/** Wire format: node ids plus edge endpoint indices; typed arrays transfer between threads. */
export interface SerialGraph {
  ids: EntityId[]
  src: Uint32Array
  dst: Uint32Array
  /** 1 when the relationship is directed. */
  directed: Uint8Array
  weight?: Float64Array
}

export interface MetricsSummary {
  nodes: number
  edges: number
  density: number
  averageDegree: number
  componentCount: number
  giantComponentSize: number
  averageClustering?: number
  modularity?: number
  communityCount?: number
  diameter?: number
  averagePathLength?: number
  /** Whether diameter / path length were computed over every source (else sampled: diameter is a lower bound). */
  pathsExact?: boolean
  pathSources?: number
  /** Betweenness / closeness sampled from this many sources (absent = exact). */
  centralitySources?: number
  warnings: string[]
  durations: Partial<Record<NodeMetricId | 'build' | 'paths' | 'total', number>>
}

export interface MetricsResult {
  computedAt: string
  sliceKey: string
  options: MetricsOptions
  /** Node order for every column. */
  ids: EntityId[]
  columns: Partial<Record<NodeMetricId, Float64Array>>
  summary: MetricsSummary
  communities?: { count: number; sizes: number[] }
  /** Served from the shared result cache rather than computed for this request. */
  cached?: boolean
  /** Columns taken from an earlier result over the same slice; the rest were computed for this request. */
  reused?: NodeMetricId[]
}
