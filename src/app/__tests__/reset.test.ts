import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A Storage for node, keys listed by index as the browser's are. */
function fakeStorage() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('clearing this browser', () => {
  let local: ReturnType<typeof fakeStorage>
  let session: ReturnType<typeof fakeStorage>
  let deleted: string[]
  let cachesDeleted: string[]
  beforeEach(() => {
    local = fakeStorage()
    session = fakeStorage()
    deleted = []
    cachesDeleted = []
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    vi.stubGlobal('caches', { keys: async () => ['workbox'], delete: async (k: string) => (cachesDeleted.push(k), true) })
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'aegraph' }, { name: 'something-else' }, { name: 'aegraph-stash' }],
      deleteDatabase: (name: string) => {
        const req: { onsuccess?: () => void; onblocked?: () => void } = {}
        queueMicrotask(() => {
          // 'aegraph' is held open by another tab first, then let go.
          if (name === 'aegraph') req.onblocked?.()
          deleted.push(name)
          req.onsuccess?.()
        })
        return req
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for it across a reload: a note in this tab’s sessionStorage, nothing cleared yet', async () => {
    const { requestBrowserReset, browserResetPending } = await import('../reset')
    expect(browserResetPending()).toBeNull()
    local.setItem('aegraph:ai:chats', '{}')
    const reload = vi.fn()
    requestBrowserReset({}, reload)
    expect(reload).toHaveBeenCalledOnce()
    expect(browserResetPending()).toEqual({})
    expect(local.getItem('aegraph:ai:chats')).toBe('{}')
  })

  it('deletes every database — listed or known — and every key, cache and note, and says when another tab holds one', async () => {
    const { clearBrowser, browserResetPending } = await import('../reset')
    local.setItem('aegraph:ai:chats', '{}')
    local.setItem('aegraph:voice:settings', '{}')
    session.setItem('aegraph:reset-browser', '{}')
    const blocked = vi.fn()
    const { databases } = await clearBrowser({}, blocked)
    expect(new Set(deleted)).toEqual(new Set(databases))
    expect(databases).toEqual(expect.arrayContaining(['aegraph', 'something-else', 'aegraph-history', 'aegraph-settings', 'aegraph-previews', 'aegraph-explorer']))
    // The stashes are how what was cleared comes back: never cleared.
    expect(deleted).not.toContain('aegraph-stash')
    expect(blocked).toHaveBeenCalledOnce()
    expect(local.length).toBe(0)
    expect(session.length).toBe(0)
    expect(cachesDeleted).toEqual(['workbox'])
    expect(browserResetPending()).toBeNull()
  })

  it('keeps the keys it is told to, and nothing else', async () => {
    const { clearBrowser } = await import('../reset')
    local.setItem('aegraph:ai:chats', '{}')
    local.setItem('aegraph:restoring-stash', '{"id":"s"}')
    await clearBrowser({ keepKeys: ['aegraph:restoring-stash'] })
    expect([...local.m.entries()]).toEqual([['aegraph:restoring-stash', '{"id":"s"}']])
  })

  it('clears to an empty Library when asked: the default demo a first visit opens is marked as opened', async () => {
    const { finishBrowserReset } = await import('../reset')
    const { EDITION } = await import('../edition')
    const replaced: string[] = []
    vi.stubGlobal('document', { getElementById: () => null })
    vi.stubGlobal('location', { replace: (u: string) => void replaced.push(u) })
    local.setItem('aegraph:ai:chats', '{}')
    await finishBrowserReset({ startEmpty: true })
    expect([...local.m.entries()]).toEqual([[EDITION.defaultDemo.key, '1']])
    expect(replaced).toEqual(['/'])
    // Without it, a clear is a plain first visit: the demo opens.
    local.setItem(EDITION.defaultDemo.key, '1')
    await finishBrowserReset({})
    expect(local.m.size).toBe(0)
  })
})
