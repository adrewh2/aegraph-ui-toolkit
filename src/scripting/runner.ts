import { Sandbox } from './sandbox'
import type { RunOptions, RunResult } from './types'
import type { ScriptWorkerRequest, ScriptWorkerResponse } from './worker'

export interface RunSummary extends RunResult {
  ms: { load: number; run: number; snapshot: number }
}

/**
 * Runs scripts in a persistent sandbox worker. The snapshot is sent only
 * when the worker does not hold the current one (keyed by the caller), and
 * cancelling terminates the worker so the next run starts a fresh one.
 *
 * Where there are no workers — the headless engine in Node — the same
 * sandbox runs in this process instead: the interpreter is the same
 * QuickJS WASM module, the snapshot is handed over without a copy, and a
 * run costs what it costs on the page minus the postMessage. What is lost
 * is the isolation the worker buys: a script that never returns holds this
 * thread until its own deadline stops it, so `timeoutMs` is the only
 * guard (and `cancel()` cannot interrupt a run in flight).
 */
/** A snapshot longer than this crosses to the worker in pieces of this many characters. */
const PART_CHARS = 8 * 1024 * 1024

export class ScriptRunner {
  private worker: Worker | null = null
  /** The in-process sandbox, where this host has no workers. */
  private sandbox: { box: Sandbox; key: string | null } | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (r: RunSummary) => void; reject: (e: Error) => void; retry: () => void }>()

  private readonly snapshot: (types?: string[]) => { key: string; json: () => string | Promise<string> }

  constructor(snapshot: (types?: string[]) => { key: string; json: () => string | Promise<string> }) {
    this.snapshot = snapshot
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<ScriptWorkerResponse>) => {
      const m = ev.data
      const p = this.pending.get(m.id)
      if (!p) return
      if (m.type === 'need-snapshot') return p.retry()
      this.pending.delete(m.id)
      if (m.type === 'result') p.resolve(m.result)
      else p.reject(new Error(m.message))
    }
    w.onerror = (e) => {
      const err = new Error(e.message || 'The script worker failed.')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.worker = null
    }
    this.worker = w
    return w
  }

  run(code: string, options: RunOptions = {}): Promise<RunSummary> {
    if (typeof Worker === 'undefined') return this.runHere(code, options)
    const { key, json } = this.snapshot(options.types)
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const send = async (withJson: boolean) => {
        const w = this.ensure()
        if (withJson) {
          // Posting one string the size of the dataset is one long copy on this thread (a second at 190 MB); pieces
          // are short copies, the event loop between them, and the worker joins them when the run arrives.
          const text = await json()
          if (text.length > PART_CHARS) {
            const total = Math.ceil(text.length / PART_CHARS)
            for (let i = 0; i < total; i++) {
              w.postMessage({ type: 'snapshot-part', key, part: text.slice(i * PART_CHARS, (i + 1) * PART_CHARS), index: i, total } satisfies ScriptWorkerRequest)
              if (i + 1 < total) await new Promise((r) => setTimeout(r, 0))
            }
            w.postMessage({ type: 'run', id, key, code, options } satisfies ScriptWorkerRequest)
            return
          }
          w.postMessage({ type: 'run', id, key, code, options, json: text } satisfies ScriptWorkerRequest)
          return
        }
        w.postMessage({ type: 'run', id, key, code, options } satisfies ScriptWorkerRequest)
      }
      this.pending.set(id, { resolve, reject, retry: () => void send(true).catch(reject) })
      void send(false).catch(reject)
    })
  }

  /** No worker to post to: load the snapshot into a sandbox here and run. Kept warm between runs, as the worker's is. */
  private async runHere(code: string, options: RunOptions): Promise<RunSummary> {
    const { key, json } = this.snapshot(options.types)
    const held = (this.sandbox ??= { box: new Sandbox(), key: null })
    let snapshot = 0
    if (held.key !== key) {
      const text = await json()
      // Room for the parsed snapshot: about six times its text, within what a 32-bit WASM heap allows. As the worker does.
      const memoryMb = Math.max(options.memoryMb ?? 512, Math.min(3072, Math.ceil(text.length / 1048576) * 6))
      snapshot = await held.box.load(key, text, { ...options, memoryMb })
      held.key = key
    }
    const r = await held.box.run(code, options)
    return { ...r, ms: { ...r.ms, snapshot } }
  }

  /** Stop whatever is running; the next run starts a fresh worker (and reloads the snapshot). */
  cancel() {
    this.worker?.terminate()
    this.worker = null
    this.sandbox = null
    const err = Object.assign(new Error('Script cancelled.'), { name: 'AbortError' })
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}
