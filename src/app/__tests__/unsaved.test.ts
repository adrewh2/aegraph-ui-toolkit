import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadForNewVersion } from '../preload'
import { databaseExists, guardUnsaved, hasUnsaved, unpersistedStore, whenSaved } from '../unsaved'

/**
 * Changes on their way to this browser's storage are not left to a reload: the browser's own unload asks first, and
 * the reload the app makes for a new deployment waits for them — and does not happen while a failed write waits.
 */
type Status = { state: 'idle' | 'saving' | 'error'; pending: number; unsaved?: number }

function fakeWrites(initial: Status) {
  let status = initial
  let land: () => void = () => {}
  return {
    getStatus: () => status,
    flush: () => new Promise<void>((r) => (land = r)),
    set: (s: Status) => (status = s),
    land: () => land(),
  }
}

let listeners: Map<string, (e: unknown) => void>
let stops: (() => void)[] = []
const reload = vi.fn()

beforeEach(() => {
  listeners = new Map()
  vi.stubGlobal('addEventListener', (type: string, fn: (e: unknown) => void) => listeners.set(type, fn))
  vi.stubGlobal('removeEventListener', (type: string) => listeners.delete(type))
  const mem = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) })
  vi.stubGlobal('location', { reload })
  reload.mockClear()
})
afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  vi.unstubAllGlobals()
})

const unload = () => {
  const e = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true } }
  listeners.get('beforeunload')?.(e)
  return e.prevented
}

describe('changes not yet saved to this browser', () => {
  it('asks before the page unloads while a write is queued or has failed, and not otherwise', () => {
    const w = fakeWrites({ state: 'idle', pending: 0 })
    stops.push(guardUnsaved(w))
    expect(unload()).toBe(false)
    w.set({ state: 'saving', pending: 2 })
    expect(unload()).toBe(true)
    w.set({ state: 'error', pending: 0, unsaved: 1 })
    expect(hasUnsaved(w)).toBe(true)
    expect(unload()).toBe(true)
    w.set({ state: 'idle', pending: 0 })
    expect(unload()).toBe(false)
  })

  it('waits for the queued writes — but not for ever', async () => {
    const w = fakeWrites({ state: 'saving', pending: 1 })
    stops.push(guardUnsaved(w))
    let done = false
    const waiting = whenSaved(10_000).then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    w.set({ state: 'idle', pending: 0 })
    w.land()
    await waiting
    expect(done).toBe(true)
    vi.useFakeTimers()
    try {
      w.set({ state: 'saving', pending: 1 })
      const stuck = whenSaved(500)
      vi.advanceTimersByTime(500)
      await expect(stuck).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads for a new deployment only once the writes have landed', async () => {
    const w = fakeWrites({ state: 'saving', pending: 1 })
    stops.push(guardUnsaved(w))
    reloadForNewVersion()
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
    w.set({ state: 'idle', pending: 0 })
    w.land()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('does not reload for a new deployment while a failed write waits to be tried again', async () => {
    const w = fakeWrites({ state: 'error', pending: 0, unsaved: 1 })
    w.flush = () => Promise.resolve()
    stops.push(guardUnsaved(w))
    reloadForNewVersion()
    await new Promise((r) => setTimeout(r, 10))
    expect(reload).not.toHaveBeenCalled()
  })

  it('counts every write to a store the workspace was never loaded into: its writes status stays idle, and nothing is kept', () => {
    // The load failed: the database is not attached, so the writes (below) never see a change and say all is well.
    const w = fakeWrites({ state: 'idle', pending: 0 })
    stops.push(guardUnsaved(w))
    const store = { version: 7 }
    stops.push(unpersistedStore(store))
    // Nothing done yet: a reload loses nothing, and is not held up.
    expect(unload()).toBe(false)
    store.version++
    expect(hasUnsaved()).toBe(true)
    expect(unload()).toBe(true)
  })

  it('does not reload for a new deployment over a store that is not being saved', async () => {
    const w = fakeWrites({ state: 'idle', pending: 0 })
    stops.push(guardUnsaved(w))
    const store = { version: 1 }
    stops.push(unpersistedStore(store))
    store.version++
    reloadForNewVersion()
    await new Promise((r) => setTimeout(r, 10))
    expect(reload).not.toHaveBeenCalled()
  })

  it('says whether this browser has the database, or that it cannot say', async () => {
    expect(await databaseExists('aegraph', { databases: async () => [{ name: 'aegraph-history' }, { name: 'aegraph' }] })).toBe(true)
    expect(await databaseExists('aegraph', { databases: async () => [{ name: 'aegraph-history' }] })).toBe(false)
    // No listing (an older browser), or one that fails: unknown — and unknown is never taken for "none".
    expect(await databaseExists('aegraph', {})).toBeNull()
    expect(await databaseExists('aegraph', { databases: () => Promise.reject(new Error('denied')) })).toBeNull()
    expect(await databaseExists('aegraph', undefined)).toBeNull()
  })
})
