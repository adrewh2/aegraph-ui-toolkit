import type { GraphEngine } from './engine/engine'
import type { BenchResult } from './bench'
import type { GeneratedGraph, GenerateSpec } from '../../core/packed/generate'

/**
 * What a mounted GPU graph exposes to the assistant tools, beside the
 * explorer handle (which drives the shared explorer state — filter,
 * layout, style, selection — as it does for the other renderers). This
 * one reaches the engine itself: its counts and frame statistics, the
 * benchmark, and what the explorer's object pipeline cannot express at
 * two hundred thousand nodes.
 */
export interface GpuGraphHandle {
  engine: GraphEngine
  /** Where the picture comes from: the explorer's slice, or a generated benchmark graph. */
  getSource: () => 'explorer' | 'benchmark'
  loadBenchmark: (preset: string | GenerateSpec) => Promise<{ generateMs: number; loadMs: number; firstFrameMs: number }>
  runBenchmark: (preset: string | GenerateSpec) => Promise<BenchResult>
  /** Back to the explorer's slice. */
  showExplorer: () => void
  lastBenchmark?: BenchResult
  /** The generated graph behind the benchmark source (its communities), for checks on a layout. */
  lastGenerated?: GeneratedGraph
  /**
   * The picture on screen as a JPEG data URL of the preview's size — what a
   * saved scene shows on its card. It is the engine's own frame read back, so
   * it is the picture the scene opens as, in the renderer it was saved from
   * and from the camera it was saved at. Null when nothing is drawn yet.
   */
  snapshot: () => Promise<string | null>
}

interface Registry {
  handles: GpuGraphHandle[]
  listeners: Set<() => void>
}
const g = globalThis as unknown as { __aegraphGpuGraphs?: Registry }
const reg: Registry = (g.__aegraphGpuGraphs ??= { handles: [], listeners: new Set() })

export function registerGpuGraph(h: GpuGraphHandle): () => void {
  reg.handles.push(h)
  reg.listeners.forEach((l) => l())
  return () => {
    const i = reg.handles.indexOf(h)
    if (i >= 0) reg.handles.splice(i, 1)
    reg.listeners.forEach((l) => l())
  }
}
export const getGpuGraph = (): GpuGraphHandle | null => reg.handles[reg.handles.length - 1] ?? null

export function waitForGpuGraph(timeoutMs = 8000): Promise<GpuGraphHandle | null> {
  const now = getGpuGraph()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (h: GpuGraphHandle | null) => {
      reg.listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => {
      const h = getGpuGraph()
      if (h) done(h)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    reg.listeners.add(check)
  })
}
