import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
const fakeStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size
  },
}

describe('the tab’s flight recorder', () => {
  beforeEach(() => {
    storage.clear()
    vi.resetModules()
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('localStorage', fakeStorage)
    const session = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) })
    vi.stubGlobal('window', {})
    vi.stubGlobal('location', { pathname: '/chats/x' })
    vi.stubGlobal('document', { querySelectorAll: () => ({ length: 0 }) })
    vi.stubGlobal('performance', { now: () => Date.now(), memory: { usedJSHeapSize: 150e6, totalJSHeapSize: 200e6 } })
    vi.stubGlobal('PerformanceObserver', class { observe() {} })
    vi.stubGlobal('addEventListener', (type: string, f: () => void) => listeners.set(type, f))
    vi.stubGlobal('__fire', (type: string) => listeners.get(type)?.())
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the last minute of a page that was killed, and not of one that closed', async () => {
    const first = await import('../memoryWatch')
    first.startMemoryWatch()
    vi.advanceTimersByTime(6000)
    expect(first.recentSamples().length).toBeGreaterThanOrEqual(3)
    expect(first.recentSamples().at(-1)).toMatchObject({ heap: 150, total: 200, route: '/chats/x' })
    expect(first.recentSamples()[0].chats).toEqual({ count: 0, kb: 0, largestKb: 0 })
    // Killed: no pagehide. The next load keeps the record as the last crash.
    vi.resetModules()
    const second = await import('../memoryWatch')
    second.startMemoryWatch()
    const crash = second.lastCrash()
    expect(crash?.clean).toBe(false)
    expect(crash?.samples.length).toBeGreaterThanOrEqual(3)
    // This one closes normally: the load after it finds nothing new.
    expect(crash?.tab).toBeTruthy()
    ;(globalThis as unknown as { __fire: (t: string) => void }).__fire('pagehide')
    for (const k of [...storage.keys()]) if (k.startsWith('aegraph:memwatch:crash:')) storage.delete(k)
    vi.resetModules()
    const third = await import('../memoryWatch')
    third.startMemoryWatch()
    expect(third.lastCrash()).toBeUndefined()
  })
})
