import type { FilterSpec } from '../core/graph/filter'
import type { LayoutAlgorithm } from '../core/graph/layouts'
import type { NodeMetricId } from '../core/graph/metrics/types'
import type { PlotSpec } from '../core/graph/plot'

/**
 * The analytics harness vocabulary. An analysis reads one columnar
 * `AnalysisInput` (built once from the store, transferable to a worker)
 * and returns ranked `Finding`s, each carrying the numbers behind it and
 * a `Visual` the app can put on screen. Nothing here touches the store,
 * React or the DOM, so the package runs in a worker and in tests as is.
 */

export type AnalysisId = 'centrality' | 'communities' | 'schema' | 'temporal' | 'anomalies'

export interface AnalysisInfo {
  id: AnalysisId
  label: string
  question: string
  description: string
  /** Metric columns the analysis reads; computed once per run and shared. */
  metrics: NodeMetricId[]
  /** Rough cost class on a 50k-node graph. */
  cost: 'fast' | 'seconds'
}

export const ANALYSES: AnalysisInfo[] = [
  { id: 'centrality', label: 'Key players', question: 'Which entities matter most, and which hold the graph together?', description: 'PageRank hubs, betweenness bridges (nodes far more central than their degree suggests), how concentrated influence is, and the shape of the degree distribution.', metrics: ['degree', 'pagerank', 'betweenness', 'community'], cost: 'seconds' },
  { id: 'communities', label: 'Community map', question: 'What are the natural groups, what is each made of, and how do they connect?', description: 'Louvain communities characterised by their dominant types, tags and most central members, with modularity, cohesion per community and the strongest cross-community ties.', metrics: ['degree', 'pagerank', 'community'], cost: 'seconds' },
  { id: 'schema', label: 'Ontology in use', question: 'How is the ontology actually used: which types connect through which relationships, and how complete is the data?', description: 'Type mix, the type × type relationship matrix, cardinality per relationship kind, property coverage per type against the declared schema, and declared types with no instances.', metrics: [], cost: 'fast' },
  { id: 'temporal', label: 'Activity over time', question: 'How did the dataset grow, when were the bursts, and which parts have gone quiet?', description: 'Creation per period by type, bursts (periods far above the trend), the share created recently, and staleness by type.', metrics: [], cost: 'fast' },
  { id: 'anomalies', label: 'Outliers and gaps', question: 'What looks wrong or missing: outliers, orphans, near-duplicates, and links that should probably exist?', description: 'Degree outliers, isolated entities, near-duplicate labels, entities missing properties their type expects, and unlinked pairs that share many neighbours.', metrics: ['degree', 'clustering'], cost: 'seconds' },
]

export const ANALYSIS_IDS = ANALYSES.map((a) => a.id)
export const analysisInfo = (id: AnalysisId) => ANALYSES.find((a) => a.id === id)!

/** Declared ontology, as far as the analyses need it. */
export interface SchemaType {
  type: string
  label: string
  category: string
  parent?: string
  /** Property keys the type declares (schema or code fields). */
  properties: string[]
  /** Where the definition came from: declared, or inferred from instances. */
  declared: boolean
}

/**
 * Everything the analyses read, columnar and index-aligned: node i is
 * `ids[i]`, `types[i]`, …; edge j runs `src[j] → dst[j]` and is `edgeTypes[j]`.
 * Built once on the main thread, posted to the worker.
 */
export interface AnalysisInput {
  ids: string[]
  types: string[]
  labels: string[]
  tags: string[][]
  /** Property keys present (non-empty) on each node's data. */
  props: string[][]
  /** Epoch ms; NaN when unknown. */
  created: Float64Array
  updated: Float64Array
  src: Uint32Array
  dst: Uint32Array
  directed: Uint8Array
  edgeTypes: string[]
  edgeIds: string[]
  schema: SchemaType[]
  /** What the input covers, for titles. */
  scope: { label: string; projectId?: string }
  /** Order-insensitive fingerprint of the node/edge sets (matches metrics `sliceKey`). */
  key: string
}

export type Visual =
  /** A chart on the Scenes page; rows are entities, refs may read `metric.<id>` from the run's metrics. */
  | { kind: 'plot'; title: string; spec: PlotSpec }
  /** Unigraph: a filter over the dataset, styled, with the entities of interest focused. */
  | { kind: 'graph'; title: string; filter?: Partial<FilterSpec>; style?: GraphStyle; layout?: LayoutAlgorithm; focus?: string[] }
  /** A table of the finding's rows. */
  | { kind: 'table'; title: string; columns: string[]; rows: (string | number)[][] }

/** A declarative look for a graph visual; the app maps it onto the explorer's rendering spec. */
export interface GraphStyle {
  color?: { by: 'type' | 'community' | 'metric' | 'tag'; metric?: NodeMetricId; palette?: string }
  size?: { by: 'degree' | 'metric'; metric?: NodeMetricId; min?: number; max?: number; log?: boolean }
  /** Entities drawn emphasised (labelled, opaque) while the rest fade. */
  highlight?: string[]
  labels?: 'auto' | 'all' | 'none'
}

export interface Finding {
  /** Stable within a report: `<analysis>:<slug>`. */
  id: string
  analysis: AnalysisId
  /** The claim, one line. */
  title: string
  /** The evidence, one to three sentences with numbers. */
  detail: string
  /** Interestingness 0–1: how far from the unremarkable case, weighted by how much of the dataset it concerns. */
  score: number
  /** Entities the finding is about, most relevant first. */
  entities?: string[]
  /** Rows behind the claim, for the assistant and the table visual. */
  data?: Record<string, unknown>
  visual?: Visual
}

export interface AnalysisRun {
  id: AnalysisId
  ms: number
  findings: Finding[]
  /** Why nothing (or less) came back: too small, no dates, … */
  note?: string
}

export interface Report {
  computedAt: string
  key: string
  scope: AnalysisInput['scope']
  nodes: number
  edges: number
  runs: AnalysisRun[]
  /** Every finding across the runs, best first. */
  findings: Finding[]
  /** Which metric columns were computed (they are kept with the run for plots and styles). */
  metrics: NodeMetricId[]
  ms: number
}

export interface RunOptions {
  /** Findings per analysis to keep (default 8). */
  perAnalysis?: number
  /** Community characterisation depth and top-k lists (default 10). */
  topK?: number
  /** Time bin for the temporal analysis; chosen from the span when absent. */
  unit?: 'day' | 'week' | 'month' | 'quarter' | 'year'
  seed?: number
}
