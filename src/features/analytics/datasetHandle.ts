/**
 * The Datasets page's handle: how the assistant's `dataset` tool reaches
 * the mounted page — which dataset it shows, where the cursor is — and
 * moves it. The edits themselves go through the entity (the pure functions
 * in `core/datasets/dataset.ts`), which the page redraws from; only what is
 * view state is here.
 */
export interface DatasetHandle {
  getState: () => { datasetId?: string; cursor: { r: number; c: number } | null; selection: { r0: number; c0: number; r1: number; c1: number } | null; selectedRows: number[]; editing: boolean }
  load: (id: string) => void
  /** Put the cursor on a cell, selecting a range around it when given. */
  select: (cell: { r: number; c: number }, range?: { r0: number; c0: number; r1: number; c1: number }) => void
  /** Write any edit still waiting in the page to the entity now (the tool reads the entity). */
  flush: () => void
}

const g = globalThis as unknown as { __aegraphDatasets?: { handle: DatasetHandle | null; listeners: Set<() => void> } }
const reg = (g.__aegraphDatasets ??= { handle: null, listeners: new Set() })

export function registerDatasetHandle(h: DatasetHandle): () => void {
  reg.handle = h
  reg.listeners.forEach((l) => l())
  return () => {
    if (reg.handle === h) reg.handle = null
    reg.listeners.forEach((l) => l())
  }
}
export const getDatasetHandle = (): DatasetHandle | null => reg.handle
export function waitForDatasetPage(timeoutMs = 5000): Promise<DatasetHandle | null> {
  if (reg.handle) return Promise.resolve(reg.handle)
  return new Promise((resolve) => {
    const done = (h: DatasetHandle | null) => {
      reg.listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => reg.handle && done(reg.handle)
    reg.listeners.add(check)
    const timer = setTimeout(() => done(null), timeoutMs)
  })
}
