import type { AnalysisRequest, AnalysisResponse } from './analysis.worker'
import { getCachedMetrics, mergeMetrics, partialMetrics, putCachedMetrics } from './cache'
import { transferablesOf } from './serialize'
import type { MetricsOptions, MetricsResult, SerialGraph } from './types'

/**
 * Run `computeMetrics` off the main thread; aborting terminates the worker.
 * A result already in the shared cache for this slice and these options is
 * returned without starting a worker; one that answers part of the request
 * has only the missing columns (or path statistics) computed and merged in;
 * the result is put back for the next caller.
 */
export function runMetricsInWorker(graph: SerialGraph, options: MetricsOptions, sliceKey: string, onProgress?: (stage: string, done: number, total: number) => void, signal?: AbortSignal): Promise<MetricsResult> {
  const cached = getCachedMetrics(sliceKey, options)
  if (cached) return Promise.resolve(cached)
  const partial = partialMetrics(sliceKey, options)
  const wanted = partial?.remaining ?? options
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    const done = () => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      reject(Object.assign(new Error('Metrics run cancelled.'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (ev: MessageEvent<AnalysisResponse>) => {
      const m = ev.data
      if (m.type === 'progress') onProgress?.(m.stage, m.done, m.total)
      else if (m.type === 'result') {
        done()
        const result = partial ? mergeMetrics(partial.base, partial.reused, m.result, options) : m.result
        putCachedMetrics(result)
        resolve(result)
      } else {
        done()
        reject(new Error(m.message))
      }
    }
    worker.onerror = (e) => {
      done()
      reject(new Error(e.message || 'The analysis worker failed.'))
    }
    const req: AnalysisRequest = { type: 'run', graph, options: wanted, sliceKey }
    worker.postMessage(req, transferablesOf(graph))
  })
}
