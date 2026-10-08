import type { MetricsResult } from '../core/graph/metrics/types'
import type { AnalysisId, AnalysisInput, Report, RunOptions } from './types'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './worker'

/**
 * Run the analyses off the main thread; aborting terminates the worker. The
 * input's typed arrays are transferred, not copied; `metrics` (a result
 * already computed over this input) is cloned in and spares the worker
 * the metrics stage.
 */
export function runAnalysesInWorker(input: AnalysisInput, which: AnalysisId[], options: RunOptions = {}, onProgress?: (stage: string, done: number, total: number) => void, signal?: AbortSignal, metrics?: MetricsResult): Promise<{ report: Report; metrics: MetricsResult }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const done = () => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      reject(Object.assign(new Error('Analysis cancelled.'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (ev: MessageEvent<AnalysisWorkerResponse>) => {
      const m = ev.data
      if (m.type === 'progress') onProgress?.(m.stage, m.done, m.total)
      else if (m.type === 'result') {
        done()
        resolve({ report: m.report, metrics: m.metrics })
      } else {
        done()
        reject(new Error(m.message))
      }
    }
    worker.onerror = (e) => {
      done()
      reject(new Error(e.message || 'The analysis worker failed.'))
    }
    const req: AnalysisWorkerRequest = { type: 'run', input, which, options, metrics }
    worker.postMessage(req, [input.src.buffer, input.dst.buffer, input.directed.buffer, input.created.buffer, input.updated.buffer] as ArrayBuffer[])
  })
}
