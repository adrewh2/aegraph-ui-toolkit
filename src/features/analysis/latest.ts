import { useSyncExternalStore } from 'react'
import type { MetricsResult } from '../../core/graph/metrics/types'
import type { Report } from '../../analysis/types'

/**
 * The most recent analytics run, kept in memory so the Insights page,
 * the assistant and the plot builder (which reads `metric.<id>` refs
 * from it) all see the same findings without recomputing.
 */
export interface LatestAnalysis {
  report: Report
  metrics: MetricsResult
}
/** Progress while a run is in flight. */
export interface AnalysisProgress {
  stage: string
  done: number
  total: number
}

interface State {
  latest: LatestAnalysis | null
  running: AnalysisProgress | null
  error: string | null
}

const g = globalThis as unknown as { __aegraphAnalysis?: { state: State; listeners: Set<() => void> } }
const reg = (g.__aegraphAnalysis ??= { state: { latest: null, running: null, error: null }, listeners: new Set() })

const set = (patch: Partial<State>) => {
  reg.state = { ...reg.state, ...patch }
  reg.listeners.forEach((l) => l())
}

export const getLatestAnalysis = (): LatestAnalysis | null => reg.state.latest
export const setLatestAnalysis = (latest: LatestAnalysis | null) => set({ latest, running: null, error: null })
export const setAnalysisProgress = (running: AnalysisProgress | null) => set({ running })
export const setAnalysisError = (error: string | null) => set({ error, running: null })

/** The latest run's metrics when they were computed over this exact node/edge set. */
export function metricsForKey(key: string): MetricsResult | undefined {
  const l = reg.state.latest
  return l && l.report.key === key ? l.metrics : undefined
}

const subscribe = (l: () => void) => {
  reg.listeners.add(l)
  return () => {
    reg.listeners.delete(l)
  }
}

export function useLatestAnalysis(): State {
  return useSyncExternalStore(subscribe, () => reg.state, () => reg.state)
}
