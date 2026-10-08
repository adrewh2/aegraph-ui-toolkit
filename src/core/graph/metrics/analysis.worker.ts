import { computeMetrics } from './compute'
import type { MetricsOptions, MetricsResult, SerialGraph } from './types'

export type AnalysisRequest = { type: 'run'; graph: SerialGraph; options: MetricsOptions; sliceKey: string }
export type AnalysisResponse = { type: 'progress'; stage: string; done: number; total: number } | { type: 'result'; result: MetricsResult } | { type: 'error'; message: string }

/** One job per worker; cancellation is `worker.terminate()` from the caller. */
self.onmessage = (ev: MessageEvent<AnalysisRequest>) => {
  const msg = ev.data
  if (msg.type !== 'run') return
  const post = (r: AnalysisResponse, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(r, transfer ?? [])
  let last = 0
  try {
    const result = computeMetrics(
      msg.graph,
      msg.options,
      {
        onProgress: (stage, done, total) => {
          const t = Date.now()
          if (t - last < 40 && done !== 0) return
          last = t
          post({ type: 'progress', stage, done, total })
        },
      },
      msg.sliceKey,
    )
    post({ type: 'result', result }, Object.values(result.columns).map((c) => c.buffer as ArrayBuffer))
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
