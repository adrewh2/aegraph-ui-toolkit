import { useSyncExternalStore } from 'react'

/**
 * Where you have been, in this tab, as the app saw it: every URL the page
 * showed — including the ones pane hosts write with `replace`, which the
 * browser's own history never records. Back and forward move a cursor;
 * arriving somewhere new drops what was ahead of it, like a browser.
 */
export interface TrailEntry {
  path: string
  at: number
}

interface TrailState {
  entries: TrailEntry[]
  index: number
}

const MAX = 60
const KEY = 'aegraph:trail:v2'

let state: TrailState = restore()
const listeners = new Set<() => void>()
/** Set while back/forward is moving the cursor, so the resulting URL change isn't recorded as new. */
let moving = false

function restore(): TrailState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as TrailState
      if (Array.isArray(v.entries) && typeof v.index === 'number') return v
    }
  } catch {
    /* ignore */
  }
  return { entries: [], index: -1 }
}

function set(next: TrailState) {
  state = next
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

/**
 * Record the URL the app is showing now. A `replace` (a consumed `?sel=`,
 * a pane host restoring its tab on mount) rewrites the current entry
 * instead of adding one: the user didn't go anywhere.
 */
export function record(path: string, mode: 'push' | 'replace' = 'push') {
  if (moving) {
    moving = false
    return
  }
  const cur = state.entries[state.index]
  if (cur?.path === path) return
  if (mode === 'replace' && cur) {
    const entries = state.entries.slice()
    entries[state.index] = { path, at: Date.now() }
    set({ ...state, entries })
    return
  }
  const entries = [...state.entries.slice(0, state.index + 1), { path, at: Date.now() }].slice(-MAX)
  set({ entries, index: entries.length - 1 })
}

/** The path to go to for a step of `delta`, moving the cursor; null at either end. */
export function step(delta: number): string | null {
  const i = state.index + delta
  if (i < 0 || i >= state.entries.length) return null
  moving = true
  set({ ...state, index: i })
  return state.entries[i].path
}

/** Jump straight to an entry by index (a crumb). */
export function jumpTo(index: number): string | null {
  if (index < 0 || index >= state.entries.length || index === state.index) return null
  moving = true
  set({ ...state, index })
  return state.entries[index].path
}

export const getTrail = () => state
export const canGoBack = () => state.index > 0
export const canGoForward = () => state.index < state.entries.length - 1

export function useTrail(): TrailState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getTrail,
    getTrail,
  )
}

/** Tests / a fresh start. */
export function resetTrail() {
  set({ entries: [], index: -1 })
}
