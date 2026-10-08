import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStashRestore, deleteStash, isSecretKey, isSignInKey, listStashes, MAX_STASHES, nextBatchSize, requestStashRestore, restoreStash, roughBytes, stashBrowser, StashRefused, StashRestoreRefused, stashRestorePending, stashRoom } from '../stash'

/** The parts of stashing that need no database. */
describe('stashes', () => {
  const session = new Map<string, string>()
  beforeEach(() => {
    session.clear()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('asks for a restore across a reload: a note in this tab’s sessionStorage naming the stash', () => {
    expect(stashRestorePending()).toBeNull()
    const reload = vi.fn()
    requestStashRestore('2026-09-29-abcd', reload)
    expect(reload).toHaveBeenCalledOnce()
    expect(stashRestorePending()).toBe('2026-09-29-abcd')
    session.set('aegraph:restore-stash', '{"id":42}')
    expect(stashRestorePending()).toBeNull()
    session.set('aegraph:restore-stash', 'not json')
    expect(stashRestorePending()).toBeNull()
  })

  it('says what it is doing as text: a database or store name, or an error, is never markup', () => {
    const code = readFileSync(new URL('../stash.ts', import.meta.url), 'utf8')
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/)
    expect(code).toContain('textContent')
  })

  it('sizes batches by bytes, not records: a Library page is megabytes, a tombstone a few bytes', () => {
    expect(roughBytes(new ArrayBuffer(6_000_000))).toBe(6_000_000)
    expect(roughBytes({ n: 1, packed: new ArrayBuffer(1000) })).toBeGreaterThanOrEqual(1000)
    expect(roughBytes('abc')).toBe(6)
    // Six-megabyte pages: a handful at a time. Tiny records: capped at the batch maximum.
    expect(nextBatchSize(64, 64 * 6_000_000)).toBe(4)
    expect(nextBatchSize(64, 64 * 40)).toBe(2000)
    // Never zero, even for a record bigger than a batch.
    expect(nextBatchSize(1, 100_000_000)).toBe(1)
    expect(nextBatchSize(0, 0)).toBe(64)
  })
})

/** localStorage as the browser has it: `length`, `key(i)`, `clear` — what clearing and stashing walk. */
function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

function openDb(name: string, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onupgradeneeded = () => upgrade?.(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
const put = async (name: string, store: string, value: unknown) => {
  const db = await openDb(name)
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).put(value)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
  db.close()
}
const all = async (name: string, store: string): Promise<unknown[]> => {
  const db = await openDb(name)
  const out = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return out
}

/**
 * The copy itself, against fake-indexeddb (the real semantics, in memory): a stash taken, the browser changed, the
 * stash restored — and a restore that cannot be whole refusing up front, or staying asked for until it is.
 */
describe('restoring a stash', () => {
  let local: ReturnType<typeof fakeStorage>
  let session: ReturnType<typeof fakeStorage>
  let real: IDBFactory
  beforeEach(async () => {
    real = new IDBFactory()
    vi.stubGlobal('indexedDB', real)
    local = fakeStorage()
    session = fakeStorage()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1e9, usage: 1e6 }) } })
    // A Library of two records, and a page's remembered state.
    const db = await openDb('aegraph', 2, (d) => d.createObjectStore('overlay', { keyPath: 'id' }))
    db.close()
    await put('aegraph', 'overlay', { id: 'a', label: 'A' })
    await put('aegraph', 'overlay', { id: 'b', label: 'B' })
    local.setItem('aegraph:page', 'as stashed')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('puts the browser back as it was, and is done with it', async () => {
    const stash = await stashBrowser('before')
    await put('aegraph', 'overlay', { id: 'c', label: 'added since' })
    local.setItem('aegraph:page', 'changed since')
    expect(await restoreStash(stash.id)).toMatchObject({ id: stash.id })
    expect((await all('aegraph', 'overlay')).map((r) => (r as { id: string }).id)).toEqual(['a', 'b'])
    expect(local.getItem('aegraph:page')).toBe('as stashed')
    expect(stashRestorePending()).toBeNull()
  })

  it('refuses, changing nothing, when the stash will not fit in what the browser has free', async () => {
    const stash = await stashBrowser('before')
    await put('aegraph', 'overlay', { id: 'c', label: 'added since' })
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1000, usage: 990 }) } })
    requestStashRestore(stash.id, () => {})
    await expect(restoreStash(stash.id)).rejects.toBeInstanceOf(StashRestoreRefused)
    // Nothing deleted, nothing laid over it.
    expect((await all('aegraph', 'overlay')).length).toBe(3)
    expect(local.getItem('aegraph:page')).toBe('as stashed')
    expect(local.getItem('aegraph:restoring-stash')).toBeNull()
    expect(await stashRoom(100, { estimate: async () => ({ quota: 1000, usage: 950 }) })).toMatchObject({ fits: false, free: 50 })
    expect(await stashRoom(100, {})).toBeNull()
  })

  it('stops at a database that will not be deleted — the stash is not laid over it — and stays asked for', async () => {
    const stash = await stashBrowser('before')
    await put('aegraph', 'overlay', { id: 'c', label: 'added since' })
    // The Library's database refuses to go.
    vi.stubGlobal('indexedDB', {
      open: (name: string, version?: number) => real.open(name, version),
      databases: () => real.databases(),
      cmp: (a: unknown, b: unknown) => real.cmp(a, b),
      deleteDatabase: (name: string) => {
        if (name !== 'aegraph') return real.deleteDatabase(name)
        const req = { error: new Error('disk fault') } as unknown as IDBOpenDBRequest
        setTimeout(() => req.onerror?.(new Event('error')), 0)
        return req
      },
    })
    await expect(restoreStash(stash.id)).rejects.toThrow(/could not be deleted/)
    // What was there is still there, not mixed with the stash; the restore is still asked for, so the next load
    // takes it up again rather than starting the app on this.
    expect((await all('aegraph', 'overlay')).length).toBe(3)
    expect(stashRestorePending()).toBe(stash.id)
    // Taken up again once the delete works: whole.
    vi.stubGlobal('indexedDB', real)
    await restoreStash(stash.id)
    expect((await all('aegraph', 'overlay')).length).toBe(2)
    expect(stashRestorePending()).toBeNull()
  })

  it('leaves the keys out unless asked, and a restore keeps the keys this browser has now', async () => {
    for (const k of ['aegraph:ai:settings', 'aegraph:voice:settings', 'aegraph:spotify:auth', 'aegraph:spotify:pkce', 'aegraph:bridge:url']) expect(isSecretKey(k), k).toBe(true)
    expect(isSecretKey('aegraph:page')).toBe(false)
    expect(isSignInKey('sb-abc-auth-token') && isSecretKey('sb-abc-auth-token')).toBe(true)
    expect(isSignInKey('aegraph:ai:chats')).toBe(false)
    local.setItem('sb-abc-auth-token', 'signed in')
    local.setItem('aegraph:ai:settings', JSON.stringify({ apiKey: 'sk-ant-secret' }))
    local.setItem('aegraph:voice:settings', JSON.stringify({ apiKey: 'sk-openai' }))
    local.setItem('aegraph:spotify:auth', JSON.stringify({ accessToken: 'spotify-token' }))
    local.setItem('aegraph:bridge:url', 'ws://127.0.0.1:8787/?token=bridge-token')
    const stash = await stashBrowser('before')
    const text = JSON.stringify(stash)
    for (const secret of ['sk-ant-secret', 'sk-openai', 'spotify-token', 'bridge-token', 'signed in']) expect(text, secret).not.toContain(secret)
    expect(stash.keys).toBeUndefined()
    expect(stash.localStorage.map(([k]) => k)).toEqual(['aegraph:page'])
    // A key entered since the stash was taken survives restoring it.
    local.setItem('aegraph:ai:settings', JSON.stringify({ apiKey: 'sk-ant-new' }))
    await restoreStash(stash.id)
    expect(local.getItem('aegraph:ai:settings')).toContain('sk-ant-new')
    expect(local.getItem('aegraph:spotify:auth')).toContain('spotify-token')
    expect(local.getItem('aegraph:page')).toBe('as stashed')
  })

  it('takes the keys when asked, and its restore lays them back', async () => {
    local.setItem('aegraph:ai:settings', JSON.stringify({ apiKey: 'sk-ant-then' }))
    local.setItem('sb-abc-auth-token', 'signed in')
    const stash = await stashBrowser('with keys', undefined, { includeKeys: true })
    expect(stash.keys).toBe(true)
    expect(JSON.stringify(stash.localStorage)).toContain('sk-ant-then')
    // A hosted copy's sign-in token is not a key of this app's: never stashed, even with the keys.
    expect(JSON.stringify(stash.localStorage)).not.toContain('signed in')
    local.setItem('aegraph:ai:settings', JSON.stringify({ apiKey: 'sk-ant-now' }))
    await restoreStash(stash.id)
    expect(local.getItem('aegraph:ai:settings')).toContain('sk-ant-then')
  })

  it('keeps at most MAX_STASHES, and refuses another — copying nothing — until one is deleted', async () => {
    for (const s of await listStashes()) await deleteStash(s.id)
    const taken = []
    for (let i = 0; i < MAX_STASHES; i++) taken.push(await stashBrowser(`s${i}`))
    await expect(stashBrowser('one too many')).rejects.toBeInstanceOf(StashRefused)
    expect((await listStashes()).length).toBe(MAX_STASHES)
    await deleteStash(taken[0].id)
    await expect(stashBrowser('room again')).resolves.toMatchObject({ name: 'room again' })
    for (const s of await listStashes()) await deleteStash(s.id)
  })

  it('refuses to start a stash the browser has no room for', async () => {
    for (const s of await listStashes()) await deleteStash(s.id)
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1_000_000, usage: 900_000 }) } })
    await expect(stashBrowser('too big')).rejects.toThrow(/needs about .* free/)
    expect(await listStashes()).toEqual([])
  })

  it('a restore cut short is taken up again by the next load, even from another tab', async () => {
    const stash = await stashBrowser('before')
    local.setItem('aegraph:restoring-stash', JSON.stringify({ id: stash.id }))
    expect(stashRestorePending()).toBe(stash.id)
    clearStashRestore()
    expect(stashRestorePending()).toBeNull()
  })
})
