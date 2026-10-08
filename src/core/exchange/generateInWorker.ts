import type { AnyEntity } from '../entity/types'
import type { GenerateStats } from './generate'
import type { WorkerRequest, WorkerResponse } from './generate.worker'

export interface WorkerGenerateResult {
  entities: AnyEntity[]
  stats: GenerateStats
}

/** Runs the generator off the main thread, streaming chunks back for progress. */
export function generateInWorker(
  target: number,
  seed: number,
  onProgress?: (produced: number, estimated: number) => void,
  signal?: AbortSignal,
): Promise<WorkerGenerateResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./generate.worker.ts', import.meta.url), { type: 'module' })
    const entities: AnyEntity[] = []
    const cleanup = () => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Generation cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort)
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'chunk') {
        for (let i = 0; i < msg.entities.length; i++) entities.push(msg.entities[i])
        onProgress?.(msg.produced, msg.estimated)
      } else if (msg.type === 'done') {
        cleanup()
        resolve({ entities, stats: msg.stats })
      } else {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(e.message || 'Generator worker failed'))
    }
    worker.postMessage({ type: 'generate', target, seed } satisfies WorkerRequest)
  })
}
