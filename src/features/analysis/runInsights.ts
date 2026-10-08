import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { ANALYSIS_IDS, type AnalysisId, type RunOptions } from '../../analysis/types'
import { metricsOptionsFor, runAnalyses } from '../../analysis/run'
import { runAnalysesInWorker } from '../../analysis/runInWorker'
import { getCachedMetrics, putCachedMetrics } from '../../core/graph/metrics/cache'
import { buildAnalysisInput } from './buildInput'
import { getLatestAnalysis, setAnalysisError, setAnalysisProgress, setLatestAnalysis, type LatestAnalysis } from './latest'

let inFlight: { promise: Promise<LatestAnalysis>; abort: AbortController } | null = null

/**
 * Run the analyses over the open dataset in a worker and publish the
 * result as the latest run. Concurrent calls share one run; a fresh call
 * while one is running cancels it only when `force` is set.
 */
export function runInsights(store: EntityStore, registry: TypeRegistry, which: AnalysisId[] = ANALYSIS_IDS, options: RunOptions = {}, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<LatestAnalysis> {
  if (inFlight && !opts.force) return inFlight.promise
  inFlight?.abort.abort()
  const abort = new AbortController()
  opts.signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const input = buildAnalysisInput(store, registry)
  // Same nodes and edges, same analyses: the latest run already answers.
  const latest = getLatestAnalysis()
  if (latest && !opts.force && latest.report.key === input.key && which.every((id) => latest.report.runs.some((r) => r.id === id))) return Promise.resolve(latest)
  setAnalysisProgress({ stage: 'metrics', done: 0, total: 1 })
  // Metrics already computed over these nodes and edges (the explorer's Stats tab, an earlier run) spare the metrics stage.
  const cached = getCachedMetrics(input.key, metricsOptionsFor(which, options))
  const run = typeof Worker === 'undefined' ? Promise.resolve(runAnalyses(input, which, options, { metrics: cached })) : runAnalysesInWorker(input, which, options, (stage, done, total) => setAnalysisProgress({ stage, done, total }), abort.signal, cached)
  const promise = run
    .then((r) => {
      putCachedMetrics(r.metrics)
      setLatestAnalysis(r)
      return r
    })
    .catch((e) => {
      setAnalysisError(e instanceof Error ? e.message : String(e))
      throw e
    })
    .finally(() => {
      if (inFlight?.abort === abort) inFlight = null
    })
  inFlight = { promise, abort }
  return promise
}

export const cancelInsights = () => inFlight?.abort.abort()
