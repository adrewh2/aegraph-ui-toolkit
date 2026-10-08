/// <reference lib="webworker" />
import type { MetricsResult } from '../core/graph/metrics/types'
import { runAnalyses } from './run'
import type { AnalysisId, AnalysisInput, Report, RunOptions } from './types'

export type AnalysisWorkerRequest = { type: 'run'; input: AnalysisInput; which: AnalysisId[]; options: RunOptions; metrics?: MetricsResult }
export type AnalysisWorkerResponse = { type: 'progress'; stage: string; done: number; total: number } | { type: 'result'; report: Report; metrics: MetricsResult } | { type: 'error'; message: string }

self.onmessage = (ev: MessageEvent<AnalysisWorkerRequest>) => {
  const m = ev.data
  if (m.type !== 'run') return
  try {
    let last = 0
    const { report, metrics } = runAnalyses(m.input, m.which, m.options, {
      metrics: m.metrics,
      onProgress: (stage, done, total) => {
        const t = Date.now()
        if (t - last < 80 && done !== total) return
        last = t
        post({ type: 'progress', stage, done, total })
      },
    })
    const buffers = Object.values(metrics.columns).map((c) => c!.buffer as ArrayBuffer)
    ;(self as unknown as Worker).postMessage({ type: 'result', report, metrics } satisfies AnalysisWorkerResponse, buffers)
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

const post = (m: AnalysisWorkerResponse) => (self as unknown as Worker).postMessage(m)
