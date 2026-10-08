import { DEFAULT_OPTIONS, type MetricsOptions, type MetricsResult, type MetricsSummary, type NodeMetricId } from './types'

/**
 * A small in-memory cache of metric results, shared by every caller that
 * computes over a slice: the explorer's Stats tab, Insights, and the tools.
 * Keyed on the slice fingerprint (`sliceKey`) and the options that change
 * a column. A result *covers* a request when it was computed over the same
 * nodes and edges with the same weighting and direction, holds every
 * column asked for, and agrees on the settings behind the columns asked
 * for (Louvain for `community`, sampling for the path centralities, the
 * path options when path statistics were wanted). A hit is returned
 * narrowed to the requested columns, so the caller sees exactly what it
 * asked for and nothing runs.
 */

const MAX_KEYS = 8
const MAX_PER_KEY = 4
/** Total cached cells (rows × columns) across every entry: 8M doubles is 64 MB. */
const MAX_CELLS = 8_000_000

const entries = new Map<string, MetricsResult[]>()

const PATH_CENTRALITIES: NodeMetricId[] = ['betweenness', 'closeness']

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k])
const pathsOff = (p: MetricsOptions['paths']) => !!p && p.exactBelow <= 0 && p.sampleSources <= 0
const PATHS_OFF: NonNullable<MetricsOptions['paths']> = { exactBelow: 0, sampleSources: 0, seed: 1 }

/** The same graph under the same weighting and direction: columns are comparable at all. */
const sameBase = (h: MetricsOptions, want: MetricsOptions) => (h.weightField ?? undefined) === (want.weightField ?? undefined) && (h.directed !== false) === (want.directed !== false)
const sameLouvain = (h: MetricsOptions, want: MetricsOptions) => same({ ...DEFAULT_OPTIONS.louvain, ...(h.louvain ?? {}) }, { ...DEFAULT_OPTIONS.louvain, ...(want.louvain ?? {}) })
const sameSampling = (h: MetricsOptions, want: MetricsOptions) => same({ ...DEFAULT_OPTIONS.sampling, ...(h.sampling ?? {}) }, { ...DEFAULT_OPTIONS.sampling, ...(want.sampling ?? {}) })
const samePaths = (h: MetricsOptions, want: MetricsOptions) => same({ ...DEFAULT_OPTIONS.paths, ...(h.paths ?? {}) }, { ...DEFAULT_OPTIONS.paths, ...(want.paths ?? {}) })
/** Whether a result carries path statistics (a run with paths off has none). */
const hasPaths = (r: MetricsResult) => r.summary.pathsExact === true || (r.summary.pathSources ?? 0) > 0

/** A column of `have` that answers `want`'s column of the same name (same base, and the same settings behind that column). */
const columnReusable = (have: MetricsResult, want: MetricsOptions, m: NodeMetricId): boolean => {
  if (!have.columns[m]) return false
  if (m === 'community') return sameLouvain(have.options, want)
  if (PATH_CENTRALITIES.includes(m)) return sameSampling(have.options, want)
  return true
}
/** Whether `have`'s path statistics answer `want`'s (trivially, when `want` asks for none). */
const pathsReusable = (have: MetricsResult, want: MetricsOptions): boolean => pathsOff({ ...DEFAULT_OPTIONS.paths, ...(want.paths ?? {}) }) || (samePaths(have.options, want) && hasPaths(have))

/** Whether `have` answers `want` over the same slice. */
export function coversMetrics(have: MetricsResult, want: MetricsOptions): boolean {
  return sameBase(have.options, want) && want.metrics.every((m) => columnReusable(have, want, m)) && pathsReusable(have, want)
}

/**
 * A miss that is partly answered: the cached result over the same slice and
 * base that reuses the most of `want`, with the options left to compute
 * (`remaining`): only the missing columns, and path statistics only when the
 * base lacks them. `remaining.metrics` may be empty when only the paths are
 * missing. Undefined when nothing can be reused.
 */
export function partialMetrics(sliceKey: string, want: MetricsOptions): { base: MetricsResult; reused: NodeMetricId[]; remaining: MetricsOptions } | undefined {
  const list = entries.get(sliceKey)
  if (!list) return undefined
  const wantsPaths = !pathsOff({ ...DEFAULT_OPTIONS.paths, ...(want.paths ?? {}) })
  let best: { base: MetricsResult; reused: NodeMetricId[]; paths: boolean; score: number } | undefined
  for (const base of list) {
    if (!sameBase(base.options, want)) continue
    const reused = want.metrics.filter((m) => columnReusable(base, want, m))
    const paths = pathsReusable(base, want)
    // Only real savings count: a column, or path statistics the request wants.
    const score = reused.length + (wantsPaths && paths ? 1 : 0)
    if (score && (!best || score > best.score)) best = { base, reused, paths, score }
  }
  if (!best) return undefined
  const reusedSet = new Set(best.reused)
  const remaining: MetricsOptions = { ...want, metrics: want.metrics.filter((m) => !reusedSet.has(m)) }
  if (best.paths) remaining.paths = PATHS_OFF
  return { base: best.base, reused: best.reused, remaining }
}

/**
 * Combine a partial's reused columns with a fresh run over the rest into one
 * result answering `want`. Graph-level summary figures follow the run that
 * computed them; the fresh run's counts and timings stand.
 */
export function mergeMetrics(base: MetricsResult, reused: NodeMetricId[], fresh: MetricsResult, want: MetricsOptions): MetricsResult {
  const columns: MetricsResult['columns'] = {}
  for (const m of want.metrics) columns[m] = fresh.columns[m] ?? (reused.includes(m) ? base.columns[m] : undefined)
  const fromBase = (m: NodeMetricId) => reused.includes(m) && !fresh.columns[m]
  const pathsFromBase = !hasPaths(fresh) && hasPaths(base)
  const durations: MetricsSummary['durations'] = { ...fresh.summary.durations }
  for (const m of reused) if (fromBase(m) && base.summary.durations[m] !== undefined) durations[m] = base.summary.durations[m]
  const summary: MetricsSummary = {
    ...fresh.summary,
    averageClustering: fromBase('clustering') ? base.summary.averageClustering : fresh.summary.averageClustering,
    modularity: fromBase('community') ? base.summary.modularity : fresh.summary.modularity,
    communityCount: fromBase('community') ? base.summary.communityCount : fresh.summary.communityCount,
    centralitySources: fresh.summary.centralitySources ?? (PATH_CENTRALITIES.some(fromBase) ? base.summary.centralitySources : undefined),
    diameter: pathsFromBase ? base.summary.diameter : fresh.summary.diameter,
    averagePathLength: pathsFromBase ? base.summary.averagePathLength : fresh.summary.averagePathLength,
    pathsExact: pathsFromBase ? base.summary.pathsExact : fresh.summary.pathsExact,
    pathSources: pathsFromBase ? base.summary.pathSources : fresh.summary.pathSources,
    warnings: [...new Set([...fresh.summary.warnings, ...(reused.length ? base.summary.warnings : [])])],
    durations,
  }
  const communities = want.metrics.includes('community') ? (fromBase('community') ? base.communities : fresh.communities) : undefined
  return { computedAt: fresh.computedAt, sliceKey: fresh.sliceKey, options: want, ids: fresh.ids, columns, summary, communities, reused: reused.length ? reused : undefined }
}

/** The cached result narrowed to `want`'s columns, or undefined when nothing covers it. */
export function getCachedMetrics(sliceKey: string, want: MetricsOptions): MetricsResult | undefined {
  const list = entries.get(sliceKey)
  if (!list) return undefined
  const hit = list.find((r) => coversMetrics(r, want))
  if (!hit) return undefined
  // Touch: most recently used key goes last.
  entries.delete(sliceKey)
  entries.set(sliceKey, list)
  const columns: MetricsResult['columns'] = {}
  for (const m of want.metrics) columns[m] = hit.columns[m]
  return { ...hit, options: want, columns, communities: want.metrics.includes('community') ? hit.communities : undefined, cached: true }
}

const cellsOf = (r: MetricsResult) => r.ids.length * Object.keys(r.columns).length

/** Remember a result; entries it makes redundant are dropped. */
export function putCachedMetrics(result: MetricsResult): void {
  if (!result.sliceKey) return
  const list = entries.get(result.sliceKey) ?? []
  // Already answered by a wider entry (a narrowed hit coming back round, or the same run twice): nothing to add.
  if (list.some((r) => coversMetrics(r, result.options))) return
  const kept = list.filter((r) => !coversMetrics(result, r.options))
  entries.delete(result.sliceKey)
  const { cached: _cached, reused: _reused, ...own } = result
  entries.set(result.sliceKey, [own, ...kept].slice(0, MAX_PER_KEY))
  while (entries.size > MAX_KEYS) entries.delete(entries.keys().next().value as string)
  // Oldest slices go first when the cells add up to more than the budget; the newest result always stays.
  let cells = [...entries.values()].flat().reduce((n, r) => n + cellsOf(r), 0)
  for (const key of [...entries.keys()]) {
    if (cells <= MAX_CELLS || key === result.sliceKey) continue
    cells -= entries.get(key)!.reduce((n, r) => n + cellsOf(r), 0)
    entries.delete(key)
  }
}

export function clearMetricsCache(): void {
  entries.clear()
}

/** For tests and diagnostics. */
export const metricsCacheSize = () => [...entries.values()].reduce((n, l) => n + l.length, 0)
