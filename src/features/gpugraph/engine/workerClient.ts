import type { WorkerRequest, WorkerResponse } from './packed.worker'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * One worker per engine, requests answered in order. `call` resolves with
 * the worker's result (its typed arrays transferred, so the caller owns
 * them); `terminate` drops the worker and rejects what was pending.
 */
export class PackedWorker {
  private worker: Worker | null = null
  private next = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./packed.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve({ ...(m.result as object), ms: m.ms })
      else p.reject(new Error(m.error))
    }
    w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'GPU graph worker failed'))
      this.pending.clear()
    }
    this.worker = w
    return w
  }

  call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<T & { ms: number }> {
    const id = this.next++
    const w = this.ensure()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      w.postMessage({ ...req, id }, transfer)
    })
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  terminate() {
    this.worker?.terminate()
    this.worker = null
    for (const p of this.pending.values()) p.reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }))
    this.pending.clear()
  }
}
