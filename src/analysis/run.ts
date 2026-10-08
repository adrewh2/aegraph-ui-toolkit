import { coversMetrics } from '../core/graph/metrics/cache'
import { computeMetrics } from '../core/graph/metrics/compute'
import type { MetricsOptions, MetricsResult, NodeMetricId } from '../core/graph/metrics/types'
import { anomalies } from './analyses/anomalies'
import { centrality } from './analyses/centrality'
import { communities } from './analyses/communities'
import { schema } from './analyses/schema'
import { temporal } from './analyses/temporal'
import { keep, makeContext, type Context } from './shared'
import { ANALYSIS_IDS, analysisInfo, type AnalysisId, type AnalysisInput, type AnalysisRun, type Finding, type Report, type RunOptions } from './types'

export interface RunHooks {
  onProgress?: (stage: string, done: number, total: number) => void
  shouldStop?: () => boolean
  /** A result computed earlier over the same input; used instead of the metrics stage when it covers what the analyses need. */
  metrics?: MetricsResult
}

/** The metric columns a set of analyses needs, as the options the metrics stage runs with (no path statistics). */
export function metricsOptionsFor(which: AnalysisId[], options: RunOptions = {}): MetricsOptions {
  const wanted = new Set<NodeMetricId>()
  for (const id of which) if (ANALYSIS_IDS.includes(id)) for (const m of analysisInfo(id).metrics) wanted.add(m)
  return { metrics: [...wanted], paths: { exactBelow: 0, sampleSources: 0, seed: options.seed ?? 1 } }
}

const RUNNERS: Record<AnalysisId, (ctx: Context, opts: RunOptions) => Finding[]> = {
  centrality: (ctx) => centrality(ctx),
  communities: (ctx) => communities(ctx),
  schema: (ctx) => schema(ctx),
  temporal: (ctx, o) => temporal(ctx, o.unit),
  anomalies: (ctx) => anomalies(ctx),
}

/**
 * Run a set of analyses over one input: the metric columns they share are
 * computed once, each analysis runs in isolation (one failing does not
 * sink the report), and the findings come back ranked across analyses.
 * Pure and synchronous; the worker wraps it.
 */
export function runAnalyses(input: AnalysisInput, which: AnalysisId[] = ANALYSIS_IDS, options: RunOptions = {}, hooks: RunHooks = {}): { report: Report; metrics: MetricsResult } {
  const t0 = now()
  const ids = which.filter((id) => ANALYSIS_IDS.includes(id))
  const metricsOptions = metricsOptionsFor(ids, options)
  const wanted = metricsOptions.metrics
  hooks.onProgress?.('metrics', 0, 1)
  const reuse = hooks.metrics && hooks.metrics.sliceKey === input.key && coversMetrics(hooks.metrics, metricsOptions)
  const metrics = reuse ? hooks.metrics! : computeMetrics({ ids: input.ids, src: input.src, dst: input.dst, directed: input.directed }, metricsOptions, { onProgress: hooks.onProgress, shouldStop: hooks.shouldStop }, input.key)
  const ctx = makeContext(input, metrics, { topK: options.topK ?? 10, seed: options.seed ?? 1 })
  const per = options.perAnalysis ?? 8
  const runs: AnalysisRun[] = []
  ids.forEach((id, k) => {
    if (hooks.shouldStop?.()) return
    hooks.onProgress?.(id, k, ids.length)
    const s = now()
    try {
      const findings = keep(RUNNERS[id](ctx, options), per)
      runs.push({ id, ms: Math.round(now() - s), findings, note: findings.length ? undefined : emptyNote(id, input) })
    } catch (e) {
      runs.push({ id, ms: Math.round(now() - s), findings: [], note: `Failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
  const findings = runs.flatMap((r) => r.findings).sort((a, b) => b.score - a.score)
  const report: Report = { computedAt: new Date().toISOString(), key: input.key, scope: input.scope, nodes: input.ids.length, edges: input.src.length, runs, findings, metrics: [...wanted], ms: Math.round(now() - t0) }
  return { report, metrics }
}

function emptyNote(id: AnalysisId, input: AnalysisInput): string {
  if (input.ids.length < 5) return 'Too few entities to say anything.'
  if (id === 'temporal') return 'Entities carry no usable creation dates.'
  if (id === 'communities' && input.src.length === 0) return 'No relationships, so no communities.'
  return 'Nothing stood out.'
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
