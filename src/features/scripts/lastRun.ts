import type { RunSummary } from '../../scripting/runner'
import type { Output } from '../../scripting/types'

/**
 * The last run of each script, kept in this browser so a reload lands on
 * the figure, table or scene that was on screen — the page used to hold
 * them in memory alone, so a refresh emptied the output pane and only a
 * *saved* script (which the page re-runs) came back, after the wait.
 *
 * What is kept is the output, not the machinery: a Visual script's live
 * iframe cannot outlive the page, so it is re-run when asked for. Big
 * results are skipped rather than allowed to fill the browser's storage —
 * the page then behaves as it did before, re-running to show them.
 */
export interface StoredRun {
  at: string
  outputs: Output[]
  error?: string
  logs: string[]
  ms: number
  /** A Visual run: its frame is gone with the page, the outputs are not. */
  view?: boolean
}

const KEY = 'aegraph:scripts:lastrun'
/** One result over this is not kept: a figure of a hundred thousand points belongs in the run, not in localStorage. */
const MAX_ENTRY = 600_000
/** Everything together; the oldest go first when a new one does not fit. */
const MAX_TOTAL = 2_000_000

type Store = Record<string, StoredRun>

const read = (): Store => {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as Store) : {}
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
const write = (all: Store) => {
  try {
    if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all))
    else localStorage.removeItem(KEY)
  } catch {
    /* no storage, or over quota: the page falls back to re-running */
  }
}

export function readLastRun(id: string): StoredRun | undefined {
  const r = read()[id]
  return r && Array.isArray(r.outputs) ? r : undefined
}

/** Rebuild what the page holds after a run from what was stored — the frame is not part of it. */
export function runStateOf(r: StoredRun): { run: RunSummary; outputs: Output[]; error?: string } {
  return { run: { value: undefined, logs: r.logs ?? [], ms: { load: 0, run: r.ms ?? 0, snapshot: 0 } }, outputs: r.outputs, error: r.error }
}

export function writeLastRun(id: string, run: StoredRun): void {
  const all = read()
  delete all[id]
  const entry = JSON.stringify(run)
  if (entry.length > MAX_ENTRY) {
    // Too big to keep: leave nothing behind rather than a stale smaller run from before.
    write(all)
    return
  }
  all[id] = run
  // Newest first; drop from the back until the whole thing fits.
  const ordered = Object.entries(all).sort((a, b) => (b[1].at ?? '').localeCompare(a[1].at ?? ''))
  const kept: Store = {}
  let total = 0
  for (const [k, v] of ordered) {
    const size = JSON.stringify(v).length
    if (total + size > MAX_TOTAL) continue
    total += size
    kept[k] = v
  }
  write(kept)
}

export function clearLastRun(id?: string): void {
  if (!id) return write({})
  const all = read()
  delete all[id]
  write(all)
}
