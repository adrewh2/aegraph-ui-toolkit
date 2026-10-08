import { generateAcademicGraph, type GenerateOptions, type GenerateStats } from './generate'
import type { AnyEntity } from '../entity/types'

export type WorkerRequest = { type: 'generate'; target: number; seed: number }
export type WorkerResponse =
  | { type: 'chunk'; entities: AnyEntity[]; produced: number; estimated: number }
  | { type: 'done'; stats: GenerateStats }
  | { type: 'error'; message: string }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type !== 'generate') return
  try {
    const opts: GenerateOptions = {
      target: msg.target,
      seed: msg.seed,
      onChunk: (entities, produced, estimated) => self.postMessage({ type: 'chunk', entities, produced, estimated } satisfies WorkerResponse),
    }
    const { stats } = generateAcademicGraph(opts)
    self.postMessage({ type: 'done', stats } satisfies WorkerResponse)
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse)
  }
}
