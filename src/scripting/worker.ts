/// <reference lib="webworker" />
import { Sandbox } from './sandbox'
import type { RunOptions, RunResult } from './types'

/**
 * The sandbox lives in a worker so a long script never blocks the page and
 * a stuck one is terminated from outside. One worker, many runs: the
 * snapshot stays loaded between scripts.
 */
export type ScriptWorkerRequest =
  | { type: 'run'; id: number; key: string; json?: string; code: string; options?: RunOptions }
  /** A big snapshot arrives in pieces (each a short copy on the page's side); the run that follows names the key. */
  | { type: 'snapshot-part'; key: string; part: string; index: number; total: number }
export type ScriptWorkerResponse = { type: 'result'; id: number; result: RunResult & { ms: { load: number; run: number; snapshot: number } } } | { type: 'need-snapshot'; id: number } | { type: 'error'; id: number; message: string }

const sandbox = new Sandbox()
let loadedKey: string | null = null
const parts = new Map<string, string[]>()

self.onmessage = async (ev: MessageEvent<ScriptWorkerRequest>) => {
  const m = ev.data
  if (m.type === 'snapshot-part') {
    const list = parts.get(m.key) ?? []
    list[m.index] = m.part
    parts.set(m.key, list)
    return
  }
  if (m.type !== 'run') return
  const post = (r: ScriptWorkerResponse) => (self as unknown as Worker).postMessage(r)
  try {
    let snapshot = 0
    if (loadedKey !== m.key) {
      const pieces = parts.get(m.key)
      parts.delete(m.key)
      const json = m.json ?? (pieces ? pieces.join('') : undefined)
      if (json === undefined) return post({ type: 'need-snapshot', id: m.id })
      // Room for the parsed snapshot: about six times its text, within what a 32-bit WASM heap allows.
      const memoryMb = Math.max(m.options?.memoryMb ?? 512, Math.min(3072, Math.ceil(json.length / 1048576) * 6))
      snapshot = await sandbox.load(m.key, json, { ...m.options, memoryMb })
      loadedKey = m.key
    }
    const r = await sandbox.run(m.code, m.options)
    post({ type: 'result', id: m.id, result: { ...r, ms: { ...r.ms, snapshot } } })
  } catch (e) {
    post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) })
  }
}
