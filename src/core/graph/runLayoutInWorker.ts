import type { EntityId } from '../entity/types'
import type { GraphSlice } from './filter'
import type { LayoutRequest, LayoutResponse } from './layout.worker'
import type { LayoutParams, Positions, ResolvedPositions } from './layouts'
import { packPositions, packSlice, transferables, unpackPositions, unpackSlice } from './layoutWire'

/**
 * The slice as the layouts read it — ids, types, endpoints, degrees and the edge weight already looked up —
 * without the entities' data and metadata, which would be copied into the worker for nothing. It crosses as
 * columns (`packSlice`) and the worker rebuilds this shape; the weight is written to `data.weight`, which is
 * where `edgeWeight` reads by default, so a request built from it points `weightField` there (see below).
 */
export const leanSlice = (slice: GraphSlice, weightField?: string): GraphSlice => unpackSlice(packSlice(slice, weightField))

/** A job as the caller states it: positions as the page holds them; either op with its own fields. */
export type LayoutJob = { algorithm: LayoutRequest['algorithm']; params: LayoutParams } & ({ op: 'compute'; previous?: Positions; pinned?: EntityId[] } | { op: 'resolve'; saved?: Positions })

/** Run a layout off the main thread; aborting terminates the worker. */
export function runLayoutInWorker(slice: GraphSlice, job: LayoutJob, signal?: AbortSignal): Promise<ResolvedPositions> {
  return new Promise((resolve, reject) => {
    // A signal that has already fired: no worker, no job — the promise would otherwise never settle.
    if (signal?.aborted) return reject(Object.assign(new Error('Layout cancelled.'), { name: 'AbortError' }))
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    const done = () => {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      reject(Object.assign(new Error('Layout cancelled.'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (ev: MessageEvent<LayoutResponse>) => {
      done()
      const m = ev.data
      if (m.type === 'result') resolve({ positions: unpackPositions(m.positions)!, unplaced: m.unplaced })
      else reject(new Error(m.message))
    }
    worker.onerror = (e) => {
      done()
      reject(new Error(e.message || 'The layout worker failed.'))
    }
    const params: LayoutParams = { ...job.params, weightField: job.params.weightField ? 'data.weight' : undefined }
    const wire = packSlice(slice, job.params.weightField)
    const req: LayoutRequest = job.op === 'compute' ? { type: 'run', op: 'compute', algorithm: job.algorithm, params, slice: wire, previous: packPositions(job.previous), pinned: job.pinned } : { type: 'run', op: 'resolve', algorithm: job.algorithm, params, slice: wire, saved: packPositions(job.saved) }
    worker.postMessage(req, transferables({ slice: wire, previous: req.op === 'compute' ? req.previous : undefined, saved: req.op === 'resolve' ? req.saved : undefined }))
  })
}
