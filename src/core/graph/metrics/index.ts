import { createEntity, displayLabel } from '../../entity/entity'
import type { EntityStore } from '../../entity/store'
import type { EntityId } from '../../entity/types'
import type { FilterSpec } from '../filter'
import { GRAPH_TYPES, type AnalysisData } from '../types'
import { metricInfo, type MetricsResult, type NodeMetricId } from './types'

export * from './types'
export { computeMetrics } from './compute'
export { clearMetricsCache, coversMetrics, getCachedMetrics, mergeMetrics, partialMetrics, putCachedMetrics } from './cache'
export { serializeSlice, sliceKey } from './serialize'

/** id → row index for a result. */
export function indexOf(result: MetricsResult): Map<EntityId, number> {
  const m = new Map<EntityId, number>()
  result.ids.forEach((id, i) => m.set(id, i))
  return m
}

export function topK(result: MetricsResult, metric: NodeMetricId, k = 10): { id: EntityId; value: number }[] {
  const col = result.columns[metric]
  if (!col) return []
  const idx: number[] = []
  for (let i = 0; i < col.length; i++) if (Number.isFinite(col[i])) idx.push(i)
  idx.sort((a, b) => col[b] - col[a])
  return idx.slice(0, k).map((i) => ({ id: result.ids[i], value: col[i] }))
}

export function columnStats(col: Float64Array): { min: number; max: number; mean: number; count: number } {
  let min = Infinity, max = -Infinity, sum = 0, count = 0
  for (let i = 0; i < col.length; i++) {
    const v = col[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    count++
  }
  return count ? { min, max, mean: sum / count, count } : { min: 0, max: 0, mean: 0, count: 0 }
}

/** Equal-width histogram (log-spaced when `log`); categorical columns should use `categoryCounts` instead. */
export function histogram(col: Float64Array, bins = 20, log = false): { edges: number[]; counts: number[] } {
  const { min, max, count } = columnStats(col)
  if (!count) return { edges: [], counts: [] }
  const lo = log ? Math.log10(Math.max(min, 1e-9)) : min
  const hi = log ? Math.log10(Math.max(max, 1e-9)) : max
  const width = hi - lo || 1
  const counts = new Array(bins).fill(0)
  for (let i = 0; i < col.length; i++) {
    const v = col[i]
    if (!Number.isFinite(v)) continue
    const x = log ? Math.log10(Math.max(v, 1e-9)) : v
    const b = Math.min(bins - 1, Math.floor(((x - lo) / width) * bins))
    counts[b]++
  }
  const edges = new Array(bins + 1).fill(0).map((_, i) => (log ? 10 ** (lo + (i / bins) * width) : lo + (i / bins) * width))
  return { edges, counts }
}

export function categoryCounts(col: Float64Array): { key: number; count: number }[] {
  const m = new Map<number, number>()
  for (let i = 0; i < col.length; i++) if (Number.isFinite(col[i])) m.set(col[i], (m.get(col[i]) ?? 0) + 1)
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

export function describeAnalysis(r: MetricsResult): string {
  const cols = Object.keys(r.columns) as NodeMetricId[]
  const parts = [`${r.ids.length} nodes`, cols.map((c) => metricInfo(c).label.toLowerCase()).join(', ')]
  if (r.summary.modularity !== undefined) parts.push(`Q=${r.summary.modularity.toFixed(3)}`)
  return parts.join(' · ')
}

export function toAnalysisData(r: MetricsResult, extras: { filterId?: EntityId; filter?: FilterSpec } = {}): AnalysisData {
  const columns: Record<string, number[]> = {}
  for (const [k, col] of Object.entries(r.columns)) if (col) columns[k] = Array.from(col)
  return { computedAt: r.computedAt, sliceKey: r.sliceKey, options: r.options, ids: r.ids, columns, summary: r.summary, communities: r.communities, ...extras }
}

export function fromAnalysisData(d: AnalysisData): MetricsResult {
  const columns: MetricsResult['columns'] = {}
  for (const [k, col] of Object.entries(d.columns ?? {})) columns[k as NodeMetricId] = Float64Array.from(col as number[])
  return { computedAt: d.computedAt, sliceKey: d.sliceKey, options: d.options, ids: d.ids, columns, summary: d.summary, communities: d.communities }
}

export function createAnalysisEntity(store: EntityStore, label: string, r: MetricsResult, extras: { filterId?: EntityId; filter?: FilterSpec; source?: string } = {}) {
  const e = createEntity<AnalysisData>({ type: GRAPH_TYPES.analysis, label, data: toAnalysisData(r, { filterId: extras.filterId, filter: extras.filter }), tags: [], meta: { source: extras.source ?? 'user' } })
  store.upsert(e)
  return e
}

/** Copy metric columns onto entity `data.<prefix><metric>` in one transaction; returns entities touched. */
export function writeMetricsToEntities(store: EntityStore, r: MetricsResult, metrics?: NodeMetricId[], prefix = ''): number {
  const cols = (metrics ?? (Object.keys(r.columns) as NodeMetricId[])).filter((m) => r.columns[m])
  if (!cols.length) return 0
  let n = 0
  store.transaction(() => {
    r.ids.forEach((id, i) => {
      const e = store.get(id)
      if (!e) return
      const patch: Record<string, number> = {}
      for (const m of cols) {
        const v = r.columns[m]![i]
        if (Number.isFinite(v)) patch[prefix + m] = Math.round(v * 1e6) / 1e6
      }
      if (Object.keys(patch).length) {
        store.update(id, { data: { ...e.data, ...patch } })
        n++
      }
    })
  })
  return n
}

export const labelFor = (store: EntityStore, id: EntityId) => {
  const e = store.get(id)
  return e ? displayLabel(e) : id
}
