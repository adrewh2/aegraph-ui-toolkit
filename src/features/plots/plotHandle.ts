import type { EntityId } from '../../core/entity/types'
import type { PlotSpec } from '../../core/graph/plot'

/** What an open plot workbench exposes to the assistant tools, mirroring explorerHandle. */
export interface PlotHandle {
  getState: () => { plotId?: EntityId; spec: PlotSpec; dirty: boolean; stats?: { rows: number; traces: number; missing: number } }
  setSpec: (spec: PlotSpec) => void
  load: (id: EntityId) => void
  save: (name: string, existing?: EntityId) => EntityId
  /** PNG of the chart, or null when nothing is drawn. */
  snapshot: (opts?: { width?: number; height?: number }) => Promise<Blob | null>
  /** Undo zoom and pan: every axis back to auto range. */
  resetView: () => Promise<void>
}

const g = globalThis as unknown as { __aegraphPlot?: { handle: PlotHandle | null; listeners: Set<() => void> } }
const reg = (g.__aegraphPlot ??= { handle: null, listeners: new Set() })

export function registerPlotHandle(h: PlotHandle): () => void {
  reg.handle = h
  reg.listeners.forEach((l) => l())
  return () => {
    if (reg.handle === h) reg.handle = null
    reg.listeners.forEach((l) => l())
  }
}
export const getPlotHandle = (): PlotHandle | null => reg.handle

export function waitForPlot(timeoutMs = 5000): Promise<PlotHandle | null> {
  if (reg.handle) return Promise.resolve(reg.handle)
  return new Promise((resolve) => {
    const done = (h: PlotHandle | null) => {
      reg.listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => reg.handle && done(reg.handle)
    const timer = setTimeout(() => done(null), timeoutMs)
    reg.listeners.add(check)
  })
}
